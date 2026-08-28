import {
	buildSessionContext,
	createAgentSession,
	createExtensionRuntime,
	getMarkdownTheme,
	SessionManager,
	type AgentSession,
	type AgentSessionEvent,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ResourceLoader,
} from '@earendil-works/pi-coding-agent';
import {
	type AssistantMessage,
	type Message,
	type ThinkingLevel as AiThinkingLevel,
} from '@earendil-works/pi-ai/compat';
import {
	Container,
	Input,
	Markdown,
	truncateToWidth,
	type Focusable,
	type KeybindingsManager,
	type OverlayHandle,
	type TUI,
} from '@earendil-works/pi-tui';
import { bottomBorder, topBorder } from '../../src/tui/helpers.js';
import { selectPanel } from '../../src/tui/select-panel.js';

const BTW_ENTRY_TYPE = 'btw-thread-entry';
const BTW_RESET_TYPE = 'btw-thread-reset';

const BTW_SYSTEM_PROMPT = [
	'你是 BTW，一个嵌入用户编码 agent 的侧通道助手。',
	'你可以访问主对话上下文 — 用它给出有依据的回答。',
	'帮助回答聚焦问题、做规划、快速探索。',
	'直接而务实。',
].join(' ');

const BTW_SUMMARY_PROMPT =
	'摘要本次侧对话以便交接给主对话。保留关键决策、发现、风险和后续行动。只输出摘要。';

type SessionThinkingLevel = 'off' | AiThinkingLevel;

type BtwDetails = {
	question: string;
	answer: string;
	timestamp: number;
	provider: string;
	model: string;
	thinkingLevel: SessionThinkingLevel;
	usage?: AssistantMessage['usage'];
};

type BtwResetDetails = {
	timestamp: number;
};

type OverlayRuntime = {
	handle?: OverlayHandle;
	refresh?: () => void;
	close?: () => void;
	finish?: () => void;
	setDraft?: (value: string) => void;
	closed?: boolean;
};

type SideSessionRuntime = {
	session: AgentSession;
	modelKey: string;
	unsubscribe: () => void;
};

type ToolCallInfo = {
	toolCallId: string;
	toolName: string;
	args: string;
	status: 'running' | 'done' | 'error';
};

function stripDynamicSystemPromptFooter(systemPrompt: string): string {
	return systemPrompt
		.replace(/\nCurrent date and time:[^\n]*(?:\nCurrent working directory:[^\n]*)?$/u, '')
		.replace(/\nCurrent working directory:[^\n]*$/u, '')
		.trim();
}

function createBtwResourceLoader(
	ctx: ExtensionContext,
	appendSystemPrompt: string[] = [BTW_SYSTEM_PROMPT],
): ResourceLoader {
	const extensionsResult = {
		extensions: [],
		errors: [],
		runtime: createExtensionRuntime(),
	};
	const systemPrompt = stripDynamicSystemPromptFooter(ctx.getSystemPrompt());

	return {
		getExtensions: () => extensionsResult,
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => appendSystemPrompt,
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

function extractText(parts: AssistantMessage['content']): string {
	return parts
		.filter((part) => part.type === 'text')
		.map((part) => part.text)
		.join('\n')
		.trim();
}

function extractEventAssistantText(message: unknown): string {
	if (!message || typeof message !== 'object') {
		return '';
	}

	const maybeMessage = message as { role?: unknown; content?: unknown };
	if (maybeMessage.role !== 'assistant' || !Array.isArray(maybeMessage.content)) {
		return '';
	}

	return maybeMessage.content
		.filter((part): part is { type: 'text'; text: string } => {
			return (
				!!part && typeof part === 'object' && (part as { type?: unknown }).type === 'text'
			);
		})
		.map((part) => part.text)
		.join('\n')
		.trim();
}

function getLastAssistantMessage(session: AgentSession): AssistantMessage | null {
	for (let i = session.state.messages.length - 1; i >= 0; i--) {
		const message = session.state.messages[i];
		if (message.role === 'assistant') {
			return message as AssistantMessage;
		}
	}

	return null;
}

function buildSeedMessages(ctx: ExtensionContext, thread: BtwDetails[]): Message[] {
	const seed: Message[] = [];

	try {
		const contextMessages = buildSessionContext(
			ctx.sessionManager.getEntries(),
			ctx.sessionManager.getLeafId(),
		).messages;
		seed.push(...(contextMessages.filter((message) => 'role' in message) as Message[]));
	} catch {
		// Ignore context seed failures and continue with an empty side thread.
	}

	for (const item of thread) {
		seed.push(
			{
				role: 'user',
				content: [{ type: 'text', text: item.question }],
				timestamp: item.timestamp,
			},
			{
				role: 'assistant',
				content: [{ type: 'text', text: item.answer }],
				provider: item.provider,
				model: item.model,
				api: ctx.model?.api ?? 'openai-responses',
				usage: item.usage ?? {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: 'stop',
				timestamp: item.timestamp,
			},
		);
	}

	return seed;
}

function formatThread(thread: BtwDetails[]): string {
	return thread
		.map((item) => `User: ${item.question.trim()}\nAssistant: ${item.answer.trim()}`)
		.join('\n\n---\n\n');
}

function notify(
	ctx: ExtensionContext | ExtensionCommandContext,
	message: string,
	level: 'info' | 'warning' | 'error',
): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, level);
	}
}

