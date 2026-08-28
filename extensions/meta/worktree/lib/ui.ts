/**
 * pi-worktree — TUI 组件（切换器面板 + 交互弹窗）
 *
 * 符合 TUI 设计规范：无 emoji、纯文本、truncateToWidth 安全网。
 * 所有面板和弹窗内联渲染（无左右竖边），与 permission-gate 一致。
 *
 * 键盘处理使用 matchesKey() / getKeybindings() 而非 raw escape codes。
 */
import { truncateToWidth, visibleWidth, matchesKey, getKeybindings } from '@earendil-works/pi-tui';
import type { ManagedWorktree } from './paths.js';
import type { NodeModulesStrategy, SymlinkSelections } from '../types.js';
import { PRESET_SYMLINK_TARGETS } from '../types.js';
import {
	setLastNodeModulesStrategy,
	setLastSymlinkTargetIds,
	getLastSymlinkTargetIds,
	getLastNodeModulesStrategy,
} from '../state.js';
import { getDirtyCount, getAheadBehind } from './git.js';

// ── 常量 ──

const STRATEGY_LABELS: Record<NodeModulesStrategy, string> = {
	symlink: 'Symlink (fastest)',
	copy: 'Hardlink copy (cp -al)',
	install: 'Auto install (npm/pnpm/yarn)',
	none: 'None',
};

// ═══════════════════════════════════════════
// 切换器面板
// ═══════════════════════════════════════════

export interface SwitchResult {
	action:
		| 'switch'
		| 'fork'
		| 'create'
		| 'delete'
		| 'merge'
		| 'rebase'
		| 'shell'
		| 'quit'
		| 'operations';
	target?: string;
}

interface WorktreeItem {
	type: 'main' | 'worktree';
	name: string;
	branch: string;
	dirty: number;
	ahead: number;
	behind: number;
}

/**
 * WorktreeSwitcherPanel — 类组件，参考 permission-gate TwoTabPanel 模式
 *
 * 键盘：
 *   up/down       导航列表
 *   Enter/Space   切换选中项
 *   f/F           Fork context
 *   c/C           Create new worktree
 *   d/D           删除选中项
 *   m/M           Merge
 *   s/S           Shell
 *   q/Q / Esc     退出
 */
class WorktreeSwitcherPanel {
	private tui_: { requestRender: () => void };
	private theme_: any;
	private done_: (v: SwitchResult) => void;
	private items_: WorktreeItem[];
	private cursor_: number;
	private currentName_: string | null;
	private errorMsg_: string;

	constructor(opts: {
		tui: { requestRender: () => void };
		theme: any;
		done: (v: SwitchResult) => void;
		items: WorktreeItem[];
		currentName: string | null;
		errorMsg: string;
	}) {
		this.tui_ = opts.tui;
		this.theme_ = opts.theme;
		this.done_ = opts.done;
		this.items_ = opts.items;
		this.currentName_ = opts.currentName;
		this.errorMsg_ = opts.errorMsg;

		this.cursor_ = this.items_.findIndex(
			(i) =>
				(opts.currentName === null && i.type === 'main') ||
				(opts.currentName !== null && i.name === opts.currentName),
		);
		if (this.cursor_ < 0) this.cursor_ = 0;
	}

	private resolveTarget_(): string {
		if (this.items_[this.cursor_]?.type === 'main') return 'main';
		return this.items_[this.cursor_]?.name || 'main';
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		const maxIdx = this.items_.length - 1;

		if (kb.matches(data, 'tui.select.up') || matchesKey(data, 'up')) {
			this.cursor_ = Math.max(0, this.cursor_ - 1);
			this.tui_.requestRender();
			return;
		}

		if (kb.matches(data, 'tui.select.down') || matchesKey(data, 'down')) {
			this.cursor_ = Math.min(maxIdx, this.cursor_ + 1);
			this.tui_.requestRender();
			return;
		}

		if (matchesKey(data, 'enter') || matchesKey(data, 'space')) {
			const target = this.resolveTarget_();
			if (target === 'main') {
				// main: 直接切换（兼容旧行为）
				this.done_({ action: 'switch', target: 'main' });
			} else {
				// worktree: 弹出操作子菜单
				this.done_({ action: 'operations', target });
			}
			return;
		}

		if (data === 'f' || data === 'F') {
			this.done_({ action: 'fork', target: this.resolveTarget_() });
			return;
		}

		if (data === 'c' || data === 'C') {
			this.done_({ action: 'create' });
			return;
		}

		if (data === 'd' || data === 'D') {
			if (this.items_[this.cursor_]?.type === 'worktree') {
				this.done_({
					action: 'delete',
					target: this.items_[this.cursor_].name,
				});
			}
			return;
		}

		if (data === 'm' || data === 'M') {
			this.done_({ action: 'merge' });
			return;
		}

		if (data === 's' || data === 'S') {
			this.done_({ action: 'shell', target: this.resolveTarget_() });
			return;
		}

		if (data === 'q' || data === 'Q' || matchesKey(data, 'escape')) {
			this.done_({ action: 'quit' });
		}
	}

