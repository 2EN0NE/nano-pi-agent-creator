/**
 * pi-logger: Lifecycle capture
 *
 * Automatically generates structured log events from pi's lifecycle events.
 * This provides "free" logging for ALL extensions (including npm-installed ones)
 * without requiring any changes to their source code.
 *
 * Covers 15+ event types: tool execution, turns, messages, agent lifecycle,
 * model selection, session events, bash commands, etc.
 *
 * All lifecycle logs use source="__lifecycle__" which can be independently
 * controlled in the config file:
 *   { "loggers": { "__lifecycle__": "info" } }
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { LOG_EVENT_CHANNEL, LIFECYCLE_SOURCE } from "./types.js";
import type { LogEvent, LogLevel } from "./types.js";

// ============================================================================
// Helpers
// ============================================================================

function now(): number {
	return Date.now();
}

/** Abbreviate a value for log display. */
function summarizeValue(value: unknown, maxLen = 80): string {
	if (typeof value === "string") {
		return value.length <= maxLen ? value : value.slice(0, maxLen - 3) + "...";
	}
	try {
		const json = JSON.stringify(value);
		return json.length <= maxLen ? json : json.slice(0, maxLen - 3) + "...";
	} catch {
		return String(value).slice(0, maxLen);
	}
}

/** Extract a summary of tool arguments suitable for logging (omit large payloads). */
function summarizeArgs(args: unknown): string {
	if (!args || typeof args !== "object") return String(args);
	const obj = args as Record<string, unknown>;
	const safe: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(obj)) {
		if (
			[
				"code",
				"content",
				"file_text",
				"fileContent",
				"newText",
				"oldText",
			].includes(key)
		) {
			safe[key] = `<${typeof value === "string" ? value.length : "?"} bytes>`;
		} else {
			safe[key] = value;
		}
	}
	return summarizeValue(safe, 120);
}

// ============================================================================
// Timing tracking
// ============================================================================

const turnStartTimes = new Map<number, number>();
const toolStartTimes = new Map<string, number>();

// ============================================================================
// Emit a log event to the EventBus
// ============================================================================

function emit(
	pi: ExtensionAPI,
	level: LogLevel,
	message: string,
	details?: unknown,
): void {
	const event: LogEvent = {
		level,
		source: LIFECYCLE_SOURCE,
		message,
		details,
		timestamp: now(),
	};
	pi.events.emit(LOG_EVENT_CHANNEL, event);
}

// ============================================================================
// Setup: register all lifecycle hooks
// ============================================================================

/**
 * Register all lifecycle event handlers.
 *
 * @param pi - ExtensionAPI for accessing events
 * @param _ctx - ExtensionContext for session info
 * @returns A cleanup function (currently a no-op, as pi manages disposable handlers)
 */
