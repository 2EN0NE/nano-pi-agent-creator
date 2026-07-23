/**
 * reconcile.ts — 冲突解决引擎 + Merger 接口
 *
 * 职责：
 *  - ConflictResolver：纯决策引擎，输入 FileState 对，输出 Resolution
 *  - MtimeResolver：默认实现，基于 hash + mtime + tieBreaker 做 4 路决策
 *  - Merger：延迟读取文件内容，生成合并结果（未来 AI merge 的 seam）
 *
 * 本模块不依赖文件系统（Merger 除外）、不依赖 pi 扩展 API，可直接单元测试。
 */

// ============================================================================
// Types
// ============================================================================

export interface FileState {
	hash: string;
	mtimeMs: number;
}

export type ConflictAction = 'push_local' | 'pull_remote' | 'skip' | 'merge';

export interface Resolution {
	action: ConflictAction;
	/** 仅 action === 'merge' 时设置 */
	mergedContent?: string;
	/** 日志/调试用 */
	reason?: string;
}

// ============================================================================
// ConflictResolver — 纯决策引擎
// ============================================================================

export interface ConflictResolver {
	/** 根据本地和远程文件状态，返回决策。不执行任何文件操作。 */
	resolve(local: FileState | null, remote: FileState | null): Resolution;
}

export interface MtimeResolverOptions {
	/** 时间容忍窗口（毫秒），默认 1500 */
	toleranceMs?: number;
	/** 边界情况（|delta| <= toleranceMs）时优先推谁，默认 'local' */
	tieBreaker?: 'local' | 'remote';
}

/**
 * MtimeResolver — 基于 hash 和 mtime 的 4 路冲突解决策略。
 *
 * 决策逻辑：
 *   1. local only → push_local
 *   2. remote only → pull_remote
 *   3. hash 相同 → skip
 *   4. hash 不同 → 比较 mtime：
 *      a. delta > toleranceMs → push_local（本地较新）
 *      b. delta < -toleranceMs → pull_remote（远端较新）
 *      c. |delta| ≤ toleranceMs → 按 tieBreaker 方向优先
 */
export class MtimeResolver implements ConflictResolver {
	private readonly toleranceMs: number;
	private readonly tieBreaker: 'local' | 'remote';

	constructor(opts: MtimeResolverOptions = {}) {
		this.toleranceMs = opts.toleranceMs ?? 1500;
		this.tieBreaker = opts.tieBreaker ?? 'local';
	}

	resolve(local: FileState | null, remote: FileState | null): Resolution {
		// ── Only one side has the file ──────────────────────────────
		if (local && !remote) {
			return { action: 'push_local', reason: 'local-only' };
		}
		if (!local && remote) {
			return { action: 'pull_remote', reason: 'remote-only' };
		}
		if (!local && !remote) {
			return { action: 'skip', reason: 'both-null (should not happen)' };
		}

		// ── Both sides have the file ────────────────────────────────
		if (local!.hash === remote!.hash) {
			return { action: 'skip', reason: 'identical-hash' };
		}

		const delta = local!.mtimeMs - remote!.mtimeMs;

		if (delta > this.toleranceMs) {
			return { action: 'push_local', reason: 'local-newer' };
		}
		if (delta < -this.toleranceMs) {
			return { action: 'pull_remote', reason: 'remote-newer' };
		}

		// Within tolerance window — apply tieBreaker
		if (this.tieBreaker === 'local') {
			return {
				action: local!.mtimeMs >= remote!.mtimeMs ? 'push_local' : 'pull_remote',
				reason: `tie-break:local`,
			};
		}
		return {
			action: remote!.mtimeMs >= local!.mtimeMs ? 'pull_remote' : 'push_local',
			reason: `tie-break:remote`,
		};
	}
}

// ============================================================================
// Merger — 延迟读取内容并生成合并结果
// ============================================================================

/**
 * Merger 负责在 ConflictResolver 返回 `merge` 后，读取双边文件内容并生成合并结果。
 *
 * 当前无默认实现——等到 AI 合并或 3-way merge 需求到来时再实现。
 */
export interface Merger {
	/** 读取 localPath 和 remotePath 的文件内容，返回合并后的完整内容。 */
	merge(localPath: string, remotePath: string): Promise<string>;
}
