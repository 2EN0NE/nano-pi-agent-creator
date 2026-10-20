/**
 * pi-worktree — 组相关 TUI（ADR-0062）
 *
 * 组成：
 *   - buildGroupRows  一级列表（switcher）的 Groups 段数据
 *   - showGroupMenu   二级组菜单（master-detail 的 detail 层）
 *   - showGroupCandidatePanel  执行前的候选多选确认（脏/无提交/不存在 → 灰显禁选）
 *   - showUnifiedAlignPanel    整批合并后的「统一对齐」范围选择（只列本轮已合入成员）
 *   - runGroupWizard  建组/改组向导（6 步：组名 → 目标分支 → 成员 → 合并策略 → env → 确认）
 *
 * 一律纯文本 + truncateToWidth 兜底；列表带滚动上限（一级列表必带上限，见 TUI 交互规范）。
 */
import { truncateToWidth, visibleWidth, matchesKey, getKeybindings } from '@earendil-works/pi-tui';
import type { MergeStrategy, NodeModulesStrategy } from '../types.js';
import { getManagedWorktrees } from './paths.js';
import { listLocalBranches } from './target.js';
import { ListSelector, MultiSelectPanel, type MultiSelectItem, type GroupRowItem } from './ui.js';
import {
	ENV_STRATEGY_NOTES,
	MERGE_STRATEGY_NOTES,
	applyGroupDefaults,
	resolveGroupBase,
	type GroupCandidates,
	type GroupEnv,
	type WorktreeGroup,
} from './groups.js';

const ENV_ORDER: NodeModulesStrategy[] = ['copy', 'symlink', 'install', 'none'];
const MERGE_ORDER: MergeStrategy[] = ['squash', 'merge'];
const AUTO_BASE = '__auto__';
/** 列表滚动窗口上限（避免长分支/长成员列表把面板撑到超视口） */
const MAX_VISIBLE = 12;

function showCustom<T>(
	ctx: any,
	build: (tui: any, theme: any, kb: any, done: (v: T) => void) => any,
): Promise<T> {
	return (ctx.ui.custom as <R>(cb: (...a: any[]) => any) => Promise<R>)<T>(build);
}

/** 滚动窗口：返回可见切片起点（选中行尽量居中，参考原生 /tree） */
function windowStart(total: number, cursor: number, max = MAX_VISIBLE): number {
	if (total <= max) return 0;
	const half = Math.floor(max / 2);
	return Math.max(0, Math.min(cursor - half, total - max));
}

// ═══════════════════════════════════════════
// 一级列表的 Groups 段
// ═══════════════════════════════════════════

/** 组装 switcher 一级列表的组条目（目标分支解析失败的组带 `!` 提示，但仍可进入菜单看原因） */
export function buildGroupRows(
	repoRoot: string,
	groups: Record<string, WorktreeGroup>,
): GroupRowItem[] {
	return Object.keys(groups)
		.sort()
		.map((name) => {
			const g = groups[name];
			const def = applyGroupDefaults(g);
			let baseLabel = g.baseRef ?? 'auto';
			let locked = false;
			try {
				baseLabel = resolveGroupBase(repoRoot, g).branch;
			} catch {
				locked = true;
				baseLabel = g.baseRef ?? '(未解析)';
			}
			return {
				name,
				summary: `${g.members.length} members · ${baseLabel} · ${def.mergeStrategy} · ${def.env.nodeModules}`,
				locked,
			};
		});
}

// ═══════════════════════════════════════════
// 二级：组菜单
// ═══════════════════════════════════════════

export type GroupMenuAction = 'merge' | 'create' | 'sync' | 'edit' | 'delete';

export async function showGroupMenu(
	ctx: any,
	repoRoot: string,
	groupName: string,
	group: WorktreeGroup,
): Promise<GroupMenuAction | null> {
	const def = applyGroupDefaults(group);
	let baseLabel = group.baseRef ?? '(解析链)';
	try {
		baseLabel = resolveGroupBase(repoRoot, group).branch;
	} catch {
		/* 保留声明值 */
	}

	return showCustom<GroupMenuAction | null>(ctx, (tui, theme, _kb, done) => {
		const panel = new ListSelector({
			tui,
			theme,
			done: (v: any) => done((v as GroupMenuAction) ?? null),
			title: `组 ${groupName} → ${baseLabel}`,
			options: [
				{ value: 'merge', label: `合并本组 → ${baseLabel}（按花名册顺序，各 1 提交）` },
				{ value: 'create', label: '创建缺失成员（只补建，不动已有）' },
				{ value: 'sync', label: '全组同步到目标分支（非破坏性）' },
				{
					value: 'edit',
					label: `编辑声明（策略=${def.mergeStrategy} env=${def.env.nodeModules}）`,
				},
				{ value: 'delete', label: '删除组声明（不删 worktree）' },
			],
			footer: `${group.members.length} members: ${group.members.join(', ')}`,
		});
		return {
			render: (w: number) => panel.render(w),
			handleInput: (d: string) => panel.handleInput(d),
			invalidate: () => panel.invalidate(),
		};
	});
}

