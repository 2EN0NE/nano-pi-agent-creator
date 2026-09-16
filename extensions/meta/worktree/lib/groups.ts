/**
 * pi-worktree — Worktree 组声明（ADR-0062）
 *
 * 「组」= 一份**显式声明的固定花名册**：组名 + 目标分支 baseRef + 成员列表 + 合并策略 + env 策略。
 *
 * 三条硬约束：
 *   1. **只在仓库级生效**：组内每一项都是仓库事实（成员名、baseRef、symlinkTargetIds 绑目录结构），
 *      脱离仓库没有意义。用户级出现 `groups` → **warn + 忽略**，绝不静默生效。
 *   2. **仓库级锚在主仓库根**（ADR-0061）：`.pi/` 被 gitignore 且每个 worktree 各有独立 `.pi/`，
 *      锚在会话 cwd 会让组在成员 worktree 里不可见。
 *   3. **分节读改写**：`save()` 是整体写入该级文件，若直接写合并结果，会把仓库级组泄漏进用户级
 *      （反之亦然）。故写盘前先读目标文件、只替换自己那一节。
 */
import { resolveConfigPaths, readJsonFile, writeJsonAtomic } from '@zenone/pi-config';
import { createLogger } from '@zenone/pi-logger';
import type { MergeStrategy, NodeModulesStrategy } from '../types.js';
import { getDirtyCount } from './git.js';
import { getManagedWorktrees } from './paths.js';
import { resolveTargetBranch, type ResolvedTarget } from './target.js';
import { spawnSync } from 'node:child_process';

const log = createLogger('pi-worktree');

const PLUGIN = 'pi-worktree';
const DEFAULT_SYMLINK_TARGET_IDS = ['husky', 'pi', 'node_modules'];

// ── 声明类型 ──

export interface GroupEnv {
	/** 依赖复用方式；缺省 `copy`（cp -al 硬链接：省盘 + 本地包解析到本 worktree） */
	nodeModules?: NodeModulesStrategy;
	/** 软链策略下要软链的目标 id（沿用既有 SymlinkSelections 语义） */
	symlinkTargetIds?: string[];
}

export interface WorktreeGroup {
	/** 组目标分支（本地 ref；缺省走目标分支解析链） */
	baseRef?: string;
	/** 成员名；**数组顺序 = 组批量合并顺序** */
	members: string[];
	/** 合并策略；缺省 `squash`（对齐「1 特性 = 1 提交」） */
	mergeStrategy?: MergeStrategy;
	env?: GroupEnv;
}

export type GroupMap = Record<string, WorktreeGroup>;

export interface LoadedGroups {
	groups: GroupMap;
	/** 被忽略/被修正的声明（供 UI 与日志展示，绝不静默） */
	warnings: string[];
}

// ── 策略说明（UI 必须展示优劣；ADR-0062 决策 10） ──

export interface StrategyNote {
	label: string;
	space: string;
	pros: string[];
	cons: string[];
}

export const ENV_STRATEGY_NOTES: Record<NodeModulesStrategy, StrategyNote> = {
	copy: {
		label: '硬链接拷贝（cp -al）',
		space: '几乎不额外占盘：与主仓库共享 inode（实测 453MB 目录 ≈ 0 额外空间）',
		pros: [
			'本地包（package.json 里 file: 依赖，如本项目 @zenone/*）解析到**本 worktree 源码**',
			'秒级完成，不需要网络',
		],
		cons: [
			'就地修改 node_modules 内文件会同时改到主仓库（编辑器 write+rename 不受影响）',
			'成员内跑 npm install 会替换文件、断开硬链接（此后该成员独立占盘）',
		],
	},
	symlink: {
		label: '整目录软链（node_modules → 主仓库）',
		space: '零额外占盘',
		pros: ['创建最快，主仓库装一次所有成员可用'],
		cons: [
			'本地包（file: 依赖）会解析到**主仓库源码**——在 worktree 里改本仓库自身的包，测试与 pi 跑的都是主仓库版本（静默测错代码）',
			'成员内 npm install 会写穿到主仓库',
		],
	},
	install: {
		label: '独立 npm install',
		space: '每个成员各占一份（数百 MB）',
		pros: ['完全隔离，行为最接近独立克隆'],
		cons: ['每个成员都要耗时安装且需要网络'],
	},
	none: {
		label: '不做处理',
		space: '零',
		pros: ['不碰依赖，创建最快'],
		cons: ['成员里跑不了 npm test / tsc / prettier 等需要依赖的命令'],
	},
};

