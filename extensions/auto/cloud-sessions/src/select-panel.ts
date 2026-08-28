/**
 * selectPanel — cloud-sessions 内联副本。
 *
 * cloud-sessions 有独立 tsconfig（rootDir=src），不能 import src/tui/select-panel.js，
 * 故内联等价实现。与 src/tui/select-panel.ts 保持一致，交互行为一致
 * （↑↓ 导航 / Enter 选择 / Esc 取消 / 滚动上限 / 顶边框 `── title ──` 嵌名）。
 */
import type { Component } from '@earendil-works/pi-tui';
import {
	Container,
	SelectList,
	Text,
	truncateToWidth,
	visibleWidth,
	type SelectItem,
} from '@earendil-works/pi-tui';
import { DynamicBorder } from '@earendil-works/pi-coding-agent';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

export interface SelectPanelOptions {
	/** AbortSignal to programmatically dismiss the dialog. */
	signal?: AbortSignal;
	/** Timeout in milliseconds. Dialog auto-dismisses. */
	timeout?: number;
	/** 面板级描述文案（显示在选项列表上方）。 */
	description?: string;
}

const MAX_VISIBLE = 10;

/** 内联 titleBar（等价 src/tui/helpers.ts 的 TitleBar + topBorder）。 */
function titleBar(title: string, color: (s: string) => string): Component {
	return {
		render(width: number) {
			const inner = `── ${title.trim()} `;
			const safe =
				visibleWidth(inner) > width
					? truncateToWidth(inner, Math.max(2, width), '')
					: inner;
			return [color(safe + '─'.repeat(Math.max(0, width - visibleWidth(safe))))];
		},
		invalidate() {},
	};
}

export async function selectPanel(
	ctx: Pick<ExtensionContext, 'ui'>,
	title: string,
	options: string[],
	opts?: SelectPanelOptions,
): Promise<string | undefined> {
	const items: SelectItem[] = options.map((option) => ({ value: option, label: option }));

	return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
		let closed = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let abortHandler: (() => void) | undefined;

		const finish = (value: string | undefined): void => {
			if (closed) return;
			closed = true;
			if (timer) clearTimeout(timer);
			if (abortHandler) {
				opts?.signal?.removeEventListener('abort', abortHandler);
				abortHandler = undefined;
			}
			done(value);
		};

		const container = new Container();
		container.addChild(titleBar(title, (s) => theme.fg('accent', theme.bold(s))));
		container.addChild(
			new Text(theme.fg('dim', '↑↓ navigate · enter select · esc cancel'), 1, 0),
		);

		const list = new SelectList(items, Math.min(items.length, MAX_VISIBLE), {
			selectedPrefix: (t) => theme.fg('accent', t),
			selectedText: (t) => theme.fg('accent', t),
			description: (t) => theme.fg('muted', t),
			scrollInfo: (t) => theme.fg('dim', t),
			noMatch: (t) => theme.fg('warning', t),
		});
		list.onSelect = (item) => finish(item.value);
		list.onCancel = () => finish(undefined);
		if (opts?.description) {
			container.addChild(new Text(theme.fg('muted', opts.description), 1, 0));
		}
		container.addChild(list);
		container.addChild(new DynamicBorder((s) => theme.fg('accent', s)));

		if (opts?.signal) {
			if (opts.signal.aborted) finish(undefined);
			else {
				abortHandler = () => finish(undefined);
				opts.signal.addEventListener('abort', abortHandler, { once: true });
			}
		}
		if (opts?.timeout) timer = setTimeout(() => finish(undefined), opts.timeout);

		const component: Component & { dispose?(): void } = {
			render: (w) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				list.handleInput(data);
				tui.requestRender();
			},
			dispose: () => {
				if (timer) clearTimeout(timer);
				if (abortHandler) {
					opts?.signal?.removeEventListener('abort', abortHandler);
					abortHandler = undefined;
				}
			},
		};
		return component;
	});
}
