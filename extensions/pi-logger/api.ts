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

import type { EventBus } from "@earendil-works/pi-coding-agent";
import type { LogEvent, LogLevel, Logger } from "./types.js";
import { LOG_EVENT_CHANNEL } from "./types.js";

// ============================================================================
// Global EventBus reference (set by initEventBus, called from index.ts)
// ============================================================================

let _bus: EventBus | null = null;

/**
 * Initialize the EventBus reference. Called by the pi-logger extension factory
 * (index.ts) at startup. Must be called before any createLogger() usage.
 */
export function initEventBus(bus: EventBus): void {
	_bus = bus;
}

/**
 * Get the current EventBus reference (for lifecycle-capture etc.).
 * Returns null if initEventBus has not been called yet.
 */
export function getEventBus(): EventBus | null {
	return _bus;
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
function formatMessage(
	template: string,
	args: unknown[],
): { message: string; details?: unknown } {
	if (args.length === 0) {
		return { message: template };
	}

	// Check for format specifiers
	if (/%(?:[sdjoO]|%)/.test(template)) {
		let idx = 0;
		const formatted = template.replace(/%(?:[sdjoO%])/g, (match) => {
			if (match === "%%") return "%";
			if (idx >= args.length) return match;
			const arg = args[idx++];
			switch (match) {
				case "%s":
					return String(arg);
				case "%d":
					return String(Number(arg));
				case "%j":
				case "%O":
				case "%o":
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
			remaining.length === 1 &&
			typeof remaining[0] === "object" &&
			remaining[0] !== null
				? remaining[0]
				: remaining.length > 0
					? remaining
					: undefined;

		return { message: formatted, details };
	}

	// No format specifiers: append non-object args as space-separated suffix
	const nonObject = args.filter((a) => typeof a !== "object" || a === null);
	const objects = args.filter((a) => typeof a === "object" && a !== null);
	const suffix = nonObject.length > 0 ? " " + nonObject.join(" ") : "";
	const details =
		objects.length === 1
			? objects[0]
			: objects.length > 0
				? objects
				: undefined;

	return { message: template + suffix, details };
}

// ============================================================================
// Internal: emit a structured LogEvent onto the EventBus
// ============================================================================

function emitLogEvent(
	level: LogLevel,
	source: string,
	message: string,
	details?: unknown,
): void {
	if (!_bus) return; // silently drop until initEventBus is called

	const event: LogEvent = {
		level,
		source,
		message,
		details,
		timestamp: Date.now(),
	};
	_bus.emit(LOG_EVENT_CHANNEL, event);
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
	if (!name || typeof name !== "string") {
		throw new Error(
			`createLogger requires a non-empty string name, got ${typeof name}`,
		);
	}

	const logger: Logger = {
		trace(message: string, ...args: unknown[]): void {
			const { message: msg, details } = formatMessage(message, args);
			emitLogEvent("trace", name, msg, details);
		},
		debug(message: string, ...args: unknown[]): void {
			const { message: msg, details } = formatMessage(message, args);
			emitLogEvent("debug", name, msg, details);
		},
		info(message: string, ...args: unknown[]): void {
			const { message: msg, details } = formatMessage(message, args);
			emitLogEvent("info", name, msg, details);
		},
		warn(message: string, ...args: unknown[]): void {
			const { message: msg, details } = formatMessage(message, args);
			emitLogEvent("warn", name, msg, details);
		},
		error(message: string, ...args: unknown[]): void {
			const { message: msg, details } = formatMessage(message, args);
			emitLogEvent("error", name, msg, details);
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
		throw new Error(
			"childLogger: parent logger was not created by createLogger()",
		);
	}
	return createLogger(`${parentName}.${childName}`);
}
