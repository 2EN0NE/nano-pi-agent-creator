import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";

// ===== Strategy Types =====

export interface FixedStrategy {
	type: "fixed";
	threshold: number;
}

export interface PercentageStrategy {
	type: "percentage";
	percent: number;
}

export interface ReserveStrategy {
	type: "reserve";
	reserveTokens: number;
}

export type CompactStrategy =
	| FixedStrategy
	| PercentageStrategy
	| ReserveStrategy;

// ===== Default Configuration =====
// Current default: compact when context reaches 80% of the model's context window.
// Strategies are combined with OR — if ANY strategy's threshold is crossed, compaction triggers.

export const DEFAULT_STRATEGIES: CompactStrategy[] = [
	{ type: "percentage", percent: 70 },
];

// ===== Threshold Computation =====
// Each strategy reads from `ctx.model` when available.
// If the model is unavailable, percentage/reserve strategies return 0 (no threshold),
// meaning they won't spuriously trigger. Fixed strategy always returns its explicit threshold.

export function computeThresholds(
	strategies: CompactStrategy[],
	model: Model<any> | undefined,
): number[] {
	const thresholds: number[] = [];

	for (const s of strategies) {
		switch (s.type) {
			case "fixed":
				thresholds.push(s.threshold);
				break;
			case "percentage":
				if (model?.contextWindow) {
					thresholds.push(Math.round((model.contextWindow * s.percent) / 100));
				}
				// no model → skip (can't compute percentage-based threshold)
				break;
			case "reserve":
				if (model?.contextWindow) {
					thresholds.push(model.contextWindow - s.reserveTokens);
				}
				// no model → skip (can't compute reserve-based threshold)
				break;
		}
	}

	return thresholds;
}

// ===== Argument Parsing =====
// Parse "type:value" or "type:value:value" into a strategy, or return null for custom instructions.
// Examples: "fixed:150000", "percentage:90", "reserve:5000"

export function parseStrategyArg(arg: string): CompactStrategy | null {
	const colonIdx = arg.indexOf(":");
	if (colonIdx === -1) return null;

	const type = arg.slice(0, colonIdx) as CompactStrategy["type"];
	const rawValue = arg.slice(colonIdx + 1);

	switch (type) {
		case "fixed": {
			const threshold = Number(rawValue);
			if (!Number.isFinite(threshold) || threshold <= 0) return null;
			return { type: "fixed", threshold };
		}
		case "percentage": {
			const percent = Number(rawValue);
			if (!Number.isFinite(percent) || percent <= 0 || percent > 100)
				return null;
			return { type: "percentage", percent };
		}
		case "reserve": {
			const reserveTokens = Number(rawValue);
			if (!Number.isFinite(reserveTokens) || reserveTokens <= 0) return null;
			return { type: "reserve", reserveTokens };
		}
		default:
			return null;
	}
}

export default function (pi: ExtensionAPI) {
	let previousTokens: number | null | undefined;

	const triggerCompaction = (
		ctx: ExtensionContext,
		customInstructions?: string,
	) => {
		if (ctx.hasUI) {
			ctx.ui.notify("Compaction started", "info");
		}
		ctx.compact({
			customInstructions,
			onComplete: () => {
				// Reset crossing detection so post-compaction token accumulation can re-trigger.
				previousTokens = 0;
				if (ctx.hasUI) {
					ctx.ui.notify("Compaction completed", "info");
				}
			},
			onError: (error) => {
				if (ctx.hasUI) {
					ctx.ui.notify(`Compaction failed: ${error.message}`, "error");
				}
			},
		});
	};

	pi.on("turn_end", (_event, ctx) => {
		const usage = ctx.getContextUsage();
		const currentTokens = usage?.tokens ?? null;

		// If usage is unavailable (e.g. right after core-initiated compaction), skip this turn.
		// previousTokens stays unchanged so the crossing window is preserved.
		if (currentTokens === null) {
			return;
		}

		// Compute thresholds from all active strategies (OR combination).
		const thresholds = computeThresholds(DEFAULT_STRATEGIES, ctx.model);
		if (thresholds.length === 0) {
			// No computable threshold — nothing to trigger on.
			previousTokens = currentTokens;
			return;
		}

		// OR crossing detection: if ANY threshold was crossed from below → compact.
		const anyCrossed = thresholds.some((threshold) => {
			if (previousTokens === undefined || previousTokens === null) return false;
			return previousTokens <= threshold && currentTokens > threshold;
		});

		previousTokens = currentTokens;
		if (!anyCrossed) {
			return;
		}
		triggerCompaction(ctx);
	});

	pi.on("session_compact", () => {
		// Core (or another extension) initiated a compaction outside our extension.
		// Reset our crossing detector so we can re-trigger on the next build-up.
		previousTokens = 0;
	});

	pi.registerCommand("trigger-compact", {
		description:
			"Trigger compaction immediately. Usage: `trigger-compact [strategy:]` or `trigger-compact [custom instructions]`. " +
			"Strategies: fixed:N, percentage:N, reserve:N. Example: `trigger-compact percentage:90`. " +
			"Without a strategy prefix, the argument is treated as custom instructions for the compaction summary.",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (!trimmed) {
				triggerCompaction(ctx);
				return;
			}

			// Try to parse as a strategy override first.
			const strategy = parseStrategyArg(trimmed);
			if (strategy) {
				// Temporarily use the parsed strategy as a single-element array.
				// onComplete/session_compact already reset previousTokens after compaction.
				const tempStrategies: CompactStrategy[] = [strategy];
				const usage = ctx.getContextUsage();
				const currentTokens = usage?.tokens ?? null;
				if (currentTokens !== null) {
					const thresholds = computeThresholds(tempStrategies, ctx.model);
					const shouldCompact = thresholds.some((t) => currentTokens > t);
					if (shouldCompact) {
						triggerCompaction(ctx);
					} else if (ctx.hasUI) {
						ctx.ui.notify(
							`Strategy ${trimmed} triggers at >${thresholds[0].toLocaleString()} tokens; current usage is ${currentTokens.toLocaleString()}. No compaction needed.`,
							"info",
						);
					}
				} else {
					// No usage data — compact anyway (manual override).
					triggerCompaction(ctx);
				}
				return;
			}

			// Not a strategy — treat as custom instructions.
			triggerCompaction(ctx, trimmed);
		},
	});
}
