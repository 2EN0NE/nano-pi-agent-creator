/**
 * pi-worktree — Core worktree 操作（创建/删除/查询/命名）
 *
 * 所有 worktree 存放在主仓库外：<parentDir>/<repoName>-worktrees/<name>/
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createLogger } from '@zenone/pi-logger';
import type { OpResult, SymlinkSelections } from '../types.js';
import { getWorktreePath, resolveWorktreePath, getManagedWorktrees } from './paths.js';
import { getDefaultBranch } from './git.js';
import { runWorktreeSetup } from './setup.js';
import type { NodeModulesStrategy } from '../types.js';
import { getNamePool, constellationOf } from '../stars.js';

const log = createLogger('pi-worktree');

// ── 名称分配 ──

export function getExistingNames(repoRoot: string): Set<string> {
	const existing = new Set<string>();
	const wts = getManagedWorktrees(repoRoot);
	for (const wt of wts) existing.add(wt.name);
	return existing;
}

export function pickAvailableName(repoRoot: string): string {
	const existing = getExistingNames(repoRoot);
	const pool = getNamePool();
	const available = pool.filter((n) => !existing.has(n));
	if (available.length > 0) return available[Math.floor(Math.random() * available.length)];
	// 池用尽：星座-minor~N 后备
	const lastCons = [...existing].map((n) => constellationOf(n)).filter(Boolean) as string[];
	const cons = lastCons.length > 0 ? lastCons[lastCons.length - 1] : 'Zodiac';
	return `${cons}-minor~${existing.size + 1}`;
}

// ── 创建 worktree ──

export function createWorktree(
	repoRoot: string,
	name: string,
	nodeModulesStrat?: NodeModulesStrategy,
	selections?: SymlinkSelections,
): OpResult {
	const targetDir = getWorktreePath(repoRoot, name);

	if (existsSync(targetDir))
		return { ok: false, message: `Worktree '${name}' already exists at ${targetDir}` };

	const newBranch = `wt/${name}`;
	const defaultBranch = getDefaultBranch(repoRoot);
	const addArgs = defaultBranch
		? ['worktree', 'add', '-b', newBranch, targetDir, `origin/${defaultBranch}`]
		: ['worktree', 'add', '-b', newBranch, targetDir];

	const nmStrategy = (nodeModulesStrat || selections?.nodeModulesStrategy) ?? 'none';

	const result = spawnSync('git', addArgs, { cwd: repoRoot, encoding: 'utf-8' });

	if (result.status !== 0) {
		const err = result.stderr?.trim() || 'Unknown error';
		// 分支已存在 → 复用该分支（wt/<name>）。用 show-ref 判断分支存在性，
		// 不依赖 git 的错误文案（跨版本/locale 不稳定）。
		const branchExists =
			spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${newBranch}`], {
				cwd: repoRoot,
				encoding: 'utf-8',
			}).status === 0;
		if (branchExists) {
			const r2 = spawnSync('git', ['worktree', 'add', targetDir, newBranch], {
				cwd: repoRoot,
				encoding: 'utf-8',
			});
			if (r2.status !== 0) return { ok: false, message: `Failed: ${r2.stderr?.trim()}` };
			const setupNotes = runWorktreeSetup(repoRoot, targetDir, nmStrategy, selections);
			return {
				ok: true,
				message: `Created '${name}' (existing branch)\n  ${setupNotes.join('\n  ')}`,
				path: targetDir,
			};
		}
		return { ok: false, message: `Failed: ${err}` };
	}

	const setupNotes = runWorktreeSetup(repoRoot, targetDir, nmStrategy, selections);
	return {
		ok: true,
		message: `Created '${name}' → ${newBranch}${defaultBranch ? ` (from origin/${defaultBranch})` : ''}\n  ${setupNotes.join('\n  ')}`,
		path: targetDir,
	};
}

// ── 删除 worktree ──

export function removeWorktree(repoRoot: string, name: string, force?: boolean): OpResult {
	const targetDir = resolveWorktreePath(repoRoot, name);

	// 安全守卫：目标必须是 git worktree list 中的真实 worktree（防误删 main checkout 或任意目录）
	const isRealWorktree = getManagedWorktrees(repoRoot).some((w) => w.path === targetDir);
	if (!isRealWorktree) {
		return {
			ok: false,
			message:
				targetDir === resolve(repoRoot)
					? 'SAFETY 拒绝：不能删除 main checkout。'
					: `SAFETY 拒绝：'${targetDir}' 不是受管理的 git worktree。`,
		};
	}

	if (!existsSync(targetDir))
		return { ok: false, message: `Worktree '${name}' not found at ${targetDir}` };

	const args = force
		? ['worktree', 'remove', targetDir, '--force']
		: ['worktree', 'remove', targetDir];
	const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf-8' });

	if (result.status !== 0) {
		const msg = result.stderr?.trim() || 'unknown error';
		return { ok: false, message: `Failed: ${msg}` };
	}

	log.info('removed worktree', { name, targetDir, force });
	return { ok: true, message: `Removed '${name}'${force ? ' (force)' : ''}` };
}

export function deleteWorktreeBranch(repoRoot: string, name: string, force?: boolean): string[] {
	const msgs: string[] = [];
	const branch = `wt/${name}`;

	// 检查是否已合并，未合并且不是 force 时跳过
	if (!force) {
		const merged = spawnSync('git', ['merge-base', '--is-ancestor', branch, 'HEAD'], {
			cwd: repoRoot,
			encoding: 'utf-8',
		});
		if (merged.status !== 0) {
			msgs.push(`Branch '${branch}' has unpushed/merged commits`);
			return msgs;
		}
	}

	const localDel = spawnSync('git', ['branch', '-D', branch], {
		cwd: repoRoot,
		encoding: 'utf-8',
	});
	if (localDel.status === 0) {
		msgs.push(`Deleted local branch '${branch}'`);
		// 远端分支不做任何操作（ADR-0019：不 push、不在命令中隐含远端副作用）。
		// 若远端存在 origin/wt/<name>，提示用户自行 `git push origin --delete` 清理。
		msgs.push(
			`Remote branch 'origin/${branch}' (if any) untouched — delete manually if needed`,
		);
	}

	return msgs;
}

// ── 查询 worktree ──

/**
 * 获取所有 managed worktree（别名：从 paths.ts 暴露）。
 */
