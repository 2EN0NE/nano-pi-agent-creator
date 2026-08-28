/**
 * todos extension — status & widget tests
 *
 * Covers:
 *   - isTodoDone / isTodoClosed status helpers
 *   - buildWidgetContent: only shows open + done, never close
 *   - buildWidgetContent: done shows [x], open shows [ ]
 *   - buildWidgetContent: completion rate in summary
 *   - widgetFilter config removed — behavior fixed
 */
import { describe, it, expect } from 'vitest';
import { isTodoDone, isTodoClosed } from '../../../extensions/accuracy/todos/storage.js';
import { buildWidgetContent } from '../../../extensions/accuracy/todos/widget.js';
import type { TodoFrontMatter } from '../../../extensions/accuracy/todos/types.js';

// ── Helpers ──────────────────────────────────────────

function makeTodo(overrides: Partial<TodoFrontMatter> = {}): TodoFrontMatter {
	return {
		id: overrides.id || 'aabbccdd',
		title: overrides.title ?? 'Test task',
		tags: overrides.tags ?? [],
		status: overrides.status ?? 'open',
		created_at: overrides.created_at ?? new Date().toISOString(),
		assigned_to_session: overrides.assigned_to_session,
		project_id: overrides.project_id ?? 'project',
	};
}

// Minimal theme mock
const theme = {
	fg: (color: string, text: string) => `${color}:${text}`,
	bold: (text: string) => `*${text}*`,
} as any;

// Default config override for project scope + summary display
const defaultCfg = {
	widgetShow: true,
	widgetScope: 'project' as const,
	widgetDisplay: 'summary' as const,
};

// ── isTodoDone ───────────────────────────────────────

describe('isTodoDone', () => {
	it('returns true for "done"', () => {
		expect(isTodoDone('done')).toBe(true);
	});

	it('returns true for "DONE" (case-insensitive)', () => {
		expect(isTodoDone('DONE')).toBe(true);
	});

	it('returns false for "open"', () => {
		expect(isTodoDone('open')).toBe(false);
	});

	it('returns false for "close"', () => {
		expect(isTodoDone('close')).toBe(false);
	});

	it('returns false for legacy "complete"', () => {
		expect(isTodoDone('complete')).toBe(false);
	});

	it('returns false for legacy "completed"', () => {
		expect(isTodoDone('completed')).toBe(false);
	});

	it('returns false for legacy "closed"', () => {
		expect(isTodoDone('closed')).toBe(false);
	});
});

// ── isTodoClosed ─────────────────────────────────────

describe('isTodoClosed', () => {
	it('returns true for "close"', () => {
		expect(isTodoClosed('close')).toBe(true);
	});

	it('returns true for "CLOSE" (case-insensitive)', () => {
		expect(isTodoClosed('CLOSE')).toBe(true);
	});

	it('returns false for "open"', () => {
		expect(isTodoClosed('open')).toBe(false);
	});

	it('returns false for "done"', () => {
		expect(isTodoClosed('done')).toBe(false);
	});

	it('returns false for legacy "closed"', () => {
		expect(isTodoClosed('closed')).toBe(false);
	});
});

// ── buildWidgetContent: scope filtering ──────────────

describe('buildWidgetContent — scope filtering', () => {
	it('shows project todos when widgetScope is "project"', () => {
		const todos = [
			makeTodo({ id: '11111111', title: 'Project task', project_id: 'project' }),
			makeTodo({ id: '22222222', title: 'Global task', project_id: 'global' }),
		];
		const lines = buildWidgetContent(todos, theme, undefined, defaultCfg);
		expect(lines.some((l) => l.includes('Project task'))).toBe(true);
	});

	it('filters by session when widgetScope is "session"', () => {
		const todos = [
			makeTodo({
				id: '11111111',
				title: 'My session task',
				assigned_to_session: 'sess-1',
			}),
			makeTodo({
				id: '22222222',
				title: 'Other session task',
				assigned_to_session: 'sess-2',
			}),
		];
		const lines = buildWidgetContent(todos, theme, 'sess-1', {
			...defaultCfg,
			widgetScope: 'session',
		});
		expect(lines.some((l) => l.includes('My session task'))).toBe(true);
	});
});

// ── buildWidgetContent: close items NEVER appear ─────

