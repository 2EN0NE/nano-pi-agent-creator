/**
 * quit — 退出时显示会话总结卡片
 *
 * 在退出时（原生 /quit 命令或 Ctrl+C）显示会话总结卡片
 * （含交互摘要、性能、模型用量、分支费用）。
 *
 * 不再注册 /quit 命令——Pi 原生已提供，避免冲突。
 *
 * 分类：tui（交互界面）
 *
 * ── 计算设计 ──
 * 交互摘要（工具调用/标签/分支计数）在 turn_end 时增量累加，退出时 O(1) 读取。
 * 金额（模型分桶 + 各分支叶子费用）在退出时一次性全量遍历 getEntries/getTree，
 * 口径对齐内置 footer（累加 usage.cost.total），O(entries)。
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
	SessionTreeNode,
} from '@earendil-works/pi-coding-agent';
import type { Usage } from '@earendil-works/pi-ai';
import { createLogger } from '@zenone/pi-logger';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { bottomBorder, topBorder } from '../../src/tui/helpers.js';

const log = createLogger('quit');

// ─── 类型 ───────────────────────────────────────────────────────────────────

interface ToolCallRecord {
	success: number;
	failed: number;
	total: number;
}

interface ModelUsageRecord {
	provider: string;
	model: string;
	requests: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalCost: number; // usage.cost.total 累加（官方口径，对齐内置 footer）
}

interface BranchLabelInfo {
	branchCount: number;
	labelCount: number;
	lastLabel: string | undefined;
}

/** 单条 root→leaf 分支路径的累计用量/费用。 */
export interface BranchCostInfo {
	leafId: string;
	summary: string;
	cost: number;
	tokens: number;
	entryCount: number;
	isCurrent: boolean;
}

export interface SessionCardData {
	sessionId: string;
	sessionFile: string;
	toolCalls: ToolCallRecord;
	branchLabels: BranchLabelInfo;
	totalDurationMs: number;
	agentActiveMs: number;
	apiCallMs: number;
	toolExecMs: number;
	modelUsage: ModelUsageRecord[];
	totalCost: number;
	branchCosts: BranchCostInfo[];
}

// ─── 增量累加器 ─────────────────────────────────────────────────────────────────
//
// 在 turn_end 时增量处理新条目，避免退出时全量遍历。
// 同时追踪已处理的条目 ID 集合，防止 /reload 后重复计数。

class IncrementalCardAccumulator {
	// 工具调用计数
	toolSuccess = 0;
	toolFailed = 0;
	toolTotal = 0;

	// Label 信息
	labelCount = 0;
	lastLabel: string | undefined;

	// Branch 信息：增量化 parentId 计数
	private parentCount = new Map<string | null, number>();
	branchCount = 0;

	// 标记已处理过的条目 ID，避免 /reload 后重复计数
	private processedIds = new Set<string>();

	/** 总条目数（仅用于日志） */
	totalEntriesSeen = 0;

	/** 增量处理一批条目 */
	processNewEntries(entries: Array<Record<string, unknown>>): void {
		for (const entry of entries) {
			// 跳过已处理的
			const entryId = entry.id as string | undefined;
			if (entryId && this.processedIds.has(entryId)) continue;
			if (entryId) this.processedIds.add(entryId);

			this.totalEntriesSeen++;

			if (entry.type === 'session') continue;

			// parentId 追踪（用于分支计数）
			const pid = (entry.parentId as string | null) ?? null;
			const prevCount = this.parentCount.get(pid) ?? 0;
			this.parentCount.set(pid, prevCount + 1);
			if (prevCount === 1) {
				// 刚好从 1 → 2，新增一个分支
				this.branchCount++;
			}

			if (entry.type === 'message') {
				const msg = entry.message as Record<string, unknown> | undefined;
				if (!msg) continue;

				// 工具调用结果
				if (msg.role === 'toolResult') {
					this.toolTotal++;
					if (msg.isError) this.toolFailed++;
					else this.toolSuccess++;
				}
			}

			// Label 条目
			if (entry.type === 'label') {
				this.labelCount++;
				const label = entry.label as string | undefined;
				if (label) this.lastLabel = label;
			}
		}
	}

