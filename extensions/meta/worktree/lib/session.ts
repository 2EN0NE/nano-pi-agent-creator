/**
 * pi-worktree — 会话切换层
 *
 * 提供 session 克隆（cloneSession）、切换（switchToSession）、创建（createSession）能力，
 * 用于 worktree ←→ main checkout 之间的 cwd 切换。
 *
 * 核心协议：clone 时将当前会话完整复制到目标目录的 session 目录下，
 * 生成新 header id 并重映射 parentId 链，保证两颗会话树完全独立。
 * 删除 worktree 不会自动删除关联 session 文件，插件会提示用户手动清理。
 */
import { createLogger } from '@zenone/pi-logger';
import { join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { getDefaultSessionDirPath } from './paths.js';
import { getWorktreesDir } from './paths.js';

const log = createLogger('pi-worktree');

// ── 类型 ──

export interface CloneMeta {
	sourceCwd: string;
	targetCwd: string;
	clonedAt: string;
	sourceSessionId: string;
	targetSessionId: string;
}

// ── 会话目录 ──

/**
 * 计算会话目录路径（纯函数，无副作用）。
 *
 * 规则：<agentDir>/sessions/--<encoded-cwd>--/
 *
 * @returns session 目录的绝对路径
 */
export function resolveSessionDir(cwd: string): string {
	return getDefaultSessionDirPath(cwd);
}

/**
 * 从 main repoRoot 和 worktree name 生成稳定的会话文件路径。
 *
 * 格式：<mainSessionDir>/worktree-<name>.jsonl
 * 后缀 name 部分做路径安全化（替换 / 为 -）
 */
export function worktreeSessionFileName(repoRoot: string, name: string): string {
	const sessionDir = resolveSessionDir(repoRoot);
	const safeName = name.replace(/[/\\:]/g, '-');
	return join(sessionDir, `worktree-${safeName}.jsonl`);
}

/**
 * 获取 main 仓库的会话文件路径。
 */
export function mainSessionFileName(repoRoot: string): string {
	const sessionDir = resolveSessionDir(repoRoot);
	return join(sessionDir, 'main.jsonl');
}

/**
 * 检查目标 cwd 是否有存在的会话文件。
 *
 * 搜索顺序：
 * 1. 旧格式：worktreeSessionFileName（主仓库 session 目录下的 worktree-<name>.jsonl）
 * 2. 新格式：目标 cwd 自己的 session 目录中的 .jsonl 文件（clone 写入的）
 *
 * 返回第一个 header.cwd === targetCwd 的有效文件。
 */
export function findExistingSession(
	targetCwd: string,
	repoRoot: string,
	targetName: string,
): string | null {
	const isMain = targetName === 'main';
	const sessionPath = isMain
		? mainSessionFileName(repoRoot)
		: worktreeSessionFileName(repoRoot, targetName);

	if (existsSync(sessionPath)) {
		try {
			const sm = SessionManager.open(sessionPath);
			if (sm && sm.getCwd() === targetCwd) return sessionPath;
		} catch {
			/* header 不匹配或文件损坏 */
		}
	}

	// 新格式：在目标 cwd 的 session 目录查找
	if (!isMain) {
		const sessionDir = resolveSessionDir(targetCwd);
		if (existsSync(sessionDir)) {
			const files = readdirSync(sessionDir, { withFileTypes: true });
			const sessionFiles = files
				.filter((f) => f.isFile() && f.name.endsWith('.jsonl'))
				.map((f) => join(sessionDir, f.name));
			for (const fp of sessionFiles) {
				try {
					const sm = SessionManager.open(fp);
					if (sm && sm.getCwd() === targetCwd) return fp;
				} catch {
					continue;
				}
			}
		}
	}

	return null;
}

/**
 * 创建新会话文件并返回路径。
 * header cwd = targetCwd，文件存于 main repo session 目录。
 *
 * Session 文件格式（JSONL）：
 *   {"type":"session","version":3,"id":"<uuid>","timestamp":"<ISO>","cwd":"<path>"}
 *   ...
 *
 * 使用正确的 v3 格式以确保 SessionManager.open 能正确解析 cwd。
 */
export function createSession(targetCwd: string, repoRoot: string, targetName: string): string {
	const sessionDir = resolveSessionDir(repoRoot);

	if (!existsSync(sessionDir)) {
		mkdirSync(sessionDir, { recursive: true });
	}

	const filePath = worktreeSessionFileName(repoRoot, targetName);

	// 写入合法的 v3 session header
	// type: "session" 是 SessionManager.find(e => e.type === "session") 查找的关键标识
	const header = JSON.stringify({
		type: 'session',
		version: 3,
		id: crypto.randomUUID(),
		timestamp: new Date().toISOString(),
		cwd: targetCwd,
	});
	writeFileSync(filePath, header + '\n', 'utf-8');

	log.info('created session file', { targetCwd, filePath });
	return filePath;
}

// ── 克隆 ──

/**
 * 克隆当前会话到目标 cwd 的 session 目录。
 *
 * 读取源 session 文件，生成新 header id，重映射 parentId 链，
 * 确保克隆后的会话树完整独立，不与源文件共享 id。
 *
 * @param sourcePath - 当前 session 文件绝对路径
 * @param targetCwd - 目标目录（worktree 路径）
 * @returns 克隆后的 session 文件路径
 */
export function cloneSession(sourcePath: string, targetCwd: string): string {
	const content = readFileSync(sourcePath, 'utf-8');
	const lines = content.trim().split('\n').filter(Boolean);
	const entries: any[] = [];
	for (const l of lines) {
		try {
			entries.push(JSON.parse(l));
		} catch {
			log.warn('clone: skipping malformed line', { line: l.slice(0, 100) });
		}
	}

	// 找到旧 header 和它的 id
	const oldHeader = entries.find((e: any) => e.type === 'session');
	if (!oldHeader) {
		throw new Error(`Cannot clone: source session has no header: ${sourcePath}`);
	}
	const oldId = oldHeader.id;
	const newId = crypto.randomUUID();
	const now = new Date().toISOString();

	// 3. 新 header：保持 version，更新 id/timestamp/cwd
	const newHeader = { ...oldHeader, id: newId, timestamp: now, cwd: targetCwd };

	// 4. 重映射 parentId：所有指向旧 header id 的改为新 id
	const newEntries = entries.map((e: any) => {
		if (e.type === 'session') return newHeader;
		return { ...e, parentId: e.parentId === oldId ? newId : e.parentId };
	});

	// 5. 写入 targetCwd 的 session 目录
	const sessionDir = resolveSessionDir(targetCwd);
	if (!existsSync(sessionDir)) {
		mkdirSync(sessionDir, { recursive: true });
	}

	const fileTimestamp = now.replace(/[:.]/g, '-');
	const filePath = join(sessionDir, `${fileTimestamp}_${newId}.jsonl`);
	writeFileSync(filePath, newEntries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8');

	// 6. 写入 .clone-meta.json
	const meta: CloneMeta = {
		sourceCwd: oldHeader.cwd,
		targetCwd,
		clonedAt: now,
		sourceSessionId: oldId,
		targetSessionId: newId,
	};
	writeFileSync(join(sessionDir, '.clone-meta.json'), JSON.stringify(meta, null, 2), 'utf-8');

	log.info('cloned session', { source: sourcePath, target: filePath, newId, targetCwd });
	return filePath;
}

/**
 * 检查目标目录是否已有从 sourceCwd 克隆而来的会话。
 * @returns CloneMeta 如果存在且来源匹配，否则返回 null
 */
export function hasClonedSession(targetCwd: string, sourceCwd: string): CloneMeta | null {
	const sessionDir = resolveSessionDir(targetCwd);
	const metaPath = join(sessionDir, '.clone-meta.json');
	if (!existsSync(metaPath)) return null;

	try {
		const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as CloneMeta;
		return meta.sourceCwd === sourceCwd ? meta : null;
	} catch {
		return null;
	}
}

/**
 * 查找目标目录中来自 sourceCwd 的克隆会话文件路径。
 * 读取 .clone-meta.json 的 targetSessionId，查找 session 目录中匹配的 .jsonl 文件。
 * @returns 会话文件路径，或 null
 */
export function findClonedSessionFile(targetCwd: string, sourceCwd: string): string | null {
	const meta = hasClonedSession(targetCwd, sourceCwd);
	if (!meta) return null;

	const sessionDir = resolveSessionDir(targetCwd);
	if (!existsSync(sessionDir)) return null;

	// 查找 <timestamp>_<targetSessionId>.jsonl
	const files = readdirSync(sessionDir, { withFileTypes: true });
	for (const f of files) {
		if (f.isFile() && f.name.endsWith('.jsonl') && f.name.includes(meta.targetSessionId)) {
			return join(sessionDir, f.name);
		}
	}

	// 降级：返回第一个非 .jsonl 文件（排除 clone-meta）
	const jsonlFiles = files
		.filter((f) => f.isFile() && f.name.endsWith('.jsonl'))
		.map((f) => join(sessionDir, f.name));
	return jsonlFiles[0] || null;
}

// ── 切换执行 ──

/**
 * 切换到目标 cwd（无声切换）。
 *
 * @param ctx - pi 命令上下文
 * @param targetCwd - 目标 cwd 绝对路径
 * @param sessionFile - 要切换到的会话文件路径
 */
export async function switchToSession(
	ctx: any,
	targetCwd: string,
	sessionFile: string,
): Promise<boolean> {
	try {
		await ctx.switchSession(sessionFile, {
			withSession: async () => {
				log.info('switched session', {
					cwd: targetCwd,
					sessionFile,
				});
			},
		});
		return true;
	} catch (err) {
		log.error('session switch failed', {
			error: String(err),
			targetCwd,
		});
		return false;
	}
}

/**
 * Fork 当前会话到目标 worktree（复制历史记录）。
 *
 * 直接从 ctx.sessionManager.getEntries() 获取当前会话的所有条目，
 * 写入新的 session 文件（含正确的 cwd header），无需源文件存在。
 *
 * @returns 目标会话文件路径
 */
export function forkToNewSession(
	ctx: any,
	targetCwd: string,
	repoRoot: string,
	targetName: string,
): string {
	const sessionDir = resolveSessionDir(repoRoot);
	if (!existsSync(sessionDir)) {
		mkdirSync(sessionDir, { recursive: true });
	}

	const filePath = worktreeSessionFileName(repoRoot, targetName);
	log.info('fork: start', { targetCwd, filePath, hasSM: !!ctx.sessionManager });

	// ── 策略 A：SessionManager.forkFrom() ──
	try {
		const sourceFile: string | undefined = ctx.sessionManager?.getSessionFile?.();
		log.info('fork: getSessionFile()', {
			sourceFile,
			exists: sourceFile ? existsSync(sourceFile) : false,
		});

		if (sourceFile && existsSync(sourceFile)) {
			const sm = SessionManager.forkFrom(sourceFile, targetCwd, sessionDir);
			const forkedFile = sm.getSessionFile();
			if (forkedFile) {
				log.info('fork: SessionManager.forkFrom ok', { source: sourceFile, forkedFile });
				// 复制到标准路径 worktree-<name>.jsonl
				const src = readFileSync(forkedFile, 'utf-8');
				writeFileSync(filePath, src, 'utf-8');
				return filePath;
			}
		}
	} catch (err) {
		log.warn('fork: forkFrom failed', { error: String(err) });
	}

	// ── 策略 B：getEntries() 手动复制 ──
	try {
		let entries: any[] = [];
		if (typeof ctx.sessionManager?.getEntries === 'function') {
			entries = ctx.sessionManager.getEntries() ?? [];
		}
		log.info('fork: getEntries()', { count: entries.length });

		if (entries.length > 0) {
			const newId = crypto.randomUUID();
			const now = new Date().toISOString();
			const sourceFile: string =
				(typeof ctx.sessionManager?.getSessionFile === 'function'
					? ctx.sessionManager.getSessionFile()
					: undefined) ?? '';

			// 获取源 header id 用于 parentId 重映射
			const sourceHeader =
				typeof ctx.sessionManager?.getHeader === 'function'
					? ctx.sessionManager.getHeader()
					: null;
			const oldHeaderId = sourceHeader?.id ?? '';

			const header = {
				type: 'session',
				version: 3,
				id: newId,
				timestamp: now,
				cwd: targetCwd,
				...(sourceFile ? { parentSession: sourceFile } : {}),
			};

			// 保留原始 entry 的 id/parentId 链，添加新 header
			// 重映射：将第一个 entry（消息/事件）的 parentId 从旧 header id 改为 newId
			const remapped = entries.map((e: any, idx: number) => {
				const entry = { ...e };
				if (idx === 0 && oldHeaderId && entry.parentId === oldHeaderId) {
					entry.parentId = newId;
				}
				return entry;
			});
			const allEntries = [header, ...remapped];
			writeFileSync(
				filePath,
				allEntries.map((e) => JSON.stringify(e)).join('\n') + '\n',
				'utf-8',
			);
			log.info('fork: manual copy ok', { count: allEntries.length, newId });
			return filePath;
		}
	} catch (err) {
		log.warn('fork: manual copy failed', { error: String(err) });
	}

	// ── 策略 C：空 session（降级） ──
	log.warn('fork: all strategies failed, creating empty session');
	return createSession(targetCwd, repoRoot, targetName);
}

/**
 * project_trust 自动批准。
 * 对 worktree 路径自动批准，避免用户在切换 worktree 时频繁确认信任。
 */
export function autoApproveProjectTrust(repoRoot: string, cwd: string): boolean {
	const worktreesDir = getWorktreesDir(repoRoot);
	return cwd.startsWith(worktreesDir + '/');
}
