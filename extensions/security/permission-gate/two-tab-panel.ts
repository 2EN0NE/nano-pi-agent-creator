/**
 * TwoTabPanel — scope × 维度两级分层面板（ADR-0029）
 *
 * 一级 tab（← / → 切换）：会话 / 项目 / 用户 / 历史 / 分析
 *   scope 三个 tab 内，二级 tab（Tab 切换）：命令 / 工具 / 目录
 *   每个 = 一个维度列表，选中条目 → 展开详情（master-detail）
 *   [历史][分析] 无二级 tab。
 *
 * 数据：展示层按层读取三层计数（getRuleCountsByLayer，同名 key 可出现在多层），
 * 判定层仍用保守合并的 getRuleCounts()。
 */

import {
	getKeybindings,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	Key,
} from '@earendil-works/pi-tui';
import { topBorder } from '../../../src/tui/helpers.js';
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { showSelect } from '@zenone/pi-selector';
import { createLogger } from '@zenone/pi-logger';
import { getProjectKey } from './records.js';
import {
	makeCommandKey,
	type DangerTier,
	type PermissionGateConfig,
	type PatternEntry,
	type CommandEntry,
} from './config.js';
import {
	getRuleCountsByLayer,
	deleteRuleKey,
	deleteRuleKeyScoped,
	moveRuleKey,
} from './approval-store.js';
import {
	getManualStrategiesByLayer,
	moveManualStrategy,
	removeManualStrategy,
	removeManualStrategyScoped,
} from './manual-strategies.js';
import { computeAnalytics, type AnalyticsMetrics } from './analytics.js';
import { listAuditFiles, readAuditFile, type AuditEntry, type AuditDecision } from './audit-log.js';
import { abbrevProjectPath, readSessionCurrentName } from './origins.js';

const log = createLogger('permission-gate:panel');

/**
 * 替换字符串中的换行符为可见的 \n 表示，确保 TUI 单行渲染不被换行打断。
 */
function sanitizeInline(text: string): string {
	return text.replace(/\r\n/g, '\\n').replace(/\n/g, '\\n');
}

/** 危险等级短标签（T9：UI 分级展示，纯文本单宽） */
export function tierLabel(tier: DangerTier | undefined | null): string {
	if (!tier) return '';
	const short: Record<DangerTier, string> = {
		critical: 'crit',
		warning: 'warn',
		info: 'info',
	};
	return `[${short[tier]}]`;
}

// ============================================================================
// 展示数据类型
// ============================================================================

type LayerTabId = 'session' | 'project' | 'user' | 'history' | 'analytics' | 'settings';
type DimTabId = 'cmd' | 'tool' | 'dir';
type ScopeTabId = 'session' | 'project' | 'user';

/** 策略展示项（单层内，不再带 scope——scope 已是一级 tab） */
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
	/** 来源：手动创建（用户拍板） vs 算法沉淀（graduated 计数） */
	source: 'manual' | 'auto';
}

/** 单层内按维度分组的策略 */
export interface StrategyGroups {
	cmd: StrategyDisplayItem[];
	tool: StrategyDisplayItem[];
	dir: StrategyDisplayItem[];
}

type LayerStrategies = Record<ScopeTabId, StrategyGroups>;

/** 历史展示项 */
export interface HistoryDisplayItem {
	entry: AuditEntry;
	isPassed: boolean;
	summary: string;
}

const LAYER_TABS: Array<{ id: LayerTabId; label: string }> = [
	{ id: 'session', label: '会话' },
	{ id: 'project', label: '项目' },
	{ id: 'user', label: '用户' },
	{ id: 'history', label: '历史' },
	{ id: 'analytics', label: '分析' },
	{ id: 'settings', label: '设置' },
];

const DIM_TABS: Array<{ id: DimTabId; label: string }> = [
	{ id: 'cmd', label: '命令' },
	{ id: 'tool', label: '工具' },
	{ id: 'dir', label: '目录' },
];

const LAYER_LABEL: Record<LayerTabId, string> = {
	session: '会话',
	project: '项目',
	user: '用户',
	history: '历史',
	analytics: '分析',
	settings: '设置',
};

/** 审计决策 → 中文说明（历史详情：被规则还是用户操作） */
const DECISION_LABEL: Record<AuditDecision, string> = {
	allow: '直接放行（未命中规则）',
	ask: '用户确认放行',
	auto: '规则自动放行',
	deny: '用户拒绝（拦截）',
};

// ============================================================================
// 数据构建
// ============================================================================

/**
 * 从单层 counts（Record<string, number>）构建按维度分组的策略。
 * entries 用于反查策略的首次创建时间和子命令原文。
 */
export function buildStrategyGroups(
	counts: Record<string, number>,
	thresholds: { sameCommand: number; sameTool: number; sameFolder: number },
	entries?: AuditEntry[],
): StrategyGroups {
	const groups: StrategyGroups = { cmd: [], tool: [], dir: [] };

	// 预计算 cmd key 的 stats（从 audit 子命令反查首次出现时间与原文）
	const keyStats: Record<string, { earliestTs: string; subCmd: string }> = {};
	if (entries) {
		for (const e of entries) {
			if (e.decision === 'deny' || e.decision === 'allow') continue;
			for (const sub of e.subCommands ?? []) {
				const cmdKey = makeCommandKey(sub);
				if (!keyStats[cmdKey] || e.ts < keyStats[cmdKey].earliestTs) {
					keyStats[cmdKey] = { earliestTs: e.ts, subCmd: sub };
				}
			}
		}
	}

	for (const key of Object.keys(counts)) {
		const count = counts[key] ?? 0;
		const stats = keyStats[key];
		const ts = stats?.earliestTs ?? '';
		const subCmd = stats?.subCmd ?? '';

		if (key.startsWith('cmd:')) {
			groups.cmd.push({
				dimension: 'cmd',
				key,
				displayKey: key.slice(4),
				count,
				threshold: thresholds.sameCommand,
				isActive: count < thresholds.sameCommand,
				createdAt: ts,
				subCommand: subCmd,
				source: 'auto',
			});
		} else if (key.startsWith('tool:')) {
			groups.tool.push({
				dimension: 'tool',
				key,
				displayKey: key.slice(5),
				count,
				threshold: thresholds.sameTool,
				isActive: count < thresholds.sameTool,
				createdAt: ts,
				subCommand: '',
				source: 'auto',
			});
		} else if (key.startsWith('dir:')) {
			groups.dir.push({
				dimension: 'dir',
				key,
				displayKey: key.slice(4),
				count,
				threshold: thresholds.sameFolder,
				isActive: count < thresholds.sameFolder,
				createdAt: ts,
				subCommand: '',
				source: 'auto',
			});
		}
	}

	return groups;
}

// ============================================================================
// Theme 类型
// ============================================================================

export interface PanelTheme {
	fg: (c: string, t: string) => string;
	bold: (s: string) => string;
}

// ============================================================================
// TwoTabPanel 组件
// ============================================================================

export class TwoTabPanel {
	private tui_: { requestRender: () => void };
	private theme_: PanelTheme;
	private onClose: () => void;
	private ctx: ExtensionCommandContext;
	private config: PermissionGateConfig;
	private onConfigChanged: () => void;

	private activeLayer: LayerTabId = 'session';
	private activeDim: DimTabId = 'cmd';
	private analyticsScope: ScopeTabId = 'session';
	private strategies: LayerStrategies = emptyStrategies();
	private filter = '';
	private isFiltering = false;
	private selectedIndex = 0;
	private expanded = false;

	// 设置 tab 状态（ADR-0030）：光标（跨开关行 + 配置列表）与二级页
	private settingsCursor = 0;
	private settingsDetail = -1;
	private settingsSubCursor = 0;
	private patternOp = -1;
	/** 危险/权限命令清单操作页（-1=列表，0=编辑命令名，1=编辑备注，2=删除） */
	private commandOp = -1;
	/** 路径空间当前组：系统目录 / 敏感凭证 */
	private pathGroup: 'system' | 'credential' = 'system';

	// T10：审计分析 Tab
	private analytics: AnalyticsMetrics = computeAnalytics([]);
	private daysWindow = 30;

	// UX3：历史/分析按来源范围（会话 ⊂ 项目 ⊂ 全部）
	// 当前面板打开的会话与项目（audit 溯源匹配基准）
	private currentSessionId = '';
	private currentCwd = '';
	/** 历史二级 tab：会话/项目/用户（默认「用户」= 全部，含旧记录无 sessionId/projectPath 的「未知」行） */
	private historyScope: ScopeTabId = 'user';
	/** 历史窗口（decision !== 'allow'，ts 降序，懒加载：从最新分片倒序分批读入） */
	private historyWindow: AuditEntry[] = [];
	/** 待读分片队列（YYYY-MM-DD.jsonl 降序）；null = 未初始化 */
	private historyFileQueue: string[] | null = null;
	/** 已读到的历史总条数（供懒加载判断） */
	/** 会话名解析缓存（面板内按 sessionId 一次） */
	private sessionNameCache = new Map<string, string | undefined>();
	/** 默认展示窗口行数（懒加载首批） */
	private static readonly HISTORY_BATCH = 160;

