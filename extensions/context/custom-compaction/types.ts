/**
 * Types for custom-compaction extension.
 *
 * A CompactionProfile consists of two dimensions:
 * - trigger:  WHEN to compact (context_percent / fixed / reserve)
 * - mechanism: HOW to compact (summarize / pass_through / adapter)
 */

// ── Trigger: when to compact ────────────────────────────────────

export type TriggerType = 'context_percent' | 'fixed' | 'reserve';

export const TRIGGER_LABELS: Record<TriggerType, string> = {
	context_percent: '上下文百分比',
	fixed: '固定 Token 数',
	reserve: '保留 Token 数',
};

/** Describe what a trigger condition means */
export function describeTrigger(trigger: { type: TriggerType; threshold: number }): string {
	switch (trigger.type) {
		case 'context_percent':
			return `上下文使用达 ${trigger.threshold}% 时压缩`;
		case 'fixed':
			return `Token 数超过 ${trigger.threshold.toLocaleString()} 时压缩`;
		case 'reserve':
			return `剩余 Token 少于 ${trigger.threshold.toLocaleString()} 时压缩`;
		default:
			return '未知触发类型';
	}
}

/** Validate a trigger threshold */
export function validateTriggerThreshold(type: TriggerType, value: number): string | null {
	switch (type) {
		case 'context_percent':
			if (!Number.isFinite(value) || value < 1 || value > 99)
				return '阈值必须在 1 到 99 之间';
			break;
		case 'fixed':
			if (!Number.isFinite(value) || value < 1000) return 'Token 数至少为 1,000';
			break;
		case 'reserve':
			if (!Number.isFinite(value) || value < 100) return '保留 Token 数至少为 100';
			break;
		default:
			return '未知触发类型';
	}
	return null;
}

// ── Trigger type change: threshold preservation ─────────────────

/** 各触发类型的默认阈值（切换类型且旧值非法时使用） */
export const DEFAULT_TRIGGER_THRESHOLDS: Record<TriggerType, number> = {
	context_percent: 20,
	fixed: 200000,
	reserve: 10000,
};

export interface TriggerThresholdResolution {
	threshold: number;
	/** true = 旧阈值在新类型下非法，已被重置为默认（调用方应提示用户） */
	reset: boolean;
}

/**
 * 切换触发类型时确定保留/重置阈值：
 * 旧阈值在新类型下合法则原样保留；非法则重置为该类型默认值。
 */
export function resolveTriggerThresholdAfterTypeChange(
	type: TriggerType,
	oldThreshold: number,
): TriggerThresholdResolution {
	if (validateTriggerThreshold(type, oldThreshold) === null) {
		return { threshold: oldThreshold, reset: false };
	}
	return { threshold: DEFAULT_TRIGGER_THRESHOLDS[type], reset: true };
}

// ── Trigger granularity: how often to evaluate triggers ────────

export type TriggerGranularity = 'user_turn' | 'agent_turn' | 'tool';

export const TRIGGER_GRANULARITY_LABELS: Record<TriggerGranularity, string> = {
	user_turn: '用户轮',
	agent_turn: 'Agent 轮',
	tool: '工具调用',
};

// ── Mechanism: how to compact ───────────────────────────────────

export type MechanismType = 'summarize' | 'pass_through' | 'adapter';

export const MECHANISM_LABELS: Record<MechanismType, string> = {
	summarize: 'LLM 摘要',
	pass_through: '透传（Pi 默认/其他扩展）',
	adapter: '外部适配器',
};

export function describeMechanism(mechanism: { type: MechanismType; adapterId?: string }): string {
	switch (mechanism.type) {
		case 'summarize':
			return 'LLM 全量摘要（自定义提示词）';
		case 'pass_through':
			return '交由 Pi 默认或其他扩展处理压缩';
		case 'adapter':
			return `外部适配器：${mechanism.adapterId ?? '(未指定)'}`;
	}
}

// ── Profile ─────────────────────────────────────────────────────

export interface TriggerCondition {
	type: TriggerType;
	/** Threshold meaning depends on type (see describeTrigger) */
	threshold: number;
}

export interface CompactionMechanism {
	type: MechanismType;
	/** Required when type="adapter" — the registered adapter ID */
	adapterId?: string;
	/** Optional adapter-specific config (adapter defines the schema) */
	adapterConfig?: Record<string, unknown>;
}

