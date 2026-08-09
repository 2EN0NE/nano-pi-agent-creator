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
import type { TodoFrontMatter } from './types.js';
import { buildWidgetContent } from './widget.js';
import { buildCompletionReminder, extractLastAssistantText } from './completion-detector.js';
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
		const allTodos = await listAllTodos(ctx.cwd);
		renderWidget(ctx, allTodos);
	}

	function updateWidgetWithTodos(ctx: ExtensionContext, allTodos: TodoFrontMatter[]) {
		if (!ctx.hasUI) return;
		renderWidget(ctx, allTodos);
	}

	function renderWidget(ctx: ExtensionContext, allTodos: TodoFrontMatter[]) {
		const cfg = getConfig();
		if (!cfg.widgetShow) {
			ctx.ui.setWidget(TUI_PANEL_WIDGET_KEY, undefined);
			return;
		}
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

	// ── Agent-end completion detection (passive) ───────
	// Cache the last assistant text on agent_end, then check on agent_settled
	// (agent_settled is the only event that guarantees the agent is truly idle,
	//  unlike agent_end which may fire mid tool-calling loop).

	let completionReminderSent = false;
	let sessionShuttingDown = false;
	let lastAssistantText: string | null = null;

	pi.on('agent_start', () => {
		completionReminderSent = false;
		lastAssistantText = null;
	});

	pi.on('session_shutdown', () => {
		sessionShuttingDown = true;
	});

	// Cache the last assistant response text from agent_end for use in agent_settled
	pi.on('agent_end', async (event, ctx) => {
		// Update widget with current todos
		const allTodos = await listAllTodos(ctx.cwd);
		updateWidgetWithTodos(ctx, allTodos);

		if (completionReminderSent || sessionShuttingDown) return;

		const response = extractLastAssistantText(
			(event as unknown as { messages?: Array<{ role?: string; content?: unknown }> })
				.messages ?? [],
		);
		if (response) lastAssistantText = response;
	});

	// On agent_settled (truly idle), check if completion reminder should be sent
	pi.on('agent_settled', async (_event, ctx) => {
		if (completionReminderSent || sessionShuttingDown || !lastAssistantText) return;

		const allTodos = await listAllTodos(ctx.cwd);
		const reminder = buildCompletionReminder(
			lastAssistantText,
			allTodos.map((t: any) => ({ id: t.id, title: t.title, status: t.status })),
		);
		if (reminder) {
			completionReminderSent = true;
			log.info('completion hint sent: %s', reminder.substring(0, 100));
			await pi.sendUserMessage(reminder, { deliverAs: 'followUp' });
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
						onDataChanged: () => updateWidget(ctx),
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
