/**
 * pi-logger: Core type definitions
 *
 * Defines the log levels, log event structure, logger interface,
 * appender configuration, and logger configuration schema.
 */

// ============================================================================
// Log Levels
// ============================================================================

export const LOG_LEVELS = [
	"trace",
	"debug",
	"info",
	"warn",
	"error",
	"off",
] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Numeric ordering: lower = more verbose, higher = more severe. "off" = Infinity */
export const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
	trace: 0,
	debug: 1,
	info: 2,
	warn: 3,
	error: 4,
	off: 99,
};

// ============================================================================
// Log Event (transported via EventBus)
// ============================================================================

export interface LogEvent {
	/** Log severity level */
	level: LogLevel;
	/** Logger/source name (e.g., "review", "sandbox", "__lifecycle__") */
	source: string;
	/** Human-readable log message (may include formatted values) */
	message: string;
	/** Optional structured data attached to the log event */
	details?: unknown;
	/** Epoch milliseconds */
	timestamp: number;
	/** Session ID at the time of logging, if available */
	sessionId?: string;
	/** Tool name, if this log is related to a tool execution */
	toolName?: string;
	/** Turn index, if available */
	turnIndex?: number;
}

// ============================================================================
// Logger Interface (what extensions use)
// ============================================================================

export interface Logger {
	trace(message: string, ...args: unknown[]): void;
	debug(message: string, ...args: unknown[]): void;
	info(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
	error(message: string, ...args: unknown[]): void;
}

// ============================================================================
// Appender Configuration
// ============================================================================

export interface FileAppenderConfig {
	enabled: boolean;
	/** Directory for log files. Default: ~/.pi/logs */
	path?: string;
	/** Log pattern. Default: "[%d{ISO}] [%p] [%c] %m%n" */
	pattern?: string;
	/** Minimum level for this appender. Default: trace */
	level?: LogLevel;
}

export interface ConsoleAppenderConfig {
	enabled: boolean;
	/** Minimum level for console output. Default: info */
	level?: LogLevel;
	/** Whether to use ANSI colors. Default: true */
	color?: boolean;
}

// ============================================================================
// Logger Configuration (from logger.json)
// ============================================================================

export interface LoggerConfig {
	/** Default level for all loggers. Default: "info" */
	defaultLevel?: LogLevel;
	/** Per-logger level overrides (hierarchical name matching) */
	loggers?: Record<string, LogLevel>;
	/** Appender configurations */
	appenders?: {
		file?: FileAppenderConfig;
		console?: ConsoleAppenderConfig;
	};
}

// ============================================================================
// Runtime State
// ============================================================================

export interface LoggerRuntimeConfig {
	defaultLevel: LogLevel;
	loggers: Record<string, LogLevel>;
	appenders: {
		file: Required<FileAppenderConfig>;
		console: Required<ConsoleAppenderConfig>;
	};
}

// ============================================================================
// Channel name used on EventBus
// ============================================================================

export const LOG_EVENT_CHANNEL = "log";
export const LIFECYCLE_SOURCE = "__lifecycle__";
