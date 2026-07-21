/**
 * cwd-bridge — 跨机器 session cwd 适配
 *
 * 问题：从另一台机器拉取的 session 文件中的原始 cwd（如 /home/zenone/...）
 * 在本地不存在（如 mac 上 /home 只读），导致 Pi 的 cwd 检查失败，
 * /tree 文件引用也无法正确解析。
 *
 * 解决方案：修改 session JSONL 文件第一行的 cwd 字段为当前工作目录。
 * 这样 Pi 的 cwd 检查通过，后续所有文件操作使用本地路径。
 *
 * 两种策略（按优先级）：
 *   1. 软连接（originalCwd → currentCwd）— 当目标父目录可写时
 *   2. cwd 重写（修改 JSONL 中的 cwd 字段）— 通用兜底
 *
 * 使用场景:
 *   机器 A: /home/zenone/.../nano-pi-stuff  →  会话在此创建
 *   机器 B: /Users/jojo/.../nano-pi-stuff    →  需要 resume
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { createLogger } from '@zenone/pi-logger';

const log = createLogger('pi-cloud-sessions:cwd-bridge');

// ─── Session 文件读取 ────────────────────────────────────────────────────

/**
 * 从 session JSONL 文件的第一行读取原始 cwd。
 *
 * session 文件格式（第一行）：
 *   {"type":"session","version":3,"id":"...","cwd":"/original/path",...}
 */
export function readSessionCwd(sessionFile: string): string | null {
	try {
		const content = readFileSync(sessionFile, 'utf-8');
		const firstLine = content.split('\n')[0];
		if (!firstLine) return null;
		const data = JSON.parse(firstLine);
		if (data && typeof data.cwd === 'string') return data.cwd;
		return null;
	} catch (err) {
		log.debug('failed to read cwd from %s: %s', sessionFile, (err as Error).message ?? err);
		return null;
	}
}

// ─── 检测 ────────────────────────────────────────────────────────────────

/**
 * 检查一个 session 文件是否需要 cwd 修复。
 *
 * 返回 true 当：
 * 1. session 文件中存有 cwd
 * 2. cwd 与当前工作目录不同
 * 3. cwd 在本地不存在（不是真实目录）
 */
export function needsCwdFix(sessionFile: string, currentCwd: string): boolean {
	const sessionCwd = readSessionCwd(sessionFile);
	if (!sessionCwd) return false;
	if (sessionCwd === currentCwd) return false;
	try {
		if (statSync(sessionCwd).isDirectory()) return false;
	} catch {
		// 路径不存在 → 需要修复
	}
	return true;
}

/**
 * 检测已加载 session 的 cwd 不匹配（用于 session_start 事后检测）。
 */
export function detectCwdMismatch(
	sessionFile: string | undefined,
	currentCwd: string,
): { originalCwd: string } | null {
	if (!sessionFile) return null;
	try {
		if (!existsSync(sessionFile)) return null;
	} catch {
		return null;
	}
	const originalCwd = readSessionCwd(sessionFile);
	if (!originalCwd) return null;
	if (originalCwd === currentCwd) return null;
	try {
		if (statSync(originalCwd).isDirectory()) return null;
	} catch {
		return { originalCwd };
	}
	return { originalCwd };
}

// ─── 策略 1: 软连接 ─────────────────────────────────────────────────────

/**
 * 检查是否可以通过软连接修复。
 * 需要目标父目录可写。
 */
export function canCreateSymlink(originalCwd: string): boolean {
	try {
		const parent = dirname(originalCwd);
		const testFile = `${parent}/.pi-cwd-test-${Date.now()}`;
		mkdirSync(parent, { recursive: true });
		writeFileSync(testFile, '');
		unlinkSync(testFile);
		return true;
	} catch (err) {
		log.warn(
			'cannot create symlink at %s: parent dir not writable (%s)',
			originalCwd,
			(err as Error).message ?? err,
		);
		return false;
	}
}

/**
 * 创建软连接: originalCwd → currentCwd。
 * 自动处理父目录创建和过期条目清理。
 *
 * @returns 是/否成功；失败时已记录日志
 */
