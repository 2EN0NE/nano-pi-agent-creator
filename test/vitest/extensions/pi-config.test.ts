/**
 * @zenone/pi-config — Vitest tests
 *
 * Covers:
 *   - deepMerge semantics
 *   - resolveConfigPaths deterministic paths
 *   - readJsonFile / writeJsonAtomic edge cases
 *   - createConfigStore layering (default → user → project → session)
 *   - ConfigStore caching / reload
 *   - sessionScoped feature
 *   - validate option
 *   - Edge cases (empty files, invalid JSON, non-object JSON)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

// Using the module via node_modules symlink (like real extensions do)
import {
	deepMerge,
	resolveConfigPaths,
	readJsonFile,
	writeJsonAtomic,
	createConfigStore,
	loadLayeredConfig,
} from '@zenone/pi-config';
import type { ConfigStoreOptions } from '@zenone/pi-config/types';

// ============================================================================
// Test utilities
// ============================================================================

interface TestConfig {
	enabled: boolean;
	retries: number;
	patterns: string[];
	thresholds?: {
		maxItems: number;
		timeout: number;
	};
	tags?: string;
}

const DEFAULTS: TestConfig = {
	enabled: true,
	retries: 3,
	patterns: ['default-pattern'],
	thresholds: { maxItems: 10, timeout: 5000 },
};

// Temporary directory for each test
let tmpDir: string;

beforeEach(() => {
	tmpDir = join(tmpdir(), `pi-config-test-${randomBytes(4).toString('hex')}`);
	mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

/** Create a config file at the given path */
function writeConfig(path: string, data: unknown): void {
	mkdirSync(require('node:path').dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

// ============================================================================
// 1. deepMerge
// ============================================================================

describe('deepMerge', () => {
	it('merges primitive fields with override winning', () => {
		const result = deepMerge<TestConfig>(DEFAULTS, { enabled: false });
		expect(result.enabled).toBe(false);
		expect(result.retries).toBe(3); // kept from base
	});

	it('recursively merges nested plain objects', () => {
		const result = deepMerge(DEFAULTS, { thresholds: { timeout: 9999 } as any });
		expect(result.thresholds?.timeout).toBe(9999);
		expect(result.thresholds?.maxItems).toBe(10); // kept from base
	});

	it('replaces arrays (does NOT concat)', () => {
		const result = deepMerge(DEFAULTS, { patterns: ['override'] });
		expect(result.patterns).toEqual(['override']);
		expect(result.patterns).not.toContain('default-pattern');
	});

	it('skips undefined values in override', () => {
		const result = deepMerge(DEFAULTS, { enabled: undefined as any });
		expect(result.enabled).toBe(true); // kept from base
	});

	it('replaces null values', () => {
		const result = deepMerge(DEFAULTS, { tags: null as any });
		expect(result.tags).toBeNull();
	});

	it('does not mutate input objects', () => {
		const base = { ...DEFAULTS };
		const override = { enabled: false };
		deepMerge(base, override);
		expect(base.enabled).toBe(true); // unchanged
	});

	it('handles empty override', () => {
		const result = deepMerge(DEFAULTS, {});
		expect(result).toEqual(DEFAULTS);
	});

	it('overrides a nested field with a non-object (depth break)', () => {
		const base = { thresholds: { maxItems: 10, timeout: 5000 } };
		const result = deepMerge(base as TestConfig, { thresholds: 'replaced' as any });
		expect(result.thresholds).toBe('replaced');
	});
});

// ============================================================================
// 2. resolveConfigPaths
// ============================================================================

const PLUGIN = 'my-plugin';

describe('resolveConfigPaths', () => {
	it('resolves paths with given homeDir and cwd', () => {
		const paths = resolveConfigPaths(PLUGIN, { homeDir: '/fake-home', cwd: '/fake-project' });

		expect(paths.userDir).toBe('/fake-home/.pi/agent/extensions-data/my-plugin');
		expect(paths.userFile).toBe('/fake-home/.pi/agent/extensions-data/my-plugin/config.json');
		expect(paths.projectDir).toBe('/fake-project/.pi/extensions-data/my-plugin');
		expect(paths.projectFile).toBe('/fake-project/.pi/extensions-data/my-plugin/config.json');
	});

	it('uses defaults for optional params', () => {
		// Just verify it doesn't throw and returns expected shape
		const paths = resolveConfigPaths(PLUGIN);
		expect(paths.userFile).toMatch(/extensions-data\/my-plugin\/config\.json$/);
		expect(paths.projectDir).toMatch(/\.pi\/extensions-data\/my-plugin$/);
	});
});

// ============================================================================
// 3. File I/O
// ============================================================================

describe('readJsonFile', () => {
	it('returns null for non-existent file', () => {
		expect(readJsonFile(join(tmpDir, 'nonexistent.json'))).toBeNull();
	});

	it('reads and parses valid JSON', () => {
		const path = join(tmpDir, 'config.json');
		writeConfig(path, { foo: 'bar' });
		expect(readJsonFile(path)).toEqual({ foo: 'bar' });
	});

	it('returns null for empty file', () => {
		const path = join(tmpDir, 'empty.json');
		writeFileSync(path, '', 'utf-8');
		expect(readJsonFile(path)).toBeNull();
	});

	it('returns null for invalid JSON', () => {
		const path = join(tmpDir, 'invalid.json');
		writeFileSync(path, '{ broken', 'utf-8');
		expect(readJsonFile(path)).toBeNull();
	});

	it('returns null for array JSON (not a plain object)', () => {
		const path = join(tmpDir, 'array.json');
		writeConfig(path, [1, 2, 3]);
		expect(readJsonFile(path)).toBeNull();
	});
});

describe('writeJsonAtomic', () => {
	it('writes pretty-printed JSON with trailing newline', () => {
		const path = join(tmpDir, 'out.json');
		writeJsonAtomic(path, { a: 1, b: 2 });

		const content = readFileSync(path, 'utf-8');
		expect(content).toBe('{\n  "a": 1,\n  "b": 2\n}\n');
	});

	it('creates parent directory automatically', () => {
		const path = join(tmpDir, 'deep', 'nested', 'out.json');
		writeJsonAtomic(path, { ok: true });
		expect(existsSync(path)).toBe(true);
	});

	it('does not leave tmp files on success', () => {
		const path = join(tmpDir, 'clean.json');
		writeJsonAtomic(path, {});
		const tmpFiles = require('node:fs')
			.readdirSync(tmpDir)
			.filter((f: string) => f.endsWith('.tmp'));
		expect(tmpFiles).toHaveLength(0);
	});
});

// ============================================================================
// 4. ConfigStore Layering
// ============================================================================

function makeStore(opts?: Partial<ConfigStoreOptions<TestConfig>>) {
	return createConfigStore<TestConfig>({
		pluginName: 'test-plugin',
		defaults: { ...DEFAULTS, thresholds: { ...DEFAULTS.thresholds! } },
		homeDir: tmpDir,
		cwd: tmpDir,
		...opts,
	});
}

describe('createConfigStore', () => {
	it('returns defaults when no files exist', () => {
		const store = makeStore();
		const cfg = store.get();
		expect(cfg.enabled).toBe(true);
		expect(cfg.retries).toBe(3);
		expect(store.getActiveSource()).toBe('default');
	});

	it('merges user-level config over defaults', () => {
		const store = makeStore();
		writeConfig(store.getPaths().userFile, { enabled: false, retries: 5 });
		store.reload();

		const cfg = store.get();
		expect(cfg.enabled).toBe(false);
		expect(cfg.retries).toBe(5);
		expect(cfg.patterns).toEqual(['default-pattern']); // from defaults
		expect(store.getActiveSource()).toBe('user');
	});

	it('project-level overrides user-level', () => {
		const store = makeStore();
		writeConfig(store.getPaths().userFile, { enabled: false });
		writeConfig(store.getPaths().projectFile, { enabled: true, retries: 10 });
		store.reload();

		const cfg = store.get();
		expect(cfg.enabled).toBe(true); // project wins
		expect(cfg.retries).toBe(10);
		expect(store.getActiveSource()).toBe('project');
	});

	it('caches results: get() returns same object after first call', () => {
		const store = makeStore();
		const a = store.get();
		const b = store.get();
		expect(a).toBe(b); // same reference (cached)
	});

	it('reload() forces re-read', () => {
		const store = makeStore();
		const before = store.get();
		writeConfig(store.getPaths().userFile, { enabled: false });
		store.reload();
		const after = store.get();
		expect(after.enabled).toBe(false);
		expect(before).not.toBe(after);
	});

	it('save() writes atomic JSON to the correct scope', () => {
		const store = makeStore();
		store.save({ ...DEFAULTS, enabled: false }, 'user');

		expect(existsSync(store.getPaths().userFile)).toBe(true);
		const content = JSON.parse(readFileSync(store.getPaths().userFile, 'utf-8'));
		expect(content.enabled).toBe(false);
	});

	it('getDefaults() returns a fresh copy', () => {
		const store = makeStore();
		const d1 = store.getDefaults();
		const d2 = store.getDefaults();
		expect(d1).toEqual(d2);
		expect(d1).not.toBe(d2);
	});

	it('validate option skips corrupt layers', () => {
		const store = makeStore({
			validate: (raw: unknown): Partial<TestConfig> | null => {
				const r = raw as Partial<TestConfig>;
				if (typeof r.enabled !== 'boolean') return null;
				return r;
			},
		});
		// Write invalid layer
		writeConfig(store.getPaths().userFile, { enabled: 'not-a-boolean' } as any);
		store.reload();

		const cfg = store.get();
		expect(cfg.enabled).toBe(true); // fell through to defaults
		expect(store.getActiveSource()).toBe('default');
	});
});

// ============================================================================
// 5. Session scope
// ============================================================================

describe('sessionScoped', () => {
	it('session config merges over project level', () => {
		const store = makeStore({ sessionScoped: true });
		writeConfig(store.getPaths().userFile, { retries: 1 });
		store.reload();

		// Set session ID and write session file
		store.setSessionId('test-session-123');
		const sessionPath = join(store.getPaths().userDir, 'test-session-123.json');
		writeConfig(sessionPath, { retries: 99 });

		const cfg = store.get();
		expect(cfg.retries).toBe(99);
		expect(store.getActiveSource()).toBe('session');
	});

	it('save to session scope writes <sessionId>.json', () => {
		const store = makeStore({ sessionScoped: true });
		store.setSessionId('sess-1');
		store.save({ ...DEFAULTS, enabled: false }, 'session');

		const sessionPath = join(store.getPaths().userDir, 'sess-1.json');
		expect(existsSync(sessionPath)).toBe(true);

		const content = JSON.parse(readFileSync(sessionPath, 'utf-8'));
		expect(content.enabled).toBe(false);
	});

	it('save to session fails when no sessionId set', () => {
		const store = makeStore({ sessionScoped: true });
		const result = store.save(DEFAULTS, 'session');
		expect(result).toBe(false);
	});

	it('setSessionId(null) disables session overlay', () => {
		const store = makeStore({ sessionScoped: true });
		writeConfig(store.getPaths().userFile, { retries: 5 });
		store.reload();
		store.setSessionId('sid');

		const sessionPath = join(store.getPaths().userDir, 'sid.json');
		writeConfig(sessionPath, { retries: 99 });
		expect(store.get().retries).toBe(99);

		store.setSessionId(null);
		expect(store.get().retries).toBe(5);
	});
});

// ============================================================================
// 6. loadLayeredConfig (one-shot)
// ============================================================================

describe('loadLayeredConfig', () => {
	it('returns defaults + sources info when no files exist', () => {
		const result = loadLayeredConfig<TestConfig>({
			pluginName: 'test-plugin',
			defaults: DEFAULTS,
			homeDir: tmpDir,
			cwd: tmpDir,
		});
		expect(result.config.enabled).toBe(true);
		expect(result.activeSource).toBe('default');
		expect(result.layers).toHaveLength(2); // user + project (session is optional)
	});

	it('detects session layer correctly', () => {
		const result = loadLayeredConfig<TestConfig>({
			pluginName: 'test-plugin',
			defaults: DEFAULTS,
			homeDir: tmpDir,
			cwd: tmpDir,
			sessionScoped: true,
			sessionId: 'my-sid',
		});

		// No files written, all layers "not present"
		const sessionLayer = result.layers.find((l) => l.scope === 'session');
		expect(sessionLayer?.present).toBe(false);
	});
});