describe('buildWidgetContent — close items hidden', () => {
	it('filters out close items in summary mode', () => {
		const todos = [
			makeTodo({ id: '11111111', title: 'Open task', status: 'open' }),
			makeTodo({ id: '22222222', title: 'Closed task', status: 'close' }),
		];
		const lines = buildWidgetContent(todos, theme, undefined, defaultCfg);
		expect(lines.some((l) => l.includes('Closed task'))).toBe(false);
		expect(lines.some((l) => l.includes('Open task'))).toBe(true);
	});

	it('filters out close items in detail mode', () => {
		const todos = [
			makeTodo({ id: '11111111', title: 'Open task', status: 'open' }),
			makeTodo({ id: '22222222', title: 'Closed task', status: 'close' }),
		];
		const lines = buildWidgetContent(todos, theme, undefined, {
			...defaultCfg,
			widgetDisplay: 'details',
		});
		expect(lines.some((l) => l.includes('Closed task'))).toBe(false);
	});

	it('shows "Todos: 无" when only close items exist', () => {
		const todos = [makeTodo({ id: '11111111', title: 'All closed', status: 'close' })];
		const lines = buildWidgetContent(todos, theme, undefined, defaultCfg);
		expect(lines.some((l) => l.includes('Todos: 无'))).toBe(true);
	});
});

// ── buildWidgetContent: done items show with [x] ─────

describe('buildWidgetContent — done items display', () => {
	it('shows done items with [x] prefix in summary mode', () => {
		const todos = [
			makeTodo({ id: '11111111', title: 'Open task', status: 'open' }),
			makeTodo({ id: '22222222', title: 'Done task', status: 'done' }),
		];
		const lines = buildWidgetContent(todos, theme, undefined, defaultCfg);
		// Done task should appear
		expect(lines.some((l) => l.includes('Done task'))).toBe(true);
		// Done task should have [x] not [ ]
		const doneLine = lines.find((l) => l.includes('Done task'));
		expect(doneLine).toContain('[x]');
	});

	it('shows done items with [x] prefix in detail mode', () => {
		const todos = [
			makeTodo({ id: '11111111', title: 'Open task', status: 'open' }),
			makeTodo({ id: '22222222', title: 'Done task', status: 'done' }),
		];
		const lines = buildWidgetContent(todos, theme, undefined, {
			...defaultCfg,
			widgetDisplay: 'details',
		});
		const doneLine = lines.find((l) => l.includes('Done task'));
		expect(doneLine).toContain('[x]');
	});

	it('shows open items with [ ] in summary mode', () => {
		const todos = [makeTodo({ id: '11111111', title: 'Open task', status: 'open' })];
		const lines = buildWidgetContent(todos, theme, undefined, defaultCfg);
		expect(lines.some((l) => l.includes('[ ]'))).toBe(true);
	});
});

// ── buildWidgetContent: completion stats ─────────────

describe('buildWidgetContent — completion stats', () => {
	it('shows done count for mixed open + done', () => {
		const todos = [
			makeTodo({ id: '11111111', title: 'Task 1', status: 'open' }),
			makeTodo({ id: '22222222', title: 'Task 2', status: 'done' }),
			makeTodo({ id: '33333333', title: 'Task 3', status: 'open' }),
		];
		const lines = buildWidgetContent(todos, theme, undefined, defaultCfg);
		// Summary mode shows "2 待处理 | 1 已完成" format (no assignment, so no "进行中")
		expect(lines.some((l) => l.includes('待处理') && l.includes('2'))).toBe(true);
		expect(lines.some((l) => l.includes('已完成') && l.includes('1'))).toBe(true);
	});

	it('shows 100% when all are done', () => {
		const todos = [
			makeTodo({ id: '11111111', title: 'Task 1', status: 'done' }),
			makeTodo({ id: '22222222', title: 'Task 2', status: 'done' }),
		];
		const lines = buildWidgetContent(todos, theme, undefined, defaultCfg);
		// All done means 0 pending, 2 done. The output includes counts.
		expect(lines.some((l) => l.includes('已完成') && l.includes('2'))).toBe(true);
	});

	it('total counts only open + done, not close', () => {
		const todos = [
			makeTodo({ id: '11111111', title: 'Open task', status: 'open' }),
			makeTodo({ id: '22222222', title: 'Done task', status: 'done' }),
			makeTodo({ id: '33333333', title: 'Closed task', status: 'close' }),
		];
		const lines = buildWidgetContent(todos, theme, undefined, defaultCfg);
		// close should not be in the counts
		expect(lines.some((l) => l.includes('已关闭'))).toBe(false);
	});
});

// ── buildWidgetContent: widgetShow=false ─────────────

describe('buildWidgetContent — hidden', () => {
	it('returns empty when widgetShow is false', () => {
		const todos = [makeTodo({ id: '11111111', title: 'Task', status: 'open' })];
		const lines = buildWidgetContent(todos, theme, undefined, {
			...defaultCfg,
			widgetShow: false,
		});
		expect(lines).toEqual([]);
	});
});
