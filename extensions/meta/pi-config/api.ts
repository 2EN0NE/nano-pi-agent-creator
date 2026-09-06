/**
 * @zenone/pi-config — 统一配置模块（纯库 API）
 *
 * 提供多层级配置加载、带缓存 ConfigStore，以及 /config 命令。
 *
 * 底座函数（路径解析 / deepMerge / 原子 IO）已下沉到 @zenone/pi-state，
 * 本模块依赖 pi-state 并从其 re-export（向后兼容，消费方零感知）。
 *
 * 层级优先级（高→低，每层 deepMerge）：
 *   1. session 级（可选）：~/.pi/agent/extensions-data/<plugin>/<sessionId>.json
 *   2. 项目级           ：<cwd>/.pi/extensions-data/<plugin>/config.json
 *   3. 用户级           ：~/.pi/agent/extensions-data/<plugin>/config.json
 *   4. defaults         ：插件内嵌
 *
 * 本模块不依赖 pi 扩展 API，可在任何 Node 环境下使用。
 */

import { join } from 'node:path';
import { createLogger } from '@zenone/pi-logger';
import { deepMerge, readJsonFile, resolvePaths, writeJsonAtomic } from '@zenone/pi-state';
import type {
	ConfigPaths,
	ConfigScope,
	ConfigSource,
	ConfigStore,
	ConfigStoreOptions,
	LayeredLoadResult,
} from './types.js';

const log = createLogger('pi-config');

// Re-export base functions (backward compatibility — 底座已下沉到 pi-state)
export { deepMerge, readJsonFile, writeJsonAtomic };

/**
 * Resolve all config file paths for a plugin (delegates to pi-state).
 */
export function resolveConfigPaths(
	pluginName: string,
	opts?: { cwd?: string; homeDir?: string },
): ConfigPaths {
	return resolvePaths(pluginName, opts) as ConfigPaths;
}

// ============================================================================
// 4. One-shot layered load (no caching)
// ============================================================================

/**
 * Load config from all layers and merge them.
 * Does NOT cache — on every call, reads from disk.
 *
 * Layer order (high→low for precedence, low→high for merge order):
 *   1. defaults (base)
 *   2. user level
 *   3. project level
 *   4. session level (if sessionId provided)
 */
export function loadLayeredConfig<T>(
	options: ConfigStoreOptions<T> & { sessionId?: string },
): LayeredLoadResult<T> {
	const {
		pluginName,
		defaults: rawDefaults,
		cwd,
		homeDir,
		sessionScoped = false,
		merge = deepMerge as (base: T, override: Partial<T>) => T,
		validate,
		sessionId,
	} = options;

	const paths = resolveConfigPaths(pluginName, { cwd, homeDir });
	const layers: LayeredLoadResult<T>['layers'] = [];

	let merged: T = structuredClone(rawDefaults) as T;
	let activeSource: ConfigSource = 'default';

	// User level
	const userRaw = readJsonFile(paths.userFile);
	const userCfg = validate
		? userRaw
			? validate(userRaw)
			: null
		: (userRaw as Partial<T> | null);
	layers.push({ scope: 'user', path: paths.userFile, present: userCfg !== null });
	if (userCfg !== null) {
		merged = merge(structuredClone(merged) as T, userCfg);
		activeSource = 'user';
	}

	// Project level
	const projectRaw = readJsonFile(paths.projectFile);
	const projectCfg = projectRaw
		? validate
			? validate(projectRaw)
			: (projectRaw as Partial<T> | null)
		: null;
	layers.push({ scope: 'project', path: paths.projectFile, present: projectCfg !== null });
	if (projectCfg !== null) {
		merged = merge(structuredClone(merged) as T, projectCfg);
		activeSource = 'project';
	}

	// Session level
	if (sessionScoped && sessionId) {
		const sessionFile = join(paths.userDir, `${sessionId}.json`);
		const sessionRaw = readJsonFile(sessionFile);
		const sessionCfg = sessionRaw
			? validate
				? validate(sessionRaw)
				: (sessionRaw as Partial<T> | null)
			: null;
		layers.push({ scope: 'session', path: sessionFile, present: sessionCfg !== null });
		if (sessionCfg !== null) {
			merged = merge(structuredClone(merged) as T, sessionCfg);
			activeSource = 'session';
		}
	}

	return { config: merged, activeSource, layers };
}

