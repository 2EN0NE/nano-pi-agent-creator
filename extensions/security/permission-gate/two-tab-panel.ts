/**
 * TwoTabPanel — Strategies & History 双 Tab 面板
 *
 * 为 permission-gate 提供策略管理和历史审计的 TUI 界面。
 */

import { getKeybindings, matchesKey, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { createLogger } from '@zenone/pi-logger';
import { createHash } from 'node:crypto';
import { loadRecords, deleteStrategy, normalizeDim, type ApprovalEntry } from './records.js';

const log = createLogger('permission-gate:two-tab');

/**
 * 替换字符串中的换行符为可见的 \n 表示，确保 TUI 单行渲染不被换行打断。
 */
function sanitizeInline(text: string): string {
	return text.replace(/\r\n/g, '\\n').replace(/\n/g, '\\n');
}

// ============================================================================
// 展示数据类型
// ============================================================================

/** 策略展示项 */
export interface StrategyDisplayItem {
	dimension: 'cmd' | 'tool' | 'dir';
	key: string;
	displayKey: string;
	count: number;
	threshold: number;
	isActive: boolean;
	/** 该策略首次出现的时间（从历史记录反查） */
	createdAt: string;
	/** 子命令原文（仅 cmd 维度有，从历史记录反查） */
	subCommand: string;
}

/** 历史展示项 */
export interface HistoryDisplayItem {
	entry: ApprovalEntry;
	isPassed: boolean;
	summary: string;
}

// ============================================================================
// 数据构建
// ============================================================================

/**
 * 从 _counts 和 thresholds 构建策略展示列表。
 * entries 用于反查策略的首次创建时间和子命令原文。
 */
export function buildStrategyItems(
	counts: Record<string, number>,
	thresholds: { sameCommand: number; sameTool: number; sameFolder: number },
	entries?: ApprovalEntry[],
): StrategyDisplayItem[] {
	const items: StrategyDisplayItem[] = [];

	// 预计算每组 key 的 stats（基于历史记录）
	const keyStats: Record<string, { earliestTs: string; subCmd: string }> = {};
	if (entries) {
		for (const e of entries) {
			if (e.action === 'blocked') continue;
			// cmd key
			const normalized = e.cmd.trim().replace(/\s+/g, ' ');
			const cmdHash = createHash('sha256').update(normalized).digest('hex').slice(0, 16);
			const cmdKey = `cmd:${cmdHash}`;
			if (!keyStats[cmdKey] || e.ts < keyStats[cmdKey].earliestTs) {
				keyStats[cmdKey] = { earliestTs: e.ts, subCmd: e.cmd };
			}
			// tool key
			const toolKey = `tool:${e.tool}`;
			if (!keyStats[toolKey] || e.ts < keyStats[toolKey].earliestTs) {
				keyStats[toolKey] = { earliestTs: e.ts, subCmd: '' };
			}
			// dir key
			const dirKey = `dir:${e.dir}`;
			if (!keyStats[dirKey] || e.ts < keyStats[dirKey].earliestTs) {
				keyStats[dirKey] = { earliestTs: e.ts, subCmd: '' };
			}
		}
	}

	for (const key of Object.keys(counts)) {
		const count = counts[key] ?? 0;
		const stats = keyStats[key];
		const ts = stats?.earliestTs ?? '';
		const subCmd = stats?.subCmd ?? '';

		if (key.startsWith('cmd:')) {
			items.push({
				dimension: 'cmd',
				key,
				displayKey: key.slice(4),
				count,
				threshold: thresholds.sameCommand,
				isActive: count < thresholds.sameCommand,
				createdAt: ts,
				subCommand: subCmd,
			});
		} else if (key.startsWith('tool:')) {
			items.push({
				dimension: 'tool',
				key,
				displayKey: key.slice(5),
				count,
				threshold: thresholds.sameTool,
				isActive: count < thresholds.sameTool,
				createdAt: ts,
				subCommand: '',
			});
		} else if (key.startsWith('dir:')) {
			items.push({
				dimension: 'dir',
				key,
				displayKey: key.slice(4),
				count,
				threshold: thresholds.sameFolder,
				isActive: count < thresholds.sameFolder,
				createdAt: ts,
				subCommand: '',
			});
		}
	}

	items.sort((a, b) => {
		const order: Record<string, number> = { cmd: 0, tool: 1, dir: 2 };
		return (order[a.dimension] ?? 0) - (order[b.dimension] ?? 0);
	});

	return items;
}

/**
 * 从 records 文件加载历史条目（时间倒序）。
 */
export function loadHistoryItems(cwd: string): HistoryDisplayItem[] {
	const result = loadRecords(cwd);
	const entries = [...result.entries].reverse();

	return entries.map((entry) => {
		const cmdSummary = entry.cmd.length > 80 ? entry.cmd.slice(0, 77) + '...' : entry.cmd;
		return {
			entry,
			isPassed: entry.action !== 'blocked',
			summary: cmdSummary,
		};
	});
}

// ============================================================================
// Theme 类型
// ============================================================================

interface PanelTheme {
	fg: (c: string, t: string) => string;
	bold: (s: string) => string;
}

// ============================================================================
// TwoTabPanel 组件
// ============================================================================

type TabId = 'strategies' | 'history';

export class TwoTabPanel {
	private tui_: { requestRender: () => void };
	private theme_: PanelTheme;
	private onClose: () => void;
	private cwd: string;
	private counts: Record<string, number>;
	private thresholds: { sameCommand: number; sameTool: number; sameFolder: number };
	private updateCounts: (c: Record<string, number>) => void;

	private activeTab: TabId = 'strategies';
	private strategies: StrategyDisplayItem[] = [];
	private history: HistoryDisplayItem[] = [];
	private strategyFilter = '';
	private historyFilter = '';
	private isFiltering = false;
	private selectedIndex = 0;
	private expanded = false;

	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(opts: {
		tui: { requestRender: () => void };
		theme: PanelTheme;
		onClose: () => void;
		cwd: string;
		counts: Record<string, number>;
		thresholds: { sameCommand: number; sameTool: number; sameFolder: number };
		updateCounts: (c: Record<string, number>) => void;
	}) {
		this.tui_ = opts.tui;
		this.theme_ = opts.theme;
		this.onClose = opts.onClose;
		this.cwd = opts.cwd;
		this.counts = opts.counts;
		this.thresholds = opts.thresholds;
		this.updateCounts = opts.updateCounts;
		this.refreshData();
	}

	private refreshData(): void {
		const historyResult = loadRecords(this.cwd);
		this.history = historyResult.entries
			.slice()
			.reverse()
			.map((entry) => {
				const cmdSummary =
					entry.cmd.length > 80 ? entry.cmd.slice(0, 77) + '...' : entry.cmd;
				return {
					entry,
					isPassed: entry.action !== 'blocked',
					summary: cmdSummary,
				};
			});
		this.strategies = buildStrategyItems(this.counts, this.thresholds, historyResult.entries);
	}

	private get filteredStrategies(): StrategyDisplayItem[] {
		if (!this.strategyFilter) return this.strategies;
		const q = this.strategyFilter.toLowerCase();
		return this.strategies.filter((s) => s.displayKey.toLowerCase().includes(q));
	}

	private get filteredHistory(): HistoryDisplayItem[] {
		if (!this.historyFilter) return this.history;
		const q = this.historyFilter.toLowerCase();
		return this.history.filter(
			(h) =>
				h.summary.toLowerCase().includes(q) ||
				h.entry.tool.toLowerCase().includes(q) ||
				h.entry.action.toLowerCase().includes(q),
		);
	}

	private get currentFilteredList(): (StrategyDisplayItem | HistoryDisplayItem)[] {
		return this.activeTab === 'strategies' ? this.filteredStrategies : this.filteredHistory;
	}

	private get currentFilter(): string {
		return this.activeTab === 'strategies' ? this.strategyFilter : this.historyFilter;
	}

	handleInput(data: string): void {
		// Tab 切换
		if (data === '\t') {
			this.activeTab = this.activeTab === 'strategies' ? 'history' : 'strategies';
			this.selectedIndex = 0;
			this.expanded = false;
			this.invalidate();
			this.tui_.requestRender();
			return;
		}

		// 过滤模式下
		if (this.isFiltering) {
			if (matchesKey(data, 'escape')) {
				this.isFiltering = false;
				if (this.activeTab === 'strategies') this.strategyFilter = '';
				else this.historyFilter = '';
				this.selectedIndex = 0;
				this.invalidate();
				this.tui_.requestRender();
				return;
			}
			if (matchesKey(data, 'backspace')) {
				const current =
					this.activeTab === 'strategies' ? this.strategyFilter : this.historyFilter;
				const updated = current.slice(0, -1);
				if (this.activeTab === 'strategies') this.strategyFilter = updated;
				else this.historyFilter = updated;
				this.selectedIndex = 0;
				this.invalidate();
				this.tui_.requestRender();
				return;
			}
			if (data.length === 1 && data.charCodeAt(0) >= 32) {
				if (this.activeTab === 'strategies') this.strategyFilter += data;
				else this.historyFilter += data;
				this.selectedIndex = 0;
				this.invalidate();
				this.tui_.requestRender();
				return;
			}
			return;
		}

		// / 进入过滤
		if (data === '/') {
			this.isFiltering = true;
			this.invalidate();
			this.tui_.requestRender();
			return;
		}

		// Esc 关闭面板
		if (matchesKey(data, 'escape')) {
			this.onClose();
			return;
		}

		// 上下导航
		const list = this.currentFilteredList;
		const kb = getKeybindings();
		if (kb.matches(data, 'tui.select.up') || matchesKey(data, 'up')) {
			if (list.length === 0) return;
			this.selectedIndex =
				this.selectedIndex === 0 ? list.length - 1 : this.selectedIndex - 1;
			this.expanded = false;
			this.invalidate();
			this.tui_.requestRender();
			return;
		}
		if (kb.matches(data, 'tui.select.down') || matchesKey(data, 'down')) {
			if (list.length === 0) return;
			this.selectedIndex =
				this.selectedIndex === list.length - 1 ? 0 : this.selectedIndex + 1;
			this.expanded = false;
			this.invalidate();
			this.tui_.requestRender();
			return;
		}

		// Ctrl+Shift+O 展开/收起
		if (matchesKey(data, 'ctrl+shift+o')) {
			this.expanded = !this.expanded;
			this.invalidate();
			this.tui_.requestRender();
			return;
		}

		// x 删除策略（仅在 strategies tab）
		if (data === 'x' && this.activeTab === 'strategies') {
			const filtered = this.filteredStrategies;
			if (this.selectedIndex < 0 || this.selectedIndex >= filtered.length) return;
			const item = filtered[this.selectedIndex];
			if (!item) return;

			log.info(
				'Deleting strategy: dim=%s key=%s displayKey=%s',
				item.dimension,
				item.key,
				item.displayKey,
			);

			const result = deleteStrategy(this.cwd, item.dimension, item.key);
			this.counts = result.counts;
			this.updateCounts(result.counts);
			this.refreshData();

			if (this.selectedIndex >= this.currentFilteredList.length) {
				this.selectedIndex = Math.max(0, this.currentFilteredList.length - 1);
			}
			this.expanded = false;
			this.invalidate();
			this.tui_.requestRender();
			return;
		}
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const th = this.theme_;
		const lines: string[] = [];

		// Tab 头
		const stratLabel =
			this.activeTab === 'strategies'
				? th.fg('accent', th.bold('[Strategies]'))
				: th.fg('dim', '[Strategies]');
		const histLabel =
			this.activeTab === 'history'
				? th.fg('accent', th.bold('[History]'))
				: th.fg('dim', '[History]');
		const tabLine = '  ' + stratLabel + '  ' + histLabel;
		lines.push(truncateToWidth(tabLine, width));

		// 分隔
		lines.push(truncateToWidth(th.fg('dim', '─'.repeat(width)), width));

		// 过滤栏
		const filterText = this.currentFilter;
		const filterLine = this.isFiltering
			? `/ ${filterText}${th.fg('dim', '_')}   (ESC to clear)`
			: filterText
				? `Filter: ${th.fg('accent', filterText)}   (/ edit, ESC clear)`
				: `/ filter   (Tab switch, Ctrl+Shift+O expand, ESC close)`;
		lines.push(truncateToWidth('  ' + filterLine, width));
		lines.push(truncateToWidth(th.fg('dim', '─'.repeat(width)), width));

		// 列表内容
		const list = this.currentFilteredList;
		const maxVisible = 12;
		const startIdx = Math.max(0, this.selectedIndex - Math.floor(maxVisible / 2));
		const endIdx = Math.min(startIdx + maxVisible, list.length);

		if (list.length === 0) {
			const msg =
				this.activeTab === 'strategies' ? 'No strategies found' : 'No history entries';
			lines.push(truncateToWidth('  ' + th.fg('dim', msg), width));
		} else {
			for (let i = startIdx; i < endIdx; i++) {
				const isSel = i === this.selectedIndex;
				const prefix = isSel ? '> ' : '  ';
				const item = list[i];
				if (!item) continue;

				let line: string;
				if (this.activeTab === 'strategies') {
					line = this.renderStrategyLine(
						prefix,
						item as StrategyDisplayItem,
						isSel,
						width,
					);
				} else {
					line = this.renderHistoryLine(prefix, item as HistoryDisplayItem, isSel, width);
				}
				lines.push(line);
			}
		}

		// 滚动提示
		if (list.length > maxVisible) {
			const scrollInfo = `  (${this.selectedIndex + 1}/${list.length})`;
			lines.push(truncateToWidth(th.fg('dim', scrollInfo), width));
		}

		// 展开详情
		if (this.expanded && list.length > 0 && this.selectedIndex < list.length) {
			const item = list[this.selectedIndex];
			if (item) {
				lines.push(truncateToWidth(th.fg('dim', '─'.repeat(width)), width));
				lines.push(truncateToWidth(th.fg('accent', th.bold('  Expanded Detail:')), width));
				const detailLines = this.renderExpandedDetail(item, width);
				for (const dl of detailLines) {
					lines.push(truncateToWidth(dl, width));
				}
			}
		}

		// 底部操作提示
		lines.push(truncateToWidth(th.fg('dim', '─'.repeat(width)), width));
		const footer =
			this.activeTab === 'strategies'
				? '↑↓ navigate  / filter  x delete  Tab switch  Ctrl+Shift+O expand  Esc close'
				: '↑↓ navigate  / filter  Tab switch  Ctrl+Shift+O expand  Esc close';
		lines.push(truncateToWidth('  ' + th.fg('dim', footer), width));

		// 填充到最小高度，防止 overlay 高度变化导致溢出渲染到屏幕顶部。
		const MIN_TOTAL_LINES = 5 + 12 + 1 + 3; // 21
		const padCount = Math.max(0, MIN_TOTAL_LINES - lines.length);
		for (let i = 0; i < padCount; i++) {
			lines.push('');
		}

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	private renderStrategyLine(
		prefix: string,
		item: StrategyDisplayItem,
		isSel: boolean,
		width: number,
	): string {
		const th = this.theme_;

		const dimLabel =
			item.dimension === 'cmd' ? '[cmd]' : item.dimension === 'tool' ? '[tool]' : '[dir]';
		const progress = `${item.count}/${item.threshold}`;
		const ts = item.createdAt ? item.createdAt.slice(0, 10) : '';
		const cmdHash = item.key.slice(4, 12);

		// cmd: hash[8] + 时间 + 子命令原文
		// tool/folder: 名称 + 时间
		let detail: string;
		if (item.dimension === 'cmd') {
			const rawCmd = item.subCommand || cmdHash;
			const sanitizedCmd = sanitizeInline(rawCmd);
			const cmdText =
				sanitizedCmd.length > 50 ? sanitizedCmd.slice(0, 47) + '...' : sanitizedCmd;
			detail = `${cmdHash}  ${ts ? ts + '  ' : ''}${cmdText}`;
		} else {
			detail = `${item.displayKey}  ${ts}`;
		}

		const mainText = `${dimLabel} ${detail}  >  ${progress}`;

		if (isSel) {
			return truncateToWidth(prefix + th.fg('accent', mainText), width);
		}

		const color = item.isActive ? 'accent' : 'warning';
		return truncateToWidth(prefix + th.fg(color, mainText), width);
	}

	private renderHistoryLine(
		prefix: string,
		item: HistoryDisplayItem,
		isSel: boolean,
		width: number,
	): string {
		const th = this.theme_;

		const statusMark = item.isPassed ? 'OK' : 'BLOCK';
		const action = item.entry.action;
		const ts = item.entry.ts.slice(0, 19).replace('T', ' ');
		const dimStr = normalizeDim(item.entry.dim)?.join(',') ?? '-';
		const lineText = `${statusMark} ${action.padEnd(9)} | ${sanitizeInline(item.summary)} | ${dimStr} | ${ts}`;

		const availWidth = width - visibleWidth(prefix);
		let display: string;
		if (visibleWidth(lineText) > availWidth) {
			// 用 visibleWidth 逐个字符截断，确保不超出可用宽度
			let truncated = '';
			let tw = 0;
			for (const ch of lineText) {
				const cw = visibleWidth(ch);
				if (tw + cw >= availWidth - 1) break;
				truncated += ch;
				tw += cw;
			}
			display = truncated + '…';
		} else {
			display = lineText;
		}

		if (isSel) {
			return truncateToWidth(prefix + th.fg('accent', display), width);
		}

		const prefixColored = th.fg(item.isPassed ? 'success' : 'error', statusMark);
		const rest = display.slice(statusMark.length + 1);
		return truncateToWidth(prefix + prefixColored + ' ' + th.fg('text', rest), width);
	}

	private renderExpandedDetail(
		item: StrategyDisplayItem | HistoryDisplayItem,
		width: number,
	): string[] {
		const th = this.theme_;
		const lines: string[] = [];
		const pad = '  ';

		if ('dimension' in item) {
			const s = item as StrategyDisplayItem;
			lines.push(truncateToWidth(pad + th.fg('accent', `Dimension: ${s.dimension}`), width));
			lines.push(truncateToWidth(pad + th.fg('text', `Key: ${s.displayKey}`), width));
			const statusPart = s.isActive
				? th.fg('success', '  (auto-approves next match)')
				: th.fg('warning', '  (threshold reached)');
			lines.push(
				truncateToWidth(
					pad +
						th.fg('text', `Count: ${s.count} / Threshold: ${s.threshold}`) +
						statusPart,
					width,
				),
			);
		} else {
			const h = item as HistoryDisplayItem;
			const e = h.entry;
			lines.push(truncateToWidth(pad + th.fg('accent', `Action: ${e.action}`), width));
			lines.push(
				truncateToWidth(
					pad + th.fg('text', `Dimension: ${normalizeDim(e.dim)?.join(', ') ?? 'N/A'}`),
					width,
				),
			);
			lines.push(truncateToWidth(pad + th.fg('text', `Tool: ${e.tool}`), width));
			lines.push(truncateToWidth(pad + th.fg('text', `Directory: ${e.dir}`), width));
			lines.push(truncateToWidth(pad + th.fg('dim', `Time: ${e.ts}`), width));

			// 子命令（当前条目的 cmd）
			const cmdLabel = pad + th.fg('text', 'Command: ');
			const cmdDisplay = sanitizeInline(e.cmd);
			const cmdAvail = width - visibleWidth(cmdLabel);
			if (visibleWidth(cmdDisplay) <= cmdAvail) {
				lines.push(truncateToWidth(cmdLabel + cmdDisplay, width));
			} else {
				let truncated = '';
				let tw = 0;
				for (const ch of cmdDisplay) {
					const cw = visibleWidth(ch);
					if (tw + cw >= cmdAvail - 1) break;
					truncated += ch;
					tw += cw;
				}
				lines.push(truncateToWidth(cmdLabel + truncated + '…', width));
			}

			// 原始复合命令（如有）
			if (e.originalCommand && e.originalCommand !== e.cmd) {
				const origLabel = pad + th.fg('text', 'Original: ');
				const origDisplay = sanitizeInline(e.originalCommand);
				const origAvail = width - visibleWidth(origLabel);
				if (visibleWidth(origDisplay) <= origAvail) {
					lines.push(truncateToWidth(origLabel + origDisplay, width));
				} else {
					let truncated = '';
					let tw = 0;
					for (const ch of origDisplay) {
						const cw = visibleWidth(ch);
						if (tw + cw >= origAvail - 1) break;
						truncated += ch;
						tw += cw;
					}
					lines.push(truncateToWidth(origLabel + truncated + '…', width));
				}
			}

			// 拆解后的命令列表（如有）
			if (e.subCommands && e.subCommands.length > 1) {
				const subsLabel = pad + th.fg('dim', `Sub-commands: ${e.subCommands.join(' | ')}`);
				lines.push(truncateToWidth(subsLabel, width));
			}
		}

		return lines;
	}
}

// ============================================================================
// 入口函数
// ============================================================================

/**
 * 打开 TwoTabPanel overlay 并等待用户关闭。
 */
export async function showTwoTabPanel(
	ctx: ExtensionCommandContext,
	counts: Record<string, number>,
	thresholds: { sameCommand: number; sameTool: number; sameFolder: number },
	updateCounts: (c: Record<string, number>) => void,
): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		const th = theme as unknown as PanelTheme;
		const panel = new TwoTabPanel({
			tui,
			theme: th,
			onClose: () => done(),
			cwd: ctx.cwd,
			counts,
			thresholds,
			updateCounts,
		});
		return {
			render: (w: number) => panel.render(w),
			invalidate: () => panel.invalidate(),
			handleInput: (data: string) => panel.handleInput(data),
		};
	});
}
