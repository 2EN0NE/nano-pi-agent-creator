/**
 * todos extension — scope & project_id storage tests
 *
 * Covers:
 *   - filterTodosByScope with session / project / global
 *   - project_id tagging on listTodos
 *   - serializeTodo preserves project_id
 *   - parseFrontMatter reads project_id
 */
import { describe, it, expect } from 'vitest';
import {
	filterTodosByScope,
	serializeTodo,
	parseFrontMatter,
} from '../../../extensions/accuracy/todos/storage.js';
import type { TodoRecord, TodoFrontMatter } from '../../../extensions/accuracy/todos/types.js';

function makeTodo(overrides: Partial<TodoFrontMatter> = {}): TodoFrontMatter {
	return {
		id: overrides.id || 'aabbccdd',
		title: overrides.title ?? 'Test todo',
		tags: overrides.tags ?? [],
		status: overrides.status ?? 'open',
		created_at: overrides.created_at ?? new Date().toISOString(),
		assigned_to_session: overrides.assigned_to_session,
		project_id: overrides.project_id,
	};
}

function makeRecord(overrides: Partial<TodoRecord> = {}): TodoRecord {
	return {
		...makeTodo(overrides),
		body: overrides.body ?? 'Some notes',
	} as TodoRecord;
}

describe('filterTodosByScope', () => {
	const sessionId = 'session-abc-123';

	const todos: TodoFrontMatter[] = [
		makeTodo({
			id: 'aaa',
			title: 'Session task',
			assigned_to_session: sessionId,
			project_id: 'project',
		}),
		makeTodo({ id: 'bbb', title: 'Project task', project_id: 'project' }),
		makeTodo({
			id: 'ccc',
			title: 'Closed project task',
			status: 'closed',
			project_id: 'project',
		}),
		makeTodo({ id: 'ddd', title: 'Global task', project_id: 'global' }),
		makeTodo({ id: 'eee', title: 'Global no project_id', project_id: undefined }),
		makeTodo({
			id: 'fff',
			title: 'Session global task',
			assigned_to_session: sessionId,
			project_id: 'global',
		}),
	];

	it('session scope returns assigned + unassigned project todos', () => {
		const result = filterTodosByScope(todos, 'session', sessionId);
		// aaa, fff: explicitly assigned to sessionId
		// bbb, ccc: unassigned project-level → included
		// eee: unassigned, no project_id → treated as project → included
		// ddd: unassigned global → excluded
		expect(result).toHaveLength(5);
		expect(result.map((t) => t.id)).toEqual(
			expect.arrayContaining(['aaa', 'bbb', 'ccc', 'eee', 'fff']),
		);
		expect(result.map((t) => t.id)).not.toContain('ddd');
	});

	it('project scope returns only project todos', () => {
		const result = filterTodosByScope(todos, 'project');
		// aaa, bbb, ccc: explicit project_id='project'  + eee: no project_id (defaults to project)
		expect(result).toHaveLength(4);
		expect(result.map((t) => t.id)).toEqual(
			expect.arrayContaining(['aaa', 'bbb', 'ccc', 'eee']),
		);
		expect(result.map((t) => t.id)).not.toContain('ddd');
		expect(result.map((t) => t.id)).not.toContain('fff');
	});

	it('global scope returns everything', () => {
		const result = filterTodosByScope(todos, 'global');
		expect(result).toHaveLength(6);
	});

	it('session scope with no session id returns empty array', () => {
		const result = filterTodosByScope(todos, 'session');
		expect(result).toHaveLength(0);
	});
});

describe('serializeTodo with project_id', () => {
	it('serializes project_id in front matter', () => {
		const todo = makeRecord({ id: 'test01', title: 'Has project', project_id: 'project' });
		const serialized = serializeTodo(todo);
		expect(serialized).toContain('"project_id": "project"');
	});

	it('defaults project_id to "project" when missing', () => {
		const todo = makeRecord({ id: 'test02', title: 'No project' });
		const serialized = serializeTodo(todo);
		expect(serialized).toContain('"project_id": "project"');
	});

	it('serializes global project_id', () => {
		const todo = makeRecord({ id: 'test03', title: 'Global', project_id: 'global' });
		const serialized = serializeTodo(todo);
		expect(serialized).toContain('"project_id": "global"');
	});

	it('serializes assigned_to_session', () => {
		const todo = makeRecord({
			id: 'test04',
			title: 'Session',
			assigned_to_session: 'session-xyz',
		});
		const serialized = serializeTodo(todo);
		expect(serialized).toContain('"assigned_to_session": "session-xyz"');
	});
});

describe('parseFrontMatter with project_id', () => {
	it('reads project_id from JSON front matter', () => {
		const json = JSON.stringify({ id: 'abc', title: 'T', project_id: 'global' });
		const result = parseFrontMatter(json, 'abc');
		expect(result.project_id).toBe('global');
	});

	it('defaults project_id to undefined when not present', () => {
		const json = JSON.stringify({ id: 'abc', title: 'T' });
		const result = parseFrontMatter(json, 'abc');
		expect(result.project_id).toBeUndefined();
	});
});
