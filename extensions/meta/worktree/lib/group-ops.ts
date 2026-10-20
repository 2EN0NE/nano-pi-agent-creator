/**
 * pi-worktree — 组批量动作的执行层与命令入口（ADR-0062）
 *
 * 三个动作（**互相独立，创建不隐含同步**）：
 *   - 组创建：只补建尚无 worktree 的成员，从组目标分支（本地 ref）派生，env 策略一次应用全批
 *   - 组合并：按花名册顺序逐成员「rebase 到目标分支 → squash 合入 → 提交」，fail-fast + 可续跑
 *   - 组同步：把成员对齐到目标分支（非破坏性，不丢未合入提交）
 *
 * 收尾对齐（两阶段，ADR-0062 决策 9）：
 *   ① 逐成员即时对齐——合入成功后立即 reset --hard 到**当时**的目标分支（防止下轮 rebase
 *      重放已 squash 的内容而出现「假冲突」）；当前会话 cwd 所在成员跳过
 *   ② 整批完成后由上层**再问一次**是否统一对齐到最终目标分支（各成员基线版本不同）
 *
 * 本文件与 handlers.ts 互相引用：handlers 的 `group` 分支用**动态 import** 调用这里，
 * 避免静态循环依赖。
 */
import { spawnSync } from 'node:child_process';
import { createLogger } from '@zenone/pi-logger';
import type { MergeStrategy, SymlinkSelections } from '../types.js';
import { PRESET_SYMLINK_TARGETS } from '../types.js';
import { execRebase, getDirtyCount } from './git.js';
import { getManagedWorktrees, realpathOf, resolveWorktreePath } from './paths.js';
import { createWorktree } from './worktree.js';
import {
	applyGroupDefaults,
	computeCandidates,
	deleteGroup,
	listGroupNames,
	loadGroups,
	resolveGroupBase,
	saveGroup,
	takeNewGroupWarnings,
	type CandidateAction,
	type GroupCandidates,
	type GroupMap,
	type WorktreeGroup,
} from './groups.js';
import { execMerge } from './handlers.js';
import {
	runGroupWizard,
	showGroupCandidatePanel,
	showGroupMenu,
	showUnifiedAlignPanel,
	type GroupMenuAction,
} from './group-ui.js';

const log = createLogger('pi-worktree');

// ── 结果类型 ──

export interface GroupStep {
	name: string;
	ok: boolean;
	/** 该步骤做了什么（成功时）/ 卡在哪（失败时） */
	message: string;
	/** 对齐前的旧 tip（可回溯找回被 reset 掉的提交） */
	oldTip?: string;
	/** 未执行任何改动（如「相对目标分支已无领先提交」）——不计入已合入成员 */
	skipped?: boolean;
}

export interface GroupOpResult {
	ok: boolean;
	message: string;
	steps: GroupStep[];
	/** 失败停在哪位成员（可续跑：从该成员起重跑即可） */
	resumeFrom?: string;
}

// ── 路径同一性 ──

/**
 * 判断两个路径是否指同一目录：**必须 realpath 归一化**（macOS `/tmp` ↔ `/private/tmp`、
 * 符号链接仓库根等场景下逻辑路径与真实路径不一致，见 paths.realpathOf 的约定）。
 * 未传 `b` 时恒为 false。
 */
function isSamePath(a: string, b?: string): boolean {
	return !!b && realpathOf(a) === realpathOf(b);
}

/**
 * 日志单行化：失败原因可能带多行 git 输出，直接拼进 message 会把一条日志拆成多行，
 * 破坏「一行一条 STEP_* 可 grep」的约定（ADR-0062 过程日志要求）。
 */
function oneLine(s: unknown): string {
	return String(s).replace(/\s+/g, ' ').trim();
}

// ── 守卫 ──

export interface GuardResult {
	ok: boolean;
	message: string;
}

