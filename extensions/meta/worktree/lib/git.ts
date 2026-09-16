/**
 * pi-worktree — Git 辅助函数（单 repo 版）
 */
import { execSync, spawnSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createLogger } from '@zenone/pi-logger';
import { tryResolveTargetBranch } from './target.js';

const log = createLogger('pi-worktree');

// ── 基础 git ──

export function getCurrentBranch(repoPath: string): string {
	try {
		return execSync('git rev-parse --abbrev-ref HEAD', {
			cwd: repoPath,
			encoding: 'utf-8',
		}).trim();
	} catch {
		// 不再回退到写死的分支名（ADR-0061）：返回空串，由调用方按「不匹配」处理
		return '';
	}
}

/**
 * 检出分支。
 *
 * **必须走参数数组**：目标分支名可能来自 `origin/HEAD`（由被 clone 的远端决定），
 * 而 git ref 名允许 `$()`、反引号等字符——字符串拼接形式会被 shell 解释成命令
 * （CWE-78，实测 `evil$(touch${IFS}/tmp/x)` 可落文件）。用 argv 传递则始终字面处理。
 */
export function execCheckoutBranch(
	repoPath: string,
	branch: string,
): { ok: boolean; message: string } {
	const res = spawnSync('git', ['checkout', branch], {
		cwd: repoPath,
		encoding: 'utf-8',
	});
	if (res.status !== 0) {
		return { ok: false, message: res.stderr?.trim() || `git checkout 退出码 ${res.status}` };
	}
	return { ok: true, message: '' };
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

// 注：默认分支解析已统一收敛到 `target.ts` 的解析链（ADR-0061，本地优先、禁止写死分支名）。
// 旧的 `getDefaultBranch`（远端优先、回退 main/master）在本次改造后已无调用者，故删除。

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
 * 列出所有本地分支名（refname:short）。
 * 供 merge 目标分支选择等场景使用。
 */
export function listBranches(repoPath: string): string[] {
	try {
		const res = spawnSync('git', ['branch', '--format=%(refname:short)'], {
			cwd: repoPath,
			encoding: 'utf-8',
			maxBuffer: 16 * 1024 * 1024,
		});
		if (res.status !== 0) return [];
		return (res.stdout || '').trim().split('\n').filter(Boolean);
	} catch {
		return [];
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
 *   2. 目标 ref（**本地优先**，ADR-0061）——默认 rebase 到**本地** ontoBranch；
 *      仅当 ontoBranch 显式写 `origin/<b>`（或 opts.fetch）时才 fetch 并走远端
 *   3. git rebase <ontoRef>（worktree 内，当前 HEAD = sourceBranch）
 *   4. 冲突 → 留在 rebase 冲突状态，不 abort；其他失败 → 报告
 */
export function execRebase(
	_repoRoot: string,
	sourceBranch: string,
	ontoBranch: string,
	sourceDir: string,
	opts?: { fetch?: boolean },
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

	// 1. 目标 ref（**本地优先**，ADR-0061）：默认 rebase 到**本地** ontoBranch。
	//    只有用户显式写 `origin/<b>`（或 opts.fetch 显式要求）时才碰远端。
	const wantsRemote = ontoBranch.startsWith('origin/');
	if (opts?.fetch || wantsRemote) {
		const remoteBranch = wantsRemote ? ontoBranch.slice('origin/'.length) : ontoBranch;
		const fetch = git(['fetch', 'origin', remoteBranch, '--quiet']);
		if (fetch.status !== 0) {
			return {
				ok: false,
				message: `Cannot fetch 'origin/${remoteBranch}': ${fetch.stderr?.trim() || 'unknown error'}`,
				conflicts: [],
			};
		}
	}

	// 2. rebase（worktree 内执行，无需指定 branch——HEAD 即 sourceBranch）
	const ontoRef = ontoBranch;
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
 * 分支相对**基准分支**的 ahead/behind 数（本地对比，不依赖远端分支存在）。
 *
 * 基准分支不再写死（ADR-0061）：`baseBranch` 缺省时经目标分支解析链求本地基准；
 * 解析不出来则返回 {0,0}（调用方跳过显示，不猜测）。
 * 分支名经参数数组传递，规避 shell 注入。
 */
/** 远端 fetch 超时（毫秒）。fetch 走网络，给足时间避免误杀；挂起时 kill 并静默降级。 */
export const REMOTE_FETCH_TIMEOUT_MS = 120_000;

export function getAheadBehind(
	repoPath: string,
	branch: string,
	baseBranch?: string,
): { ahead: number; behind: number } {
	const base = baseBranch ?? tryResolveTargetBranch(repoPath)?.branch;
	if (!base) return { ahead: 0, behind: 0 };
	try {
		const res = spawnSync(
			'git',
			['rev-list', '--left-right', '--count', `${base}...${branch}`],
			{
				cwd: repoPath,
				encoding: 'utf-8',
				maxBuffer: 16 * 1024 * 1024,
			},
		);
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

/**
 * 异步执行 git 命令（spawn + Promise），带超时 kill。
 * 与 handlers.ts 的 runGit 同构，但 git.ts 不能依赖 handlers.ts（避免循环依赖），
 * 故在此独立实现，用于网络类命令（fetch）避免同步 spawnSync 阻塞 TUI 事件循环。
 */
function runGitAsync(
	cwd: string,
	args: string[],
	timeoutMs: number,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn('git', args, { cwd });
		let stdout = '';
		let stderr = '';
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill('SIGKILL');
		}, timeoutMs);
		child.stdout?.on('data', (d: Buffer) => {
			stdout += d.toString('utf-8');
		});
		child.stderr?.on('data', (d: Buffer) => {
			stderr += d.toString('utf-8');
		});
		child.on('error', (err) => {
			clearTimeout(timer);
			resolve({ status: null, stdout, stderr: stderr || err.message });
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			resolve({ status: timedOut ? null : code, stdout, stderr });
		});
	});
}

/**
 * 只读远端同步差距诊断：本地分支与远端对应分支的 ahead/behind。
 * 无 remote、远端分支不存在、网络失败时返回 null（静默，绝不报错）。
 * 供 merge 前/后提示「本地落后远端 N 提交」使用（本地优先原则：只诊断、不自动同步）。
 *
 * ahead = 本地领先远端（有未 push 提交）；behind = 本地落后远端（远端有新提交）。
 * **默认不 fetch**（ADR-0061 本地优先）：只读已有的 remote-tracking ref，可能略陈旧
 * 但绝不联网；仅当显式 `opts.fetch` 时才更新远端引用。
 *
 * fetch（仅显式）用异步 spawn（带超时 kill），不阻塞 TUI 事件循环；挂起（网络黑洞/VPN 断连）
 * 时超时 kill 后 status=null → 静默 null，绝不冻结 merge 确认 UI。
 */
export async function getRemoteAheadBehind(
	repoPath: string,
	branch: string,
	opts?: { fetch?: boolean; timeoutMs?: number },
): Promise<{ ahead: number; behind: number } | null> {
	try {
		// 1. 是否有 remote origin（本地，快）
		const remote = spawnSync('git', ['remote', 'get-url', 'origin'], {
			cwd: repoPath,
			encoding: 'utf-8',
		});
		if (remote.status !== 0) return null;

		// 2. 仅在显式要求时 fetch（默认只读本地已有的 remote-tracking ref）
		if (opts?.fetch) {
			const fetch = await runGitAsync(
				repoPath,
				['fetch', 'origin', branch, '--quiet'],
				opts.timeoutMs ?? REMOTE_FETCH_TIMEOUT_MS,
			);
			if (fetch.status !== 0) return null;
		}

		// 3. 本地 vs 远端差距（本地，快）
		const count = spawnSync(
			'git',
			['rev-list', '--left-right', '--count', `${branch}...origin/${branch}`],
			{
				cwd: repoPath,
				encoding: 'utf-8',
				maxBuffer: 16 * 1024 * 1024,
			},
		);
		if (count.status !== 0) return null;
		const parts = (count.stdout || '').trim().split(/\s+/);
		return {
			// left = 本地独有 → ahead；right = 远端独有 → behind
			ahead: parseInt(parts[0] || '0', 10),
			behind: parseInt(parts[1] || '0', 10),
		};
	} catch {
		return null;
	}
}
