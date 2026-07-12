/**
 * Custom Compaction Extension
 *
 * A folder-based extension that replaces Pi's default compaction behavior
 * with profile-based, configurable compaction strategies.
 *
 * Features:
 * - Uses Pi's current model for summarization (no manual API key resolution)
 * - Profile-based configuration (model, trigger strategy, prompt, auto-continue)
 * - Strategy types: context_percent, fixed (absolute token count), reserve (remaining tokens)
 * - Interactive settings panel via /custom-compaction-setting command
 * - Proactive compaction trigger on agent_end
 * - Manual compaction trigger via /custom-compact [profile-name]
 * - Auto-continue after compaction to resume work seamlessly
 *
 * Configuration is persisted in:
 *   ~/.pi/agent/extensions-data/custom-compaction/<sessionId>.json
 * (deterministic path, survives /reload)
 *
 * Usage:
 *   pi --extension custom-compaction
 *   /custom-compaction-setting         (open settings panel)
 *   /custom-compact                    (trigger compaction, pick profile if multiple)
 *   /custom-compact my-profile         (trigger compaction with a specific profile)
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { createLogger } from "@zenone/pi-logger";
import { showSelect } from "@zenone/pi-selector";
import { loadConfig, reloadConfig, setSessionId } from "./config.js";
import { buildCompactionHandler, setPendingSupplement } from "./compactor.js";
import { openSettingsPanel } from "./settings-panel.js";
import { type CompactionProfile, describeTrigger } from "./types.js";

// Auto-register available compaction adapters
import "./mechanisms/smart-compact.js";

const log = createLogger("custom-compaction");

/** Debounce flag: true while a compaction is in progress */
let compactingInProgress = false;

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Check whether a trigger threshold has been crossed based on current context usage.
 */
