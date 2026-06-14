/**
 * pi-logger: File appender
 *
 * Writes log events to daily-rotated files, one per logger source.
 * Filename format: {source}_{YYYYMMDD}.log
 *
 * Example files:
 *   review_20260614.log
 *   __lifecycle___20260614.log
 *   my-extension_20260614.log
 */

import { appendFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { LogEvent, LoggerRuntimeConfig } from "../types.js";

// ============================================================================
// Pattern formatting
// ============================================================================

function pad(n: number, width = 2): string {
	return String(n).padStart(width, "0");
}

function formatTimestamp(ts: number): string {
	const d = new Date(ts);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function todayDateCompact(): string {
	const d = new Date();
	return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

/**
 * Sanitize a source name for use as a filename component.
 * Replaces characters unsafe for filenames with underscores.
 */
function sanitizeSource(source: string): string {
	return source.replace(/[<>:"/\\|?*.]/g, "_").replace(/\s+/g, "_");
}

/**
 * Format a log event according to the configured pattern.
 *
 * Pattern tokens:
 *   %d{ISO}   → ISO 8601 timestamp
 *   %d        → ISO 8601 timestamp (same as %d{ISO})
 *   %p        → Log level (uppercase, 5-char padded)
 *   %c        → Logger/source name
 *   %m        → Log message
 *   %n        → Newline
 *   %%        → Literal %
 */
function formatEvent(event: LogEvent, pattern: string): string {
	const levelPadded = event.level.toUpperCase().padEnd(5);

	return pattern
		.replace(/%d\{ISO\}/g, formatTimestamp(event.timestamp))
		.replace(/%d/g, formatTimestamp(event.timestamp))
		.replace(/%p/g, levelPadded)
		.replace(/%c/g, event.source)
		.replace(/%m/g, event.message)
		.replace(/%n/g, "\n")
		.replace(/%%/g, "%");
}

// ============================================================================
// File appender
// ============================================================================

export interface FileAppenderState {
	/** Log directory path */
	logDir: string;
	/** Current date string (for rotation check across all source files) */
	currentDate: string;
}

let _state: FileAppenderState | null = null;

/**
 * Initialize the file appender. Ensures log directory exists.
 */
export async function initFileAppender(
	config: LoggerRuntimeConfig,
): Promise<void> {
	const logDir = config.appenders.file.path;
	if (!existsSync(logDir)) {
		await mkdir(logDir, { recursive: true });
	}
	_state = {
		logDir,
		currentDate: todayDateCompact(),
	};
}

/**
 * Append a log event to the per-source daily log file.
 * Automatically rotates to a new file when the date changes.
 *
 * @example
 *   writeFileLog({ source: "review", ... }, config)
 *   // writes to {logDir}/review_20260614.log
 */
export async function writeFileLog(
	event: LogEvent,
	config: LoggerRuntimeConfig,
): Promise<void> {
	const appenderConfig = config.appenders.file;
	if (!appenderConfig.enabled) return;

	// Ensure initialized
	if (!_state) {
		await initFileAppender(config);
	}

	// Check rotation
	const today = todayDateCompact();
	if (_state!.currentDate !== today) {
		_state!.currentDate = today;
	}

	// Per-source filename: {sanitizedSource}_{YYYYMMDD}.log
	const safeSource = sanitizeSource(event.source);
	const logFileName = `${safeSource}_${_state!.currentDate}.log`;
	const logFilePath = join(_state!.logDir, logFileName);

	const line = formatEvent(event, appenderConfig.pattern);
	try {
		await appendFile(logFilePath, line, "utf-8");
	} catch {
		// Silently fail on write errors (don't crash the agent)
	}
}

/**
 * Get the log directory path, or null if not initialized.
 */
export function getLogDir(): string | null {
	return _state?.logDir ?? null;
}