export interface CompactionProfile {
	/** Unique identifier */
	id: string;
	/** Human-readable name shown in the settings panel */
	name: string;
	/**
	 * Model specification:
	 * - "current": use ctx.model (the currently active Pi model)
	 * - "provider/modelId": use a specific model (e.g. "anthropic/claude-sonnet-4-20250514")
	 */
	model: 'current' | `${string}/${string}`;
	/**
	 * Optional model pattern to auto-select this profile.
	 * When set, this profile ONLY activates when the current Pi model matches the pattern.
	 * When undefined, the profile acts as a universal fallback (matches any model).
	 *
	 * Matching is case-insensitive. Examples:
	 *   "openai/gpt-4o"     → matches "openai/gpt-4o", "openai/gpt-4o-mini"
	 *   "openai/"           → matches any OpenAI model
	 *   "gpt-4o"            → matches any provider with "gpt-4o" in the model ID
	 *
	 * When multiple profiles match, the most specific (longest pattern) wins.
	 */
	matchModel?: string;
	/** WHEN to compact */
	trigger: TriggerCondition;
	/** HOW to compact */
	mechanism: CompactionMechanism;
	/**
	 * Custom summarization prompt.
	 * Only used when mechanism.type === "summarize".
	 * For adapter mechanisms, the adapter may also consult this.
	 */
	prompt: string;
	/** Whether to automatically resume work after compaction succeeds */
	autoContinue: boolean;
	/**
	 * Whether to inject autoContinueMessage as a visible user message after
	 * compaction. When false (default), the continuation is invisible — a
	 * hidden custom marker resumes the loop without the LLM seeing new text.
	 */
	injectContinueText: boolean;
	/** Message sent via pi.sendUserMessage() when autoContinue is true */
	autoContinueMessage: string;
}

// ── Config ──────────────────────────────────────────────────────

/** 会话复杂度等级（来自 pi-session-tree 的 ComplexityReport.level） */
export type ComplexityLevel = 'low' | 'medium' | 'high';

/**
 * 选择算法第一层的路由规则：当 [环境条件] 满足 → 指定 profile。
 * 规则有序，首条命中生效。条件维度目前为 model / complexity（均可选）。
 */
export interface RoutingRule {
	/** 模型匹配（与 matchModel 同语义：大小写不敏感、前缀/子串） */
	model?: string;
	/** 复杂度等级匹配 */
	complexity?: ComplexityLevel;
	/** 命中的目标 profile id */
	targetProfileId: string;
}

export interface CompactionConfig {
	profiles: Record<string, CompactionProfile>;
	/** 启用集：Space 勾选、参与自动压缩触发评估的 profile id 集合（第一道闸） */
	enabledProfileIds: string[];
	/** 触发粒度：触发条件评估频率 */
	triggerGranularity: TriggerGranularity;
	/** 路由规则：有序、首条命中生效（选择算法第一层） */
	routingRules: RoutingRule[];
}

// ── Default values ──────────────────────────────────────────────

/** Default auto-continue message */
export const DEFAULT_AUTO_CONTINUE_MESSAGE = 'continue';

/** Default prompt used when a profile has no custom prompt */
export const DEFAULT_COMPACTION_PROMPT = `You are a conversation summarizer. Create a comprehensive summary of this conversation that captures:

1. The main goals and objectives discussed
2. Key decisions made and their rationale
3. Important code changes, file modifications, or technical details
4. Current state of any ongoing work
5. Any blockers, issues, or open questions
6. Next steps that were planned or suggested

Be thorough but concise. The summary will replace the ENTIRE conversation history, so include all information needed to continue the work effectively.

Format the summary as structured markdown with clear sections.`;

/** Default profile shipped with the extension */
export function createDefaultProfile(): CompactionProfile {
	return {
		id: 'default',
		name: 'Default',
		model: 'current',
		trigger: {
			type: 'context_percent',
			threshold: 20,
		},
		mechanism: {
			type: 'summarize',
		},
		prompt: DEFAULT_COMPACTION_PROMPT,
		autoContinue: true,
		injectContinueText: false,
		autoContinueMessage: DEFAULT_AUTO_CONTINUE_MESSAGE,
	};
}

export function createDefaultConfig(): CompactionConfig {
	return {
		profiles: {
			default: createDefaultProfile(),
		},
		enabledProfileIds: ['default'],
		triggerGranularity: 'agent_turn',
		routingRules: [],
	};
}

// ── Model matching ──────────────────────────────────────────────

/**
 * Build a model spec string ("provider/id") from an object with provider and id fields.
 * Returns undefined if either field is missing.
 */
export function toModelSpec(modelLike?: { provider?: string; id?: string }): string | undefined {
	if (!modelLike?.provider || !modelLike?.id) return undefined;
	return `${modelLike.provider}/${modelLike.id}`;
}

/**
 * How well a profile's matchModel matches a given model spec (provider/id).
 * Lower value = better match. undefined = no match.
 */
export function modelMatchScore(
	matchModel: string | undefined,
	modelSpec: string,
): number | undefined {
	if (!matchModel) return undefined; // universal fallback — scored separately
	const pattern = matchModel.toLowerCase();
	const target = modelSpec.toLowerCase();

	if (pattern === target) return 0; // exact match, best
	if (target.startsWith(pattern)) return 1; // prefix match (e.g. "openai/" matches "openai/gpt-4o")
	if (target.includes(pattern)) return 2; // substring match (e.g. "gpt-4o" matches "openai/gpt-4o")
	return undefined; // no match
}
