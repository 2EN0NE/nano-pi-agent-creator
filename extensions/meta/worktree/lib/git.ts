/**
 * pi-worktree — Git 辅助函数（单 repo 版）
 */
import { execSync, spawnSync } from 'node:child_process';

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
 * 分支与 origin/base 的 ahead/behind 数。
 */
export function getAheadBehind(
	repoPath: string,
	branch: string,
	remote?: string,
): { ahead: number; behind: number } {
	try {
		const ref = remote ? `${remote}/${branch}` : `origin/${branch}`;
		const out = execSync(`git rev-list --left-right --count ${ref}...HEAD`, {
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
