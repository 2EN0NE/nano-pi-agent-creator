import type { Theme } from '@earendil-works/pi-coding-agent';
import { getConfig } from './config.js';
import type { TodoFrontMatter, TodoPluginConfig } from './types.js';
import { isTodoDone, isTodoClosed } from './storage.js';

/**
 * Build widget content lines for a set of todos.
 * Fixed behavior: always shows open + done, never shows close (soft-deleted).
 * Supports scope filtering and summary/details display modes.
 *
 * @param todos The list of todos to display
 * @param theme Theme for styling
 * @param currentSessionId Optional session ID for scope filtering
 * @param configOverride Optional config override (for testing)
 */
export function buildWidgetContent(
	todos: TodoFrontMatter[],
	theme: Theme,
	currentSessionId?: string,
	configOverride?: Partial<TodoPluginConfig>,
): string[] {
	const cfg = configOverride ? { ...getConfig(), ...configOverride } : getConfig();
	if (!cfg.widgetShow) return [];

	// Filter based on scope
	let scoped = todos;
	if (cfg.widgetScope === 'session' && currentSessionId) {
		scoped = todos.filter((t) => t.assigned_to_session === currentSessionId);
	} else if (cfg.widgetScope === 'session' && !currentSessionId) {
		// No session id — fall back to assigned or project
		scoped = todos.filter((t) => t.assigned_to_session);
	}

	// Always filter out close (soft-deleted) items
	scoped = scoped.filter((t) => !isTodoClosed(t.status));

	if (scoped.length === 0) {
		return [theme.fg('text', '|Todos: none')];
	}

	if (cfg.widgetDisplay === 'details') {
		return buildDetailLines(scoped, theme);
	}

	return buildSummaryLines(scoped, theme);
}

function buildSummaryLines(todos: TodoFrontMatter[], theme: Theme): string[] {
	const done = todos.filter((t) => isTodoDone(t.status));
	const open = todos.filter((t) => !isTodoDone(t.status));

	const pending = open.filter((t) => !t.assigned_to_session);
	const assigned = open.filter((t) => t.assigned_to_session);

	const title = theme.fg('accent', theme.bold('Todos'));
	const counts = [
		assigned.length ? theme.fg('success', `${assigned.length} in progress`) : '',
		pending.length ? theme.fg('text', `${pending.length} pending`) : '',
		done.length ? theme.fg('dim', `${done.length} done`) : '',
	]
		.filter(Boolean)
		.join(theme.fg('dim', ' | '));

	const lines = [`${title}  ${theme.fg('dim', '(')}${counts}${theme.fg('dim', ')')}`];

	// Show up to 3 most relevant items (open first, then done)
	const showItems = [...open, ...done].slice(0, 3);
	for (const t of showItems) {
		const isDone = isTodoDone(t.status);
		const checkbox = isDone ? '[x]' : '[ ]';
		const suffix = t.assigned_to_session ? ' (in progress)' : '';
		lines.push(
			theme.fg(
				isDone ? 'dim' : 'accent',
				`${checkbox} ${t.id} ${t.status || 'open'} ${t.title || '(untitled)'}${suffix}`,
			),
		);
	}

	const remaining = open.length + done.length - 3;
	if (remaining > 0) {
		lines.push(theme.fg('dim', `  ... ${remaining} more`));
	}

	lines.push(theme.fg('dim', '  For details, run /todos'));

	return lines;
}

function buildDetailLines(todos: TodoFrontMatter[], theme: Theme): string[] {
	const lines: string[] = [];
	const title = theme.fg('accent', theme.bold('Todos'));
	lines.push(title);

	const maxItems = 6;
	const shown = todos.slice(0, maxItems);

	for (const t of shown) {
		const done = isTodoDone(t.status);
		const checkbox = done ? '[x]' : '[ ]';
		const suffix = done ? ' (done)' : t.assigned_to_session ? ' (in progress)' : '';
		const text = `${checkbox} ${t.id} ${t.status || 'open'} ${t.title || '(untitled)'}${suffix}`;
		lines.push(theme.fg(done ? 'dim' : 'accent', text));
	}

	if (todos.length > maxItems) {
		lines.push(theme.fg('dim', `  ... ${todos.length - maxItems} more`));
	}

	lines.push(theme.fg('dim', '  For details, run /todos'));

	return lines;
}