	render(width: number): string[] {
		const th = this.theme_;
		const lines: string[] = [];

		// 标题（嵌入上边框）：── pi-worktree ────...
		// 前缀线与右侧填充线同为 dim 色，保证整条上边框颜色一致
		const titleText = th.fg('accent', 'pi-worktree');
		const titlePrefix = th.fg('dim', '── ');
		const titleSuffix = ' ';
		const titleVisible = visibleWidth(titleText);
		const titleFill = Math.max(
			0,
			width - visibleWidth(titlePrefix) - titleVisible - visibleWidth(titleSuffix),
		);
		lines.push(
			truncateToWidth(
				titlePrefix + titleText + titleSuffix + th.fg('dim', '─'.repeat(titleFill)),
				width,
			),
		);

		// 当前 cwd
		const cwdLabel = this.currentName_
			? th.fg('accent', this.currentName_)
			: th.fg('success', 'main');
		lines.push(truncateToWidth(th.fg('dim', 'cwd: ') + cwdLabel, width));

		// 分隔
		lines.push(truncateToWidth(th.fg('dim', '─'.repeat(width)), width));

		// 表头
		lines.push(
			truncateToWidth(
				'   Name' + ' '.repeat(10) + 'Branch' + ' '.repeat(14) + 'Status',
				width,
			),
		);

		// 列表
		for (let i = 0; i < this.items_.length; i++) {
			const item = this.items_[i];
			const isCurrent =
				(this.currentName_ === null && item.type === 'main') ||
				(this.currentName_ !== null && item.name === this.currentName_);
			const arrow = i === this.cursor_ ? th.fg('accent', '>') : ' ';
			const namePart =
				i === this.cursor_
					? th.fg('accent', item.name)
					: isCurrent
						? th.fg('success', item.name)
						: th.fg('text', item.name);
			const nameVisible = visibleWidth(namePart);
			const namePadded = namePart + ' '.repeat(Math.max(0, 15 - nameVisible));
			const dirtyStr =
				item.dirty > 0 ? th.fg('warning', `dirty(${item.dirty})`) : th.fg('dim', 'clean');
			// ahead = worktree 领先 main（待合并），behind = worktree 落后 main（需 sync）
			const aheadStr = item.ahead > 0 ? th.fg('accent', ` +${item.ahead}`) : '';
			const behindStr = item.behind > 0 ? th.fg('warning', ` -${item.behind}`) : '';

			lines.push(
				truncateToWidth(
					` ${arrow} ${namePadded} ${item.branch.padEnd(18)} ${dirtyStr}${aheadStr}${behindStr}`,
					width,
				),
			);
		}

		// 操作栏
		lines.push(truncateToWidth(th.fg('dim', '─'.repeat(width)), width));
		const actions = [
			th.fg('dim', '[F]ork'),
			th.fg('dim', '[C]reate'),
			th.fg('dim', '[D]elete'),
			th.fg('dim', '[M]erge'),
			th.fg('dim', '[S]hell'),
			th.fg('accent', '[Enter] Switch'),
			th.fg('dim', '[Q]uit'),
		];
		lines.push(truncateToWidth(' ' + actions.join('  '), width));

		// 选中项
		if (this.items_[this.cursor_]) {
			const actLabel =
				this.items_[this.cursor_].type === 'main'
					? 'main checkout'
					: `worktree "${this.items_[this.cursor_].name}"`;
			lines.push(truncateToWidth(th.fg('dim', ' Current: ' + actLabel), width));
		}

		if (this.errorMsg_) {
			lines.push(truncateToWidth(th.fg('error', this.errorMsg_), width));
		}

		// 底部
		lines.push(truncateToWidth(th.fg('dim', '─'.repeat(width)), width));

		return lines;
	}

	invalidate(): void {}
}

export async function showWorktreeTui(
	ctx: any,
	allWorktrees: ManagedWorktree[],
	currentName: string | null,
	errorMsg: string,
	repoRoot: string,
): Promise<SwitchResult> {
	return (ctx.ui.custom as <T>(cb: (...a: any[]) => any) => Promise<T>)<SwitchResult>(
		(tui, theme, _kb, done) => {
			const items: WorktreeItem[] = [
				{
					type: 'main',
					name: 'main',
					branch: 'current',
					dirty: 0,
					ahead: 0,
					behind: 0,
				},
				...allWorktrees.map((wt) => {
					const { ahead, behind } = getAheadBehind(repoRoot, wt.branch);
					return {
						type: 'worktree' as const,
						name: wt.name,
						branch: wt.branch,
						dirty: getDirtyCount(wt.path),
						ahead,
						behind,
					};
				}),
			];

			const panel = new WorktreeSwitcherPanel({
				tui,
				theme,
				done,
				items,
				currentName,
				errorMsg,
			});

			return {
				render: (w: number) => panel.render(w),
				handleInput: (data: string) => panel.handleInput(data),
				invalidate: () => panel.invalidate(),
			};
		},
	);
}

// ═══════════════════════════════════════════
// 内联选择器（ListSelector — 通用列表选择）
// ═══════════════════════════════════════════

class ListSelector {
	private tui_: { requestRender: () => void };
	private theme_: any;
	private done_: (v: any) => void;
	private options_: Array<{ value: string; label: string }>;
	private cursor_: number;
	private title_: string;
	private footer_: string;

	constructor(opts: {
		tui: { requestRender: () => void };
		theme: any;
		done: (v: any) => void;
		title: string;
		options: Array<{ value: string; label: string }>;
		cursor?: number;
		footer?: string;
	}) {
		this.tui_ = opts.tui;
		this.theme_ = opts.theme;
		this.done_ = opts.done;
		this.title_ = opts.title;
		this.options_ = opts.options;
		this.cursor_ = opts.cursor ?? 0;
		this.footer_ = opts.footer ?? 'up/down navigate  Enter confirm  Esc cancel';
	}

	handleInput(data: string): void {
		const kb = getKeybindings();

		if (kb.matches(data, 'tui.select.up') || matchesKey(data, 'up')) {
			this.cursor_ = Math.max(0, this.cursor_ - 1);
			this.tui_.requestRender();
			return;
		}

		if (kb.matches(data, 'tui.select.down') || matchesKey(data, 'down')) {
			this.cursor_ = Math.min(this.options_.length - 1, this.cursor_ + 1);
			this.tui_.requestRender();
			return;
		}

		if (matchesKey(data, 'enter') || matchesKey(data, 'space')) {
			this.done_(this.options_[this.cursor_]?.value ?? null);
			return;
		}

		if (matchesKey(data, 'escape')) {
			this.done_(null);
		}
	}

	render(width: number): string[] {
		const th = this.theme_;
		const lines: string[] = [];

		lines.push(truncateToWidth(th.fg('accent', th.bold(this.title_)), width));
		lines.push(truncateToWidth(th.fg('dim', '─'.repeat(width)), width));

		for (let i = 0; i < this.options_.length; i++) {
			const opt = this.options_[i];
			const arrow = i === this.cursor_ ? th.fg('accent', '>') : ' ';
			const label = i === this.cursor_ ? th.fg('accent', opt.label) : opt.label;
			lines.push(truncateToWidth(` ${arrow} ${label}`, width));
		}

		lines.push(truncateToWidth(th.fg('dim', '─'.repeat(width)), width));
		lines.push(truncateToWidth(th.fg('dim', this.footer_), width));

		return lines;
	}

	invalidate(): void {}
}

// ═══════════════════════════════════════════
// 删除当前 worktree 时的离开去向选择
// ═══════════════════════════════════════════

