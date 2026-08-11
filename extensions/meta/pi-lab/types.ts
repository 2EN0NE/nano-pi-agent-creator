/**
 * @zenone/pi-lab 类型定义
 */

// ============================================================================
// Outcome — 实验反馈信号
// ============================================================================

/**
 * 实验反馈信号。
 *
 * 分层设计（参考 Langfuse / LangSmith / Arize Phoenix）：
 *   Tier 1: success → 驱动贝叶斯 Beta-Bernoulli 更新
 *   Tier 2-5 → 存入 metadata，供面板查看和分层分析
 */
export interface Outcome {
	// ── Tier 1: 核心（驱动贝叶斯更新）──
	/** 成功/失败 */
	success: boolean;

	// ── Tier 2: 质量 ──
	/** 首次尝试即成功，无需内部 fallback/retry */
	firstAttempt?: boolean;
	/** 执行耗时 ms */
	latencyMs?: number;
	/** 失败分类 */
	errorType?: 'match-failed' | 'not-found' | 'permission' | 'timeout' | 'crash' | 'unknown';

	// ── Tier 3: 成本（预留）──
	/** token 消耗 */
	totalTokens?: number;
	/** 估算美元成本 */
	costUsd?: number;

	// ── Tier 4: 上下文影响（Pi 特有）──
	/** 本次执行导致 session 增长的字节 */
	contextFootprintBytes?: number;
	/** 是否触发了 compaction */
	compactionTriggered?: boolean;

	// ── Tier 5: 调试与分析 ──
	/** 失败详情 */
	errorMessage?: string;
	/** Arm 自定义元数据 */
	metadata?: Record<string, unknown>;
}

// ============================================================================
// Arm — 实验臂
// ============================================================================

/** Arm 统计快照 */
export interface ArmStats {
	/** Arm ID */
	id: string;
	/** 显示标签 */
	label: string;
	/** Beta 分布 α */
	alpha: number;
	/** Beta 分布 β */
	beta: number;
	/** 调用总次数 */
	totalCalls: number;
	/** 成功次数 */
	successes: number;
	/** 首次尝试即成功次数 */
	firstAttempts: number;
	/** 累计延迟 ms */
	totalLatencyMs: number;
	/** 成功率（仅用于展示，贝叶斯使用 Beta 分布） */
	successRate: number;
}

/** 持久化的 Arm 状态 */
export interface ArmState {
	alpha: number;
	beta: number;
	firstAttempts: number;
	totalCalls: number;
	totalLatencyMs: number;
}

// ============================================================================
// ContextKey — 上下文键
// ============================================================================

/**
 * 上下文键提取函数。
 * 结果用于分桶（如 "anthropic:claude-sonnet-4-5" 或 "global"）。
 */
export type ContextKeyFn<TCtx> = (ctx: TCtx) => string;

// ============================================================================
// Experiment — 实验定义与运行时
// ============================================================================

/** 实验定义（注册时传入） */
export interface ExperimentDef {
	/** 实验名称，全局唯一 */
	name: string;
	/** 上下文键提取函数 */
	contextKey: string | ContextKeyFn<any>;
	/** 实验臂定义 */
	arms: ArmDef[];
	/** 决策策略 */
	strategy: BanditStrategy;
}

/** Arm 定义（注册时传入） */
export interface ArmDef {
	/** Arm ID，实验内唯一 */
	id: string;
	/** 显示标签 */
	label: string;
}

/** 决策策略 */
export type BanditStrategy = 'thompson-sampling' | 'epsilon-greedy';

// ============================================================================
// Registration — 注册来源与冲突
// ============================================================================

/** 注册来源，决定实验的优先级 */
export type RegistrationSource = 'import' | 'bridge';

/** 注册来源的优先级数值（高→低） */
export const REGISTRATION_PRIORITY: Record<RegistrationSource, number> = {
	import: 2,
	bridge: 1,
};

/** 冲突事件（缓冲，等待 session_start 时冲刷到 UI） */
export interface ConflictEvent {
	type: 'overwrite' | 'blocked';
	experimentName: string;
	newSource: RegistrationSource;
	existingSource: RegistrationSource;
	timestamp: string;
}

// ============================================================================
// ExperimentAPI — 实验运行时 API
// ============================================================================

/** 消费方使用的实验 API */
export interface ExperimentAPI {
	/** 选择臂 */
	select: () => Promise<string>;
	/** 记录反馈 */
	record: (armId: string, outcome: Outcome) => Promise<void>;
	/** 获取当前统计 */
	stats: () => Promise<Record<string, ArmState>>;
	/** 强制固定臂（禁用自动切换，调试用） */
	forceArm: (armId: string | null) => void;
	/** 获取实验信息 */
	info: () => { name: string; strategy: BanditStrategy; forceArmId: string | null };
	/** 重置统计数据 */
	reset: () => Promise<void>;
}

// ============================================================================
// 持久化类型
// ============================================================================

export interface PersistedModelEntry {
	[key: string]: ArmState;
}

export interface PersistedExperiment {
	version: number;
	strategy: BanditStrategy;
	arms: string[];
	models: Record<string, PersistedModelEntry>;
	created: string;
	updated: string;
}

// ============================================================================
// 面板类型
// ============================================================================

export interface ExperimentSummary {
	name: string;
	strategy: BanditStrategy;
	armCount: number;
	modelCount: number;
	totalCalls: number;
	forceArmId: string | null;
}

export type PanelTab = 'session' | 'global';

export type PanelView =
	| { kind: 'menu' }
	| { kind: 'experiment-list'; tab: PanelTab }
	| { kind: 'experiment-detail'; experimentName: string; tab: PanelTab }
	| { kind: 'settings'; experimentName: string }
	| { kind: 'confirm-reset'; experimentName: string; tab: PanelTab };
