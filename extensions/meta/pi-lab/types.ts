/**
 * @zenone/pi-lab 类型定义
 */

// ============================================================================
// Outcome — 实验反馈信号
// ============================================================================

/**
 * 实验反馈信号：本轮观测到的指标值。
 * 测什么由实验声明的 metric 决定，不设固定字段。
 */
export interface Outcome {
	/** 本轮观测到的指标值，键为 metric id */
	metrics: Record<string, number>;
	/** 附加元数据 */
	metadata?: Record<string, unknown>;
}

/** 指标类型：binary（是/否）、continuous（数值）、count（次数） */
export type MetricType = 'binary' | 'continuous' | 'count';

/**
 * 声明式派生指标（ADR 0009）。
 * 复合评分（composite）是消费方的领域逻辑，pi-lab 提供原语而非硬编码：
 * query() 时按当前声明从源 metric 投影计算，改权重后可回溯重算历史。
 */
export interface DerivedMetricDef {
	kind: 'weighted-sum' | 'any-fail';
	/** 参与计算的源 metric 及权重（any-fail 忽略 weight） */
	components: Array<{ metricId: string; weight?: number }>;
}

/** 指标定义（注册实验时声明） */
export interface MetricDef {
	/** Metric id，实验内唯一 */
	id: string;
	/** 指标类型（派生指标时：weighted-sum→continuous、any-fail→binary） */
	type: MetricType;
	/** 优化方向：maximize（越大越好）/ minimize（越小越好） */
	direction: 'maximize' | 'minimize';
	/** 是否为护栏指标（不参与选赢家，只做副作用告警） */
	isGuardrail?: boolean;
	/** 声明式派生指标（可选）：从源 metric 投影计算，源值 record() 直报 */
	derived?: DerivedMetricDef;
	/** 指标描述（人话解释，/lab 面板展示时帮助理解指标含义） */
	description?: string;
}

/** 单条实验事件（JSONL 中的一行） */
export interface ExperimentEvent {
	/** ISO 时间戳 */
	ts: string;
	/** 分配的 arm id */
	armId: string;
	/** 上下文键 */
	ctxKey: string;
	/** 本轮观测值 */
	metrics: Record<string, number>;
	/** 附加元数据 */
	metadata?: Record<string, unknown>;
	/**
	 * 幂等键（可选）：用于异步信号去重（如 TAG 节点的 targetId）。
	 * 同实验内同 dedupKey 的事件只写入一次；record() 直报不设此键。
	 */
	dedupKey?: string;
}

// ============================================================================
// Arm — 实验臂
// ============================================================================

/** 单指标聚合（从事件流投影） */
export interface MetricAggregate {
	/** 值之和（binary 时即成功次数） */
	sum: number;
	/** 观测次数 */
	count: number;
}

/** 单臂聚合（从事件流投影） */
export interface ArmAggregate {
	/** 观测总次数 */
	totalCalls: number;
	/** 各 metric 的聚合 */
	metrics: Record<string, MetricAggregate>;
}

/** 单臂后验分析结果 */
export interface ArmAnalysis {
	armId: string;
	/** 样本量 */
	n: number;
	/** 后验均值 */
	mean: number;
	/** 95% credible interval */
	credibleInterval: { low: number; high: number };
	/** 胜出概率 P(arm 在所有臂中最优) */
	winProbability: number;
}

/** guardrail 告警 */
export interface GuardrailAlert {
	armId: string;
	/** P(该 arm 是 guardrail 最差) */
	pWorse: number;
}

/** query 的返回：单个 metric 的贝叶斯后验分析 */
export interface QueryResult {
	metricId: string;
	arms: ArmAnalysis[];
	guardrailAlert: GuardrailAlert[];
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
	/**
	 * 注册方身份 key（必填）。pi-lab 以 (owner, name) 二元组识别逻辑实验身份，
	 * 不解释 owner 的命名/层级语义（是否用插件名、是否编码 user/project 级别，均由消费方自行决定）。
	 */
	owner: string;
	/** 实验名称，owner 内唯一 */
	name: string;
	/**
	 * 分组键（分析/展示维度）：事件按此键分桶，面板「分桶」视图按此键分组。
	 * 通常声明为模型（provider:model）——分析时按模型分层，控制「模型效应」混杂。
	 */
	contextKey: string | ContextKeyFn<any>;
	/**
	 * 分流键（stable-hash 的分流单元，可选）：决定同一单元稳定分到同一臂。
	 * 应为跨分组键分布、稳定的单元（如会话 sessionId），缺省回退 contextKey。
	 *
	 * ⚠️ 若缺省（= contextKey=模型），则「臂」与「模型」完全绑定（confounding），
	 * 同一模型内无法对比两臂。消费方应显式声明会话级 assignKey 解耦。
	 */
	assignKey?: string | ContextKeyFn<any>;
	/** 实验臂定义 */
	arms: ArmDef[];
	/** 观测指标定义 */
	metrics: MetricDef[];
	/** 分配策略，默认 stable-hash */
	strategy?: AllocationStrategy;
	/**
	 * AA 实验标志（可选）：两臂指向同一实现，用于验证分流/测量无偏。
	 * 声明后 /lab 面板启用后验校准提示（胜出概率应 ~50/50，异常高则告警）。
	 */
	isAA?: boolean;
}