export const MERGE_STRATEGY_NOTES: Record<MergeStrategy, StrategyNote> = {
	squash: {
		label: 'squash（推荐）',
		space: '—',
		pros: [
			'N 个成员 = 目标分支 N 个提交，对齐「1 特性 = 1 提交」',
			'成员内部提交历史不进目标分支',
		],
		cons: ['冲突只能靠「先变基再合入」处理（squash 冲突无法 continue/abort）'],
	},
	merge: {
		label: 'merge（保留分支历史）',
		space: '—',
		pros: ['保留成员分支的完整提交图与合并点'],
		cons: ['目标分支历史变复杂；与「1 特性 = 1 提交」不一致'],
	},
	'rebase-ff': {
		label: 'rebase-ff（快进）',
		space: '—',
		pros: ['目标分支线性、无合并提交'],
		cons: ['要求成员已变基且可快进，否则失败；重写目标分支历史风险高'],
	},
};

// ── 默认值与校验 ──

// ── 告警去重 ──

const emittedGroupWarnings = new Set<string>();

/**
 * 过滤出「本进程内尚未提示过」的告警。
 *
 * 用户级 `groups` 被忽略这类问题在**每次打开面板/执行命令**时都会被重新发现，
 * 逐次弹通知只是噪音。只影响**通知**路径：`formatGroupView`（显式的
 * `/worktree group list` 视图）仍然完整展示所有告警。
 */
export function takeNewGroupWarnings(warnings: string[]): string[] {
	return warnings.filter((w) => {
		if (emittedGroupWarnings.has(w)) return false;
		emittedGroupWarnings.add(w);
		return true;
	});
}

/** 仅测试用：重置去重状态 */
export function resetGroupWarningDedup(): void {
	emittedGroupWarnings.clear();
}

export function applyGroupDefaults(g: WorktreeGroup): Required<Pick<WorktreeGroup, 'members'>> & {
	baseRef?: string;
	mergeStrategy: MergeStrategy;
	env: { nodeModules: NodeModulesStrategy; symlinkTargetIds: string[] };
} {
	return {
		baseRef: g.baseRef,
		members: g.members,
		mergeStrategy: g.mergeStrategy ?? 'squash',
		env: {
			nodeModules: g.env?.nodeModules ?? 'copy',
			symlinkTargetIds: g.env?.symlinkTargetIds ?? [...DEFAULT_SYMLINK_TARGET_IDS],
		},
	};
}

const VALID_ENV: NodeModulesStrategy[] = ['symlink', 'copy', 'install', 'none'];
const VALID_MERGE: MergeStrategy[] = ['squash', 'merge', 'rebase-ff'];

