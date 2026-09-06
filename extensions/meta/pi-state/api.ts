/**
 * @zenone/pi-state — 分层持久化状态底座（纯库 API）
 *
 * 提供多层级状态读写、通用底座函数（路径解析 / 原子 IO / deepMerge）、
 * 以及带缓存的 StateStore（增量 upsert + 会话生命周期）。
 *
 * 层级优先级（高→低，每层 deepMerge）：
 *   1. session 级（可选）：~/.pi/agent/extensions-data/<plugin>/<sessionId>.json
 *   2. 项目级           ：<cwd>/.pi/extensions-data/<plugin>/config.json
 *   3. 用户级           ：~/.pi/agent/extensions-data/<plugin>/config.json
 *   4. defaults         ：插件内嵌
 *
 * 与 pi-config 的分工：本模块是通用底座（配置是"无生命周期、整体覆盖"的状态特例），
 * pi-config 依赖本模块实现"配置语义"（validate / ConfigStore / /config 命令）。
 * 本模块不依赖 pi 扩展 API，可在任何 Node 环境下使用。
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createLogger } from '@zenone/pi-logger';
import type {
	CleanupExpiredOptions,
	CleanupExpiredResult,
	DeepPartial,
	StatePaths,
	StateScope,
	StateStore,
	StateStoreOptions,
} from './types.js';

const log = createLogger('pi-state');

// ============================================================================
// Helpers
// ============================================================================

function isPlainObject(v: unknown): v is Record<string, unknown> {
	if (v === null || v === undefined) return false;
	const proto = Object.getPrototypeOf(v);
	return proto === Object.prototype || proto === null;
}

// ============================================================================
// 1. Path resolution
// ============================================================================

/**
 * Resolve state file paths for a plugin (user + project layers).
 *
 * All paths are deterministic based on plugin name + homedir + cwd.
 * No import.meta.url used → safe across /reload.
 */
export function resolvePaths(
	pluginName: string,
	opts?: { cwd?: string; homeDir?: string; fileName?: string },
): StatePaths {
	const home = opts?.homeDir ?? homedir();
	const cwd = opts?.cwd ?? process.cwd();
	const fileName = opts?.fileName ?? 'config.json';

	const userDir = join(home, '.pi', 'agent', 'extensions-data', pluginName);
	const userFile = join(userDir, fileName);
	const projectDir = join(cwd, '.pi', 'extensions-data', pluginName);
	const projectFile = join(projectDir, fileName);

	return { userDir, userFile, projectDir, projectFile };
}

// ============================================================================
// 2. deepMerge
// ============================================================================

/**
 * Deep-merge two plain objects.
 *
 * Rules:
 *   - `undefined` values in override → skip (keep base)
 *   - Both values are plain objects → recurse
 *   - Otherwise (array, primitive, null, class instance) → override wins
 *   - Returns a new object, never mutates inputs
 *
 * Arrays are REPLACED, not concat.
 */
export function deepMerge<T>(base: T, override: DeepPartial<T>): T {
	const result = { ...base } as Record<string, unknown>;

	for (const key of Object.keys(override)) {
		const val = (override as Record<string, unknown>)[key];
		if (val === undefined) continue;

		const baseVal = (base as Record<string, unknown>)[key];
		if (isPlainObject(baseVal) && isPlainObject(val)) {
			result[key] = deepMerge(baseVal, val);
		} else {
			result[key] = val;
		}
	}

	return result as T;
}

// ============================================================================
// 3. File I/O
// ============================================================================

/**
 * Safely read and parse a JSON file.
 *
 * Returns null if the file doesn't exist (ENOENT), isn't valid JSON,
 * or isn't a plain object. Logs a warning on parse failure (non-ENOENT).
 */
export function readJsonFile(path: string): Record<string, unknown> | null {
	try {
		if (!existsSync(path)) return null;
		const raw = readFileSync(path, 'utf-8');
		const parsed = JSON.parse(raw);
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
			log.warn('file is not a plain object, skipping: %s', path);
			return null;
		}
		return parsed as Record<string, unknown>;
	} catch (err: unknown) {
		const nodeErr = err as NodeJS.ErrnoException;
		if (nodeErr.code === 'ENOENT') return null;
		log.warn('failed to parse file: %s — %s', path, (err as Error).message ?? String(err));
		return null;
	}
}

/**
 * Atomically write a JSON object to a file.
 *
 * Atomicity: write to `<path>.<pid>.tmp` → renameSync.
 * Ensures parent directory exists (mkdirSync recursive).
 * Writes 2-space-indented JSON with trailing newline.
 */
export function writeJsonAtomic(path: string, data: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
	renameSync(tmp, path);
}

// ============================================================================
// 4. Expired session-file cleanup
// ============================================================================

/** 保留的非 session 文件名（配置/状态文件，不参与过期清理） */
const RESERVED_FILES = new Set(['config.json', 'state.json']);

/**
 * 清理 <pluginName> 目录下过期的 session 文件（<sessionId>.json）。
 *
 * 会话文件按 mtime 保留 maxAgeDays 天（默认 30，不传即用默认值）。
 * 不触碰 config.json / state.json 以及 opts.reservedFiles 列出的文件
 * （配置/状态文件由插件自己管理）。
 *
 * 调用时机建议放在 session_start（而非 session_shutdown）：
 * /reload 会先触发 session_shutdown，若在那里删除会误删当前会话文件，
 * 违背「会话级状态 /reload 后仍生效」的语义。
 */
