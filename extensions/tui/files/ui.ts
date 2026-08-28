/**
 * Files Extension — TUI Components
 *
 * 文件选择器、操作选择器、diff 面板、变更列表展示等 UI 组件。
 */

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { DynamicBorder } from '@earendil-works/pi-coding-agent';
import { TitleBar } from '../../../src/tui/helpers.js';
import {
	Container,
	fuzzyFilter,
	Input,
	matchesKey,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
	truncateToWidth,
} from '@earendil-works/pi-tui';
import { createLogger } from '@zenone/pi-logger';
import type { ChangeRecord, FileEntry } from './types.js';

const log = createLogger('files:ui');

// ── TUI Offline Toggle ─────────────────────────────────────────────────────

export const toggleTuiOffline = { set: (_v: boolean) => {} };

// ── Build Select Items ─────────────────────────────────────────────────────

export const buildSelectItems = (files: FileEntry[], selectedPaths: Set<string>): SelectItem[] =>
	files.map((file) => {
		const checkbox = selectedPaths.has(file.canonicalPath) ? '[x] ' : '[ ] ';
		const directoryLabel = file.isDirectory ? ' [directory]' : '';
		const statusSuffix = file.status ? ` [${file.status}]` : '';
		return {
			value: file.canonicalPath,
			label: `${checkbox}${file.displayPath}${directoryLabel}${statusSuffix}`,
		};
	});

// ── Action Selector ────────────────────────────────────────────────────────

export const showActionSelector = async (
	ctx: ExtensionContext,
	options: {
		canQuickLook: boolean;
		canEdit: boolean;
		canViewChanges: boolean;
		canFileDiff: boolean;
	},
): Promise<
	'reveal' | 'quicklook' | 'open' | 'edit' | 'addToPrompt' | 'viewChanges' | 'fileDiff' | null
> => {
	const actions: SelectItem[] = [
		...(options.canViewChanges
			? [{ value: 'viewChanges' as const, label: '查看 git 变更' }]
			: []),
		...(options.canFileDiff ? [{ value: 'fileDiff' as const, label: '进行 diff 对比' }] : []),
		{ value: 'reveal' as const, label: '在 Finder 中显示' },
		{ value: 'open' as const, label: '打开' },
		{ value: 'addToPrompt' as const, label: '添加到提示词' },
		...(options.canQuickLook
			? [{ value: 'quicklook' as const, label: 'Quick Look 预览' }]
			: []),
		...(options.canEdit ? [{ value: 'edit' as const, label: '编辑' }] : []),
	];

	const picked = await ctx.ui.custom<
		'reveal' | 'quicklook' | 'open' | 'edit' | 'addToPrompt' | 'viewChanges' | 'fileDiff' | null
	>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(
			new TitleBar('Choose action', (str: string) => theme.fg('accent', theme.bold(str))),
		);

		const selectList = new SelectList(actions, actions.length, {
			selectedPrefix: (text) => theme.fg('accent', text),
			selectedText: (text) => theme.fg('accent', text),
			description: (text) => theme.fg('muted', text),
			scrollInfo: (text) => theme.fg('dim', text),
			noMatch: (text) => theme.fg('warning', text),
		});

		selectList.onSelect = (item) => done(item.value as any);
		selectList.onCancel = () => done(null);

		container.addChild(selectList);
		container.addChild(new Text(theme.fg('dim', '按 Enter 确认或 Esc 取消')));
		container.addChild(new DynamicBorder((str) => theme.fg('accent', str)));

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});

	return picked;
};

// ── File Selector ──────────────────────────────────────────────────────────

