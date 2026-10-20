/**
 * 完成时限与逾期（ADR-0055 `D3`/`D7`）：纯函数口径
 *
 * 逾期动作 = **标记 + 通知，不自动回落**；同一参与者只标记一次（巡检不重复写历史/重复通知）。
 */
import { describe, expect, it } from 'vitest';

import {
	findOverdue,
	isOverdueMarked,
	markOverdue,
	OVERDUE_EVENT,
	markInterrupted,
	INTERRUPTED_EVENT,
} from '../../../extensions/auto/org/task.js';
import type { Task } from '../../../extensions/auto/org/types.js';

function taskWith(dueAt: string | null, status: 'invited' | 'claimed' | 'delivered' = 'invited') {
	const t: Task = {
		schemaVersion: 1,
		id: 'M-1',
		org: 'dev-team',
		title: 't',
		background: '',
		items: [],
		dispatcher: 'chief',
		dispatcherRole: 'chief',
		dueAt,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		status: 'in_progress',
		subTasks: [
			{
				id: 'S-1',
				description: 'd',
				assignees: [{ agent: 'worker-a', status, round: 0, deliveries: [] }],
			},
		],
		history: [],
	};
	return t;
}

const NOW = Date.parse('2026-09-14T12:00:00.000Z');

describe('findOverdue（只读口径）', () => {
	it('未设时限 → 不判逾期', () => {
		expect(findOverdue([taskWith(null)], NOW)).toHaveLength(0);
	});

	it('未到期 → 不判逾期', () => {
		expect(findOverdue([taskWith('2026-09-14T13:00:00.000Z')], NOW)).toHaveLength(0);
	});

	it('已过期且未终态 → 命中', () => {
		const hit = findOverdue([taskWith('2026-09-14T11:00:00.000Z')], NOW);
		expect(hit).toHaveLength(1);
		expect(hit[0].sub.id).toBe('S-1');
	});

	it('已交付 → 不判逾期（终态）', () => {
		expect(findOverdue([taskWith('2026-09-14T11:00:00.000Z', 'delivered')], NOW)).toHaveLength(
			0,
		);
	});

	it('已关闭任务 → 不判逾期（铁终态）', () => {
		const t = taskWith('2026-09-14T11:00:00.000Z');
		t.status = 'closed';
		expect(findOverdue([t], NOW)).toHaveLength(0);
	});

	it('子任务级时限优先于任务级', () => {
		const t = taskWith('2026-09-14T11:00:00.000Z');
		t.subTasks[0].dueAt = '2026-09-14T13:00:00.000Z';
		expect(findOverdue([t], NOW)).toHaveLength(0);
	});
});

describe('markOverdue（标记 + 幂等）', () => {
	it('标记写入历史并可被查重（不重复标记/重复通知）', () => {
		const t = taskWith('2026-09-14T11:00:00.000Z');
		const entry = findOverdue([t], NOW)[0];
		expect(markOverdue(entry, NOW)).toBe(true);
		expect(isOverdueMarked(t, t.subTasks[0], 'worker-a')).toBe(true);
		expect(t.history.some((h) => h.event === OVERDUE_EVENT)).toBe(true);
		// 再次扫描：已标记 → 不再命中（巡检不重复通知）
		expect(findOverdue([t], NOW)).toHaveLength(0);
		expect(markOverdue(entry, NOW)).toBe(false);
	});

	it('不自动回落：参与者状态与任务状态都不变', () => {
		const t = taskWith('2026-09-14T11:00:00.000Z');
		const entry = findOverdue([t], NOW)[0];
		markOverdue(entry, NOW);
		expect(t.subTasks[0].assignees[0].status).toBe('invited');
		expect(t.status).toBe('in_progress');
	});
});

describe('markInterrupted（ADR-0055 D7：可指认）', () => {
	it('记录谁 / 何时 / 当时在做什么', () => {
		const t = taskWith(null);
		markInterrupted(t, 'chief', { subTaskId: 'S-1', context: '被抢占时正在执行 M-1/S-1' }, NOW);
		const evt = t.history.find((h) => h.event === INTERRUPTED_EVENT);
		expect(evt?.by).toBe('chief');
		expect(evt?.note).toContain('S-1');
		expect(evt?.at).toBe(new Date(NOW).toISOString());
	});
});