/** Arm 定义（注册时传入） */
export interface ArmDef {
	/** Arm ID，实验内唯一 */
	id: string;
	/** 显示标签 */
	label: string;
	/** 稳定哈希分桶的权重，默认等权 1 */
	weight?: number;
}

/**
 * 分配策略。当前只有 stable-hash（固定分流 + 事后统计检验，即 AB 测试）。
 *
 * bandit（thompson-sampling / epsilon-greedy）已拆除——在线优化与 AB 测试
 * 目标相反（自适应倾斜流量会破坏统计有效性），未来若需引入，应作为独立
 * 「模式」（mode）与 AB 测试正交拆分，而非混入本枚举。
 */
export type AllocationStrategy = 'stable-hash';

// ============================================================================
// Registration — 注册来源与冲突
// ============================================================================

/**
 * 注册来源（接入方式），仅表消费方如何接入 pi-lab：
 * import = 直接依赖 @zenone/pi-lab 包；bridge = 经 globalThis.__labApi 鸭子类型访问。
 * 不参与冲突裁决（冲突裁决以 (owner, name) 身份判定，见 ADR）。
 */
export type RegistrationSource = 'import' | 'bridge';

/** 定义差异摘要（definitionDiff 输出） */
export interface DefinitionDiff {
	/** 声明式字段是否有变化（function 型 contextKey 不参与比较） */
	changed: boolean;
	/** 变化点的人话描述列表（如 'arms 新增 x'、'metrics 移除 y'） */
	changes: string[];
}

/**
 * 注册事件（缓冲，等待 session_start 时冲刷到 UI）：
 *  - owner-conflict：异 owner 撞名，硬冲突（error 级，后注册者被阻断并返回 undefined）
 *  - evolved：同 owner 同 name 定义演进（warn 级，含副作用说明）
 */
export interface ConflictEvent {
	type: 'owner-conflict' | 'evolved';
	experimentName: string;
	/** 触发本事件的注册方 owner */
	owner: string;
	timestamp: string;
	/** owner-conflict 专用：已存在实验的 owner */
	existingOwner?: string;
	/** 双方接入方式（仅表接入方式，不参与裁决） */
	newSource?: RegistrationSource;
	existingSource?: RegistrationSource;
	/** evolved 专用：定义变化摘要（人话描述列表） */
	changes?: string[];
}

// ============================================================================
// ExperimentAPI — 实验运行时 API
// ============================================================================

/** 消费方使用的实验 API */
export interface ExperimentAPI {
	/** 选择臂。context 传给实验声明的 contextKey fn 提取分桶键（stable-hash 用）。 */
	select: (context?: unknown) => Promise<string>;
	/** 记录反馈。context 传给 contextKey fn（与 select 用同一上下文，保证同桶）。 */
	record: (armId: string, outcome: Outcome, context?: unknown) => Promise<void>;
	/** 获取聚合统计（从事件流投影）。context 可选，缺省为全部事件。 */
	stats: (context?: unknown) => Promise<Record<string, ArmAggregate>>;
	/** 获取某 metric 的贝叶斯后验分析结论。context 可选，缺省为全部事件。 */
	query: (metricId: string, context?: unknown) => Promise<QueryResult>;
	/** 强制固定臂（禁用自动切换，调试用） */
	forceArm: (armId: string | null) => void;
	/** 获取实验信息 */
	info: () => {
		name: string;
		source: RegistrationSource | undefined;
		strategy: AllocationStrategy;
		forceArmId: string | null;
	};
	/** 重置统计数据 */
	reset: () => Promise<void>;
}

// ============================================================================
// 面板类型
// ============================================================================

export interface ExperimentSummary {
	name: string;
	strategy: AllocationStrategy;
	armCount: number;
	modelCount: number;
	totalCalls: number;
	forceArmId: string | null;
}

// ============================================================================
// Ingestion Source — 信号入口
// ============================================================================

/**
 * 信号源提取器：把原始信号转成带 armId 的实验事件。
 * 异步信号（TAG/日志）无法由 pi-lab 推断 arm，故 armId 归因是 extractor 的职责：
 * 信号里须显式携带 armId（label/日志格式约定见 CONTEXT.md）。
 */
export type SignalExtractor = (rawData: unknown) => Array<{
	armId: string;
	ctxKey: string;
	metrics: Record<string, number>;
	metadata?: Record<string, unknown>;
	/** 幂等键（可选）：异步信号去重用，见 ExperimentEvent.dedupKey */
	dedupKey?: string;
}>;

/** 已注册的信号源 */
export interface IngestionSource {
	name: string;
	extract: SignalExtractor;
}

/** 面板统计分组口径：'bucket' = 按 contextKey 分桶（消费方声明的分桶键），'global' = 跨桶汇总 */
export type PanelTab = 'bucket' | 'global';

/** 二级操作视图：对当前实验的操作（操作条 Tab 切换） */
export type ExperimentOperation = 'stats' | 'settings' | 'reset';

/**
 * 两级导航（master-detail）：
 *  - menu：一级实验列表（1 个 SelectList + 滚动视口）
 *  - experiment-operations：二级操作页（操作条 [统计] [设置] [重置] Tab 切换）
 */
export type PanelView =
	| { kind: 'menu'; tab: PanelTab }
	| {
			kind: 'experiment-operations';
			experimentName: string;
			operation: ExperimentOperation;
			tab: PanelTab;
	  };
