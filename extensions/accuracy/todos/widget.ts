import type { Theme } from '@earendil-works/pi-coding-agent';
import { getConfig } from './config.js';
import type { TodoFrontMatter } from './types.js';

/**
 * Build widget content lines for a set of todos.
 * Respects current config: show/hide, scope filter, pending-only, summary/details.
 */
export function buildWidgetContent(
	todos: TodoFrontMatter[],
	theme: Theme,
	currentSessionId?: string,
): string[] {
	const cfg = getConfig();
	if (!cfg.widgetShow) return [];

	// Filter based on scope
	let scoped = todos;
	if (cfg.widgetScope === 'session' && currentSessionId) {
		scoped = todos.filter((t) => t.assigned_to_session === currentSessionId);
	} else if (cfg.widgetScope === 'session' && !currentSessionId) {
		// No session id — fall back to assigned or project
		scoped = todos.filter((t) => t.assigned_to_session);
	}

	// Apply pending filter
	if (cfg.widgetFilter === 'pending-only') {
		scoped = scoped.filter((t) => !['closed', 'done'].includes(t.status.toLowerCase()));
	}

	if (scoped.length === 0) {
		return [theme.fg('dim', '[Todos] none')];
	}

	if (cfg.widgetDisplay === 'details') {
		return buildDetailLines(scoped, theme, currentSessionId);
	}

	return buildSummaryLines(scoped, theme);
}

function buildSummaryLines(todos: TodoFrontMatter[], theme: Theme): string[] {
	const open = todos.filter((t) => !['closed', 'done'].includes(t.status.toLowerCase()));
	const closed = todos.length - open.length;

	const pending = open.filter((t) => !t.assigned_to_session);
	const assigned = open.filter((t) => t.assigned_to_session);

	const title = theme.fg('accent', theme.bold('Todos'));
	const counts = [
		assigned.length ? theme.fg('success', `${assigned.length} in progress`) : '',
		pending.length ? theme.fg('text', `${pending.length} pending`) : '',
		closed ? theme.fg('dim', `${closed} closed`) : '',
	]
		.filter(Boolean)
		.join(theme.fg('dim', ' | '));

	const lines = [`${title}  ${theme.fg('dim', '(')}${counts}${theme.fg('dim', ')')}`];

	// Show up to 3 most relevant items
	const showItems = open.slice(0, 3);
	for (const t of showItems) {
		const prefix = t.assigned_to_session ? theme.fg('success', '*') : theme.fg('dim', '-');
		const titleColor = t.assigned_to_session ? 'success' : 'text';
		lines.push(
			`${prefix} ${theme.fg('accent', `TODO-${t.id}`)} ${theme.fg(titleColor, t.title || '(untitled)')}`,
		);
	}

	if (open.length > 3) {
		lines.push(theme.fg('dim', `  ... ${open.length - 3} more`));
	}

	lines.push(theme.fg('dim', '  For details, run /todos'));

	return lines;
}

function buildDetailLines(
	todos: TodoFrontMatter[],
	theme: Theme,
	currentSessionId?: string,
): string[] {
	const lines: string[] = [];
	const title = theme.fg('accent', theme.bold('Todos'));
	lines.push(title);

	const maxItems = 6;
	const shown = todos.slice(0, maxItems);

	for (const t of shown) {
		const closed = ['closed', 'done'].includes(t.status.toLowerCase());
		const prefix = closed ? theme.fg('dim', 'x') : theme.fg('accent', '-');
		const titleColor = closed ? 'dim' : 'text';
		const statusSuffix = closed
			? theme.fg('dim', ' (closed)')
			: t.assigned_to_session
				? theme.fg('success', ' (in progress)')
				: '';
		lines.push(
			`${prefix} ${theme.fg('accent', `TODO-${t.id}`)} ${theme.fg(titleColor, t.title || '(untitled)')}${statusSuffix}`,
		);
	}

	if (todos.length > maxItems) {
		lines.push(theme.fg('dim', `  ... ${todos.length - maxItems} more`));
	}

	lines.push(theme.fg('dim', '  For details, run /todos'));

	return lines;
}
