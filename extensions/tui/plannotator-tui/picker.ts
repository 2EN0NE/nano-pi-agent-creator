/**
 * plannotator-tui / picker — 单选 + 输入即过滤的候选集选择器。
 *
 * 四种入口共用同一台选择器，差别只在传进来的候选集（全部文件 / 目录 / 未提交变更 /
 * 某次提交），所以「变更」在这里只是一层过滤，不是另一种交互。
 *
 * 刻意不复用 `files` 扩展的选择器：那台是多选（空格开关）且带 diff 快捷动作，
 * 与本插件「一次只打开一个路径」的约束相反。
 */

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { DynamicBorder } from '@earendil-works/pi-coding-agent';
import {
	Container,
	fuzzyFilter,
	Input,
	SelectList,
	Spacer,
	Text,
	type SelectItem,
} from '@earendil-works/pi-tui';
import { TitleBar } from '../../../src/tui/helpers.js';
import type { FileCandidate } from './git.js';

/** 一级列表滚动上限，对齐仓库其他选择面板（ADR-0023 / TUI 规范）。 */
const MAX_VISIBLE = 10;

/** 候选集 → SelectItem。`value` 用下标，避免同名路径互相覆盖。 */
function toItems(candidates: FileCandidate[]): SelectItem[] {
	return candidates.map((candidate, index) => ({
		value: String(index),
		label: candidate.isDirectory
			? candidate.display
			: `${candidate.status ? `[${candidate.status}] ` : ''}${candidate.display}`,
	}));
}

/**
 * 打开选择器，返回被选中的候选；`Esc` 返回 `null`。
 * 调用方负责「候选集为空」的提示，本函数不在空集上开面板。
 */
export async function pickCandidate(
	ctx: ExtensionContext,
	title: string,
	candidates: FileCandidate[],
): Promise<FileCandidate | null> {
	const items = toItems(candidates);

	return ctx.ui.custom<FileCandidate | null>((tui, theme, keybindings, done) => {
		const container = new Container();
		container.addChild(new TitleBar(title, (text) => theme.fg('accent', theme.bold(text))));

		const search = new Input();
		container.addChild(search);
		container.addChild(new Spacer(1));

		const listContainer = new Container();
		container.addChild(listContainer);
		container.addChild(new Text(theme.fg('dim', '输入过滤 · enter 打开 · esc 取消'), 1, 0));
		container.addChild(new DynamicBorder((text) => theme.fg('accent', text)));

		let filtered: SelectItem[] = items;
		let list: SelectList | null = null;

		const paint = () => {
			listContainer.clear();
			if (filtered.length === 0) {
				list = null;
				listContainer.addChild(new Text(theme.fg('warning', '  No matching files'), 0, 0));
				return;
			}
			const selection = new SelectList(filtered, Math.min(filtered.length, MAX_VISIBLE), {
				selectedPrefix: (text) => theme.fg('accent', text),
				selectedText: (text) => theme.fg('accent', text),
				description: (text) => theme.fg('muted', text),
				scrollInfo: (text) => theme.fg('dim', text),
				noMatch: (text) => theme.fg('warning', text),
			});
			selection.onSelect = (item) => done(candidates[Number(item.value)] ?? null);
			selection.onCancel = () => done(null);
			list = selection;
			listContainer.addChild(selection);
		};

		const applyFilter = () => {
			const query = search.getValue();
			filtered = query ? fuzzyFilter(items, query, (item) => item.label) : items;
			paint();
		};

		paint();

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				if (
					keybindings.matches(data, 'tui.select.up') ||
					keybindings.matches(data, 'tui.select.down') ||
					keybindings.matches(data, 'tui.select.confirm') ||
					keybindings.matches(data, 'tui.select.cancel')
				) {
					if (list) {
						list.handleInput(data);
					} else if (keybindings.matches(data, 'tui.select.cancel')) {
						done(null);
					}
					tui.requestRender();
					return;
				}
				search.handleInput(data);
				applyFilter();
				tui.requestRender();
			},
		};
	});
}