export { getManagedWorktrees as getExistingWorktrees } from './paths.js';

/**
 * 查找已合并的 worktree（用于 clean 命令）。
 *
 * 先尝试 `git fetch origin <branch>` 同步远程状态，
 * 然后检查分支是否已合并到本地 HEAD 或 origin/<branch>。
 * 两者任一已合并则视为可清理。
 */
export function findMergedWorktrees(
	repoRoot: string,
	exclude?: Set<string>,
): Array<{ name: string; branch: string }> {
	const ex = exclude || new Set();
	const wts = getManagedWorktrees(repoRoot).filter(
		(wt) => !ex.has(wt.name) && wt.branch !== 'detached',
	);
	if (wts.length === 0) return [];

	// 单次 fetch 同步所有远程状态（而非每个分支各一次）
	spawnSync('git', ['fetch', 'origin', '--quiet'], {
		cwd: repoRoot,
		encoding: 'utf-8',
	});

	return wts
		.filter((wt) => {
			// 检查是否已合并到本地 HEAD
			const local = spawnSync('git', ['merge-base', '--is-ancestor', wt.branch, 'HEAD'], {
				cwd: repoRoot,
				encoding: 'utf-8',
			});
			if (local.status === 0) return true;

			// 检查是否已合并到 origin/<branch>
			const remote = spawnSync(
				'git',
				['merge-base', '--is-ancestor', `origin/${wt.branch}`, 'HEAD'],
				{ cwd: repoRoot, encoding: 'utf-8' },
			);
			return remote.status === 0;
		})
		.map((wt) => ({ name: wt.name, branch: wt.branch }));
}