function parseGroup(name: string, raw: unknown, warnings: string[]): WorktreeGroup | null {
	if (!raw || typeof raw !== 'object') {
		warnings.push(`组 '${name}' 声明不是对象，已忽略`);
		return null;
	}
	const o = raw as Record<string, unknown>;
	const members = Array.isArray(o.members)
		? o.members.filter((m) => typeof m === 'string')
		: null;
	if (!members || members.length === 0) {
		warnings.push(`组 '${name}' 缺少有效的 members 数组，已忽略`);
		return null;
	}
	if (typeof o.baseRef === 'string' && o.baseRef.startsWith('origin/')) {
		warnings.push(`组 '${name}' 的 baseRef 指向远端 ref '${o.baseRef}'（默认应为本地分支）`);
	}
	const mergeStrategy =
		typeof o.mergeStrategy === 'string' &&
		VALID_MERGE.includes(o.mergeStrategy as MergeStrategy)
			? (o.mergeStrategy as MergeStrategy)
			: undefined;
	if (o.mergeStrategy !== undefined && mergeStrategy === undefined) {
		warnings.push(
			`组 '${name}' 的 mergeStrategy '${String(o.mergeStrategy)}' 无效，回退 squash`,
		);
	}
	const envRaw = (o.env ?? {}) as Record<string, unknown>;
	let nodeModules: NodeModulesStrategy | undefined;
	if (typeof envRaw.nodeModules === 'string') {
		if (VALID_ENV.includes(envRaw.nodeModules as NodeModulesStrategy)) {
			nodeModules = envRaw.nodeModules as NodeModulesStrategy;
		} else {
			warnings.push(
				`组 '${name}' 的 env.nodeModules '${envRaw.nodeModules}' 无效，回退 copy`,
			);
		}
	}
	const symlinkTargetIds = Array.isArray(envRaw.symlinkTargetIds)
		? envRaw.symlinkTargetIds.filter((x): x is string => typeof x === 'string')
		: undefined;

	return {
		baseRef: typeof o.baseRef === 'string' ? o.baseRef : undefined,
		members,
		mergeStrategy,
		env:
			nodeModules !== undefined || symlinkTargetIds !== undefined
				? { nodeModules, symlinkTargetIds }
				: undefined,
	};
}

// ── 读写 ──

function paths(repoRoot: string) {
	return resolveConfigPaths(PLUGIN, { cwd: repoRoot });
}

/**
 * 读取组声明。
 *
 * 用户级 `groups` **一律忽略并 warn**（ADR-0062 决策 2）；仓库级才是有效来源。
 */
export function loadGroups(repoRoot: string): LoadedGroups {
	const warnings: string[] = [];
	const { userFile, projectFile } = paths(repoRoot);

	const userRaw = readJsonFile(userFile) as Record<string, unknown> | null;
	if (userRaw && userRaw.groups && typeof userRaw.groups === 'object') {
		const count = Object.keys(userRaw.groups as Record<string, unknown>).length;
		if (count > 0) {
			warnings.push(
				`用户级配置里声明了 ${count} 个组，已忽略（组只在仓库级生效：成员名/目标分支/软链目标都是本仓库事实，跨仓库无意义）`,
			);
			log.warn('ignored user-level groups declaration', { file: userFile, count });
		}
	}

	const projRaw = readJsonFile(projectFile) as Record<string, unknown> | null;
	const groups: GroupMap = {};
	const rawGroups = projRaw?.groups;
	if (rawGroups && typeof rawGroups === 'object') {
		for (const [name, raw] of Object.entries(rawGroups as Record<string, unknown>)) {
			const parsed = parseGroup(name, raw, warnings);
			if (parsed) groups[name] = parsed;
		}
	}
	return { groups, warnings };
}

export function listGroupNames(repoRoot: string): string[] {
	return Object.keys(loadGroups(repoRoot).groups).sort();
}

export function getGroup(repoRoot: string, name: string): WorktreeGroup | null {
	return loadGroups(repoRoot).groups[name] ?? null;
}

/**
 * 写入 / 更新一个组（**分节读改写**）：只替换 `groups` 节，保留文件里其他节（如偏好），
 * 也绝不动用户级文件——避免把仓库级组泄漏到用户级。
 */
export function saveGroup(repoRoot: string, name: string, group: WorktreeGroup): void {
	const { projectFile } = paths(repoRoot);
	const existing = (readJsonFile(projectFile) as Record<string, unknown> | null) ?? {};
	const groups = { ...((existing.groups as Record<string, unknown>) ?? {}) };
	groups[name] = group;
	writeJsonAtomic(projectFile, { ...existing, groups });
	log.info('saved worktree group', { name, file: projectFile, members: group.members.length });
}

export function deleteGroup(repoRoot: string, name: string): boolean {
	const { projectFile } = paths(repoRoot);
	const existing = readJsonFile(projectFile) as Record<string, unknown> | null;
	if (!existing) return false;
	const groups = { ...((existing.groups as Record<string, unknown>) ?? {}) };
	if (!(name in groups)) return false;
	delete groups[name];
	writeJsonAtomic(projectFile, { ...existing, groups });
	log.info('deleted worktree group', { name, file: projectFile });
	return true;
}