	// 审计分片全量读入缓存（面板生命周期内不变：overlay 聚焦期间不会有新命令执行）。
	// 注意：仅策略反查/分析聚合使用；历史列表走 historyWindow 懒加载（UX3）。
	private auditEntriesCache: AuditEntry[] | null = null;

	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(opts: {
		tui: { requestRender: () => void };
		theme: PanelTheme;
		onClose: () => void;
		ctx: ExtensionCommandContext;
		config: PermissionGateConfig;
		onConfigChanged: () => void;
	}) {
		this.tui_ = opts.tui;
		this.theme_ = opts.theme;
		this.onClose = opts.onClose;
		this.ctx = opts.ctx;
		this.config = opts.config;
		this.onConfigChanged = opts.onConfigChanged;
		this.currentSessionId = opts.ctx.sessionManager?.getSessionId?.() ?? '';
		this.currentCwd = opts.ctx.cwd ?? '';
		// 历史窗口首批（懒加载起点：最新分片起）
		this.ensureHistoryWindow(TwoTabPanel.HISTORY_BATCH);
		this.refreshData();
	}

	/**
	 * 历史窗口懒加载（UX3）：从最新分片倒序读入，直到累计条数 >= minEntries 或分片读尽。
	 * 只追加更早记录（保持 ts 降序），已渲染区不变。
	 */
	private ensureHistoryWindow(minEntries: number): void {
		if (this.historyFileQueue === null) {
			this.historyFileQueue = listAuditFiles().sort().reverse();
		}
		const queue = this.historyFileQueue;
		while (this.historyWindow.length < minEntries && queue.length > 0) {
			const file = queue.shift()!;
			let rows: AuditEntry[];
			try {
				rows = readAuditFile(file);
			} catch {
				continue;
			}
			const kept = rows.filter((e) => e.decision !== 'allow');
			// 分片内时间升序 → 追加前反转，保持全局 ts 降序
			this.historyWindow.push(...kept.reverse());
		}
	}

	/** 全量读入审计分片一次并缓存（面板生命周期内复用）。 */
	private loadAuditEntries(): AuditEntry[] {
		if (this.auditEntriesCache === null) {
			const entries: AuditEntry[] = [];
			for (const f of listAuditFiles()) {
				entries.push(...readAuditFile(f));
			}
			this.auditEntriesCache = entries;
		}
		return this.auditEntriesCache;
	}

	private refreshData(): void {
		const projectKey = getProjectKey(this.ctx.cwd);
		const auditEntries = this.loadAuditEntries();
		const projectEntries = auditEntries.filter(
			(e) => e.projectKey === projectKey && e.decision !== 'allow',
		);

		// 历史列表走 historyWindow 懒加载（UX3），此处不再构建全量 history 数组
		this.invalidate();

		const byLayer = getRuleCountsByLayer();
		this.strategies = {
			session: buildStrategyGroups(
				byLayer.session,
				this.config.dynamicPolicy.thresholds,
				projectEntries,
			),
			project: buildStrategyGroups(
				byLayer.project,
				this.config.dynamicPolicy.thresholds,
				projectEntries,
			),
			user: buildStrategyGroups(
				byLayer.user,
				this.config.dynamicPolicy.thresholds,
				projectEntries,
			),
		};

		// 融合手动策略（ADR-0030）：手动策略是命令级，优先于同名 graduated 条目
		const manualByLayer = getManualStrategiesByLayer();
		for (const scope of ['session', 'project', 'user'] as ScopeTabId[]) {
			const manual = manualByLayer[scope];
			const cmdList = this.strategies[scope].cmd;
			for (const [key, entry] of Object.entries(manual)) {
				const item: StrategyDisplayItem = {
					dimension: 'cmd',
					key,
					displayKey: entry.command,
					count: 0,
					threshold: 0,
					isActive: true,
					createdAt: entry.createdAt,
					subCommand: entry.command,
					source: 'manual',
				};
				const existing = cmdList.findIndex((s) => s.key === key);
				if (existing >= 0) cmdList[existing] = item;
				else cmdList.push(item);
			}
		}

		// 按当前 scope 计算分析指标（复用已缓存的审计条目）。
		this.refreshAnalytics();
	}

	/**
	 * 来源范围审计（UX3，历史/分析共用）：
	 * session=本会话记录；project=当前项目（含历史会话；旧记录经 projectKey 匹配）；
	 * user=全部。均排除直接放行（allow）。
	 */
	private scopeAuditEntries(scope: ScopeTabId): AuditEntry[] {
		if (scope === 'session') {
			if (!this.currentSessionId) return [];
			return this.loadAuditEntries().filter(
				(e) =>
					e.decision !== 'allow' &&
					!!e.sessionId &&
					e.sessionId === this.currentSessionId,
			);
		}
		if (scope === 'project') {
			const key = getProjectKey(this.ctx.cwd);
			return this.loadAuditEntries().filter(
				(e) =>
					e.decision !== 'allow' &&
					((e.projectPath && e.projectPath === this.currentCwd) ||
						(!e.projectPath && !!e.projectKey && e.projectKey === key)),
			);
		}
		return this.loadAuditEntries().filter((e) => e.decision !== 'allow');
	}

	/** 从已缓存的审计日志聚合最近 daysWindow 天的指标（UX3：按来源范围过滤） */
	private refreshAnalytics(): void {
		const entries = this.scopeAuditEntries(this.analyticsScope);
		this.analytics = computeAnalytics(entries, this.daysWindow);
	}

	private isScopeLayer(): boolean {
		return (
			this.activeLayer === 'session' ||
			this.activeLayer === 'project' ||
			this.activeLayer === 'user'
		);
	}

	private currentGroups(): StrategyGroups {
		return this.strategies[this.activeLayer as ScopeTabId];
	}

	private filteredDimList(): StrategyDisplayItem[] {
		const group = this.currentGroups();
		const dimList = group[this.activeDim];
		if (!this.filter) return dimList;
		const q = this.filter.toLowerCase();
		return dimList.filter(
			(s) => s.displayKey.toLowerCase().includes(q) || s.subCommand.toLowerCase().includes(q),
		);
	}

	/**
	 * 历史按来源范围筛（UX3）：会话 ⊂ 项目 ⊂ 全部。
	 * 旧记录（无 projectPath，如迁移自 approvals.json）只能通过 projectKey 落入「项目」，
	 * 无 sessionId 的不落入「会话」；两者都可在「用户」（全部）看到并标「未知」。
	 */
	private scopeHistoryEntries(): AuditEntry[] {
		if (this.historyScope === 'session') {
			if (!this.currentSessionId) return [];
			return this.historyWindow.filter(
				(e) => !!e.sessionId && e.sessionId === this.currentSessionId,
			);
		}
		if (this.historyScope === 'project') {
			const key = getProjectKey(this.ctx.cwd);
			return this.historyWindow.filter(
				(e) =>
					(e.projectPath && e.projectPath === this.currentCwd) ||
					(!e.projectPath && !!e.projectKey && e.projectKey === key),
			);
		}
		// user = 全部（含旧记录「未知」项目）
		return this.historyWindow;
	}

	private buildHistoryItem(e: AuditEntry): HistoryDisplayItem {
		const raw = e.originalCommand ?? e.command;
		const summary = raw.length > 80 ? raw.slice(0, 77) + '...' : raw;
		return { entry: e, isPassed: e.decision !== 'deny', summary };
	}

	private filteredHistory(): HistoryDisplayItem[] {
		const base = this.scopeHistoryEntries();
		if (!this.filter) return base.map((e) => this.buildHistoryItem(e));
		const q = this.filter.toLowerCase();
		return base
			.filter((e) => {
				const raw = e.originalCommand ?? e.command;
				return (
					raw.toLowerCase().includes(q) ||
					e.tool.toLowerCase().includes(q) ||
					e.decision.toLowerCase().includes(q)
				);
			})
			.map((e) => this.buildHistoryItem(e));
	}

	private get currentList(): (StrategyDisplayItem | HistoryDisplayItem)[] {
		if (this.activeLayer === 'history') return this.filteredHistory();
		if (this.activeLayer === 'analytics') return [];
		return this.filteredDimList();
	}

	private cycleLayer(dir: 1 | -1): void {
		const order: LayerTabId[] = [
			'session',
			'project',
			'user',
			'history',
			'analytics',
			'settings',
		];
		const idx = order.indexOf(this.activeLayer);
		this.activeLayer = order[(idx + dir + order.length) % order.length];
		// 进入历史 tab 时确保初始窗口已加载（懒加载起点）
		if (this.activeLayer === 'history') {
			this.ensureHistoryWindow(TwoTabPanel.HISTORY_BATCH);
		}
		this.resetListState();
	}

	private cycleDim(dir: 1 | -1): void {
		const order: DimTabId[] = ['cmd', 'tool', 'dir'];
		const idx = order.indexOf(this.activeDim);
		this.activeDim = order[(idx + dir + order.length) % order.length];
		this.resetListState();
	}

	private cycleAnalyticsScope(dir: 1 | -1): void {
		const order: ScopeTabId[] = ['session', 'project', 'user'];
		const idx = order.indexOf(this.analyticsScope);
		this.analyticsScope = order[(idx + dir + order.length) % order.length];
		this.refreshAnalytics();
		this.invalidate();
		this.tui_.requestRender();
	}

	/** 历史二级 tab 切换（会话/项目/用户，← →） */
	private cycleHistoryScope(dir: 1 | -1): void {
		const order: ScopeTabId[] = ['session', 'project', 'user'];
		const idx = order.indexOf(this.historyScope);
		this.historyScope = order[(idx + dir + order.length) % order.length];
		this.resetListState();
	}

	private cycleSecondary(dir: 1 | -1): void {
		if (this.isScopeLayer()) {
			this.cycleDim(dir);
		} else if (this.activeLayer === 'history') {
			this.cycleHistoryScope(dir);
		} else if (this.activeLayer === 'analytics') {
			this.cycleAnalyticsScope(dir);
		}
	}

	private cycleWindow(dir: 1 | -1): void {
		const windows = [7, 30, 90, 180];
		const idx = windows.indexOf(this.daysWindow);
		this.daysWindow = windows[(idx + dir + windows.length) % windows.length];
		this.refreshAnalytics();
		this.invalidate();
		this.tui_.requestRender();
	}

