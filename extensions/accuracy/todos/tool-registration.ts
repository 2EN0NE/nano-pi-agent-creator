import type { ExtensionAPI, Theme } from '@earendil-works/pi-coding-agent';
import { existsSync } from 'node:fs';
import { createLogger } from '@zenone/pi-logger';
import { keyHint } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import type { TodoAction, TodoRecord, TodoFrontMatter, TodoToolDetails } from './types.js';
import { TodoParams } from './types.js';
import {
	formatTodoId,
	normalizeTodoId,
	validateTodoId,
	getTodosDir,
	getTodoPath,
	ensureTodosDir,
	generateTodoId,
	ensureTodoExists,
	writeTodoFile,
	listTodos,
	listAllTodos,
	filterTodosByScope,
	isTodoClosed,
	splitTodosByAssignment,
	serializeTodoForAgent,
	serializeTodoListForAgent,
	withTodoLock,
	clearAssignmentIfClosed,
	appendTodoBody,
	releaseTodoAssignment,
	claimTodoAssignment,
	deleteTodo,
	getTodoTitle,
	getTodoStatus,
	renderAssignmentSuffix,
} from './storage.js';

const log = createLogger('todos:tool');

export function registerTool(pi: ExtensionAPI): void {
	const todosDirLabel = getTodosDir(process.cwd());

	pi.registerTool({
		name: 'todo',
		label: 'Todo',
		description:
			`Manage file-based todos in ${todosDirLabel} (list, list-all, get, create, update, append, delete, claim, release). ` +
			'Title is the short summary; body is long-form markdown notes (update replaces, append adds). ' +
			'Todo ids are shown as TODO-<hex>; id parameters accept TODO-<hex> or the raw hex filename. ' +
			'Claim tasks before working on them to avoid conflicts, and close them when complete.',
		parameters: TodoParams,

		async execute(
			_toolCallId: string,
			params: any,
			_signal: AbortSignal | undefined,
			_onUpdate: any,
			ctx: any,
		) {
			const cwd = (ctx as any).cwd || process.cwd();
			const todosDir = getTodosDir(cwd);
			const action: TodoAction = params.action;

			switch (action) {
				case 'list': {
					const scope: 'session' | 'project' | 'global' =
						(params as any).scope || 'session';
					const allTodos = await listAllTodos(cwd);
					const filtered = filterTodosByScope(
						allTodos,
						scope,
						ctx.sessionManager.getSessionId(),
					);
					const { assignedTodos, openTodos } = splitTodosByAssignment(filtered);
					const listedTodos = [...assignedTodos, ...openTodos];
					const currentSessionId = ctx.sessionManager.getSessionId();
					return {
						content: [{ type: 'text', text: serializeTodoListForAgent(listedTodos) }],
						details: {
							action: 'list',
							todos: listedTodos,
							currentSessionId,
						} as TodoToolDetails,
					};
				}

				case 'list-all': {
					const allTodos = await listAllTodos(cwd);
					const currentSessionId = ctx.sessionManager.getSessionId();
					return {
						content: [{ type: 'text', text: serializeTodoListForAgent(allTodos) }],
						details: {
							action: 'list-all',
							todos: allTodos,
							currentSessionId,
						} as TodoToolDetails,
					};
				}

				case 'get': {
					if (!params.id) {
						return {
							content: [{ type: 'text', text: 'Error: id required' }],
							details: { action: 'get', error: 'id required' } as any,
						};
					}
					const validated = validateTodoId(params.id);
					if ('error' in validated) {
						return {
							content: [{ type: 'text', text: validated.error }],
							details: { action: 'get', error: validated.error } as any,
						};
					}
					const filePath = getTodoPath(todosDir, validated.id);
					const todo = await ensureTodoExists(filePath, validated.id);
					if (!todo) {
						return {
							content: [
								{
									type: 'text',
									text: `Todo ${formatTodoId(validated.id)} not found`,
								},
							],
							details: { action: 'get', error: 'not found' } as any,
						};
					}
					return {
						content: [{ type: 'text', text: serializeTodoForAgent(todo) }],
						details: { action: 'get', todo } as TodoToolDetails,
					};
				}

				case 'create': {
					if (!params.title) {
						return {
							content: [{ type: 'text', text: 'Error: title required' }],
							details: { action: 'create', error: 'title required' } as any,
						};
					}
					await ensureTodosDir(todosDir);
					const id = await generateTodoId(todosDir);
					const filePath = getTodoPath(todosDir, id);
					const sessionId = ctx.sessionManager.getSessionId();
					const todo: TodoRecord = {
						id,
						title: params.title,
						tags: params.tags ?? [],
						status: params.status ?? 'open',
						created_at: new Date().toISOString(),
						body: params.body ?? '',
						assigned_to_session: sessionId || undefined,
						project_id: 'project',
					};

					const result = await withTodoLock(todosDir, id, ctx, async () => {
						await writeTodoFile(filePath, todo);
						return todo;
					});

					if (typeof result === 'object' && 'error' in result) {
						return {
							content: [{ type: 'text', text: result.error }],
							details: { action: 'create', error: result.error } as any,
						};
					}
					return {
						content: [{ type: 'text', text: serializeTodoForAgent(todo) }],
						details: { action: 'create', todo } as TodoToolDetails,
					};
				}

				case 'update': {
					if (!params.id) {
						return {
							content: [{ type: 'text', text: 'Error: id required' }],
							details: { action: 'update', error: 'id required' } as any,
						};
					}
					const validated = validateTodoId(params.id);
					if ('error' in validated) {
						return {
							content: [{ type: 'text', text: validated.error }],
							details: { action: 'update', error: validated.error } as any,
						};
					}
					const filePath = getTodoPath(todosDir, validated.id);
					if (!existsSync(filePath)) {
						return {
							content: [
								{
									type: 'text',
									text: `Todo ${formatTodoId(validated.id)} not found`,
								},
							],
							details: { action: 'update', error: 'not found' } as any,
						};
					}
					const result = await withTodoLock(todosDir, validated.id, ctx, async () => {
						const existing = await ensureTodoExists(filePath, validated.id);
						if (!existing)
							return {
								error: `Todo ${formatTodoId(validated.id)} not found`,
							} as const;
						if (params.title !== undefined) existing.title = params.title;
						if (params.status !== undefined) existing.status = params.status;
						if (params.tags !== undefined) existing.tags = params.tags;
						if (params.body !== undefined) existing.body = params.body;
						if (!existing.created_at) existing.created_at = new Date().toISOString();
						clearAssignmentIfClosed(existing);
						await writeTodoFile(filePath, existing);
						return existing;
					});

					if (typeof result === 'object' && 'error' in result) {
						return {
							content: [{ type: 'text', text: result.error }],
							details: { action: 'update', error: result.error } as any,
						};
					}
					return {
						content: [
							{ type: 'text', text: serializeTodoForAgent(result as TodoRecord) },
						],
						details: {
							action: 'update',
							todo: result as TodoRecord,
						} as TodoToolDetails,
					};
				}

				case 'append': {
					if (!params.id) {
						return {
							content: [{ type: 'text', text: 'Error: id required' }],
							details: { action: 'append', error: 'id required' } as any,
						};
					}
					const validated = validateTodoId(params.id);
					if ('error' in validated) {
						return {
							content: [{ type: 'text', text: validated.error }],
							details: { action: 'append', error: validated.error } as any,
						};
					}
					const filePath = getTodoPath(todosDir, validated.id);
					if (!existsSync(filePath)) {
						return {
							content: [
								{
									type: 'text',
									text: `Todo ${formatTodoId(validated.id)} not found`,
								},
							],
							details: { action: 'append', error: 'not found' } as any,
						};
					}
					const result = await withTodoLock(todosDir, validated.id, ctx, async () => {
						const existing = await ensureTodoExists(filePath, validated.id);
						if (!existing)
							return {
								error: `Todo ${formatTodoId(validated.id)} not found`,
							} as const;
						if (!params.body || !params.body.trim()) return existing;
						return appendTodoBody(filePath, existing, params.body);
					});

					if (typeof result === 'object' && 'error' in result) {
						return {
							content: [{ type: 'text', text: result.error }],
							details: { action: 'append', error: result.error } as any,
						};
					}
					return {
						content: [
							{ type: 'text', text: serializeTodoForAgent(result as TodoRecord) },
						],
						details: {
							action: 'append',
							todo: result as TodoRecord,
						} as TodoToolDetails,
					};
				}

				case 'claim': {
					if (!params.id) {
						return {
							content: [{ type: 'text', text: 'Error: id required' }],
							details: { action: 'claim', error: 'id required' } as any,
						};
					}
					const result = await claimTodoAssignment(
						todosDir,
						params.id,
						ctx,
						Boolean(params.force),
					);
					if (typeof result === 'object' && 'error' in result) {
						return {
							content: [{ type: 'text', text: result.error }],
							details: { action: 'claim', error: result.error } as any,
						};
					}
					return {
						content: [
							{ type: 'text', text: serializeTodoForAgent(result as TodoRecord) },
						],
						details: { action: 'claim', todo: result as TodoRecord } as TodoToolDetails,
					};
				}

				case 'release': {
					if (!params.id) {
						return {
							content: [{ type: 'text', text: 'Error: id required' }],
							details: { action: 'release', error: 'id required' } as any,
						};
					}
					const result = await releaseTodoAssignment(
						todosDir,
						params.id,
						ctx,
						Boolean(params.force),
					);
					if (typeof result === 'object' && 'error' in result) {
						return {
							content: [{ type: 'text', text: result.error }],
							details: { action: 'release', error: result.error } as any,
						};
					}
					return {
						content: [
							{ type: 'text', text: serializeTodoForAgent(result as TodoRecord) },
						],
						details: {
							action: 'release',
							todo: result as TodoRecord,
						} as TodoToolDetails,
					};
				}

				case 'delete': {
					if (!params.id) {
						return {
							content: [{ type: 'text', text: 'Error: id required' }],
							details: { action: 'delete', error: 'id required' } as any,
						};
					}
					const validated = validateTodoId(params.id);
					if ('error' in validated) {
						return {
							content: [{ type: 'text', text: validated.error }],
							details: { action: 'delete', error: validated.error } as any,
						};
					}
					const result = await deleteTodo(todosDir, validated.id, ctx);
					if (typeof result === 'object' && 'error' in result) {
						return {
							content: [{ type: 'text', text: result.error }],
							details: { action: 'delete', error: result.error } as any,
						};
					}
					return {
						content: [
							{ type: 'text', text: serializeTodoForAgent(result as TodoRecord) },
						],
						details: {
							action: 'delete',
							todo: result as TodoRecord,
						} as TodoToolDetails,
					};
				}
			}
		},

		renderCall(args: any, theme: Theme) {
			const action = typeof args.action === 'string' ? args.action : '';
			const id = typeof args.id === 'string' ? args.id : '';
			const normalizedId = id ? normalizeTodoId(id) : '';
			const title = typeof args.title === 'string' ? args.title : '';
			let text = theme.fg('toolTitle', theme.bold('todo ')) + theme.fg('muted', action);
			if (normalizedId) {
				text += ' ' + theme.fg('accent', formatTodoId(normalizedId));
			}
			if (title) {
				text += ' ' + theme.fg('dim', `"${title}"`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result: any, { expanded, isPartial }: any, theme: Theme) {
			const details = result.details as TodoToolDetails | undefined;
			if (isPartial) {
				return new Text(theme.fg('warning', 'Processing...'), 0, 0);
			}
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === 'text' ? text.text : '', 0, 0);
			}

			if (details.error) {
				return new Text(theme.fg('error', `Error: ${details.error}`), 0, 0);
			}

			if (details.action === 'list' || details.action === 'list-all') {
				const todos = (details as any).todos as TodoFrontMatter[] | undefined;
				const currentSessionId = (details as any).currentSessionId as string | undefined;
				if (!todos) {
					return new Text('', 0, 0);
				}
				const text = renderTodoList(theme, todos, expanded, currentSessionId);
				return new Text(text, 0, 0);
			}

			if (!('todo' in details) || !details.todo) {
				return new Text('', 0, 0);
			}

			const todo = details.todo;
			const todoText = renderTodoDetail(theme, todo, expanded);
			const actionLabel =
				details.action === 'create'
					? 'Created'
					: details.action === 'update'
						? 'Updated'
						: details.action === 'append'
							? 'Appended to'
							: details.action === 'delete'
								? 'Deleted'
								: details.action === 'claim'
									? 'Claimed'
									: details.action === 'release'
										? 'Released'
										: null;
			let finalText = todoText;
			if (actionLabel) {
				const lines = finalText.split('\n');
				lines[0] =
					theme.fg('success', '✓ ') + theme.fg('muted', `${actionLabel} `) + lines[0];
				finalText = lines.join('\n');
			}
			if (!expanded) {
				finalText = appendExpandHint(theme, finalText);
			}
			return new Text(finalText, 0, 0);
		},
	} as any);

	log.debug('tool registered');
}

