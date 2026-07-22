/**
 * @zenone/pi-config — Public types
 *
 * Users of the pi-config library import from this module:
 *   import type { ConfigStore, ConfigStoreOptions } from '@zenone/pi-config/types';
 */

// ============================================================================
// Config source / scope
// ============================================================================

/** Which config level is active */
export type ConfigSource = 'default' | 'user' | 'project' | 'session';

/** Which scope to save to */
export type ConfigScope = 'user' | 'project' | 'session';

// ============================================================================
// Paths
// ============================================================================

export interface ConfigPaths {
	/** User-level directory: ~/.pi/agent/extensions-data/<plugin>/ */
	userDir: string;
	/** User-level config file: <userDir>/config.json */
	userFile: string;
	/** Project-level directory: <cwd>/.pi/extensions-data/<plugin>/ */
	projectDir: string;
	/** Project-level config file: <projectDir>/config.json */
	projectFile: string;
	/** Session-level config file: <userDir>/<sessionId>.json (only populated when sessionScoped=true) */
	sessionFile?: string;
}

// ============================================================================
// Store options
// ============================================================================

export interface ConfigStoreOptions<T> {
	/** Plugin directory name under extensions-data/ (e.g. "permission-gate") */
	pluginName: string;

	/** Embedded default config values */
	defaults: T;

	/** Current working directory for project-level config (default: process.cwd()) */
	cwd?: string;

	/** Home directory for user-level config (default: os.homedir()). Test injection. */
	homeDir?: string;

	/** Enable session-level overlay (~/.pi/agent/extensions-data/<plugin>/<sessionId>.json) */
	sessionScoped?: boolean;

	/**
	 * Custom merge function.
	 * Default: deepMerge (plain-object recursive, array/primitive replace, undefined skip).
	 */
	merge?: (base: T, override: Partial<T>) => T;

	/**
	 * Optional validation/sanitization function.
	 * Called after loading raw JSON from each layer. Return null to skip this layer.
	 */
	validate?: (raw: unknown) => Partial<T> | null;
}

// ============================================================================
// Store interface
// ============================================================================

export interface ConfigStore<T> {
	/**
	 * Get the effective (merged) config.
	 * Result is cached; call reload() to force re-read from disk.
	 */
	get(): T;

	/** Discard in-memory cache and re-read from disk on next get(). */
	reload(): T;

	/**
	 * Save config to disk at the specified scope.
	 * Returns true on success, false on error (e.g. missing sessionId for session scope).
	 */
	save(config: T, scope: ConfigScope): boolean;

	/**
	 * Set session ID (required for session scope).
	 * Only meaningful when sessionScoped was enabled.
	 * Calling this triggers a reload.
	 */
	setSessionId(sessionId: string | null): void;

	/** Which config source was the highest-priority layer with an existing file. */
	getActiveSource(): ConfigSource;

	/** Paths for all config layers. */
	getPaths(): ConfigPaths;

	/** A fresh copy of the embedded defaults. */
	getDefaults(): T;
}

// ============================================================================
// Layered load result (for one-shot usage without caching)
// ============================================================================

export interface LayeredLoadResult<T> {
	config: T;
	/** Which source was active */
	activeSource: ConfigSource;
	/** Details per layer: path and whether it loaded */
	layers: Array<{ scope: ConfigScope; path: string; present: boolean }>;
}
