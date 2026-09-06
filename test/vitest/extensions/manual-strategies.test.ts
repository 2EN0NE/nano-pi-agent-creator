/**
 * permission-gate — 手动策略存储 Vitest 测试（ADR-0030）
 *
 * 覆盖：三层持久化、会话级清除、分层读取、跨层迁移、判定辅助。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
	resetManualStrategiesStore,
	setManualStrategiesSessionId,
	clearSessionManualStrategies,
	addManualStrategy,
	getManualStrategies,
	getManualStrategiesByLayer,
	removeManualStrategy,
	removeManualStrategyScoped,
	moveManualStrategy,
	hasManualStrategy,
} from '../../../extensions/security/permission-gate/manual-strategies';

let tmpDir: string;
let tmpHome: string;
let tmpCwd: string;

beforeEach(() => {
	tmpDir = join(tmpdir(), `manual-strategies-test-${randomBytes(4).toString('hex')}`);
	tmpHome = join(tmpDir, 'home');
	tmpCwd = join(tmpDir, 'cwd');
	mkdirSync(tmpHome, { recursive: true });
	mkdirSync(tmpCwd, { recursive: true });
	resetManualStrategiesStore({ homeDir: tmpHome, cwd: tmpCwd });
	setManualStrategiesSessionId('sess-1');
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

describe('手动策略三级持久化', () => {
	it('会话级手动策略 clearSession 后失效', () => {
		setManualStrategiesSessionId('sess-1');
		addManualStrategy('cmd:abc', 'rm -rf dist/', 'session');
		expect(hasManualStrategy('cmd:abc')).toBe(true);

		clearSessionManualStrategies();
		expect(hasManualStrategy('cmd:abc')).toBe(false);
	});

	it('项目级手动策略跨会话保留', () => {
		setManualStrategiesSessionId('sess-1');
		addManualStrategy('cmd:abc', 'rm -rf dist/', 'project');
		clearSessionManualStrategies();
		expect(hasManualStrategy('cmd:abc')).toBe(true);
	});

	it('用户级手动策略跨项目保留', () => {
		addManualStrategy('cmd:abc', 'rm -rf dist/', 'user');
		expect(hasManualStrategy('cmd:abc')).toBe(true);
	});

	it('getManualStrategiesByLayer 分层返回，同名 key 可同时存在于多层', () => {
		addManualStrategy('cmd:abc', 'rm -rf dist/', 'session');
		addManualStrategy('cmd:abc', 'rm -rf dist/', 'project');
		const byLayer = getManualStrategiesByLayer();
		expect(byLayer.session['cmd:abc']).toBeDefined();
		expect(byLayer.project['cmd:abc']).toBeDefined();
		expect(byLayer.session['cmd:abc']).not.toBe(byLayer.project['cmd:abc']);
	});

	it('getManualStrategies 合并读取，高层覆盖低层', () => {
		addManualStrategy('cmd:abc', 'rm -rf dist/', 'user');
		addManualStrategy('cmd:abc', 'rm -rf other/', 'session');
		const merged = getManualStrategies();
		// session 层覆盖 user 层
		expect(merged['cmd:abc'].command).toBe('rm -rf other/');
		expect(merged['cmd:abc'].scope).toBe('session');
	});

	it('moveManualStrategy 迁移：源层删、目标层加', () => {
		addManualStrategy('cmd:abc', 'rm -rf dist/', 'project');
		const moved = moveManualStrategy('cmd:abc', 'project', 'user');
		expect(moved).toBe(true);

		const byLayer = getManualStrategiesByLayer();
		expect(byLayer.project['cmd:abc']).toBeUndefined();
		expect(byLayer.user['cmd:abc']).toBeDefined();
	});

	it('removeManualStrategyScoped 只删目标层，其余层保留', () => {
		addManualStrategy('cmd:abc', 'rm -rf dist/', 'session');
		addManualStrategy('cmd:abc', 'rm -rf dist/', 'project');
		removeManualStrategyScoped('cmd:abc', 'session');

		const byLayer = getManualStrategiesByLayer();
		expect(byLayer.session['cmd:abc']).toBeUndefined();
		expect(byLayer.project['cmd:abc']).toBeDefined();
	});

	it('removeManualStrategy 跨层全删', () => {
		addManualStrategy('cmd:abc', 'rm -rf dist/', 'session');
		addManualStrategy('cmd:abc', 'rm -rf dist/', 'project');
		expect(removeManualStrategy('cmd:abc')).toBe(true);
		expect(hasManualStrategy('cmd:abc')).toBe(false);
	});
});
