/**
 * pi-worktree — TUI 组件（切换器面板 + 交互弹窗）
 *
 * 符合 TUI 设计规范：无 emoji、纯文本、truncateToWidth 安全网。
 * 所有面板和弹窗内联渲染（无左右竖边），与 permission-gate 一致。
 *
 * 键盘处理使用 matchesKey() / getKeybindings() 而非 raw escape codes。
 */
import { truncateToWidth, matchesKey, getKeybindings } from '@earendil-works/pi-tui';
import type { ManagedWorktree } from './paths.js';
import type { NodeModulesStrategy } from '../types.js';
import { setLastNodeModulesStrategy } from '../state.js';
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
	action: 'switch' | 'fork' | 'create' | 'delete' | 'merge' | 'shell' | 'quit';
	target?: string;
}

interface WorktreeItem {
	type: 'main' | 'worktree';
	name: string;
	branch: string;
	dirty: number;
	ahead: number;
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
			this.done_({ action: 'switch', target: this.resolveTarget_() });
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
			this.done_({ action: 'shell' });
			return;
		}

		if (data === 'q' || data === 'Q' || matchesKey(data, 'escape')) {
			this.done_({ action: 'quit' });
		}
	}

	render(width: number): string[] {
		const th = this.theme_;
		const lines: string[] = [];

		// 标题
		lines.push(truncateToWidth(th.fg('accent', 'pi-worktree'), width));

		// 分隔
		lines.push(truncateToWidth(th.fg('dim', '─'.repeat(width)), width));

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
			const dirtyStr =
				item.dirty > 0 ? th.fg('warning', `dirty(${item.dirty})`) : th.fg('dim', 'clean');
			const aheadStr = item.ahead > 0 ? th.fg('info', ` +${item.ahead}`) : '';

			lines.push(
				truncateToWidth(
					` ${arrow} ${namePart.padEnd(15)} ${item.branch.padEnd(18)} ${dirtyStr}${aheadStr}`,
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
				{ type: 'main', name: 'main', branch: 'current', dirty: 0, ahead: 0 },
				...allWorktrees.map((wt) => ({
					type: 'worktree' as const,
					name: wt.name,
					branch: wt.branch,
					dirty: getDirtyCount(wt.path),
					ahead: getAheadBehind(repoRoot, wt.branch).ahead,
				})),
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
// node_modules 策略
// ═══════════════════════════════════════════

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
// ═══════════════════════════════════════════
// （widget 已移除，保留此区域供未来 TUI 组件使用）
// ═══════════════════════════════════════════