// ═══════════════════════════════════════════
// 执行前的候选多选确认
// ═══════════════════════════════════════════

const ACTION_TITLE: Record<string, string> = {
	merge: '合并成员',
	create: '创建成员',
	sync: '同步成员',
};

/** 候选多选：默认全选可选项；锁定项灰显禁选（显示原因） */
export async function showGroupCandidatePanel(
	ctx: any,
	cand: GroupCandidates,
	action: string,
): Promise<string[] | null> {
	const items: MultiSelectItem[] = cand.items.map((it) => ({
		id: it.name,
		label: it.name,
		hint: it.reason,
		selected: !it.locked,
		disabled: it.locked,
	}));

	return showCustom<string[] | null>(ctx, (tui, theme, _kb, done) => {
		const panel = new MultiSelectPanel({
			tui,
			theme,
			done,
			title: `${ACTION_TITLE[action] ?? action} · 组 ${cand.group} → ${cand.base.branch}`,
			items,
			footer: `按花名册顺序执行 · 灰显项本次不参与 · Enter 确认 Esc 取消`,
		});
		return {
			render: (w: number) => panel.render(w),
			handleInput: (d: string) => panel.handleInput(d),
			invalidate: () => panel.invalidate(),
		};
	});
}

/** 整批合并完成后的「统一对齐」范围选择：默认全选，Esc 表示跳过（保持即刻对齐后的状态） */
export async function showUnifiedAlignPanel(
	ctx: any,
	members: string[],
	baseBranch: string,
): Promise<string[] | null> {
	const items: MultiSelectItem[] = members.map((name) => ({
		id: name,
		label: name,
		hint: '已合入本轮，可安全对齐',
		selected: true,
	}));
	return showCustom<string[] | null>(ctx, (tui, theme, _kb, done) => {
		const panel = new MultiSelectPanel({
			tui,
			theme,
			done,
			title: `统一对齐到 ${baseBranch}`,
			items,
			footer: '各成员当前基线版本不同 · Enter 对齐所选 Esc 跳过（不改动）',
		});
		return {
			render: (w: number) => panel.render(w),
			handleInput: (d: string) => panel.handleInput(d),
			invalidate: () => panel.invalidate(),
		};
	});
}

// ═══════════════════════════════════════════
// 建组 / 改组向导
// ═══════════════════════════════════════════

export interface GroupWizardResult {
	name: string;
	group: WorktreeGroup;
}

type WizardStep = 0 | 1 | 2 | 3 | 4 | 5;

/**
 * 6 步向导。编辑类步骤**必显当前值**（组名行内回显、分支/成员/策略高亮当前选择）。
 * Esc 任一步 = 整体取消（返回 null），避免半成品声明落盘。
 */
class GroupWizardPanel {
	private tui_: { requestRender: () => void };
	private theme_: any;
	private done_: (v: GroupWizardResult | null) => void;
	private step_: WizardStep = 0;

	private name_: string;
	private nameDraft_: string;
	private baseOptions_: Array<{ value: string; label: string }>;
	private baseIdx_ = 0;
	private memberItems_: MultiSelectItem[];
	private memberCursor_ = 0;
	private strategyIdx_: number;
	private envIdx_: number;
	private editing_: boolean;

	constructor(opts: {
		tui: { requestRender: () => void };
		theme: any;
		done: (v: GroupWizardResult | null) => void;
		repoRoot: string;
		existingName?: string;
		existing?: WorktreeGroup;
	}) {
		this.tui_ = opts.tui;
		this.theme_ = opts.theme;
		this.done_ = opts.done;
		this.editing_ = !!opts.existing;

		const ex = opts.existing;
		this.name_ = opts.existingName ?? '';
		this.nameDraft_ = this.name_;

		// 目标分支：自动（解析链）+ 本地分支
		const branches = listLocalBranches(opts.repoRoot);
		this.baseOptions_ = [
			{ value: AUTO_BASE, label: '自动（组目标分支解析链，本地优先）' },
			...branches.map((b) => ({ value: b, label: b })),
		];
		const wantBase = ex?.baseRef ?? AUTO_BASE;
		const bi = this.baseOptions_.findIndex((o) => o.value === wantBase);
		this.baseIdx_ = bi >= 0 ? bi : 0;

		// 成员：现有受管 worktree，新建默认全选；编辑时按既有花名册
		const names = getManagedWorktrees(opts.repoRoot).map((w) => w.name);
		const prepicked = ex?.members ?? names;
		this.memberItems_ = names.map((n) => ({
			id: n,
			label: n,
			hint: 'worktree',
			selected: prepicked.includes(n),
		}));

		this.strategyIdx_ = Math.max(0, MERGE_ORDER.indexOf(ex?.mergeStrategy ?? 'squash'));
		this.envIdx_ = Math.max(0, ENV_ORDER.indexOf(ex?.env?.nodeModules ?? 'copy'));
	}