export async function askDeleteLeaveChoice(
	ctx: any,
	hasHistory: boolean,
): Promise<'resume' | 'new' | 'cancel'> {
	if (!ctx.hasUI) return hasHistory ? 'resume' : 'new';

	const options: Array<{ value: 'resume' | 'new' | 'cancel'; label: string }> = [];
	if (hasHistory) {
		options.push({ value: 'resume', label: 'Resume main history' });
	}
	options.push({ value: 'new', label: 'New session in main' });
	options.push({ value: 'cancel', label: 'Cancel deletion' });

	return (ctx.ui.custom as <T>(cb: (...a: any[]) => any) => Promise<T>)<
		'resume' | 'new' | 'cancel'
	>((tui, theme, _kb, done) => {
		const selector = new ListSelector({
			tui,
			theme,
			done,
			title: 'Delete current worktree: where to go?',
			options,
			footer: 'up/down navigate  Enter confirm  Esc cancel',
		});
		return {
			render: (w: number) => selector.render(w),
			handleInput: (d: string) => selector.handleInput(d),
			invalidate: () => selector.invalidate(),
		};
	});
}

// ═══════════════════════════════════════════
// 会话策略
// ═══════════════════════════════════════════

export async function askSessionStrategy(
	ctx: any,
	targetName: string,
	hasHistory: boolean,
): Promise<'checkout' | 'resume' | 'new' | 'clone' | 'cancel'> {
	if (!ctx.hasUI) return hasHistory ? 'resume' : 'new';

	const isOriginalProject = targetName === 'main';
	const label = isOriginalProject ? 'original project' : `worktree "${targetName}"`;
	const options: Array<{ value: string; label: string }> = [];

	if (isOriginalProject) {
		options.push({
			value: 'checkout',
			label: 'Checkout branch in current directory (no session switch)',
		});
		if (hasHistory) {
			options.push({ value: 'resume', label: 'Resume existing session' });
		}
		// 始终允许带 session 切换回 main
		options.push({ value: 'new', label: 'Switch to main (new session)' });
	} else {
		// worktree 目标：clone 始终可用（有 history 时覆盖，无 history 时首次建立）
		if (hasHistory) {
			options.push({ value: 'resume', label: 'Resume existing session' });
			options.push({
				value: 'clone',
				label: 'Clone current session history (overwrite existing)',
			});
		} else {
			options.push({
				value: 'clone',
				label: 'Clone current session history to worktree',
			});
		}
		options.push({ value: 'new', label: 'New session (no history)' });
	}
	options.push({ value: 'cancel', label: 'Cancel' });

	return (ctx.ui.custom as <T>(cb: (...a: any[]) => any) => Promise<T>)<
		'checkout' | 'resume' | 'new' | 'clone' | 'cancel'
	>((tui, theme, _kb, done) => {
		const selector = new ListSelector({
			tui,
			theme,
			done,
			title: `Switch to ${label}`,
			options,
			footer: 'up/down navigate  Enter confirm  Esc cancel',
		});
		return {
			render: (w: number) => selector.render(w),
			handleInput: (d: string) => selector.handleInput(d),
			invalidate: () => selector.invalidate(),
		};
	});
}

// ═══════════════════════════════════════════
// 多选面板（通用）
// ═══════════════════════════════════════════

interface MultiSelectItem {
	id: string;
	label: string;
	hint: string;
	selected: boolean;
}

class MultiSelectPanel {
	private tui_: { requestRender: () => void };
	private theme_: any;
	private done_: (v: string[] | null) => void;
	private items_: MultiSelectItem[];
	private cursor_: number;
	private title_: string;
	private footer_: string;

	constructor(opts: {
		tui: { requestRender: () => void };
		theme: any;
		done: (v: string[] | null) => void;
		title: string;
		items: MultiSelectItem[];
		cursor?: number;
		footer?: string;
	}) {
		this.tui_ = opts.tui;
		this.theme_ = opts.theme;
		this.done_ = opts.done;
		this.title_ = opts.title;
		this.items_ = opts.items;
		this.cursor_ = opts.cursor ?? 0;
		this.footer_ = opts.footer ?? 'up/down navigate  Space toggle  Enter confirm  Esc cancel';
	}

	handleInput(data: string): void {
		const kb = getKeybindings();

		if (kb.matches(data, 'tui.select.up') || matchesKey(data, 'up')) {
			this.cursor_ = Math.max(0, this.cursor_ - 1);
			this.tui_.requestRender();
			return;
		}

		if (kb.matches(data, 'tui.select.down') || matchesKey(data, 'down')) {
			this.cursor_ = Math.min(this.items_.length - 1, this.cursor_ + 1);
			this.tui_.requestRender();
			return;
		}

		if (matchesKey(data, 'space')) {
			this.items_[this.cursor_].selected = !this.items_[this.cursor_].selected;
			this.tui_.requestRender();
			return;
		}

		if (matchesKey(data, 'enter')) {
			const selected = this.items_.filter((it) => it.selected).map((it) => it.id);
			this.done_(selected.length > 0 ? selected : null);
			return;
		}

		if (matchesKey(data, 'escape')) {
			this.done_(null);
		}
	}

	render(width: number): string[] {
		const th = this.theme_;
		const lines: string[] = [];

		lines.push(truncateToWidth(th.fg('accent', th.bold(this.title_)), width));
		lines.push(truncateToWidth(th.fg('dim', '\u2500'.repeat(width)), width));

		for (let i = 0; i < this.items_.length; i++) {
			const item = this.items_[i];
			const arrow = i === this.cursor_ ? th.fg('accent', '>') : ' ';
			const check = item.selected ? th.fg('accent', '[x]') : th.fg('dim', '[ ]');
			const paddedLabel = item.label + ' '.repeat(Math.max(0, 17 - visibleWidth(item.label)));
			const hintText = th.fg('dim', item.hint);

			lines.push(truncateToWidth(` ${arrow} ${check} ${paddedLabel} ${hintText}`, width));
		}

		lines.push(truncateToWidth(th.fg('dim', '\u2500'.repeat(width)), width));
		lines.push(truncateToWidth(th.fg('dim', this.footer_), width));

		return lines;
	}

	invalidate(): void {}
}

// ═══════════════════════════════════════════
// 自定义路径输入面板
// ═══════════════════════════════════════════

class CustomPathsInput {
	private tui_: { requestRender: () => void };
	private theme_: any;
	private done_: (v: string | null) => void;
	private input_: string;

	constructor(opts: {
		tui: { requestRender: () => void };
		theme: any;
		done: (v: string | null) => void;
	}) {
		this.tui_ = opts.tui;
		this.theme_ = opts.theme;
		this.done_ = opts.done;
		this.input_ = '';
	}

