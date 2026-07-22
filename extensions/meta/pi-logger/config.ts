/**
 * pi-logger: Configuration engine
 *
 * Java Logback-style hierarchical logger configuration.
 *
 * Config file locations (merged, later takes precedence, using pi-config standard):
 *   1. ./extensions/meta/pi-logger/pi-logger.json   (plugin-bundled default)
 *   2. ~/.pi/agent/extensions-data/pi-logger/config.json  (user global)
 *   3. <project-root>/.pi/extensions-data/pi-logger/config.json (project-local)
 *
 * Hierarchy rules (matches Log4j/Logback):
 *   Given logger name "review.file-scanner":
 *   1. Exact match "review.file-scanner" → use its level
 *   2. No match → walk up to "review" → use its level
 *   3. No match → use defaultLevel
 *   4. No defaultLevel → use "info"
 */

import type { LogLevel, LoggerConfig, LoggerRuntimeConfig } from './types.js';
import { LOG_LEVELS, LOG_LEVEL_ORDER } from './types.js';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { resolveConfigPaths } from '@zenone/pi-config';

// ============================================================================
// Config file name
// ============================================================================

const CONFIG_FILE = 'pi-logger.json';

// ============================================================================
// Default configuration (embedded in the plugin)
// ============================================================================

const DEFAULT_CONFIG: LoggerRuntimeConfig = {
	defaultLevel: 'info',
	loggers: {},
	appenders: {
		file: {
			enabled: true,
			path: join(homedir(), '.pi', 'logs'),
			pattern: '[%d{ISO}] [%p] [%c] %m%n',
			level: 'trace',
		},
		console: {
			enabled: false,
			level: 'info',
			color: true,
		},
	},
};

// ============================================================================
// In-memory runtime state
// ============================================================================

let _runtimeConfig: LoggerRuntimeConfig = deepClone(DEFAULT_CONFIG);

function deepClone(cfg: LoggerRuntimeConfig): LoggerRuntimeConfig {
	return {
		defaultLevel: cfg.defaultLevel,
		loggers: { ...cfg.loggers },
		appenders: {
			file: { ...cfg.appenders.file },
			console: { ...cfg.appenders.console },
		},
	};
}

// ============================================================================
// Config file loading
// ============================================================================

function loadConfigFile(path: string): LoggerConfig | null {
	try {
		if (!existsSync(path)) return null;
		const raw = readFileSync(path, 'utf-8');
		return JSON.parse(raw) as LoggerConfig;
	} catch {
		return null;
	}
}

