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
 *
 * **写入是同步的（appendFileSync），这是刻意的。** 日志的可靠性优先于吞吐：
 *  - 异步写在 `process.exit()`（pi print 模式收尾、harness 清理、异常退出）时会被丢弃，
 *    调用方 `void handleLogEvent(event)` 是火忘式的，没人会 await 它；
 *  - 异步入口的 `await mkdir()` 前置还会让「log 后立刻 exit」连入队都来不及；
 *  - 同步写同时消除了并发 append 的行序交错。
 * 单条日志是几十~几百字节的本地追加，成本远低于它在排障中的价值。
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { LogEvent, LoggerRuntimeConfig } from '../types.js';

// ============================================================================
// Pattern formatting
// ============================================================================

function pad(n: number, width = 2): string {
	return String(n).padStart(width, '0');
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
	return source.replace(/[<>:"/\\|?*.]/g, '_').replace(/\s+/g, '_');
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
		.replace(/%n/g, '\n')
		.replace(/%%/g, '%');
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
 * Ensure the appender is initialized for the configured log dir.
 *
 * 同步实现：首次写入前即可用，且不在 `writeFileLog` 里留下 `await` 前置——
 * 那条 `await` 会让「log 完立刻退出」的进程连队列都排不进。
 */
function ensureState(config: LoggerRuntimeConfig): void {
	const logDir = config.appenders.file.path;
	if (_state && _state.logDir === logDir) return;
	try {
		mkdirSync(logDir, { recursive: true });
	} catch {
		// 建目录失败（权限等）时仍记录状态：后续 append 同样会失败并被吞掉
	}
	_state = { logDir, currentDate: todayDateCompact() };
}

/**
 * Initialize the file appender. Ensures log directory exists.
 */
export async function initFileAppender(config: LoggerRuntimeConfig): Promise<void> {
	ensureState(config);
}

/**
 * Append a log event to the per-source daily log file.
 * Automatically rotates to a new file when the date changes.
 *
 * 同步落盘（见文件头说明）：调用返回时该行已写入，进程随后退出也不丢。
 *
 * @example
 *   writeFileLog({ source: "review", ... }, config)
 *   // writes to {logDir}/review_20260614.log
 */
export async function writeFileLog(event: LogEvent, config: LoggerRuntimeConfig): Promise<void> {
	const appenderConfig = config.appenders.file;
	if (!appenderConfig.enabled) return;

	ensureState(config);

	// Check rotation
	const today = todayDateCompact();
	if (_state!.currentDate !== today) {
		_state!.currentDate = today;
	}

	// Per-source filename: {sanitizedSource}_{YYYYMMDD}.log
	const safeSource = sanitizeSource(event.source);
	const logFileName = `${safeSource}_${_state!.currentDate}.log`;
	const logFilePath = join(_state!.logDir, logFileName);

	try {
		appendFileSync(logFilePath, formatEvent(event, appenderConfig.pattern), 'utf-8');
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
