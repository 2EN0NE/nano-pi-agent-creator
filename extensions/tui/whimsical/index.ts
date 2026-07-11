/**
 * Whimsical extension — Chinese working messages with sigma-based difficulty.
 *
 * Displays a context-aware working message based on 4 session metrics:
 * (a) thinking steps count, (b) avg turns per question,
 * (c) user questions, (d) tool types used.
 *
 * Each metric is compared to historical session data using z-scores.
 * The most anomalous dimension determines the message pool.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createLogger } from "@zenone/pi-logger";

import {
	computeSigma,
	pickWorstDimension,
	computeColorLevel,
} from "./sigma.js";
import type { ColorLevel } from "./sigma.js";
import { MetricsTracker } from "./metrics.js";
import {
	appendSession,
	loadSessions,
	saveLiveState,
	loadLiveState,
	deleteLiveState,
} from "./session-store.js";
import type { SessionMetrics } from "./session-store.js";
import { DIMENSION_KEYS, pickMessage } from "./messages.js";
import type { DimensionKey } from "./messages.js";

const log = createLogger("whimsical");

/**
 * Build a lookup of { dimension → historical values } from all past sessions.
 */
function buildHistoryLookup(
	sessions: { metrics: SessionMetrics }[],
): Record<DimensionKey, number[]> {
	const history: Record<DimensionKey, number[]> = {
		thinkingSteps: [],
		avgTurnsPerQuestion: [],
		userQuestions: [],
		toolTypesUsed: [],
	};

	for (const s of sessions) {
		history.thinkingSteps.push(s.metrics.thinkingSteps);
		history.avgTurnsPerQuestion.push(s.metrics.avgTurnsPerQuestion);
		history.userQuestions.push(s.metrics.userQuestions);
		history.toolTypesUsed.push(s.metrics.toolTypesUsed);
	}

	return history;
}