	/** 重置累加器（新会话时调用） */
	reset(): void {
		this.toolSuccess = 0;
		this.toolFailed = 0;
		this.toolTotal = 0;
		this.labelCount = 0;
		this.lastLabel = undefined;
		this.processedIds.clear();
		this.parentCount.clear();
		this.branchCount = 0;
		this.totalEntriesSeen = 0;
	}

	/** 获取分支/Label 信息（纯内存读取，O(1)） */
	getBranchLabelInfo(): BranchLabelInfo {
		return {
			branchCount: this.branchCount,
			labelCount: this.labelCount,
			lastLabel: this.lastLabel,
		};
	}
}

// ─── 追踪器（已有，保持兼容） ─────────────────────────────────────────────────

class QuitTracker {
	sessionStartMs = 0;
	agentActiveMs = 0;
	agentStartMs = 0;
	apiCallMs = 0;
	toolExecMs = 0;
	private _toolTimers = new Map<string, number>();
	private _apiStartMs = 0;

	reset(startMs: number): void {
		this.sessionStartMs = startMs;
		this.agentActiveMs = 0;
		this.agentStartMs = 0;
		this.apiCallMs = 0;
		this.toolExecMs = 0;
		this._toolTimers.clear();
		this._apiStartMs = 0;
	}

	onAgentStart(): void {
		this.agentStartMs = Date.now();
	}

	onAgentEnd(): void {
		if (this.agentStartMs > 0) {
			this.agentActiveMs += Date.now() - this.agentStartMs;
			this.agentStartMs = 0;
		}
	}

	onTurnStart(): void {
		this._apiStartMs = Date.now();
	}

	onTurnEnd(): void {
		if (this._apiStartMs > 0) {
			this.apiCallMs += Date.now() - this._apiStartMs;
			this._apiStartMs = 0;
		}
	}

	onToolStart(toolCallId: string): void {
		this._toolTimers.set(toolCallId, Date.now());
	}

	onToolEnd(toolCallId: string): void {
		const start = this._toolTimers.get(toolCallId);
		if (start !== undefined) {
			this.toolExecMs += Date.now() - start;
			this._toolTimers.delete(toolCallId);
		}
	}
}

// ─── 用量/费用聚合（官方口径：累加 usage.cost.total） ──────────────────────────
//
// 对齐内置 footer（FooterComponent / usage-totals.js）：
//   - assistant 消息按 `${provider}/${responseModel ?? model}` 分桶
//   - toolResult / compaction / branch_summary 的 usage 归入 "Tools/summaries"
//   - 费用一律累加 usage.cost.total，不再用静态目录价自行推算

/** 返回条目可计费的 usage（对齐 footer 的四类来源），否则 undefined。 */
function usageOfEntry(entry: SessionEntry): Usage | undefined {
	if (entry.type === 'message') {
		if (entry.message.role === 'assistant') return entry.message.usage;
		if (entry.message.role === 'toolResult' && entry.message.usage) return entry.message.usage;
		return undefined;
	}
	if (entry.type === 'compaction' || entry.type === 'branch_summary') return entry.usage;
	return undefined;
}