/**
 * 合并前守卫（ADR-0062 决策 8）：
 *   - 目标检出**不能处于 merge 进行中**（存在 `MERGE_HEAD` 即拒绝）。
 *   - 目标检出的**脏改动不作为拒绝理由**：`execMerge` 内部会 `stash push` → 合并 →
 *     `stash pop`，实测已暂存改动不会被卷进 squash 提交（回归保护见
 *     `worktree-group-ops.test.ts` 的「已暂存改动不被卷入 squash 提交」用例），
 *     硬拒绝反而会拦住「主检出里有在途改动」这一正常状态。
 *   - 未暂存且与被合入路径重叠的文件由 git 自身拒绝（不重叠的无害）。
 */
export function checkTargetGuard(repoRoot: string, baseBranch: string): GuardResult {
	const inProgress = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], {
		cwd: repoRoot,
		encoding: 'utf-8',
	});
	if (inProgress.status === 0) {
		return { ok: false, message: `目标分支 ${baseBranch} 正处于 merge 进行中，请先处理完。` };
	}
	return { ok: true, message: '' };
}

/** 成员工作区是否干净（脏成员在执行层硬拒绝，面板不是唯一入口） */
export function memberIsClean(repoRoot: string, name: string): { clean: boolean; dirty: number } {
	const path = resolveWorktreePath(repoRoot, name);
	const dirty = getDirtyCount(path);
	return { clean: dirty === 0, dirty };
}

/** 分支相对基准领先的提交数（分支不存在/git 失败 → 0） */
function commitsAhead(repoRoot: string, base: string, branch: string): number {
	const res = spawnSync('git', ['rev-list', '--count', `${base}..${branch}`], {
		cwd: repoRoot,
		encoding: 'utf-8',
	});
	if (res.status !== 0) return 0;
	return parseInt((res.stdout || '0').trim() || '0', 10);
}

// ── 收尾对齐 ──

/**
 * 把成员分支对齐到目标分支（**破坏性**：丢弃该成员上领先目标分支的提交）。
 *
 * 只允许用于**本轮已合入**的成员——提交已经在目标分支上，reset 不丢东西；旧 tip 记入结果。
 * 未合入的成员绝不可调用（会丢工作内容，见 ADR-0062 决策 9）。
 */
export function alignMember(
	repoRoot: string,
	name: string,
	baseBranch: string,
): { ok: boolean; oldTip: string; message: string } {
	const branch = `wt/${name}`;
	const oldTip = spawnSync('git', ['rev-parse', branch], {
		cwd: repoRoot,
		encoding: 'utf-8',
	}).stdout.trim();

	const managed = getManagedWorktrees(repoRoot).find((w) => w.name === name);
	if (managed?.path) {
		// 分支被该 worktree checkout，必须在它自己的目录内 reset
		const res = spawnSync('git', ['reset', '--hard', baseBranch], {
			cwd: managed.path,
			encoding: 'utf-8',
		});
		if (res.status !== 0) {
			return {
				ok: false,
				oldTip,
				message: `reset --hard ${baseBranch} 失败：${(res.stderr || '').trim()}`,
			};
		}
	} else {
		// 分支存在但没有 worktree：直接移动分支指针
		const res = spawnSync('git', ['branch', '-f', branch, baseBranch], {
			cwd: repoRoot,
			encoding: 'utf-8',
		});
		if (res.status !== 0) {
			return {
				ok: false,
				oldTip,
				message: `branch -f ${branch} ${baseBranch} 失败：${(res.stderr || '').trim()}`,
			};
		}
	}
	log.info('aligned member to base', { name, baseBranch, oldTip });
	return {
		ok: true,
		oldTip,
		message: `已对齐到 ${baseBranch}（旧 tip ${oldTip.slice(0, 8)} 可经 reflog 找回）`,
	};
}

// ── 组创建 ──