function renderTodoList(
	theme: Theme,
	todos: TodoFrontMatter[],
	expanded: boolean,
	currentSessionId?: string,
): string {
	if (!todos.length) return theme.fg('dim', 'No todos');

	const { assignedTodos, openTodos, closedTodos } = splitTodosByAssignment(todos);
	const lines: string[] = [];
	const pushSection = (label: string, sectionTodos: TodoFrontMatter[]) => {
		lines.push(theme.fg('muted', `${label} (${sectionTodos.length})`));
		if (!sectionTodos.length) {
			lines.push(theme.fg('dim', '  none'));
			return;
		}
		const maxItems = expanded ? sectionTodos.length : Math.min(sectionTodos.length, 3);
		for (let i = 0; i < maxItems; i++) {
			lines.push(`  ${renderTodoHeading(theme, sectionTodos[i], currentSessionId)}`);
		}
		if (!expanded && sectionTodos.length > maxItems) {
			lines.push(theme.fg('dim', `  ... ${sectionTodos.length - maxItems} more`));
		}
	};

	const sections: Array<{ label: string; todos: TodoFrontMatter[] }> = [
		{ label: 'Assigned todos', todos: assignedTodos },
		{ label: 'Open todos', todos: openTodos },
		{ label: 'Closed todos', todos: closedTodos },
	];

	sections.forEach((section, index) => {
		if (index > 0) lines.push('');
		pushSection(section.label, section.todos);
	});

	return lines.join('\n');
}