export function aggregateModelUsage(entries: SessionEntry[]): {
	modelUsage: ModelUsageRecord[];
	totalCost: number;
} {
	const map = new Map<string, ModelUsageRecord>();
	let totalCost = 0;

	for (const entry of entries) {
		let key: string | null = null;
		let usage: Usage | undefined;

		if (entry.type === 'message' && entry.message.role === 'assistant') {
			key = `${entry.message.provider}/${entry.message.responseModel ?? entry.message.model}`;
			usage = entry.message.usage;
		} else if (
			entry.type === 'message' &&
			entry.message.role === 'toolResult' &&
			entry.message.usage
		) {
			key = 'Tools/summaries';
			usage = entry.message.usage;
		} else if (
			(entry.type === 'compaction' || entry.type === 'branch_summary') &&
			entry.usage
		) {
			key = 'Tools/summaries';
			usage = entry.usage;
		}

		if (!key || !usage) continue;

		let rec = map.get(key);
		if (!rec) {
			rec = {
				provider: '',
				model: '',
				requests: 0,
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				totalCost: 0,
			};
			map.set(key, rec);
		}
		rec.requests++;
		rec.inputTokens += usage.input;
		rec.outputTokens += usage.output;
		rec.cacheReadTokens += usage.cacheRead;
		rec.cacheWriteTokens += usage.cacheWrite;
		rec.totalCost += usage.cost.total;
		totalCost += usage.cost.total;
	}

	const modelUsage: ModelUsageRecord[] = [];
	for (const [key, rec] of map.entries()) {
		const slash = key.indexOf('/');
		rec.provider = slash === -1 ? key : key.slice(0, slash);
		rec.model = slash === -1 ? '' : key.slice(slash + 1);
		modelUsage.push(rec);
	}
	modelUsage.sort((a, b) => b.totalCost - a.totalCost);

	return { modelUsage, totalCost };
}

// ─── 分支费用聚合 ────────────────────────────────────────────────────────────
//
// getTree() 返回完整会话树。每条 root→leaf 路径是一条分支；共享祖先会
// 计入其下每一条分支（与 pi-branch-cost-footer 的语义一致）。

function collectLeafPaths(
	nodes: SessionTreeNode[],
	path: SessionEntry[],
	out: Array<{ path: SessionEntry[]; leafId: string }>,
): void {
	for (const node of nodes) {
		const nextPath = [...path, node.entry];
		if (node.children.length === 0) {
			out.push({ path: nextPath, leafId: node.entry.id });
		} else {
			collectLeafPaths(node.children, nextPath, out);
		}
	}
}

/** 用路径上最后一条用户消息作为分支摘要，否则退回叶子条目类型+id。 */
function summarizeBranch(path: SessionEntry[]): string {
	for (let i = path.length - 1; i >= 0; i--) {
		const entry = path[i];
		if (entry.type !== 'message' || entry.message.role !== 'user') continue;

		const content = entry.message.content;
		let text = '';
		if (typeof content === 'string') {
			text = content;
		} else if (Array.isArray(content)) {
			text = content
				.map((c) => {
					if (typeof c === 'string') return c;
					return (c as { text?: string }).text ?? '';
				})
				.join(' ');
		}
		text = text.trim().replace(/\s+/g, ' ');
		if (!text) continue;
		return text.length > 28 ? text.slice(0, 28) + '…' : text;
	}

	const leaf = path[path.length - 1];
	return `${leaf.type}@${leaf.id.slice(0, 8)}`;
}

export function aggregateBranchCosts(
	tree: SessionTreeNode[],
	currentLeafId: string | null,
): BranchCostInfo[] {
	const paths: Array<{ path: SessionEntry[]; leafId: string }> = [];
	collectLeafPaths(tree, [], paths);

	const result: BranchCostInfo[] = paths.map(({ path, leafId }) => {
		let cost = 0;
		let tokens = 0;
		for (const entry of path) {
			const usage = usageOfEntry(entry);
			if (!usage) continue;
			cost += usage.cost.total;
			tokens += usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
		}
		return {
			leafId,
			summary: summarizeBranch(path),
			cost,
			tokens,
			entryCount: path.length,
			isCurrent: leafId === currentLeafId,
		};
	});

	// 当前分支排最前，其余按费用降序
	result.sort((a, b) => {
		if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
		return b.cost - a.cost;
	});
	return result;
}

// ─── 从累加器构建卡片数据（金额部分退出时一次性全量遍历，O(entries)） ──────