function shouldTrigger(
	trigger: CompactionProfile["trigger"],
	contextUsage: { tokens: number; percent: number | null },
	contextWindow: number | undefined,
): boolean {
	const { type, threshold } = trigger;

	switch (type) {
		case "context_percent":
			if (contextUsage.percent === null) return false;
			return contextUsage.percent >= threshold;

		case "fixed":
			return contextUsage.tokens >= threshold;

		case "reserve": {
			if (contextWindow === undefined || contextWindow <= 0) {
				// Fallback: derive window from percent if available
				if (contextUsage.percent === null || contextUsage.percent <= 0)
					return false;
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
 * Execute compaction with the active profile's settings.
 */
function doCompact(
	pi: ExtensionAPI,
	ctx: Parameters<Parameters<typeof pi.on>[1]>[1],
	profile: CompactionProfile,
) {
	if (compactingInProgress) {
		log.info("Compaction already in progress, skipping");
		return;
	}

	compactingInProgress = true;
	const triggerProfile = profile;

	if (ctx.hasUI) {
		ctx.ui.notify(
			`Compaction starting (${describeTrigger(profile.trigger)})`,
			"info",
		);
	}

	ctx.compact({
		onComplete: () => {
			log.info("Compaction completed successfully");
			compactingInProgress = false;

			if (ctx.hasUI) {
				ctx.ui.notify("Compaction completed", "info");
			}

			if (triggerProfile.autoContinue) {
				const msg = triggerProfile.autoContinueMessage || "continue";
				log.info("Auto-continue: sending message:", msg);
				pi.sendUserMessage(msg, {
					deliverAs: "followUp",
				});
			}
		},
		onError: (err) => {
			log.error("Compaction failed:", err.message);
			compactingInProgress = false;

			if (ctx.hasUI) {
				ctx.ui.notify(`Compaction failed: ${err.message}`, "error");
			}
		},
	});
}

// ── Extension entry ─────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	log.info("Extension loaded");

	// Load config on startup
	loadConfig();

	// ── On session start/reload: set session ID, load session-specific config ──
	pi.on("session_start", async (_event, ctx) => {
		const sid = ctx.sessionManager.getSessionId();
		if (sid) {
			setSessionId(sid);
		} else {
			reloadConfig();
		}
	});

	// ── Register /custom-compaction-setting command ───────────
	pi.registerCommand("custom-compaction-setting", {
		description: "Open custom compaction settings panel",
		handler: async (_args, ctx) => {
			reloadConfig();
			await openSettingsPanel(ctx);
		},
	});

	// ── Register /custom-compact command ──────────────────────
	// Usage:
	//   /custom-compact                        — pick profile via selector (Tab to supplement)
	//   /custom-compact <profile-name>         — compact with the named profile
	const triggerHandler = async (
		_args: string,
		ctx: ExtensionCommandContext,
	) => {
		const config = loadConfig();
		const entries = Object.entries(config.profiles);
		if (entries.length === 0) {
			if (ctx.hasUI) ctx.ui.notify("No compaction profiles available", "error");
			return;
		}

		let chosenProfile: CompactionProfile | undefined;
		let supplement: string | undefined;
		const trimmedName = _args.trim();

		if (trimmedName) {
			// Arg given → try to match as profile id or name (case-insensitive)
			const match = entries.find(
				([id, p]) =>
					id.toLowerCase() === trimmedName.toLowerCase() ||
					p.name.toLowerCase() === trimmedName.toLowerCase(),
			);
			if (match) {
				chosenProfile = match[1];
			} else if (ctx.hasUI) {
				ctx.ui.notify(`Profile "${trimmedName}" not found`, "warning");
			}
		}

		if (!chosenProfile) {
			// Resolve which profile to use
			if (entries.length === 1) {
				chosenProfile = entries[0][1];
				// Supplement can still be provided via the selector prompt
			} else if (ctx.hasUI) {
				// Use the shared selector for multi-profile picker
				const selectOptions = entries.map(([id, p]) => ({
					value: id,
					label: p.name,
					description: describeTrigger(p.trigger),
				}));
				const result = await showSelect(
					ctx,
					"选择 compaction profile  (Tab 可补充说明)",
					selectOptions,
				);
				if (!result) return;
				chosenProfile = config.profiles[result.value];
				supplement = result.supplement;
			} else {
				return;
			}
		}

		// Store supplement for the compactor to pick up
		if (supplement) setPendingSupplement(supplement);
		doCompact(pi, ctx, chosenProfile!);
	};

	pi.registerCommand("custom-compact", {
		description:
			"Trigger compaction manually. Usage: /custom-compact [profile-name]. " +
			"Without a profile name, pick one via selector (Tab for supplementary instructions).",
		handler: triggerHandler,
	});

	// ── Proactive trigger: monitor context usage on agent_end ──
	// agent_end fires when the agent has completed its processing loop.
	// We do NOT check isIdle() here because pi's internal isStreaming
	// flag is still true when agent_end fires (even though processing is done).
	// The compactingInProgress flag prevents re-entry.
	pi.on("agent_end", async (_event, ctx) => {
		if (compactingInProgress) return;

		const config = loadConfig();
		const profile = config.profiles[config.activeProfileId];
		if (!profile) return;

		const contextUsage = ctx.getContextUsage();
		if (!contextUsage) {
			log.info("Proactive trigger: getContextUsage() returned undefined");
			return;
		}
		if (contextUsage.tokens === null) {
			log.info("Proactive trigger: tokens is null");
			return;
		}

		const contextWindow = ctx.model?.contextWindow;
		log.info(
			"Proactive trigger check:",
			`${contextUsage.tokens.toLocaleString()} tokens`,
			contextUsage.percent !== null
				? `(${contextUsage.percent.toFixed(1)}%)`
				: "",
			"trigger type:",
			profile.trigger.type,
			"threshold:",
			profile.trigger.threshold,
		);

		if (
			shouldTrigger(
				profile.trigger,
				contextUsage as { tokens: number; percent: number | null },
				contextWindow,
			)
		) {
			log.info("Proactive compaction triggered", {
				type: profile.trigger.type,
				threshold: profile.trigger.threshold,
				tokens: contextUsage.tokens,
				percent: contextUsage.percent,
			});
			doCompact(pi, ctx, profile);
		}
	});

	// ── Intercept compaction: custom summarization ────────────
	pi.on("session_before_compact", buildCompactionHandler());

	// ── Cleanup after compaction (belt-and-suspenders) ────────
	pi.on("session_compact", async () => {
		compactingInProgress = false;
	});

	// ── Cleanup on session shutdown ───────────────────────────
	pi.on("session_shutdown", async () => {
		compactingInProgress = false;
	});
}
