import type { Theme } from '@earendil-works/pi-coding-agent';
import { truncateToWidth, type Component } from '@earendil-works/pi-tui';
import type { TabId } from '../types.js';

export interface TabBarOptions {
	theme: Theme;
	activeTab: TabId;
	tabs: Array<{ id: TabId; label: string }>;
	onSwitch: (tab: TabId) => void;
}

/**
 * Custom tab bar component for the todos panel.
 * Renders as a horizontal bar with active tab highlighted.
 * All tabs are always enabled (Global is always available).
 */
export class TabBar implements Component {
	private options: TabBarOptions;

	constructor(options: TabBarOptions) {
		this.options = options;
	}

	setOptions(options: Partial<TabBarOptions>): void {
		Object.assign(this.options, options);
	}

	cycleNext(): void {
		const { tabs, activeTab } = this.options;
		const currentIdx = tabs.findIndex((t) => t.id === activeTab);
		if (currentIdx === -1) return;

		const next = (currentIdx + 1) % tabs.length;
		if (next !== currentIdx) {
			this.options.onSwitch(tabs[next].id);
		}
	}

	cyclePrev(): void {
		const { tabs, activeTab } = this.options;
		const currentIdx = tabs.findIndex((t) => t.id === activeTab);
		if (currentIdx === -1) return;

		const prev = (currentIdx - 1 + tabs.length) % tabs.length;
		if (prev !== currentIdx) {
			this.options.onSwitch(tabs[prev].id);
		}
	}

	render(width: number): string[] {
		const { theme, activeTab, tabs } = this.options;
		const lines: string[] = [];

		// Build tab labels
		const tabParts: string[] = [];
		for (const tab of tabs) {
			const isActive = tab.id === activeTab;

			let label = ` ${tab.label} `;
			if (isActive) {
				label = theme.fg('accent', theme.bold(label));
			} else {
				label = theme.fg('muted', label);
			}

			// Wrap in brackets: active = [Session], inactive = [Session]
			const bracket = isActive ? theme.fg('accent', '[') : theme.fg('dim', '[');
			const close = isActive ? theme.fg('accent', ']') : theme.fg('dim', ']');
			tabParts.push(`${bracket}${label}${close}`);
		}

		const separator = theme.fg('dim', ' ');
		const barLine = tabParts.join(separator);

		// Divider line — accent color for visual separation
		const divider = theme.fg('accent', '─'.repeat(Math.min(width, 80)));
		const hint = theme.fg('dim', 'Left/Right: switch  Enter: select  Esc: close');

		lines.push(truncateToWidth(barLine, width));
		lines.push(truncateToWidth(divider, width));
		lines.push(truncateToWidth(hint, width));

		return lines;
	}

	invalidate(): void {
		// Nothing to invalidate - data is direct
	}
}
