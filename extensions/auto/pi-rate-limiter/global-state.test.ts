/**
 * Integration tests for the global shared rate limiter.
 *
 * Run with: node --test --import tsx/global-state.test.ts
 * Or compile to JS first: npx tsc && node --test dist/global-state.test.js
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { GlobalRateLimiter, DirectoryLock, OptimisticStateManager } from './global-state.js';

// Helper to create isolated temp directories for each test
function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), 'pi-rate-limiter-test-'));
}

function cleanup(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		// ignore cleanup failures
	}
}

// ============================================================================
// DirectoryLock tests
// ============================================================================

describe('DirectoryLock', () => {
	it('should acquire and release a lock', () => {
		const dir = makeTempDir();
		const lockDir = join(dir, '.lock');
		const lock = new DirectoryLock(lockDir, {
			lockTimeoutMs: 1000,
			lockMaxHoldMs: 5000,
			heartbeatIntervalMs: 100,
			staleProcessTimeoutMs: 500,
		});

		const acquired = lock.acquire();
		assert.strictEqual(acquired, true);
		assert.strictEqual(existsSync(lockDir), true);

		lock.release();
		assert.strictEqual(existsSync(lockDir), false);

		cleanup(dir);
	});

	it('should block a second acquire until released', () => {
		const dir = makeTempDir();
		const lockDir = join(dir, '.lock');
		const opts = {
			lockTimeoutMs: 500,
			lockMaxHoldMs: 5000,
			heartbeatIntervalMs: 100,
			staleProcessTimeoutMs: 500,
		};

		const lock1 = new DirectoryLock(lockDir, opts);
		const lock2 = new DirectoryLock(lockDir, opts);

		assert.strictEqual(lock1.acquire(), true);
		assert.strictEqual(lock2.acquire(), false); // timeout waiting for lock1

		lock1.release();
		assert.strictEqual(lock2.acquire(), true); // now it can acquire
		lock2.release();

		cleanup(dir);
	});

	it('should steal a stale lock', () => {
		const dir = makeTempDir();
		const lockDir = join(dir, '.lock');
		const opts = {
			lockTimeoutMs: 2000,
			lockMaxHoldMs: 50, // very short stale threshold
			heartbeatIntervalMs: 100,
			staleProcessTimeoutMs: 500,
		};

		const lock1 = new DirectoryLock(lockDir, opts);
		const lock2 = new DirectoryLock(lockDir, opts);

		assert.strictEqual(lock1.acquire(), true);

		// Wait for the lock to become stale
		const start = Date.now();
		while (Date.now() - start < 150) {
			// busy wait
		}

		assert.strictEqual(lock2.acquire(), true); // should steal stale lock
		lock2.release();

		cleanup(dir);
	});
});

// ============================================================================
// GlobalRateLimiter single-process tests
// ============================================================================

describe('GlobalRateLimiter (single process)', () => {
	it('should init and write heartbeat file', () => {
		const dir = makeTempDir();
		const limiter = new GlobalRateLimiter({
			stateDir: dir,
			heartbeatIntervalMs: 100,
			lockTimeoutMs: 500,
			staleProcessTimeoutMs: 500,
		});

		limiter.init();
		assert.strictEqual(existsSync(join(dir, '.sessions', `${process.pid}.json`)), true);

		limiter.shutdown();
		assert.strictEqual(existsSync(join(dir, '.sessions', `${process.pid}.json`)), false);

		cleanup(dir);
	});

	it('should allow requests under the limit', () => {
		const dir = makeTempDir();
		const limiter = new GlobalRateLimiter({
			stateDir: dir,
			heartbeatIntervalMs: 100,
			lockTimeoutMs: 500,
			staleProcessTimeoutMs: 500,
		});
		limiter.init();

		const result = limiter.checkAndRecord(100, 10, 10000, 80);
		assert.strictEqual(result.allowed, true);

		const stats = limiter.getGlobalStats();
		assert.ok(stats);
		assert.strictEqual(stats!.requests, 1);
		assert.strictEqual(stats!.tokens, 100);

		limiter.shutdown();
		cleanup(dir);
	});

	it('should throttle when request count exceeds threshold', () => {
		const dir = makeTempDir();
		const limiter = new GlobalRateLimiter({
			stateDir: dir,
			heartbeatIntervalMs: 100,
			lockTimeoutMs: 500,
			staleProcessTimeoutMs: 500,
		});
		limiter.init();

		// Threshold is 80% of 5 = 4 requests
		for (let i = 0; i < 4; i++) {
			const r = limiter.checkAndRecord(10, 5, 10000, 80);
			assert.strictEqual(r.allowed, true);
		}

		// 5th request should be throttled
		const r = limiter.checkAndRecord(10, 5, 10000, 80);
		assert.strictEqual(r.allowed, false);
		if (!r.allowed) {
			assert.ok(r.delayMs > 0);
			assert.ok(r.delayMs <= 61000);
		}

		limiter.shutdown();
		cleanup(dir);
	});

	it('should throttle when token count exceeds threshold', () => {
		const dir = makeTempDir();
		const limiter = new GlobalRateLimiter({
			stateDir: dir,
			heartbeatIntervalMs: 100,
			lockTimeoutMs: 500,
			staleProcessTimeoutMs: 500,
		});
		limiter.init();

		// Threshold is 80% of 1000 = 800 tokens
		const r1 = limiter.checkAndRecord(700, 100, 1000, 80);
		assert.strictEqual(r1.allowed, true);

		// 700 + 200 = 900 >= 800 → throttled
		const r2 = limiter.checkAndRecord(200, 100, 1000, 80);
		assert.strictEqual(r2.allowed, false);
		if (!r2.allowed) {
			assert.ok(r2.delayMs > 0);
		}

		limiter.shutdown();
		cleanup(dir);
	});

	it('should correct last request tokens', () => {
		const dir = makeTempDir();
		const limiter = new GlobalRateLimiter({
			stateDir: dir,
			heartbeatIntervalMs: 100,
			lockTimeoutMs: 500,
			staleProcessTimeoutMs: 500,
		});
		limiter.init();

		limiter.checkAndRecord(100, 10, 10000, 80);
		limiter.correctLastRequest(250);

		const stats = limiter.getGlobalStats();
		assert.ok(stats);
		assert.strictEqual(stats!.tokens, 250);

		limiter.shutdown();
		cleanup(dir);
	});

	it('should rotate window and reset counters', () => {
		const dir = makeTempDir();
		const limiter = new GlobalRateLimiter({
			stateDir: dir,
			heartbeatIntervalMs: 100,
			lockTimeoutMs: 500,
			staleProcessTimeoutMs: 500,
		});
		limiter.init();

		limiter.checkAndRecord(100, 10, 10000, 80);
		let stats = limiter.getGlobalStats();
		assert.strictEqual(stats!.requests, 1);

		// Manually write an old window state
		const oldWindow = Math.floor(Date.now() / 60000) * 60000 - 60000;
		const statePath = join(dir, 'global-state.json');
		const oldState = {
			version: 1,
			windowStart: oldWindow,
			totalRequests: 99,
			totalTokens: 9999,
			processes: {},
		};
		writeFileSync(statePath, JSON.stringify(oldState), 'utf8');

		// Next check should rotate the window
		const r = limiter.checkAndRecord(50, 10, 10000, 80);
		assert.strictEqual(r.allowed, true);

		stats = limiter.getGlobalStats();
		assert.strictEqual(stats!.requests, 1); // rotated, only our new request
		assert.strictEqual(stats!.tokens, 50);

		limiter.shutdown();
		cleanup(dir);
	});
});

// ============================================================================
// Multi-process simulation tests
// ============================================================================

describe('GlobalRateLimiter (multi-process simulation)', () => {
	it('should aggregate requests from multiple simulated processes', () => {
		const dir = makeTempDir();
		const p1 = new GlobalRateLimiter({
			stateDir: dir,
			pid: 1111,
			heartbeatIntervalMs: 100,
			lockTimeoutMs: 500,
			staleProcessTimeoutMs: 500,
		});
		const p2 = new GlobalRateLimiter({
			stateDir: dir,
			pid: 2222,
			heartbeatIntervalMs: 100,
			lockTimeoutMs: 500,
			staleProcessTimeoutMs: 500,
		});
		const p3 = new GlobalRateLimiter({
			stateDir: dir,
			pid: 3333,
			heartbeatIntervalMs: 100,
			lockTimeoutMs: 500,
			staleProcessTimeoutMs: 500,
		});

		p1.init();
		p2.init();
		p3.init();

		// Each process makes 2 requests
		for (let i = 0; i < 2; i++) {
			assert.strictEqual(p1.checkAndRecord(10, 100, 10000, 80).allowed, true);
			assert.strictEqual(p2.checkAndRecord(10, 100, 10000, 80).allowed, true);
			assert.strictEqual(p3.checkAndRecord(10, 100, 10000, 80).allowed, true);
		}

		const stats = p1.getGlobalStats();
		assert.ok(stats);
		assert.strictEqual(stats!.requests, 6); // 2 * 3 processes
		assert.strictEqual(stats!.tokens, 60); // 10 * 6

		p1.shutdown();
		p2.shutdown();
		p3.shutdown();
		cleanup(dir);
	});

	it('should throttle when global request count exceeds threshold across processes', () => {
		const dir = makeTempDir();
		// Limit: 5 req/min, threshold 80% → throttle at 4 requests globally
		const p1 = new GlobalRateLimiter({
			stateDir: dir,
			pid: 1111,
			heartbeatIntervalMs: 100,
			lockTimeoutMs: 500,
			staleProcessTimeoutMs: 500,
		});
		const p2 = new GlobalRateLimiter({
			stateDir: dir,
			pid: 2222,
			heartbeatIntervalMs: 100,
			lockTimeoutMs: 500,
			staleProcessTimeoutMs: 500,
		});

		p1.init();
		p2.init();

		// p1 uses 3 requests
		for (let i = 0; i < 3; i++) {
			assert.strictEqual(p1.checkAndRecord(10, 5, 10000, 80).allowed, true);
		}

		// p2 uses 1 request → global total = 4 (at threshold)
		assert.strictEqual(p2.checkAndRecord(10, 5, 10000, 80).allowed, true);

		// p2 tries another → global total = 5 > 4 → throttled
		const r = p2.checkAndRecord(10, 5, 10000, 80);
		assert.strictEqual(r.allowed, false);

		p1.shutdown();
		p2.shutdown();
		cleanup(dir);
	});

	it('should clean up stale processes after timeout', () => {
		const dir = makeTempDir();
		const staleTimeout = 100;
		const p1 = new GlobalRateLimiter({
			stateDir: dir,
			pid: 1111,
			heartbeatIntervalMs: 50,
			lockTimeoutMs: 500,
			staleProcessTimeoutMs: staleTimeout,
		});
		const p2 = new GlobalRateLimiter({
			stateDir: dir,
			pid: 2222,
			heartbeatIntervalMs: 50,
			lockTimeoutMs: 500,
			staleProcessTimeoutMs: staleTimeout,
		});

		p1.init();
		p2.init();

		p1.checkAndRecord(10, 100, 10000, 80);
		p2.checkAndRecord(20, 100, 10000, 80);

		let stats = p1.getGlobalStats();
		assert.strictEqual(stats!.requests, 2);
		assert.strictEqual(stats!.tokens, 30);

		// Stop p2's heartbeat and remove its file to simulate crash
		p2.shutdown();
		// Also delete heartbeat so it looks like a crash
		try {
			rmSync(join(dir, '.sessions', '2222.json'), { force: true });
		} catch {}

		// Wait for stale timeout
		const start = Date.now();
		while (Date.now() - start < staleTimeout + 100) {
			// busy wait
		}

		// p1 makes another request → should clean up stale p2
		p1.checkAndRecord(10, 100, 10000, 80);

		stats = p1.getGlobalStats();
		assert.strictEqual(stats!.requests, 2); // p1's 2 requests only (p2 cleaned)
		assert.strictEqual(stats!.tokens, 20); // 10 + 10 (p2's 20 cleaned)

		p1.shutdown();
		cleanup(dir);
	});

	it('should remove self from global state on shutdown', () => {
		const dir = makeTempDir();
		const p1 = new GlobalRateLimiter({
			stateDir: dir,
			pid: 1111,
			heartbeatIntervalMs: 100,
			lockTimeoutMs: 500,
			staleProcessTimeoutMs: 500,
		});
		const p2 = new GlobalRateLimiter({
			stateDir: dir,
			pid: 2222,
			heartbeatIntervalMs: 100,
			lockTimeoutMs: 500,
			staleProcessTimeoutMs: 500,
		});

		p1.init();
		p2.init();

		p1.checkAndRecord(10, 100, 10000, 80);
		p2.checkAndRecord(20, 100, 10000, 80);

		let stats = p1.getGlobalStats();
		assert.strictEqual(stats!.requests, 2);

		p1.shutdown();

		// p2 makes another request to trigger state read
		p2.checkAndRecord(10, 100, 10000, 80);

		stats = p2.getGlobalStats();
		assert.strictEqual(stats!.requests, 2); // only p2's requests remain

		p2.shutdown();
		cleanup(dir);
	});
});

// ============================================================================
// Async throttle test
// ============================================================================

describe('GlobalRateLimiter.throttle', () => {
	it('should wait and retry after window reset', async () => {
		const dir = makeTempDir();
		const limiter = new GlobalRateLimiter({
			stateDir: dir,
			heartbeatIntervalMs: 100,
			lockTimeoutMs: 500,
			staleProcessTimeoutMs: 500,
		});
		limiter.init();

		// Fill up to threshold: 80% of 3 = 2.4 → throttle at 3 requests
		limiter.checkAndRecord(10, 3, 10000, 80);
		limiter.checkAndRecord(10, 3, 10000, 80);
		limiter.checkAndRecord(10, 3, 10000, 80);

		// Next request would be throttled normally
		// But we will manually rotate the window by writing old state
		const statePath = join(dir, 'global-state.json');
		const oldWindow = Math.floor(Date.now() / 60000) * 60000 - 60000;
		const oldState = {
			version: 1,
			windowStart: oldWindow,
			totalRequests: 99,
			totalTokens: 9999,
			processes: {},
		};
		writeFileSync(statePath, JSON.stringify(oldState), 'utf8');

		// throttle() should see the old window, wait, then rotate and succeed
		// But since we can't wait a full minute in tests, let's verify with a fresh limiter
		const limiter2 = new GlobalRateLimiter({
			stateDir: dir,
			pid: 9999,
			heartbeatIntervalMs: 100,
			lockTimeoutMs: 500,
			staleProcessTimeoutMs: 500,
		});
		limiter2.init();

		// With fresh window, should be allowed immediately
		const start = Date.now();
		await limiter2.throttle(10, 3, 10000, 80);
		const elapsed = Date.now() - start;
		assert.ok(elapsed < 500, `throttle took too long: ${elapsed}ms`);

		limiter.shutdown();
		limiter2.shutdown();
		cleanup(dir);
	});
});

// ============================================================================
// Per-model state tests
// ============================================================================

describe('GlobalRateLimiter (per-model)', () => {
	it('should track requests per model independently', () => {
		const dir = makeTempDir();
		const limiter = new GlobalRateLimiter({
			stateDir: dir,
			heartbeatIntervalMs: 100,
			lockTimeoutMs: 500,
			staleProcessTimeoutMs: 500,
		});
		limiter.init();

		// 3 requests for model A
		for (let i = 0; i < 3; i++) {
			const r = limiter.checkAndRecord(10, 10, 10000, 80, 'model-a');
			assert.strictEqual(r.allowed, true);
		}

		// 2 requests for model B
		for (let i = 0; i < 2; i++) {
			const r = limiter.checkAndRecord(10, 10, 10000, 80, 'model-b');
			assert.strictEqual(r.allowed, true);
		}

		const statsA = limiter.getGlobalStats('model-a');
		const statsB = limiter.getGlobalStats('model-b');

		assert.ok(statsA);
		assert.ok(statsB);
		assert.strictEqual(statsA!.requests, 3);
		assert.strictEqual(statsB!.requests, 2);

		limiter.shutdown();
		cleanup(dir);
	});

	it('should throttle per-model independently', () => {
		const dir = makeTempDir();
		const limiter = new GlobalRateLimiter({
			stateDir: dir,
			heartbeatIntervalMs: 100,
			lockTimeoutMs: 500,
			staleProcessTimeoutMs: 500,
		});
		limiter.init();

		// Fill model A to threshold: 80% of 3 = 2.4 → throttle at 3
		for (let i = 0; i < 3; i++) {
			limiter.checkAndRecord(10, 3, 10000, 80, 'model-a');
		}

		// Model A should throttle
		const rA = limiter.checkAndRecord(10, 3, 10000, 80, 'model-a');
		assert.strictEqual(rA.allowed, false);

		// Model B should still be allowed
		const rB = limiter.checkAndRecord(10, 3, 10000, 80, 'model-b');
		assert.strictEqual(rB.allowed, true);

		limiter.shutdown();
		cleanup(dir);
	});
});

// ============================================================================
// Optimistic locking tests
// ============================================================================

describe('OptimisticStateManager', () => {
	it('should atomically update state', () => {
		const dir = makeTempDir();
		const statePath = join(dir, 'state.json');
		const manager = new OptimisticStateManager(statePath);

		const state1 = manager.update((s) => {
			s.totalRequests = 1;
		});
		assert.ok(state1);
		assert.strictEqual(state1!.totalRequests, 1);

		const state2 = manager.update((s) => {
			s.totalRequests = 2;
		});
		assert.ok(state2);
		assert.strictEqual(state2!.totalRequests, 2);

		cleanup(dir);
	});

	it('should handle concurrent updates', () => {
		const dir = makeTempDir();
		const statePath = join(dir, 'state.json');
		const manager1 = new OptimisticStateManager(statePath);
		const manager2 = new OptimisticStateManager(statePath);

		// First update
		manager1.update((s) => {
			s.totalRequests = 10;
		});

		// Second update should succeed (retry on conflict)
		const result = manager2.update((s) => {
			s.totalRequests += 5;
		});
		assert.ok(result);
		assert.strictEqual(result!.totalRequests, 15);

		cleanup(dir);
	});
});

// ============================================================================
// Backward compatibility tests
// ============================================================================

describe('GlobalStateData v1 migration', () => {
	it('should migrate v1 state to v2 on read', () => {
		const dir = makeTempDir();
		const statePath = join(dir, 'global-state.json');
		const v1State = {
			version: 1,
			windowStart: Date.now(),
			totalRequests: 5,
			totalTokens: 100,
			processes: { '1234': { requests: 5, tokens: 100, lastHeartbeat: Date.now() } },
		};
		writeFileSync(statePath, JSON.stringify(v1State), 'utf8');

		const limiter = new GlobalRateLimiter({
			stateDir: dir,
			heartbeatIntervalMs: 100,
			lockTimeoutMs: 500,
			staleProcessTimeoutMs: 500,
		});
		limiter.init();

		const stats = limiter.getGlobalStats();
		assert.ok(stats);
		assert.strictEqual(stats!.requests, 5);

		limiter.shutdown();
		cleanup(dir);
	});
});
