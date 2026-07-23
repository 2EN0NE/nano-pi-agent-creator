/**
 * quit — 退出时显示会话总结卡片
 *
 * 在退出时（原生 /quit 命令或 Ctrl+C）显示会话总结卡片
 * （含交互摘要、性能、模型用量）。
 *
 * 不再注册 /quit 命令——Pi 原生已提供，避免冲突。
 *
 * 分类：tui（交互界面）
 *
 * ── 增量计算设计 ──
 * 不在 session_shutdown 时遍历全部条目，而是在每次 turn_end 时
 * 增量处理新增条目。退出时只需最后一次 sync 即可渲染，O(1) 完成。
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createLogger } from '@zenone/pi-logger';
import { getModel } from '@earendil-works/pi-ai/compat';

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
	inputCost: number;
	outputCost: number;
	cacheReadCost: number;
	cacheWriteCost: number;
	totalCost: number;
}

interface BranchLabelInfo {
	branchCount: number;
	labelCount: number;
	lastLabel: string | undefined;
}

interface SessionCardData {
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

	// 模型用量：key = provider/model
	modelMap = new Map<string, ModelUsageRecord>();

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

				// 模型用量
				if (msg.role === 'assistant' && msg.provider && msg.model) {
					const provider = msg.provider as string;
					const model = msg.model as string;
					const key = `${provider}/${model}`;
					const usage = msg.usage as Record<string, unknown> | undefined;

					let rec = this.modelMap.get(key);
					if (!rec) {
						rec = {
							provider,
							model,
							requests: 0,
							inputTokens: 0,
							outputTokens: 0,
							cacheReadTokens: 0,
							cacheWriteTokens: 0,
							inputCost: 0,
							outputCost: 0,
							cacheReadCost: 0,
							cacheWriteCost: 0,
							totalCost: 0,
						};
						this.modelMap.set(key, rec);
					}
					rec.requests++;
					if (usage) {
						rec.inputTokens += (usage.input as number) ?? 0;
						rec.outputTokens += (usage.output as number) ?? 0;
						rec.cacheReadTokens += (usage.cacheRead as number) ?? 0;
						rec.cacheWriteTokens += (usage.cacheWrite as number) ?? 0;
					}
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
		this.modelMap.clear();
		this.labelCount = 0;
		this.lastLabel = undefined;
		this.processedIds.clear();
		this.parentCount.clear();
		this.branchCount = 0;
		this.totalEntriesSeen = 0;
	}

	/** 计算各模型费用（仅在退出时执行一次） */
	computeCosts(): { modelUsage: ModelUsageRecord[]; totalCost: number } {
		let totalCost = 0;
		const modelUsage: ModelUsageRecord[] = [];
		for (const rec of this.modelMap.values()) {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const modelDef = (getModel as any)(rec.provider, rec.model);
			if (modelDef) {
				const inputCost = (modelDef.cost.input / 1_000_000) * rec.inputTokens;
				const outputCost = (modelDef.cost.output / 1_000_000) * rec.outputTokens;
				const cacheReadCost = (modelDef.cost.cacheRead / 1_000_000) * rec.cacheReadTokens;
				const cacheWriteCost =
					(modelDef.cost.cacheWrite / 1_000_000) * rec.cacheWriteTokens;
				rec.inputCost = inputCost;
				rec.outputCost = outputCost;
				rec.cacheReadCost = cacheReadCost;
				rec.cacheWriteCost = cacheWriteCost;
				rec.totalCost = inputCost + outputCost + cacheReadCost + cacheWriteCost;
			} else {
				log.debug('模型定价未找到，费用将显示为 0', {
					provider: rec.provider,
					model: rec.model,
				});
			}
			totalCost += rec.totalCost;
			modelUsage.push(rec);
		}
		return { modelUsage, totalCost };
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

// ─── 从累加器构建卡片数据（O(costModels + entriesForBranchCount)，极快） ──────

function buildCardData(
	ctx: ExtensionContext,
	tracker: QuitTracker,
	accumulator: IncrementalCardAccumulator,
): SessionCardData {
	// 计算费用（O(uniqueModels)，通常 1~3）
	const { modelUsage, totalCost } = accumulator.computeCosts();

	// 分支/Label 信息：纯内存读取（O(1)，已在增量中追踪）
	const branchLabels = accumulator.getBranchLabelInfo();

	const sessionId = ctx.sessionManager.getSessionId() ?? 'unknown';
	const sessionFile = ctx.sessionManager.getSessionFile() ?? '';

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
	};
}

// ─── 卡片渲染 ───────────────────────────────────────────────────────────────

/**
 * 获取主题的 ANSI 颜色函数。
 * 如果 theme 不可用，返回回退函数。
 */