	private resetListState(): void {
		this.selectedIndex = 0;
		this.expanded = false;
		this.filter = '';
		this.isFiltering = false;
		this.invalidate();
		this.tui_.requestRender();
	}

	/** 设置一级项总数 = 3 开关 + 配置列表 */
	private settingsTotalCount(): number {
		return 3 + this.settingsConfigItems().length;
	}

	/**
	 * 设置配置列表（开关行之后，cursor 从 3 起）。
	 * detail 为二级页编号：0 沉淀级别 / 1 拦截模式 / 2 阈值 / 3 危险命令 / 4 权限命令 / 5 路径空间；
	 * -1 = 就地处理（范围输入 / 组件详情切换）。
	 */
	private settingsConfigItems(): Array<{
		label: string;
		value: string;
		detail: -1 | 0 | 1 | 2 | 3 | 4 | 5;
	}> {
		return [
			{
				label: '默认沉淀级别',
				value: LAYER_LABEL[this.config.defaultPersistenceScope as ScopeTabId],
				detail: 0,
			},
			{ label: '拦截模式', value: `${this.config.patterns.length} 个`, detail: 1 },
			{
				label: '阈值',
				value: `命令${this.config.dynamicPolicy.thresholds.sameCommand} 工具${this.config.dynamicPolicy.thresholds.sameTool} 目录${this.config.dynamicPolicy.thresholds.sameFolder}`,
				detail: 2,
			},
			{ label: '范围', value: this.config.dynamicPolicy.scope, detail: -1 },
			{
				label: '组件详情',
				value: this.config.widget.detailLevel === 'full' ? '完整' : '仅门控',
				detail: -1,
			},
			{ label: '危险命令清单', value: `${this.config.dangerCommands.length} 个`, detail: 3 },
			{
				label: '权限命令清单',
				value: `${this.config.permissionCommands.length} 个`,
				detail: 4,
			},
			{
				label: '路径空间',
				value: `系统${this.config.pathSurfaces.systemDirs.length} 凭证${this.config.pathSurfaces.credentialFiles.length}`,
				detail: 5,
			},
		];
	}

	/** 设置层键位：开关切换 + 配置列表导航 + 二级页 */
	private handleSettingsInput(data: string): void {
		// 二级页：默认沉淀级别三选一
		if (this.settingsDetail === 0) {
			const scopes: ScopeTabId[] = ['session', 'project', 'user'];
			if (matchesKey(data, 'up')) {
				this.settingsSubCursor =
					(this.settingsSubCursor - 1 + scopes.length) % scopes.length;
				this.invalidate();
				this.tui_.requestRender();
				return;
			}
			if (matchesKey(data, 'down')) {
				this.settingsSubCursor = (this.settingsSubCursor + 1) % scopes.length;
				this.invalidate();
				this.tui_.requestRender();
				return;
			}
			if (matchesKey(data, 'enter')) {
				this.config.defaultPersistenceScope = scopes[this.settingsSubCursor];
				this.settingsDetail = -1;
				this.onConfigChanged();
				this.invalidate();
				this.tui_.requestRender();
				return;
			}
			if (matchesKey(data, 'escape')) {
				this.settingsDetail = -1;
				this.invalidate();
				this.tui_.requestRender();
				return;
			}
			return;
		}

		// 二级页：阈值 ←→ 调整
		if (this.settingsDetail === 2) {
			const keys = ['sameCommand', 'sameTool', 'sameFolder'] as const;
			if (matchesKey(data, 'up')) {
				this.settingsSubCursor = (this.settingsSubCursor - 1 + keys.length) % keys.length;
				this.invalidate();
				this.tui_.requestRender();
				return;
			}
			if (matchesKey(data, 'down')) {
				this.settingsSubCursor = (this.settingsSubCursor + 1) % keys.length;
				this.invalidate();
				this.tui_.requestRender();
				return;
			}
			if (matchesKey(data, 'left') || matchesKey(data, 'right')) {
				const key = keys[this.settingsSubCursor];
				const delta = matchesKey(data, 'left') ? -1 : 1;
				// 0 = 永不自动放行（语义在 checkThreshold/hasGraduatedStrategy/calcWidgetContentText 中已支持），
				// UI 需可调达 0，否则该语义只能手改 config.json。
				this.config.dynamicPolicy.thresholds[key] = Math.max(
					0,
					this.config.dynamicPolicy.thresholds[key] + delta,
				);
				this.onConfigChanged();
				this.invalidate();
				this.tui_.requestRender();
				return;
			}
			if (matchesKey(data, 'enter') || matchesKey(data, 'escape')) {
				this.settingsDetail = -1;
				this.invalidate();
				this.tui_.requestRender();
				return;
			}
			return;
		}

		// 二级页：拦截模式（列表 + 操作页）
		if (this.settingsDetail === 1) {
			this.handlePatternsInput(data);
			return;
		}

		// 二级页：危险命令清单
		if (this.settingsDetail === 3) {
			this.handleCommandListInput(data, 'danger');
			return;
		}

		// 二级页：权限命令清单
		if (this.settingsDetail === 4) {
			this.handleCommandListInput(data, 'permission');
			return;
		}

		// 二级页：路径空间
		if (this.settingsDetail === 5) {
			this.handlePathSurfacesInput(data);
			return;
		}

		// 一级：↑↓ 导航（3 开关 + 配置列表）
		if (matchesKey(data, 'up')) {
			const total = this.settingsTotalCount();
			this.settingsCursor = (this.settingsCursor - 1 + total) % total;
			this.invalidate();
			this.tui_.requestRender();
			return;
		}
		if (matchesKey(data, 'down')) {
			const total = this.settingsTotalCount();
			this.settingsCursor = (this.settingsCursor + 1) % total;
			this.invalidate();
			this.tui_.requestRender();
			return;
		}
		if (matchesKey(data, 'enter')) {
			this.applySettingsSelection();
			this.invalidate();
			this.tui_.requestRender();
			return;
		}
		// esc 关闭面板（设置分支已 return，不落到全局 Esc）
		if (matchesKey(data, 'escape')) {
			this.onClose();
			return;
		}
	}

	/** 拦截模式二级页键位（列表 + 操作页） */
	private handlePatternsInput(data: string): void {
		const count = this.config.patterns.length;

		// 操作页：编辑正则 / 修改级别 / 删除
		if (this.patternOp >= 0) {
			const p = this.config.patterns[this.settingsSubCursor];
			if (matchesKey(data, 'up')) {
				this.patternOp = (this.patternOp - 1 + 4) % 4;
				this.invalidate();
				this.tui_.requestRender();
				return;
			}
			if (matchesKey(data, 'down')) {
				this.patternOp = (this.patternOp + 1) % 4;
				this.invalidate();
				this.tui_.requestRender();
				return;
			}
			if (matchesKey(data, 'enter')) {
				const op = this.patternOp;
				this.patternOp = -1;
				if (p) {
					if (op === 0) this.editPattern(p);
					else if (op === 1) this.editPatternNote(p);
					else if (op === 2) this.changePatternTier(p).catch(() => {});
					else this.deletePattern(p).catch(() => {});
				}
				this.invalidate();
				this.tui_.requestRender();
				return;
			}
			if (matchesKey(data, 'escape')) {
				this.patternOp = -1;
				this.invalidate();
				this.tui_.requestRender();
				return;
			}
			return;
		}

		// 列表页
		if (matchesKey(data, 'up')) {
			if (count === 0) return;
			this.settingsSubCursor = (this.settingsSubCursor - 1 + count) % count;
			this.invalidate();
			this.tui_.requestRender();
			return;
		}
		if (matchesKey(data, 'down')) {
			if (count === 0) return;
			this.settingsSubCursor = (this.settingsSubCursor + 1) % count;
			this.invalidate();
			this.tui_.requestRender();
			return;
		}
		if (matchesKey(data, 'enter')) {
			if (count === 0) return;
			this.patternOp = 0;
			this.invalidate();
			this.tui_.requestRender();
			return;
		}
		if (data === 'a') {
			this.addPattern();
			return;
		}
		if (data === 'x') {
			const p = this.config.patterns[this.settingsSubCursor];
			if (p) void this.deletePattern(p);
			return;
		}
		if (matchesKey(data, 'escape')) {
			this.settingsDetail = -1;
			this.patternOp = -1;
			this.invalidate();
			this.tui_.requestRender();
			return;
		}
	}

	/** 新增拦截模式：输入正则 + tier 三选一 */
	private addPattern(): void {
		void this.ctx.ui
			.input('正则模式', '')
			.then(async (v) => {
				if (v === undefined || !v.trim()) return;
				const pattern = v.trim();
				if (this.config.patterns.some((p) => p.pattern === pattern)) {
					this.ctx.ui.notify(`模式已存在：${pattern}`, 'error');
					return;
				}
				try {
					new RegExp(pattern);
				} catch {
					this.ctx.ui.notify(`无效的正则表达式：${pattern}`, 'error');
					return;
				}
				const tier = await this.pickTier();
				if (!tier) return;
				this.config.patterns.push({ pattern, tier });
				this.onConfigChanged();
				this.invalidate();
				this.tui_.requestRender();
			})
			.catch(() => {});
	}

	/** 编辑正则文本 */
	private editPattern(p: PatternEntry): void {
		void this.ctx.ui
			.input('正则模式', p.pattern)
			.then((v) => {
				if (v === undefined || !v.trim()) return;
				try {
					new RegExp(v.trim());
				} catch {
					this.ctx.ui.notify(`无效的正则表达式：${v.trim()}`, 'error');
					return;
				}
				p.pattern = v.trim();
				this.onConfigChanged();
				this.invalidate();
				this.tui_.requestRender();
			})
			.catch(() => {});
	}

