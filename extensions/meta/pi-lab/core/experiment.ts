/**
 * 单个实验实例：select → record → stats
 */

import type {
	AllocationStrategy,
	ArmAggregate,
	ArmDef,
	ContextKeyFn,
	MetricAggregate,
	MetricDef,
	Outcome,
	QueryResult,
} from '../types.js';
import { stableHashAssign } from './allocation.js';
import { analyzeMetric, projectMetricValue } from './analysis.js';
import { ExperimentStorage } from './storage.js';

export class Experiment {
	private _name: string;
	private _strategy: AllocationStrategy;
	private _arms: ArmDef[];
	private _metrics: MetricDef[];
	private _contextKey: ContextKeyFn<any> | string;
	private _assignKey: ContextKeyFn<any> | string;
	private _storage: ExperimentStorage;
	private _forceArmId: string | null = null;
	/** 已摄入的异步信号幂等键（去重，跨 /reload 从事件流重建） */
	private _dedupKeys = new Set<string>();
	/** query 结果缓存（事件流变化时失效），避免面板每次 render 重跑蒙特卡洛 */
	private _queryCache = new Map<string, QueryResult>();

	constructor(
		name: string,
		strategy: AllocationStrategy,
		arms: ArmDef[],
		metrics: MetricDef[],
		contextKey: ContextKeyFn<any> | string,
		assignKey?: ContextKeyFn<any> | string,
	) {
		this._name = name;
		this._strategy = strategy;
		this._arms = arms;
		this._metrics = metrics;
		this._contextKey = contextKey;
		// 分流键缺省回退分组键（旧行为：contextKey 兼作分流键）
		this._assignKey = assignKey ?? contextKey;
		this._storage = new ExperimentStorage(name);
		// 从已加载事件重建去重集合，保证 /reload 后历史 TAG 不会重复摄入
		for (const e of this._storage.getEvents()) {
			if (e.dedupKey) this._dedupKeys.add(e.dedupKey);
		}
	}

	// ── 核心 API ──

	async select(context: unknown): Promise<string> {
		if (this._forceArmId) return this._forceArmId;

		// 分流用 assignKey（会话级稳定单元），分析/展示用 contextKey（分组维度）——
		// 两者解耦后，同一模型内不同会话可落到不同臂，消除「臂=模型」的混杂。
		// 当前唯一策略 stable-hash：同一 assignKey 恒定同一臂。
		const assignKey = this._resolveAssignKey(context);
		return stableHashAssign(assignKey, this._arms);
	}

	async record(armId: string, outcome: Outcome, context: unknown): Promise<void> {
		const ctxKey = this._resolveContextKey(context);
		this._storage.appendEvent({
			ts: new Date().toISOString(),
			armId,
			ctxKey,
			metrics: outcome.metrics,
			metadata: outcome.metadata,
		});
		this._queryCache.clear();
	}

	/**
	 * 从信号入口写入事件（ingest 用）。
	 * 与 record 的区别：ctxKey 由 extractor 提供，不再走 contextKey fn 解析。
	 *
	 * @returns 是否实际写入（dedupKey 已存在时返回 false，幂等去重）
	 */
	appendEvent(event: {
		armId: string;
		ctxKey: string;
		metrics: Record<string, number>;
		metadata?: Record<string, unknown>;
		dedupKey?: string;
	}): boolean {
		if (event.dedupKey) {
			if (this._dedupKeys.has(event.dedupKey)) return false;
			this._dedupKeys.add(event.dedupKey);
		}
		this._storage.appendEvent({
			ts: new Date().toISOString(),
			armId: event.armId,
			ctxKey: event.ctxKey,
			metrics: event.metrics,
			metadata: event.metadata,
			dedupKey: event.dedupKey,
		});
		this._queryCache.clear();
		return true;
	}

	// ── 统计 ──

	/** 从事件流投影聚合（每 arm × 每 metric 的 sum/count） */
	stats(context?: unknown): Record<string, ArmAggregate> {
		const events =
			context === undefined
				? this._storage.getEvents()
				: this._storage.getEventsByContext(this._resolveContextKey(context));

		const result: Record<string, ArmAggregate> = {};
		for (const arm of this._arms) {
			const armEvents = events.filter((e) => e.armId === arm.id);
			const metrics: Record<string, MetricAggregate> = {};
			for (const m of this._metrics) {
				let sum = 0;
				let count = 0;
				for (const e of armEvents) {
					// 派生指标走与 query() 相同的投影，避免 stats() 对派生指标恒返回 0
					const v = projectMetricValue(m, e);
					if (v !== undefined) {
						sum += v;
						count++;
					}
				}
				metrics[m.id] = { sum, count };
			}
			result[arm.id] = { totalCalls: armEvents.length, metrics };
		}
		return result;
	}

