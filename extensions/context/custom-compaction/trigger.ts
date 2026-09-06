/**
 * Trigger threshold logic for custom-compaction.
 *
 * Pure functions — no Pi API dependency, no side effects.
 * Extracted from index.ts for testability.
 */
import {
	modelMatchScore,
	type CompactionProfile,
	type ComplexityLevel,
	type RoutingRule,
} from './types.js';

/**
 * Check whether a trigger threshold has been crossed based on current context usage.
 *
 * @param trigger - The trigger configuration from the active profile
 * @param contextUsage - Current context token count and optional percentage
 * @param contextWindow - The model's context window size (required for 'reserve' type)
 */
export function shouldTrigger(
	trigger: CompactionProfile['trigger'],
	contextUsage: { tokens: number; percent: number | null },
	contextWindow: number | undefined,
): boolean {
	const { type, threshold } = trigger;

	switch (type) {
		case 'context_percent':
			if (contextUsage.percent === null) return false;
			return contextUsage.percent >= threshold;

		case 'fixed':
			return contextUsage.tokens >= threshold;

		case 'reserve': {
			if (contextWindow === undefined || contextWindow <= 0) {
				// Fallback: derive window from percent if available
				if (contextUsage.percent === null || contextUsage.percent <= 0) return false;
				return (
					Math.round((contextUsage.tokens / contextUsage.percent) * 100) -
						contextUsage.tokens <=
					threshold
				);
			}
			return contextWindow - contextUsage.tokens <= threshold;
		}
		default:
			return false;
	}
}

/**
 * Check whether context usage is approaching the trigger threshold (>=80% but not yet triggered).
 *
 * - context_percent / fixed: approaching when usage >= threshold * 0.8 and < threshold
 * - reserve: approaching when remaining tokens <= threshold * 1.5 and > threshold
 *
 * The 80% line scales with the model-specific threshold — e.g. for a profile with
 * threshold 50%, the warning appears at 40%.
 *
 * @param trigger - The trigger configuration from the active profile
 * @param contextUsage - Current context token count and optional percentage
 * @param contextWindow - The model's context window size (required for 'reserve' type)
 */
export function isApproaching(
	trigger: CompactionProfile['trigger'],
	contextUsage: { tokens: number; percent: number | null },
	contextWindow: number | undefined,
): boolean {
	const { type, threshold } = trigger;

	switch (type) {
		case 'context_percent': {
			if (contextUsage.percent === null) return false;
			const warnThreshold = threshold * 0.8;
			return contextUsage.percent >= warnThreshold && contextUsage.percent < threshold;
		}
		case 'fixed': {
			const warnThreshold = Math.round(threshold * 0.8);
			return contextUsage.tokens >= warnThreshold && contextUsage.tokens < threshold;
		}
		case 'reserve': {
			if (contextWindow === undefined || contextWindow <= 0) {
				if (contextUsage.percent === null || contextUsage.percent <= 0) return false;
				return (
					Math.round((contextUsage.tokens / contextUsage.percent) * 100) -
						contextUsage.tokens <=
						threshold * 1.5 &&
					Math.round((contextUsage.tokens / contextUsage.percent) * 100) -
						contextUsage.tokens >
						threshold
				);
			}
			return (
				contextWindow - contextUsage.tokens <= threshold * 1.5 &&
				contextWindow - contextUsage.tokens > threshold
			);
		}
		default:
			return false;
	}
}

/**
 * Select the profile to compact from the enabled set (ADR-0036).
 *
 * 启用集 → 触发集 → tiebreak（阈值倒序）择一：
 * 1. 过滤出满足触发条件的 profile（触发集 = 启用集 ∩ 触发）
 * 2. 触发集非空时，按 tiebreak 择一：同 trigger.type 内阈值倒序（大优先），
 *    不同 type 按类型名稳定排序（保证结果可预测、与 profiles 定义顺序无关）
 *
 * Returns undefined when no enabled profile satisfies its trigger.
 */
export function selectTriggeredProfile(
	enabled: CompactionProfile[],
	contextUsage: { tokens: number; percent: number | null },
	contextWindow: number | undefined,
): CompactionProfile | undefined {
	const triggered = enabled.filter((p) => shouldTrigger(p.trigger, contextUsage, contextWindow));
	if (triggered.length === 0) return undefined;
	return [...triggered].sort(tiebreakCompare)[0];
}

/**
 * 在触发集内择一（ADR-0036 选择算法三层）：
 * 1. 显式路由规则（有序，首条命中且 target 在触发集内）
 * 2. matchModel 隐式规则（兼容旧字段，最具体匹配优先）
 * 3. tiebreak（阈值倒序）
 */
export function selectProfileFromTriggered(
	triggered: CompactionProfile[],
	opts: {
		modelSpec?: string;
		complexityLevel?: ComplexityLevel;
		routingRules: RoutingRule[];
	},
): CompactionProfile | undefined {
	if (triggered.length === 0) return undefined;

	// 第一层：显式路由规则
	for (const rule of opts.routingRules) {
		if (
			rule.model !== undefined &&
			(!opts.modelSpec || modelMatchScore(rule.model, opts.modelSpec) === undefined)
		) {
			continue; // 模型维度不匹配
		}
		if (rule.complexity !== undefined && rule.complexity !== opts.complexityLevel) {
			continue; // 复杂度维度不匹配
		}
		const target = triggered.find((p) => p.id === rule.targetProfileId);
		if (target) return target;
	}

	// 第二层：matchModel 隐式规则（旧字段兼容）—— 最具体匹配优先
	if (opts.modelSpec) {
		let best: CompactionProfile | undefined;
		let bestScore = Infinity;
		let bestLen = 0;
		for (const p of triggered) {
			if (!p.matchModel) continue;
			const score = modelMatchScore(p.matchModel, opts.modelSpec);
			if (score === undefined) continue;
			const len = p.matchModel.length;
			if (score < bestScore || (score === bestScore && len > bestLen)) {
				best = p;
				bestScore = score;
				bestLen = len;
			}
		}
		if (best) return best;
	}

	// 第三层：tiebreak（阈值倒序）
	return [...triggered].sort(tiebreakCompare)[0];
}

/** tiebreak：同 type 内阈值倒序（大优先），不同 type 按类型名稳定排序 */
function tiebreakCompare(a: CompactionProfile, b: CompactionProfile): number {
	if (a.trigger.type !== b.trigger.type) {
		return a.trigger.type.localeCompare(b.trigger.type);
	}
	return b.trigger.threshold - a.trigger.threshold;
}