	/** 修改级别（tier 三选一） */
	private async changePatternTier(p: PatternEntry): Promise<void> {
		const tier = await this.pickTier();
		if (!tier) return;
		p.tier = tier;
		this.onConfigChanged();
		this.invalidate();
		this.tui_.requestRender();
	}

	/** 编辑备注（可选，解释为何危险） */
	private editPatternNote(p: PatternEntry): void {
		void this.ctx.ui
			.input('备注说明（可选，解释为何危险）', p.note ?? '')
			.then((v) => {
				if (v === undefined) return;
				if (v.trim()) p.note = v.trim();
				else delete p.note;
				this.onConfigChanged();
				this.invalidate();
				this.tui_.requestRender();
			})
			.catch(() => {});
	}

	/** 删除（确认） */
	private async deletePattern(p: PatternEntry): Promise<void> {
		const result = await showSelect<'yes'>(
			this.ctx,
			'删除模式？',
			[{ value: 'yes', label: '删除' }],
			{ detail: p.pattern, mode: 'danger' },
		);
		if (!result) return;
		const idx = this.config.patterns.indexOf(p);
		if (idx >= 0) this.config.patterns.splice(idx, 1);
		this.settingsSubCursor = Math.max(0, this.settingsSubCursor - 1);
		this.onConfigChanged();
		this.invalidate();
		this.tui_.requestRender();
	}

	/** tier 三选一 */
	private async pickTier(): Promise<DangerTier | null> {
		const result = await showSelect<DangerTier>(this.ctx, '选择级别', [
			{ value: 'critical', label: 'critical（危险）' },
			{ value: 'warning', label: 'warning（警告）' },
			{ value: 'info', label: 'info（提示）' },
		]);
		return result ? result.value : null;
	}

	/** 当前命令清单（危险 / 权限） */
	private commandList(kind: 'danger' | 'permission'): CommandEntry[] {
		return kind === 'danger' ? this.config.dangerCommands : this.config.permissionCommands;
	}

	/** 危险/权限命令清单二级页键位（列表 + 操作页） */
	private handleCommandListInput(data: string, kind: 'danger' | 'permission'): void {
		const list = this.commandList(kind);
		const count = list.length;

		// 操作页：编辑命令名 / 编辑备注 / 删除
		if (this.commandOp >= 0) {
			if (matchesKey(data, 'up')) {
				this.commandOp = (this.commandOp - 1 + 3) % 3;
				this.invalidate();
				this.tui_.requestRender();
				return;
			}
			if (matchesKey(data, 'down')) {
				this.commandOp = (this.commandOp + 1) % 3;
				this.invalidate();
				this.tui_.requestRender();
				return;
			}
			if (matchesKey(data, 'enter')) {
				const op = this.commandOp;
				this.commandOp = -1;
				const entry = list[this.settingsSubCursor];
				if (entry) {
					if (op === 0) this.editCommandName(kind, entry);
					else if (op === 1) this.editCommandNote(kind, entry);
					else this.deleteCommand(kind, entry).catch(() => {});
				}
				this.invalidate();
				this.tui_.requestRender();
				return;
			}
			if (matchesKey(data, 'escape')) {
				this.commandOp = -1;
				this.invalidate();
				this.tui_.requestRender();
				return;
			}
			return;
		}

		// 列表页
		if (matchesKey(data, 'up')) {
			if (count === 0) return;
			this.settingsSubCursor = (this.settingsSubCursor - 1 + count) % count;
			this.invalidate();
			this.tui_.requestRender();
			return;
		}
		if (matchesKey(data, 'down')) {
			if (count === 0) return;
			this.settingsSubCursor = (this.settingsSubCursor + 1) % count;
			this.invalidate();
			this.tui_.requestRender();
			return;
		}
		if (matchesKey(data, 'enter')) {
			if (count === 0) return;
			this.commandOp = 0;
			this.invalidate();
			this.tui_.requestRender();
			return;
		}
		if (data === 'a') {
			this.addCommand(kind);
			return;
		}
		if (data === 'x') {
			const entry = list[this.settingsSubCursor];
			if (entry) void this.deleteCommand(kind, entry);
			return;
		}
		if (matchesKey(data, 'escape')) {
			this.settingsDetail = -1;
			this.commandOp = -1;
			this.invalidate();
			this.tui_.requestRender();
			return;
		}
	}

	/** 路径空间二级页键位：←→ 切组 + 组内列表增删 */
	private handlePathSurfacesInput(data: string): void {
		const group =
			this.pathGroup === 'system'
				? this.config.pathSurfaces.systemDirs
				: this.config.pathSurfaces.credentialFiles;
		const count = group.length;

		if (matchesKey(data, 'left') || matchesKey(data, 'right')) {
			this.pathGroup = this.pathGroup === 'system' ? 'credential' : 'system';
			this.settingsSubCursor = 0;
			this.invalidate();
			this.tui_.requestRender();
			return;
		}
		if (matchesKey(data, 'up')) {
			if (count === 0) return;
			this.settingsSubCursor = (this.settingsSubCursor - 1 + count) % count;
			this.invalidate();
			this.tui_.requestRender();
			return;
		}
		if (matchesKey(data, 'down')) {
			if (count === 0) return;
			this.settingsSubCursor = (this.settingsSubCursor + 1) % count;
			this.invalidate();
			this.tui_.requestRender();
			return;
		}
		if (data === 'a') {
			this.addPath();
			return;
		}
		if (data === 'x') {
			const path = group[this.settingsSubCursor];
			if (path) void this.deletePath(path);
			return;
		}
		if (matchesKey(data, 'escape')) {
			this.settingsDetail = -1;
			this.invalidate();
			this.tui_.requestRender();
			return;
		}
	}

	/** 新增命令（危险/权限清单）：输入命令名 + 可选备注 */
	private addCommand(kind: 'danger' | 'permission'): void {
		void this.ctx.ui
			.input('命令名', '')
			.then(async (v) => {
				if (v === undefined || !v.trim()) return;
				const command = v.trim();
				const list = this.commandList(kind);
				if (list.some((e) => e.command === command)) {
					this.ctx.ui.notify(`命令已存在：${command}`, 'error');
					return;
				}
				const note = await this.ctx.ui.input('备注说明（可选，解释为何危险）', '');
				const entry: CommandEntry = { command };
				if (note !== undefined && note.trim()) entry.note = note.trim();
				list.push(entry);
				this.onConfigChanged();
				this.invalidate();
				this.tui_.requestRender();
			})
			.catch(() => {});
	}

	/** 编辑命令名（危险/权限清单） */
	private editCommandName(kind: 'danger' | 'permission', entry: CommandEntry): void {
		void this.ctx.ui
			.input('命令名', entry.command)
			.then((v) => {
				if (v === undefined || !v.trim()) return;
				const command = v.trim();
				const list = this.commandList(kind);
				if (list.some((e) => e !== entry && e.command === command)) {
					this.ctx.ui.notify(`命令已存在：${command}`, 'error');
					return;
				}
				entry.command = command;
				this.onConfigChanged();
				this.invalidate();
				this.tui_.requestRender();
			})
			.catch(() => {});
	}

	/** 编辑备注（危险/权限清单） */
	private editCommandNote(_kind: 'danger' | 'permission', entry: CommandEntry): void {
		void this.ctx.ui
			.input('备注说明（可选，解释为何危险）', entry.note ?? '')
			.then((v) => {
				if (v === undefined) return;
				if (v.trim()) entry.note = v.trim();
				else delete entry.note;
				this.onConfigChanged();
				this.invalidate();
				this.tui_.requestRender();
			})
			.catch(() => {});
	}

	/** 删除命令（危险/权限清单） */
	private async deleteCommand(kind: 'danger' | 'permission', entry: CommandEntry): Promise<void> {
		const result = await showSelect<'yes'>(
			this.ctx,
			'删除命令？',
			[{ value: 'yes', label: '删除' }],
			{ detail: entry.command, mode: 'danger' },
		);
		if (!result) return;
		const list = this.commandList(kind);
		const idx = list.indexOf(entry);
		if (idx >= 0) list.splice(idx, 1);
		this.settingsSubCursor = Math.max(0, this.settingsSubCursor - 1);
		this.onConfigChanged();
		this.invalidate();
		this.tui_.requestRender();
	}

	/** 新增路径（当前组） */
	private addPath(): void {
		void this.ctx.ui
			.input('路径', '')
			.then((v) => {
				if (v === undefined || !v.trim()) return;
				const path = v.trim();
				const group =
					this.pathGroup === 'system'
						? this.config.pathSurfaces.systemDirs
						: this.config.pathSurfaces.credentialFiles;
				if (group.includes(path)) {
					this.ctx.ui.notify(`路径已存在：${path}`, 'error');
					return;
				}
				group.push(path);
				this.onConfigChanged();
				this.invalidate();
				this.tui_.requestRender();
			})
			.catch(() => {});
	}

	/** 删除路径（当前组） */
	private async deletePath(path: string): Promise<void> {
		const result = await showSelect<'yes'>(
			this.ctx,
			'删除路径？',
			[{ value: 'yes', label: '删除' }],
			{ detail: path, mode: 'danger' },
		);
		if (!result) return;
		const group =
			this.pathGroup === 'system'
				? this.config.pathSurfaces.systemDirs
				: this.config.pathSurfaces.credentialFiles;
		const idx = group.indexOf(path);
		if (idx >= 0) group.splice(idx, 1);
		this.settingsSubCursor = Math.max(0, this.settingsSubCursor - 1);
		this.onConfigChanged();
		this.invalidate();
		this.tui_.requestRender();
	}

