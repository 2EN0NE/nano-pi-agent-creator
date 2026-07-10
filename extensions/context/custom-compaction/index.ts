/**
 * Custom Compaction Extension
 *
 * A folder-based extension that replaces Pi's default compaction behavior
 * with profile-based, configurable compaction strategies.
 *
 * Features:
 * - Uses Pi's current model for summarization (no manual API key resolution)
 * - Profile-based configuration (model, trigger threshold, prompt, auto-continue)
 * - Interactive settings panel via /custom-compaction-setting command
 * - Proactive compaction trigger based on context window percentage
 * - Auto-continue after compaction to resume work seamlessly
 *
 * Configuration is persisted in:
 *   ~/.pi/agent/extensions-data/custom-compaction/<sessionId>.json
 * (deterministic path, survives /reload)
 *
 * Usage:
 *   pi --extension custom-compaction
 *   /custom-compaction-setting  (open settings panel)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// @ts-expect-error — @zenone/pi-logger resolves api.ts at runtime
import { createLogger } from "@zenone/pi-logger";
import { loadConfig, reloadConfig, setSessionId } from "./config.js";
import { buildCompactionHandler } from "./compactor.js";
import { openSettingsPanel } from "./settings-panel.js";

const log = createLogger("custom-compaction");

/** Debounce flag: true while a compaction is in progress */
let compactingInProgress = false;

export default function (pi: ExtensionAPI) {
	log.info("Extension loaded");

	// Load config on startup
	loadConfig();

	// ── On session start/reload: set session ID, load session-specific config ──
	// Session configs are stored as <sessionId>.json under ~/.pi/agent/extensions-data/custom-compaction/.
	// This path is deterministic and not affected by jiti module caching, so
	// settings survive /reload correctly.
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
			// Reload config before opening panel (ensures fresh state)
			reloadConfig();
			await openSettingsPanel(ctx);
		},
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

		// Only trigger if strategy is context_percent
		if (profile.strategy.type !== "context_percent") return;

		const contextUsage = ctx.getContextUsage();
		if (!contextUsage) {
			log.info("Proactive trigger: getContextUsage() returned undefined");
			return;
		}
		if (contextUsage.percent === null) {
			log.info("Proactive trigger: context percent is null");
			return;
		}

		log.info(
			"Proactive trigger check: context",
			`${contextUsage.percent.toFixed(1)}%`,
			"(threshold:",
			`${profile.strategy.threshold}%)`,
			"idle:",
			ctx.isIdle(),
		);

		if (contextUsage.percent >= profile.strategy.threshold) {
			log.info(
				"Proactive compaction triggered at",
				contextUsage.percent.toFixed(1),
				"%",
			);
			compactingInProgress = true;

			// Capture profile in closure for onComplete (it may have been updated
			// by the time compact() finishes, but we want the trigger-time profile).
			const triggerProfile = profile;

			ctx.compact({
				onComplete: () => {
					log.info("Compaction completed successfully");
					compactingInProgress = false;

					// Auto-continue after compaction fully completes.
					// We do this in onComplete rather than session_compact because
					// session_compact fires mid-compact while the agent is disconnected
					// (after _disconnectFromAgent), and pi.sendUserMessage() →
					// this.prompt() is unreliable in that state. onComplete fires
					// after compact() returns, when the agent is reconnected.
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
				},
			});
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