function selectionsFor(group: WorktreeGroup): SymlinkSelections {
	const env = applyGroupDefaults(group).env;
	const targets = PRESET_SYMLINK_TARGETS.filter((t) => env.symlinkTargetIds.includes(t.id));
	return { targets, customPaths: [], nodeModulesStrategy: env.nodeModules };
}

/**
 * 组创建：只补建尚无 worktree 的成员；已存在者**一律不动**。
 * `wt/<name>` 分支已存在但 worktree 不在 → 复用该分支（由 createWorktree 内部处理）。
 */
export function execGroupCreate(
	repoRoot: string,
	groupName: string,
	group: WorktreeGroup,
	members: string[],
): GroupOpResult {
	const env = applyGroupDefaults(group).env;
	const selections = selectionsFor(group);
	const steps: GroupStep[] = [];

	for (const name of members) {
		const t0 = Date.now();
		log.info(`STEP_BEGIN group=${groupName} action=create member=${name}`);
		const existing = getManagedWorktrees(repoRoot).some((w) => w.name === name);
		if (existing) {
			steps.push({ name, ok: true, message: '已存在，跳过（组创建只补建缺失成员）' });
			log.info(
				`STEP_OK group=${groupName} action=create member=${name} ms=${Date.now() - t0} note=exists`,
			);
			continue;
		}
		const res = createWorktree(repoRoot, name, env.nodeModules, selections, {
			baseRef: group.baseRef,
		});
		steps.push({ name, ok: res.ok, message: res.message });
		if (!res.ok) {
			log.error(
				`FAIL_MARKER group=${groupName} action=create member=${name} ms=${Date.now() - t0} reason=${oneLine(res.message)}`,
			);
			return {
				ok: false,
				message: `组 '${groupName}' 创建在成员 '${name}' 处失败，已停止`,
				steps,
				resumeFrom: name,
			};
		}
		log.info(
			`STEP_OK group=${groupName} action=create member=${name} ms=${Date.now() - t0} note=created`,
		);
	}

	return {
		ok: true,
		message: `组 '${groupName}' 创建完成：${steps.length} 个成员（env=${env.nodeModules}）`,
		steps,
	};
}

// ── 组合并 ──

/**
 * 组合并：按给定顺序逐成员「rebase 到目标分支 → 合入 → 提交 → 即时对齐」。
 *
 * **fail-fast**：任一步失败即停止，已完成的成员保留在目标分支上；失败成员停在
 * rebase 冲突态，解决后从该成员起重跑即可续完剩余（**绝不跳过失败成员继续**——
 * 那会合入引用不存在代码的提交且 git 不报错）。
 *
 * **幂等**：相对目标分支已无领先提交的成员直接跳过（`skipped`），因此「解冲突后重跑
 * 同一命令」无论传全量花名册还是仅剩余成员都能续完——见 `commitsAhead` 处的说明。
 */
