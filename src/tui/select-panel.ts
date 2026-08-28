/**
 * selectPanel — 统一的选择面板，替代 ctx.ui.select 的平台内置 frame。
 *
 * 背景：ctx.ui.select 用 pi-mono 内置的 frame()（DynamicBorder 纯横线 + Text 独立标题），
 * 不符合 ADR-0023「── 标题 ── 嵌名」范式，且插件无法改变其样式。本模块用
 * ctx.ui.custom + TitleBar + SelectList 重新实现，接口对齐 ctx.ui.select，
 * 交互行为统一（↑↓ 导航 / Enter 选择 / Esc 取消 / 过滤 / 滚动上限）。
 *
 * 独立于 helpers.ts（用户要求），供所有插件 import。
 */
import type { Component } from '@earendil-works/pi-tui';
import { Container, SelectList, Text, type SelectItem } from '@earendil-works/pi-tui';
import { DynamicBorder } from '@earendil-works/pi-coding-agent';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { TitleBar } from './helpers.js';

export interface SelectPanelOptions {
	/** AbortSignal to programmatically dismiss the dialog. */
	signal?: AbortSignal;
	/** Timeout in milliseconds. Dialog auto-dismisses. */
	timeout?: number;
	/** 面板级描述文案（显示在选项列表上方）。 */
	description?: string;
}

/** 一级列表滚动上限（对齐 files/ui.ts 的 12，略保守取 10）。 */
const MAX_VISIBLE = 10;

/**
 * 显示一个选择面板（顶边框 `── title ──` 嵌名 + SelectList + 底边框纯横线），
 * 返回用户选择的值；Esc / abort / timeout 返回 undefined。
 *
 * @param ctx     含 ui.custom 的上下文（ExtensionContext 或类似）
 * @param title   顶边框标题，**用插件英文名**（如 'Rate Limiter'、'Mode'）
 * @param options 选项列表
 */
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
		container.addChild(new TitleBar(title, (s) => theme.fg('accent', theme.bold(s))));
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
