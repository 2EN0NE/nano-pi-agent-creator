/**
 * @zenone/pi-state — Vitest tests
 *
 * Covers:
 *   - resolvePaths deterministic paths (user/project, injectable home/cwd)
 *   - readJsonFile / writeJsonAtomic edge cases
 *   - deepMerge semantics
 *   - createStateStore layering (defaults → user → project → session)
 *   - upsert incremental merge (not whole-file overwrite)
 *   - session lifecycle (setSessionId / clearSession)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import {
	resolvePaths,
	readJsonFile,
	writeJsonAtomic,
	deepMerge,
	createStateStore,
	cleanupExpiredSessions,
} from '@zenone/pi-state';

// ============================================================================
// Test utilities
// ============================================================================

interface TestState {
	enabled: boolean;
	retries: number;
	rules: string[];
	meta?: {
		owner: string;
		tags?: string[];
	};
}

const DEFAULTS: TestState = {
	enabled: true,
	retries: 3,
	rules: ['default-rule'],
};

let tmpDir: string;
let tmpHome: string;
let tmpCwd: string;

beforeEach(() => {
	tmpDir = join(tmpdir(), `pi-state-test-${randomBytes(4).toString('hex')}`);
	tmpHome = join(tmpDir, 'home');
	tmpCwd = join(tmpDir, 'cwd');
	mkdirSync(tmpHome, { recursive: true });
	mkdirSync(tmpCwd, { recursive: true });
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

function writeJson(path: string, data: unknown): void {
	writeJsonAtomic(path, data);
}

// ============================================================================
// 1. resolvePaths
// ============================================================================

describe('resolvePaths', () => {
	it('returns deterministic user/project paths', () => {
		const p = resolvePaths('my-plugin', { homeDir: tmpHome, cwd: tmpCwd });
		expect(p.userFile).toBe(
			join(tmpHome, '.pi', 'agent', 'extensions-data', 'my-plugin', 'config.json'),
		);
		expect(p.projectFile).toBe(
			join(tmpCwd, '.pi', 'extensions-data', 'my-plugin', 'config.json'),
		);
		expect(p.sessionFile).toBeUndefined();
	});
});

// ============================================================================
// 2. readJsonFile / writeJsonAtomic
// ============================================================================

describe('readJsonFile', () => {
	it('returns null for missing file', () => {
		expect(readJsonFile(join(tmpDir, 'nope.json'))).toBeNull();
	});

	it('reads a plain object', () => {
		const f = join(tmpDir, 'x.json');
		writeJson(f, { a: 1 });
		expect(readJsonFile(f)).toEqual({ a: 1 });
	});

	it('returns null for invalid JSON', () => {
		const f = join(tmpDir, 'bad.json');
		mkdirSync(join(tmpDir), { recursive: true });
		writeFileSync(f, '{not json', 'utf-8');
		expect(readJsonFile(f)).toBeNull();
	});

	it('returns null for non-object JSON', () => {
		const f = join(tmpDir, 'arr.json');
		writeFileSync(f, '[1,2,3]', 'utf-8');
		expect(readJsonFile(f)).toBeNull();
	});
});

describe('writeJsonAtomic', () => {
	it('creates parent dirs and writes readable JSON', () => {
		const f = join(tmpDir, 'deep', 'nested', 'x.json');
		writeJson(f, { b: 2 });
		expect(existsSync(f)).toBe(true);
		expect(readJsonFile(f)).toEqual({ b: 2 });
	});
});

// ============================================================================
// 3. deepMerge
// ============================================================================

describe('deepMerge', () => {
	it('recursively merges plain objects', () => {
		expect(deepMerge({ a: 1, n: { x: 1, y: 2 } }, { n: { y: 9 } })).toEqual({
			a: 1,
			n: { x: 1, y: 9 },
		});
	});

	it('replaces arrays (does NOT concat)', () => {
		expect(deepMerge({ rules: ['a', 'b'] }, { rules: ['c'] })).toEqual({ rules: ['c'] });
	});

	it('skips undefined values in override', () => {
		expect(deepMerge({ a: 1 }, { a: undefined })).toEqual({ a: 1 });
	});
});

// ============================================================================
// 4. createStateStore layering
// ============================================================================

describe('createStateStore', () => {
	it('get() returns defaults when no files exist', () => {
		const store = createStateStore<TestState>({
			pluginName: 'test-plugin',
			defaults: DEFAULTS,
			cwd: tmpCwd,
			homeDir: tmpHome,
		});
		expect(store.get()).toEqual(DEFAULTS);
	});

	it('merges user → project → session precedence', () => {
		const store = createStateStore<TestState>({
			pluginName: 'test-plugin',
			defaults: DEFAULTS,
			cwd: tmpCwd,
			homeDir: tmpHome,
		});
		const p = store.getPaths();
		// user layer
		writeJson(p.userFile, { retries: 5 });
		// project layer (higher precedence)
		writeJson(p.projectFile, { retries: 7 });
		expect(store.get().retries).toBe(7);
	});

	it('session layer has highest precedence', () => {
		const store = createStateStore<TestState>({
			pluginName: 'test-plugin',
			defaults: DEFAULTS,
			cwd: tmpCwd,
			homeDir: tmpHome,
		});
		store.setSessionId('sess-1');
		const p = store.getPaths();
		writeJson(p.projectFile!, { retries: 7 });
		writeJson(p.sessionFile!, { retries: 99 });
		expect(store.get().retries).toBe(99);
	});

	it('upsert merges incrementally (does not clobber sibling keys)', () => {
		const store = createStateStore<TestState>({
			pluginName: 'test-plugin',
			defaults: DEFAULTS,
			cwd: tmpCwd,
			homeDir: tmpHome,
		});
		const p = store.getPaths();
		writeJson(p.userFile, { retries: 5, rules: ['r1'] });
		store.upsert({ enabled: false }, 'user');
		expect(store.get()).toMatchObject({ enabled: false, retries: 5, rules: ['r1'] });
	});

	it('upsert to session scope requires setSessionId', () => {
		const store = createStateStore<TestState>({
			pluginName: 'test-plugin',
			defaults: DEFAULTS,
			cwd: tmpCwd,
			homeDir: tmpHome,
		});
		expect(store.upsert({ enabled: false }, 'session')).toBe(false);
	});

	it('clearSession removes the session file', () => {
		const store = createStateStore<TestState>({
			pluginName: 'test-plugin',
			defaults: DEFAULTS,
			cwd: tmpCwd,
			homeDir: tmpHome,
		});
		store.setSessionId('sess-2');
		const p = store.getPaths();
		writeJson(p.sessionFile!, { retries: 42 });
		expect(existsSync(p.sessionFile!)).toBe(true);
		expect(store.clearSession()).toBe(true);
		expect(existsSync(p.sessionFile!)).toBe(false);
		expect(store.get().retries).toBe(3); // back to defaults
	});

	it('reload() re-reads from disk', () => {
		const store = createStateStore<TestState>({
			pluginName: 'test-plugin',
			defaults: DEFAULTS,
			cwd: tmpCwd,
			homeDir: tmpHome,
		});
		const p = store.getPaths();
		expect(store.get().retries).toBe(3);
		writeJson(p.userFile, { retries: 11 });
		expect(store.reload().retries).toBe(11);
	});
});

// ============================================================================
// 5. cleanupExpiredSessions（会话级文件过期清理）
// ============================================================================

describe('cleanupExpiredSessions', () => {
	it('删除超期 session 文件，保留未超期', () => {
		const home = tmpHome;
		const dir = join(home, '.pi', 'agent', 'extensions-data', 'cleanup-plugin');
		mkdirSync(dir, { recursive: true });
		const oldFile = join(dir, 'old-session.json');
		const newFile = join(dir, 'new-session.json');
		writeJson(oldFile, { retries: 1 });
		writeJson(newFile, { retries: 2 });
		// oldFile mtime 拨回 40 天前，newFile 保持当前
		const oldTime = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
		utimesSync(oldFile, oldTime, oldTime);

		const result = cleanupExpiredSessions('cleanup-plugin', { maxAgeDays: 30, homeDir: home });

		expect(result.removed).toBe(1);
		expect(existsSync(oldFile)).toBe(false);
		expect(existsSync(newFile)).toBe(true);
	});

	it('排除 config.json / state.json（不参与扫描）', () => {
		const home = tmpHome;
		const dir = join(home, '.pi', 'agent', 'extensions-data', 'cleanup-plugin2');
		mkdirSync(dir, { recursive: true });
		const configFile = join(dir, 'config.json');
		const stateFile = join(dir, 'state.json');
		writeJson(configFile, { retries: 1 });
		writeJson(stateFile, { retries: 2 });
		const oldTime = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
		utimesSync(configFile, oldTime, oldTime);
		utimesSync(stateFile, oldTime, oldTime);

		const result = cleanupExpiredSessions('cleanup-plugin2', { maxAgeDays: 30, homeDir: home });

		expect(result.scanned).toBe(0);
		expect(result.removed).toBe(0);
		expect(existsSync(configFile)).toBe(true);
		expect(existsSync(stateFile)).toBe(true);
	});

	it('StateStore.cleanupExpired 便捷方法删除当前插件超期文件', () => {
		const store = createStateStore<TestState>({
			pluginName: 'cleanup-plugin3',
			defaults: DEFAULTS,
			cwd: tmpCwd,
			homeDir: tmpHome,
		});
		store.setSessionId('sess-old');
		const p = store.getPaths();
		writeJson(p.sessionFile!, { retries: 5 });
		const oldTime = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
		utimesSync(p.sessionFile!, oldTime, oldTime);

		const result = store.cleanupExpired(30);

		expect(result.removed).toBe(1);
		expect(existsSync(p.sessionFile!)).toBe(false);
	});

	it('默认保留 30 天（不传 maxAgeDays）', () => {
		const home = tmpHome;
		const dir = join(home, '.pi', 'agent', 'extensions-data', 'cleanup-plugin4');
		mkdirSync(dir, { recursive: true });
		const oldFile = join(dir, 'old.json');
		writeJson(oldFile, { retries: 1 });
		const oldTime = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
		utimesSync(oldFile, oldTime, oldTime);

		const result = cleanupExpiredSessions('cleanup-plugin4', { homeDir: home });

		expect(result.removed).toBe(1);
	});

	it('目录不存在时返回零计数', () => {
		const result = cleanupExpiredSessions('nonexistent-plugin', { homeDir: tmpHome });
		expect(result.scanned).toBe(0);
		expect(result.removed).toBe(0);
	});

	it('reservedFiles 额外保留固定状态文件（如 manual-strategies.json）', () => {
		const home = tmpHome;
		const dir = join(home, '.pi', 'agent', 'extensions-data', 'cleanup-plugin5');
		mkdirSync(dir, { recursive: true });
		const manualFile = join(dir, 'manual-strategies.json');
		const oldSession = join(dir, 'old-session.json');
		writeJson(manualFile, { strategies: { 'cmd:x': {} } });
		writeJson(oldSession, { retries: 1 });
		const oldTime = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
		utimesSync(manualFile, oldTime, oldTime);
		utimesSync(oldSession, oldTime, oldTime);

		const result = cleanupExpiredSessions('cleanup-plugin5', {
			maxAgeDays: 30,
			homeDir: home,
			reservedFiles: ['manual-strategies.json'],
		});

		// 仅删超期 session 文件，manual-strategies.json 被 reservedFiles 保留
		expect(result.removed).toBe(1);
		expect(existsSync(oldSession)).toBe(false);
		expect(existsSync(manualFile)).toBe(true);
	});

	it('StateStore.cleanupExpired 自动保留自己的 fileName（非默认 config.json）', () => {
		const store = createStateStore<TestState>({
			pluginName: 'cleanup-plugin6',
			defaults: DEFAULTS,
			fileName: 'state.json',
			cwd: tmpCwd,
			homeDir: tmpHome,
		});
		// 写一个超期的本 store 状态文件（user 层 state.json）
		const paths = store.getPaths();
		writeJson(paths.userFile, { retries: 9 });
		const oldTime = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
		utimesSync(paths.userFile, oldTime, oldTime);
		// 再写一个超期的会话文件，应被清理
		store.setSessionId('sess-6');
		const sessionFile = store.getPaths().sessionFile!;
		writeJson(sessionFile, { retries: 1 });
		utimesSync(sessionFile, oldTime, oldTime);

		const result = store.cleanupExpired(30);

		// 会话文件被删，state.json（fileName）被自动保留
		expect(result.removed).toBe(1);
		expect(existsSync(sessionFile)).toBe(false);
		expect(existsSync(paths.userFile)).toBe(true);
	});
});