/** 组的有效目标分支（baseRef → 解析链） */
export function resolveGroupBase(repoRoot: string, group: WorktreeGroup): ResolvedTarget {
	return resolveTargetBranch(repoRoot, { baseRef: group.baseRef });
}

// ── 候选集合 ──

export type CandidateAction = 'create' | 'merge' | 'sync';

export type CandidateStatus = 'ready' | 'dirty' | 'no-commits' | 'missing';

export interface GroupCandidate {
	name: string;
	branch: string;
	path: string | null;
	exists: boolean;
	/** 相对目标分支领先的提交数 */
	ahead: number;
	dirty: number;
	status: CandidateStatus;
	/** 锁定 = 不可选中（UI 灰显 + 执行层硬拒绝） */
	locked: boolean;
	reason: string;
}

export interface GroupCandidates {
	group: string;
	base: ResolvedTarget;
	items: GroupCandidate[];
	/** 默认全选 = 全部未锁定项 */
	selectable: string[];
}

function aheadCount(repoRoot: string, base: string, branch: string): number {
	const res = spawnSync('git', ['rev-list', '--count', `${base}..${branch}`], {
		cwd: repoRoot,
		encoding: 'utf-8',
	});
	if (res.status !== 0) return 0;
	return parseInt((res.stdout || '0').trim() || '0', 10);
}

function branchExists(repoRoot: string, branch: string): boolean {
	return (
		spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
			cwd: repoRoot,
			encoding: 'utf-8',
		}).status === 0
	);
}

/**
 * 计算某动作的候选集合。
 *
 * 「候选 = 本次动作真正作用到的对象集合」，**不适用的成员保留在列表里作为上下文**
 * （灰显 + 原因），绝不静默过滤（ADR-0062 决策 7）：
 *   - create：尚无 worktree 的成员可选；已存在的灰显 `exists`
 *   - merge ：存在分支中「有提交且干净」者可选；脏 / 无提交者灰显并说明原因
 *   - sync  ：当前存在的成员可选；脏成员灰显（对齐需要干净工作区）
 */
export function computeCandidates(
	repoRoot: string,
	groupName: string,
	group: WorktreeGroup,
	action: CandidateAction,
): GroupCandidates {
	const base = resolveGroupBase(repoRoot, group);
	const managed = new Map(getManagedWorktrees(repoRoot).map((w) => [w.name, w]));
	const items: GroupCandidate[] = [];

	for (const name of group.members) {
		const branch = `wt/${name}`;
		const wt = managed.get(name);
		const exists = !!wt;
		const path = wt?.path ?? null;
		const hasBranch = exists || branchExists(repoRoot, branch);
		const ahead = hasBranch ? aheadCount(repoRoot, base.branch, branch) : 0;
		const dirty = exists && path ? getDirtyCount(path) : 0;

		let status: CandidateStatus;
		let locked = false;
		let reason = '';

		if (action === 'create') {
			if (exists) {
				status = 'ready';
				locked = true;
				reason = '已存在（创建只补建缺失成员）';
			} else {
				status = 'ready';
				reason = hasBranch ? '分支已存在 → 复用该分支' : `将从 ${base.branch} 派生`;
			}
		} else if (!exists) {
			status = 'missing';
			locked = true;
			reason = 'worktree 不存在（先用「组创建」补建）';
		} else if (dirty > 0) {
			status = 'dirty';
			locked = true;
			reason = `有 ${dirty} 处未提交改动，先提交或 stash`;
		} else if (action === 'merge' && ahead === 0) {
			status = 'no-commits';
			locked = true;
			reason = `相对 ${base.branch} 无提交，没有可合入的内容`;
		} else {
			status = 'ready';
			reason = action === 'merge' ? `${ahead} 个提交待合入` : '将对齐到目标分支';
		}

		items.push({ name, branch, path, exists, ahead, dirty, status, locked, reason });
	}

	return {
		group: groupName,
		base,
		items,
		selectable: items.filter((i) => !i.locked).map((i) => i.name),
	};
}
