/**
 * Q&A extraction hook - extracts questions from assistant responses
 *
 * Custom interactive TUI for answering questions.
 *
 * Demonstrates the "prompt generator" pattern with custom TUI:
 * 1. /answer command gets the last assistant message
 * 2. Shows a spinner while extracting questions as structured JSON
 * 3. Presents an interactive TUI to navigate and answer questions
 * 4. Submits the compiled answers when done
 */

import {
	complete,
	parseJsonWithRepair,
	type Model,
	type Api,
	type UserMessage,
} from '@earendil-works/pi-ai/compat';
import type {
	ExtensionAPI,
	ExtensionContext,
	ModelRegistry,
	Theme,
} from '@earendil-works/pi-coding-agent';
import { BorderedLoader } from '@earendil-works/pi-coding-agent';
import { createLogger } from '@zenone/pi-logger';

const log = createLogger('answer');

import {
	type Component,
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	truncateToWidth,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from '@earendil-works/pi-tui';
import { bottomBorder, makeThemeColors, topBorder } from '../../src/tui/helpers.js';

// Structured output format for question extraction
interface ExtractedQuestion {
	question: string;
	context?: string;
}

interface ExtractionResult {
	questions: ExtractedQuestion[];
}

type ExtractionOutcome =
	| { status: 'ok'; result: ExtractionResult }
	| { status: 'cancelled' }
	| { status: 'error'; message: string };

const SYSTEM_PROMPT = `You are a question extractor. Given text from a conversation, extract any questions that need answering.

Output a JSON object with this structure:
{
  "questions": [
    {
      "question": "The question text",
      "context": "Optional context that helps answer the question"
    }
  ]
}

Rules:
- Extract all questions that require user input
- Keep questions in the order they appeared
- Be concise with question text
- Include context only when it provides essential information for answering
- If no questions are found, return {"questions": []}

Example output:
{
  "questions": [
    {
      "question": "What is your preferred database?",
      "context": "We can only configure MySQL and PostgreSQL because of what is implemented."
    },
    {
      "question": "Should we use TypeScript or JavaScript?"
    }
  ]
}`;

/**
 * 直接使用当前模型进行问答提取，无需硬编码 fallback。
 * 提取问题是一个轻量任务，当前模型足以胜任。
 */
function selectExtractionModel(
	currentModel: Model<Api>,
	_modelRegistry: ModelRegistry,
): Model<Api> {
	return currentModel;
}

function toExtractedQuestion(value: unknown): ExtractedQuestion | null {
	if (typeof value !== 'object' || value === null) return null;
	const record = value as Record<string, unknown>;
	const question = record.question;
	const context = record.context;
	if (typeof question !== 'string') return null;
	if (context !== undefined && context !== null && typeof context !== 'string') return null;
	return typeof context === 'string' && context.length > 0 ? { question, context } : { question };
}

function toExtractionResult(value: unknown): ExtractionResult | null {
	if (typeof value !== 'object' || value === null) return null;
	const record = value as Record<string, unknown>;
	if (!Array.isArray(record.questions)) return null;
	const questions: ExtractedQuestion[] = [];
	for (const q of record.questions) {
		const extractedQuestion = toExtractedQuestion(q);
		if (!extractedQuestion) return null;
		questions.push(extractedQuestion);
	}
	return { questions };
}

/**
 * 使用括号计数器提取第一个完整的顶层 JSON 对象。
 * 避免在 LLM 输出包含多个以文本分隔的 JSON 对象时跨对象截取。
 */
function extractFirstJsonObject(text: string): string | null {
	const start = text.indexOf('{');
	if (start === -1) return null;

	let depth = 0;
	let inString = false;
	let escape = false;

	for (let i = start; i < text.length; i++) {
		const ch = text[i];

		if (escape) {
			escape = false;
			continue;
		}

		if (ch === '\\' && inString) {
			escape = true;
			continue;
		}

		if (ch === '"') {
			inString = !inString;
			continue;
		}

		if (!inString) {
			if (ch === '{') depth++;
			else if (ch === '}') {
				depth--;
				if (depth === 0) {
					return text.slice(start, i + 1);
				}
			}
		}
	}

	return null;
}

/**
 * Parse the JSON response from the LLM.  Tries multiple candidate strings
 * (markdown code block, raw text, brace-extracted JSON) with parseJsonWithRepair.
 */
function parseExtractionResult(text: string): ExtractionResult | null {
	const candidates: string[] = [];
	const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (jsonMatch) candidates.push(jsonMatch[1].trim());

	const trimmed = text.trim();
	candidates.push(trimmed);

	const braceJson = extractFirstJsonObject(trimmed);
	if (braceJson) candidates.push(braceJson);

	for (const candidate of candidates) {
		try {
			const result = toExtractionResult(parseJsonWithRepair<unknown>(candidate));
			if (result) return result;
		} catch {
			// Try the next candidate.
		}
	}

	return null;
}

/**
 * Interactive Q&A component for answering extracted questions
 */
export class QnAComponent implements Component {
	private questions: ExtractedQuestion[];
	private answers: string[];
	private currentIndex: number = 0;
	private editor: Editor;
	private tui: TUI;
	private onDone: (result: string | null) => void;
	private showingConfirmation: boolean = false;

	// Cache
	private cachedWidth?: number;
	private cachedLines?: string[];

	// Colors — themed via makeThemeColors（禁用硬编码 ANSI，见 ADR-0023）
	private dim!: (s: string) => string;
	private bold!: (s: string) => string;
	private cyan!: (s: string) => string;
	private green!: (s: string) => string;
	private yellow!: (s: string) => string;
	private red!: (s: string) => string;
	private gray!: (s: string) => string;

	constructor(
		questions: ExtractedQuestion[],
		tui: TUI,
		theme: Theme,
		onDone: (result: string | null) => void,
	) {
		this.questions = questions;
		this.answers = questions.map(() => '');
		this.tui = tui;
		this.onDone = onDone;

		Object.assign(this, makeThemeColors(theme));

		// Create a minimal theme for the editor
		const editorTheme: EditorTheme = {
			borderColor: this.dim,
			selectList: {
				selectedPrefix: this.cyan,
				selectedText: (s: string) => theme.bg('selectedBg', s),
				description: this.gray,
				scrollInfo: this.dim,
				noMatch: this.yellow,
			},
		};

		this.editor = new Editor(tui, editorTheme);
		// Disable the editor's built-in submit (which clears the editor)
		// We'll handle Enter ourselves to preserve the text
		this.editor.disableSubmit = true;
		this.editor.onChange = () => {
			this.invalidate();
			this.tui.requestRender();
		};
	}

	private allQuestionsAnswered(): boolean {
		this.saveCurrentAnswer();
		return this.answers.every((a) => (a?.trim() || '').length > 0);
	}

	private saveCurrentAnswer(): void {
		this.answers[this.currentIndex] = this.editor.getText();
	}

	private navigateTo(index: number): void {
		if (index < 0 || index >= this.questions.length) return;
		this.saveCurrentAnswer();
		this.currentIndex = index;
		this.editor.setText(this.answers[index] || '');
		this.invalidate();
	}

	private submit(): void {
		this.saveCurrentAnswer();

		// Build the response text
		const parts: string[] = [];
		for (let i = 0; i < this.questions.length; i++) {
			const q = this.questions[i];
			const a = this.answers[i]?.trim() || '(no answer)';
			parts.push(`Q: ${q.question}`);
			if (q.context) {
				parts.push(`> ${q.context}`);
			}
			parts.push(`A: ${a}`);
			parts.push('');
		}

		this.onDone(parts.join('\n').trim());
	}

	private cancel(): void {
		this.onDone(null);
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	handleInput(data: string): void {
		// Handle confirmation dialog
		if (this.showingConfirmation) {
			if (matchesKey(data, Key.enter) || data.toLowerCase() === 'y') {
				this.submit();
				return;
			}
			if (
				matchesKey(data, Key.escape) ||
				matchesKey(data, Key.ctrl('c')) ||
				data.toLowerCase() === 'n'
			) {
				this.showingConfirmation = false;
				this.invalidate();
				this.tui.requestRender();
				return;
			}
			return;
		}

		// Global navigation and commands
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
			this.cancel();
			return;
		}

		// Tab / Shift+Tab for navigation
		if (matchesKey(data, Key.tab)) {
			if (this.currentIndex < this.questions.length - 1) {
				this.navigateTo(this.currentIndex + 1);
				this.tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, Key.shift('tab'))) {
			if (this.currentIndex > 0) {
				this.navigateTo(this.currentIndex - 1);
				this.tui.requestRender();
			}
			return;
		}

		// Arrow up/down for question navigation when editor is empty
		// (Editor handles its own cursor navigation when there's content)
		if (matchesKey(data, Key.up) && this.editor.getText() === '') {
			if (this.currentIndex > 0) {
				this.navigateTo(this.currentIndex - 1);
				this.tui.requestRender();
				return;
			}
		}
		if (matchesKey(data, Key.down) && this.editor.getText() === '') {
			if (this.currentIndex < this.questions.length - 1) {
				this.navigateTo(this.currentIndex + 1);
				this.tui.requestRender();
				return;
			}
		}

		// Handle Enter ourselves (editor's submit is disabled)
		// Plain Enter moves to next question or shows confirmation on last question
		// Shift+Enter adds a newline (handled by editor)
		if (matchesKey(data, Key.enter) && !matchesKey(data, Key.shift('enter'))) {
			this.saveCurrentAnswer();
			if (this.currentIndex < this.questions.length - 1) {
				this.navigateTo(this.currentIndex + 1);
			} else {
				// On last question - show confirmation
				this.showingConfirmation = true;
			}
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		// Pass to editor
		this.editor.handleInput(data);
		this.invalidate();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const boxWidth = Math.min(width - 4, 120); // Allow wider box
		const contentWidth = boxWidth - 4; // 2 chars padding on each side

		// 纯横线范式（ADR-0023）：无角无竖线，内容行缩进 + truncate 兜底
		const boxLine = (content: string, leftPad: number = 2): string => {
			return ' '.repeat(leftPad) + truncateToWidth(content, Math.max(0, boxWidth - leftPad));
		};

		const emptyBoxLine = (): string => '';

		const padToWidth = (line: string): string => {
			const len = visibleWidth(line);
			return line + ' '.repeat(Math.max(0, width - len));
		};

		// 顶边框：纯横线 + 插件名（ADR-0023）
		lines.push(padToWidth(this.dim(topBorder('── answer ', boxWidth))));
		const title = `${this.bold(this.cyan('Questions'))} ${this.dim(`(${this.currentIndex + 1}/${this.questions.length})`)}`;
		lines.push(padToWidth(boxLine(title)));
		lines.push(padToWidth(this.dim(' ' + bottomBorder(boxWidth - 2) + ' ')));

		// Progress indicator
		const progressParts: string[] = [];
		for (let i = 0; i < this.questions.length; i++) {
			const answered = (this.answers[i]?.trim() || '').length > 0;
			const current = i === this.currentIndex;
			if (current) {
				progressParts.push(this.cyan('●'));
			} else if (answered) {
				progressParts.push(this.green('●'));
			} else {
				progressParts.push(this.dim('○'));
			}
		}
		lines.push(padToWidth(boxLine(progressParts.join(' '))));
		lines.push(padToWidth(emptyBoxLine()));

		// Current question
		const q = this.questions[this.currentIndex];
		const questionText = `${this.bold('Q:')} ${q.question}`;
		const wrappedQuestion = wrapTextWithAnsi(questionText, contentWidth);
		for (const line of wrappedQuestion) {
			lines.push(padToWidth(boxLine(line)));
		}

		// Context if present
		if (q.context) {
			lines.push(padToWidth(emptyBoxLine()));
			const contextText = this.gray(`> ${q.context}`);
			const wrappedContext = wrapTextWithAnsi(contextText, contentWidth - 2);
			for (const line of wrappedContext) {
				lines.push(padToWidth(boxLine(line)));
			}
		}

		lines.push(padToWidth(emptyBoxLine()));

		// Render the editor component (multi-line input) with padding
		// Skip the first and last lines (editor's own border lines)
		const answerPrefix = this.bold('A: ');
		const editorWidth = contentWidth - 4 - 3; // Extra padding + space for "A: "
		const editorLines = this.editor.render(editorWidth);
		for (let i = 1; i < editorLines.length - 1; i++) {
			if (i === 1) {
				// First content line gets the "A: " prefix
				lines.push(padToWidth(boxLine(answerPrefix + editorLines[i])));
			} else {
				// Subsequent lines get padding to align with the first line
				lines.push(padToWidth(boxLine('   ' + editorLines[i])));
			}
		}

		lines.push(padToWidth(emptyBoxLine()));

		// Confirmation dialog or footer with controls
		if (this.showingConfirmation) {
			lines.push(padToWidth(this.dim(' ' + bottomBorder(boxWidth - 2) + ' ')));
			const confirmMsg = `${this.yellow('提交所有答案？')} ${this.dim('（Enter/y 确认，Esc/n 取消）')}`;
			lines.push(padToWidth(boxLine(truncateToWidth(confirmMsg, contentWidth))));
		} else {
			lines.push(padToWidth(this.dim(' ' + bottomBorder(boxWidth - 2) + ' ')));
			const controls = `${this.dim('Tab/Enter')} 下一个 · ${this.dim('Shift+Tab')} 上一个 · ${this.dim('Shift+Enter')} 换行 · ${this.dim('Esc')} 取消`;
			lines.push(padToWidth(boxLine(truncateToWidth(controls, contentWidth))));
		}
		lines.push(padToWidth(this.dim(bottomBorder(boxWidth))));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

export default function (pi: ExtensionAPI) {
	log.info('Extension loaded — /answer command and ctrl+. shortcut registered');

	const answerHandler = async (ctx: ExtensionContext) => {
		log.debug('answerHandler triggered', { hasUI: ctx.hasUI, hasModel: !!ctx.model });

		if (!ctx.hasUI) {
			ctx.ui.notify('answer 需要交互模式', 'error');
			return;
		}

		if (!ctx.model) {
			ctx.ui.notify('未选择模型', 'error');
			return;
		}

		// Find the last assistant message on the current branch
		const branch = ctx.sessionManager.getBranch();
		let lastAssistantText: string | undefined;

		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type === 'message') {
				const msg = entry.message;
				if ('role' in msg && msg.role === 'assistant') {
					if (msg.stopReason !== 'stop') {
						ctx.ui.notify(`上一条助手消息不完整 (${msg.stopReason})`, 'error');
						return;
					}
					const textParts = msg.content
						.filter((c): c is { type: 'text'; text: string } => c.type === 'text')
						.map((c) => c.text);
					if (textParts.length > 0) {
						lastAssistantText = textParts.join('\n');
						break;
					}
				}
			}
		}

		if (!lastAssistantText) {
			ctx.ui.notify('未找到助手消息', 'error');
			return;
		}

		// Select the best model for extraction
		const extractionModel = selectExtractionModel(ctx.model, ctx.modelRegistry);
		log.info('Extraction model selected', {
			modelId: extractionModel.id,
			provider: extractionModel.provider,
		});

		// Run extraction with loader UI
		const extractionOutcome = await ctx.ui.custom<ExtractionOutcome>(
			(tui, theme, _kb, done) => {
				const loader = new BorderedLoader(
					tui,
					theme,
					`正在使用 ${extractionModel.id} 提取问题...`,
				);
				loader.onAbort = () => done({ status: 'cancelled' });

				const doExtract = async (): Promise<ExtractionOutcome> => {
					const auth = await ctx.modelRegistry.getApiKeyAndHeaders(extractionModel);
					if (auth.ok === false) {
						return { status: 'error', message: auth.error };
					}
					const userMessage: UserMessage = {
						role: 'user',
						content: [{ type: 'text', text: lastAssistantText! }],
						timestamp: Date.now(),
					};

					const response = await complete(
						extractionModel,
						{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
						{
							apiKey: auth.apiKey,
							headers: auth.headers,
							signal: loader.signal,
						},
					);

					if (response.stopReason === 'aborted') {
						return { status: 'cancelled' };
					}
					if (response.stopReason === 'error') {
						return {
							status: 'error',
							message: response.errorMessage ?? '问题提取失败',
						};
					}

					const responseText = response.content
						.filter((c): c is { type: 'text'; text: string } => c.type === 'text')
						.map((c) => c.text)
						.join('\n');
					const result = parseExtractionResult(responseText);
					if (!result) {
						return {
							status: 'error',
							message: '问题提取返回无效 JSON',
						};
					}

					return { status: 'ok', result };
				};

				doExtract()
					.then(done)
					.catch((error: unknown) => {
						const message = error instanceof Error ? error.message : String(error);
						done({ status: 'error', message });
					});

				return loader;
			},
		);

		log.info('Extraction outcome', {
			status: extractionOutcome.status,
			questionCount:
				extractionOutcome.status === 'ok' ? extractionOutcome.result.questions.length : 0,
		});

		if (extractionOutcome.status === 'cancelled') {
			ctx.ui.notify('已取消', 'info');
			return;
		}
		if (extractionOutcome.status === 'error') {
			log.error('Question extraction failed', { message: extractionOutcome.message });
			ctx.ui.notify(`问题提取失败: ${extractionOutcome.message}`, 'error');
			return;
		}

		const extractionResult = extractionOutcome.result;
		if (extractionResult.questions.length === 0) {
			log.info('No questions found in last assistant message');
			ctx.ui.notify('上一条消息中未找到问题', 'info');
			return;
		}

		// Show the Q&A component
		const answersResult = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			return new QnAComponent(extractionResult.questions, tui, theme, done);
		});

		if (answersResult === null) {
			ctx.ui.notify('已取消', 'info');
			return;
		}

		// Send the answers directly as a message and trigger a turn
		pi.sendMessage(
			{
				customType: 'answers',
				content: 'I answered your questions in the following way:\n\n' + answersResult,
				display: true,
			},
			{ triggerTurn: true },
		);
	};

	pi.registerCommand('answer', {
		description: '从最后一条 assistant 消息提取问题到交互式问答',
		handler: (_args, ctx) => answerHandler(ctx),
	});

	// session_start 时注册（消除加载顺序竞险：hub 在所有扩展工厂函数执行后才挂载）
	pi.on('session_start', () => {
		const shortcutHub = (globalThis as any).__shortcutsApi;
		if (shortcutHub?.register) {
			shortcutHub.register({
				name: 'answer',
				keys: ['a'],
				description: '提取并解答最后一条回复的问题',
				handler: answerHandler,
			});
		} else {
			pi.registerShortcut('ctrl+.', {
				description: '提取并解答最后一条回复的问题',
				handler: answerHandler,
			});
		}
	});
}
