/**
 * cloud-sessions — reconcile 模块测试
 *
 * 覆盖 MtimeResolver 的 5 条决策路径 + tieBreaker 配置。
 * 纯函数测试，不依赖文件系统 / pi API。
 */
import { describe, it, expect } from 'vitest';
import { MtimeResolver } from '../../../extensions/auto/cloud-sessions/src/reconcile.js';

describe('MtimeResolver', () => {
	// ================================================================
	// 基础路径
	// ================================================================

	it('local only → push_local', () => {
		const r = new MtimeResolver();
		const local = { hash: 'a', mtimeMs: 1000 };
		const result = r.resolve(local, null);
		expect(result.action).toBe('push_local');
		expect(result.reason).toBe('local-only');
	});

	it('remote only → pull_remote', () => {
		const r = new MtimeResolver();
		const remote = { hash: 'b', mtimeMs: 1000 };
		const result = r.resolve(null, remote);
		expect(result.action).toBe('pull_remote');
		expect(result.reason).toBe('remote-only');
	});

	it('both null → skip', () => {
		const r = new MtimeResolver();
		const result = r.resolve(null, null);
		expect(result.action).toBe('skip');
	});

	it('identical hash → skip', () => {
		const r = new MtimeResolver();
		const local = { hash: 'x', mtimeMs: 1000 };
		const remote = { hash: 'x', mtimeMs: 2000 };
		const result = r.resolve(local, remote);
		expect(result.action).toBe('skip');
		expect(result.reason).toBe('identical-hash');
	});

	// ================================================================
	// mtime delta > tolerance
	// ================================================================

	it('local significantly newer → push_local', () => {
		const r = new MtimeResolver({ toleranceMs: 1500 });
		const local = { hash: 'a', mtimeMs: 5000 };
		const remote = { hash: 'b', mtimeMs: 1000 };
		// delta = 4000 > 1500
		const result = r.resolve(local, remote);
		expect(result.action).toBe('push_local');
		expect(result.reason).toBe('local-newer');
	});

	it('remote significantly newer → pull_remote', () => {
		const r = new MtimeResolver({ toleranceMs: 1500 });
		const local = { hash: 'a', mtimeMs: 1000 };
		const remote = { hash: 'b', mtimeMs: 5000 };
		// delta = -4000 < -1500
		const result = r.resolve(local, remote);
		expect(result.action).toBe('pull_remote');
		expect(result.reason).toBe('remote-newer');
	});

	// ================================================================
	// 边界: |delta| ≤ tolerance
	// ================================================================

	it('tieBreaker=local: local mtime >= remote → push_local', () => {
		const r = new MtimeResolver({ tieBreaker: 'local' });
		// delta = 0 (within tolerance)
		const result = r.resolve({ hash: 'a', mtimeMs: 2000 }, { hash: 'b', mtimeMs: 2000 });
		expect(result.action).toBe('push_local');
	});

	it('tieBreaker=local: local mtime < remote → pull_remote', () => {
		const r = new MtimeResolver({ tieBreaker: 'local' });
		const result = r.resolve({ hash: 'a', mtimeMs: 2000 }, { hash: 'b', mtimeMs: 2500 });
		expect(result.action).toBe('pull_remote');
	});

	it('tieBreaker=remote: remote mtime >= local → pull_remote', () => {
		const r = new MtimeResolver({ tieBreaker: 'remote' });
		const result = r.resolve({ hash: 'a', mtimeMs: 2000 }, { hash: 'b', mtimeMs: 2000 });
		expect(result.action).toBe('pull_remote');
	});

	it('tieBreaker=remote: remote mtime < local → push_local', () => {
		const r = new MtimeResolver({ tieBreaker: 'remote' });
		const result = r.resolve({ hash: 'a', mtimeMs: 3000 }, { hash: 'b', mtimeMs: 2500 });
		expect(result.action).toBe('push_local');
	});

	// ================================================================
	// custom toleranceMs
	// ================================================================

	it('delta within custom tolerance → uses tieBreaker (not significant)', () => {
		// tolerance = 5000ms, delta = 3000 → within tolerance
		const r = new MtimeResolver({ toleranceMs: 5000 });
		const result = r.resolve({ hash: 'a', mtimeMs: 5000 }, { hash: 'b', mtimeMs: 2000 });
		expect(result.action).toBe('push_local'); // default tieBreaker=local
		expect(result.reason).toBe('tie-break:local');
	});

	it('delta beyond custom tolerance → uses delta', () => {
		// tolerance = 1000ms, delta = 3000 → beyond tolerance
		const r = new MtimeResolver({ toleranceMs: 1000 });
		const result = r.resolve({ hash: 'a', mtimeMs: 5000 }, { hash: 'b', mtimeMs: 2000 });
		expect(result.action).toBe('push_local');
		expect(result.reason).toBe('local-newer');
	});
});