	handleInput(data: string): void {
		if (matchesKey(data, 'enter')) {
			this.done_(this.input_.trim() || null);
			return;
		}
		if (matchesKey(data, 'escape')) {
			this.done_(null);
			return;
		}
		if (data === '\x7F' || data === '\b') {
			this.input_ = this.input_.slice(0, -1);
			this.tui_.requestRender();
		} else if (data.length === 1 && data >= ' ') {
			this.input_ += data;
			this.tui_.requestRender();
		}
	}

	render(width: number): string[] {
		const th = this.theme_;
		const lines: string[] = [];

		lines.push(truncateToWidth(th.fg('accent', th.bold('Custom symlink paths')), width));
		lines.push(truncateToWidth(th.fg('dim', '\u2500'.repeat(width)), width));
		lines.push(
			truncateToWidth(
				th.fg('dim', 'Enter paths relative to repo root. Separate multiple with ;'),
				width,
			),
		);
		lines.push(truncateToWidth(th.fg('dim', ''), width));
		lines.push(truncateToWidth(th.fg('dim', 'Examples:'), width));
		lines.push(truncateToWidth(th.fg('dim', '  .venv;public/assets'), width));
		lines.push(truncateToWidth(th.fg('dim', '  .mypy_cache;.pytest_cache'), width));
		lines.push(truncateToWidth(th.fg('dim', '  storage/cache;uploads'), width));
		lines.push(truncateToWidth(th.fg('dim', '\u2500'.repeat(width)), width));
		lines.push(truncateToWidth(` ${th.fg('accent', '>')} ${this.input_}`, width));
		lines.push(truncateToWidth(th.fg('dim', '\u2500'.repeat(width)), width));
		lines.push(truncateToWidth(th.fg('dim', '[Enter] confirm  [Esc] skip / cancel'), width));

		return lines;
	}

	invalidate(): void {}
}

// ═══════════════════════════════════════════
// node_modules 策略（内部）
// ═══════════════════════════════════════════

// ═══════════════════════════════════════════
// 合并策略选择
// ═══════════════════════════════════════════

export async function askMergeStrategy(ctx: any): Promise<'merge' | 'squash' | 'rebase-ff' | null> {
	const options: Array<{ value: 'merge' | 'squash' | 'rebase-ff'; label: string }> = [
		{ value: 'merge', label: 'Merge -- preserve branch history (merge commit)' },
		{ value: 'squash', label: 'Squash -- single commit, linear history' },
		{ value: 'rebase-ff', label: 'Rebase + ff -- linear, no merge commit' },
	];

	return (ctx.ui.custom as <T>(cb: (...a: any[]) => any) => Promise<T>)<
		'merge' | 'squash' | 'rebase-ff'
	>((tui, theme, _kb, done) => {
		const selector = new ListSelector({
			tui,
			theme,
			done,
			title: 'Merge strategy',
			options,
			footer: 'up/down navigate  Enter confirm  Esc cancel',
		});
		return {
			render: (w: number) => selector.render(w),
			handleInput: (d: string) => selector.handleInput(d),
			invalidate: () => selector.invalidate(),
		};
	});
}

export async function askNodeModulesStrategy(
	ctx: any,
	lastStrategy: NodeModulesStrategy,
): Promise<NodeModulesStrategy | null> {
	if (!ctx.hasUI) return lastStrategy;

	const strategies: NodeModulesStrategy[] = ['symlink', 'copy', 'install', 'none'];
	const cursorIdx = strategies.indexOf(lastStrategy);

	const options = strategies.map((s) => ({
		value: s,
		label: STRATEGY_LABELS[s],
	}));

	return (
		ctx.ui.custom as <T>(cb: (...a: any[]) => any) => Promise<T>
	)<NodeModulesStrategy | null>((tui, theme, _kb, done) => {
		const selector = new ListSelector({
			tui,
			theme,
			done: (v) => {
				if (v) setLastNodeModulesStrategy(v as NodeModulesStrategy);
				done(v);
			},
			title: 'node_modules strategy',
			options,
			cursor: cursorIdx >= 0 ? cursorIdx : 0,
		});
		return {
			render: (w: number) => selector.render(w),
			handleInput: (d: string) => selector.handleInput(d),
			invalidate: () => selector.invalidate(),
		};
	});
}

// ═══════════════════════════════════════════
// 软链接目标多选面板（顶层入口）
// ═══════════════════════════════════════════

/**
 * 弹出软链接目标多选面板，返回用户选择或 null（取消）。
 *
 * 流程：
 *  1. 多选面板（预设 + 「其他」）
 *  2. 若「其他」选中 → 自定义路径输入
 *  3. 若 node_modules 选中 → 策略选择
 */
export async function askSymlinkTargetsPanel(ctx: any): Promise<SymlinkSelections | null> {
	if (!ctx.hasUI) {
		// 非 TUI 模式：使用已保存的偏好
		const lastIds = getLastSymlinkTargetIds();
		const targets = PRESET_SYMLINK_TARGETS.filter((t) => lastIds.includes(t.id));
		const nmStrat = getLastNodeModulesStrategy();
		return {
			targets,
			customPaths: [],
			nodeModulesStrategy: nmStrat,
		};
	}

	// 恢复上次选择
	const lastIds = getLastSymlinkTargetIds();

	const items: MultiSelectItem[] = [
		...PRESET_SYMLINK_TARGETS.map((t) => ({
			id: t.id,
			label: t.label,
			hint: t.hint,
			selected: lastIds.includes(t.id),
		})),
		{
			id: '__other__',
			label: 'Other...',
			hint: 'Custom paths',
			selected: lastIds.includes('__other__'),
		},
	];

	// 步骤 1: 多选面板
	const selectedIds = await (ctx.ui.custom as <T>(cb: (...a: any[]) => any) => Promise<T>)<
		string[] | null
	>((tui, theme, _kb, done) => {
		const panel = new MultiSelectPanel({
			tui,
			theme,
			done,
			title: 'Symlink to worktree',
			items,
		});
		return {
			render: (w: number) => panel.render(w),
			handleInput: (d: string) => panel.handleInput(d),
			invalidate: () => panel.invalidate(),
		};
	});

	if (selectedIds === null) return null;

	// 保存选择（不持久化 __other__—避免每次创建都弹自定义路径输入）
	setLastSymlinkTargetIds(selectedIds.filter((id) => id !== '__other__'));

	// 解析选中项
	const presetTargets = PRESET_SYMLINK_TARGETS.filter((t) => selectedIds.includes(t.id));
	const hasOther = selectedIds.includes('__other__');

	// 步骤 2: 「其他」自定义路径
	let customPaths: string[] = [];
	if (hasOther) {
		const rawInput = await (ctx.ui.custom as <T>(cb: (...a: any[]) => any) => Promise<T>)<
			string | null
		>((tui, theme, _kb, done) => {
			const input = new CustomPathsInput({ tui, theme, done });
			return {
				render: (w: number) => input.render(w),
				handleInput: (d: string) => input.handleInput(d),
				invalidate: () => input.invalidate(),
			};
		});

		if (rawInput === null) return null; // 取消
		customPaths = rawInput
			.split(';')
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
	}

	// 步骤 3: node_modules 策略
	const hasNodeModules = presetTargets.some((t) => t.id === 'node_modules');
	let nodeModulesStrategy: NodeModulesStrategy = getLastNodeModulesStrategy();
	if (hasNodeModules) {
		const strategy = await askNodeModulesStrategy(ctx, nodeModulesStrategy);
		if (strategy === null) return null;
		nodeModulesStrategy = strategy;
	}

	return {
		targets: presetTargets,
		customPaths,
		nodeModulesStrategy,
	};
}

