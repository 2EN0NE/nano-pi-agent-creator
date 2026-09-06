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
import { join, resolve, sep } from 'node:path';
import {
	existsSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	readdirSync,
	realpathSync,
} from 'node:fs';
import crypto from 'node:crypto';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { getDefaultSessionDirPath, getManagedWorktrees } from './paths.js';
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
	const sessionDir = resolveSessionDir(targetCwd);

	// 1. 优先扫描目标 cwd 的 session 目录中已有的所有 .jsonl 文件
	//    对 main 尤其重要：Pi 默认用 <timestamp>_<uuid>.jsonl，不叫 main.jsonl
	//    先扫目录能找到这些真实 session（含历史记录），而非空的新建文件
	if (existsSync(sessionDir)) {
		const files = readdirSync(sessionDir, { withFileTypes: true });
		const sessionFiles = files
			.filter((f) => f.isFile() && f.name.endsWith('.jsonl'))
			.map((f) => join(sessionDir, f.name));
		for (const fp of sessionFiles) {
			// 跳过本插件建立的 worktree-*.jsonl（由候选人路径统一处理）
			if (fp.includes('worktree-')) continue;
			// 跳过 main.jsonl（同样由候选人路径处理）
			if (fp.endsWith('main.jsonl') || fp.endsWith('worktree-main.jsonl')) continue;
			try {
				const sm = SessionManager.open(fp);
				if (sm && sm.getCwd() === targetCwd) return fp;
			} catch {
				/* 跳过损坏的 session 文件 */
			}
		}
	}

	// 2. 降级检查本插件命名的候选人文件（兼容旧创建的文件）
	const candidates: string[] = isMain
		? [mainSessionFileName(repoRoot), worktreeSessionFileName(repoRoot, 'main')]
		: [worktreeSessionFileName(repoRoot, targetName)];

	for (const sessionPath of candidates) {
		if (existsSync(sessionPath)) {
			try {
				const sm = SessionManager.open(sessionPath);
				if (sm && sm.getCwd() === targetCwd) return sessionPath;
			} catch {
				/* header 不匹配或文件损坏 */
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

	const filePath =
		targetName === 'main'
			? mainSessionFileName(repoRoot)
			: worktreeSessionFileName(repoRoot, targetName);

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

// ── 路径改写（clone / fork 共用） ──

/**
 * 递归改写值中的源 cwd 路径 → 目标 cwd 路径。
 *
 * clone/fork 复制源会话的完整历史——包括源 cwd 绝对路径（bash `cd` 命令、
 * read/write/edit 的绝对路径）以及 pi 默认注入在会话头部的 context 内容
 * （如 skills-cache 等 custom entry 里的 filePath）。软切换后 agent 会沿这些
 * 历史路径继续操作源目录（心智残留），产物落回源目录而非目标 worktree。
 *
 * 左右边界断言既匹配 `cd <cwd>`、`"<cwd>/…`、字符串末尾的 `<cwd>`，又避免误伤兄弟目录
 * `<cwd>-worktrees/…`：
 *   - lookbehind：cwd 前不能是路径字符（字母数字、. _ -）
 *   - lookahead：cwd 后不能是路径字符，也不能是「空格 + 路径字符」
 *     （表示空格后仍是更长路径的组成部分，如 `<cwd> backup/…`），
 *     但不排除 `cd <cwd> && …` 这类命令分隔（空格后是 & 等命令字符）
 *
 * 已知局限：targetCwd 嵌套在 sourceCwd 之下（如 `<repo>/wt/<name>`）时本函数
 * 整体跳过改写（见下方守卫）——sourceCwd 是 targetCwd 的前缀，无法用单字符
 * 断言区分「sourceCwd 独立出现」与「作为 target 子路径出现」，改写真会双重
 * 改写历史中已有的 target 路径。保守跳过（保留源路径）比改写错更安全。
 */
function rewriteCwdPaths(value: any, sourceCwd: string, targetCwd: string): any {
	// 嵌套 worktree（target 是 source 的子路径）：跳过改写，避免前缀双重改写
	if (targetCwd.startsWith(sourceCwd + sep)) return value;

	const escapedSource = sourceCwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const sourceCwdRe = new RegExp(
		'(?<![A-Za-z0-9._-])' + escapedSource + '(?![A-Za-z0-9._-]| [A-Za-z0-9._-])',
		'g',
	);
	const rewrite = (v: any): any => {
		if (typeof v === 'string') return v.replace(sourceCwdRe, targetCwd);
		if (Array.isArray(v)) return v.map(rewrite);
		if (v && typeof v === 'object') {
			const out: any = {};
			for (const [k, val] of Object.entries(v)) out[k] = rewrite(val);
			return out;
		}
		return v;
	};
	return rewrite(value);
}

/**
 * 读 session 文件 header 的 cwd（首行 JSON 的 cwd 字段）。
 * 失败返回 null（调用方降级为不改写路径）。
 */
function readSessionCwd(filePath: string): string | null {
	try {
		const content = readFileSync(filePath, 'utf-8');
		const firstLine = content.trim().split('\n')[0];
		if (!firstLine) return null;
		const header = JSON.parse(firstLine);
		return typeof header.cwd === 'string' ? header.cwd : null;
	} catch {
		return null;
	}
}

// ── 克隆 ──

/**
 * 克隆当前会话到目标 cwd 的 session 目录。
 *
 * 读取源 session 文件，生成新 header id，重映射 parentId 链，
 * 确保克隆后的会话树完整独立，不与源文件共享 id。
 *
 * 设计决策：JSON 解析采用 fail-fast 策略 —— 任何损坏的 JSON 行都会
 * 立即 throw Error，中断整个克隆操作。这是因为：
 *   - 损坏的 session 文件意味着数据完整性已被破坏，不应静默传播
 *   - 部分克隆可能导致用户误以为数据完整（丢失的 entries 不可见）
 *   - 与 SessionManager 内部的行为保持一致（损坏文件无法 open）
 *
 * @param sourcePath - 当前 session 文件绝对路径
 * @param targetCwd - 目标目录（worktree 路径）
 * @returns 克隆后的 session 文件路径
 * @throws {Error} 如果源 session 文件包含无法解析的 JSON 行
 */
export function cloneSession(sourcePath: string, targetCwd: string): string {
	const content = readFileSync(sourcePath, 'utf-8');
	const lines = content.trim().split('\n').filter(Boolean);
	const entries: any[] = [];
	for (let i = 0; i < lines.length; i++) {
		try {
			entries.push(JSON.parse(lines[i]));
		} catch {
			throw new Error(
				`clone: malformed JSON at line ${i + 1} in ${sourcePath}: ${lines[i].slice(0, 120)}`,
			);
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

	// 4. 重映射 parentId + 路径改写（源 cwd → 目标 cwd）
	// clone/fork 复制历史会带源 cwd 路径，需改写——见 rewriteCwdPaths 注释。
	// 与 fork 策略对齐：sourceCwd 缺失/为空/等于 targetCwd 时跳过改写
	// （空串会使正则匹配每个边界位置，造成全局污染；undefined 会直接抛错）。
	const sourceCwd = oldHeader.cwd;
	const shouldRewrite = sourceCwd && sourceCwd !== targetCwd;

	const newEntries = entries.map((e: any) => {
		if (e.type === 'session') return newHeader;
		const remapped = { ...e, parentId: e.parentId === oldId ? newId : e.parentId };
		return shouldRewrite ? rewriteCwdPaths(remapped, sourceCwd, targetCwd) : remapped;
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
		// 路径归一化比较：clone-meta 存的是 clone 时的会话 header cwd（可能为 /var/...），
		// 而当前会话 getCwd() 可能为 /private/var/...（同一目录，macOS 符号链接），
		// 直接 === 字符串比较会漏检。用 realpathSync 归一化后再比较。
		const metaCwd = normalizeRealPath(meta.sourceCwd);
		const curCwd = normalizeRealPath(sourceCwd);
		return metaCwd === curCwd ? meta : null;
	} catch {
		return null;
	}
}

/** realpath 归一化（失败时回退原始路径）。 */
function normalizeRealPath(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
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
				// 路径改写：forkFrom 只改 header cwd，历史里的源 cwd 绝对路径仍会
				// 诱导 agent 操作源目录。改写后写入标准路径 worktree-<name>.jsonl。
				const sourceCwd = readSessionCwd(sourceFile);
				if (sourceCwd && sourceCwd !== targetCwd) {
					const lines = readFileSync(forkedFile, 'utf-8')
						.trim()
						.split('\n')
						.filter(Boolean);
					const rewritten = lines
						.map((l) => JSON.parse(l))
						.map((e: any) => rewriteCwdPaths(e, sourceCwd, targetCwd));
					writeFileSync(
						filePath,
						rewritten.map((e) => JSON.stringify(e)).join('\n') + '\n',
						'utf-8',
					);
				} else {
					const src = readFileSync(forkedFile, 'utf-8');
					writeFileSync(filePath, src, 'utf-8');
				}
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

		// 过滤掉可能已存在的 session header，防止重复
		const filteredEntries = entries.filter((e: any) => e.type !== 'session');

		// 至少需要 1 条有效条目（不含 header）才能构建有意义的 fork
		if (filteredEntries.length > 0) {
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
			// 重映射：将旧的 parentId 指向旧 header 的改为指向新 header id
			// 路径改写：源 cwd → 目标 cwd（fork 复制历史带源路径，见 rewriteCwdPaths）
			const sourceCwd = sourceHeader?.cwd ?? '';
			const remapped = filteredEntries.map((e: any) => {
				const entry = { ...e };
				if (oldHeaderId && entry.parentId === oldHeaderId) {
					entry.parentId = newId;
				}
				return sourceCwd && sourceCwd !== targetCwd
					? rewriteCwdPaths(entry, sourceCwd, targetCwd)
					: entry;
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
	const resolved = resolve(cwd);
	// 约定目录内（向后兼容：exact match 或路径前缀）
	const worktreesDir = resolve(getWorktreesDir(repoRoot));
	if (resolved === worktreesDir || resolved.startsWith(worktreesDir + sep)) return true;
	// 任意位置的 git worktree（含仓库内 wt/ 等外部 worktree）
	return getManagedWorktrees(repoRoot).some(
		(wt) => resolved === wt.path || resolved.startsWith(wt.path + sep),
	);
}