export function setupLifecycleCapture(
	pi: ExtensionAPI,
	_ctx: ExtensionContext,
): () => void {
	// ── Tool Execution ──────────────────────────────────────────────────

	pi.on(
		"tool_execution_start",
		(event: { toolCallId: string; toolName: string; args: unknown }) => {
			toolStartTimes.set(event.toolCallId, now());
			emit(pi, "trace", `[tool] → ${event.toolName}`, {
				toolCallId: event.toolCallId,
				args: summarizeArgs(event.args),
			});
		},
	);

	pi.on(
		"tool_execution_end",
		(event: {
			toolCallId: string;
			toolName: string;
			result: unknown;
			isError: boolean;
		}) => {
			const startTime = toolStartTimes.get(event.toolCallId);
			const duration = startTime ? now() - startTime : 0;
			toolStartTimes.delete(event.toolCallId);

			const level: LogLevel = event.isError ? "warn" : "info";
			emit(
				pi,
				level,
				`[tool] ← ${event.toolName}  ${duration}ms  ${event.isError ? "✗" : "✓"}`,
				{
					toolCallId: event.toolCallId,
					duration,
					isError: event.isError,
					resultPreview: summarizeValue(event.result),
				},
			);
		},
	);

	// ── Turns ────────────────────────────────────────────────────────────

	pi.on("turn_start", (event: { turnIndex: number }) => {
		turnStartTimes.set(event.turnIndex, now());
		emit(pi, "trace", `[turn] → #${event.turnIndex}`, {
			turnIndex: event.turnIndex,
		});
	});

	pi.on("turn_end", (event: { turnIndex: number; toolResults?: unknown[] }) => {
		const startTime = turnStartTimes.get(event.turnIndex);
		const duration = startTime ? now() - startTime : 0;
		turnStartTimes.delete(event.turnIndex);

		emit(pi, "info", `[turn] ← #${event.turnIndex}  ${duration}ms`, {
			turnIndex: event.turnIndex,
			duration,
			toolResults: event.toolResults?.length ?? 0,
		});
	});

	// ── Messages ──────────────────────────────────────────────────────────

	pi.on("message_start", (event: { message: { role?: string } }) => {
		const role = event.message?.role ?? "unknown";
		emit(pi, "trace", `[msg] → ${role}`, { role });
	});

	pi.on(
		"message_end",
		(event: { message: { role?: string; usage?: unknown } }) => {
			const role = event.message?.role ?? "unknown";
			const usage = event.message?.usage;
			emit(pi, "info", `[msg] ← ${role}`, { role, usage: usage ?? undefined });
		},
	);

	// ── Agent ────────────────────────────────────────────────────────────

	pi.on("agent_start", () => {
		emit(pi, "info", "[agent] →");
	});

	pi.on("agent_end", (event: { messages?: unknown[] }) => {
		emit(pi, "info", "[agent] ←", { messages: event.messages?.length ?? 0 });
	});

	// ── Model / Thinking ─────────────────────────────────────────────────

	pi.on(
		"model_select",
		(event: {
			model?: { id?: string; provider?: string };
			previousModel?: { id?: string };
		}) => {
			const modelId = event.model?.id ?? "unknown";
			const provider = event.model?.provider ?? "?";
			emit(pi, "info", `[model] ${provider}/${modelId}`, {
				provider,
				modelId,
				previousModel: event.previousModel?.id,
			});
		},
	);

	// ── Session ──────────────────────────────────────────────────────────

	pi.on("session_start", (event: { reason: string }) => {
		const sid = _ctx.sessionManager.getSessionId();
		emit(pi, "info", `[session] → ${sid}  reason=${event.reason}`, {
			sessionId: sid,
			reason: event.reason,
		});
	});

	pi.on("session_shutdown", (event: { reason: string }) => {
		emit(pi, "info", `[session] ←  reason=${event.reason}`, {
			reason: event.reason,
		});
	});

	pi.on(
		"session_compact",
		(event: {
			compactionEntry?: { tokensBefore?: number; summary?: string };
		}) => {
			const entry = event.compactionEntry;
			emit(
				pi,
				"info",
				`[session] compact  tokens=${entry?.tokensBefore ?? "?"}`,
				{
					tokensBefore: entry?.tokensBefore,
					summary: entry?.summary
						? summarizeValue(entry.summary, 80)
						: undefined,
				},
			);
		},
	);

	// ── Bash ─────────────────────────────────────────────────────────────

	pi.on(
		"user_bash",
		(event: { command: string; excludeFromContext: boolean; cwd: string }) => {
			emit(
				pi,
				"info",
				`[bash] ${event.excludeFromContext ? "!! " : "! "}${summarizeValue(event.command, 80)}`,
				{
					command: event.command,
					excludeFromContext: event.excludeFromContext,
					cwd: event.cwd,
				},
			);
		},
	);

	// Return cleanup (pi.on returns void, so this is a no-op)
	return () => {
		// Cleanup handled by pi's session lifecycle on session_shutdown
	};
}
