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
			lines.push(
				truncateToWidth(this.theme.fg('accent', this.theme.bold('Todo Settings')), width),
				'',
			);
			const rendered = this.mainSettings?.render(width) ?? [];
			lines.push(...rendered);
		} else {
			if (!this.widgetSettings) this.buildWidgetSubmenu();
			lines.push(
				truncateToWidth(this.theme.fg('accent', this.theme.bold('Widget Settings')), width),
				truncateToWidth(this.theme.fg('dim', 'Esc to go back'), width),
				'',
			);
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
				label: 'Sort by',
				currentValue: cfg.sortField === 'created-at' ? 'Created time' : 'Title',
				values: ['Created time', 'Title'],
			},
			{
				id: 'sortDirection',
				label: 'Sort direction',
				currentValue: cfg.sortDirection === 'desc' ? 'Descending' : 'Ascending',
				values: ['Descending', 'Ascending'],
			},
			{
				id: 'compactView',
				label: 'Compact list view',
				currentValue: cfg.compactView ? 'Yes' : 'No',
				values: ['Yes', 'No'],
			},
			{
				id: 'widget',
				label: 'Widget settings',
				currentValue: '>',
				submenu: (_value: string, done: (v?: string) => void) => {
					this.mode = 'widget-sub';
					this.widgetSettings = null;
					return this;
				},
			},
		];

		this.mainSettings = new SettingsList(
			items,
			10,
			getSettingsListTheme(),
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
				updates.sortField = newValue === 'Created time' ? 'created-at' : 'title';
				break;
			case 'sortDirection':
				updates.sortDirection = newValue === 'Descending' ? 'desc' : 'asc';
				break;
			case 'compactView':
				updates.compactView = newValue === 'Yes';
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
				label: cfg.widgetShow ? 'Show widget' : 'Hide widget',
				description: 'Toggle widget visibility',
			},
			{
				value: 'widgetScope',
				label: `Scope: ${cfg.widgetScope}`,
				description: 'Session | Project | Global',
			},
			{
				value: 'widgetDisplay',
				label: `Display: ${cfg.widgetDisplay}`,
				description: 'Summary | Details',
			},
			{
				value: 'widgetFilter',
				label: `Filter: ${cfg.widgetFilter === 'pending-only' ? 'Pending only' : 'All'}`,
				description: 'Show all items or only pending',
			},
		];

		const cycleValues: Record<string, string[]> = {
			widgetShow: ['true', 'false'],
			widgetScope: ['session', 'project', 'global'],
			widgetDisplay: ['summary', 'details'],
			widgetFilter: ['pending-only', 'all'],
		};

		const displayLabels: Record<string, (val: string) => string> = {
			widgetShow: (v: string) => (v === 'true' ? 'Show widget' : 'Hide widget'),
			widgetScope: (v: string) => `Scope: ${v}`,
			widgetDisplay: (v: string) => `Display: ${v}`,
			widgetFilter: (v: string) => `Filter: ${v === 'pending-only' ? 'Pending only' : 'All'}`,
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
				widgetFilter:
					key === 'widgetFilter'
						? (newValue as TodoPluginConfig['widgetFilter'])
						: cur.widgetFilter,
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