	private result_(): GroupWizardResult {
		const members = this.memberItems_.filter((i) => i.selected).map((i) => i.id);
		const base = this.baseOptions_[this.baseIdx_].value;
		const env: GroupEnv = {
			...applyGroupDefaults({ members }).env,
			nodeModules: ENV_ORDER[this.envIdx_],
		};
		return {
			name: this.nameDraft_.trim(),
			group: {
				members,
				...(base === AUTO_BASE ? {} : { baseRef: base }),
				mergeStrategy: MERGE_ORDER[this.strategyIdx_],
				env,
			},
		};
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		const up = kb.matches(data, 'tui.select.up') || matchesKey(data, 'up');
		const down = kb.matches(data, 'tui.select.down') || matchesKey(data, 'down');

		if (matchesKey(data, 'escape')) {
			this.done_(null);
			return;
		}

		// 步骤 0：组名（行内编辑，回显当前值）
		if (this.step_ === 0) {
			if (matchesKey(data, 'enter')) {
				const v = this.nameDraft_.trim();
				if (!v) return; // 空名不允许前进
				this.name_ = v;
				this.step_ = 1;
			} else if (matchesKey(data, 'backspace') || data === '\x7f') {
				this.nameDraft_ = this.nameDraft_.slice(0, -1);
			} else if (matchesKey(data, 'space')) {
				this.nameDraft_ += '_'; // 组名不允许空格，落盘友好（config key）
			} else if (data && data.length === 1 && data >= ' ' && data !== '\x1b') {
				this.nameDraft_ += data;
			}
			this.tui_.requestRender();
			return;
		}

		// 步骤 2：成员多选
		if (this.step_ === 2) {
			if (up) this.memberCursor_ = Math.max(0, this.memberCursor_ - 1);
			else if (down)
				this.memberCursor_ = Math.min(this.memberItems_.length - 1, this.memberCursor_ + 1);
			else if (matchesKey(data, 'space')) {
				const it = this.memberItems_[this.memberCursor_];
				if (it) it.selected = !it.selected;
			} else if (matchesKey(data, 'enter')) this.step_ = 3;
			else return;
			this.tui_.requestRender();
			return;
		}

		// 步骤 5：确认
		if (this.step_ === 5) {
			if (matchesKey(data, 'enter')) {
				const r = this.result_();
				if (r.group.members.length === 0) return; // 空花名册不允许落盘
				this.done_(r);
			}
			return;
		}

		// 步骤 1/3/4：列表选择（up/down 移动、Enter 前进）
		const list = this.currentList_();
		if (!list) return;
		if (up || down) {
			const next = up ? Math.max(0, list.idx() - 1) : Math.min(list.len - 1, list.idx() + 1);
			list.set(next);
			this.tui_.requestRender();
		} else if (matchesKey(data, 'enter')) {
			this.step_ = (this.step_ + 1) as WizardStep;
			this.tui_.requestRender();
		}
	}

	/** 步骤 1/3/4 共用的「单列选择」访问器（长度 / 当前下标 / 设值） */
	private currentList_(): { len: number; idx: () => number; set: (n: number) => void } | null {
		if (this.step_ === 1)
			return {
				len: this.baseOptions_.length,
				idx: () => this.baseIdx_,
				set: (n) => (this.baseIdx_ = n),
			};
		if (this.step_ === 3)
			return {
				len: MERGE_ORDER.length,
				idx: () => this.strategyIdx_,
				set: (n) => (this.strategyIdx_ = n),
			};
		if (this.step_ === 4)
			return {
				len: ENV_ORDER.length,
				idx: () => this.envIdx_,
				set: (n) => (this.envIdx_ = n),
			};
		return null;
	}

	private title_(): string {
		const label = this.editing_ ? '编辑组' : '新建组';
		const stepNames = ['组名', '目标分支', '成员', '合并策略', 'env 策略', '确认'];
		return `${label} ${this.step_ + 1}/6 ${stepNames[this.step_]}`;
	}

	/** 纯横线范式：顶边框带标题、内容行缩进、底边框纯横线 */
	private frame_(width: number, th: any, body: string[]): string[] {
		const titleText = th.fg('accent', th.bold(this.title_()));
		const prefix = th.fg('dim', '── ');
		const fill = Math.max(0, width - visibleWidth(prefix) - visibleWidth(titleText) - 1);
		const lines = [
			truncateToWidth(prefix + titleText + ' ' + th.fg('dim', '─'.repeat(fill)), width),
		];
		for (const b of body) lines.push(truncateToWidth(' ' + b, width));
		lines.push(truncateToWidth(th.fg('dim', '─'.repeat(width)), width));
		return lines;
	}

