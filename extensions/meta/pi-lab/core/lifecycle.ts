/**
 * lifecycle 生命周期信号源 — 把 pi-logger 的 `__lifecycle__` 事件投影成通用过程指标，
 * 按 turn 级归因到活跃实验臂（共享观测 + turnId 观测键）。
 *
 * 纯逻辑模块，不依赖 pi / pi-logger 运行时——输入是已解析的 lifecycle 事件形状。
 */

import type { MetricDef } from '../types.js';

// ── 通用过程指标（自动注入所有实验，tool_/turn_ 前缀隔离） ──

export const LIFECYCLE_METRIC_DEFS: MetricDef[] = [
	{
		id: 'tool_error_rate',
		type: 'continuous',
		direction: 'minimize',
		description: '工具报错率（0-1，自动采集）',
	},
	{
		id: 'tool_latency_ms',
		type: 'continuous',
		direction: 'minimize',
		description: '工具耗时总和（毫秒，自动采集）',
	},
	{
		id: 'turn_token_usage',
		type: 'continuous',
		direction: 'minimize',
		description: 'turn token 用量（自动采集）',
	},
];

// ── 增量 ──

/** 单条 lifecycle 事件投影出的增量（turn 内累积） */
export interface LifecycleDelta {
	toolErrorCount: number;
	toolCallCount: number;
	toolLatencySum: number;
	tokenSum: number;
}

export function zeroDelta(): LifecycleDelta {
	return { toolErrorCount: 0, toolCallCount: 0, toolLatencySum: 0, tokenSum: 0 };
}

/**
 * 自动注入通用指标到实验声明（已声明的 id 不覆盖，保留实验自声明版本）。
 * metrics 缺省（undefined）时仅注入通用指标——消费方经桥接注册可能绕过类型检查不传 metrics。
 */
export function injectLifecycleMetrics(metrics: MetricDef[] | undefined): MetricDef[] {
	const base = metrics ?? [];
	const existing = new Set(base.map((m) => m.id));
	const extra = LIFECYCLE_METRIC_DEFS.filter((m) => !existing.has(m.id));
	return [...base, ...extra];
}

/** 从 usage 对象稳健提取 token 总数（兼容 totalTokens / inputTokens+outputTokens 等常见字段） */
function extractTokenCount(usage: unknown): number {
	if (typeof usage === 'number') return usage;
	if (!usage || typeof usage !== 'object') return 0;
	const u = usage as Record<string, unknown>;
	if (typeof u.totalTokens === 'number') return u.totalTokens;
	if (typeof u.total_tokens === 'number') return u.total_tokens;
	const input = u.inputTokens ?? u.promptTokens ?? u.input_tokens ?? u.prompt_tokens;
	const output = u.outputTokens ?? u.completionTokens ?? u.output_tokens ?? u.completion_tokens;
	const i = typeof input === 'number' ? input : 0;
	const o = typeof output === 'number' ? output : 0;
	return i + o;
}

/**
 * 从一条 log 事件投影增量。仅识别 `__lifecycle__` source：
 *   - tool_execution_end：details 带 isError + duration
 *   - message_end：details 带 usage
 * 其余返回 null。
 */
export function extractLifecycleDelta(event: {
	source?: unknown;
	details?: unknown;
}): LifecycleDelta | null {
	if (event.source !== '__lifecycle__') return null;
	const d = event.details as Record<string, unknown> | null | undefined;
	if (!d || typeof d !== 'object') return null;

	// tool_execution_end：isError + duration 同时存在
	if (typeof d.isError === 'boolean' && typeof d.duration === 'number') {
		return {
			toolErrorCount: d.isError ? 1 : 0,
			toolCallCount: 1,
			toolLatencySum: d.duration,
			tokenSum: 0,
		};
	}

	// message_end：带 usage
	if (d.usage !== undefined) {
		const tokens = extractTokenCount(d.usage);
		if (tokens > 0) {
			return { toolErrorCount: 0, toolCallCount: 0, toolLatencySum: 0, tokenSum: tokens };
		}
	}

	return null;
}

// ── turn 级归因器 ──

/** turn 级归因：select 登记活跃臂 → 事件累积 → turn_end flush（共享观测 + turnId） */
export class TurnAttributor {
	private _activeArms = new Map<string, string>();
	private _delta: LifecycleDelta = zeroDelta();
	private _turnId: string | null = null;

	/** turn 开始：清空活跃臂与累积，重置观测键 */
	startTurn(turnId?: string): void {
		this._activeArms.clear();
		this._delta = zeroDelta();
		this._turnId = turnId ?? null;
	}

	/** 实验 select 时登记该 turn 的活跃臂（同实验后 select 覆盖先 select） */
	noteSelect(experimentName: string, armId: string): void {
		this._activeArms.set(experimentName, armId);
	}

	/** 累积一条 lifecycle 增量 */
	noteLifecycle(delta: LifecycleDelta): void {
		this._delta.toolErrorCount += delta.toolErrorCount;
		this._delta.toolCallCount += delta.toolCallCount;
		this._delta.toolLatencySum += delta.toolLatencySum;
		this._delta.tokenSum += delta.tokenSum;
	}

	/**
	 * turn 结束：把该 turn 聚合的通用指标 flush 到每个活跃实验臂。
	 * 共享观测——同一份指标复制到每个活跃臂（允许跨实验重复归因）。
	 */
	endTurn(): Array<{
		experimentName: string;
		armId: string;
		ctxKey: string;
		metrics: Record<string, number>;
		metadata: Record<string, unknown>;
	}> {
		const d = this._delta;
		const metrics: Record<string, number> = {
			tool_error_rate: d.toolCallCount > 0 ? d.toolErrorCount / d.toolCallCount : 0,
			tool_latency_ms: d.toolLatencySum,
			turn_token_usage: d.tokenSum,
		};
		const metadata: Record<string, unknown> = {};
		if (this._turnId) metadata.turnId = this._turnId;

		const results = [];
		for (const [experimentName, armId] of this._activeArms) {
			results.push({
				experimentName,
				armId,
				// ctxKey 硬编码 'global'：token 用量 / 工具耗时是 turn 级全局观测、无分桶语义。
				// 限制：当实验的 contextKey 解析为非 'global' 时，这些事件会进入全局「汇总」tab
				// （getEvents），但不会被「分桶」tab（queryByCtxKey）命中，两视图口径不一致。
				ctxKey: 'global',
				metrics: { ...metrics },
				metadata: { ...metadata },
			});
		}
		return results;
	}
}