export const showFileSelector = async (
	ctx: ExtensionContext,
	files: FileEntry[],
	selectedPath?: string | null,
	gitRoots: string[] = [],
): Promise<{ selected: FileEntry[]; quickAction: 'diff' | null }> => {
	const selectedPaths = new Set<string>();
	const allItems = buildSelectItems(files, selectedPaths);

	let quickAction: 'diff' | null = null;
	const selectionResult = await ctx.ui.custom<string[] | null>(
		(tui, theme, keybindings, done) => {
			const container = new Container();
			container.addChild(
				new TitleBar('选择文件', (str: string) => theme.fg('accent', theme.bold(str))),
			);

			const searchInput = new Input();
			container.addChild(searchInput);
			container.addChild(new Spacer(1));

			const listContainer = new Container();
			container.addChild(listContainer);
			container.addChild(
				new Text(
					theme.fg(
						'dim',
						'输入过滤 \u2022 空格开关 \u2022 enter 确认 \u2022 ctrl+shift+d 差异 \u2022 esc 取消',
					),
					0,
					0,
				),
			);
			container.addChild(new DynamicBorder((str) => theme.fg('accent', str)));

			let filteredItems = allItems;
			let selectList: SelectList | null = null;

			const updateList = () => {
				listContainer.clear();
				if (filteredItems.length === 0) {
					listContainer.addChild(
						new Text(theme.fg('warning', '  No matching files'), 0, 0),
					);
					selectList = null;
					return;
				}

				selectList = new SelectList(filteredItems, Math.min(filteredItems.length, 12), {
					selectedPrefix: (text) => theme.fg('accent', text),
					selectedText: (text) => theme.fg('accent', text),
					description: (text) => theme.fg('muted', text),
					scrollInfo: (text) => theme.fg('dim', text),
					noMatch: (text) => theme.fg('warning', text),
				});

				if (selectedPath && !selectedPaths.size) {
					const index = filteredItems.findIndex((item) => item.value === selectedPath);
					if (index >= 0) {
						selectList.setSelectedIndex(index);
					}
				}

				selectList.onSelect = () => {
					const values =
						selectedPaths.size > 0
							? Array.from(selectedPaths)
							: selectList?.getSelectedItem()
								? [selectList.getSelectedItem()!.value]
								: [];
					done(values);
				};
				selectList.onCancel = () => done(null);

				listContainer.addChild(selectList);
			};

			const applyFilter = () => {
				const query = searchInput.getValue();
				const currentItems = buildSelectItems(files, selectedPaths);
				filteredItems = query
					? fuzzyFilter(
							currentItems,
							query,
							(item) => `${item.label} ${item.value} ${item.description ?? ''}`,
						)
					: currentItems;
				updateList();
			};

			applyFilter();

			return {
				render(width: number) {
					return container.render(width);
				},
				invalidate() {
					container.invalidate();
				},
				handleInput(data: string) {
					if (data === ' ') {
						const focused = selectList?.getSelectedItem();
						if (focused) {
							const wasSelected = selectedPaths.has(focused.value);
							if (wasSelected) {
								selectedPaths.delete(focused.value);
							} else {
								selectedPaths.add(focused.value);
							}
							log.debug('多选切换', {
								文件: focused.value,
								已选: selectedPaths.size,
							});
							const focusedVal = selectList?.getSelectedItem()?.value;
							applyFilter();
							if (focusedVal && selectList) {
								const newIdx = filteredItems.findIndex(
									(item) => item.value === focusedVal,
								);
								if (newIdx >= 0) {
									selectList.setSelectedIndex(newIdx);
								}
							}
							tui.requestRender();
						}
						return;
					}

					if (matchesKey(data, 'ctrl+shift+d')) {
						const focused = selectList?.getSelectedItem();
						if (focused) {
							const file = files.find(
								(entry) => entry.canonicalPath === focused.value,
							);
							const canDiff =
								file?.isTracked && !file.isDirectory && gitRoots.length > 0;
							if (!canDiff) {
								ctx.ui.notify(
									'Diff is only available for tracked files',
									'warning',
								);
								return;
							}
							quickAction = 'diff';
							done([focused.value]);
							return;
						}
					}

					if (
						keybindings.matches(data, 'tui.select.up') ||
						keybindings.matches(data, 'tui.select.down') ||
						keybindings.matches(data, 'tui.select.confirm') ||
						keybindings.matches(data, 'tui.select.cancel')
					) {
						if (selectList) {
							selectList.handleInput(data);
						} else if (keybindings.matches(data, 'tui.select.cancel')) {
							done(null);
						}
						tui.requestRender();
						return;
					}

					searchInput.handleInput(data);
					applyFilter();
					tui.requestRender();
				},
			};
		},
	);

	const selected = selectionResult
		? selectionResult
				.map((p) => files.find((f) => f.canonicalPath === p))
				.filter((f): f is FileEntry => f !== undefined)
		: [];
	return { selected, quickAction };
};

// ── Diff Display Mode Prompt ───────────────────────────────────────────────

export const promptDiffDisplayMode = async (
	ctx: ExtensionContext,
	inTmux: boolean,
): Promise<'panel' | 'tmux' | null> => {
	if (!ctx.hasUI) return 'panel';

	const options: SelectItem[] = [
		{
			value: 'panel',
			label: 'Pi 原生面板',
			description: '在 pi 的 TUI 面板中显示 diff 文本',
		},
	];
	if (inTmux) {
		options.push({
			value: 'tmux',
			label: 'Tmux 新面板',
			description: '在 tmux 分屏中打开 vimdiff',
		});
	}

	return ctx.ui.custom<'panel' | 'tmux' | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(
			new TitleBar('Diff View', (str: string) => theme.fg('accent', theme.bold(str))),
		);

		const list = new SelectList(options, options.length, {
			selectedPrefix: (text) => theme.fg('accent', text),
			selectedText: (text) => theme.fg('accent', text),
			description: (text) => theme.fg('muted', text),
			scrollInfo: (text) => theme.fg('dim', text),
			noMatch: (text) => theme.fg('warning', text),
		});
		list.onSelect = (item) => done(item.value as 'panel' | 'tmux');
		list.onCancel = () => done(null);

		container.addChild(list);
		container.addChild(new Text(theme.fg('dim', 'enter 确认 \u00b7 esc 取消'), 0, 0));
		container.addChild(new DynamicBorder((str) => theme.fg('accent', str)));

		return {
			render(w: number) {
				return container.render(w);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				list.handleInput(data);
				tui.requestRender();
			},
		};
	});
};