export async function execGroupMerge(
	repoRoot: string,
	groupName: string,
	group: WorktreeGroup,
	members: string[],
	opts: { currentCwd?: string } = {},
): Promise<GroupOpResult> {
	const base = resolveGroupBase(repoRoot, group);
	const strategy: MergeStrategy = applyGroupDefaults(group).mergeStrategy;

	const guard = checkTargetGuard(repoRoot, base.branch);
	if (!guard.ok) return { ok: false, message: guard.message, steps: [] };

	const steps: GroupStep[] = [];

	for (const name of members) {
		const t0 = Date.now();
		log.info(`STEP_BEGIN group=${groupName} action=merge member=${name} base=${base.branch}`);
		const branch = `wt/${name}`;
		const wtPath = resolveWorktreePath(repoRoot, name);
		// 成员**变基前**的原始 tip：即时对齐会丢弃它，记录下来才能真正回溯找回
		const originalTip = spawnSync('git', ['rev-parse', branch], {
			cwd: repoRoot,
			encoding: 'utf-8',
		}).stdout.trim();

		// 执行层守卫：脏成员绝不参与（面板不是唯一入口）——**必须排在幂等跳过之前**：
		// 「有未提交改动但尚无提交」的成员若被跳过，等于放过了脏成员（ADR-0062 决策 8）。
		const clean = memberIsClean(repoRoot, name);
		if (!clean.clean) {
			const msg = `成员 '${name}' 有 ${clean.dirty} 处未提交改动，已停止（先提交或 stash）`;
			steps.push({ name, ok: false, message: msg });
			log.error(
				`FAIL_MARKER group=${groupName} action=merge member=${name} ms=${Date.now() - t0} reason=${oneLine(msg)}`,
			);
			return { ok: false, message: msg, steps, resumeFrom: name };
		}

		// 幂等（ADR-0062「fail-fast + 可续跑」）：相对目标分支已无领先提交的成员没有
		// 可合入内容，**跳过**而不是执行。否则 `merge --squash` 无变更 → `git commit` 报
		// 「nothing to commit」→ 假失败：解冲突后按报错提示「重跑本命令」会在第一个
		// 已合入成员处卡住，剩余成员永远合不完。
		if (commitsAhead(repoRoot, base.branch, branch) === 0) {
			steps.push({
				name,
				ok: true,
				skipped: true,
				message: `相对 ${base.branch} 无领先提交（已合入或未开始），跳过`,
			});
			log.info(
				`STEP_OK group=${groupName} action=merge member=${name} ms=${Date.now() - t0} base=${base.branch} note=no-commits-skip`,
			);
			continue;
		}

		// 1. 变基到目标分支（本地 ref）——冲突落在这一步，可 continue/abort
		const rebase = execRebase(repoRoot, branch, base.branch, wtPath);
		if (!rebase.ok) {
			const msg =
				rebase.conflicts.length > 0
					? `rebase 冲突：${rebase.conflicts.join(', ')}（解决后重跑本命令即可续完剩余成员）`
					: rebase.message;
			steps.push({ name, ok: false, message: msg });
			log.error(
				`FAIL_MARKER group=${groupName} action=merge member=${name} ms=${Date.now() - t0} reason=${oneLine(msg)}`,
			);
			return {
				ok: false,
				message: `组 '${groupName}' 合并停在成员 '${name}'（已完成的 ${mergedCount(steps)} 个提交保留在 ${base.branch} 上）`,
				steps,
				resumeFrom: name,
			};
		}

		// 2. 合入目标分支（squash 时由 execMerge 内部提交）
		const merge = await execMerge(repoRoot, branch, base.branch, strategy);
		if (!merge.ok) {
			steps.push({ name, ok: false, message: `合入失败：${merge.message}` });
			log.error(
				`FAIL_MARKER group=${groupName} action=merge member=${name} ms=${Date.now() - t0} reason=${oneLine(merge.message)}`,
			);
			return {
				ok: false,
				message: `组 '${groupName}' 合并停在成员 '${name}'`,
				steps,
				resumeFrom: name,
			};
		}

		// 3. 即时对齐（当前会话所在成员跳过：它正被这个会话使用）
		const isCurrentCwd = isSamePath(resolveWorktreePath(repoRoot, name), opts.currentCwd);
		let alignNote = '';
		if (isCurrentCwd) {
			alignNote = '（当前会话所在成员，已跳过即时对齐）';
		} else {
			const align = alignMember(repoRoot, name, base.branch);
			alignNote = align.ok ? `（已对齐）` : `（对齐失败：${align.message}）`;
		}

		steps.push({
			name,
			ok: true,
			message: `已合入 ${base.branch} ${alignNote}`,
			oldTip: originalTip,
		});
		log.info(
			`STEP_OK group=${groupName} action=merge member=${name} ms=${Date.now() - t0} base=${base.branch} oldTip=${originalTip} align=${isCurrentCwd ? 'skipped' : 'done'}`,
		);
	}

	const mergedN = mergedCount(steps);
	const skippedN = steps.length - mergedN;
	return {
		ok: true,
		message: `组 '${groupName}' 合并完成：${mergedN} 个成员 → ${base.branch} 新增 ${mergedN} 个提交${skippedN > 0 ? `（另有 ${skippedN} 个成员无领先提交，已跳过）` : ''}`,
		steps,
	};
}