function mergeConfig(base: LoggerRuntimeConfig, overlay: LoggerConfig): LoggerRuntimeConfig {
	return {
		defaultLevel: overlay.defaultLevel ?? base.defaultLevel,
		loggers: { ...base.loggers, ...overlay.loggers },
		appenders: {
			file: { ...base.appenders.file, ...overlay.appenders?.file },
			console: { ...base.appenders.console, ...overlay.appenders?.console },
		},
	};
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Resolve the effective level for a given logger name.
 *
 * Hierarchical lookup:
 * 1. Exact match (e.g., "review.file-scanner")
 * 2. Walk up the dot-separated hierarchy ("review", then "")
 * 3. Use defaultLevel
 */
export function resolveLevel(name: string): LogLevel {
	const loggers = _runtimeConfig.loggers;

	// 1. Exact match
	if (loggers[name] !== undefined) return loggers[name] as LogLevel;

	// 2. Walk up hierarchy
	const parts = name.split('.');
	while (parts.length > 1) {
		parts.pop();
		const parent = parts.join('.');
		if (loggers[parent] !== undefined) return loggers[parent] as LogLevel;
	}

	// 3. Root level
	if (loggers[''] !== undefined) return loggers[''] as LogLevel;

	// 4. Default
	return _runtimeConfig.defaultLevel;
}

/**
 * Check whether a log event at the given level + source should be emitted.
 */
export function shouldLog(source: string, level: LogLevel): boolean {
	const configuredLevel = resolveLevel(source);
	const configuredOrder = LOG_LEVEL_ORDER[configuredLevel] ?? LOG_LEVEL_ORDER.info;
	const eventOrder = LOG_LEVEL_ORDER[level] ?? LOG_LEVEL_ORDER.info;
	return eventOrder >= configuredOrder;
}

/**
 * Check whether an appender should receive a log event at the given level.
 */
export function shouldAppend(appenderLevel: LogLevel | undefined, eventLevel: LogLevel): boolean {
	const appenderOrder = LOG_LEVEL_ORDER[appenderLevel ?? 'trace'];
	const eventOrder = LOG_LEVEL_ORDER[eventLevel] ?? LOG_LEVEL_ORDER.info;
	return eventOrder >= appenderOrder;
}

/**
 * Get the current runtime config (read-only access for appenders).
 */
export function getRuntimeConfig(): Readonly<LoggerRuntimeConfig> {
	return _runtimeConfig;
}

// ============================================================================
// Initialization
// ============================================================================

/**
 * Load and merge configuration files from all locations.
 *
 * Search order (later wins):
 *   1. Plugin-bundled default: alongside this module
 *   2. User global: ~/.pi/agent/extensions-data/pi-logger/config.json
 *   3. Project-local: <cwd>/.pi/extensions-data/pi-logger/config.json
 *
 * @param cwd - Current working directory (for project-level config)
 */
export function loadConfiguration(cwd: string): void {
	// Determine plugin's own directory (where this module lives)
	const pluginDir = dirname(fileURLToPath(import.meta.url));

	const bundledPath = join(pluginDir, CONFIG_FILE);
	const paths = resolveConfigPaths('pi-logger', { cwd });

	// Load in priority order (later overrides earlier)
	let merged: LoggerRuntimeConfig = deepClone(DEFAULT_CONFIG);

	// 1) Plugin-bundled default
	const bundled = loadConfigFile(bundledPath);
	if (bundled) merged = mergeConfig(merged, bundled);

	// 2) User global (~/.pi/agent/extensions-data/pi-logger/config.json)
	const userCfg = loadConfigFile(paths.userFile);
	if (userCfg) merged = mergeConfig(merged, userCfg);

	// 3) Project-local (extensions-data/pi-logger/config.json)
	const projectCfg = loadConfigFile(paths.projectFile);
	if (projectCfg) merged = mergeConfig(merged, projectCfg);

	// If the config specifies a relative path for file appender, resolve it against cwd
	if (
		merged.appenders.file.path &&
		!merged.appenders.file.path.startsWith('/') &&
		!merged.appenders.file.path.startsWith('~')
	) {
		merged.appenders.file.path = resolve(cwd, merged.appenders.file.path);
	}

	_runtimeConfig = merged;
}

// ============================================================================
// Runtime modifications
// ============================================================================

export function setDefaultLevel(level: LogLevel): void {
	if (LOG_LEVELS.includes(level)) _runtimeConfig.defaultLevel = level;
}

export function setLoggerLevel(name: string, level: LogLevel): void {
	if (!name) {
		setDefaultLevel(level);
		return;
	}
	_runtimeConfig.loggers[name] = level;
}

export function unsetLoggerLevel(name: string): void {
	delete _runtimeConfig.loggers[name];
}

export function getLoggerLevel(name: string): LogLevel {
	return resolveLevel(name);
}

export function setOutputMode(mode: 'file' | 'console' | 'both'): void {
	_runtimeConfig.appenders.file.enabled = mode === 'file' || mode === 'both';
	_runtimeConfig.appenders.console.enabled = mode === 'console' || mode === 'both';
}

export function getEffectiveConfig(): LoggerRuntimeConfig {
	return deepClone(_runtimeConfig);
}

export function reloadConfiguration(cwd: string): void {
	loadConfiguration(cwd);
}

export function getLogDir(): string {
	return _runtimeConfig.appenders.file.path;
}
