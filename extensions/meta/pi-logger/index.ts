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
 *   /log level             Interactive TUI: change log level with persist dialog
 *   /log tail [n]          Show last n log entries from current file
 *   /log path              Show current log file path
 *   /log set-output <file|console|both>
 *
 * Usage:
 *   pi -e ./pi-logger --log-level debug
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveConfigPaths } from '@zenone/pi-config';
import { DynamicBorder } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import type { SelectItem } from '@earendil-works/pi-tui';
import { Container, SelectList, Text } from '@earendil-works/pi-tui';
import { initEventBus } from './api.js';
import type { LogEvent, LogLevel } from './types.js';
import { LOG_EVENT_CHANNEL, LOG_LEVELS } from './types.js';
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
} from './config.js';
import { initFileAppender, writeFileLog, getLogDir } from './appenders/file-appender.js';
import { writeConsoleLog } from './appenders/console-appender.js';

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
// Log-event deduplication: collapse identical events within a short window.
//
// pi reloads extensions via /reload, which re-executes factory functions
// and re-registers event handlers.  Each handler can independently emit the
// same log call (same source, level, message), producing N copies.
// This cache deduplicates by (source, level, message) within a 500 ms window
// so downstream consumers (file, console, tail-buffer) see each event once.
// ============================================================================

const DEDUP_WINDOW_MS = 500;
const recentEvents = new Map<string, number>(); // key !92 timestamp

function dedupCheck(event: LogEvent): boolean {
	const key = `${event.source}\x00${event.level}\x00${event.message}`;
	const last = recentEvents.get(key);
	const now = event.timestamp;
	if (last !== undefined && now - last < DEDUP_WINDOW_MS) {
		return true; // duplicate
	}
	recentEvents.set(key, now);

	// Periodic cleanup: drop entries older than the window
	if (recentEvents.size > 300) {
		for (const [k, t] of recentEvents) {
			if (now - t > DEDUP_WINDOW_MS) recentEvents.delete(k);
		}
	}
	return false;
}

// ============================================================================
// Log handler: receive events from EventBus, filter, route to appenders
// ============================================================================

async function handleLogEvent(event: LogEvent, config = getRuntimeConfig()): Promise<void> {
	// 1. Check per-logger level filter
	if (!shouldLog(event.source, event.level)) return;

	// 2. Deduplicate identical events arriving within DEDUP_WINDOW_MS
	//    (protects against /reload-triggered duplicate handler registrations)
	if (dedupCheck(event)) return;

	// 3. Push to tail buffer (always, regardless of appenders)
	pushTail(event);

	// 4. Route to appenders
	// 4a. File appender
	if (config.appenders.file.enabled && shouldAppend(config.appenders.file.level, event.level)) {
		await writeFileLog(event, config);
	}

	// 4b. Console appender
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
	return String(n).padStart(w, '0');
}

// ============================================================================
// Interactive TUI helpers for /log level
// ============================================================================

/**
 * Step 1: Select a logger (or "default") to configure.
 */
