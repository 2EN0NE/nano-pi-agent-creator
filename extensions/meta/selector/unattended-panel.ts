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
import { truncateToWidth } from '@earendil-works/pi-tui';
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

const KEY_UP = '\x1b[A';
const KEY_DOWN = '\x1b[B';
const KEY_ESC = '\x1b';

export class UnattendedPanel implements Component, Focusable {
	focused = false;

	private view: 'menu' | 'confirm' = 'menu';
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
		const add = (line: string) => lines.push(truncateToWidth(line, w));
		const row = (content: string) => add('  ' + content);
		const status = this.deps.status();

		add(c.cyan(topBorder('── 豁免运维面 / unattended ', w)));
		row(`${c.dim('状态')}  ${status.mode} · ${status.license ? '许可已授予' : '未授权'}`);
		row(`${c.dim('占用')}  ${this.occupancy(status)}`);

		if (this.view === 'confirm') {
			add('');
			this.renderConfirm(add, row, status, w);
		} else {
			add('');
			this.renderMenu(row);
			add(c.dim(bottomBorder(w)));
			this.renderInfo(row, status);
		}

		add(c.dim(bottomBorder(w)));
		add(
			c.dim(
				this.view === 'confirm'
					? '  ↑↓ 选择 · Enter 确认 · Esc 返回'
					: '  ↑↓ 选择 · Enter 继续 · Esc 关闭',
			),
		);
		return lines;
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

	private renderInfo(row: (s: string) => void, status: ConfirmGateStatus): void {
		const c = this.colors;
		const key = this.items()[this.index];
		const copy =
			key === 'scope' && status.mode === 'off'
				? { label: '如何开启', lines: statusDetailLines(status) }
				: UNATTENDED_ACTIONS[key];
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
		add(c.red(topBorder('── 确认解除豁免 ', width)));
		const total = status.owners.reduce((n, o) => n + (status.counts[o] ?? 1), 0);
		row(c.dim(`将撤销以下占用（合计 ${total} 个计数）：`));
		for (const owner of status.owners) {
			row(`  ${ownerLabel(owner)}  x${status.counts[owner] ?? 1}`);
		}
		add('');
		for (const line of UNATTENDED_ACTIONS.disarm.lines) row(c.gray(line));
		add('');

		const options = ['确认解除', '取消'];
		for (let i = 0; i < options.length; i++) {
			if (i === this.confirmIndex) row(c.red(`> ${options[i]}`));
			else row(`  ${options[i]}`);
		}
	}

	handleInput(data: string): void {
		if (this.view === 'confirm') {
			this.handleConfirmInput(data);
			return;
		}
		const items = this.items();
		if (data === KEY_UP) {
			this.index = (this.index - 1 + items.length) % items.length;
			this.onChange?.();
			return;
		}
		if (data === KEY_DOWN) {
			this.index = (this.index + 1) % items.length;
			this.onChange?.();
			return;
		}
		if (data === KEY_ESC) {
			this.onClose?.();
			return;
		}
		if (data !== '\r' && data !== '\n') return;

		const key = items[this.index];
		if (key === 'disarm') {
			this.view = 'confirm';
			this.confirmIndex = 0;
			this.onChange?.();
			return;
		}
		if (key === 'close') {
			this.onClose?.();
			return;
		}
		// scope：只读项，解释已在信息栏；Enter 无操作
	}

	private handleConfirmInput(data: string): void {
		if (data === KEY_ESC) {
			this.view = 'menu';
			this.onChange?.();
			return;
		}
		if (data === KEY_UP || data === KEY_DOWN) {
			this.confirmIndex = this.confirmIndex === 0 ? 1 : 0;
			this.onChange?.();
			return;
		}
		if (data !== '\r' && data !== '\n') return;
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
		this.view = 'menu';
		this.index = 0;
		this.onChange?.();
	}

	invalidate(): void {}
}
