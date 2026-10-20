/**
 * pi-worktree — 目标分支解析与主检出标识（ADR-0061）
 *
 * 两条硬约束：
 *   1. **本地优先**：目标分支一律解析为**本地 ref**。远端只作只读提示，绝不隐式
 *      `fetch`；只有用户显式写 `origin/<b>` 时才使用远端 ref。
 *   2. **禁止写死分支名**：历史上 `'main'` 同时被当作「主检出标识」与「默认目标
 *      分支」，在「默认分支 = main、集成分支 = dev」的仓库里两种语义互相遮蔽，
 *      导致合并缺省落点错到 main。标识与分支名从此分离（见 MAIN_CHECKOUT_NAME）。
 */
import { execSync, spawnSync } from 'node:child_process';

/**
 * 「主检出」（main checkout）的**标识名**——仅用于身份判定（节点类型 / 名称比较），
 * **任何情况下都不得拿它当分支名使用**。分支名一律经 resolveTargetBranch 解析。
 */
export const MAIN_CHECKOUT_NAME = 'main';

export type TargetSource = 'explicit' | 'baseRef' | 'repo-default' | 'head';

export interface ResolvedTarget {
	/** 分支名。本地解析时为裸分支名；仅显式写 `origin/<b>` 时才带前缀。 */
	branch: string;
	/** 该分支名是怎么来的（供结果/日志显示落点） */
	source: TargetSource;
	/** false = 解析到了远端 ref（用户显式指定） */
	isLocal: boolean;
}

export interface ResolveTargetOptions {
	/** 命令行显式指定（`--target` / `--from` / `--onto`） */
	explicit?: string;
	/** 组声明里的 baseRef */
	baseRef?: string;
}

export class TargetResolutionError extends Error {}

const SOURCE_LABELS: Record<TargetSource, string> = {
	explicit: '显式指定',
	baseRef: '组声明',
	'repo-default': '仓库默认分支（本地）',
	head: '当前 HEAD 分支',
};

/** 供结果与日志展示：`dev（组声明 · 本地）` 这种一眼能看出落点与来源的写法。 */
export function describeTarget(t: ResolvedTarget): string {
	return `${t.branch}（${SOURCE_LABELS[t.source]}${t.isLocal ? ' · 本地' : ' · 远端 ref'}）`;
}

function git(repoRoot: string, args: string[]): { status: number | null; stdout: string } {
	const res = spawnSync('git', args, {
		cwd: repoRoot,
		encoding: 'utf-8',
		maxBuffer: 16 * 1024 * 1024,
	});
	return { status: res.status, stdout: res.stdout || '' };
}

/** 本地分支是否存在 */
export function hasLocalBranch(repoRoot: string, branch: string): boolean {
	return git(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0;
}

/** 远端跟踪分支是否存在 */
export function hasRemoteBranch(repoRoot: string, ref: string): boolean {
	return git(repoRoot, ['show-ref', '--verify', '--quiet', `refs/remotes/${ref}`]).status === 0;
}

/**
 * 仓库**默认分支名**的唯一来源：`refs/remotes/origin/HEAD`（本地引用，**不联网**）。
 * 读不到（无远端 / 未设置）返回 null，交给调用方下一步（当前 HEAD → 显式报错）。
 *
 * **不按名称猜 main/master**：ADR-0061 决议 2 禁止写死分支名、决议 3 要求宁可报错也不猜错落点。
 * 无 origin/HEAD 时按名称猜 main，会把 dev 上的特性合进 main——正是该 ADR 要消除的事故。
 */
export function getDefaultBranchName(repoRoot: string): string | null {
	try {
		const ref = execSync('git symbolic-ref --quiet refs/remotes/origin/HEAD', {
			cwd: repoRoot,
			encoding: 'utf-8',
		}).trim();
		const name = ref.replace(/^refs\/remotes\/origin\//, '');
		if (name) return name;
	} catch {
		/* 无 origin/HEAD → 落到下一步（HEAD / 报错），不猜分支名 */
	}
	return null;
}

function requireRef(repoRoot: string, branch: string, source: TargetSource): ResolvedTarget {
	if (branch.startsWith('origin/')) {
		if (!hasRemoteBranch(repoRoot, branch)) {
			throw new TargetResolutionError(
				`远端分支 '${branch}' 不存在（未 fetch 过？）。先手动 fetch，或改用本地分支名。`,
			);
		}
		return { branch, source, isLocal: false };
	}
	if (!hasLocalBranch(repoRoot, branch)) {
		throw new TargetResolutionError(
			`本地分支 '${branch}' 不存在。可用分支：${listLocalBranches(repoRoot).join(', ') || '(无)'}`,
		);
	}
	return { branch, source, isLocal: true };
}

export function listLocalBranches(repoRoot: string): string[] {
	const res = git(repoRoot, ['branch', '--format=%(refname:short)']);
	if (res.status !== 0) return [];
	return res.stdout.trim().split('\n').filter(Boolean);
}

/** 当前 HEAD 所在分支名；detached 时返回 null */
export function getHeadBranchName(repoRoot: string): string | null {
	const res = git(repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
	const name = res.stdout.trim();
	return res.status === 0 && name ? name : null;
}

/**
 * 目标分支解析链（自上而下，全部落到**本地 ref**）：
 *   1. 显式 `--target` / `--from` / `--onto`（显式写 `origin/<b>` 才走远端）
 *   2. 组声明的 `baseRef`
 *   3. 仓库默认分支名（`origin/HEAD` 只读本地引用）→ 取其**本地同名分支**
 *   4. 当前 `HEAD` 所在分支
 *   5. 全部失败 → 报错要求显式指定（**不猜**）
 */
export function resolveTargetBranch(
	repoRoot: string,
	opts: ResolveTargetOptions = {},
): ResolvedTarget {
	if (opts.explicit) return requireRef(repoRoot, opts.explicit, 'explicit');
	if (opts.baseRef) return requireRef(repoRoot, opts.baseRef, 'baseRef');

	const def = getDefaultBranchName(repoRoot);
	if (def && hasLocalBranch(repoRoot, def)) {
		return { branch: def, source: 'repo-default', isLocal: true };
	}

	const head = getHeadBranchName(repoRoot);
	if (head) return { branch: head, source: 'head', isLocal: true };

	throw new TargetResolutionError(
		'无法解析目标分支（无显式指定、无组声明、无仓库默认分支、HEAD 未指向分支）。请用 --target <branch> 显式指定。',
	);
}

/**
 * 解析「用于比较的」本地基准分支（ui 列表里显示相对谁是 ahead/behind）。
 * 解析失败时返回 null（调用方跳过显示），绝不猜测。
 */
export function tryResolveTargetBranch(
	repoRoot: string,
	opts: ResolveTargetOptions = {},
): ResolvedTarget | null {
	try {
		return resolveTargetBranch(repoRoot, opts);
	} catch {
		return null;
	}
}