	/** 一级设置项的 enter 处理（开关 toggle / 进入二级） */
	private applySettingsSelection(): void {
		// 开关行（cursor 0-2）
		if (this.settingsCursor === 0) {
			this.config.enabled = !this.config.enabled;
			this.onConfigChanged();
			return;
		}
		if (this.settingsCursor === 1) {
			this.config.dynamicPolicyEnabled = !this.config.dynamicPolicyEnabled;
			this.onConfigChanged();
			return;
		}
		if (this.settingsCursor === 2) {
			this.config.widget.show = !this.config.widget.show;
			this.onConfigChanged();
			return;
		}

		// 配置列表（cursor 3 起，数据表驱动）
		const item = this.settingsConfigItems()[this.settingsCursor - 3];
		if (!item) return;

		switch (item.detail) {
			case 0:
				this.settingsDetail = 0;
				this.settingsSubCursor = 0;
				break;
			case 1:
				this.settingsDetail = 1;
				this.settingsSubCursor = 0;
				this.patternOp = -1;
				break;
			case 2:
				this.settingsDetail = 2;
				this.settingsSubCursor = 0;
				break;
			case 3:
				this.settingsDetail = 3;
				this.settingsSubCursor = 0;
				this.commandOp = -1;
				break;
			case 4:
				this.settingsDetail = 4;
				this.settingsSubCursor = 0;
				this.commandOp = -1;
				break;
			case 5:
				this.settingsDetail = 5;
				this.settingsSubCursor = 0;
				this.pathGroup = 'system';
				break;
			case -1: {
				// 就地处理：范围输入（第 4 项）/ 组件详情切换（第 5 项）
				const idx = this.settingsCursor - 3;
				if (idx === 3) {
					void this.ctx.ui
						.input('范围目录路径', this.config.dynamicPolicy.scope)
						.then((v) => {
							if (v !== undefined && v.trim()) {
								this.config.dynamicPolicy.scope = v.trim();
								this.onConfigChanged();
								this.invalidate();
								this.tui_.requestRender();
							}
						})
						.catch(() => {});
				} else if (idx === 4) {
					this.config.widget.detailLevel =
						this.config.widget.detailLevel === 'full' ? 'gate' : 'full';
					this.onConfigChanged();
				}
				break;
			}
		}
	}

	handleInput(data: string): void {
		// Tab 切一级 tab（全局）
		if (matchesKey(data, Key.tab) || data === '\t') {
			this.cycleLayer(1);
			return;
		}

		// 设置层：开关行 + 配置列表（二级页 esc 返回一级；需在 ←→ 全局处理之前，
		// 否则阈值二级页的 ←→ 调整会被「切二级 tab」捕获）
		if (this.activeLayer === 'settings') {
			this.handleSettingsInput(data);
			return;
		}

		// ← / → 切二级 tab（scope 层切维度；分析层切 scope；历史层忽略）
		if (matchesKey(data, Key.left)) {
			this.cycleSecondary(-1);
			return;
		}
		if (matchesKey(data, Key.right)) {
			this.cycleSecondary(1);
			return;
		}

		// 分析层：[ / ] 切时间窗口；其余键忽略（Esc 关闭）
		if (this.activeLayer === 'analytics') {
			if (data === '[') {
				this.cycleWindow(-1);
				return;
			}
			if (data === ']') {
				this.cycleWindow(1);
				return;
			}
			if (matchesKey(data, 'escape')) {
				this.onClose();
				return;
			}
			return;
		}

		// 过滤模式
		if (this.isFiltering) {
			if (matchesKey(data, 'escape')) {
				this.isFiltering = false;
				this.filter = '';
				this.selectedIndex = 0;
				this.invalidate();
				this.tui_.requestRender();
				return;
			}
			if (matchesKey(data, 'backspace')) {
				this.filter = this.filter.slice(0, -1);
				this.selectedIndex = 0;
				this.invalidate();
				this.tui_.requestRender();
				return;
			}
			if (data.length === 1 && data.charCodeAt(0) >= 32) {
				this.filter += data;
				this.selectedIndex = 0;
				this.invalidate();
				this.tui_.requestRender();
				return;
			}
			return;
		}

		// / 进入过滤（scope 层与 history 层；analytics 层已在上面 return）
		if (data === '/') {
			this.isFiltering = true;
			this.invalidate();
			this.tui_.requestRender();
			return;
		}

		// Esc 关闭面板
		if (matchesKey(data, Key.escape)) {
			this.onClose();
			return;
		}

		// Enter 展开/收起详情（策略层与历史层）
		if (matchesKey(data, Key.enter)) {
			if (this.currentList.length === 0) return;
			this.expanded = !this.expanded;
			this.invalidate();
			this.tui_.requestRender();
			return;
		}

		// 上下导航
		const list = this.currentList;
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
			// 历史懒加载：接近窗口尾部且仍有更早分片时，先加载一批（避免回绕丢失数据）
			if (this.activeLayer === 'history' && this.selectedIndex + 20 >= list.length) {
				const before = this.historyWindow.length;
				this.ensureHistoryWindow(list.length + TwoTabPanel.HISTORY_BATCH);
				if (this.historyWindow.length > before) {
					this.selectedIndex += 1;
					this.expanded = false;
					this.invalidate();
					this.tui_.requestRender();
					return;
				}
			}
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

		// m 调整层级（仅 scope 层）
		if (data === 'm' && this.isScopeLayer()) {
			const filtered = this.filteredDimList();
			if (this.selectedIndex < 0 || this.selectedIndex >= filtered.length) return;
			const item = filtered[this.selectedIndex];
			if (!item) return;
			void this.confirmMoveStrategy(item);
			return;
		}

		// x 删除策略（仅 scope 层）
		if (data === 'x' && this.isScopeLayer()) {
			const filtered = this.filteredDimList();
			if (this.selectedIndex < 0 || this.selectedIndex >= filtered.length) return;
			const item = filtered[this.selectedIndex];
			if (!item) return;
			void this.confirmAndDelete(item);
			return;
		}
	}

	private async confirmAndDelete(item: StrategyDisplayItem): Promise<void> {
		const layerLabel = LAYER_LABEL[this.activeLayer];
		const result = await showSelect<'layer' | 'all'>(
			this.ctx,
			'删除策略？',
			[
				{
					value: 'layer',
					label: '仅本层',
					description: `仅删除当前「${layerLabel}」层的该策略`,
				},
				{
					value: 'all',
					label: '所有层',
					description: '删除三层中同名的该策略',
				},
			],
			{ detail: item.displayKey, mode: 'danger' },
		);
		if (!result) return; // Esc 取消

		log.info(
			'Deleting strategy: scope=%s dim=%s key=%s displayKey=%s',
			this.activeLayer,
			item.dimension,
			item.key,
			item.displayKey,
		);

		if (result.value === 'all') {
			// 手动策略存于 manual-strategies.json，计数删除（deleteRuleKey）对其无效——
			// 需按来源分支，否则删除静默 no-op，规则继续以最高优先级自动放行。
			if (item.source === 'manual') {
				removeManualStrategy(item.key);
			} else {
				deleteRuleKey(item.key);
			}
		} else if (item.source === 'manual') {
			removeManualStrategyScoped(item.key, this.activeLayer as ScopeTabId);
		} else {
			deleteRuleKeyScoped(item.key, this.activeLayer as ScopeTabId);
		}

		this.refreshData();
		this.onConfigChanged();

		// 修正选中态越界
		const list = this.currentList;
		if (this.selectedIndex >= list.length) {
			this.selectedIndex = Math.max(0, list.length - 1);
		}
		this.expanded = false;
		this.invalidate();
		this.tui_.requestRender();
	}