/** 已真正合入的成员数（跳过项不计） */
function mergedCount(steps: GroupStep[]): number {
	return steps.filter((s) => s.ok && !s.skipped).length;
}

/** 结果行前缀：OK / FAIL / SKIP */
function stepMark(s: GroupStep): string {
	return s.ok ? (s.skipped ? 'SKIP' : 'OK') : 'FAIL';
}

// ── 组同步 ──

/**
 * 组同步：把成员对齐到目标分支。**非破坏性**（用 rebase，不丢未合入提交）；
 * 冲突即停，状态可续。
 */
export function execGroupSync(
	repoRoot: string,
	groupName: string,
	group: WorktreeGroup,
	members: string[],
): GroupOpResult {
	const base = resolveGroupBase(repoRoot, group);
	const steps: GroupStep[] = [];

	for (const name of members) {
		const t0 = Date.now();
		log.info(`STEP_BEGIN group=${groupName} action=sync member=${name} base=${base.branch}`);
		const branch = `wt/${name}`;
		const wtPath = resolveWorktreePath(repoRoot, name);
		const res = execRebase(repoRoot, branch, base.branch, wtPath);
		if (!res.ok) {
			const msg =
				res.conflicts.length > 0 ? `冲突：${res.conflicts.join(', ')}` : res.message;
			steps.push({ name, ok: false, message: msg });
			log.error(
				`FAIL_MARKER group=${groupName} action=sync member=${name} ms=${Date.now() - t0} reason=${oneLine(msg)}`,
			);
			return {
				ok: false,
				message: `组 '${groupName}' 同步停在成员 '${name}'`,
				steps,
				resumeFrom: name,
			};
		}
		steps.push({ name, ok: true, message: `已对齐到 ${base.branch}` });
		log.info(
			`STEP_OK group=${groupName} action=sync member=${name} ms=${Date.now() - t0} base=${base.branch}`,
		);
	}

	return {
		ok: true,
		message: `组 '${groupName}' 同步完成：${steps.length} 个成员 → ${base.branch}`,
		steps,
	};
}

// ── 只读视图 ──

export function formatGroupView(repoRoot: string): string {
	const { groups, warnings } = loadGroups(repoRoot);
	const names = Object.keys(groups).sort();
	const lines: string[] = [];

	if (warnings.length > 0) {
		lines.push('警告：', ...warnings.map((w) => `  - ${w}`), '');
	}
	if (names.length === 0) {
		lines.push('未声明任何组。');
		lines.push('在 <repoRoot>/.pi/extensions-data/pi-worktree/config.json 里加 groups 节，');
		lines.push('或用 `/worktree group new <组名>` 走向导创建。');
		return lines.join('\n');
	}

	for (const name of names) {
		const g = groups[name];
		const def = applyGroupDefaults(g);
		let baseDesc = g.baseRef ?? '(解析链)';
		let items: string[] = [];
		try {
			const cand = computeCandidates(repoRoot, name, g, 'merge');
			baseDesc = `${cand.base.branch}（${cand.base.source}）`;
			items = cand.items.map((i) => {
				const mark = i.locked ? '·' : '>';
				return `      ${mark} ${i.name} [${i.status}] ${i.reason}`;
			});
		} catch (err) {
			lines.push(
				`组 ${name}：目标分支解析失败（${err instanceof Error ? err.message : err}）`,
			);
		}
		lines.push(
			`组 ${name}  base=${baseDesc}  策略=${def.mergeStrategy}  env=${def.env.nodeModules}  成员=${g.members.length}`,
		);
		lines.push(...items);
	}
	return lines.join('\n');
}

// ── 交互流程（TUI 是主入口） ──