export class BtwOverlay extends Container implements Focusable {
	private readonly input: Input;
	private readonly tui: TUI;
	private readonly theme: ExtensionContext['ui']['theme'];
	private readonly keybindings: KeybindingsManager;
	private readonly getTranscript: (
		width: number,
		theme: ExtensionContext['ui']['theme'],
	) => string[];
	private readonly getStatus: () => string;
	private readonly onSubmitCallback: (value: string) => void;
	private readonly onDismissCallback: () => void;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(
		tui: TUI,
		theme: ExtensionContext['ui']['theme'],
		keybindings: KeybindingsManager,
		getTranscript: (width: number, theme: ExtensionContext['ui']['theme']) => string[],
		getStatus: () => string,
		onSubmit: (value: string) => void,
		onDismiss: () => void,
	) {
		super();
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.getTranscript = getTranscript;
		this.getStatus = getStatus;
		this.onSubmitCallback = onSubmit;
		this.onDismissCallback = onDismiss;

		this.input = new Input();
		this.input.onSubmit = (value) => {
			this.onSubmitCallback(value);
		};
		this.input.onEscape = () => {
			this.onDismissCallback();
		};
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, 'tui.select.cancel')) {
			this.onDismissCallback();
			return;
		}

		this.input.handleInput(data);
	}

	setDraft(value: string): void {
		this.input.setValue(value);
		this.tui.requestRender();
	}

	getDraft(): string {
		return this.input.getValue();
	}

	private frameLine(content: string, innerWidth: number): string {
		// 纯横线范式（ADR-0023）：无竖线，2 空格缩进 + truncate 兜底（与边框同宽）
		return '  ' + truncateToWidth(content, innerWidth, '');
	}

	private borderLine(innerWidth: number, edge: 'top' | 'bottom'): string {
		if (edge === 'top') {
			return this.theme.fg('borderMuted', topBorder('── btw ', innerWidth + 2));
		}
		return this.theme.fg('borderMuted', bottomBorder(innerWidth + 2));
	}

	override render(width: number): string[] {
		const dialogWidth = Math.max(56, Math.min(width, Math.floor(width * 0.9)));
		const innerWidth = Math.max(40, dialogWidth - 2);
		const terminalRows = process.stdout.rows ?? 30;
		const dialogHeight = Math.max(16, Math.min(30, Math.floor(terminalRows * 0.75)));
		const chromeHeight = 7;
		const transcriptHeight = Math.max(6, dialogHeight - chromeHeight);

		// Markdown renders to innerWidth already — no manual wrapping needed
		const transcript = this.getTranscript(innerWidth, this.theme);
		const visibleTranscript = transcript.slice(-transcriptHeight);
		const transcriptPadding = Math.max(0, transcriptHeight - visibleTranscript.length);

		const status = this.getStatus();

		const previousFocused = this.input.focused;
		this.input.focused = false;
		const inputLine = this.input.render(innerWidth)[0] ?? '';
		this.input.focused = previousFocused;

		const lines = [
			this.borderLine(innerWidth, 'top'),
			this.frameLine(this.theme.fg('accent', this.theme.bold(' BTW side chat ')), innerWidth),
			this.frameLine(this.theme.fg('dim', '独立的侧边对话。Esc 关闭。'), innerWidth),
			this.theme.fg('borderMuted', ' ' + bottomBorder(innerWidth) + ' '),
		];

		for (const line of visibleTranscript) {
			lines.push(this.frameLine(line, innerWidth));
		}
		for (let i = 0; i < transcriptPadding; i++) {
			lines.push(this.frameLine('', innerWidth));
		}

		lines.push(this.theme.fg('borderMuted', ' ' + bottomBorder(innerWidth) + ' '));
		lines.push(this.frameLine(this.theme.fg('warning', status), innerWidth));
		lines.push(inputLine);
		lines.push(this.frameLine(this.theme.fg('dim', 'Enter 发送 · Esc 关闭'), innerWidth));
		lines.push(this.borderLine(innerWidth, 'bottom'));

		return lines;
	}
}

