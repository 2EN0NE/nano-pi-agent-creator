/**
 * 执行槽（ADR-0055 `D2`）：租约、幂等占用、保守回收
 *
 * 抄自参考实现 `pi-subagents-1` 的容量槽语义，核心是**保守**：
 *   · 释放必须带 token（旧占用者不得误释放新占用）；
 *   · 只在该进程**证明已死**时回收；状态未知时要超过阈值才回收；阈值可禁用。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	claimSlot,
	readSlot,
	reconcileSlot,
	releaseSlot,
	resolveAbandonedReleaseAfterMs,
	DEFAULT_ABANDONED_SLOT_RELEASE_AFTER_MS,
	MIN_ABANDONED_SLOT_RELEASE_AFTER_MS,
	MAX_ABANDONED_SLOT_RELEASE_AFTER_MS,
} from '../../../extensions/auto/org/slot.js';

const ORG = 'dev-team';
const ME = 'worker-a';
let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'org-slot-'));
	process.env.ORG_ROOT = root;
	mkdirSync(join(root, ME), { recursive: true });
});

afterEach(() => {
	delete process.env.ORG_ROOT;
	rmSync(root, { recursive: true, force: true });
});

describe('占用与释放（租约）', () => {
	it('空槽占用成功；重复占用同一任务幂等', async () => {
		const first = await claimSlot(ORG, ME, { taskId: 'M-1', subTaskId: 'S-1' });
		expect(first.ok).toBe(true);
		const again = await claimSlot(ORG, ME, { taskId: 'M-1', subTaskId: 'S-1' });
		expect(again.ok).toBe(true);
	});

	it('已有别的任务在跑 → 拒绝占用并回报占用者（串行前提）', async () => {
		await claimSlot(ORG, ME, { taskId: 'M-1' });
		const res = await claimSlot(ORG, ME, { taskId: 'M-2' });
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.holder.taskId).toBe('M-1');
	});

	it('租约不匹配的释放被拒（旧占用者不得误释放新占用）', async () => {
		const c = await claimSlot(ORG, ME, { taskId: 'M-1' });
		expect(c.ok).toBe(true);
		expect(await releaseSlot(ORG, ME, 'stale-token')).toBe('not-owner');
		expect(await readSlot(ORG, ME)).not.toBeNull();
		if (c.ok) expect(await releaseSlot(ORG, ME, c.record.token)).toBe('released');
		expect(await readSlot(ORG, ME)).toBeNull();
	});

	it('空槽释放返回 free（幂等）', async () => {
		expect(await releaseSlot(ORG, ME, 'whatever')).toBe('free');
	});
});

describe('对账回收（保守优先）', () => {
	it('无记录 → none', async () => {
		expect((await reconcileSlot(ORG, ME)).state).toBe('none');
	});

	it('进程存活 → held（绝不误判活着的成员）', async () => {
		await claimSlot(ORG, ME, { taskId: 'M-1', pid: 4242 });
		const res = await reconcileSlot(ORG, ME, { liveness: () => true });
		expect(res.state).toBe('held');
		expect(await readSlot(ORG, ME)).not.toBeNull();
	});

	it('进程已死（有死亡实证）→ reclaimed', async () => {
		await claimSlot(ORG, ME, { taskId: 'M-1', pid: 4242 });
		const res = await reconcileSlot(ORG, ME, {
			liveness: () => false,
			abandonedAfterMs: false, // 即便禁用超时策略，死亡实证仍回收
		});
		expect(res.state).toBe('reclaimed');
		expect(await readSlot(ORG, ME)).toBeNull();
	});

	it('无 pid 且未超阈值 → held；超过阈值 → reclaimed', async () => {
		await claimSlot(ORG, ME, { taskId: 'M-1', pid: 0 });
		// 阈值钳位到 5min–24h（抄参考实现）：这里用钳位后的 5min 做边界
		expect(
			(
				await reconcileSlot(ORG, ME, {
					abandonedAfterMs: MIN_ABANDONED_SLOT_RELEASE_AFTER_MS,
				})
			).state,
		).toBe('held');
		const res = await reconcileSlot(ORG, ME, {
			abandonedAfterMs: MIN_ABANDONED_SLOT_RELEASE_AFTER_MS,
			now: Date.now() + MIN_ABANDONED_SLOT_RELEASE_AFTER_MS + 60_000,
		});
		expect(res.state).toBe('reclaimed');
	});

	it('阈值可禁用：无 pid 也保留并说明原因', async () => {
		await claimSlot(ORG, ME, { taskId: 'M-1', pid: 0 });
		const res = await reconcileSlot(ORG, ME, { abandonedAfterMs: false });
		expect(res.state).toBe('held');
		expect(res.reason).toContain('禁用');
	});
});

describe('阈值解析（配置入口）', () => {
	it('非法值回默认', () => {
		expect(resolveAbandonedReleaseAfterMs(undefined)).toBe(
			DEFAULT_ABANDONED_SLOT_RELEASE_AFTER_MS,
		);
		expect(resolveAbandonedReleaseAfterMs('nope')).toBe(
			DEFAULT_ABANDONED_SLOT_RELEASE_AFTER_MS,
		);
	});
	it('数值钳位到 5min–24h', () => {
		expect(resolveAbandonedReleaseAfterMs(1)).toBe(MIN_ABANDONED_SLOT_RELEASE_AFTER_MS);
		expect(resolveAbandonedReleaseAfterMs(99 * 3600_000)).toBe(
			MAX_ABANDONED_SLOT_RELEASE_AFTER_MS,
		);
	});
	it('false = 禁用', () => {
		expect(resolveAbandonedReleaseAfterMs(false)).toBe(false);
	});
});