function errMsg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** 建组 / 改组：走向导 → 分节读改写落盘 */
export async function runGroupWizardFlow(
	repoRoot: string,
	ctx: any,
	opts: { existingName?: string; existing?: WorktreeGroup } = {},
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(
			'建组/改组需要 TUI。也可在 <repoRoot>/.pi/extensions-data/pi-worktree/config.json 手写 groups 节（仓库级才生效）。',
			'warning',
		);
		return;
	}
	const picked = await runGroupWizard(ctx, repoRoot, opts);
	if (!picked) {
		ctx.ui.notify('已取消', 'warning');
		return;
	}
	saveGroup(repoRoot, picked.name, picked.group);
	log.info('group saved', {
		name: picked.name,
		members: picked.group.members.length,
		baseRef: picked.group.baseRef ?? null,
		strategy: picked.group.mergeStrategy,
		env: picked.group.env?.nodeModules,
	});
	ctx.ui.notify(
		`已保存组 '${picked.name}'：${picked.group.members.length} 个成员 · 目标 ${picked.group.baseRef ?? '(解析链)'} · ${picked.group.mergeStrategy} · env=${picked.group.env?.nodeModules}`,
		'info',
	);
}

/**
 * 阶段② 统一对齐：只列**本轮已合入**成员（未合入者不出现，脏/锁定项不参与），默认全选。
 * Esc / 空选 = 跳过（保持阶段①的逐成员即时对齐结果，不做任何改动）。
 */
export async function promptUnifiedAlign(
	repoRoot: string,
	ctx: any,
	merged: string[],
	baseBranch: string,
	currentCwd?: string,
): Promise<void> {
	if (merged.length === 0) return;
	if (!ctx.hasUI) {
		ctx.ui.notify(
			`已合入成员已各自即时对齐。如需把全组收敛到同一基线：/worktree group sync <组名>`,
			'info',
		);
		return;
	}
	const picked = await showUnifiedAlignPanel(ctx, merged, baseBranch);
	if (!picked || picked.length === 0) return;

	const notes: string[] = [];
	for (const name of picked) {
		if (isSamePath(resolveWorktreePath(repoRoot, name), currentCwd)) {
			notes.push(`  ${name}：当前会话所在，保持不变`);
			continue;
		}
		const r = alignMember(repoRoot, name, baseBranch);
		notes.push(`  ${name}：${r.ok ? '已对齐' : `失败（${r.message}）`}`);
	}
	log.info('unified align done', { baseBranch, count: picked.length });
	ctx.ui.notify(`统一对齐 → ${baseBranch}\n${notes.join('\n')}`, 'info');
}

/**
 * 组动作交互流程：候选多选确认 → 执行 → 结果展示；合并成功后再问一次统一对齐。
 * 命令路径（无 UI）用「默认全选 = 全部未锁定候选」，`--members` 可显式收窄。
 */