function buildCardData(
	ctx: ExtensionContext,
	tracker: QuitTracker,
	accumulator: IncrementalCardAccumulator,
): SessionCardData {
	const sessionManager = ctx.sessionManager;

	// 总金额 + 模型分桶：官方口径，全量条目（对齐 footer 的 getEntries）
	const { modelUsage, totalCost } = aggregateModelUsage(
		sessionManager.getEntries() as SessionEntry[],
	);

	// 各分支费用：树遍历每条 root→leaf 路径
	const branchCosts = aggregateBranchCosts(
		sessionManager.getTree() as SessionTreeNode[],
		sessionManager.getLeafId(),
	);

	// 分支/Label 信息：纯内存读取（O(1)，已在增量中追踪）
	const branchLabels = accumulator.getBranchLabelInfo();

	const sessionId = sessionManager.getSessionId() ?? 'unknown';
	const sessionFile = sessionManager.getSessionFile() ?? '';

	return {
		sessionId,
		sessionFile,
		toolCalls: {
			total: accumulator.toolTotal,
			success: accumulator.toolSuccess,
			failed: accumulator.toolFailed,
		},
		branchLabels,
		totalDurationMs: Date.now() - tracker.sessionStartMs,
		agentActiveMs: tracker.agentActiveMs,
		apiCallMs: tracker.apiCallMs,
		toolExecMs: tracker.toolExecMs,
		modelUsage,
		totalCost,
		branchCosts,
	};
}

// ─── 卡片渲染 ───────────────────────────────────────────────────────────────

/**
 * 获取主题的 ANSI 颜色函数。
 * 如果 theme 不可用，返回回退函数。
 */
function getColorFn(theme: ExtensionContext['ui']['theme'] | undefined) {
	if (!theme) {
		// theme 不可用时降级为纯文本（ADR-0023：禁用硬编码 ANSI）
		return {
			fg: (_token: string, text: string) => text,
			bold: (text: string) => text,
		};
	}

	return {
		fg: (token: string, text: string) => theme.fg(token as any, text),
		bold: (text: string) => theme.bold(text),
	};
}

function termWidth(): number {
	return process.stdout.columns ?? 80;
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const sec = Math.round(ms / 1000);
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	const s = sec % 60;
	if (min < 60) return `${min}m ${s}s`;
	const hour = Math.floor(min / 60);
	const m = min % 60;
	return `${hour}h ${m}m ${s}s`;
}

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

function formatCost(n: number): string {
	if (n === 0) return '$0';
	if (n < 0.01) return '<$0.01';
	return `$${n.toFixed(2)}`;
}

