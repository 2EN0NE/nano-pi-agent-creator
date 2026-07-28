/**
 * Todo extension -- file-based todo management with TUI panel, widget, and tool support.
 */
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createLogger } from '@zenone/pi-logger';
import {
	getTodosDir,
	getGlobalTodosDir,
	listAllTodos,
	ensureTodosDir,
	garbageCollectTodos,
	readTodoSettings,
	formatTodoList,
} from './storage.js';
import { getConfig } from './config.js';
import { truncateToWidth } from '@earendil-works/pi-tui';
import { buildWidgetContent } from './widget.js';
import { buildCompletionReminder } from './completion-detector.js';
import { registerTool } from './tool-registration.js';
import { TodoPanel } from './ui/panel.js';

const log = createLogger('todos');

const TUI_PANEL_WIDGET_KEY = 'todos';

export default function todosExtension(pi: ExtensionAPI) {
	// ── Lifecycle ──────────────────────────────────────

	pi.on('session_start', async (_event, ctx) => {
		const cwd = ctx.cwd;
		const todosDir = getTodosDir(cwd);
		await ensureTodosDir(todosDir);
		const settings = await readTodoSettings(todosDir, cwd);
		await garbageCollectTodos(todosDir, settings);
		updateWidget(ctx);

		const globalDir = getGlobalTodosDir();
		if (globalDir && globalDir !== getTodosDir(cwd)) {
			await ensureTodosDir(globalDir);
		}
	});

	pi.on('session_tree', async (_event, ctx) => {
		updateWidget(ctx);
	});

	// ── Tool registration ─────────────────────────────

	registerTool(pi);

	// ── Widget update helper ──────────────────────────

	async function updateWidget(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		const cfg = getConfig();
		if (!cfg.widgetShow) {
			ctx.ui.setWidget(TUI_PANEL_WIDGET_KEY, undefined);
			return;
		}
		const allTodos = await listAllTodos(ctx.cwd);
		const currentSessionId = ctx.sessionManager.getSessionId();

		// 当 scope 为 session 且没有分配给当前 session 的 todo 时，隐藏 widget
		if (cfg.widgetScope === 'session') {
			const sessionTodos = currentSessionId
				? allTodos.filter((t) => t.assigned_to_session === currentSessionId)
				: allTodos.filter((t) => t.assigned_to_session);
			if (sessionTodos.length === 0) {
				ctx.ui.setWidget(TUI_PANEL_WIDGET_KEY, undefined);
				return;
			}
		}

		ctx.ui.setWidget(TUI_PANEL_WIDGET_KEY, (_tui, theme) => {
			const lines = buildWidgetContent(allTodos, theme, currentSessionId);
			return {
				render: (width: number) => lines.map((l) => truncateToWidth(l, width)),
				invalidate: () => {},
			};
		});
	}

	// ── Turn-end completion detection (passive) ────────

	pi.on('turn_end', async (event, ctx) => {
		updateWidget(ctx);
		// Defensive: extract text content from turn_end event message
		const msg =
			event && typeof event === 'object' && 'message' in event
				? (event as unknown as Record<string, unknown>).message
				: undefined;
		const response =
			msg && typeof msg === 'object' && msg !== null && 'content' in msg
				? typeof (msg as Record<string, unknown>).content === 'string'
					? (msg as Record<string, string>).content
					: ''
				: '';
		if (!response) return;

		const allTodos = await listAllTodos(ctx.cwd);
		const reminder = buildCompletionReminder(
			response,
			allTodos.map((t: any) => ({ id: t.id, title: t.title, status: t.status })),
		);
		if (reminder) {
			log.info('completion hint generated: %s', reminder.substring(0, 100));
		}
	});

	// ── /todos command ────────────────────────────────

	pi.registerCommand('todos', {
		description: 'Manage todos - interactive panel with Session/Project/Global/Settings tabs',
		handler: async (args, ctx) => {
			const cwd = ctx.cwd;
			const allTodos = await listAllTodos(cwd);
			const currentSessionId = ctx.sessionManager.getSessionId();
			const searchTerm = ((args as string) ?? '').trim();

			if (!ctx.hasUI) {
				log.info(formatTodoList(allTodos));
				return;
			}

			let nextPrompt: string | null = null;

			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				const filteredTodos = searchTerm
					? allTodos.filter(
							(t) =>
								t.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
								t.id.toLowerCase().includes(searchTerm.toLowerCase()),
						)
					: allTodos;

				return new TodoPanel(
					theme,
					ctx,
					tui,
					{
						onWorkOnTodo: (todoId, title) => {
							nextPrompt = `work on todo TODO-${todoId} "${title}"`;
							done();
						},
						onRefineTodo: async (todoId, title) => {
							const { buildRefinePrompt } = await import('./storage.js');
							nextPrompt = buildRefinePrompt(todoId, title);
							done();
						},
						onClose: () => done(),
						onConfigChanged: () => updateWidget(ctx),
					},
					filteredTodos,
					currentSessionId,
				);
			});

			if (nextPrompt) {
				ctx.ui.setEditorText(nextPrompt);
			}
		},
	});
}