function renderTodoHeading(theme: Theme, todo: TodoFrontMatter, currentSessionId?: string): string {
	const closed = isTodoClosed(getTodoStatus(todo));
	const titleColor = closed ? 'dim' : 'text';
	const tagText = todo.tags.length ? theme.fg('dim', ` [${todo.tags.join(', ')}]`) : '';
	const assignmentText = renderAssignmentSuffix(theme, todo, currentSessionId);
	return (
		theme.fg('accent', formatTodoId(todo.id)) +
		' ' +
		theme.fg(titleColor, getTodoTitle(todo)) +
		tagText +
		assignmentText
	);
}

function renderTodoDetail(theme: Theme, todo: TodoRecord, expanded: boolean): string {
	const summary = renderTodoHeading(theme, todo);
	if (!expanded) return summary;

	const tags = todo.tags.length ? todo.tags.join(', ') : 'none';
	const createdAt = todo.created_at || 'unknown';
	const bodyText = todo.body?.trim() ? todo.body.trim() : 'No details yet.';
	const bodyLines = bodyText.split('\n');

	const lines = [
		summary,
		theme.fg('muted', `Status: ${getTodoStatus(todo)}`),
		theme.fg('muted', `Tags: ${tags}`),
		theme.fg('muted', `Created: ${createdAt}`),
		'',
		theme.fg('muted', 'Body:'),
		...bodyLines.map((line) => theme.fg('text', `  ${line}`)),
	];

	return lines.join('\n');
}

function appendExpandHint(theme: Theme, text: string): string {
	return `${text}\n${theme.fg('dim', `(${keyHint('app.tools.expand', 'to expand')})`)}`;
}