export function renderCard(
	data: SessionCardData,
	theme?: ExtensionContext['ui']['theme'],
	width?: number,
): string[] {
	const c = getColorFn(theme);
	const { fg, bold } = c;
	const borderColor = (text: string) => fg('border', text);
	const mutedColor = (text: string) => fg('dim', text);
	const accentColor = (text: string) => fg('accent', text);
	const successColor = (text: string) => fg('success', text);
	const errorColor = (text: string) => fg('error', text);
	const warningColor = (text: string) => fg('warning', text);

	const lines: string[] = [];
	const tw = width ?? termWidth();
	// 卡片宽自适应终端：窄终端（<64 列）收窄避免溢出；W 恒 ≤ tw，任何宽度下不超视口。
	const W = Math.min(64, tw);
	const indent = ' '.repeat(Math.max(0, Math.floor((tw - W) / 2)));
	const sepLine = indent + ' ' + borderColor(bottomBorder(W - 2)) + ' ';

	// 内容行：缩进 + truncate 兜底（ADR-0023 纯横线：无竖线无 rightPad）
	const row = (content: string): string => indent + truncateToWidth(content, W);

	// 顶边框（纯横线 + 插件名）：truncate 兜底，避免极窄终端（<8 列）下插件名行溢出
	lines.push(truncateToWidth(indent + borderColor(topBorder('── quit ', W)), tw));
	lines.push(row('  ' + accentColor(bold('Session Summary  会话总结卡片'))));
	lines.push(sepLine);

	// 交互摘要
	lines.push(row('  ' + accentColor(bold('交互摘要 Interaction'))));
	const sid =
		visibleWidth(data.sessionId) > W - 12
			? data.sessionId.slice(0, W - 15) + '…'
			: data.sessionId;
	lines.push(row(`    ${mutedColor('会话 ID')}: ${fg('text', sid)}`));

	const { total, success, failed } = data.toolCalls;
	const successRate = total > 0 ? Math.round((success / total) * 100) : 0;
	const rateFn = successRate >= 80 ? successColor : warningColor;
	const toolLine = `    ${mutedColor('工具调用')}: ${fg('text', String(total))} ${mutedColor('次 ·')} ${successColor(String(success))} ${mutedColor('成功 ·')} ${errorColor(String(failed))} ${mutedColor('失败 · 成功率')} ${rateFn(`(${successRate}%)`)}`;
	lines.push(row(toolLine));

	const { branchCount, labelCount, lastLabel } = data.branchLabels;
	const treeLine = `    ${mutedColor('/tree')}: ${fg('text', String(branchCount))} ${mutedColor('个分支 ·')} ${fg('text', String(labelCount))} ${mutedColor('个标签')}`;
	lines.push(row(treeLine));

	if (lastLabel) {
		lines.push(row(`    ${mutedColor('最后标签')}: ${fg('accent', lastLabel)}`));
	}

	lines.push(sepLine);

	// 性能
	lines.push(row('  ' + accentColor(bold('性能 Performance'))));
	lines.push(
		row(`    ${mutedColor('总耗时')}: ${fg('text', formatDuration(data.totalDurationMs))}`),
	);
	lines.push(
		row(`    ${mutedColor('智能体活跃')}: ${fg('text', formatDuration(data.agentActiveMs))}`),
	);
	lines.push(row(`    ${mutedColor('API 调用')}: ${fg('text', formatDuration(data.apiCallMs))}`));
	lines.push(
		row(`    ${mutedColor('工具执行')}: ${fg('text', formatDuration(data.toolExecMs))}`),
	);

	lines.push(sepLine);

	// 模型使用
	lines.push(row('  ' + accentColor(bold('模型使用 Model Usage'))));
	if (data.modelUsage.length === 0) {
		lines.push(row('    ' + mutedColor('(无模型调用数据)')));
	} else {
		const hModel = mutedColor('模型');
		const hReq = mutedColor('请求');
		const hIn = mutedColor('输入');
		const hOut = mutedColor('输出');
		const hCost = mutedColor('费用');
		const headerLine = `    ${hModel}${' '.repeat(Math.max(1, 24 - 4))}${hReq}  ${hIn}  ${hOut}  ${hCost}`;
		lines.push(row(headerLine));

		for (const mu of data.modelUsage) {
			const name = `${mu.provider}/${mu.model}`;
			const displayName = visibleWidth(name) > 24 ? '…' + name.slice(-23) : name;
			const reqStr = String(mu.requests);
			const inStr = formatTokens(mu.inputTokens);
			const outStr = formatTokens(mu.outputTokens);
			const costStr = formatCost(mu.totalCost);
			const rowStr = `    ${fg('text', displayName)}${' '.repeat(Math.max(1, 26 - visibleWidth(displayName)))}${fg('text', reqStr)}  ${fg('text', inStr)}  ${fg('text', outStr)}  ${fg('text', costStr)}`;
			lines.push(row(rowStr));
		}
	}

	// 分支费用（各分支金额 + 总计）
	lines.push(sepLine);
	lines.push(row('  ' + accentColor(bold('分支费用 Branch Costs'))));
	if (data.branchCosts.length === 0) {
		lines.push(row('    ' + mutedColor('(无分支数据)')));
	} else {
		for (let i = 0; i < data.branchCosts.length; i++) {
			const bc = data.branchCosts[i];
			const marker = bc.isCurrent ? accentColor('>') : ' ';
			const curTag = bc.isCurrent ? ` ${successColor('当前')}` : '';
			const head = `    ${marker} ${mutedColor('分支')} ${fg('text', String(i + 1))}${curTag}:`;
			const body = `${successColor(formatCost(bc.cost))} · ${fg('text', formatTokens(bc.tokens))} ${mutedColor('tokens ·')} ${fg('text', String(bc.entryCount))} ${mutedColor('条')}`;
			lines.push(row(head + ' ' + body));

			if (bc.summary) {
				const summary =
					visibleWidth(bc.summary) > 22 ? bc.summary.slice(0, 21) + '…' : bc.summary;
				lines.push(row(`      ${mutedColor('→')} ${fg('text', summary)}`));
			}
		}
	}
	lines.push(row(`    ${mutedColor('总计费用')}:  ${successColor(formatCost(data.totalCost))}`));

	// 底边框（纯横线）
	lines.push(indent + borderColor(bottomBorder(W)));

	return lines;
}