export default function whimsicalExtension(pi: ExtensionAPI) {
	const tracker = new MetricsTracker();
	let sessionId: string | undefined;
	let sessionCwd: string | undefined;
	let loadedHistory: Record<DimensionKey, number[]> | null = null;
	let shuttingDown = false;

	// Event-driven refresh state (replaces polling tick)
	let currentCtx: ExtensionContext | null = null;
	let refreshTimer: ReturnType<typeof setTimeout> | null = null;

	// -------------------------------------------------------------------------
	// Checkpoint: persist current tracker state to the live file so it
	// survives extension re-initialization (/reload, pi -r).
	// -------------------------------------------------------------------------
	function saveCheckpoint() {
		if (!sessionId) return;
		const raw = tracker.exportRawState();
		saveLiveState({
			sessionId,
			timestamp: Date.now(),
			cwd: sessionCwd ?? "",
			...raw,
		});
	}

	// -------------------------------------------------------------------------
	// Debounced refresh: coalesces rapid metric changes into a single TUI
	// update, avoiding unnecessary re-renders during bursts of tool calls
	// or thinking steps.
	// -------------------------------------------------------------------------
	function cancelRefresh() {
		if (refreshTimer !== null) {
			clearTimeout(refreshTimer);
			refreshTimer = null;
		}
	}

	function scheduleRefresh() {
		cancelRefresh();
		// Only schedule if we have a ctx to work with (i.e., inside an active turn)
		if (!currentCtx) return;
		refreshTimer = setTimeout(() => {
			refreshTimer = null;
			if (currentCtx) refreshMessage(currentCtx);
		}, 300); // 300ms debounce — responsive without overwhelming TUI
	}

	// -------------------------------------------------------------------------
	// Core: refresh the working message based on current metrics
	// -------------------------------------------------------------------------
	function refreshMessage(ctx: ExtensionContext) {
		// Guard: don't touch UI after shutdown has started
		if (!loadedHistory || shuttingDown) return;

		const snapshot = tracker.snapshot();

		saveCheckpoint(); // Persist mid-session state after any metric change

		// Compute sigma for each dimension
		const results: Record<
			DimensionKey,
			{ mean: number; std: number; zScore: number; level: 0 | 1 | 2 }
		> = {} as any;

		for (const dim of DIMENSION_KEYS) {
			const history = loadedHistory[dim];
			const current =
				dim === "avgTurnsPerQuestion"
					? snapshot.avgTurnsPerQuestion
					: dim === "thinkingSteps"
						? snapshot.thinkingSteps
						: dim === "userQuestions"
							? snapshot.userQuestions
							: snapshot.toolTypesUsed;
			results[dim] = computeSigma(history, current);
		}

		// Pick the most anomalous dimension
		const worst = pickWorstDimension(results, DIMENSION_KEYS);
		if (!worst) {
			ctx.ui.setWorkingMessage("工作中...");
			return;
		}

		const msg = pickMessage(
			worst.dimension as DimensionKey,
			worst.result.level,
		);

		// Compute max color level across all dimensions
		let maxColorLevel: ColorLevel = 0;
		for (const dim of DIMENSION_KEYS) {
			const cl = computeColorLevel(results[dim].zScore);
			if (cl > maxColorLevel) maxColorLevel = cl;
		}

		// Map color level to theme color name
		const colorNames: Record<ColorLevel, string> = {
			0: "thinkingOff",
			1: "thinkingMinimal",
			2: "thinkingLow",
			3: "thinkingMedium",
			4: "thinkingHigh",
			5: "thinkingXhigh",
		};
		const coloredMsg = ctx.ui.theme.fg(colorNames[maxColorLevel] as any, msg);

		// Structured info log — fires only when metrics actually change
		log.info(
			"whimsical:refresh dimension=%s level=%d zScore=%s colorLevel=%d colorName=%s message=%s thinkingSteps=%d avgTurns=%s questions=%d tools=%d",
			worst.dimension,
			worst.result.level,
			worst.result.zScore.toFixed(3),
			maxColorLevel,
			colorNames[maxColorLevel],
			msg,
			snapshot.thinkingSteps,
			snapshot.avgTurnsPerQuestion.toFixed(3),
			snapshot.userQuestions,
			snapshot.toolTypesUsed,
		);

		ctx.ui.setWorkingMessage(coloredMsg);
	}

	// -------------------------------------------------------------------------
	// Event Handlers
	// -------------------------------------------------------------------------

	// 1. Load historical data and reset tracker at session start.
	//    Also restore any mid-session live state from a previous extension
	//    incarnation (survives /reload, pi -r, or any re-initialization).
	pi.on("session_start", async (_event, ctx) => {
		log.debug("event: session_start");

		sessionId = ctx.sessionManager.getSessionId();
		sessionCwd = ctx.cwd;
		tracker.reset();
		shuttingDown = false;

		// Restore live state if one exists for this session
		const live = await loadLiveState(sessionId);
		if (live) {
			tracker.importRawState({
				thinkingSteps: live.thinkingSteps,
				userQuestions: live.userQuestions,
				agentTurns: live.agentTurns,
				toolTypes: live.toolTypes,
			});
			log.info(
				"whimsical:restore sessionId=%s thinkingSteps=%d userQuestions=%d agentTurns=%d toolTypes=%d",
				sessionId,
				live.thinkingSteps,
				live.userQuestions,
				live.agentTurns,
				live.toolTypes.length,
			);
		}

		// Load historical session data
		const sessions = await loadSessions();
		loadedHistory = buildHistoryLookup(sessions);
		log.info(
			"whimsical:history sessions=%d thinkingSteps=%d avgTurns=%d questions=%d tools=%d",
			sessions.length,
			loadedHistory.thinkingSteps.length,
			loadedHistory.avgTurnsPerQuestion.length,
			loadedHistory.userQuestions.length,
			loadedHistory.toolTypesUsed.length,
		);
	});

	// 2. Track user input (questions) — only human-typed questions
	pi.on("input", (event, _ctx) => {
		if (event.source !== "interactive") return;
		tracker.incrementUserQuestions();
		scheduleRefresh();
	});

	// 3. Track tool executions (for distinct tool types)
	pi.on("tool_execution_start", (event) => {
		tracker.recordToolType(event.toolName);
		scheduleRefresh();
	});

	// 4. Track thinking steps via message_update events
	pi.on("message_update", (event) => {
		if (
			event.message.role === "assistant" &&
			event.assistantMessageEvent?.type === "thinking_start"
		) {
			tracker.incrementThinkingSteps();
			scheduleRefresh();
		}
	});

	// 5. On turn_start: set a working message
	pi.on("turn_start", (_event, ctx) => {
		log.debug("event: turn_start");
		currentCtx = ctx;
		refreshMessage(ctx);
	});

	// 6. On turn_end: track turns, persist checkpoint, clear message
	pi.on("turn_end", (_event, ctx) => {
		log.debug("event: turn_end");
		tracker.incrementAgentTurns();
		cancelRefresh();
		currentCtx = null;
		saveCheckpoint(); // Persist at turn boundary (safe checkpoint)
		ctx.ui.setWorkingMessage(); // Reset to default
	});

	// 7. On session shutdown: persist metrics
	pi.on("session_shutdown", async (_event, ctx) => {
		log.debug("event: session_shutdown");
		shuttingDown = true;
		cancelRefresh();
		currentCtx = null;
		ctx.ui.setWorkingMessage();

		if (sessionId) {
			const metrics = tracker.toSessionMetrics();
			await appendSession({
				sessionId,
				timestamp: Date.now(),
				cwd: sessionCwd ?? ctx.cwd,
				metrics,
			});
			await deleteLiveState(sessionId); // Clean up mid-session state
			log.info(
				"whimsical:persist sessionId=%s thinkingSteps=%d avgTurns=%s questions=%d tools=%d",
				sessionId,
				metrics.thinkingSteps,
				metrics.avgTurnsPerQuestion.toFixed(3),
				metrics.userQuestions,
				metrics.toolTypesUsed,
			);
		}
	});
}