export function cleanupExpiredSessions(
	pluginName: string,
	opts?: CleanupExpiredOptions,
): CleanupExpiredResult {
	const maxAgeDays = opts?.maxAgeDays ?? 30;
	const home = opts?.homeDir ?? homedir();
	const userDir = join(home, '.pi', 'agent', 'extensions-data', pluginName);

	let scanned = 0;
	let removed = 0;

	if (!existsSync(userDir)) return { scanned, removed };

	const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

	const reserved = new Set(RESERVED_FILES);
	for (const f of opts?.reservedFiles ?? []) reserved.add(f);

	let entries: string[];
	try {
		entries = readdirSync(userDir);
	} catch {
		return { scanned, removed };
	}

	for (const name of entries) {
		if (!name.endsWith('.json')) continue;
		if (reserved.has(name)) continue;
		const file = join(userDir, name);
		scanned++;
		try {
			if (statSync(file).mtimeMs < cutoffMs) {
				rmSync(file, { force: true });
				removed++;
			}
		} catch {
			// 单个文件 stat/删除失败不中断整体清理
		}
	}

	return { scanned, removed };
}

// ============================================================================
// 5. StateStore (layered + incremental + session lifecycle)
// ============================================================================

const SCOPE_FILE: Record<StateScope, 'userFile' | 'projectFile' | 'sessionFile'> = {
	user: 'userFile',
	project: 'projectFile',
	session: 'sessionFile',
};

/**
 * Create a cached layered state store.
 *
 * Unlike pi-config's ConfigStore (whose save() overwrites a whole layer),
 * `upsert()` merges incrementally into one layer — the semantics required for
 * runtime-accumulated state such as graduated approval rules.
 */
export function createStateStore<T>(options: StateStoreOptions<T>): StateStore<T> {
	const { pluginName, fileName } = options;
	const rawDefaults = (options.defaults ?? {}) as T;
	const cwdOption = options.cwd;
	const homeDirOption = options.homeDir;

	let _sessionId: string | null = null;
	let _cached: T | null = null;

	function resolveAllPaths(): StatePaths {
		const paths = resolvePaths(pluginName, {
			cwd: cwdOption,
			homeDir: homeDirOption,
			fileName,
		});
		if (_sessionId) {
			// 会话层文件 = <userDir>/<sessionId>.json（固定命名，与 pi-config 的
			// sessionScoped 约定一致）。同一插件的多个 store 会共享该文件——
			// 写入必须保留未属字段（upsert/read-modify-write deepMerge），
			// 严禁整体覆盖写（会清掉同插件其他 store 的会话数据）。
			return { ...paths, sessionFile: join(paths.userDir, `${_sessionId}.json`) };
		}
		return paths;
	}

	function loadLayer(file: string | undefined): Record<string, unknown> | null {
		return file ? readJsonFile(file) : null;
	}

	return {
		get(): T {
			if (_cached !== null) return _cached;
			const paths = resolveAllPaths();
			let merged = structuredClone(rawDefaults) as Record<string, unknown>;
			for (const file of [paths.userFile, paths.projectFile, paths.sessionFile]) {
				const layer = loadLayer(file);
				if (layer) merged = deepMerge(merged, layer);
			}
			_cached = merged as T;
			return _cached as T;
		},

		upsert(partial: DeepPartial<T>, scope: StateScope): boolean {
			const paths = resolveAllPaths();
			const file = paths[SCOPE_FILE[scope]];
			if (!file) {
				log.warn('upsert to %s scope requires setSessionId first', scope);
				return false;
			}
			const existing = loadLayer(file) ?? {};
			const merged = deepMerge(existing, partial as Record<string, unknown>);
			writeJsonAtomic(file, merged);
			_cached = null;
			return true;
		},

		setSessionId(sessionId: string | null): void {
			_sessionId = sessionId;
			_cached = null;
		},

		clearSession(): boolean {
			const paths = resolveAllPaths();
			if (!paths.sessionFile) return false;
			try {
				rmSync(paths.sessionFile, { force: true });
				_cached = null;
				return true;
			} catch {
				return false;
			}
		},

		cleanupExpired(maxAgeDays = 30, reservedFiles?: string[]): CleanupExpiredResult {
			// 自动保留本 store 的 fileName，避免清理时误删自己的状态文件；
			// 共享目录的兄弟 store 文件名由调用方经 reservedFiles 传入。
			const reserved = new Set(reservedFiles ?? []);
			reserved.add(fileName ?? 'config.json');
			return cleanupExpiredSessions(pluginName, {
				maxAgeDays,
				homeDir: homeDirOption,
				reservedFiles: [...reserved],
			});
		},

		reload(): T {
			_cached = null;
			return this.get();
		},

		getPaths(): StatePaths {
			return resolveAllPaths();
		},

		getDefaults(): T {
			return structuredClone(rawDefaults) as T;
		},
	};
}

// Re-export types for convenience
export type {
	CleanupExpiredOptions,
	CleanupExpiredResult,
	DeepPartial,
	StatePaths,
	StateScope,
	StateStore,
	StateStoreOptions,
} from './types.js';
