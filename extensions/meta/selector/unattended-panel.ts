/**
 * 豁免运维面板（ADR-0068 D8）
 *
 * `/unattended` 无参打开的终端面板：只做「看清状态 + 救援解除」，不承担开启豁免的入口。
 * 解释放底部信息栏、随选中项动态显示——首屏不铺全部说明。
 *
 * 三条实现约束（改之前先读 ADR-0068 D8）：
 *   1. 本组件**不经过** `showSelect`：armed 时 selector 的闸门会把调用直接跳过，
 *      恰好在最需要救援时打不开面板。
 *   2. 状态每次 render 现读，不缓存快照：disarm 的反馈必须当场可见。
 *   3. 每行都过 `truncateToWidth`，只用单宽字符（ADR-0023）。
 */
import type { Component, Focusable } from '@earendil-works/pi-tui';
import { Key, matchesKey, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { bottomBorder, makeThemeColors, topBorder } from '../../../src/tui/helpers.js';
import {
	UNATTENDED_ACTIONS,
	ownerLabel,
	statusDetailLines,
	type ConfirmGateStatus,
} from './unattended.js';

type ThemeLike = Parameters<typeof makeThemeColors>[0];
type ActionKey = keyof typeof UNATTENDED_ACTIONS;

export interface UnattendedPanelDeps {
	status(): ConfirmGateStatus;
	/** 撤销全部占用，返回被清掉的 owner id */
	disarmAll(): string[];
	notify(message: string, level?: 'info' | 'warning' | 'error'): void;
}

export interface UnattendedPanelOptions {
	theme: ThemeLike;
	deps: UnattendedPanelDeps;
	/** 状态改变后请求重绘（由 `ctx.ui.custom` 注入 `tui.requestRender`） */
	onChange?: () => void;
	onClose?: () => void;
}

const ARMED_ITEMS: readonly ActionKey[] = ['disarm', 'scope', 'close'];
const IDLE_ITEMS: readonly ActionKey[] = ['scope', 'close'];

/**
 * 面板固定总高（docs/tui-design-principles.md §7.3 最小高度填充）。
 * 三视图（menu/confirm/detail）与三态（armed/idle/off）都以它为准，不足补空行。
 * 行数随视图变化 → overlay 高度抖动 → fullscreen 下渲染溢出（UAT 实测：整屏冻结）。
 */
const PANEL_ROWS = 14;

// 按键一律走 matchesKey：终端差异（application cursor mode、Kitty CSI-u 等）会让同一个键
// 产生不同字节序列。UAT 实测：硬编码 '\x1b' 判 Esc 在 Ghostty 下收不到，面板像卡死。
const isEsc = (d: string) => matchesKey(d, Key.escape) || matchesKey(d, Key.esc);
const isEnter = (d: string) => matchesKey(d, Key.enter) || matchesKey(d, Key.return);
const isUp = (d: string) => matchesKey(d, Key.up);
const isDown = (d: string) => matchesKey(d, Key.down);
const isCtrlC = (d: string) => matchesKey(d, Key.ctrl('c'));

export class UnattendedPanel implements Component, Focusable {
	focused = false;

	private view: 'menu' | 'confirm' | 'detail' = 'menu';
	private index = 0;
	private confirmIndex = 0;

	private readonly colors: ReturnType<typeof makeThemeColors>;
	private readonly deps: UnattendedPanelDeps;
	private readonly onChange?: () => void;
	private readonly onClose?: () => void;

	constructor(opts: UnattendedPanelOptions) {
		this.colors = makeThemeColors(opts.theme);
		this.deps = opts.deps;
		this.onChange = opts.onChange;
		this.onClose = opts.onClose;
	}

	private items(): readonly ActionKey[] {
		return this.deps.status().mode === 'armed' ? ARMED_ITEMS : IDLE_ITEMS;
	}

	render(width: number): string[] {
		const w = Math.max(4, width);
		const c = this.colors;
		const lines: string[] = [];
		// overlay 模式下面板必须自己填满整行，否则底层文本会从两侧透出来
		const add = (line: string) => {
			const cut = truncateToWidth(line, w);
			lines.push(cut + ' '.repeat(Math.max(0, w - visibleWidth(cut))));
		};
		const row = (content: string) => add('  ' + content);
		const status = this.deps.status();

		add(c.cyan(topBorder('── 豁免运维面 / unattended ', w)));
		row(`${c.dim('状态')}  ${status.mode} · ${status.license ? '许可已授予' : '未授权'}`);
		row(`${c.dim('占用')}  ${this.occupancy(status)}`);

		if (this.view === 'confirm') {
			add('');
			this.renderConfirm(add, row, status, w);
		} else if (this.view === 'detail') {
			add('');
			const copy = this.infoCopy(status);
			row(c.cyan(copy.label));
			add(c.dim(bottomBorder(w)));
			for (const line of copy.lines) row(c.gray(line));
		} else {
			add('');
			this.renderMenu(row);
			add(c.dim(bottomBorder(w)));
			this.renderInfo(row, status);
		}

		add(c.dim(bottomBorder(w)));
		add(c.dim(`  ${this.hint()}`));

		// §7.3 最小高度填充：menu/confirm/detail 三个视图行数必须**完全相同**。
		// 行数随视图变化会让 overlay 高度抖动，在 fullscreen（tuiMode 默认）下造成渲染溢出，
		// UAT 实测表现为整个界面冻结、连 Ctrl+C 都无响应。
		while (lines.length < PANEL_ROWS) add('');
		return lines;
	}

	private hint(): string {
		if (this.view === 'detail') return 'Esc 返回';
		if (this.view === 'confirm') return '↑↓ 选择 · Enter 确认 · Esc 返回';
		return '↑↓ 选择 · Enter 继续 · Esc 关闭';
	}

	private occupancy(status: ConfirmGateStatus): string {
		if (status.owners.length === 0) return '无';
		return status.owners
			.map((owner) => `${ownerLabel(owner)} x${status.counts[owner] ?? 1}`)
			.join(' · ');
	}

	private renderMenu(row: (s: string) => void): void {
		const c = this.colors;
		const items = this.items();
		this.index = Math.min(this.index, items.length - 1);
		for (let i = 0; i < items.length; i++) {
			const label = UNATTENDED_ACTIONS[items[i]].label;
			if (i === this.index) row(c.cyan(`> ${label}`));
			else row(`  ${label}`);
		}
	}

	private infoCopy(status: ConfirmGateStatus): { label: string; lines: readonly string[] } {
		const key = this.items()[this.index];
		if (key === 'scope' && status.mode === 'off') {
			return { label: '如何开启', lines: statusDetailLines(status) };
		}
		return UNATTENDED_ACTIONS[key];
	}

	private renderInfo(row: (s: string) => void, status: ConfirmGateStatus): void {
		const c = this.colors;
		const copy = this.infoCopy(status);
		row(c.cyan(copy.label));
		for (const line of copy.lines) row(c.gray(line));
	}

	private renderConfirm(
		add: (s: string) => void,
		row: (s: string) => void,
		status: ConfirmGateStatus,
		width: number,
	): void {
		const c = this.colors;
		const total = status.owners.reduce((n, o) => n + (status.counts[o] ?? 1), 0);
		// 高度预算（60x20 视口下必须 ≤ 14 行）：计数进标题、owner 压成一行、说明只留 2 行
		add(c.red(topBorder(`── 确认解除豁免 · ${total} 个计数 `, width)));
		row(
			c.dim(
				status.owners
					.map((owner) => `${ownerLabel(owner)} x${status.counts[owner] ?? 1}`)
					.join(' · '),
			),
		);
		row(c.gray(UNATTENDED_ACTIONS.disarm.lines[0]));
		row(c.gray(UNATTENDED_ACTIONS.disarm.lines[1]));

		const options = ['确认解除', '取消'];
		for (let i = 0; i < options.length; i++) {
			if (i === this.confirmIndex) row(c.red(`> ${options[i]}`));
			else row(`  ${options[i]}`);
		}
	}

	handleInput(data: string): void {
		// 逃生通道：Ctrl+C 在任何视图都关面板（终端若把 C-c 送到组件，不能让它「点了没反应」）
		if (isCtrlC(data)) {
			this.onClose?.();
			return;
		}
		if (this.view === 'detail') {
			if (isEsc(data)) {
				this.view = 'menu';
				this.onChange?.();
			}
			return;
		}
		if (this.view === 'confirm') {
			this.handleConfirmInput(data);
			return;
		}
		const items = this.items();
		if (isUp(data)) {
			this.index = (this.index - 1 + items.length) % items.length;
			this.onChange?.();
			return;
		}
		if (isDown(data)) {
			this.index = (this.index + 1) % items.length;
			this.onChange?.();
			return;
		}
		if (isEsc(data)) {
			this.onClose?.();
			return;
		}
		if (!isEnter(data)) return;

		const key = items[this.index];
		if (key === 'disarm') {
			this.view = 'confirm';
			this.confirmIndex = 0;
			this.onChange?.();
			return;
		}
		if (key === 'scope') {
			// 只读项也必须对 Enter 有反应：no-op 会让面板看起来卡死
			this.view = 'detail';
			this.onChange?.();
			return;
		}
		if (key === 'close') {
			this.onClose?.();
			return;
		}
	}

	private handleConfirmInput(data: string): void {
		if (isEsc(data)) {
			this.view = 'menu';
			this.onChange?.();
			return;
		}
		if (isUp(data) || isDown(data)) {
			this.confirmIndex = this.confirmIndex === 0 ? 1 : 0;
			this.onChange?.();
			return;
		}
		if (!isEnter(data)) return;
		if (this.confirmIndex === 1) {
			this.view = 'menu';
			this.onChange?.();
			return;
		}

		const cleared = this.deps.disarmAll();
		this.deps.notify(
			cleared.length > 0
				? `远端豁免已解除（${cleared.join(',')}）`
				: '远端豁免当前未生效，无需解除',
			'info',
		);
		// 解除成功后立即关闭：留在面板上焦点会落到只读项（Enter 无反应），
		// UAT 实测看起来像卡死。notify 文本 + 状态栏消失已足够反馈。
		this.onClose?.();
	}

	invalidate(): void {}
}
