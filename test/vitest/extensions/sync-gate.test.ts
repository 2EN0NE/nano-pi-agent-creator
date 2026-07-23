/**
 * sync-gate — 单元测试
 *
 * 验证 SyncGate 重入保护机制：
 * 1. 同步进行中时新请求应排队（返回 'queued'）
 * 2. 同步完成后 pending 标志应可查询
 * 3. pending 被消费后应重置
 * 4. 串行调用的常规同步行为
 */
import { describe, it, expect } from 'vitest';

// ── SyncGate：重入保护 + 自动待同步跟踪 ─────────────────────

class SyncGate {
	private _inProgress = false;
	private _pending = false;

	get inProgress(): boolean {
		return this._inProgress;
	}

	get pending(): boolean {
		return this._pending;
	}

	/**
	 * 尝试执行同步操作。
	 *
	 * @returns 'synced' — 同步已执行
	 *          'queued' — 同步进行中，已标记待重新检测
	 */
	async run(fn: () => Promise<void>): Promise<'synced' | 'queued'> {
		if (this._inProgress) {
			this._pending = true;
			return 'queued';
		}

		this._inProgress = true;
		this._pending = false;
		try {
			await fn();
			return 'synced';
		} finally {
			this._inProgress = false;
		}
	}

	/** 消费 pending 标记（同步完成后的重检测） */
	consumePending(): boolean {
		if (this._pending) {
			this._pending = false;
			return true;
		}
		return false;
	}
}

// ══════════════════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════════════════

describe('SyncGate', () => {
	it('首次调用执行同步函数', async () => {
		const gate = new SyncGate();
		let executed = false;

		const result = await gate.run(async () => {
			executed = true;
		});

		expect(result).toBe('synced');
		expect(executed).toBe(true);
		expect(gate.inProgress).toBe(false);
		expect(gate.pending).toBe(false);
	});

	it('同步进行中新调用返回 queued 并标记 pending', async () => {
		const gate = new SyncGate();

		// 开始一个不会立即结束的同步
		const firstPromise = gate.run(async () => {
			await new Promise((r) => setTimeout(r, 50));
		});

		// 等待同步开始
		await new Promise((r) => setTimeout(r, 20));

		// 此时 inProgress 应为 true
		expect(gate.inProgress).toBe(true);

		// 第二次调用应返回 queued
		const secondResult = await gate.run(async () => {
			/* 不应执行 */
		});

		expect(secondResult).toBe('queued');
		expect(gate.pending).toBe(true);

		// 等待第一个同步完成
		await firstPromise;

		expect(gate.inProgress).toBe(false);
		// pending 应在 consumePending 前仍为 true
		expect(gate.pending).toBe(true);
	});

	it('consumePending 消费 pending 标记', async () => {
		const gate = new SyncGate();

		// 触发一个长同步
		const firstPromise = gate.run(async () => {
			await new Promise((r) => setTimeout(r, 30));
		});

		// 在同步中第二次调用
		await new Promise((r) => setTimeout(r, 10));
		await gate.run(async () => {});

		await firstPromise;

		expect(gate.pending).toBe(true);

		// 消费 pending
		const consumed = gate.consumePending();
		expect(consumed).toBe(true);
		expect(gate.pending).toBe(false);

		// 再次 consume 应返回 false
		expect(gate.consumePending()).toBe(false);
	});

	it('无并发时三次连续调用正常同步', async () => {
		const gate = new SyncGate();
		let count = 0;

		const r1 = await gate.run(async () => {
			count++;
			await new Promise((r) => setTimeout(r, 10));
		});
		expect(r1).toBe('synced');
		expect(count).toBe(1);

		const r2 = await gate.run(async () => {
			count++;
			await new Promise((r) => setTimeout(r, 10));
		});
		expect(r2).toBe('synced');
		expect(count).toBe(2);

		const r3 = await gate.run(async () => {
			count++;
		});
		expect(r3).toBe('synced');
		expect(count).toBe(3);

		expect(gate.pending).toBe(false);
	});

	it('同步函数抛出异常时正确释放锁', async () => {
		const gate = new SyncGate();

		// run 会传递回 fn 的异常
		await expect(
			gate.run(async () => {
				throw new Error('sync failed');
			}),
		).rejects.toThrow('sync failed');

		// 但锁已正确释放
		expect(gate.inProgress).toBe(false);
		expect(gate.pending).toBe(false);

		// 锁释放后新调用正常执行
		let executed = false;
		const result = await gate.run(async () => {
			executed = true;
		});
		expect(result).toBe('synced');
		expect(executed).toBe(true);
	});
});
