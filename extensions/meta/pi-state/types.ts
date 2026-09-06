/**
 * @zenone/pi-state — Public types
 *
 * 分层持久化状态底座的类型定义。状态与配置的区别：
 *   - 配置：用户显式设定、整体覆盖写入、无生命周期（pi-config）
 *   - 状态：运行时增量累积（upsert）、可能带会话级生命周期（pi-state）
 */

// ============================================================================
// State scope
// ============================================================================

/** Which state layer to read/merge/write */
export type StateScope = 'user' | 'project' | 'session';

// ============================================================================
// Paths
// ============================================================================

export interface StatePaths {
	/** User-level directory: ~/.pi/agent/extensions-data/<plugin>/ */
	userDir: string;
	/** User-level file: <userDir>/<fileName> (default config.json) */
	userFile: string;
	/** Project-level directory: <cwd>/.pi/extensions-data/<plugin>/ */
	projectDir: string;
	/** Project-level file: <projectDir>/<fileName> (default config.json) */
	projectFile: string;
	/** Session-level file: <userDir>/<sessionId>.json (only populated when a session id is set) */
	sessionFile?: string;
}

// ============================================================================
// Expired cleanup
// ============================================================================

export interface CleanupExpiredOptions {
	/** 保留天数：mtime 超过该天数的 session 文件被删除（默认 30） */
	maxAgeDays?: number;
	/** 用户目录（默认 os.homedir()）。测试可注入。 */
	homeDir?: string;
	/**
	 * 额外保留的非会话文件名（如 manual-strategies.json），与内置的
	 * config.json / state.json 合并。插件目录下存在多个固定状态文件时，
	 * 调用方必须把「不属于会话」的文件名全部列出，避免被当作过期会话文件误删。
	 */
	reservedFiles?: string[];
}

export interface CleanupExpiredResult {
	/** 扫描到的候选 session 文件数（不含 config.json / state.json） */
	scanned: number;
	/** 实际删除的过期文件数 */
	removed: number;
}

// ============================================================================
// Store options
// ============================================================================

export type DeepPartial<T> = {
	[K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export interface StateStoreOptions<T> {
	/** Plugin directory name under extensions-data/ (e.g. "permission-gate") */
	pluginName: string;
	/** Embedded defaults (base layer) */
	defaults?: T;
	/** Working directory (default: process.cwd()) */
	cwd?: string;
	/** Home directory (default: os.homedir()). Injectable for testing. */
	homeDir?: string;
	/**
	 * File name for the user/project layers (default: "config.json").
	 * State stores that must not collide with the plugin's config file
	 * (e.g. runtime-accumulated approval rules vs. user-editable config)
	 * pass a distinct name such as "state.json".
	 */
	fileName?: string;
}

// ============================================================================
// State store
// ============================================================================

export interface StateStore<T> {
	/** Read merged state (defaults → user → project → session), cached. */
	get(): T;

	/** Incrementally merge `partial` into the layer at `scope` (does NOT clobber sibling keys). */
	upsert(partial: DeepPartial<T>, scope: StateScope): boolean;

	/** Set the session id (enables the session layer). Triggers cache invalidation. */
	setSessionId(sessionId: string | null): void;

	/** Remove the session file. Returns false if no session id is set. */
	clearSession(): boolean;

	/**
	 * Delete expired session files under this plugin's directory (older than
	 * maxAgeDays by mtime, default 30). Returns scan/removal counts.
	 * Call from session_start (not session_shutdown) to preserve /reload state.
	 *
	 * `reservedFiles` adds extra non-session filenames to the keep list; the
	 * store's own `fileName` is always kept automatically. Plugins that share
	 * one directory across multiple stores must pass each sibling store's
	 * `fileName` here so cleanup never deletes a sibling's persistent state.
	 */
	cleanupExpired(maxAgeDays?: number, reservedFiles?: string[]): CleanupExpiredResult;

	/** Discard cache and re-read from disk. */
	reload(): T;

	/** Paths for all layers. */
	getPaths(): StatePaths;

	/** A fresh copy of the embedded defaults. */
	getDefaults(): T;
}