// ═══════════════════════════════════════════
// Rebase+ff 确认面板
// ═══════════════════════════════════════════

/**
 * rebase+ff 确认弹窗。警告用户 worktree 文件将被重写。
 */
export async function confirmRebaseFF(
	ctx: any,
	sourceName: string,
	sourceBranch: string,
	targetBranch: string,
): Promise<boolean> {
	if (!ctx.hasUI) return true;
	return (ctx.ui.custom as <T>(cb: (...a: any[]) => any) => Promise<T>)<boolean>(
		(_tui, theme, _kb, done) => ({
			render(w: number): string[] {
				const lines: string[] = [];
				lines.push(
					truncateToWidth(theme.fg('warning', theme.bold(' Rebase + fast-forward')), w),
				);
				lines.push(truncateToWidth(theme.fg('dim', '─'.repeat(w)), w));
				lines.push(
					truncateToWidth(
						theme.fg('text', ` Rebase '${sourceBranch}' -> '${targetBranch}'`),
						w,
					),
				);
				lines.push(truncateToWidth(theme.fg('dim', ''), w));
				lines.push(
					truncateToWidth(
						theme.fg(
							'warning',
							' Files in worktree "' + sourceName + '" will be rewritten!',
						),
						w,
					),
				);
				lines.push(
					truncateToWidth(
						theme.fg(
							'warning',
							' Open files will show changes; uncommitted work will abort.',
						),
						w,
					),
				);
				lines.push(truncateToWidth(theme.fg('dim', '─'.repeat(w)), w));
				lines.push(truncateToWidth(` ${theme.fg('accent', '[y]')} Proceed with rebase`, w));
				lines.push(truncateToWidth(` ${theme.fg('dim', '[n/esc]')} Cancel`, w));
				return lines;
			},
			handleInput(data: string): void {
				if (data === 'y' || data === 'Y' || matchesKey(data, 'enter')) {
					done(true);
					return;
				}
				if (data === 'n' || data === 'N' || matchesKey(data, 'escape')) {
					done(false);
					return;
				}
			},
			invalidate(): void {},
		}),
	);
}

// ═══════════════════════════════════════════
// 删除确认
// ═══════════════════════════════════════════

export async function confirmDelete(ctx: any, name: string): Promise<boolean> {
	if (!ctx.hasUI) return true;
	return (ctx.ui.custom as <T>(cb: (...a: any[]) => any) => Promise<T>)<boolean>(
		(_tui, theme, _kb, done) => ({
			render(w: number): string[] {
				const lines: string[] = [];
				lines.push(
					truncateToWidth(
						theme.fg('warning', theme.bold(` Delete worktree "${name}"?`)),
						w,
					),
				);
				lines.push(truncateToWidth(theme.fg('dim', '─'.repeat(w)), w));
				lines.push(truncateToWidth(` ${theme.fg('accent', '[y]')} Yes, delete it`, w));
				lines.push(truncateToWidth(` ${theme.fg('dim', '[n/esc]')} Cancel`, w));
				lines.push(truncateToWidth(theme.fg('dim', '─'.repeat(w)), w));
				lines.push(
					truncateToWidth(
						theme.fg('dim', 'Removes the worktree directory and deletes branch.'),
						w,
					),
				);
				lines.push(
					truncateToWidth(
						theme.fg('warning', 'Session history (if any) is NOT deleted.'),
						w,
					),
				);
				lines.push(truncateToWidth(theme.fg('dim', 'To clean up session files:'), w));
				lines.push(
					truncateToWidth(
						theme.fg('dim', '  ~/.pi/agent/sessions/--<worktree-path>--/'),
						w,
					),
				);
				return lines;
			},
			handleInput(data: string): void {
				if (data === 'y' || data === 'Y' || matchesKey(data, 'enter')) {
					done(true);
					return;
				}
				if (data === 'n' || data === 'N' || matchesKey(data, 'escape')) {
					done(false);
					return;
				}
			},
			invalidate(): void {},
		}),
	);
}

// ═══════════════════════════════════════════
// 强制删除确认
// ═══════════════════════════════════════════

export async function confirmForceDelete(
	ctx: any,
	name: string,
	dirtyPreview: string,
): Promise<boolean> {
	if (!ctx.hasUI) return true;
	return (ctx.ui.custom as <T>(cb: (...a: any[]) => any) => Promise<T>)<boolean>(
		(_tui, theme, _kb, done) => ({
			render(w: number): string[] {
				const lines: string[] = [];
				lines.push(
					truncateToWidth(theme.fg('warning', theme.bold(` Force delete "${name}"?`)), w),
				);
				lines.push(truncateToWidth(theme.fg('dim', '─'.repeat(w)), w));
				lines.push(
					truncateToWidth(
						theme.fg('error', ' Git refused — worktree has uncommitted files:'),
						w,
					),
				);
				dirtyPreview
					.split('\n')
					.slice(0, 5)
					.forEach((l) => {
						lines.push(truncateToWidth(`   ${theme.fg('dim', l)}`, w));
					});
				lines.push(truncateToWidth(theme.fg('dim', '─'.repeat(w)), w));
				lines.push(
					truncateToWidth(
						` ${theme.fg('error', '[y]')} Force remove — discards ALL uncommitted/untracked changes`,
						w,
					),
				);
				lines.push(truncateToWidth(` ${theme.fg('dim', '[n/esc]')} Cancel`, w));
				lines.push(truncateToWidth(theme.fg('dim', '─'.repeat(w)), w));
				lines.push(
					truncateToWidth(
						theme.fg('dim', 'Session history (~/.pi/agent/sessions/) is NOT affected.'),
						w,
					),
				);
				return lines;
			},
			handleInput(data: string): void {
				if (data === 'y' || data === 'Y' || matchesKey(data, 'enter')) {
					done(true);
					return;
				}
				if (data === 'n' || data === 'N' || matchesKey(data, 'escape')) {
					done(false);
					return;
				}
			},
			invalidate(): void {},
		}),
	);
}