// ── Diff Panel ─────────────────────────────────────────────────────────────

export const showDiffInPiPanel = async (
	ctx: ExtensionContext,
	title: string,
	diffContent: string,
): Promise<void> => {
	return ctx.ui.custom<void>((_tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(
			new TitleBar(title, (str: string) => theme.fg('accent', theme.bold(str))),
		);
		container.addChild(new Spacer(1));

		const lines = diffContent.split('\n');
		const maxLineWidth = 120;
		for (const raw of lines) {
			const line = raw.length > maxLineWidth ? truncateToWidth(raw, maxLineWidth) : raw;
			let styled = line;
			if (line.startsWith('+')) {
				styled = theme.fg('success', line);
			} else if (line.startsWith('-')) {
				styled = theme.fg('error', line);
			} else if (line.startsWith('@@')) {
				styled = theme.fg('warning', line);
			} else if (
				line.startsWith('diff --git') ||
				line.startsWith('---') ||
				line.startsWith('+++')
			) {
				styled = theme.fg('accent', line);
			}
			container.addChild(new Text(styled, 0, 0));
		}

		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg('dim', '按 q 或 esc 关闭'), 0, 0));
		container.addChild(new DynamicBorder((str) => theme.fg('accent', str)));

		return {
			render(w: number) {
				return container.render(w);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				if (data === 'q' || data === 'Escape') {
					done(undefined);
				}
			},
		};
	});
};

// ── Changes Viewer ─────────────────────────────────────────────────────────

export const showChangesUI = async (
	ctx: ExtensionContext,
	changes: ChangeRecord[],
): Promise<void> => {
	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(
			new TitleBar(`变更文件 (${changes.length})`, (str: string) =>
				theme.fg('accent', theme.bold(str)),
			),
		);

		const searchInput = new Input();
		container.addChild(searchInput);
		container.addChild(new Spacer(1));

		const listContainer = new Container();
		container.addChild(listContainer);

		container.addChild(
			new Text(
				theme.fg(
					'dim',
					'输入过滤 \u00b7 enter 显示路径 \u00b7 esc 关闭 \u00b7 /changes cls 清空',
				),
				0,
				0,
			),
		);
		container.addChild(new DynamicBorder((str) => theme.fg('accent', str)));

		const buildItems = () => {
			const query = searchInput.getValue();
			const rawItems = changes.map((c) => {
				const icon =
					c.source === 'write'
						? '\u270f\ufe0f'
						: c.source === 'edit'
							? '\U0001f4dd'
							: c.source === 'bash_result'
								? '\u2699\ufe0f'
								: '\U0001f50d';
				let label = `${icon} ${c.display}`;
				if (c.count > 1) label += ` (x${c.count})`;
				return {
					value: c.path,
					label,
					description: `${c.source}  ${new Date(c.timestamp).toLocaleTimeString()}`,
				};
			});
			return query
				? fuzzyFilter(
						rawItems,
						query,
						(item) => `${item.label} ${item.value} ${item.description}`,
					)
				: rawItems;
		};

		let filtered = buildItems();
		let selectList: SelectList | null = null;

		const updateList = () => {
			listContainer.clear();
			if (filtered.length === 0) {
				listContainer.addChild(new Text(theme.fg('warning', '  无匹配项'), 0, 0));
				selectList = null;
				return;
			}

			const items = filtered.map((item) => ({
				...item,
				label: item.description
					? `${item.label}  ${theme.fg('dim', truncateToWidth(item.description, 30))}`
					: item.label,
			}));

			selectList = new SelectList(items, Math.min(items.length, 15), {
				selectedPrefix: (text) => theme.fg('accent', text),
				selectedText: (text) => theme.fg('accent', text),
				description: (text) => theme.fg('muted', text),
				scrollInfo: (text) => theme.fg('dim', text),
				noMatch: (text) => theme.fg('warning', text),
			});
			selectList.onSelect = () => {
				const item = selectList?.getSelectedItem();
				if (item) {
					done(undefined);
					ctx.ui.notify(item.value, 'info');
				}
			};
			selectList.onCancel = () => done(undefined);
			listContainer.addChild(selectList);
		};
		updateList();

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				if (
					_kb?.matches(data, 'tui.select.up') ||
					_kb?.matches(data, 'tui.select.down') ||
					_kb?.matches(data, 'tui.select.confirm') ||
					_kb?.matches(data, 'tui.select.cancel')
				) {
					if (selectList) selectList.handleInput(data);
					else if (_kb?.matches(data, 'tui.select.cancel')) done(undefined);
					tui.requestRender();
					return;
				}
				searchInput.handleInput(data);
				filtered = buildItems();
				updateList();
				tui.requestRender();
			},
		};
	});
};
