/**
 * pi-logger: Main extension factory
 *
 * Ties together the three subsystems:
 * 1. Logger API (api.ts) — provides createLogger() for other extensions
 * 2. Config Engine (config.ts) — hierarchical per-logger level control
 * 3. Lifecycle Capture (lifecycle-capture.ts) — auto-log for 3rd-party extensions
 *
 * Extension flags:
 *   --log-level <level>    Override default log level at startup
 *
 * Commands:
 *   /log config            Show current configuration
 *   /log config reload     Reload config files
 *   /log config level <name> [level]  Get/set per-logger level
 *   /log tail [n]          Show last n log entries from current file
 *   /log path              Show current log file path
 *   /log set-output <file|console|both>
 *
 * Usage:
 *   pi -e ./pi-logger --log-level debug
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { initEventBus } from "./api.js";
import {
	loadConfiguration,
	getRuntimeConfig,
	setDefaultLevel,
	setLoggerLevel,
	setOutputMode,
	reloadConfiguration,
	getEffectiveConfig,
	shouldLog,
	shouldAppend,
} from "./config.js";
import {
	initFileAppender,
	writeFileLog,
	getLogDir,
} from "./appenders/file-appender.js";
import { writeConsoleLog } from "./appenders/console-appender.js";
import {
	type LogEvent,
	type LogLevel,
	LOG_EVENT_CHANNEL,
	LOG_LEVELS,
} from "./types.js";

// ============================================================================
// In-memory ring buffer for /log tail
// ============================================================================

const MAX_TAIL_BUFFER = 500;
const tailBuffer: LogEvent[] = [];

function pushTail(event: LogEvent): void {
	tailBuffer.push(event);
	if (tailBuffer.length > MAX_TAIL_BUFFER) {
		tailBuffer.splice(0, tailBuffer.length - MAX_TAIL_BUFFER);
	}
}

function getTail(n: number): LogEvent[] {
	const count = Math.min(n, tailBuffer.length);
	return tailBuffer.slice(-count);
}

// ============================================================================
// Log handler: receive events from EventBus, filter, route to appenders
// ============================================================================

async function handleLogEvent(
	event: LogEvent,
	config = getRuntimeConfig(),
): Promise<void> {
	// 1. Check per-logger level filter
	if (!shouldLog(event.source, event.level)) return;

	// 2. Push to tail buffer (always, regardless of appenders)
	pushTail(event);

	// 3. Route to appenders
	// File appender
	if (
		config.appenders.file.enabled &&
		shouldAppend(config.appenders.file.level, event.level)
	) {
		await writeFileLog(event, config);
	}

	// Console appender
	if (
		config.appenders.console.enabled &&
		shouldAppend(config.appenders.console.level, event.level)
	) {
		writeConsoleLog(event, config);
	}
}

// ============================================================================
// /log command handler
// ============================================================================

function formatTailEvent(event: LogEvent): string {
	const d = new Date(event.timestamp);
	const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
	const level = event.level.toUpperCase().padEnd(5);
	return `${time} ${level} [${event.source}] ${event.message}`;
}

function pad(n: number, w = 2): string {
	return String(n).padStart(w, "0");
}

async function logCommandHandler(
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const trimmed = args.trim();
	const parts = trimmed.split(/\s+/).filter(Boolean);
	const subcommand = parts[0]?.toLowerCase();

	switch (subcommand) {
		case "config": {
			const sub = parts[1]?.toLowerCase();
			if (sub === "reload") {
				reloadConfiguration(ctx.cwd);
				if (ctx.hasUI) {
					ctx.ui.notify("Logger config reloaded", "info");
				} else {
					console.log("Logger config reloaded");
				}
				return;
			}

			if (sub === "level") {
				const loggerName = parts[2];
				const newLevel = parts[3]?.toLowerCase() as LogLevel | undefined;

				if (loggerName && newLevel && LOG_LEVELS.includes(newLevel)) {
					setLoggerLevel(loggerName, newLevel);
					if (ctx.hasUI) {
						ctx.ui.notify(
							`Logger level set: ${loggerName} = ${newLevel}`,
							"info",
						);
					} else {
						console.log(`Logger level set: ${loggerName} = ${newLevel}`);
					}
					return;
				}

				if (loggerName) {
					// Show current level for this logger
					const config = getEffectiveConfig();
					const level = config.loggers[loggerName] ?? "inherited";
					if (ctx.hasUI) {
						ctx.ui.notify(`Level for "${loggerName}": ${level}`, "info");
					} else {
						console.log(`Level for "${loggerName}": ${level}`);
					}
					return;
				}

				// Show all configured loggers
				const config = getEffectiveConfig();
				const lines = [
					`Default level: ${config.defaultLevel}`,
					"Per-logger levels:",
				];
				for (const [name, level] of Object.entries(config.loggers)) {
					lines.push(`  ${name}: ${level}`);
				}
				const text = lines.join("\n");
				if (ctx.hasUI) {
					ctx.ui.notify(text, "info");
				} else {
					console.log(text);
				}
				return;
			}

			// Show full config
			const cfg = getEffectiveConfig();
			const cfgLines = [
				`Default level: ${cfg.defaultLevel}`,
				`Loggers: ${Object.entries(cfg.loggers).length > 0 ? "" : "(none configured)"}`,
			];
			for (const [name, level] of Object.entries(cfg.loggers)) {
				cfgLines.push(`  ${name}: ${level}`);
			}
			cfgLines.push(
				`File appender: ${cfg.appenders.file.enabled ? "enabled" : "disabled"}`,
				`  path: ${cfg.appenders.file.path}`,
				`  level: ${cfg.appenders.file.level}`,
				`Console appender: ${cfg.appenders.console.enabled ? "enabled" : "disabled"}`,
				`  level: ${cfg.appenders.console.level}`,
				`  color: ${cfg.appenders.console.color}`,
			);

			if (ctx.hasUI) {
				ctx.ui.notify(cfgLines.join("\n"), "info");
			} else {
				console.log(cfgLines.join("\n"));
			}
			return;
		}

		case "tail": {
			const n = parts[1] ? parseInt(parts[1], 10) : 20;
			const count = isNaN(n) || n <= 0 ? 20 : Math.min(n, 200);
			const events = getTail(count);
			if (events.length === 0) {
				if (ctx.hasUI) {
					ctx.ui.notify("No log entries in buffer", "info");
				} else {
					console.log("No log entries in buffer");
				}
				return;
			}
			const lines = events.map(formatTailEvent);
			const text = lines.join("\n");
			if (ctx.hasUI) {
				ctx.ui.notify(`Last ${events.length} log entries:\n${text}`, "info");
			} else {
				console.log(`Last ${events.length} log entries:\n${text}`);
			}
			return;
		}

		case "path": {
			const logDir = getLogDir();
			if (logDir) {
				if (ctx.hasUI) {
					ctx.ui.notify(
						`Log directory: ${logDir}  (files: <source>_<date>.log)`,
						"info",
					);
				} else {
					console.log(`Log directory: ${logDir}  (files: <source>_<date>.log)`);
				}
			} else {
				if (ctx.hasUI) {
					ctx.ui.notify(
						"Log directory not initialized. Ensure file appender is enabled.",
						"warning",
					);
				} else {
					console.log(
						"Log directory not initialized. Ensure file appender is enabled.",
					);
				}
			}
			return;
		}

		case "set-output": {
			const mode = parts[1]?.toLowerCase() as
				| "file"
				| "console"
				| "both"
				| undefined;
			if (!mode || !["file", "console", "both"].includes(mode)) {
				const msg = "Usage: /log set-output file|console|both";
				if (ctx.hasUI) {
					ctx.ui.notify(msg, "warning");
				} else {
					console.log(msg);
				}
				return;
			}
			setOutputMode(mode);
			if (ctx.hasUI) {
				ctx.ui.notify(`Log output set to: ${mode}`, "info");
			} else {
				console.log(`Log output set to: ${mode}`);
			}
			return;
		}

		default: {
			const help = [
				"pi-logger commands:",
				"  /log config                      Show current configuration",
				"  /log config reload               Reload config files",
				"  /log config level <name> [level]  Get/set per-logger level",
				"  /log tail [n]                    Show last n log entries (default: 20)",
				"  /log path                        Show current log file path",
				"  /log set-output file|console|both",
			].join("\n");
			if (ctx.hasUI) {
				ctx.ui.notify(help, "info");
			} else {
				console.log(help);
			}
		}
	}
}

// ============================================================================
// Extension factory
// ============================================================================

export default function loggerExtension(pi: ExtensionAPI) {
	// Track lifecycle unsubscribe for cleanup
	let lifecycleUnsubscribe: (() => void) | null = null;

	// 1. Register CLI flags
	pi.registerFlag("log-level", {
		description: "Set default log level (trace, debug, info, warn, error, off)",
		type: "string",
	});

	// 2. Initialize subsystems once we have a session context
	pi.on("session_start", async (_event, ctx) => {
		// Initialize config (loads from files)
		loadConfiguration(ctx.cwd);

		// Apply CLI flag override if provided
		const flagLevel = pi.getFlag("log-level");
		if (
			typeof flagLevel === "string" &&
			(LOG_LEVELS as readonly string[]).includes(flagLevel)
		) {
			setDefaultLevel(flagLevel as LogLevel);
		}

		// Initialize file appender
		await initFileAppender(getRuntimeConfig());

		// Initialize EventBus reference for api.ts (createLogger)
		initEventBus(pi.events);

		// Subscribe to log events from the EventBus
		pi.events.on(LOG_EVENT_CHANNEL, (data: unknown) => {
			const event = data as LogEvent;
			if (
				event &&
				typeof event === "object" &&
				"level" in event &&
				"source" in event
			) {
				void handleLogEvent(event);
			}
		});

		// Import and setup lifecycle capture dynamically
		try {
			const { setupLifecycleCapture } = await import("./lifecycle-capture.js");
			lifecycleUnsubscribe = setupLifecycleCapture(pi, ctx);
		} catch (err) {
			// Lifecycle capture is optional; if it fails, continue without it
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`pi-logger: failed to setup lifecycle capture: ${msg}`);
		}
	});

	// 4. Register /log command
	pi.registerCommand("log", {
		description:
			"Control the pi-logger system (config, tail, path, set-output)",
		handler: logCommandHandler,
	});

	// 5. Register /log argument completions
	// (We'll handle this in the command itself)

	// 6. Status widget
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		const config = getRuntimeConfig();
		ctx.ui.setStatus(
			"pi-logger",
			ctx.ui.theme.fg("dim", `log:${config.defaultLevel}`),
		);
	});

	// 7. Cleanup on shutdown
	pi.on("session_shutdown", async () => {
		if (lifecycleUnsubscribe) {
			lifecycleUnsubscribe();
			lifecycleUnsubscribe = null;
		}
	});
}
