import { type Theme, getSettingsListTheme } from '@earendil-works/pi-coding-agent';
import {
	SelectList,
	SettingsList,
	type Component,
	type SettingItem,
	truncateToWidth,
} from '@earendil-works/pi-tui';
import { getConfig, saveConfig, reloadConfig } from '../config.js';
import type { TodoPluginConfig } from '../types.js';
import { scopeLabel, widgetDisplayLabel } from '../storage.js';

export interface SettingsHandlers {
	onClose: () => void;
}

type SettingsPanelMode = 'main' | 'widget-sub';

/**
 * Settings panel for the todos plugin.
 * Main page: list of setting items.
 * Widget submenu: entrance via Enter on the widget item.
 */
export class SettingsPanel implements Component {
	private mode: SettingsPanelMode = 'main';
	private mainSettings: SettingsList | null = null;
	private widgetSettings: SelectList | null = null;
	private theme: Theme;
	private handlers: SettingsHandlers;

	constructor(theme: Theme, handlers: SettingsHandlers) {
		this.theme = theme;
		this.handlers = handlers;
	}

	handleInput(data: string): void {
		// Esc always exits to caller (calling component or main mode)
		if (data === '\x1b' || data === 'Escape') {
			if (this.mode === 'widget-sub') {
				this.mode = 'main';
				this.mainSettings = null;
				return;
			}
			this.handlers.onClose();
			return;
		}
		if (this.mode === 'main') {
			this.mainSettings?.handleInput(data);
		} else {
			this.widgetSettings?.handleInput(data);
		}
	}

	render(width: number): string[] {
		this.theme;
		const lines: string[] = [];

		if (this.mode === 'main') {
			if (!this.mainSettings) this.buildMainSettings();
			const rendered = this.mainSettings?.render(width) ?? [];
			lines.push(...rendered);
		} else {
			if (!this.widgetSettings) this.buildWidgetSubmenu();
			lines.push(truncateToWidth(this.theme.fg('dim', 'Esc 返回'), width));
			const rendered = this.widgetSettings?.render(width) ?? [];
			lines.push(...rendered);
		}

		return lines;
	}

	invalidate(): void {
		this.mainSettings = null;
		this.widgetSettings = null;
	}

	private buildMainSettings(): void {
		const cfg = getConfig();

		const items: SettingItem[] = [
			{
				id: 'sortField',
				label: '排序字段',
				currentValue: cfg.sortField === 'created-at' ? '创建时间' : '标题',
				values: ['创建时间', '标题'],
			},
			{
				id: 'sortDirection',
				label: '排序方向',
				currentValue: cfg.sortDirection === 'desc' ? '降序' : '升序',
				values: ['降序', '升序'],
			},
			{
				id: 'compactView',
				label: '紧凑列表视图',
				currentValue: cfg.compactView ? '是' : '否',
				values: ['是', '否'],
			},
			{
				id: 'widget',
				label: '组件设置',
				currentValue: '>',
				submenu: (_value: string, _done: (v?: string) => void) => {
					this.mode = 'widget-sub';
					this.widgetSettings = null;
					return this;
				},
			},
		];

		// pi-tui 的 SettingsList 内置 hint（"Enter/Space to change · Esc to cancel"）为英文，
		// 通过覆盖 theme.hint 翻译为中文（不改 pi-tui 源码）。
		const listTheme = getSettingsListTheme();
		const localizedTheme = {
			...listTheme,
			hint: (text: string) =>
				listTheme.hint(
					text
						.replace(
							'Type to search · Enter/Space to change · Esc to cancel',
							'输入搜索 · 回车/空格 修改 · Esc 取消',
						)
						.replace(
							'Enter/Space to change · Esc to cancel',
							'回车/空格 修改 · Esc 取消',
						),
				),
		};

		this.mainSettings = new SettingsList(
			items,
			10,
			localizedTheme,
			(id, newValue) => {
				this.handleMainChange(id, newValue);
			},
			() => this.handlers.onClose(),
			{ enableSearch: false },
		);
	}

	private handleMainChange(id: string, newValue: string): void {
		const updates: Partial<TodoPluginConfig> = {};
		switch (id) {
			case 'sortField':
				updates.sortField = newValue === '创建时间' ? 'created-at' : 'title';
				break;
			case 'sortDirection':
				updates.sortDirection = newValue === '降序' ? 'desc' : 'asc';
				break;
			case 'compactView':
				updates.compactView = newValue === '是';
				break;
		}
		if (Object.keys(updates).length > 0) {
			saveConfig(updates);
			reloadConfig();
		}
	}

	private buildWidgetSubmenu(): void {
		const cfg = getConfig();

		const widgetItems: Array<{
			value: string;
			label: string;
			description: string;
		}> = [
			{
				value: 'widgetShow',
				label: cfg.widgetShow ? '显示组件' : '隐藏组件',
				description: '切换组件可见性',
			},
			{
				value: 'widgetScope',
				label: `范围: ${scopeLabel(cfg.widgetScope)}`,
				description: '会话 | 项目 | 全局',
			},
			{
				value: 'widgetDisplay',
				label: `显示: ${widgetDisplayLabel(cfg.widgetDisplay)}`,
				description: '摘要 | 详情',
			},
		];

		const cycleValues: Record<string, string[]> = {
			widgetShow: ['true', 'false'],
			widgetScope: ['session', 'project', 'global'],
			widgetDisplay: ['summary', 'details'],
		};

		const displayLabels: Record<string, (val: string) => string> = {
			widgetShow: (v: string) => (v === 'true' ? '显示组件' : '隐藏组件'),
			widgetScope: (v: string) => `范围: ${scopeLabel(v)}`,
			widgetDisplay: (v: string) => `显示: ${widgetDisplayLabel(v)}`,
		};

		const updateWidgetConfig = (key: string, newValue: string) => {
			const cur = getConfig();
			saveConfig({
				widgetShow: key === 'widgetShow' ? newValue === 'true' : cur.widgetShow,
				widgetScope:
					key === 'widgetScope'
						? (newValue as TodoPluginConfig['widgetScope'])
						: cur.widgetScope,
				widgetDisplay:
					key === 'widgetDisplay'
						? (newValue as TodoPluginConfig['widgetDisplay'])
						: cur.widgetDisplay,
			});
		};

		this.widgetSettings = new SelectList(widgetItems, widgetItems.length, {
			selectedPrefix: (text) => this.theme.fg('accent', text),
			selectedText: (text) => this.theme.fg('accent', text),
			description: (text) => this.theme.fg('muted', text),
			scrollInfo: (text) => this.theme.fg('dim', text),
			noMatch: (text) => this.theme.fg('warning', text),
		});

		this.widgetSettings.onSelect = (item) => {
			const key = item.value;
			const values = cycleValues[key];
			if (!values) return;
			// Read FRESH values each time — not from captured cfg
			const cur = getConfig();
			// SAFETY: getConfig() 返回 TodoPluginConfig，此处按 key 动态读取可选字段；
			// 窄化为 Record 后 String() 包装，缺失字段得 "undefined"，不影响 cycleValues 查找。
			const currentValue = String((cur as unknown as Record<string, unknown>)[key]);
			const idx = values.indexOf(currentValue);
			const nextValue = values[(idx + 1) % values.length];
			const label = displayLabels[key]?.(nextValue) ?? nextValue;
			item.label = label;
			updateWidgetConfig(key, nextValue);
			void (this.widgetSettings as SelectList | null)?.invalidate();
		};

		this.widgetSettings.onCancel = () => {
			this.mode = 'main';
			this.mainSettings = null;
		};
	}
}
