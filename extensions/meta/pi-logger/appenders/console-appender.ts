/**
 * pi-logger: Console appender
 *
 * Writes log events to stderr with ANSI color coding (when enabled).
 * Uses stderr to avoid interfering with pi's TUI stdout rendering.
 */

import type { LogEvent, LoggerRuntimeConfig } from "../types.js";

// ============================================================================
// ANSI color codes
// ============================================================================

const ANSI = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",

	// Foreground colors
	gray: "\x1b[90m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	red: "\x1b[31m",
	magenta: "\x1b[35m",
	cyan: "\x1b[36m",
	white: "\x1b[37m",
};

const LEVEL_COLORS: Record<string, string> = {
	trace: ANSI.gray + ANSI.dim,
	debug: ANSI.gray,
	info: ANSI.green,
	warn: ANSI.yellow,
	error: ANSI.red + ANSI.bold,
};

const LEVEL_LABELS: Record<string, string> = {
	trace: "TRACE",
	debug: "DEBUG",
	info: "INFO",
	warn: "WARN",
	error: "ERROR",
};

// ============================================================================
// Console appender
// ============================================================================

/**
 * Write a log event to stderr with optional ANSI colors.
 */
export function writeConsoleLog(
	event: LogEvent,
	config: LoggerRuntimeConfig,
): void {
	const appenderConfig = config.appenders.console;
	if (!appenderConfig.enabled) return;

	const useColor = appenderConfig.color;
	const d = new Date(event.timestamp);
	const timeStr = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
	const levelStr = (
		LEVEL_LABELS[event.level] ?? event.level.toUpperCase()
	).padEnd(5);

	let line: string;

	if (useColor) {
		const levelColor = LEVEL_COLORS[event.level] ?? ANSI.white;
		const sourceColor = ANSI.cyan;
		line = `${ANSI.dim}${timeStr}${ANSI.reset} ${levelColor}${levelStr}${ANSI.reset} ${sourceColor}${event.source}${ANSI.reset} ${event.message}`;
	} else {
		line = `${timeStr} ${levelStr} ${event.source} ${event.message}`;
	}

	// Append details if present (compact JSON)
	if (event.details !== undefined) {
		try {
			const json = JSON.stringify(event.details, null, useColor ? 2 : 0);
			const maxLen = useColor ? 200 : 500;
			const truncated =
				json.length > maxLen ? json.slice(0, maxLen) + "..." : json;
			line += useColor
				? ` ${ANSI.dim}${truncated}${ANSI.reset}`
				: ` ${truncated}`;
		} catch {
			line += useColor
				? ` ${ANSI.dim}[unserializable]${ANSI.reset}`
				: " [unserializable]";
		}
	}

	// Use stderr to avoid interfering with pi's TUI stdout
	process.stderr.write(line + "\n");
}

function pad(n: number, width = 2): string {
	return String(n).padStart(width, "0");
}
