/**
 * pi-logger: Logger API
 *
 * Provides createLogger(name) for extensions to create named loggers.
 * Extensions call logger.info(), logger.debug(), etc. without caring about
 * output destinations or level filtering — all handled centrally by the
 * pi-logger extension via the EventBus.
 *
 * Usage in any extension:
 * ```typescript
 * import { createLogger } from '<path>/pi-logger/api.js';
 * const log = createLogger('my-extension');
 * log.info('Hello %s', 'world');
 * log.error('Failed: %s', err.message);
 * log.warn('Something suspicious', { file, line });
 * ```
 */

import type { EventBus } from '@earendil-works/pi-coding-agent';
import type { LogEvent, LogLevel, Logger } from './types.js';
import { LOG_EVENT_CHANNEL } from './types.js';

// ============================================================================
// Global EventBus reference (stored on globalThis to survive jiti module isolation)
//
// jiti loads extensions with moduleCache:false, so each extension gets its own
// module instance of api.ts. Module-level variables are NOT shared across jiti
// instances. We use globalThis so all instances see the same EventBus reference.
// ============================================================================

const GLOBAL_EVENTBUS_KEY = '__pi_logger_eventbus__';

// ============================================================================
// Event buffer: capture log events emitted before initEventBus() is called.
// Fixes the startup ordering issue where other extensions' factories run before
// pi-logger's factory.  Buffered events are flushed on initEventBus().
// ============================================================================

const GLOBAL_BUFFER_KEY = '__pi_logger_pending_events__';

// Upper bound for buffered events. The buffer exists to absorb log calls made
// (a) before initEventBus() and (b) while the globalThis bus still points at a
// stale extension runtime right after a session replacement. Bounding it keeps
// an unbounded flush from growing the process memory.
const MAX_BUFFERED_EVENTS = 2000;

// 缓冲满丢弃的限频告警标志（每个 runtime 只告警一次）
let BUFFER_DROP_WARNED = false;

function getPendingEvents(): LogEvent[] {
	const g = globalThis as Record<string, unknown>;
	if (!g[GLOBAL_BUFFER_KEY]) {
		g[GLOBAL_BUFFER_KEY] = [] as LogEvent[];
	}
	return g[GLOBAL_BUFFER_KEY] as LogEvent[];
}

/**
 * True when the error indicates the EventBus points at an invalidated
 * extension runtime (session replacement or reload).
 *
 * 匹配 pi 的稳定错误措辞（runner.js `invalidate()` / `assertActive()` 抛出的
 * staleMessage 固定以 "This extension ctx is stale after session replacement
 * or reload" 开头），避免用宽泛正则误吞无关错误消息。
 */
function isStaleBusError(err: unknown): boolean {
	return (
		err instanceof Error &&
		err.message.startsWith('This extension ctx is stale after session replacement or reload')
	);
}

/**
 * Initialize the EventBus reference AND flush any buffered events.
 * Called by the pi-logger extension factory (index.ts) at startup.
 */
export function initEventBus(bus: EventBus): void {
	(globalThis as Record<string, unknown>)[GLOBAL_EVENTBUS_KEY] = bus;

	// Flush buffered events
	const pending = getPendingEvents();
	if (pending.length > 0) {
		for (const event of pending) {
			bus.emit(LOG_EVENT_CHANNEL, event);
		}
		pending.length = 0;
	}
}

/**
 * Get the current EventBus reference (for lifecycle-capture etc.).
 * Returns null if initEventBus has not been called yet.
 */
export function getEventBus(): EventBus | null {
	return ((globalThis as Record<string, unknown>)[GLOBAL_EVENTBUS_KEY] as EventBus) ?? null;
}

// ============================================================================
// Message formatting
// ============================================================================

/**
 * Simple printf-style format supporting standard specifiers.
 *
 * - %s → String(arg)
 * - %d → Number(arg)
 * - %j / %o → JSON.stringify(arg)
 * - %% → literal "%"
 *
 * If no format specifiers are present, args are space-appended to the message.
 * The last positional arg that is a plain object becomes the `details` field.
 */
function formatMessage(template: string, args: unknown[]): { message: string; details?: unknown } {
	if (args.length === 0) {
		return { message: template };
	}

	// Check for format specifiers
	if (/%(?:[sdjoO]|%)/.test(template)) {
		let idx = 0;
		const formatted = template.replace(/%(?:[sdjoO%])/g, (match) => {
			if (match === '%%') return '%';
			if (idx >= args.length) return match;
			const arg = args[idx++];
			switch (match) {
				case '%s':
					return String(arg);
				case '%d':
					return String(Number(arg));
				case '%j':
				case '%O':
				case '%o':
					try {
						return JSON.stringify(arg, null, 2);
					} catch {
						return String(arg);
					}
				default:
					return String(arg);
			}
		});

		const remaining = args.slice(idx);
		const details =
			remaining.length === 1 && typeof remaining[0] === 'object' && remaining[0] !== null
				? remaining[0]
				: remaining.length > 0
					? remaining
					: undefined;

		return { message: formatted, details };
	}

	// No format specifiers: append non-object args as space-separated suffix
	const nonObject = args.filter((a) => typeof a !== 'object' || a === null);
	const objects = args.filter((a) => typeof a === 'object' && a !== null);
	const suffix = nonObject.length > 0 ? ' ' + nonObject.join(' ') : '';
	const details = objects.length === 1 ? objects[0] : objects.length > 0 ? objects : undefined;

	return { message: template + suffix, details };
}