// ─── 输出到终端 ──────────────────────────────────────────────────────────────

function printCard(data: SessionCardData, theme?: ExtensionContext['ui']['theme']): void {
	const lines = renderCard(data, theme);
	process.stdout.write('\n');
	for (const line of lines) {
		process.stdout.write(line + '\n');
	}
	process.stdout.write('\n');
}

// ─── 主入口 ──────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
	const tracker = new QuitTracker();
	const accumulator = new IncrementalCardAccumulator();
	let sessionStarted = false;

	function syncIncremental(ctx: ExtensionContext): void {
		// SAFETY: sessionManager.getBranch() 返回 session tree 的 branch 节点数组，
		// 每个节点是 JSON-like entry（Record<string, unknown>），此处仅用于增量累加器遍历。
		const branch = ctx.sessionManager.getBranch() as unknown as Array<Record<string, unknown>>;
		accumulator.processNewEntries(branch);
	}

	pi.on('session_start', async (_event: unknown, _ctx: ExtensionContext) => {
		if (sessionStarted) return;
		sessionStarted = true;
		tracker.reset(Date.now());
		accumulator.reset();
		log.info('session_start: quit tracker + accumulator reset');
	});

	pi.on('agent_start', async () => {
		tracker.onAgentStart();
	});

	pi.on('agent_end', async () => {
		tracker.onAgentEnd();
	});

	pi.on('turn_start', async () => {
		tracker.onTurnStart();
	});

	pi.on('turn_end', async (_event, ctx) => {
		tracker.onTurnEnd();

		// 增量处理：每次 turn 结束后处理新增条目
		syncIncremental(ctx);

		log.debug(
			'Incremental sync: toolSuccess=%d toolFailed=%d toolTotal=%d labels=%d seen=%d',
			accumulator.toolSuccess,
			accumulator.toolFailed,
			accumulator.toolTotal,
			accumulator.labelCount,
			accumulator.totalEntriesSeen,
		);
	});

	pi.on('tool_execution_start', async (event: { toolCallId: string }) => {
		tracker.onToolStart(event.toolCallId);
	});

	pi.on('tool_execution_end', async (event: { toolCallId: string }) => {
		tracker.onToolEnd(event.toolCallId);
	});

	// ── Ctrl+C / 原生 /quit 退出拦截 ──
	pi.on('session_shutdown', async (event: { reason: string }, ctx: ExtensionContext) => {
		if (event.reason === 'quit') {
			const sdT0 = Date.now();
			log.info('session_shutdown(quit) start');

			// 确保 agent_time 计算完毕
			if (tracker.agentStartMs > 0) {
				tracker.onAgentEnd();
			}

			const sdT1 = Date.now();
			log.info('quit:timing:session_shutdown: agentEndFix=%dms', sdT1 - sdT0);

			// 最后一次增量同步（捕获最后一轮的新条目）
			syncIncremental(ctx);
			const sdT2 = Date.now();
			log.info('quit:timing:syncIncremental=%dms', sdT2 - sdT1);

			// 直接从累加器构建卡片（O(costModels + entriesForBranchCount)）
			const data = buildCardData(ctx, tracker, accumulator);
			const sdT3 = Date.now();
			log.info('quit:timing:buildCardData=%dms', sdT3 - sdT2);

			printCard(data, ctx.ui?.theme);
			const sdT4 = Date.now();
			log.info(
				'quit:timing:printCard=%dms total=%dms card_toolCalls=%d uniqueModels=%d totalCost=%s entriesSeen=%d',
				sdT4 - sdT3,
				sdT4 - sdT0,
				data.toolCalls.total,
				data.modelUsage.length,
				data.totalCost.toFixed(4),
				accumulator.totalEntriesSeen,
			);
		}
	});
}