export function createCwdSymlink(originalCwd: string, currentCwd: string): boolean {
	try {
		mkdirSync(dirname(originalCwd), { recursive: true });

		// 移除已存在的条目（但不是真实目录）
		try {
			const s = statSync(originalCwd);
			if (s.isDirectory()) {
				log.warn(
					'real directory blocks symlink at %s (is a real dir, not a stale symlink)',
					originalCwd,
				);
				return false;
			}
			// 存在但非目录（如失效的软连接）→ 移除
			unlinkSync(originalCwd);
			log.info('removed stale entry at symlink target: %s', originalCwd);
		} catch {
			// 不存在 → 无需清理
		}

		symlinkSync(currentCwd, originalCwd);
		log.info('created symlink: %s -> %s', originalCwd, currentCwd);
		return true;
	} catch (err) {
		const syscall = (err as NodeJS.ErrnoException).syscall ?? 'symlink';
		const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
		log.error(
			'symlink failed (%s errno=%s): %s -> %s — %s',
			syscall,
			code,
			originalCwd,
			currentCwd,
			(err as Error).message ?? err,
		);
		return false;
	}
}

// ─── 策略 2: CWD 重写 ──────────────────────────────────────────────────

/**
 * 重写 session JSONL 文件中的 cwd 字段。
 *
 * 将第一行的 "cwd" 字段替换为新的路径，保持文件其他部分不变。
 *
 * @returns 是否成功
 */
export function rewriteSessionCwd(sessionFile: string, newCwd: string): boolean {
	try {
		const content = readFileSync(sessionFile, 'utf-8');
		const lines = content.split('\n');
		if (lines.length === 0) return false;

		const firstLine = lines[0];
		const data = JSON.parse(firstLine);
		if (!data || typeof data.cwd !== 'string') return false;

		const originalCwd = data.cwd;
		data.cwd = newCwd;
		lines[0] = JSON.stringify(data);

		writeFileSync(sessionFile, lines.join('\n'), 'utf-8');
		log.info('rewrote cwd in %s: %s → %s', sessionFile, originalCwd, newCwd);
		return true;
	} catch (err) {
		log.error('failed to rewrite cwd in %s: %s', sessionFile, (err as Error).message ?? err);
		return false;
	}
}

/**
 * 尝试用最佳策略修复 cwd 不匹配。
 *
 * 策略优先级：
 *   1. 软连接 — 可跨机器共享，文件本身不修改
 *   2. cwd 重写 — 通用方案，文件内容修改
 *
 * @returns 修复结果，含每步状态
 */
export interface FixCwdResult {
	/** 整体是否成功（任意策略生效即 true） */
	success: boolean;
	/** 父目录可写性检查结果（false = 跳过软连接策略） */
	parentWritable: boolean;
	/** 是否尝试了软连接创建 */
	symlinkAttempted: boolean;
	/** 软连接是否创建成功 */
	symlinkSucceeded: boolean;
	/** cwd 重写是否成功 */
	rewriteSucceeded: boolean;
}

export function fixCwdMismatch(
	originalCwd: string,
	currentCwd: string,
	sessionFile: string,
): FixCwdResult {
	const result: FixCwdResult = {
		success: false,
		parentWritable: false,
		symlinkAttempted: false,
		symlinkSucceeded: false,
		rewriteSucceeded: false,
	};

	// 策略 1: 软连接
	result.parentWritable = canCreateSymlink(originalCwd);
	if (result.parentWritable) {
		result.symlinkAttempted = true;
		log.info('symlink strategy: %s -> %s', originalCwd, currentCwd);
		result.symlinkSucceeded = createCwdSymlink(originalCwd, currentCwd);
		if (result.symlinkSucceeded) {
			result.success = true;
			log.info('symlink strategy succeeded');
			return result;
		}
		log.warn('symlink strategy failed, falling back to cwd rewrite');
	} else {
		log.info('parent dir not writable, skipping symlink strategy, using cwd rewrite');
	}

	// 策略 2: cwd 重写
	log.info('cwd rewrite strategy for %s', sessionFile);
	result.rewriteSucceeded = rewriteSessionCwd(sessionFile, currentCwd);
	result.success = result.rewriteSucceeded;
	if (result.rewriteSucceeded) {
		log.info('cwd rewrite strategy succeeded');
	} else {
		log.error('both symlink and cwd rewrite failed for %s', sessionFile);
	}
	return result;
}

// ─── UI 提示生成 ─────────────────────────────────────────────────────────

/**
 * 生成人类可读的路径对比描述，用于 UI 提示。
 */
export function formatCwdDiff(originalCwd: string, currentCwd: string): string {
	return `Session 原始工作目录（cwd）不存在：

  ${originalCwd}

是否修改 session 文件的 cwd 为当前工作目录？

  ${currentCwd}

修改后 Pi 的 cwd 检查将通过，/tree 和文件引用将正确解析。`;
}
