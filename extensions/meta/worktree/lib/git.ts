/**
 * pi-worktree — Git 辅助函数（单 repo 版）
 */
import { execSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '@zenone/pi-logger';

const log = createLogger('pi-worktree');

// ── 基础 git ──

export function getCurrentBranch(repoPath: string): string {
	try {
		return execSync('git rev-parse --abbrev-ref HEAD', {
			cwd: repoPath,
			encoding: 'utf-8',
		}).trim();
	} catch {
		return 'main';
	}
}

export function getDefaultBranch(repoPath: string): string | null {
	try {
		const ref = execSync('git symbolic-ref --quiet refs/remotes/origin/HEAD', {
			cwd: repoPath,
			encoding: 'utf-8',
		}).trim();
		return ref.replace(/^refs\/remotes\/origin\//, '') || null;
	} catch {
		for (const candidate of ['main', 'master']) {
			const check = spawnSync(
				'git',
				['show-ref', '--verify', '--quiet', `refs/remotes/origin/${candidate}`],
				{ cwd: repoPath, encoding: 'utf-8' },
			);
			if (check.status === 0) return candidate;
		}
		return null;
	}
}

// ── 状态采集 ──

/**
 * 计算工作区 dirty 文件数。
 */
export function getDirtyCount(repoPath: string): number {
	try {
		const out = execSync('git status --porcelain', {
			cwd: repoPath,
			encoding: 'utf-8',
		});
		return out.trim() ? out.trim().split('\n').length : 0;
	} catch {
		return 0;
	}
}

/**
 * 将 worktree 分支 rebase 到目标分支上。
 *
 * 使用 `git rebase <upstream> <branch>` 语法，无需 checkout 该分支
 * （避免与 worktree 的 checkout 冲突）。
 *
 * 流程：
 *   1. Fetch origin 获取最新 onto 分支
 *   2. git rebase origin/<ontoBranch> <sourceBranch>
 *   3. 失败时 abort 并恢复
 */
export function execRebase(
	repoRoot: string,
	sourceBranch: string,
	ontoBranch: string,
): { ok: boolean; message: string; conflicts: string[] } {
	const git = (args: string[]) =>
		spawnSync('git', args, { cwd: repoRoot, encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 });

	// 0. 清理遗留的悬空 rebase 状态（上一次 rebase 异常中断）
	const gitDir = join(repoRoot, '.git');
	if (existsSync(join(gitDir, 'rebase-merge')) || existsSync(join(gitDir, 'rebase-apply'))) {
		const abort = git(['rebase', '--abort']);
		if (abort.status !== 0) {
			return {
				ok: false,
				message: `Dangling rebase state detected but abort failed: ${abort.stderr?.trim() || 'unknown error'}. Run 'git rebase --abort' manually first.`,
				conflicts: [],
			};
		}
	}

	// 1. Fetch origin 获取最新 onto 分支
	const hasRemote = git(['remote', 'get-url', 'origin']).status === 0;
	if (hasRemote) {
		const fetch = git(['fetch', 'origin', ontoBranch, '--quiet']);
		if (fetch.status !== 0) {
			return {
				ok: false,
				message: `Cannot fetch 'origin/${ontoBranch}': ${fetch.stderr?.trim() || 'unknown error'}`,
				conflicts: [],
			};
		}
	}

	// 2. 直接 rebase（无需 checkout，避免 worktree checkout 冲突）
	const ontoRef = hasRemote ? `origin/${ontoBranch}` : ontoBranch;
	const rebase = git(['rebase', ontoRef, sourceBranch]);

	if (rebase.status === 0) {
		return {
			ok: true,
			message: `Rebased '${sourceBranch}' onto '${ontoRef}'`,
			conflicts: [],
		};
	}

	// P0-1: 冲突 → 留在 rebase 冲突状态，不 abort
	// 收集冲突文件
	const unmerged = (git(['diff', '--name-only', '--diff-filter=U']).stdout || '').trim();
	const conflictFiles = unmerged.split('\n').filter(Boolean);

	if (conflictFiles.length > 0) {
		return {
			ok: false,
			message: `Rebase failed. ${conflictFiles.length} file(s) conflict. Stay on branch with conflict markers.`,
			conflicts: conflictFiles,
		};
	}

	// 非冲突失败（rebase 根本没启动或前置检查失败）
	const stderr = rebase.stderr?.trim() || 'unknown error';
	return {
		ok: false,
		message: `Rebase failed: ${stderr.split('\n').pop() || stderr}`,
		conflicts: [],
	};
}

/**
 * 分支与 origin/base 的 ahead/behind 数。
 */
// ── Merge/Rebase 状态检测 ──

/**
 * 检测是否有 merge 正在进行中。
 */
export function isMergeInProgress(repoPath: string): boolean {
	return existsSync(join(repoPath, '.git', 'MERGE_MSG'));
}

/**
 * 检测是否有 rebase 正在进行中。
 */
export function isRebaseInProgress(repoPath: string): boolean {
	return (
		existsSync(join(repoPath, '.git', 'rebase-merge')) ||
		existsSync(join(repoPath, '.git', 'rebase-apply'))
	);
}

/**
 * 获取当前 merge/rebase 冲突文件列表。
 */
export function getConflictFiles(repoPath: string): string[] {
	try {
		const out = execSync('git diff --name-only --diff-filter=U', {
			cwd: repoPath,
			encoding: 'utf-8',
			timeout: 5000,
		});
		return out.trim().split('\n').filter(Boolean);
	} catch {
		return [];
	}
}

/**
 * 获取当前 merge 的源分支名（仅 merge in progress 时有值）。
 * 从 .git/MERGE_HEAD 读取。
 */
export function getMergeSourceBranch(repoPath: string): string | null {
	try {
		const mergeHeadPath = join(repoPath, '.git', 'MERGE_HEAD');
		if (!existsSync(mergeHeadPath)) return null;
		const mergeHead = execSync('git rev-parse --abbrev-ref MERGE_HEAD', {
			cwd: repoPath,
			encoding: 'utf-8',
			timeout: 5000,
		}).trim();
		return mergeHead || null;
	} catch {
		return null;
	}
}

/**
 * 查找由 worktree merge 自动创建的 stash 并 pop。
 * 匹配 stash message 前缀 'worktree-merge-auto-'。
 */
export function popWorktreeStash(repoPath: string): boolean {
	try {
		const list = execSync('git stash list', {
			cwd: repoPath,
			encoding: 'utf-8',
			timeout: 5000,
		});
		if (!list.includes('worktree-merge-auto-')) return false;
		execSync('git stash pop', { cwd: repoPath, encoding: 'utf-8' });
		log.info('popped auto-stash after abort/continue');
		return true;
	} catch {
		return false;
	}
}

// ── 与原 getAheadBehind 之间的间隙 ──

export function getAheadBehind(
	repoPath: string,
	branch: string,
	remote?: string,
): { ahead: number; behind: number } {
	try {
		const ref = remote ? `${remote}/${branch}` : `origin/${branch}`;
		const out = execSync(`git rev-list --left-right --count ${ref}...HEAD 2>/dev/null`, {
			cwd: repoPath,
			encoding: 'utf-8',
		}).trim();
		const parts = out.split('\t');
		return {
			behind: parseInt(parts[0] || '0', 10),
			ahead: parseInt(parts[1] || '0', 10),
		};
	} catch {
		return { ahead: 0, behind: 0 };
	}
}
