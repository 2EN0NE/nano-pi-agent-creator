/**
 * pi-worktree — Git 辅助函数（单 repo 版）
 */
import { execSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
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

/**
 * 探测目录是否存在进行中的 rebase 状态（rebase-merge 或 rebase-apply）。
 * rebase 状态位于该目录的 gitDir 下（worktree 为 .git/worktrees/<name>/）。
 * 供 execRebase 悬空清理与 findInProgressDir 复用。
 */
export function hasRebaseState(dir: string): boolean {
	try {
		const rbMerge = resolve(
			dir,
			execSync('git rev-parse --git-path rebase-merge', {
				cwd: dir,
				encoding: 'utf-8',
			}).trim(),
		);
		const rbApply = resolve(
			dir,
			execSync('git rev-parse --git-path rebase-apply', {
				cwd: dir,
				encoding: 'utf-8',
			}).trim(),
		);
		return existsSync(rbMerge) || existsSync(rbApply);
	} catch {
		return false;
	}
}

/**
 * 判断 rebase 是否停在冲突待解决状态（有未完成的 rebase 进度）。
 * merge backend：rebase-merge/stopped-sha 存在（冲突中止）；
 * apply backend（legacy）：rebase-apply 目录存在（该 backend 下状态几乎总是冲突/进行中）。
 * 区别于"异常中断的残留"：冲突中止时可能已有用户手工解决的进度，
 * 不能静默 abort（见 execRebase 的悬空清理）。
 * 导出供 handleRebase 在失败收尾前判断是否应保留冲突状态（ADR-0018）。
 */
export function isRebaseConflictPaused(dir: string): boolean {
	try {
		const rbMerge = resolve(
			dir,
			execSync('git rev-parse --git-path rebase-merge', {
				cwd: dir,
				encoding: 'utf-8',
			}).trim(),
		);
		if (existsSync(rbMerge)) {
			return existsSync(join(rbMerge, 'stopped-sha'));
		}
		const rbApply = resolve(
			dir,
			execSync('git rev-parse --git-path rebase-apply', {
				cwd: dir,
				encoding: 'utf-8',
			}).trim(),
		);
		return existsSync(rbApply);
	} catch {
		return false;
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
 * 遵循 Worktree-Local Rebase 约束（ADR-0018）：被 worktree checkout 的分支
 * 无法从其他目录 rebase（git 拒绝），变基必须在持有该分支的 worktree 目录内执行。
 *
 * 流程（均在 sourceDir 内执行）：
 *   0. 前置检查：目录存在、HEAD 是 sourceBranch、无未提交修改
 *   1. 清理遗留的悬空 rebase 状态（rebase 状态在 worktree 自己的 gitDir 下）
 *   2. Fetch origin 获取最新 onto 分支
 *   3. git rebase origin/<ontoBranch>（worktree 内，当前 HEAD = sourceBranch）
 *   4. 冲突 → 留在 rebase 冲突状态，不 abort；其他失败 → 报告
 */
export function execRebase(
	_repoRoot: string,
	sourceBranch: string,
	ontoBranch: string,
	sourceDir: string,
): { ok: boolean; message: string; conflicts: string[] } {
	const git = (args: string[]) =>
		spawnSync('git', args, { cwd: sourceDir, encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 });

	// 0. 前置检查：目录存在
	if (!existsSync(sourceDir)) {
		return {
			ok: false,
			message: `Worktree directory not found: ${sourceDir}`,
			conflicts: [],
		};
	}

	// 0a. rebase 状态检查（必须先于分支检查：冲突暂停时 HEAD 处于 detached，
	//     getCurrentBranch 返回 'HEAD' 而非分支名，分支检查会提前返回误导信息，
	//     使 paused 分支成为死代码，用户手工解决进度也会被后续 abort 销毁——ADR-0018）
	if (hasRebaseState(sourceDir)) {
		// 冲突中止（rebase-merge/stopped-sha 存在）说明 rebase 停在冲突待解决状态，
		// 可能已有用户手工解决的进度——不静默 abort，提示走 continue/abort
		if (isRebaseConflictPaused(sourceDir)) {
			return {
				ok: false,
				message: `Rebase in progress with conflicts in '${sourceBranch}'. Resolve conflicts and use /worktree continue, or abort with /worktree abort first.`,
				conflicts: [],
			};
		}
		const abort = git(['rebase', '--abort']);
		if (abort.status !== 0) {
			return {
				ok: false,
				message: `Dangling rebase state detected but abort failed: ${abort.stderr?.trim() || 'unknown error'}. Run 'git rebase --abort' manually first.`,
				conflicts: [],
			};
		}
	}

	// 0b. 分支匹配（rebase 状态已清理或不存在后，HEAD 应回到 sourceBranch）
	const wtBranch = getCurrentBranch(sourceDir);
	if (wtBranch !== sourceBranch) {
		return {
			ok: false,
			message: `Worktree is on '${wtBranch}', expected '${sourceBranch}'. Cannot rebase.`,
			conflicts: [],
		};
	}

	// 0c. 无未提交修改检查（rebase 状态已清理或不存在，此处纯属普通脏工作区拦截）
	try {
		const dirty = execSync('git status --porcelain', {
			cwd: sourceDir,
			encoding: 'utf-8',
		}).trim();
		if (dirty) {
			return {
				ok: false,
				message: `Worktree '${sourceBranch}' has uncommitted changes. Commit or stash them first.`,
				conflicts: [],
			};
		}
	} catch {
		/* worktree dir inaccessible, skip dirty check */
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

	// 2. rebase（worktree 内执行，无需指定 branch——HEAD 即 sourceBranch）
	const ontoRef = hasRemote ? `origin/${ontoBranch}` : ontoBranch;
	const rebase = git(['rebase', ontoRef]);

	if (rebase.status === 0) {
		return {
			ok: true,
			message: `Rebased '${sourceBranch}' onto '${ontoRef}'`,
			conflicts: [],
		};
	}

	// 3. 冲突 → 留在 rebase 冲突状态，不 abort
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
 * 定位正在进行的 merge/rebase 所在目录。
 *
 * merge/rebase 状态存在于发起目录的 gitDir 下：
 *   - main checkout → <repoRoot>/.git/...
 *   - worktree       → <repoRoot>/.git/worktrees/<name>/...
 * 遍历 main 根 + 受管 worktrees，用 `git rev-parse --git-path` 探测各目录的状态文件。
 *
 * 依据 ADR-0018（Worktree-Local Rebase）：worktree 内发起的 rebase 冲突，
 * continue/abort 必须在同一目录执行，此函数用于自动定位该目录。
 *
 * @returns 存在进行中操作的目录（main 根或 worktree 路径），无则 null
 */
export function findInProgressDir(repoRoot: string, kind: 'merge' | 'rebase'): string | null {
	// main 根 + 所有 git worktree（含非受管目录，如 pi-dynamic-workflows 的 .pi/worktrees）
	const dirs: string[] = [repoRoot];
	try {
		const out = execSync('git worktree list --porcelain', {
			cwd: repoRoot,
			encoding: 'utf-8',
		});
		for (const block of out.trim().split('\n\n')) {
			const first = block.split('\n')[0];
			if (first.startsWith('worktree ')) {
				dirs.push(first.slice('worktree '.length).trim());
			}
		}
	} catch {
		/* worktree list failed, only main root */
	}

	for (const dir of dirs) {
		try {
			if (kind === 'merge') {
				// rebase 内部用 merge 机制，冲突时也会创建 MERGE_MSG——先排除 rebase 状态
				if (hasRebaseState(dir)) continue;
				const mergePath = execSync('git rev-parse --git-path MERGE_MSG', {
					cwd: dir,
					encoding: 'utf-8',
				}).trim();
				if (existsSync(resolve(dir, mergePath))) return dir;
			} else if (hasRebaseState(dir)) {
				return dir;
			}
		} catch {
			/* 目录不可访问，跳过 */
		}
	}
	return null;
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

/**
 * 分支与 main 的 ahead/behind 数（本地对比，不依赖远端分支存在）。
 *
 * 基准固定为 `main` 分支（而非 main checkout 的 HEAD），避免 main checkout
 * 停留在其他分支时语义漂移。分支名经参数数组传递，规避 shell 注入。
 */
export function getAheadBehind(
	repoPath: string,
	branch: string,
): { ahead: number; behind: number } {
	try {
		const res = spawnSync('git', ['rev-list', '--left-right', '--count', `main...${branch}`], {
			cwd: repoPath,
			encoding: 'utf-8',
			maxBuffer: 16 * 1024 * 1024,
		});
		if (res.status !== 0) return { ahead: 0, behind: 0 };
		const parts = (res.stdout || '').trim().split('\t');
		return {
			// left = main 独有（main 领先 worktree）→ behind
			// right = branch 独有（worktree 领先 main）→ ahead
			ahead: parseInt(parts[1] || '0', 10),
			behind: parseInt(parts[0] || '0', 10),
		};
	} catch {
		return { ahead: 0, behind: 0 };
	}
}