// ============================================================================
// 5. ConfigStore (with caching)
// ============================================================================

/**
 * Create a ConfigStore with in-memory caching.
 *
 * Usage:
 *   const store = createConfigStore({ pluginName: 'my-ext', defaults: { ... } });
 *   const cfg = store.get();       // cached → fast
 *   store.reload();                // force re-read from disk
 *   store.save(newCfg, 'project'); // write to project scope
 *   store.setSessionId(sid);       // enable session overlay
 */
export function createConfigStore<T>(options: ConfigStoreOptions<T>): ConfigStore<T> {
	const {
		pluginName,
		defaults: rawDefaults,
		cwd: cwdOption,
		homeDir: homeDirOption,
		sessionScoped = false,
		merge = deepMerge as (base: T, override: Partial<T>) => T,
		validate,
	} = options;

	let _sessionId: string | null = null;
	let _cachedConfig: T | null = null;
	let _activeSource: ConfigSource = 'default';

	// ── Internal helpers ──────────────────────────────────

	function loadLayer(filePath: string): Partial<T> | null {
		const raw = readJsonFile(filePath);
		if (raw === null) return null;
		return validate ? validate(raw) : (raw as Partial<T>);
	}

	function loadFromDisk(): T {
		const paths = resolveConfigPaths(pluginName, {
			cwd: cwdOption,
			homeDir: homeDirOption,
		});

		let merged: T = structuredClone(rawDefaults) as T;
		let source: ConfigSource = 'default';

		// User
		const userCfg = loadLayer(paths.userFile);
		if (userCfg !== null) {
			merged = merge(structuredClone(merged) as T, userCfg);
			source = 'user';
		}

		// Project
		const projectCfg = loadLayer(paths.projectFile);
		if (projectCfg !== null) {
			merged = merge(structuredClone(merged) as T, projectCfg);
			source = 'project';
		}

		// Session (optional, highest priority)
		if (sessionScoped && _sessionId) {
			const sessionFile = join(paths.userDir, `${_sessionId}.json`);
			const sessionCfg = loadLayer(sessionFile);
			if (sessionCfg !== null) {
				merged = merge(structuredClone(merged) as T, sessionCfg);
				source = 'session';
			}
		}

		_activeSource = source;
		_cachedConfig = merged;
		return merged;
	}

	// ── Public API ────────────────────────────────────────

	return {
		get(): T {
			if (_cachedConfig) return _cachedConfig;
			return loadFromDisk();
		},

		reload(): T {
			_cachedConfig = null;
			return loadFromDisk();
		},

		save(config: T, scope: ConfigScope): boolean {
			const paths = resolveConfigPaths(pluginName, {
				cwd: cwdOption,
				homeDir: homeDirOption,
			});

			let targetPath: string;
			if (scope === 'session') {
				if (!_sessionId) {
					log.warn('cannot save to session scope: no session ID set');
					return false;
				}
				targetPath = join(paths.userDir, `${_sessionId}.json`);
			} else if (scope === 'project') {
				targetPath = paths.projectFile;
			} else {
				targetPath = paths.userFile;
			}

			try {
				writeJsonAtomic(targetPath, config);
				_cachedConfig = config;
				return true;
			} catch (err) {
				log.error('failed to save config to %s: %s', targetPath, String(err));
				return false;
			}
		},

		setSessionId(sessionId: string | null): void {
			_sessionId = sessionId;
			// Force re-merge on next get()
			_cachedConfig = null;
		},

		getActiveSource(): ConfigSource {
			this.get(); // ensures loaded
			return _activeSource;
		},

		getPaths(): ConfigPaths {
			const paths = resolveConfigPaths(pluginName, {
				cwd: cwdOption,
				homeDir: homeDirOption,
			});
			if (sessionScoped && _sessionId) {
				return {
					...paths,
					sessionFile: join(paths.userDir, `${_sessionId}.json`),
				};
			}
			return paths;
		},

		getDefaults(): T {
			return structuredClone(rawDefaults) as T;
		},
	};
}

// Re-export types for convenience
export type {
	ConfigPaths,
	ConfigScope,
	ConfigSource,
	ConfigStore,
	ConfigStoreOptions,
	LayeredLoadResult,
} from './types.js';