// ═══════════════════════════════════════════
// 分支删除询问
// ═══════════════════════════════════════════

export async function askBranchDelete(
	ctx: any,
	name: string,
	unmerged: boolean,
): Promise<'delete' | 'keep' | 'cancel'> {
	if (!ctx.hasUI) return unmerged ? 'keep' : 'delete';
	if (!unmerged) return 'delete';

	const options = [
		{ value: 'delete', label: 'Force delete branch (commits may be lost)' },
		{ value: 'keep', label: 'Keep branch (safe)' },
		{ value: 'cancel', label: 'Cancel' },
	];

	return (ctx.ui.custom as <T>(cb: (...a: any[]) => any) => Promise<T>)<
		'delete' | 'keep' | 'cancel'
	>((tui, theme, _kb, done) => {
		const selector = new ListSelector({
			tui,
			theme,
			done,
			title: `Branch wt/${name} has unmerged commits`,
			options,
			cursor: 1,
		});
		return {
			render: (w: number) => selector.render(w),
			handleInput: (d: string) => selector.handleInput(d),
			invalidate: () => selector.invalidate(),
		};
	});
}

// ═══════════════════════════════════════════
// 名称输入
// ═══════════════════════════════════════════

export async function promptWorktreeName(ctx: any): Promise<string | null> {
	if (!ctx.hasUI) return null;
	return (ctx.ui.custom as <T>(cb: (...a: any[]) => any) => Promise<T>)<string | null>(
		(_tui, theme, _kb, done) => {
			let input = '';
			return {
				render(w: number): string[] {
					const lines: string[] = [];
					lines.push(truncateToWidth(theme.bold('Worktree name:'), w));
					lines.push(truncateToWidth(theme.fg('dim', '─'.repeat(w)), w));
					lines.push(truncateToWidth(` ${theme.fg('accent', '>')} ${input}`, w));
					lines.push(truncateToWidth(theme.fg('dim', '─'.repeat(w)), w));
					lines.push(
						truncateToWidth(
							theme.fg(
								'dim',
								'Leave empty for auto-name.  [Enter] confirm  [Esc] cancel',
							),
							w,
						),
					);
					return lines;
				},
				handleInput(data: string): void {
					if (matchesKey(data, 'enter')) {
						done(input.trim() || null);
						return;
					}
					if (matchesKey(data, 'escape')) {
						done(null);
						return;
					}
					if (data === '\x7F' || data === '\b') {
						input = input.slice(0, -1);
						_tui.requestRender();
					} else if (data.length === 1 && data >= ' ') {
						input += data;
						_tui.requestRender();
					}
				},
				invalidate(): void {},
			};
		},
	);
}

// ═══════════════════════════════════════════
// 操作子菜单（Enter 选中 worktree 时弹出）
// ═══════════════════════════════════════════

export interface SubmenuResult {
	action: 'switch' | 'fork' | 'merge' | 'rebase' | 'delete' | 'shell' | 'cancel';
}

interface SubmenuOption {
	value: SubmenuResult['action'];
	label: string;
	key: string;
}

class OperationSubmenu {
	private tui_: { requestRender: () => void };
	private theme_: any;
	private done_: (v: SubmenuResult) => void;
	private options_: SubmenuOption[];
	private cursor_: number;
	private worktreeName_: string;

	constructor(opts: {
		tui: { requestRender: () => void };
		theme: any;
		done: (v: SubmenuResult) => void;
		worktreeName: string;
	}) {
		this.tui_ = opts.tui;
		this.theme_ = opts.theme;
		this.done_ = opts.done;
		this.worktreeName_ = opts.worktreeName;

		this.options_ = [
			{ value: 'switch', label: 'Switch to worktree', key: 'S' },
			{ value: 'fork', label: 'Fork context to worktree', key: 'F' },
			{ value: 'merge', label: 'Merge into main', key: 'M' },
			{ value: 'rebase', label: 'Sync onto main (rebase)', key: 'R' },
			{ value: 'delete', label: 'Delete worktree', key: 'D' },
			{ value: 'shell', label: 'Open shell in worktree', key: 'H' },
			{ value: 'cancel', label: 'Cancel', key: '' },
		];
		this.cursor_ = 0;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();

		if (kb.matches(data, 'tui.select.up') || matchesKey(data, 'up')) {
			this.cursor_ = Math.max(0, this.cursor_ - 1);
			this.tui_.requestRender();
			return;
		}

		if (kb.matches(data, 'tui.select.down') || matchesKey(data, 'down')) {
			this.cursor_ = Math.min(this.options_.length - 1, this.cursor_ + 1);
			this.tui_.requestRender();
			return;
		}

		if (matchesKey(data, 'enter') || matchesKey(data, 'space')) {
			this.done_({ action: this.options_[this.cursor_]?.value ?? 'cancel' });
			return;
		}

		// 快捷键直达
		const lower = data.toLowerCase();
		for (const opt of this.options_) {
			if (lower === opt.key.toLowerCase()) {
				this.done_({ action: opt.value });
				return;
			}
		}

		if (matchesKey(data, 'escape')) {
			this.done_({ action: 'cancel' });
		}
	}

	render(width: number): string[] {
		const th = this.theme_;
		const lines: string[] = [];

		lines.push(
			truncateToWidth(th.fg('accent', th.bold(` Worktree: ${this.worktreeName_}`)), width),
		);
		lines.push(truncateToWidth(th.fg('dim', '─'.repeat(width)), width));

		for (let i = 0; i < this.options_.length; i++) {
			const opt = this.options_[i];
			const arrow = i === this.cursor_ ? th.fg('accent', '>') : ' ';
			const label =
				i === this.cursor_ ? th.fg('accent', opt.label) : th.fg('text', opt.label);
			const keyHint = opt.key ? th.fg('dim', ` [${opt.key}]`) : '';
			lines.push(truncateToWidth(` ${arrow} ${label}${keyHint}`, width));
		}

		lines.push(truncateToWidth(th.fg('dim', '─'.repeat(width)), width));
		lines.push(
			truncateToWidth(
				th.fg('dim', ' up/down navigate  Enter confirm  key shortcut  Esc back'),
				width,
			),
		);

		return lines;
	}