// ============================================================================
// Internal: emit a structured LogEvent onto the EventBus
// ============================================================================

/**
 * Buffer a log event with an upper bound. Shared by both buffering windows:
 * (a) before initEventBus() has run, and (b) while the globalThis bus points
 * at a stale extension runtime right after a session replacement. Bounding
 * keeps an unbounded flush from growing the process memory; when full, later
 * events are dropped with a once-per-runtime warning instead of silently.
 */
function bufferEvent(event: LogEvent): void {
	const pending = getPendingEvents();
	if (pending.length < MAX_BUFFERED_EVENTS) {
		pending.push(event);
	} else if (!BUFFER_DROP_WARNED) {
		// 缓冲满后丢弃后续事件：有界设计防内存膨胀，但静默丢弃会让日志
		// 缺失无从排查——限频告警一次。
		BUFFER_DROP_WARNED = true;
		console.error(
			'[pi-logger] event buffer full (' +
				MAX_BUFFERED_EVENTS +
				'), dropping log events until initEventBus() re-points the bus',
		);
	}
}

function emitLogEvent(level: LogLevel, source: string, message: string, details?: unknown): void {
	const bus = getEventBus();
	const event: LogEvent = {
		level,
		source,
		message,
		details,
		timestamp: Date.now(),
	};
	if (bus) {
		try {
			bus.emit(LOG_EVENT_CHANNEL, event);
		} catch (err) {
			// The globalThis bus may still point at a stale extension runtime
			// right after a session replacement (resume/newSession/fork/
			// switchSession/reload), before pi-logger's factory re-runs and
			// re-points it at the current runtime's events. Buffer instead of
			// throwing so a single stale reference cannot take down unrelated
			// extensions; buffered events flush on the next initEventBus().
			if (isStaleBusError(err)) {
				bufferEvent(event);
				return;
			}
			// Not a stale-bus error: log the throw for diagnosis (e.g. if pi
			// ever rewords the stale message, this surfaces the mismatch)
			// before propagating — a failing log call must not be silently
			// absorbed, but the caller should see why it happened.
			console.error('[pi-logger] bus.emit failed (non-stale error)', {
				error: err instanceof Error ? err.message : String(err),
			});
			throw err;
		}
	} else {
		// Buffer until pi-logger's initEventBus() is called
		bufferEvent(event);
	}
}

// ============================================================================
// Logger Name Tracking (for childLogger support)
// ============================================================================

const LOGGER_NAMES = new WeakMap<Logger, string>();

/** Retrieve the stored name of a Logger (used by childLogger). */
export function getLoggerName(logger: Logger): string | undefined {
	return LOGGER_NAMES.get(logger);
}

// ============================================================================
// Logger creation
// ============================================================================

/**
 * Create a named logger instance.
 *
 * @param name - Logger name (e.g., "review", "review.file-scanner", "sandbox")
 * @returns A Logger object with .trace(), .debug(), .info(), .warn(), .error()
 *
 * @example
 * ```typescript
 * const log = createLogger('my-ext');
 * log.info('processing file %s', path);
 * log.error('failed: %s', err.message, { code: err.code });
 * ```
 */
export function createLogger(name: string): Logger {
	if (!name || typeof name !== 'string') {
		throw new Error(`createLogger requires a non-empty string name, got ${typeof name}`);
	}

	const logger: Logger = {
		trace(message: string, ...args: unknown[]): void {
			const { message: msg, details } = formatMessage(message, args);
			emitLogEvent('trace', name, msg, details);
		},
		debug(message: string, ...args: unknown[]): void {
			const { message: msg, details } = formatMessage(message, args);
			emitLogEvent('debug', name, msg, details);
		},
		info(message: string, ...args: unknown[]): void {
			const { message: msg, details } = formatMessage(message, args);
			emitLogEvent('info', name, msg, details);
		},
		warn(message: string, ...args: unknown[]): void {
			const { message: msg, details } = formatMessage(message, args);
			emitLogEvent('warn', name, msg, details);
		},
		error(message: string, ...args: unknown[]): void {
			const { message: msg, details } = formatMessage(message, args);
			emitLogEvent('error', name, msg, details);
		},
	};

	LOGGER_NAMES.set(logger, name);
	return logger;
}

/**
 * Create a child logger whose name inherits the parent's prefix.
 *
 * @example
 * ```typescript
 * const log = createLogger('review');
 * const scanLog = childLogger(log, 'file-scanner');
 * scanLog.info('scanning...');   // source = "review.file-scanner"
 * ```
 */
export function childLogger(parent: Logger, childName: string): Logger {
	const parentName = LOGGER_NAMES.get(parent);
	if (!parentName) {
		throw new Error('childLogger: parent logger was not created by createLogger()');
	}
	return createLogger(`${parentName}.${childName}`);
}