async function interactiveSelectLogger(ctx: ExtensionCommandContext): Promise<string | null> {
	const config = getEffectiveConfig();

	// Collect unique sources from tail buffer + already-configured loggers
	const sourceSet = new Set<string>();
	for (const e of tailBuffer) {
		sourceSet.add(e.source);
	}
	for (const name of Object.keys(config.loggers)) {
		sourceSet.add(name);
	}

	const items: SelectItem[] = [
		{
			value: '__default__',
			label: 'default (for all loggers)',
			description: `Current level: ${config.defaultLevel}`,
		},
		...[...sourceSet].sort().map((s) => ({
			value: s,
			label: s,
			description: `Current: ${config.loggers[s] ?? `inherited (${config.defaultLevel})`}`,
		})),
	];

	return await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg('accent', s)));
		container.addChild(
			new Text(theme.fg('accent', theme.bold('Select Logger to Configure')), 1, 0),
		);
		const selectList = new SelectList(items, Math.min(items.length, 12), {
			selectedPrefix: (t) => theme.fg('accent', t),
			selectedText: (t) => theme.fg('accent', t),
			description: (t) => theme.fg('muted', t),
			scrollInfo: (t) => theme.fg('dim', t),
			noMatch: (t) => theme.fg('warning', t),
		});
		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(null);
		container.addChild(selectList);
		container.addChild(
			new Text(theme.fg('dim', '↑↓ navigate • enter select • esc cancel'), 1, 0),
		);
		container.addChild(new DynamicBorder((s: string) => theme.fg('accent', s)));
		return {
			render: (w) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

function levelDescription(level: LogLevel): string {
	switch (level) {
		case 'trace':
			return 'All events (most verbose)';
		case 'debug':
			return 'Debug and above';
		case 'info':
			return 'Info and above (default)';
		case 'warn':
			return 'Warnings and errors only';
		case 'error':
			return 'Errors only';
		case 'off':
			return 'Suppress all logging';
	}
}

/**
 * Step 2: Select a log level.
 */
async function interactiveSelectLevel(
	ctx: ExtensionCommandContext,
	loggerName: string,
): Promise<LogLevel | null> {
	const items: SelectItem[] = LOG_LEVELS.map((l) => ({
		value: l,
		label: l.toUpperCase(),
		description: levelDescription(l),
	}));

	return await ctx.ui.custom<LogLevel | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg('accent', s)));
		container.addChild(
			new Text(
				theme.fg(
					'accent',
					theme.bold(
						`Set Log Level for "${loggerName === '__default__' ? 'default' : loggerName}"`,
					),
				),
				1,
				0,
			),
		);
		const selectList = new SelectList(items, Math.min(items.length, 10), {
			selectedPrefix: (t) => theme.fg('accent', t),
			selectedText: (t) => theme.fg('accent', t),
			description: (t) => theme.fg('muted', t),
			scrollInfo: (t) => theme.fg('dim', t),
			noMatch: (t) => theme.fg('warning', t),
		});
		selectList.onSelect = (item) => done(item.value as LogLevel);
		selectList.onCancel = () => done(null);
		container.addChild(selectList);
		container.addChild(
			new Text(theme.fg('dim', '↑↓ navigate • enter select • esc cancel'), 1, 0),
		);
		container.addChild(new DynamicBorder((s: string) => theme.fg('accent', s)));
		return {
			render: (w) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

/**
 * Step 3: Ask whether to persist the change to config file.
 */
async function interactivePersist(
	ctx: ExtensionCommandContext,
	loggerName: string,
	level: LogLevel,
): Promise<void> {
	const projectPath = resolveConfigPaths('pi-logger', { cwd: ctx.cwd }).projectFile;
	const globalPath = resolveConfigPaths('pi-logger').userFile;

	const items: SelectItem[] = [
		{
			value: 'project',
			label: 'Save to project config',
			description: `Write to project: ${projectPath}`,
		},
		{
			value: 'global',
			label: 'Save to global config',
			description: `Write to user global: ${globalPath}`,
		},
		{
			value: 'none',
			label: 'Session only',
			description: "Don't persist, apply to current session only",
		},
	];

	const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg('accent', s)));
		container.addChild(
			new Text(theme.fg('accent', theme.bold('Persist Log Level Change?')), 1, 0),
		);
		const selectList = new SelectList(items, items.length, {
			selectedPrefix: (t) => theme.fg('accent', t),
			selectedText: (t) => theme.fg('accent', t),
			description: (t) => theme.fg('muted', t),
			scrollInfo: (t) => theme.fg('dim', t),
			noMatch: (t) => theme.fg('warning', t),
		});
		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done('none');
		container.addChild(selectList);
		container.addChild(
			new Text(
				theme.fg(
					'dim',
					`${loggerName === '__default__' ? 'Default' : loggerName} → ${level.toUpperCase()}`,
				),
				1,
				0,
			),
		);
		container.addChild(
			new Text(theme.fg('dim', '↑↓ navigate • enter select • esc = session only'), 1, 0),
		);
		container.addChild(new DynamicBorder((s: string) => theme.fg('accent', s)));
		return {
			render: (w) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});

	if (!result || result === 'none') {
		ctx.ui.notify('Log level change applied to current session only', 'info');
		return;
	}

	const configPath = result === 'project' ? projectPath : globalPath;

	// Read existing config or start fresh
	let config: Record<string, unknown> = {};
	if (existsSync(configPath)) {
		try {
			config = JSON.parse(readFileSync(configPath, 'utf-8'));
		} catch {
			config = {};
		}
	}

	// Update the level
	if (loggerName === '__default__') {
		config.defaultLevel = level;
	} else {
		config.loggers = config.loggers ?? {};
		(config.loggers as Record<string, unknown>)[loggerName] = level;
	}

	// Ensure directory exists
	const dir = dirname(configPath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');

	// Reload configuration to pick up changes
	reloadConfiguration(ctx.cwd);
	await initFileAppender(getRuntimeConfig());

	ctx.ui.notify(`Log level saved to ${configPath}`, 'info');
}