	invalidate(): void {}
}

export async function showOperationSubmenu(ctx: any, worktreeName: string): Promise<SubmenuResult> {
	if (!ctx.hasUI) {
		return { action: 'switch' };
	}

	return (ctx.ui.custom as <T>(cb: (...a: any[]) => any) => Promise<T>)<SubmenuResult>(
		(tui, theme, _kb, done) => {
			const submenu = new OperationSubmenu({
				tui,
				theme,
				done,
				worktreeName,
			});
			return {
				render: (w: number) => submenu.render(w),
				handleInput: (d: string) => submenu.handleInput(d),
				invalidate: () => submenu.invalidate(),
			};
		},
	);
}

// ═══════════════════════════════════════════
// 冲突解决面板（P0-1）
// ═══════════════════════════════════════════

/**
 * 显示 merge/rebase 冲突面板。
 * 提供两个操作：
 *  [L] Launch terminal at worktree
 *  [A] Abort
 */
export interface ConflictPanelAction {
	action: 'agent' | 'shell' | 'abort' | 'stay';
}

export async function showConflictPanel(
	ctx: any,
	conflicts: Array<{ file: string; lines: string }>,
	_repoRoot: string,
	stashMsg?: string,
	variant: 'merge' | 'stash-pop' = 'merge',
): Promise<ConflictPanelAction> {
	if (!ctx.hasUI) return { action: 'stay' };

	const isStashPop = variant === 'stash-pop';

	return (ctx.ui.custom as <T>(cb: (...a: any[]) => any) => Promise<T>)<ConflictPanelAction>(
		(tui, theme, _kb, done) => {
			const options: Array<{ value: ConflictPanelAction['action']; label: string }> =
				isStashPop
					? [
							{ value: 'agent', label: '让 Agent 尝试修复' },
							{ value: 'shell', label: '打开终端自己解决' },
							{ value: 'stay', label: '停留（稍后手动处理）' },
						]
					: [
							{ value: 'agent', label: '让 Agent 尝试修复' },
							{ value: 'shell', label: '打开终端自己解决' },
							{ value: 'abort', label: '中止并回滚' },
							{ value: 'stay', label: '停留（稍后手动处理）' },
						];
			let cursor = 0;

			return {
				render(w: number): string[] {
					const th = theme;
					const lines: string[] = [];
					lines.push(
						truncateToWidth(
							th.fg(
								'error',
								th.bold(isStashPop ? ' 恢复未提交改动时冲突' : ' 检测到合并冲突'),
							),
							w,
						),
					);
					lines.push(truncateToWidth(th.fg('dim', '─'.repeat(w)), w));

					// 冲突文件列表
					lines.push(truncateToWidth(th.fg('warning', ' 冲突文件：'), w));
					const shown = conflicts.slice(0, 10);
					for (const c of shown) {
						lines.push(truncateToWidth(`   ${th.fg('text', c.file)}`, w));
					}
					if (conflicts.length > 10) {
						lines.push(
							truncateToWidth(
								`   ${th.fg('dim', `... 还有 ${conflicts.length - 10} 个`)}`,
								w,
							),
						);
					}

					if (stashMsg) {
						lines.push(truncateToWidth(th.fg('dim', stashMsg), w));
					}

					lines.push(truncateToWidth(th.fg('dim', '─'.repeat(w)), w));
					for (let i = 0; i < options.length; i++) {
						const opt = options[i];
						const arrow = i === cursor ? th.fg('accent', '>') : ' ';
						const label =
							i === cursor ? th.fg('accent', opt.label) : th.fg('text', opt.label);
						lines.push(truncateToWidth(` ${arrow} ${label}`, w));
					}
					lines.push(truncateToWidth(th.fg('dim', '─'.repeat(w)), w));
					lines.push(
						truncateToWidth(th.fg('dim', ' 上下键导航  Enter 确认  Esc 停留'), w),
					);
					return lines;
				},
				handleInput(data: string): void {
					const kb = getKeybindings();
					if (kb.matches(data, 'tui.select.up') || matchesKey(data, 'up')) {
						cursor = Math.max(0, cursor - 1);
						tui.requestRender();
						return;
					}
					if (kb.matches(data, 'tui.select.down') || matchesKey(data, 'down')) {
						cursor = Math.min(options.length - 1, cursor + 1);
						tui.requestRender();
						return;
					}
					if (matchesKey(data, 'enter') || matchesKey(data, 'space')) {
						done({ action: options[cursor].value });
						return;
					}
					if (matchesKey(data, 'escape')) {
						done({ action: 'stay' });
					}
				},
				invalidate(): void {},
			};
		},
	);
}

// ═══════════════════════════════════════════
// 合并/变基后步骤引导（P0-2）
// ═══════════════════════════════════════════

/**
 * 显示 merge/rebase 成功后的检查清单。
 *
 * @param type 'merge' | 'rebase' | 'rebase-ff'
 * @param targetBranch 目标分支名（用于 rebase-ff 的 push 提示，默认 main）
 */
