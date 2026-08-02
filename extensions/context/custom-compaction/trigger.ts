/**
 * Trigger threshold logic for custom-compaction.
 *
 * Pure functions — no Pi API dependency, no side effects.
 * Extracted from index.ts for testability.
 */
import type { CompactionProfile } from './types.js';

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