export async function runGroupActionFlow(
	repoRoot: string,
	groupName: string,
	group: WorktreeGroup,
	action: CandidateAction,
	ctx: any,
	memberFilter: string[] | null = null,
): Promise<void> {
	let cand: GroupCandidates;
	try {
		cand = computeCandidates(repoRoot, groupName, group, action);
	} catch (err) {
		ctx.ui.notify(`组 '${groupName}' 目标分支解析失败：${errMsg(err)}`, 'error');
		return;
	}
	if (cand.items.length === 0) {
		ctx.ui.notify(`组 '${groupName}' 没有成员。`, 'warning');
		return;
	}

	let selected: string[];
	if (memberFilter) {
		selected = cand.selectable.filter((n) => memberFilter.includes(n));
		const dropped = memberFilter.filter((n) => !cand.selectable.includes(n));
		if (dropped.length > 0) {
			const why = cand.items
				.filter((i) => dropped.includes(i.name))
				.map((i) => `${i.name}(${i.reason})`)
				.join(' ');
			ctx.ui.notify(`已跳过不符合条件的成员：${why}`, 'warning');
		}
	} else if (ctx.hasUI) {
		const picked = await showGroupCandidatePanel(ctx, cand, action);
		if (picked === null) {
			ctx.ui.notify('已取消', 'warning');
			return;
		}
		// 双保险：锁定项永不进入执行集（面板已禁选，这里再过滤一次）
		selected = picked.filter((n) => cand.selectable.includes(n));
	} else {
		selected = cand.selectable;
	}

	if (selected.length === 0) {
		const locked = cand.items.map((i) => `  · ${i.name}：${i.reason}`).join('\n');
		ctx.ui.notify(
			`组 '${groupName}' 本次没有可执行的成员（目标分支 ${cand.base.branch}）：\n${locked}`,
			'warning',
		);
		return;
	}
	// 按花名册声明顺序执行（筛选不改变顺序）
	const ordered = group.members.filter((m) => selected.includes(m));

	log.info('group action start', {
		group: groupName,
		action,
		base: cand.base.branch,
		baseSource: cand.base.source,
		ordered,
	});
	const t0 = Date.now();
	let result: GroupOpResult;
	if (action === 'create') {
		result = execGroupCreate(repoRoot, groupName, group, ordered);
	} else if (action === 'sync') {
		result = execGroupSync(repoRoot, groupName, group, ordered);
	} else {
		result = await execGroupMerge(repoRoot, groupName, group, ordered, { currentCwd: ctx.cwd });
	}
	log.info('group action done', {
		group: groupName,
		action,
		ok: result.ok,
		resumeFrom: result.resumeFrom ?? null,
		ms: Date.now() - t0,
		steps: result.steps.map((s) => `${stepMark(s)} ${s.name}`),
	});

	const body = result.steps
		.map((s) => `  ${stepMark(s).padEnd(4)} ${s.name}：${s.message}`)
		.join('\n');
	ctx.ui.notify(`${result.message}\n${body}`, result.ok ? 'info' : 'error');

	if (action === 'merge' && result.ok) {
		// 只列**本轮真正合入**的成员：跳过项（无领先提交）没有可对齐的内容（ADR-0062 决策 9）
		const merged = result.steps.filter((s) => s.ok && !s.skipped).map((s) => s.name);
		await promptUnifiedAlign(repoRoot, ctx, merged, cand.base.branch, ctx.cwd);
	}
}

/**
 * 删除组声明：只删声明，不动 worktree / 分支 / 提交。
 * TUI 入口先让用户确认；命令入口（显式敲了 `delete`）不再二次询问。
 */
export async function runGroupDeleteFlow(
	repoRoot: string,
	groupName: string,
	ctx: any,
	opts: { confirm: boolean },
): Promise<void> {
	if (opts.confirm && ctx.ui.confirm) {
		const yes = await ctx.ui.confirm(
			`删除组声明 '${groupName}'？`,
			'只删除声明，不动任何 worktree、分支或提交。[Y] 确认 [N/Esc] 取消',
		);
		if (!yes) {
			ctx.ui.notify('已取消', 'warning');
			return;
		}
	}
	const ok = deleteGroup(repoRoot, groupName);
	log.info('group deleted', { name: groupName, ok });
	ctx.ui.notify(
		ok ? `已删除组声明 '${groupName}'` : `删除失败：组 '${groupName}' 不存在`,
		ok ? 'info' : 'error',
	);
}

/** 二级组菜单：进入组后选择动作（创建/合并/同步/编辑/删除） */
export async function runGroupMenuFlow(
	repoRoot: string,
	groupName: string,
	ctx: any,
): Promise<void> {
	const { groups } = loadGroups(repoRoot);
	const group = groups[groupName];
	if (!group) {
		ctx.ui.notify(`组 '${groupName}' 不存在。`, 'error');
		return;
	}
	const action: GroupMenuAction | null = await showGroupMenu(ctx, repoRoot, groupName, group);
	if (!action) return;

	if (action === 'delete') {
		await runGroupDeleteFlow(repoRoot, groupName, ctx, { confirm: true });
		return;
	}

	if (action === 'edit') {
		await runGroupWizardFlow(repoRoot, ctx, { existingName: groupName, existing: group });
		return;
	}

	await runGroupActionFlow(repoRoot, groupName, group, action as CandidateAction, ctx);
}