	/** 调整规则持久化层级（m 键）：计数/手动策略从当前层迁移到目标层 */
	private async confirmMoveStrategy(item: StrategyDisplayItem): Promise<void> {
		const currentLayer = this.activeLayer as ScopeTabId;
		const scopes: ScopeTabId[] = ['session', 'project', 'user'];
		const result = await showSelect<ScopeTabId>(
			this.ctx,
			'调整持久化层级',
			scopes.map((s) => ({
				value: s,
				label: LAYER_LABEL[s],
				description: s === currentLayer ? '当前层' : undefined,
			})),
			{ detail: item.displayKey },
		);
		if (!result) return; // Esc 取消
		const target = result.value;
		if (target === currentLayer) return;

		if (item.source === 'manual') {
			moveManualStrategy(item.key, currentLayer, target);
		} else {
			moveRuleKey(item.key, currentLayer, target);
		}

		log.info(
			'Moving strategy: key=%s %s → %s (source=%s)',
			item.key,
			currentLayer,
			target,
			item.source,
		);

		this.refreshData();
		this.onConfigChanged();
		this.invalidate();
		this.tui_.requestRender();
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

		// 顶边框（标题嵌入，ADR-0023）
		lines.push(
			truncateToWidth(th.fg('accent', topBorder('── Permission Gate ', width)), width),
		);

		// 一级 tab 头
		const layerParts = LAYER_TABS.map((t) => {
			const label = t.id === this.activeLayer ? th.bold(`[${t.label}]`) : `[${t.label}]`;
			return t.id === this.activeLayer ? th.fg('accent', label) : th.fg('dim', label);
		});
		lines.push(truncateToWidth('  ' + layerParts.join('  '), width));

		// 设置层：独立渲染路径（无二级 tab、无过滤栏）
		if (this.activeLayer === 'settings') {
			lines.push(truncateToWidth(th.fg('dim', '─'.repeat(width)), width));
			for (const l of this.renderSettings()) {
				lines.push(truncateToWidth(l, width));
			}
			lines.push(truncateToWidth(th.fg('dim', '─'.repeat(width)), width));
			lines.push(
				truncateToWidth(
					'  ' + th.fg('dim', '↑↓ 导航  enter 确认/切换  Tab 层级  Esc 关闭'),
					width,
				),
			);
			const MIN_TOTAL_LINES = 5 + 12 + 1 + 3;
			const padCount = Math.max(0, MIN_TOTAL_LINES - lines.length);
			for (let i = 0; i < padCount; i++) lines.push('');
			this.cachedWidth = width;
			this.cachedLines = lines;
			return lines;
		}

		// 二级 tab 头（scope 层切维度；分析层切 scope）
		if (this.isScopeLayer()) {
			const groups = this.currentGroups();
			const counts: Record<DimTabId, number> = {
				cmd: groups.cmd.length,
				tool: groups.tool.length,
				dir: groups.dir.length,
			};
			const dimParts = DIM_TABS.map((t) => {
				const label =
					t.id === this.activeDim
						? th.bold(`[${t.label}(${counts[t.id]})]`)
						: `[${t.label}(${counts[t.id]})]`;
				return t.id === this.activeDim ? th.fg('accent', label) : th.fg('dim', label);
			});
			lines.push(truncateToWidth('    ' + dimParts.join('  '), width));
		} else if (this.activeLayer === 'history') {
			// 历史二级 tab：按来源范围筛（会话 ⊂ 项目 ⊂ 全部）
			const histParts = (['session', 'project', 'user'] as ScopeTabId[]).map((s) => {
				const label =
					s === this.historyScope
						? th.bold(`[${LAYER_LABEL[s]}]`)
						: `[${LAYER_LABEL[s]}]`;
				return s === this.historyScope ? th.fg('accent', label) : th.fg('dim', label);
			});
			lines.push(truncateToWidth('    ' + histParts.join('  '), width));
		} else if (this.activeLayer === 'analytics') {
			const scopeParts = (['session', 'project', 'user'] as ScopeTabId[]).map((s) => {
				const label =
					s === this.analyticsScope
						? th.bold(`[${LAYER_LABEL[s]}]`)
						: `[${LAYER_LABEL[s]}]`;
				return s === this.analyticsScope ? th.fg('accent', label) : th.fg('dim', label);
			});
			lines.push(truncateToWidth('    ' + scopeParts.join('  '), width));
		}

		lines.push(truncateToWidth(th.fg('dim', '─'.repeat(width)), width));

		// 过滤栏 / 会话提示 / 时间窗口
		if (this.activeLayer === 'analytics') {
			lines.push(truncateToWidth(`  时间窗口 ${this.daysWindow} 天`, width));
		} else {
			const filterLine = this.isFiltering
				? `/ ${this.filter}${th.fg('dim', '_')}   (ESC 清除)`
				: this.filter
					? `过滤: ${th.fg('accent', this.filter)}   (/ 编辑, ESC 清除)`
					: `/ 过滤   (Tab 层级, ←→ 维度, Enter 详情, ESC 关闭)`;
			lines.push(truncateToWidth('  ' + filterLine, width));
			if (this.activeLayer === 'session') {
				lines.push(
					truncateToWidth('  ' + th.fg('dim', '会话级：本次对话结束后失效'), width),
				);
			}
		}
		lines.push(truncateToWidth(th.fg('dim', '─'.repeat(width)), width));

		// 分析层：渲染聚合指标（无列表导航，提前返回）
		if (this.activeLayer === 'analytics') {
			for (const l of this.renderAnalytics()) {
				lines.push(truncateToWidth(l, width));
			}
			lines.push(truncateToWidth(th.fg('dim', '─'.repeat(width)), width));
			lines.push(
				truncateToWidth(
					'  ' + th.fg('dim', '[ ] 时间窗口   Tab 层级  ←→ scope  Esc 关闭'),
					width,
				),
			);
			const MIN_TOTAL_LINES = 5 + 12 + 1 + 3;
			const padCount = Math.max(0, MIN_TOTAL_LINES - lines.length);
			for (let i = 0; i < padCount; i++) lines.push('');
			this.cachedWidth = width;
			this.cachedLines = lines;
			return lines;
		}

		// 列表内容
		const list = this.currentList;
		const maxVisible = 12;
		const startIdx = Math.max(0, this.selectedIndex - Math.floor(maxVisible / 2));
		const endIdx = Math.min(startIdx + maxVisible, list.length);

		if (list.length === 0) {
			const msg = this.isScopeLayer()
				? `暂无${LAYER_LABEL[this.activeLayer]}级的${DIM_TABS.find((t) => t.id === this.activeDim)?.label ?? ''}策略`
				: this.emptyHistoryMsg();
			lines.push(truncateToWidth('  ' + th.fg('dim', msg), width));
		} else {
			// 历史表头（列名行，非导航行；UX3）
			if (this.activeLayer === 'history') {
				lines.push(
					truncateToWidth(
						th.fg('dim', this.renderHistoryHeader(this.historyScope === 'user', width)),
						width,
					),
				);
			}
			for (let i = startIdx; i < endIdx; i++) {
				const isSel = i === this.selectedIndex;
				const prefix = isSel ? '> ' : '  ';
				const item = list[i];
				if (!item) continue;

				const line = this.isScopeLayer()
					? this.renderStrategyLine(prefix, item as StrategyDisplayItem, isSel, width)
					: this.renderHistoryLine(
							prefix,
							item as HistoryDisplayItem,
							isSel,
							width,
							this.historyScope === 'user',
						);
				lines.push(line);
			}
		}

		// 滚动提示（含懒加载提示：未读完时标记 …）
		if (list.length > maxVisible) {
			const moreMark =
				this.activeLayer === 'history' &&
				this.historyFileQueue &&
				this.historyFileQueue.length > 0
					? '…'
					: '';
			const scrollInfo = `  (${this.selectedIndex + 1}/${list.length}${moreMark})`;
			lines.push(truncateToWidth(th.fg('dim', scrollInfo), width));
		}

		// 展开详情
		if (this.expanded && list.length > 0 && this.selectedIndex < list.length) {
			const item = list[this.selectedIndex];
			if (item) {
				lines.push(truncateToWidth(th.fg('dim', '─'.repeat(width)), width));
				lines.push(truncateToWidth(th.fg('accent', th.bold('  展开详情：')), width));
				const detailLines = this.renderExpandedDetail(item, width);
				for (const dl of detailLines) {
					lines.push(truncateToWidth(dl, width));
				}
			}
		}

		// 底部操作提示
		lines.push(truncateToWidth(th.fg('dim', '─'.repeat(width)), width));
		const footer = this.isScopeLayer()
			? '↑↓ 导航  / 过滤  m 调级  x 删除  Tab 层级  ←→ 维度  Enter 详情  Esc 关闭'
			: this.activeLayer === 'history'
				? '↑↓ 导航  / 过滤  ←→ 范围  Tab 层级  Enter 详情  Esc 关闭'
				: '↑↓ 导航  / 过滤  Tab 层级  Enter 详情  Esc 关闭';
		lines.push(truncateToWidth('  ' + th.fg('dim', footer), width));

		// tier→scope 持久化层级映射提示（scope 层，ADR-0025/0030）
		if (this.isScopeLayer()) {
			lines.push(
				truncateToWidth(
					'  ' + th.fg('dim', 'critical→会话  warning→项目  info→用户'),
					width,
				),
			);
		}

		// 填充到最小高度，防止 overlay 高度变化导致溢出渲染到屏幕顶部。
		const MIN_TOTAL_LINES = 5 + 12 + 1 + 3 + 2; // 23
		const padCount = Math.max(0, MIN_TOTAL_LINES - lines.length);
		for (let i = 0; i < padCount; i++) {
			lines.push('');
		}

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	/** 渲染设置 Tab（ADR-0030）：顶部开关行 + 配置列表 master-detail */
	private renderSettings(): string[] {
		const th = this.theme_;
		const lines: string[] = [];

		// 二级页
		if (this.settingsDetail === 0) {
			return this.renderScopeChoice();
		}
		if (this.settingsDetail === 1) {
			return this.renderPatterns();
		}
		if (this.settingsDetail === 2) {
			return this.renderThresholdChoice();
		}
		if (this.settingsDetail === 3) {
			return this.renderCommandList('danger');
		}
		if (this.settingsDetail === 4) {
			return this.renderCommandList('permission');
		}
		if (this.settingsDetail === 5) {
			return this.renderPathSurfaces();
		}

		// 开关行（3 项横排，光标高亮）
		const toggles: Array<{ label: string; on: boolean }> = [
			{ label: '权限门', on: this.config.enabled },
			{ label: '动态策略', on: this.config.dynamicPolicyEnabled },
			{ label: '组件', on: this.config.widget.show },
		];
		const toggleParts = toggles.map((t, i) => {
			const label = `[${t.on ? 'X' : ' '}] ${t.label}`;
			return i === this.settingsCursor
				? th.fg('accent', th.bold(label))
				: th.fg('text', label);
		});
		lines.push('  ' + toggleParts.join('   '));
		lines.push('');

		// 配置列表（settingsConfigItems 数据表）
		this.settingsConfigItems().forEach((c, i) => {
			const idx = i + 3;
			const isSel = idx === this.settingsCursor;
			const prefix = isSel ? '> ' : '  ';
			const text = `${c.label}: ${c.value}`;
			lines.push(prefix + (isSel ? th.fg('accent', text) : th.fg('text', text)));
		});

		return lines;
	}

	/** 默认沉淀级别二级页：三选一 */
	private renderScopeChoice(): string[] {
		const th = this.theme_;
		const lines: string[] = [];
		lines.push('  ' + th.fg('accent', th.bold('默认沉淀级别')));
		const scopes: Array<{ scope: ScopeTabId; label: string }> = [
			{ scope: 'session', label: '会话（本次对话结束失效）' },
			{ scope: 'project', label: '项目（当前项目持久）' },
			{ scope: 'user', label: '用户（全局持久）' },
		];
		scopes.forEach((s, i) => {
			const isSel = i === this.settingsSubCursor;
			const prefix = isSel ? '> ' : '  ';
			lines.push(prefix + (isSel ? th.fg('accent', s.label) : th.fg('text', s.label)));
		});
		lines.push('');
		lines.push('  ' + th.fg('dim', '↑↓ 选择  enter 确认  esc 返回'));
		return lines;
	}

	/** 阈值二级页：三个阈值项，←→ 调整 */
	private renderThresholdChoice(): string[] {
		const th = this.theme_;
		const lines: string[] = [];
		lines.push('  ' + th.fg('accent', th.bold('阈值（←→ 调整）')));
		type ThresholdKey = 'sameCommand' | 'sameTool' | 'sameFolder';
		const items: Array<{ label: string; key: ThresholdKey }> = [
			{ label: '同命令', key: 'sameCommand' },
			{ label: '同工具', key: 'sameTool' },
			{ label: '同目录', key: 'sameFolder' },
		];
		items.forEach((it, i) => {
			const isSel = i === this.settingsSubCursor;
			const prefix = isSel ? '> ' : '  ';
			const v = this.config.dynamicPolicy.thresholds[it.key];
			const text = `${it.label}: ${v}${v === 0 ? ' (永不自动放行)' : ''}`;
			lines.push(prefix + (isSel ? th.fg('accent', text) : th.fg('text', text)));
		});
		lines.push('');
		lines.push('  ' + th.fg('dim', '↑↓ 选择  ←→ 调整  enter/esc 返回'));
		return lines;
	}

	/** 拦截模式二级页（列表 + 操作页 master-detail） */
	private renderPatterns(): string[] {
		const th = this.theme_;
		const lines: string[] = [];

		// 操作页：编辑正则 / 编辑备注 / 修改级别 / 删除
		if (this.patternOp >= 0) {
			const p = this.config.patterns[this.settingsSubCursor];
			lines.push('  ' + th.fg('accent', th.bold(`模式操作：${p ? p.pattern : ''}`)));
			if (p?.note) {
				lines.push('    ' + th.fg('dim', `备注: ${sanitizeInline(p.note)}`));
			}
			const ops = ['编辑正则', '编辑备注', '修改级别', '删除'];
			ops.forEach((op, i) => {
				const isSel = i === this.patternOp;
				const prefix = isSel ? '> ' : '  ';
				lines.push(prefix + (isSel ? th.fg('accent', op) : th.fg('text', op)));
			});
			lines.push('');
			lines.push('  ' + th.fg('dim', '↑↓ 选择  enter 确认  esc 返回'));
			return lines;
		}

		// 列表页
		lines.push('  ' + th.fg('accent', th.bold('拦截模式')));
		if (this.config.patterns.length === 0) {
			lines.push('  ' + th.fg('dim', '暂无模式'));
		} else {
			this.config.patterns.forEach((p, i) => {
				const isSel = i === this.settingsSubCursor;
				const prefix = isSel ? '> ' : '  ';
				const label = `${p.pattern}  [${p.tier}]`;
				lines.push(prefix + (isSel ? th.fg('accent', label) : th.fg('text', label)));
			});
		}
		lines.push('');
		lines.push('  ' + th.fg('dim', 'enter 操作  a 新增  x 删除  esc 返回'));
		return lines;
	}

	/** 危险/权限命令清单二级页渲染（列表 + 操作页） */
	private renderCommandList(kind: 'danger' | 'permission'): string[] {
		const th = this.theme_;
		const lines: string[] = [];
		const list = this.commandList(kind);
		const title = kind === 'danger' ? '危险命令清单' : '权限命令清单';

		// 操作页：编辑命令名 / 编辑备注 / 删除
		if (this.commandOp >= 0) {
			const e = list[this.settingsSubCursor];
			lines.push('  ' + th.fg('accent', th.bold(`命令操作：${e ? e.command : ''}`)));
			if (e?.note) {
				lines.push('    ' + th.fg('dim', `备注: ${sanitizeInline(e.note)}`));
			}
			const ops = ['编辑命令名', '编辑备注', '删除'];
			ops.forEach((op, i) => {
				const isSel = i === this.commandOp;
				const prefix = isSel ? '> ' : '  ';
				lines.push(prefix + (isSel ? th.fg('accent', op) : th.fg('text', op)));
			});
			lines.push('');
			lines.push('  ' + th.fg('dim', '↑↓ 选择  enter 确认  esc 返回'));
			return lines;
		}

		// 列表页
		lines.push('  ' + th.fg('accent', th.bold(title)));
		if (list.length === 0) {
			lines.push('  ' + th.fg('dim', '暂无命令'));
		} else {
			list.forEach((e, i) => {
				const isSel = i === this.settingsSubCursor;
				const prefix = isSel ? '> ' : '  ';
				const note = e.note ? `  ${sanitizeInline(e.note)}` : '';
				const label = `${e.command}${note}`;
				lines.push(prefix + (isSel ? th.fg('accent', label) : th.fg('text', label)));
			});
		}
		lines.push('');
		lines.push('  ' + th.fg('dim', 'enter 操作  a 新增  x 删除  esc 返回'));
		return lines;
	}

	/** 路径空间二级页渲染（组标签 + 组内列表） */
	private renderPathSurfaces(): string[] {
		const th = this.theme_;
		const lines: string[] = [];
		const isSystem = this.pathGroup === 'system';
		const list = isSystem
			? this.config.pathSurfaces.systemDirs
			: this.config.pathSurfaces.credentialFiles;

		const sysLabel = isSystem
			? th.fg('accent', th.bold('[系统目录]'))
			: th.fg('dim', '[系统目录]');
		const credLabel = isSystem
			? th.fg('dim', '[敏感凭证]')
			: th.fg('accent', th.bold('[敏感凭证]'));
		lines.push('  ' + sysLabel + '  ' + credLabel);

		if (list.length === 0) {
			lines.push('  ' + th.fg('dim', '暂无路径'));
		} else {
			list.forEach((p, i) => {
				const isSel = i === this.settingsSubCursor;
				const prefix = isSel ? '> ' : '  ';
				lines.push(prefix + (isSel ? th.fg('accent', p) : th.fg('text', p)));
			});
		}
		lines.push('');
		lines.push('  ' + th.fg('dim', '←→ 切换组  a 新增  x 删除  esc 返回'));
		return lines;
	}

	/** 渲染分析 Tab（UX3）：按来源范围（会话 ⊂ 项目 ⊂ 全部）聚合指标 */
	private renderAnalytics(): string[] {
		const th = this.theme_;
		const lines: string[] = [];
		const m = this.analytics;
		const scopeDesc: Record<ScopeTabId, string> = {
			session: '本次会话',
			project: '当前项目',
			user: '全部项目',
		};
		const tiers = ['critical', 'warning', 'info'] as DangerTier[];

		lines.push(
			'  ' +
				th.fg(
					'accent',
					th.bold(
						`${LAYER_LABEL[this.analyticsScope]}范围（${scopeDesc[this.analyticsScope]}）`,
					),
				),
		);
		const tot = tiers.reduce(
			(acc, t) => {
				const c = m.byTier[t];
				acc.confirmed += c.confirmed;
				acc.auto += c.auto;
				acc.blocked += c.blocked;
				return acc;
			},
			{ confirmed: 0, auto: 0, blocked: 0 },
		);
		lines.push(`  确认:${tot.confirmed}  自动:${tot.auto}  拦截:${tot.blocked}`);
		for (const t of tiers) {
			const c = m.byTier[t];
			if (c.confirmed + c.auto + c.blocked === 0) continue;
			lines.push(`    ${tierLabel(t)} 确认:${c.confirmed} 自动:${c.auto} 拦截:${c.blocked}`);
		}
		lines.push('');

		// 异常高亮：范围内 critical 被 graduated 自动放行
		if (m.criticalGraduated.length > 0) {
			lines.push(
				'  ' +
					th.fg(
						'error',
						th.bold(`[异常] critical 被自动放行 (${m.criticalGraduated.length})`),
					),
			);
			for (const cmd of m.criticalGraduated.slice(0, 3)) {
				lines.push('    ' + th.fg('error', sanitizeInline(cmd)));
			}
			lines.push('');
		}

		// 高频被确认 Top N
		if (m.topConfirmed.length > 0) {
			lines.push('  ' + th.fg('accent', th.bold('高频被确认')));
			for (const { command, count } of m.topConfirmed) {
				lines.push(`    ${count}x  ${sanitizeInline(command)}`);
			}
			lines.push('');
		}

		// 误拦比例（>50% 标黄）
		const rate = (m.falseBlockRate * 100).toFixed(1);
		const rateColor = m.falseBlockRate > 0.5 ? 'warning' : 'text';
		lines.push(`  误拦比例: ${th.fg(rateColor, rate + '%')}`);
		lines.push(`  拦截总数: ${m.totalIntercepted}`);

		return lines;
	}

	private renderStrategyLine(
		prefix: string,
		item: StrategyDisplayItem,
		isSel: boolean,
		width: number,
	): string {
		const th = this.theme_;
		const sourceMark = item.source === 'manual' ? '手动' : '自动';
		const progress = item.source === 'manual' ? '已放行' : `${item.count}/${item.threshold}`;
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

		const mainText = `${sourceMark}  ${detail}  >  ${progress}`;

		if (isSel) {
			return truncateToWidth(prefix + th.fg('accent', mainText), width);
		}

		const color = item.isActive ? 'accent' : 'warning';
		return truncateToWidth(prefix + th.fg(color, mainText), width);
	}

	/**
	 * 历史空态文案（按范围 + 是否仍有更早分片）。
	 */
	private emptyHistoryMsg(): string {
		const scope = LAYER_LABEL[this.historyScope];
		const moreMark =
			this.historyFileQueue && this.historyFileQueue.length > 0
				? '（↓ 继续滚动加载更早记录）'
				: '';
		if (this.filter) return `「${scope}」范围内无匹配「${this.filter}」的记录${moreMark}`;
		if (this.historyScope === 'session') {
			return '会话级历史 = 本次对话产生的命令记录；本会话尚无拦截/放行记录' + moreMark;
		}
		if (this.historyScope === 'project' && !this.currentCwd) {
			return '未定位当前项目' + moreMark;
		}
		return `暂无「${scope}」范围的历史记录${moreMark}`;
	}

	/** 历史行/表头共享列宽（head 固定；user 层含项目路径列） */
	private historyCols(
		showPath: boolean,
		avail: number,
	): { headW: number; pathW: number; cmdW: number } {
		const headW = 13; // '状态 决策     ' 段
		const tailW = 2 + 11; // ' ' + 'MM-DD HH:mm'
		const rest = Math.max(2, avail - headW - tailW);
		const pathW = showPath ? Math.min(18, Math.floor(rest * 0.45)) : 0;
		const cmdW = Math.max(1, rest - pathW - (showPath ? 1 : 0));
		return { headW, pathW, cmdW };
	}

	/** 历史列表表头（列名，dim 样式） */
	private renderHistoryHeader(showPath: boolean, width: number): string {
		const avail = Math.max(10, width - 2);
		const { headW, pathW, cmdW } = this.historyCols(showPath, avail);
		let text = '状态 决策'.padEnd(headW);
		if (showPath) {
			text += '项目'.padEnd(pathW) + ' ';
		}
		text += '命令'.padEnd(cmdW) + '  时间';
		return '  ' + text;
	}

	private renderHistoryLine(
		prefix: string,
		item: HistoryDisplayItem,
		isSel: boolean,
		width: number,
		showPath: boolean,
	): string {
		const th = this.theme_;
		const e = item.entry;
		const statusMark = item.isPassed ? 'OK' : 'BLOCK';
		const decision = e.decision.padEnd(7);
		const ts = e.ts.slice(5, 16).replace('T', ' '); // MM-DD HH:mm
		const headStr = `${statusMark} ${decision}`;

		const avail = Math.max(10, width - visibleWidth(prefix));
		const { headW, pathW, cmdW } = this.historyCols(showPath, avail);

		const head = headStr.slice(0, headW).padEnd(headW);
		let body = '';
		if (showPath) {
			const rawPath = e.projectPath || '';
			let pathText = rawPath ? abbrevProjectPath(rawPath) : '未知';
			if (visibleWidth(pathText) > pathW - 1) {
				let cut = '';
				let tw = 0;
				for (const ch of pathText) {
					const cw = visibleWidth(ch);
					if (tw + cw > pathW - 2) break;
					cut += ch;
					tw += cw;
				}
				pathText = cut + '…';
			}
			body += pathText.padEnd(pathW) + ' ';
		}
		const cmdRaw = sanitizeInline(e.originalCommand ?? e.command);
		let cmdText = cmdRaw;
		if (visibleWidth(cmdRaw) > cmdW - 1) {
			let cut = '';
			let tw = 0;
			for (const ch of cmdRaw) {
				const cw = visibleWidth(ch);
				if (tw + cw > cmdW - 2) break;
				cut += ch;
				tw += cw;
			}
			cmdText = cut + '…';
		}
		body += cmdText.padEnd(cmdW);
		const lineText = head + body + '  ' + ts;

		if (isSel) {
			return truncateToWidth(prefix + th.fg('accent', lineText), width);
		}
		const prefixColored = th.fg(item.isPassed ? 'success' : 'error', statusMark);
		const rest = prefixColored + lineText.slice(statusMark.length);
		return truncateToWidth(prefix + rest, width);
	}

	/**
	 * 长值换行输出：首行 label + 值片段，续行缩进对齐（值按 visibleWidth 切成可容纳片段）。
	 * 用于详情页展示"全展开"的路径/长文本，不被单行截断丢弃。
	 */
	private wrapLongValue(label: string, value: string, width: number): string[] {
		const th = this.theme_;
		const padW = 2;
		const labelW = visibleWidth(label);
		const avail = Math.max(6, width - padW - labelW);
		const out: string[] = [];
		let rest = value;
		let first = true;
		if (!rest) {
			out.push(label);
			return out;
		}
		while (rest.length > 0) {
			let take = 0;
			let tw = 0;
			for (const ch of rest) {
				const cw = visibleWidth(ch);
				if (tw + cw > avail) break;
				take++;
				tw += cw;
			}
			if (take === 0) take = 1;
			const seg = rest.slice(0, take);
			rest = rest.slice(take);
			if (first) {
				out.push(label + seg);
				first = false;
			} else {
				out.push(th.fg('dim', '  ' + ' '.repeat(labelW - 2)) + seg);
			}
		}
		return out;
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
			lines.push(truncateToWidth(pad + th.fg('accent', `键: ${s.displayKey}`), width));
			const statusPart = s.isActive
				? th.fg('success', '  （下次匹配自动放行）')
				: th.fg('warning', '  （已达阈值）');
			lines.push(
				truncateToWidth(
					pad + th.fg('text', `计数: ${s.count} / 阈值: ${s.threshold}`) + statusPart,
					width,
				),
			);
			if (s.subCommand) {
				lines.push(
					truncateToWidth(
						pad + th.fg('text', `命令: ${sanitizeInline(s.subCommand)}`),
						width,
					),
				);
			}
		} else {
			const h = item as HistoryDisplayItem;
			const e = h.entry;
			lines.push(
				truncateToWidth(
					pad + th.fg('accent', `决策: ${DECISION_LABEL[e.decision]} (${e.decision})`),
					width,
				),
			);
			lines.push(
				truncateToWidth(
					pad + th.fg('text', `命中: ${e.reasons.join(', ') || 'N/A'}`),
					width,
				),
			);
			if (e.tier) {
				lines.push(
					truncateToWidth(pad + th.fg('text', `等级: ${tierLabel(e.tier)}`), width),
				);
			}
			lines.push(truncateToWidth(pad + th.fg('text', `工具: ${e.tool}`), width));
			lines.push(truncateToWidth(pad + th.fg('dim', `时间: ${e.ts}`), width));

			// 溯源（UX3）：项目路径全展开（超宽自动换行续行）+ 会话
			if (e.projectPath) {
				for (const l of this.wrapLongValue(
					pad + th.fg('accent', '项目: '),
					e.projectPath,
					width,
				)) {
					lines.push(truncateToWidth(l, width));
				}
			} else {
				lines.push(
					truncateToWidth(pad + th.fg('dim', '项目: 未知（旧记录未记录路径）'), width),
				);
			}
			if (e.sessionId) {
				if (!this.sessionNameCache.has(e.sessionId)) {
					this.sessionNameCache.set(
						e.sessionId,
						readSessionCurrentName(e.sessionId) ?? e.sessionName,
					);
				}
				const current = this.sessionNameCache.get(e.sessionId);
				const renamed =
					current && e.sessionName && current !== e.sessionName
						? `（改名自「${e.sessionName}」）`
						: '';
				lines.push(
					truncateToWidth(
						pad + th.fg('text', `会话: ${current || '未命名'}${renamed}`),
						width,
					),
				);
				lines.push(truncateToWidth(pad + th.fg('dim', `会话ID: ${e.sessionId}`), width));
			} else if (e.sessionName) {
				lines.push(truncateToWidth(pad + th.fg('text', `会话: ${e.sessionName}`), width));
			}

			// 命令摘要
			const cmdLabel = pad + th.fg('text', '命令: ');
			const cmdDisplay = sanitizeInline(e.command);
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

			// 原始完整命令（如有）
			if (e.originalCommand && e.originalCommand !== e.command) {
				const origLabel = pad + th.fg('text', '原始命令: ');
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
				const subsLabel = pad + th.fg('dim', `子命令: ${e.subCommands.join(' | ')}`);
				lines.push(truncateToWidth(subsLabel, width));
			}
		}

		return lines;
	}
}

function emptyStrategies(): LayerStrategies {
	return {
		session: { cmd: [], tool: [], dir: [] },
		project: { cmd: [], tool: [], dir: [] },
		user: { cmd: [], tool: [], dir: [] },
	};
}

// ============================================================================
// 入口函数
// ============================================================================

/**
 * 打开分层策略面板 overlay 并等待用户关闭。
 */
export async function showTwoTabPanel(
	ctx: ExtensionCommandContext,
	config: PermissionGateConfig,
	onConfigChanged: () => void,
): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		// SAFETY: ctx.ui.custom 回调的 theme 形参在 pi 运行时恒为 Theme 实例，
		// 此处仅窄化声明类型为 PanelTheme（PanelTheme 是 Theme 的语义色子集），无运行时转换。
		const th = theme as unknown as PanelTheme;
		const panel = new TwoTabPanel({
			tui,
			theme: th,
			onClose: () => done(),
			ctx,
			config,
			onConfigChanged,
		});
		return {
			render: (w: number) => panel.render(w),
			invalidate: () => panel.invalidate(),
			handleInput: (data: string) => panel.handleInput(data),
		};
	});
}