	/** 返回全部事件（供面板/分析使用） */
	getEvents() {
		return this._storage.getEvents();
	}

	/** 对单个 metric 做贝叶斯后验分析（结果缓存，事件流变化时失效） */
	query(metricId: string, context?: unknown): QueryResult {
		const metricDef = this._metrics.find((m) => m.id === metricId);
		if (!metricDef) throw new Error(`未知指标: ${metricId}`);
		const ctxKey = context === undefined ? '__all__' : this._resolveContextKey(context);
		const cacheKey = `${metricId}\u0000${ctxKey}`;
		const cached = this._queryCache.get(cacheKey);
		if (cached) return cached;
		const events =
			ctxKey === '__all__'
				? this._storage.getEvents()
				: this._storage.getEventsByContext(ctxKey);
		const result = analyzeMetric(metricId, metricDef, events, this._armIds());
		this._queryCache.set(cacheKey, result);
		return result;
	}

	/**
	 * 按已解析的 ctxKey 字符串过滤做分析（不经 contextKey fn 二次解析）。
	 * 供面板按上下文分桶时用——getContextKeys() 返回的是已解析字符串，
	 * 若走 query(metricId, ctxKey) 会被函数型 contextKey 二次解析破坏。
	 */
	queryByCtxKey(metricId: string, ctxKey: string): QueryResult {
		const metricDef = this._metrics.find((m) => m.id === metricId);
		if (!metricDef) throw new Error(`未知指标: ${metricId}`);
		const cacheKey = `${metricId}\u0000${ctxKey}`;
		const cached = this._queryCache.get(cacheKey);
		if (cached) return cached;
		const events = this._storage.getEventsByContext(ctxKey);
		const result = analyzeMetric(metricId, metricDef, events, this._armIds());
		this._queryCache.set(cacheKey, result);
		return result;
	}

	getContextKeys(): string[] {
		const keys = new Set(this._storage.getEvents().map((e) => e.ctxKey));
		return Array.from(keys);
	}

	getInfo() {
		return {
			name: this._name,
			strategy: this._strategy,
			arms: this._arms,
			metrics: this._metrics,
			forceArmId: this._forceArmId,
			loadWarning: this._storage.getLoadWarning(),
		};
	}

	// ── 控制 ──

	forceArm(armId: string | null): void {
		this._forceArmId = armId;
	}

	/**
	 * 原地更新实验定义（演进场景：同 owner 同 name 口径变化）。
	 * 不重建 storage——保留内存事件与 JSONL 数据，仅替换口径字段并失效 forceArm/缓存。
	 */
	updateDef(
		strategy: AllocationStrategy,
		arms: ArmDef[],
		metrics: MetricDef[],
		contextKey: ContextKeyFn<any> | string,
		assignKey?: ContextKeyFn<any> | string,
	): void {
		this._strategy = strategy;
		this._arms = arms;
		this._metrics = metrics;
		this._contextKey = contextKey;
		this._assignKey = assignKey ?? contextKey;
		this._forceArmId = null;
		this._queryCache.clear();
	}

	async reset(): Promise<void> {
		await this._storage.reset();
		this._dedupKeys.clear();
		this._queryCache.clear();
	}

	async flush(): Promise<void> {
		await this._storage.flush();
	}

	// ── 内部 ──

	private _armIds(): string[] {
		return this._arms.map((a) => a.id);
	}

	private _resolveContextKey(context: unknown): string {
		if (context === undefined || context === null) {
			return 'global';
		}
		if (typeof this._contextKey === 'function') {
			return (this._contextKey as ContextKeyFn<unknown>)(context);
		}
		return this._contextKey;
	}

	/** 解析分流键（stable-hash 的分流单元），与分组键分离 */
	private _resolveAssignKey(context: unknown): string {
		if (context === undefined || context === null) {
			return 'global';
		}
		if (typeof this._assignKey === 'function') {
			return (this._assignKey as ContextKeyFn<unknown>)(context);
		}
		return this._assignKey;
	}
}