function getColorFn(theme: ExtensionContext['ui']['theme'] | undefined) {
	const ansiFg = (code: number, text: string) => `\x1b[38;5;${code}m${text}\x1b[0m`;
	const ansiBold = (text: string) => `\x1b[1m${text}\x1b[0m`;

	if (!theme) {
		return {
			fg: (token: string, text: string) => {
				const fallback: Record<string, number> = {
					accent: 39,
					borderMuted: 242,
					border: 243,
					dim: 240,
					success: 76,
					error: 196,
					warning: 214,
					muted: 242,
					text: 0,
					toolTitle: 39,
					thinkingText: 242,
				};
				return ansiFg(fallback[token] ?? 0, text);
			},
			bold: ansiBold,
		};
	}

	return {
		fg: (token: string, text: string) => theme.fg(token as any, text),
		bold: (text: string) => theme.bold(text),
	};
}

/** 移除 ANSI 转义码后获取终端显示宽度 */
function displayWidth(s: string): number {
	const cleaned = s.replace(/\x1b\[[0-9;]*m/g, '');
	let width = 0;
	for (const ch of cleaned) {
		const code = ch.charCodeAt(0);
		if (
			code >= 0x1100 &&
			(code <= 0x115f ||
				code === 0x2329 ||
				code === 0x232a ||
				(code >= 0x2e80 && code <= 0x303e) ||
				(code >= 0x3040 && code <= 0x33ff) ||
				(code >= 0x3400 && code <= 0x4dbf) ||
				(code >= 0x4e00 && code <= 0x9fff) ||
				(code >= 0xa000 && code <= 0xa4cf) ||
				(code >= 0xac00 && code <= 0xd7af) ||
				(code >= 0xf900 && code <= 0xfaff) ||
				(code >= 0xfe10 && code <= 0xfe19) ||
				(code >= 0xfe30 && code <= 0xfe6f) ||
				(code >= 0xff01 && code <= 0xff60) ||
				(code >= 0xffe0 && code <= 0xffe6) ||
				(code >= 0x1f000 && code <= 0x1ffff))
		) {
			width += 2;
		} else {
			width += 1;
		}
	}
	return width;
}

const visibleLen = displayWidth;

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

function renderCard(data: SessionCardData, theme?: ExtensionContext['ui']['theme']): string[] {
	const c = getColorFn(theme);
	const { fg, bold } = c;
	const borderColor = (text: string) => fg('border', text);
	const mutedColor = (text: string) => fg('dim', text);
	const accentColor = (text: string) => fg('accent', text);
	const successColor = (text: string) => fg('success', text);
	const errorColor = (text: string) => fg('error', text);
	const warningColor = (text: string) => fg('warning', text);

	const lines: string[] = [];
	const W = 64;
	const tw = termWidth();
	const indent = ' '.repeat(Math.max(0, Math.floor((tw - W) / 2)));

	// 顶部边框
	lines.push(indent + borderColor(`┌${'─'.repeat(W - 2)}┐`));
	// 标题（居中）
	const titleStr = 'Session Summary  会话总结卡片';
	const titlePadding = Math.max(0, W - 2 - visibleLen(titleStr));
	const titleLeft = Math.floor(titlePadding / 2);
	const titleRight = titlePadding - titleLeft;
	lines.push(
		indent +
			borderColor('│') +
			' '.repeat(titleLeft) +
			accentColor(bold(titleStr)) +
			' '.repeat(titleRight) +
			borderColor('│'),
	);

	// 分隔线
	lines.push(indent + borderColor(`├${'─'.repeat(W - 2)}┤`));

	// 交互摘要
	const sectionLabel = '交互摘要 Interaction';
	lines.push(
		indent +
			borderColor('│') +
			'  ' +
			accentColor(bold(sectionLabel)) +
			' '.repeat(Math.max(0, W - 4 - visibleLen(sectionLabel))) +
			borderColor('│'),
	);

	const sid =
		data.sessionId.length > W - 12 ? data.sessionId.slice(0, W - 15) + '…' : data.sessionId;
	lines.push(
		indent +
			borderColor('│') +
			`    ${mutedColor('会话 ID')}: ${fg('text', sid)}` +
			' '.repeat(Math.max(0, W - 2 - displayWidth('    会话 ID: ') - sid.length)) +
			borderColor('│'),
	);

	const { total, success, failed } = data.toolCalls;
	const successRate = total > 0 ? Math.round((success / total) * 100) : 0;
	const rateFn = successRate >= 80 ? successColor : warningColor;
	const toolLine = `    ${mutedColor('工具调用')}: ${fg('text', String(total))} ${mutedColor('次 ·')} ${successColor(String(success))} ${mutedColor('成功 ·')} ${errorColor(String(failed))} ${mutedColor('失败 · 成功率')} ${rateFn(`(${successRate}%)`)}`;
	lines.push(
		indent +
			borderColor('│') +
			toolLine +
			' '.repeat(Math.max(0, W - 2 - displayWidth(toolLine))) +
			borderColor('│'),
	);

	const { branchCount, labelCount, lastLabel } = data.branchLabels;
	const treeLine = `    ${mutedColor('/tree')}: ${fg('text', String(branchCount))} ${mutedColor('个分支 ·')} ${fg('text', String(labelCount))} ${mutedColor('个标签')}`;
	lines.push(
		indent +
			borderColor('│') +
			treeLine +
			' '.repeat(Math.max(0, W - 2 - displayWidth(treeLine))) +
			borderColor('│'),
	);

	if (lastLabel) {
		const labelLine = `    ${mutedColor('最后标签')}: ${fg('accent', lastLabel)}`;
		lines.push(
			indent +
				borderColor('│') +
				labelLine +
				' '.repeat(Math.max(0, W - 2 - displayWidth(labelLine))) +
				borderColor('│'),
		);
	}

	// 分隔线
	lines.push(indent + borderColor(`├${'─'.repeat(W - 2)}┤`));

	// 性能
	const perfLabel = '性能 Performance';
	lines.push(
		indent +
			borderColor('│') +
			'  ' +
			accentColor(bold(perfLabel)) +
			' '.repeat(Math.max(0, W - 4 - visibleLen(perfLabel))) +
			borderColor('│'),
	);

	const dur = formatDuration(data.totalDurationMs);
	lines.push(
		indent +
			borderColor('│') +
			`    ${mutedColor('总耗时')}: ${fg('text', dur)}` +
			' '.repeat(Math.max(0, W - 2 - displayWidth('    总耗时: ') - dur.length)) +
			borderColor('│'),
	);

	const agent = formatDuration(data.agentActiveMs);
	lines.push(
		indent +
			borderColor('│') +
			`    ${mutedColor('智能体活跃')}: ${fg('text', agent)}` +
			' '.repeat(Math.max(0, W - 2 - displayWidth('    智能体活跃: ') - agent.length)) +
			borderColor('│'),
	);

	const api = formatDuration(data.apiCallMs);
	lines.push(
		indent +
			borderColor('│') +
			`    ${mutedColor('API 调用')}: ${fg('text', api)}` +
			' '.repeat(Math.max(0, W - 2 - displayWidth('    API 调用: ') - api.length)) +
			borderColor('│'),
	);

	const toolExec = formatDuration(data.toolExecMs);
	lines.push(
		indent +
			borderColor('│') +
			`    ${mutedColor('工具执行')}: ${fg('text', toolExec)}` +
			' '.repeat(Math.max(0, W - 2 - displayWidth('    工具执行: ') - toolExec.length)) +
			borderColor('│'),
	);

	// 分隔线
	lines.push(indent + borderColor(`├${'─'.repeat(W - 2)}┤`));

	// 模型使用
	const modelLabel = '模型使用 Model Usage';
	lines.push(
		indent +
			borderColor('│') +
			'  ' +
			accentColor(bold(modelLabel)) +
			' '.repeat(Math.max(0, W - 4 - visibleLen(modelLabel))) +
			borderColor('│'),
	);

	if (data.modelUsage.length === 0) {
		const emptyLabel = '(无模型调用数据)';
		lines.push(
			indent +
				borderColor('│') +
				`    ${mutedColor(emptyLabel)}` +
				' '.repeat(Math.max(0, W - 2 - 4 - displayWidth(emptyLabel))) +
				borderColor('│'),
		);
	} else {
		const hModel = mutedColor('模型');
		const hReq = mutedColor('请求');
		const hIn = mutedColor('输入');
		const hOut = mutedColor('输出');
		const hCost = mutedColor('费用');
		const headerLine = `    ${hModel}${' '.repeat(Math.max(1, 24 - 4))}${hReq}  ${hIn}  ${hOut}  ${hCost}`;
		lines.push(
			indent +
				borderColor('│') +
				headerLine +
				' '.repeat(Math.max(0, W - 2 - displayWidth(headerLine))) +
				borderColor('│'),
		);

		for (const mu of data.modelUsage) {
			const name = `${mu.provider}/${mu.model}`;
			const displayName = name.length > 24 ? '…' + name.slice(-23) : name;
			const reqStr = String(mu.requests);
			const inStr = formatTokens(mu.inputTokens);
			const outStr = formatTokens(mu.outputTokens);
			const costStr = formatCost(mu.totalCost);
			const row = `    ${fg('text', displayName)}${' '.repeat(Math.max(1, 26 - displayName.length))}${fg('text', reqStr)}  ${fg('text', inStr)}  ${fg('text', outStr)}  ${fg('text', costStr)}`;
			const padding = Math.max(0, W - 2 - displayWidth(row));
			lines.push(indent + borderColor('│') + row + ' '.repeat(padding) + borderColor('│'));
		}

		const totalCostLabel = mutedColor('总计费用');
		const totalCostStr = successColor(formatCost(data.totalCost));
		const totalLine = `    ${totalCostLabel}:  ${totalCostStr}`;
		const totalPadding = Math.max(0, W - 2 - displayWidth(totalLine));
		lines.push(
			indent + borderColor('│') + totalLine + ' '.repeat(totalPadding) + borderColor('│'),
		);
	}

	// 底部边框
	lines.push(indent + borderColor(`└${'─'.repeat(W - 2)}┘`));

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
			'Incremental sync: toolSuccess=%d toolFailed=%d toolTotal=%d models=%d labels=%d seen=%d',
			accumulator.toolSuccess,
			accumulator.toolFailed,
			accumulator.toolTotal,
			accumulator.modelMap.size,
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