export async function showPostMergeGuide(
	ctx: any,
	_repoRoot: string,
	resultMsg: string,
	type: 'merge' | 'rebase' | 'rebase-ff',
	targetBranch?: string,
): Promise<void> {
	if (!ctx.hasUI) return;

	await (ctx.ui.custom as <T>(cb: (...a: any[]) => any) => Promise<T>)<string | null>(
		(_tui, theme, _kb, done) => ({
			render(w: number): string[] {
				const lines: string[] = [];
				lines.push(truncateToWidth(theme.fg('success', theme.bold(' ' + resultMsg)), w));
				lines.push(truncateToWidth(theme.fg('dim', '─'.repeat(w)), w));
				lines.push(
					truncateToWidth(theme.fg('text', ' Next steps (recommended order):'), w),
				);
				lines.push(truncateToWidth(theme.fg('dim', '  [1] npm run typecheck'), w));
				lines.push(truncateToWidth(theme.fg('dim', '  [2] npm test'), w));
				lines.push(truncateToWidth(theme.fg('dim', '  [3] npm run format:check'), w));
				if (type === 'merge') {
					lines.push(
						truncateToWidth(
							theme.fg('accent', '  [4] git add + git commit (manual)'),
							w,
						),
					);
				} else if (type === 'rebase-ff') {
					const pushBranch = targetBranch || 'main';
					lines.push(
						truncateToWidth(
							theme.fg('accent', `  [4] git push origin ${pushBranch}`),
							w,
						),
					);
				} else {
					lines.push(
						truncateToWidth(
							theme.fg('accent', '  [4] git rebase --continue (if needed)'),
							w,
						),
					);
				}
				lines.push(truncateToWidth(theme.fg('dim', '─'.repeat(w)), w));
				lines.push(
					truncateToWidth(
						theme.fg('dim', ' Check typecheck and tests before committing.'),
						w,
					),
				);
				lines.push(truncateToWidth(theme.fg('dim', ' [Esc] Dismiss'), w));
				return lines;
			},
			handleInput(data: string): void {
				if (matchesKey(data, 'escape')) {
					done(null);
				}
			},
			invalidate(): void {},
		}),
	);
}

// ═══════════════════════════════════════════
// merge 成功后的两选项面板（中文，对齐 OperationSubmenu 交互风格）
// ═══════════════════════════════════════════

export interface MergeSuccessResult {
	action: 'switch' | 'menu' | 'dismiss';
}

/**
 * merge 成功后显示两选项面板：
 *   - 「切换到 <target>」：切到合并目标分支（复用 handleUse）
 *   - 「回到主菜单」：重新进入 WorktreeSwitcherPanel 主列表
 *   - Esc：关闭面板，原地不动（成功合并后已切回合并前的原分支，而非 target）
 *
 * 仅当 merge 从面板触发（fromPanel）时调用；命令触发则直接 notify 一句。
 */
export async function showMergeSuccessPanel(
	ctx: any,
	sourceBranch: string,
	targetBranch: string,
): Promise<MergeSuccessResult> {
	if (!ctx.hasUI) return { action: 'dismiss' };

	return (ctx.ui.custom as <T>(cb: (...a: any[]) => any) => Promise<T>)<MergeSuccessResult>(
		(tui, theme, _kb, done) => {
			const options: Array<{ value: MergeSuccessResult['action']; label: string }> = [
				{ value: 'switch', label: `切换到 ${targetBranch}` },
				{ value: 'menu', label: '回到主菜单' },
			];
			let cursor = 0;

			return {
				render(w: number): string[] {
					const th = theme;
					const lines: string[] = [];
					lines.push(
						truncateToWidth(
							th.fg('success', th.bold(` 已合并 ${sourceBranch} -> ${targetBranch}`)),
							w,
						),
					);
					lines.push(truncateToWidth(th.fg('dim', '─'.repeat(w)), w));
					for (let i = 0; i < options.length; i++) {
						const opt = options[i];
						const arrow = i === cursor ? th.fg('accent', '>') : ' ';
						const label =
							i === cursor ? th.fg('accent', opt.label) : th.fg('text', opt.label);
						lines.push(truncateToWidth(` ${arrow} ${label}`, w));
					}
					lines.push(truncateToWidth(th.fg('dim', '─'.repeat(w)), w));
					lines.push(
						truncateToWidth(th.fg('dim', ' 上下键导航  Enter 确认  Esc 关闭'), w),
					);
					return lines;
				},
				handleInput(data: string): void {
					const kb = getKeybindings();
					if (kb.matches(data, 'tui.select.up') || matchesKey(data, 'up')) {
						cursor = Math.max(0, cursor - 1);
						tui.requestRender();
						return;
					}
					if (kb.matches(data, 'tui.select.down') || matchesKey(data, 'down')) {
						cursor = Math.min(options.length - 1, cursor + 1);
						tui.requestRender();
						return;
					}
					if (matchesKey(data, 'enter') || matchesKey(data, 'space')) {
						done({ action: options[cursor].value });
						return;
					}
					if (matchesKey(data, 'escape')) {
						done({ action: 'dismiss' });
					}
				},
				invalidate(): void {},
			};
		},
	);
}

// ═══════════════════════════════════════════
// 冲突解决内嵌提示词（ticket 10）
// ═══════════════════════════════════════════

/**
 * 内嵌 `resolving-merge-conflicts` 技能的 5 步提示词（中文），
 * 避免 worktree 插件与独立技能运行时耦合。
 *
 * 第 5 步按 merge/rebase 定制：merge 走 `git commit`，rebase 走 `git rebase --continue`
 * （并提醒多轮冲突）。squash 冲突不适用（已回滚，不弹冲突面板）。
 */
export function buildConflictResolvePrompt(opts: {
	strategy: 'merge' | 'rebase' | 'stash-pop';
	sourceBranch: string;
	targetBranch: string;
	conflicts: Array<{ file: string; lines?: string }>;
}): string {
	const finishStep =
		opts.strategy === 'rebase'
			? '继续 rebase：git add 已解决的文件，然后 git rebase --continue，直到所有 commit 都 rebase 完。'
			: opts.strategy === 'stash-pop'
				? '完成修复：git add 所有已解决的文件即可（合并本身已完成，无需 commit——这些只是恢复的未提交改动）。'
				: '完成 merge：git add 所有已解决的文件，然后 git commit。';

	const headline =
		opts.strategy === 'stash-pop'
			? `git 合并已成功（${opts.sourceBranch} -> ${opts.targetBranch}），但恢复你的未提交改动（stash pop）时冲突，请按以下步骤解决：`
			: `当前存在 git ${opts.strategy} 冲突（${opts.sourceBranch} -> ${opts.targetBranch}），请按以下步骤解决：`;

	return [
		headline,
		'',
		'1. 查看当前 git 状态、历史，以及所有冲突文件。',
		'2. 找到每个冲突的主要来源，理解每处改动的原因与原始意图（读 commit message、PR、issue）。',
		'3. 逐个 hunk 解决：尽量保留双方意图；无法兼容时，选择符合本次合并目标的方案并说明取舍；不要发明新行为；只 resolve，不要 --abort。',
		'4. 运行项目的自动化检查（先 typecheck，再 test，再 format），修复合并导致的问题。',
		'5. ' + finishStep,
		'',
		'冲突文件：',
		...opts.conflicts.map((c) => '  - ' + c.file),
	].join('\n');
}
