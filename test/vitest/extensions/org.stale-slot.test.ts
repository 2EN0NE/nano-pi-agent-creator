/**
 * 失效执行槽释放（ADR-0055 `D2`）
 *
 * 回归背景：`claimSlot` 只在「空槽 / 同一任务同一 pid」放行，而释放只发生在交付与离岗。
 * 取消 / 叫停 / 改派都会把参与者移出非终态却**不碰槽**——成员于是被「一次只做一件」永久挡住，
 * 而 `reconcileSlot` 因本进程存活永远判 held，救不回来。
 *
 * 本测试钉住两半：`hasOpenAssignment`（任务侧"还算不算在手"）与 `releaseSlotIfStale`（按此释放本进程的槽）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parkOrgRoot } from '../setup/org-root.js';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { claimSlot, readSlot, releaseSlotIfStale } from '../../../extensions/auto/org/slot.js';
import { hasOpenAssignment } from '../../../extensions/auto/org/task.js';
import type { Assignee, Task } from '../../../extensions/auto/org/types.js';

const ORG = 'dev-team';
const ME = 'worker-a';
let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'org-stale-slot-'));
	process.env.ORG_ROOT = root;
	mkdirSync(join(root, ME), { recursive: true });
});

afterEach(() => {
	parkOrgRoot();
	rmSync(root, { recursive: true, force: true });
});

function taskWith(status: Assignee['status'], stopped = false): Task {
	return {
		schemaVersion: 1,
		id: 'M-1',
		org: ORG,
		title: 't',
		background: 'b',
		items: [],
		dispatcher: 'chief',
		dispatcherRole: 'chief',
		createdAt: '2026-09-14T00:00:00.000Z',
		updatedAt: '2026-09-14T00:00:00.000Z',
		status: 'in_progress',
		subTasks: [
			{
				id: 'S-1',
				description: 'x',
				assignees: [{ agent: ME, status, round: 0, deliveries: [], stopped }],
			},
		],
		history: [],
	};
}

describe('hasOpenAssignment（任务侧的在手判定）', () => {
	it('invited / claimed / returned 都算在手', () => {
		for (const s of ['invited', 'claimed', 'returned'] as const) {
			expect(hasOpenAssignment(taskWith(s), ME, 'S-1')).toBe(true);
		}
	});

	it('cancelled / rejected / delivered 不算在手', () => {
		for (const s of ['cancelled', 'rejected', 'delivered'] as const) {
			expect(hasOpenAssignment(taskWith(s), ME, 'S-1')).toBe(false);
		}
	});

	it('被叫停（stopped）即使状态仍是 claimed 也不算在手', () => {
		expect(hasOpenAssignment(taskWith('claimed', true), ME, 'S-1')).toBe(false);
	});

	it('子任务不匹配 → 不看其它子任务的在手工作', () => {
		const task = taskWith('cancelled');
		task.subTasks.push({
			id: 'S-2',
			description: 'y',
			assignees: [{ agent: ME, status: 'invited', round: 0, deliveries: [] }],
		});
		// 槽指向 S-1：S-1 已取消 → 即便 S-2 还有 invited，也不该据此判"在手"
		expect(hasOpenAssignment(task, ME, 'S-1')).toBe(false);
		// 缺省（不看子任务）→ 还有 invited，算在手
		expect(hasOpenAssignment(task, ME)).toBe(true);
	});
});

describe('releaseSlotIfStale（按任务侧判定释放本进程的槽）', () => {
	it('任务仍在手 → 保留；离开非终态 → 释放', async () => {
		await claimSlot(ORG, ME, { taskId: 'M-1', subTaskId: 'S-1' });

		// 仍在手（claimed）→ 不释放
		const stillClaimed = taskWith('claimed');
		expect(
			await releaseSlotIfStale(ORG, ME, async () =>
				hasOpenAssignment(stillClaimed, ME, 'S-1'),
			),
		).toBe(false);
		expect(await readSlot(ORG, ME)).not.toBeNull();

		// 被取消（离开非终态）→ 释放
		const cancelled = taskWith('cancelled');
		expect(
			await releaseSlotIfStale(ORG, ME, async () => hasOpenAssignment(cancelled, ME, 'S-1')),
		).toBe(true);
		expect(await readSlot(ORG, ME)).toBeNull();
	});

	it('空槽 → 不动（幂等）', async () => {
		expect(await releaseSlotIfStale(ORG, ME, async () => false)).toBe(false);
	});

	it('他方**存活**进程持有的槽 → 不越权释放', async () => {
		// 父进程（vitest runner）确定存活：本进程之外的活持有者，绝不越权释放
		await claimSlot(ORG, ME, { taskId: 'M-1', subTaskId: 'S-1', pid: process.ppid });
		expect(await releaseSlotIfStale(ORG, ME, async () => false)).toBe(false);
		expect(await readSlot(ORG, ME)).not.toBeNull();
	});

	it('他方**已死**进程残留的槽（任务侧已无在手工作）→ 可释放', async () => {
		// 为什么允许：进程存活校验证伪 + 调用方已确认任务侧无在手工作 = 证明已死的保守回收，
		// 死进程不可能被误伤；不放行则"成员进程重启后残留的槽"要等巡检下一拍才解锁（ADR-0055 `D2`）
		await claimSlot(ORG, ME, { taskId: 'M-1', subTaskId: 'S-1', pid: 2_147_483_646 });
		expect(await releaseSlotIfStale(ORG, ME, async () => false)).toBe(true);
		expect(await readSlot(ORG, ME)).toBeNull();
	});

	it('他方已死进程残留的槽，但任务侧仍有在手工作 → 仍不释放', async () => {
		await claimSlot(ORG, ME, { taskId: 'M-1', subTaskId: 'S-1', pid: 2_147_483_646 });
		expect(await releaseSlotIfStale(ORG, ME, async () => true)).toBe(false);
		expect(await readSlot(ORG, ME)).not.toBeNull();
	});
});