	render(width: number): string[] {
		const th = this.theme_;
		const dim = (s: string) => th.fg('dim', s);
		const body: string[] = [];

		if (this.step_ === 0) {
			body.push(dim('组名（config key，仅字母/数字/-/_）'));
			body.push(`${th.fg('accent', '>')} ${this.nameDraft_}${th.fg('accent', '_')}`);
			if (this.name_ && this.editing_) body.push(dim(`当前：${this.name_}`));
			body.push(dim('Enter 下一步  Esc 取消'));
		} else if (this.step_ === 1) {
			body.push(dim('目标分支（缺省 = 解析链：组声明 → 仓库默认分支 → 当前 HEAD）'));
			const start = windowStart(this.baseOptions_.length, this.baseIdx_);
			for (let i = start; i < Math.min(start + MAX_VISIBLE, this.baseOptions_.length); i++) {
				const o = this.baseOptions_[i];
				body.push(
					i === this.baseIdx_
						? `${th.fg('accent', '>')} ${o.label}`
						: `  ${dim(o.label)}`,
				);
			}
		} else if (this.step_ === 2) {
			body.push(dim('成员（space 开关；默认全选现有受管 worktree）'));
			if (this.memberItems_.length === 0)
				body.push(dim('  （当前没有受管 worktree，可稍后 group create 补建）'));
			const start = windowStart(this.memberItems_.length, this.memberCursor_);
			for (let i = start; i < Math.min(start + MAX_VISIBLE, this.memberItems_.length); i++) {
				const it = this.memberItems_[i];
				const mark = i === this.memberCursor_ ? th.fg('accent', '>') : ' ';
				const check = it.selected ? th.fg('accent', '[x]') : dim('[ ]');
				body.push(`${mark} ${check} ${it.label}`);
			}
		} else if (this.step_ === 3) {
			body.push(dim('合并策略'));
			for (let i = 0; i < MERGE_ORDER.length; i++) {
				const s = MERGE_ORDER[i];
				const note = MERGE_STRATEGY_NOTES[s];
				body.push(
					i === this.strategyIdx_
						? `${th.fg('accent', '>')} ${note.label}`
						: `  ${dim(note.label)}`,
				);
			}
			const note = MERGE_STRATEGY_NOTES[MERGE_ORDER[this.strategyIdx_]];
			body.push(dim(`  ${note.pros[0] ?? ''}`));
		} else if (this.step_ === 4) {
			body.push(dim('node_modules 策略（影响依赖复用与空间占用）'));
			for (let i = 0; i < ENV_ORDER.length; i++) {
				const s = ENV_ORDER[i];
				const note = ENV_STRATEGY_NOTES[s];
				body.push(
					i === this.envIdx_
						? `${th.fg('accent', '>')} ${note.label}`
						: `  ${dim(note.label)}`,
				);
			}
			const note = ENV_STRATEGY_NOTES[ENV_ORDER[this.envIdx_]];
			body.push(dim(`  空间：${note.space}`));
			body.push(dim(`  ${note.pros[0] ?? ''}`));
		} else {
			const r = this.result_();
			body.push(dim('确认声明（Enter 保存  Esc 取消）'));
			body.push(`  组名   ${th.fg('accent', r.name || '(未填)')}`);
			body.push(`  目标   ${this.baseOptions_[this.baseIdx_].label}`);
			body.push(
				`  成员   ${r.group.members.length} 个：${r.group.members.join(', ') || '(无)'}`,
			);
			body.push(`  策略   ${r.group.mergeStrategy}   env=${r.group.env?.nodeModules}`);
			if (!r.name) body.push(th.fg('warning', '  组名不能为空'));
			if (r.group.members.length === 0) body.push(th.fg('warning', '  至少选择一个成员'));
		}

		return this.frame_(width, th, body);
	}

	invalidate(): void {}
}

export async function runGroupWizard(
	ctx: any,
	repoRoot: string,
	opts: { existingName?: string; existing?: WorktreeGroup } = {},
): Promise<GroupWizardResult | null> {
	return showCustom<GroupWizardResult | null>(ctx, (tui, theme, _kb, done) => {
		const panel = new GroupWizardPanel({
			tui,
			theme,
			done,
			repoRoot,
			existingName: opts.existingName,
			existing: opts.existing,
		});
		return {
			render: (w: number) => panel.render(w),
			handleInput: (d: string) => panel.handleInput(d),
			invalidate: () => panel.invalidate(),
		};
	});
}