// ── 命令入口 ──

/** `/worktree group` 支持的子命令（未列出的动作直接报错） */
const KNOWN_GROUP_ACTIONS = ['list', 'new', 'edit', 'delete', 'create', 'merge', 'sync'] as const;

function parseMemberFilter(flags: Record<string, string>): string[] | null {
	const raw = flags.members;
	if (!raw) return null;
	return raw
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
}

/**
 * `/worktree group <action> [<组名>] [--members a,b]`
 *
 * action：`list` | `new` | `edit` | `delete` | `create` | `merge` | `sync`
 * 未给 `--members` 时取**默认全选 = 全部未锁定候选**（与面板默认一致）。
 */
export async function handleGroupCommand(
	repoRoot: string,
	flags: Record<string, string>,
	ctx: any,
): Promise<void> {
	const action = flags._positional || 'list';
	const extra = (flags._extraPositional || '').split(',').filter(Boolean);
	const groupName = flags.group || extra[0] || listGroupNames(repoRoot)[0];

	// 未知/拼错的子命令**绝不降级**为某个变更型动作（历史缺陷：`delete` 与拼错词都曾落到 merge）
	if (!(KNOWN_GROUP_ACTIONS as readonly string[]).includes(action)) {
		ctx.ui.notify(
			`未知的组子命令 '${action}'。可用：${KNOWN_GROUP_ACTIONS.join(' | ')}`,
			'error',
		);
		return;
	}

	if (action === 'list') {
		ctx.ui.notify(formatGroupView(repoRoot), 'info');
		return;
	}

	if (action === 'new') {
		await runGroupWizardFlow(repoRoot, ctx);
		return;
	}

	if (!groupName) {
		ctx.ui.notify('未声明任何组。先创建：/worktree group new', 'warning');
		return;
	}

	const { groups, warnings } = loadGroups(repoRoot);
	for (const w of takeNewGroupWarnings(warnings)) ctx.ui.notify(w, 'warning');
	const group: WorktreeGroup | undefined = groups[groupName];
	if (!group) {
		ctx.ui.notify(
			`组 '${groupName}' 不存在。已有：${Object.keys(groups).join(', ') || '(无)'}`,
			'error',
		);
		return;
	}

	if (action === 'delete') {
		await runGroupDeleteFlow(repoRoot, groupName, ctx, { confirm: false });
		return;
	}

	if (action === 'edit') {
		await runGroupWizardFlow(repoRoot, ctx, { existingName: groupName, existing: group });
		return;
	}

	// 白名单已收敛：此处 action 只可能是 create | merge | sync
	const candidateAction: CandidateAction = action as CandidateAction;
	await runGroupActionFlow(
		repoRoot,
		groupName,
		group,
		candidateAction,
		ctx,
		parseMemberFilter(flags),
	);
}

/** 供 TUI 面板使用：列出所有组（含默认值解析） */
export function listGroupsForUI(repoRoot: string): {
	name: string;
	group: WorktreeGroup;
	baseLabel: string;
	warnings: string[];
	groups: GroupMap;
}[] {
	const { groups, warnings } = loadGroups(repoRoot);
	return Object.keys(groups)
		.sort()
		.map((name) => {
			const group = groups[name];
			let baseLabel = group.baseRef ?? '(解析链)';
			try {
				const base = resolveGroupBase(repoRoot, group);
				baseLabel = base.branch;
			} catch {
				/* 解析失败时保留声明值 */
			}
			return { name, group, baseLabel, warnings, groups };
		});
}

export { saveGroup };