export default function (pi: ExtensionAPI) {
	let thread: BtwDetails[] = [];
	let pendingQuestion: string | null = null;
	let pendingAnswer = '';
	let pendingError: string | null = null;
	let pendingToolCalls: ToolCallInfo[] = [];
	let sideBusy = false;
	let overlayStatus = '就绪';
	let overlayDraft = '';
	let overlayRuntime: OverlayRuntime | null = null;
	let activeSideSession: SideSessionRuntime | null = null;
	let overlayRefreshTimer: ReturnType<typeof setTimeout> | null = null;

	const mdTheme = getMarkdownTheme();

	function getModelKey(ctx: ExtensionContext): string {
		const model = ctx.model;
		return model ? `${model.provider}/${model.id}` : 'none';
	}

	function renderMarkdownLines(text: string, width: number): string[] {
		if (!text) return [];
		try {
			const md = new Markdown(text, 0, 0, mdTheme);
			return md.render(width);
		} catch {
			// Fall back to plain text wrapping if Markdown rendering fails
			return text.split('\n').flatMap((line) => {
				if (!line) return [''];
				const wrapped: string[] = [];
				for (let i = 0; i < line.length; i += width) {
					wrapped.push(line.slice(i, i + width));
				}
				return wrapped.length > 0 ? wrapped : [''];
			});
		}
	}

	function formatToolArgs(toolName: string, args: unknown): string {
		if (!args || typeof args !== 'object') return '';
		const a = args as Record<string, unknown>;
		switch (toolName) {
			case 'bash':
				return typeof a.command === 'string'
					? truncateToWidth(a.command.split('\n')[0], 50, '…')
					: '';
			case 'read':
			case 'write':
			case 'edit':
				return typeof a.path === 'string' ? a.path : '';
			default: {
				const first = Object.values(a)[0];
				return typeof first === 'string'
					? truncateToWidth(first.split('\n')[0], 40, '…')
					: '';
			}
		}
	}

	function renderToolCallLines(
		toolCalls: ToolCallInfo[],
		theme: ExtensionContext['ui']['theme'],
		width: number,
	): string[] {
		const lines: string[] = [];
		for (const tc of toolCalls) {
			const icon = tc.status === 'running' ? '..' : tc.status === 'error' ? '失败' : '成功';
			const color =
				tc.status === 'error' ? 'error' : tc.status === 'done' ? 'success' : 'dim';
			const label = theme.fg(color, `${icon} `) + theme.fg('toolTitle', tc.toolName);
			const argsText = tc.args ? theme.fg('dim', ` ${tc.args}`) : '';
			lines.push(truncateToWidth(`  ${label}${argsText}`, width, ''));
		}
		return lines;
	}

	function getTranscriptLines(width: number, theme: ExtensionContext['ui']['theme']): string[] {
		try {
			return getTranscriptLinesInner(width, theme);
		} catch (error) {
			return [
				theme.fg(
					'error',
					`Render error: ${error instanceof Error ? error.message : String(error)}`,
				),
			];
		}
	}

	function getTranscriptLinesInner(
		width: number,
		theme: ExtensionContext['ui']['theme'],
	): string[] {
		if (thread.length === 0 && !pendingQuestion && !pendingAnswer && !pendingError) {
			return [theme.fg('dim', '还没有 BTW 消息。请在下方输入问题。')];
		}

		const lines: string[] = [];
		for (const item of thread.slice(-6)) {
			// User message
			const userText = item.question.trim().split('\n')[0];
			lines.push(
				theme.fg('accent', theme.bold('You: ')) + truncateToWidth(userText, width - 5, '…'),
			);
			lines.push('');

			// Assistant message rendered as markdown
			const mdLines = renderMarkdownLines(item.answer, width);
			lines.push(...mdLines);
			lines.push('');
		}

		if (pendingQuestion) {
			const userText = pendingQuestion.trim().split('\n')[0];
			lines.push(
				theme.fg('accent', theme.bold('You: ')) + truncateToWidth(userText, width - 5, '…'),
			);

			// Show tool calls inline
			if (pendingToolCalls.length > 0) {
				lines.push(...renderToolCallLines(pendingToolCalls, theme, width));
			}

			if (pendingError) {
				lines.push(theme.fg('error', `[ERROR] ${pendingError}`));
			} else if (pendingAnswer) {
				lines.push('');
				const mdLines = renderMarkdownLines(pendingAnswer, width);
				lines.push(...mdLines);
			} else if (pendingToolCalls.length === 0) {
				lines.push(theme.fg('dim', '…'));
			}
		}

		// Trim trailing empty line
		while (lines.length > 0 && lines[lines.length - 1] === '') {
			lines.pop();
		}
		return lines;
	}

	function syncOverlay(): void {
		overlayRuntime?.refresh?.();
	}

	function scheduleOverlayRefresh(): void {
		if (overlayRefreshTimer) {
			return;
		}

		overlayRefreshTimer = setTimeout(() => {
			overlayRefreshTimer = null;
			syncOverlay();
		}, 16);
	}

	function setOverlayStatus(status: string, throttled = false): void {
		overlayStatus = status;
		if (throttled) {
			scheduleOverlayRefresh();
		} else {
			syncOverlay();
		}
	}

	function dismissOverlay(): void {
		overlayRuntime?.close?.();
		overlayRuntime = null;
		if (overlayRefreshTimer) {
			clearTimeout(overlayRefreshTimer);
			overlayRefreshTimer = null;
		}
	}

	function setOverlayDraft(value: string): void {
		overlayDraft = value;
		overlayRuntime?.setDraft?.(value);
	}

	async function disposeSideSession(): Promise<void> {
		const current = activeSideSession;
		activeSideSession = null;
		if (!current) {
			return;
		}

		try {
			current.unsubscribe();
		} catch {
			// Ignore unsubscribe errors during cleanup.
		}

		try {
			await current.session.abort();
		} catch {
			// Ignore abort errors during cleanup.
		}
		current.session.dispose();

		if (overlayRefreshTimer) {
			clearTimeout(overlayRefreshTimer);
			overlayRefreshTimer = null;
		}
	}

	async function resetThread(
		_ctx: ExtensionContext | ExtensionCommandContext,
		persist = true,
	): Promise<void> {
		thread = [];
		pendingQuestion = null;
		pendingAnswer = '';
		pendingError = null;
		pendingToolCalls = [];
		sideBusy = false;
		setOverlayDraft('');
		setOverlayStatus('就绪');
		await disposeSideSession();
		if (persist) {
			const details: BtwResetDetails = { timestamp: Date.now() };
			pi.appendEntry(BTW_RESET_TYPE, details);
		}
		syncOverlay();
	}

	async function restoreThread(ctx: ExtensionContext): Promise<void> {
		await disposeSideSession();
		thread = [];
		pendingQuestion = null;
		pendingAnswer = '';
		pendingError = null;
		pendingToolCalls = [];
		sideBusy = false;
		overlayStatus = '就绪';
		overlayDraft = '';
		const branch = ctx.sessionManager.getBranch();
		let lastResetIndex = -1;
		for (let i = 0; i < branch.length; i++) {
			const entry = branch[i];
			if (entry.type === 'custom' && entry.customType === BTW_RESET_TYPE) {
				lastResetIndex = i;
			}
		}

		for (const entry of branch.slice(lastResetIndex + 1)) {
			if (entry.type !== 'custom' || entry.customType !== BTW_ENTRY_TYPE) {
				continue;
			}
			const details = entry.data as BtwDetails | undefined;
			if (!details?.question || !details.answer) {
				continue;
			}
			thread.push(details);
		}

		syncOverlay();
	}

	async function createSideSession(
		ctx: ExtensionCommandContext,
	): Promise<SideSessionRuntime | null> {
		if (!ctx.model) {
			return null;
		}

		const { session } = await createAgentSession({
			sessionManager: SessionManager.inMemory(),
			model: ctx.model,
			thinkingLevel: pi.getThinkingLevel() as SessionThinkingLevel,
			tools: ['read', 'bash', 'edit', 'write'],
			resourceLoader: createBtwResourceLoader(ctx),
		});

		const seedMessages = buildSeedMessages(ctx, thread);
		if (seedMessages.length > 0) {
			session.agent.state.messages = seedMessages as typeof session.agent.state.messages;
		}

		const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			if (!sideBusy || !pendingQuestion) {
				return;
			}

			switch (event.type) {
				case 'message_start':
				case 'message_update':
				case 'message_end': {
					const streamed = extractEventAssistantText(event.message);
					if (streamed) {
						pendingAnswer = streamed;
						pendingError = null;
					}
					setOverlayStatus(
						event.type === 'message_end'
							? '正在完成侧边回复...'
							: '正在流式生成侧边回复...',
						true,
					);
					return;
				}
				case 'tool_execution_start': {
					const toolName = (event as { toolName?: string }).toolName ?? 'unknown';
					try {
						pendingToolCalls.push({
							toolCallId: (event as { toolCallId?: string }).toolCallId ?? '',
							toolName,
							args: formatToolArgs(toolName, (event as { args?: unknown }).args),
							status: 'running',
						});
					} catch {
						// Ignore tool tracking failures
					}
					setOverlayStatus(`运行工具：${toolName}...`, true);
					return;
				}
				case 'tool_execution_end': {
					const endToolName = (event as { toolName?: string }).toolName ?? 'unknown';
					const tc = pendingToolCalls.find(
						(t) => t.toolName === endToolName && t.status === 'running',
					);
					if (tc) {
						tc.status = (event as { isError?: boolean }).isError ? 'error' : 'done';
					}
					setOverlayStatus('正在流式生成侧边回复...', true);
					return;
				}
				case 'turn_end': {
					setOverlayStatus('正在完成侧边回复...', true);
					return;
				}
				default:
					return;
			}
		});

		return {
			session,
			modelKey: getModelKey(ctx),
			unsubscribe,
		};
	}

	async function ensureSideSession(
		ctx: ExtensionCommandContext,
	): Promise<SideSessionRuntime | null> {
		if (!ctx.model) {
			return null;
		}

		const expectedModelKey = getModelKey(ctx);
		if (activeSideSession && activeSideSession.modelKey === expectedModelKey) {
			return activeSideSession;
		}

		await disposeSideSession();
		activeSideSession = await createSideSession(ctx);
		return activeSideSession;
	}

	async function ensureOverlay(ctx: ExtensionCommandContext | ExtensionContext): Promise<void> {
		if (!ctx.hasUI) {
			return;
		}

		if (overlayRuntime?.handle) {
			overlayRuntime.handle.setHidden(false);
			overlayRuntime.handle.focus();
			overlayRuntime.refresh?.();
			return;
		}

		const runtime: OverlayRuntime = {};
		const closeRuntime = () => {
			if (runtime.closed) {
				return;
			}
			runtime.closed = true;
			runtime.handle?.hide();
			if (overlayRuntime === runtime) {
				overlayRuntime = null;
			}
			runtime.finish?.();
		};
		runtime.close = closeRuntime;
		overlayRuntime = runtime;

		void ctx.ui
			.custom<void>(
				async (tui, theme, keybindings, done) => {
					runtime.finish = () => done();

					const overlay = new BtwOverlay(
						tui,
						theme,
						keybindings,
						(width, t) => getTranscriptLines(width, t),
						() => overlayStatus,
						(value) => {
							void submitFromOverlay(ctx, value);
						},
						() => {
							void closeOverlayFlow(ctx);
						},
					);

					overlay.focused = true;
					overlay.setDraft(overlayDraft);
					runtime.setDraft = (value) => overlay.setDraft(value);
					runtime.refresh = () => {
						overlay.focused = runtime.handle?.isFocused() ?? false;
						tui.requestRender();
					};
					runtime.close = () => {
						overlayDraft = overlay.getDraft();
						closeRuntime();
					};

					if (runtime.closed) {
						done();
					}

					return overlay;
				},
				{
					overlay: true,
					overlayOptions: {
						width: '80%',
						minWidth: 72,
						maxHeight: '78%',
						anchor: 'top-center',
						margin: { top: 1, left: 2, right: 2 },
					},
					onHandle: (handle) => {
						runtime.handle = handle;
						handle.focus();
						if (runtime.closed) {
							closeRuntime();
						}
					},
				},
			)
			.catch((error) => {
				if (overlayRuntime === runtime) {
					overlayRuntime = null;
				}
				notify(ctx, error instanceof Error ? error.message : String(error), 'error');
			});
	}

	async function summarizeThread(ctx: ExtensionContext, items: BtwDetails[]): Promise<string> {
		const model = ctx.model;
		if (!model) {
			throw new Error('未选择活跃模型。');
		}

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (auth.ok === false) {
			throw new Error(auth.error);
		}

		const { session } = await createAgentSession({
			sessionManager: SessionManager.inMemory(),
			model,
			thinkingLevel: 'off',
			tools: [],
			resourceLoader: createBtwResourceLoader(ctx, [BTW_SUMMARY_PROMPT]),
		});

		try {
			await session.prompt(formatThread(items), { source: 'extension' });
			const response = getLastAssistantMessage(session);
			if (!response) {
				throw new Error('摘要请求结束但没有响应。');
			}
			if (response.stopReason === 'aborted') {
				throw new Error('摘要请求已中止。');
			}
			if (response.stopReason === 'error') {
				throw new Error(response.errorMessage || '摘要请求失败。');
			}

			return extractText(response.content) || '(No summary generated)';
		} finally {
			try {
				await session.abort();
			} catch {
				// Ignore abort errors during temporary session teardown.
			}
			session.dispose();
		}
	}

	async function injectSummaryIntoMain(
		ctx: ExtensionContext | ExtensionCommandContext,
	): Promise<void> {
		if (thread.length === 0) {
			notify(ctx, '没有可摘要的 BTW 线程。', 'warning');
			return;
		}

		setOverlayStatus('Summarizing BTW thread for injection...');
		try {
			const summary = await summarizeThread(ctx, thread);
			const message = `Summary of my BTW side conversation:\n\n${summary}`;
			if (ctx.isIdle()) {
				pi.sendUserMessage(message);
			} else {
				pi.sendUserMessage(message, { deliverAs: 'followUp' });
			}

			await resetThread(ctx);
			notify(ctx, '已将 BTW 摘要注入主对话。', 'info');
		} catch (error) {
			notify(ctx, error instanceof Error ? error.message : String(error), 'error');
		}
	}

	async function closeOverlayFlow(
		ctx: ExtensionContext | ExtensionCommandContext,
	): Promise<void> {
		dismissOverlay();
		if (!ctx.hasUI) {
			return;
		}

		if (thread.length === 0) {
			return;
		}

		const choice = await selectPanel(ctx, '关闭 BTW:', ['保留侧边线程', '将摘要注入主对话']);
		if (choice === '将摘要注入主对话') {
			await injectSummaryIntoMain(ctx);
		}
	}

	async function runBtwPrompt(ctx: ExtensionCommandContext, question: string): Promise<void> {
		const model = ctx.model;
		if (!model) {
			setOverlayStatus('未选择活跃模型。');
			notify(ctx, '未选择活跃模型。', 'error');
			return;
		}

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (auth.ok === false) {
			const message = auth.error;
			setOverlayStatus(message);
			notify(ctx, message, 'error');
			return;
		}

		if (sideBusy) {
			notify(ctx, 'BTW 仍在处理上一条消息。', 'warning');
			return;
		}

		const side = await ensureSideSession(ctx);
		if (!side) {
			notify(ctx, '无法创建 BTW 侧边会话。', 'error');
			return;
		}

		sideBusy = true;
		pendingQuestion = question;
		pendingAnswer = '';
		pendingError = null;
		pendingToolCalls = [];
		setOverlayStatus('正在流式生成侧边回复...');
		syncOverlay();

		try {
			await side.session.prompt(question, { source: 'extension' });
			const response = getLastAssistantMessage(side.session);
			if (!response) {
				throw new Error('BTW 请求结束但没有响应。');
			}
			if (response.stopReason === 'aborted') {
				throw new Error('BTW 请求已中止。');
			}
			if (response.stopReason === 'error') {
				throw new Error(response.errorMessage || 'BTW 请求失败。');
			}

			const answer = extractText(response.content) || '(No text response)';
			pendingAnswer = answer;
			const details: BtwDetails = {
				question,
				answer,
				timestamp: Date.now(),
				provider: model.provider,
				model: model.id,
				thinkingLevel: pi.getThinkingLevel() as SessionThinkingLevel,
				usage: response.usage,
			};
			thread.push(details);
			pi.appendEntry(BTW_ENTRY_TYPE, details);

			pendingQuestion = null;
			pendingAnswer = '';
			pendingToolCalls = [];
			setOverlayStatus('准备接收下一条侧边问题。');
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			pendingError = message;
			setOverlayStatus('BTW request failed.');
			notify(ctx, message, 'error');
		} finally {
			sideBusy = false;
			syncOverlay();
		}
	}

	async function submitFromOverlay(
		ctx: ExtensionContext | ExtensionCommandContext,
		rawValue: string,
	): Promise<void> {
		const question = rawValue.trim();
		if (!question) {
			setOverlayStatus('请先输入问题。');
			return;
		}

		setOverlayDraft('');
		if (!('waitForIdle' in ctx)) {
			setOverlayStatus('BTW submit requires command context. Re-open with /btw.');
			return;
		}

		await runBtwPrompt(ctx, question);
	}

	pi.registerCommand('btw', {
		description: '打开一个 BTW 侧聊弹出窗口。`/btw <文本>` 立即提问，`/btw` 打开侧线程。',
		handler: async (args, ctx) => {
			const question = args.trim();

			if (!question) {
				if (thread.length > 0 && ctx.hasUI) {
					const choice = await selectPanel(ctx, 'BTW side chat:', [
						'继续之前的对话',
						'重新开始',
					]);
					if (choice === '继续之前的对话') {
						// Dispose session so it's recreated with fresh main context on next submit
						await disposeSideSession();
						setOverlayStatus('Continuing BTW thread.');
						await ensureOverlay(ctx);
					} else if (choice === '重新开始') {
						await resetThread(ctx, true);
						setOverlayStatus('就绪');
						await ensureOverlay(ctx);
					}
					// null = user cancelled (Esc), do nothing
				} else {
					await resetThread(ctx, true);
					setOverlayStatus('就绪');
					await ensureOverlay(ctx);
				}
				return;
			}

			await ensureOverlay(ctx);
			await runBtwPrompt(ctx, question);
		},
	});

	pi.on('session_start', async (_event, ctx) => {
		await restoreThread(ctx);
	});

	pi.on('session_tree', async (_event, ctx) => {
		await restoreThread(ctx);
	});

	pi.on('session_shutdown', async () => {
		await disposeSideSession();
		dismissOverlay();
	});
}