async function logCommandHandler(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const trimmed = args.trim();
	const parts = trimmed.split(/\s+/).filter(Boolean);
	const subcommand = parts[0]?.toLowerCase();

	switch (subcommand) {
		case 'config': {
			const sub = parts[1]?.toLowerCase();
			if (sub === 'reload') {
				reloadConfiguration(ctx.cwd);
				if (ctx.hasUI) {
					ctx.ui.notify('Logger config reloaded', 'info');
				} else {
					console.log('Logger config reloaded');
				}
				return;
			}

			if (sub === 'level') {
				const loggerName = parts[2];
				const newLevel = parts[3]?.toLowerCase() as LogLevel | undefined;

				if (loggerName && newLevel && LOG_LEVELS.includes(newLevel)) {
					setLoggerLevel(loggerName, newLevel);
					if (ctx.hasUI) {
						ctx.ui.notify(`Logger level set: ${loggerName} = ${newLevel}`, 'info');
					} else {
						console.log(`Logger level set: ${loggerName} = ${newLevel}`);
					}
					return;
				}

				if (loggerName) {
					// Show current level for this logger
					const config = getEffectiveConfig();
					const level = config.loggers[loggerName] ?? 'inherited';
					if (ctx.hasUI) {
						ctx.ui.notify(`Level for "${loggerName}": ${level}`, 'info');
					} else {
						console.log(`Level for "${loggerName}": ${level}`);
					}
					return;
				}

				// Show all configured loggers
				const config = getEffectiveConfig();
				const lines = [`Default level: ${config.defaultLevel}`, 'Per-logger levels:'];
				for (const [name, level] of Object.entries(config.loggers)) {
					lines.push(`  ${name}: ${level}`);
				}
				const text = lines.join('\n');
				if (ctx.hasUI) {
					ctx.ui.notify(text, 'info');
				} else {
					console.log(text);
				}
				return;
			}

			// Show full config
			const cfg = getEffectiveConfig();
			const cfgLines = [
				`Default level: ${cfg.defaultLevel}`,
				`Loggers: ${Object.entries(cfg.loggers).length > 0 ? '' : '(none configured)'}`,
			];
			for (const [name, level] of Object.entries(cfg.loggers)) {
				cfgLines.push(`  ${name}: ${level}`);
			}
			cfgLines.push(
				`File appender: ${cfg.appenders.file.enabled ? 'enabled' : 'disabled'}`,
				`  path: ${cfg.appenders.file.path}`,
				`  level: ${cfg.appenders.file.level}`,
				`Console appender: ${cfg.appenders.console.enabled ? 'enabled' : 'disabled'}`,
				`  level: ${cfg.appenders.console.level}`,
				`  color: ${cfg.appenders.console.color}`,
			);

			if (ctx.hasUI) {
				ctx.ui.notify(cfgLines.join('\n'), 'info');
			} else {
				console.log(cfgLines.join('\n'));
			}
			return;
		}

		case 'tail': {
			const n = parts[1] ? parseInt(parts[1], 10) : 20;
			const count = isNaN(n) || n <= 0 ? 20 : Math.min(n, 200);
			const events = getTail(count);
			if (events.length === 0) {
				if (ctx.hasUI) {
					ctx.ui.notify('No log entries in buffer', 'info');
				} else {
					console.log('No log entries in buffer');
				}
				return;
			}
			const lines = events.map(formatTailEvent);
			const text = lines.join('\n');
			if (ctx.hasUI) {
				ctx.ui.notify(`Last ${events.length} log entries:\n${text}`, 'info');
			} else {
				console.log(`Last ${events.length} log entries:\n${text}`);
			}
			return;
		}

		case 'path': {
			const logDir = getLogDir();
			if (logDir) {
				if (ctx.hasUI) {
					ctx.ui.notify(`Log directory: ${logDir}  (files: <source>_<date>.log)`, 'info');
				} else {
					console.log(`Log directory: ${logDir}  (files: <source>_<date>.log)`);
				}
			} else {
				if (ctx.hasUI) {
					ctx.ui.notify(
						'Log directory not initialized. Ensure file appender is enabled.',
						'warning',
					);
				} else {
					console.log('Log directory not initialized. Ensure file appender is enabled.');
				}
			}
			return;
		}

		case 'set-output': {
			const mode = parts[1]?.toLowerCase() as 'file' | 'console' | 'both' | undefined;
			if (!mode || !['file', 'console', 'both'].includes(mode)) {
				const msg = 'Usage: /log set-output file|console|both';
				if (ctx.hasUI) {
					ctx.ui.notify(msg, 'warning');
				} else {
					console.log(msg);
				}
				return;
			}
			setOutputMode(mode);
			if (ctx.hasUI) {
				ctx.ui.notify(`Log output set to: ${mode}`, 'info');
			} else {
				console.log(`Log output set to: ${mode}`);
			}
			return;
		}

		case 'level': {
			// Interactive log level changer (TUI only)
			if (!ctx.hasUI) {
				console.log('Use /log config level <name> [level] in non-TUI mode');
				return;
			}

			// Step 1: Select logger
			const loggerName = await interactiveSelectLogger(ctx);
			if (!loggerName) return;

			// Step 2: Select level
			const level = await interactiveSelectLevel(ctx, loggerName);
			if (!level) return;

			// Step 3: Apply to current session
			if (loggerName === '__default__') {
				setDefaultLevel(level);
			} else {
				setLoggerLevel(loggerName, level);
			}

			const displayName = loggerName === '__default__' ? 'default' : loggerName;
			ctx.ui.notify(`Log level changed: ${displayName} → ${level.toUpperCase()}`, 'info');

			// Step 4: Ask whether to persist
			await interactivePersist(ctx, loggerName, level);
			return;
		}

		default: {
			const help = [
				'pi-logger commands:',
				'  /log config                      Show current configuration',
				'  /log config reload               Reload config files',
				'  /log config level <name> [level]  Get/set per-logger level',
				'  /log level                       Interactive log level changer',
				'  /log tail [n]                    Show last n log entries (default: 20)',
				'  /log path                        Show current log file path',
				'  /log set-output file|console|both',
			].join('\n');
			if (ctx.hasUI) {
				ctx.ui.notify(help, 'info');
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

	// 0. Early EventBus initialization — idempotent via globalThis guard.
	//    jiti loads extensions with moduleCache:false, which can cause this
	//    factory to run multiple times if the module is loaded through different
	//    jiti instances.  The guard ensures initEventBus + listener registration
	//    happens at most once per Node process, preventing duplicate log entries.
	const _G = globalThis as Record<string, unknown>;
	const FACTORY_GUARD = '__pi_logger_factory_init_guard__';

	if (!_G[FACTORY_GUARD]) {
		_G[FACTORY_GUARD] = true;
		initEventBus(pi.events);
		pi.events.on(LOG_EVENT_CHANNEL, (data: unknown) => {
			const event = data as LogEvent;
			if (event && typeof event === 'object' && 'level' in event && 'source' in event) {
				void handleLogEvent(event);
			}
		});
	}

	void initFileAppender(getRuntimeConfig());

	// 1. Register CLI flags
	pi.registerFlag('log-level', {
		description: 'Set default log level (trace, debug, info, warn, error, off)',
		type: 'string',
	});

	// 2. On session_start: reload config with proper cwd and reinit appender
	pi.on('session_start', async (_event, ctx) => {
		// Reload config (bundled + user + project), resolve paths against cwd
		loadConfiguration(ctx.cwd);

		// Apply CLI flag override if provided
		const flagLevel = pi.getFlag('log-level');
		if (
			typeof flagLevel === 'string' &&
			(LOG_LEVELS as readonly string[]).includes(flagLevel)
		) {
			setDefaultLevel(flagLevel as LogLevel);
		}

		// Reinitialize file appender with the project-resolved path
		await initFileAppender(getRuntimeConfig());

		// Import and setup lifecycle capture dynamically
		try {
			const { setupLifecycleCapture } = await import('./lifecycle-capture.js');
			lifecycleUnsubscribe = setupLifecycleCapture(pi, ctx);
		} catch (err) {
			// Lifecycle capture is optional; if it fails, continue without it
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`pi-logger: failed to setup lifecycle capture: ${msg}`);
		}
	});

	// 3. Register /log command
	pi.registerCommand('log', {
		description: 'Control the pi-logger system (config, level, tail, path, set-output)',
		handler: logCommandHandler,
	});

	// 4. Status widget
	pi.on('session_start', async (_event, ctx) => {
		if (!ctx.hasUI) return;
		const config = getRuntimeConfig();
		const level = config.defaultLevel;
		const dimLevels = new Set(['info', 'off']);
		const color = dimLevels.has(level) ? 'dim' : 'accent';
		ctx.ui.setStatus('pi-logger', ctx.ui.theme.fg(color as any, `| log:${level}`));
	});

	// 5. Cleanup on shutdown
	pi.on('session_shutdown', async () => {
		if (lifecycleUnsubscribe) {
			lifecycleUnsubscribe();
			lifecycleUnsubscribe = null;
		}
	});
}
