/**
 * Questionnaire Tool - Unified tool for asking single or multiple questions
 *
 * Single question: delegates to @zenone/pi-selector for consistent UX
 * Multiple questions: tab-based custom UI providing:
 *   - Tab bar navigation (← → / Tab / Shift+Tab) between questions + submit tab
 *   - Per-question option selection (↑↓ + Enter)
 *   - Tab supplement: press Tab on selected option to attach extra info to LLM
 *   - Custom input: "Type something" option with full Editor
 *   - Submit tab: review all answers before confirming
 *   - isSelecting signal to prevent model execution during wait
 *   - Clear help annotation per interaction mode
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { showSelect } from '@zenone/pi-selector';
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	truncateToWidth,
	wrapTextWithAnsi,
	visibleWidth,
} from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import { createLogger } from '@zenone/pi-logger';

const log = createLogger('questionnaire');

log.debug('Extension loaded');

// ── Types ──

interface QuestionOption {
	value: string;
	label: string;
	description?: string;
}

interface Question {
	id: string;
	label: string;
	prompt: string;
	options: QuestionOption[];
	allowOther: boolean;
}

interface Answer {
	id: string;
	value: string;
	label: string;
	wasCustom: boolean;
	/** Tab supplement text (extra info user entered via Tab key) */
	supplement?: string;
	index?: number;
}

interface QuestionnaireResult {
	questions: Question[];
	answers: Answer[];
	cancelled: boolean;
}

interface RenderOption extends QuestionOption {
	isOther?: boolean;
}

// ── Schema ──

const QuestionOptionSchema = Type.Object({
	value: Type.String({ description: 'The value returned when selected' }),
	label: Type.String({ description: 'Display label for the option' }),
	description: Type.Optional(
		Type.String({ description: 'Optional description shown below label' }),
	),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: 'Unique identifier for this question' }),
	label: Type.Optional(
		Type.String({
			description:
				"Short contextual label for tab bar, e.g. 'Scope', 'Priority' (defaults to Q1, Q2)",
		}),
	),
	prompt: Type.String({ description: 'The full question text to display' }),
	options: Type.Array(QuestionOptionSchema, {
		description: 'Available options to choose from',
	}),
	allowOther: Type.Optional(
		Type.Boolean({
			description: "Allow 'Type something' option (default: true)",
		}),
	),
});

const QuestionnaireParams = Type.Object({
	questions: Type.Array(QuestionSchema, {
		description: 'Questions to ask the user',
	}),
});

// ── Helpers ──

function errorResult(
	message: string,
	questions: Question[] = [],
): {
	content: { type: 'text'; text: string }[];
	details: QuestionnaireResult;
} {
	return {
		content: [{ type: 'text', text: message }],
		details: { questions, answers: [], cancelled: true },
	};
}

/**
 * Format a single answer line, optionally including supplement text.
 */
function formatAnswerLine(q: Question, a: Answer): string {
	const qLabel = q.label || a.id;
	if (a.wasCustom) {
		return `${qLabel}: user wrote: ${a.label}`;
	}
	const base = a.index
		? `${qLabel}: user selected: ${a.index}. ${a.label}`
		: `${qLabel}: user selected: ${a.label}`;
	if (a.supplement) {
		return `${base}\n    supplement: ${a.supplement}`;
	}
	return base;
}

/**
 * Build the final content string from all answers.
 */
function buildContent(questions: Question[], answers: Answer[]): string {
	return questions
		.map((q) => {
			const a = answers.find((a) => a.id === q.id);
			return a ? formatAnswerLine(q, a) : `${q.label}: (no answer)`;
		})
		.join('\n');
}

// ── Main extension ──

export default function questionnaire(pi: ExtensionAPI) {
	pi.registerTool({
		name: 'questionnaire',
		label: 'Questionnaire',
		description:
			'Ask the user one or more questions. For single questions, shows a simple option list. For multiple questions, shows a tab-based interface with navigation between questions and a submit review step.',
		parameters: QuestionnaireParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (ctx.mode !== 'tui') {
				return errorResult('Error: UI not available (running in non-interactive mode)');
			}
			if (params.questions.length === 0) {
				return errorResult('Error: No questions provided');
			}

			// Normalize questions with defaults
			const questions: Question[] = params.questions.map((q, i) => ({
				...q,
				label: q.label || `Q${i + 1}`,
				allowOther: q.allowOther !== false,
			}));

			// ── Single question: delegate to showSelect ──
			if (questions.length === 1) {
				return handleSingleQuestion(questions[0], ctx);
			}

			// ── Multiple questions: custom tabbed UI ──
			return handleMultiQuestion(questions, ctx);
		},

		renderCall(args, theme, _context) {
			const qs = (args.questions as Question[]) || [];
			const count = qs.length;
			const labels = qs.map((q) => q.label || q.id).join(', ');
			let text = theme.fg('toolTitle', theme.bold('questionnaire '));
			text += theme.fg('muted', `${count} question${count !== 1 ? 's' : ''}`);
			if (labels) {
				text += theme.fg('dim', ` (${truncateToWidth(labels, 40)})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as QuestionnaireResult | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === 'text' ? text.text : '', 0, 0);
			}
			if (details.cancelled) {
				return new Text(theme.fg('warning', 'Cancelled'), 0, 0);
			}
			const lines = details.answers.map((a) => {
				if (a.wasCustom) {
					return `${theme.fg('success', '✓ ')}${theme.fg('accent', a.id)}: ${theme.fg('muted', '(wrote) ')}${a.label}`;
				}
				const display = a.index ? `${a.index}. ${a.label}` : a.label;
				let result = `${theme.fg('success', '✓ ')}${theme.fg('accent', a.id)}: ${display}`;
				if (a.supplement) {
					result += `\n  ${theme.fg('dim', 'supplement:')} ${a.supplement}`;
				}
				return result;
			});
			return new Text(lines.join('\n'), 0, 0);
		},
	});
}

// ── Single question handler ──

async function handleSingleQuestion(
	q: Question,
	ctx: any,
): Promise<{
	content: { type: 'text'; text: string }[];
	details: QuestionnaireResult;
}> {
	const options = q.options.map((o) => ({
		value: o.value,
		label: o.label,
		description: o.description,
	}));

	const result = await showSelect(ctx, q.prompt, options, {
		allowOther: q.allowOther,
		otherPlaceholder: '输入自定义答案...',
	});

	if (result === null) {
		log.info('User cancelled single question');
		return {
			content: [{ type: 'text', text: 'User cancelled the questionnaire' }],
			details: { questions: [q], answers: [], cancelled: true },
		};
	}

	// Determine if result came from allowOther (no matching option value)
	const matchedOption = options.find((o) => o.value === result.value);
	const isCustom = !matchedOption && !!result.supplement;

	let answer: Answer;
	if (isCustom) {
		// allowOther: the typed text is in result.supplement (or result.value for some paths)
		answer = {
			id: q.id,
			value: result.supplement || result.value,
			label: result.supplement || result.label,
			wasCustom: true,
		};
	} else if (result.supplement && matchedOption) {
		// Tab supplement on a normal option
		const answerIndex = options.findIndex((o) => o.value === result.value) + 1;
		answer = {
			id: q.id,
			value: result.value,
			label: result.label,
			wasCustom: false,
			supplement: result.supplement,
			index: answerIndex > 0 ? answerIndex : undefined,
		};
	} else {
		// Normal selection
		const answerIndex = options.findIndex((o) => o.value === result.value) + 1;
		answer = {
			id: q.id,
			value: result.value,
			label: result.label,
			wasCustom: false,
			index: answerIndex > 0 ? answerIndex : undefined,
		};
	}

	log.info('Single question answered: %s', answer.label);
	if (answer.supplement) {
		log.info('  with supplement: %s', answer.supplement);
	}

	return {
		content: [{ type: 'text', text: buildContent([q], [answer]) }],
		details: { questions: [q], answers: [answer], cancelled: false },
	};
}

// ── Multi-question handler ──

async function handleMultiQuestion(
	questions: Question[],
	ctx: any,
): Promise<{
	content: { type: 'text'; text: string }[];
	details: QuestionnaireResult;
}> {
	const totalTabs = questions.length + 1; // questions + Submit

	const result = await ctx.ui.custom<QuestionnaireResult>((tui, theme, _kb, done) => {
		// ── State ──
		let currentTab = 0;
		let selectedIndex = 0;
		let supplementMode = false;
		let supplementText = '';
		let customInputMode = false;
		let customInputQuestionId: string | null = null;
		let cachedLines: string[] | undefined;
		const answers = new Map<string, Answer>();

		// Editor for "Type something" custom input
		const editorTheme: EditorTheme = {
			borderColor: (s) => theme.fg('accent', s),
			selectList: {
				selectedPrefix: (t) => theme.fg('accent', t),
				selectedText: (t) => theme.fg('accent', t),
				description: (t) => theme.fg('muted', t),
				scrollInfo: (t) => theme.fg('dim', t),
				noMatch: (t) => theme.fg('warning', t),
			},
		};
		const editor = new Editor(tui, editorTheme);

		// ── isSelecting signal ──
		(globalThis as any).__piTmuxDialogState = { isSelecting: true };

		// ── Helpers ──

		function refresh() {
			cachedLines = undefined;
			tui.requestRender();
		}

		function submit(cancelled: boolean) {
			// Sort answers to match original question order
			const sortedAnswers = questions
				.map((q) => answers.get(q.id))
				.filter((a): a is Answer => a !== undefined);
			done({ questions, answers: sortedAnswers, cancelled });
		}

		function currentQuestion(): Question | undefined {
			return questions[currentTab];
		}

		function currentOptions(): RenderOption[] {
			const q = currentQuestion();
			if (!q) return [];
			const opts: RenderOption[] = [...q.options];
			if (q.allowOther) {
				opts.push({ value: '__other__', label: 'Type something.', isOther: true });
			}
			return opts;
		}

		function allAnswered(): boolean {
			return questions.every((q) => answers.has(q.id));
		}

		function goToTab(tab: number) {
			currentTab = ((tab % totalTabs) + totalTabs) % totalTabs;
			selectedIndex = 0;
			// Exit any input mode when switching tabs
			supplementMode = false;
			supplementText = '';
			customInputMode = false;
			customInputQuestionId = null;
			editor.setText('');
			refresh();
		}

		function advanceOrSubmit() {
			if (currentTab < questions.length - 1) {
				goToTab(currentTab + 1);
			} else {
				goToTab(questions.length); // Submit tab
			}
		}

		function saveAnswer(
			questionId: string,
			value: string,
			label: string,
			wasCustom: boolean,
			supplement?: string,
			index?: number,
		) {
			answers.set(questionId, { id: questionId, value, label, wasCustom, supplement, index });
		}

		// Editor submit callback for custom input (allowOther)
		editor.onSubmit = (value) => {
			if (!customInputQuestionId) return;
			const trimmed = value.trim() || '(no response)';
			saveAnswer(customInputQuestionId, trimmed, trimmed, true);
			customInputMode = false;
			customInputQuestionId = null;
			editor.setText('');
			advanceOrSubmit();
		};

		// ── Input handling ──

		function handleInput(data: string): void {
			// ── Custom input mode (allowOther: multi-line Editor) ──
			if (customInputMode) {
				if (matchesKey(data, Key.escape)) {
					customInputMode = false;
					customInputQuestionId = null;
					editor.setText('');
					refresh();
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}

			// ── Supplement mode (Tab supplement: single-line input) ──
			if (supplementMode) {
				if (matchesKey(data, Key.enter)) {
					// Submit selected option + supplement
					const opts = currentOptions();
					const q = currentQuestion();
					if (selectedIndex >= 0 && selectedIndex < opts.length && q) {
						const opt = opts[selectedIndex];

						// If on "Type something" with supplement, redirect to custom input
						if (opt.isOther) {
							supplementMode = false;
							supplementText = '';
							customInputMode = true;
							customInputQuestionId = q.id;
							editor.setText('');
							refresh();
							return;
						}

						const supplement = supplementText.trim() || undefined;
						saveAnswer(
							q.id,
							opt.value,
							opt.label,
							false,
							supplement,
							selectedIndex + 1,
						);
						supplementMode = false;
						supplementText = '';
						advanceOrSubmit();
					}
					return;
				}
				if (matchesKey(data, Key.escape)) {
					// Cancel supplement, back to selection mode
					supplementMode = false;
					supplementText = '';
					refresh();
					return;
				}
				if (matchesKey(data, Key.backspace)) {
					supplementText = supplementText.slice(0, -1);
					refresh();
					return;
				}
				if (data.length === 1 && data.charCodeAt(0) >= 32) {
					supplementText = supplementText + data;
					refresh();
					return;
				}
				return;
			}

			// ── Selection mode ──

			// Tab bar navigation: ← → keys (Tab reserved for supplement)
			if (matchesKey(data, Key.right)) {
				goToTab(currentTab + 1);
				return;
			}
			if (matchesKey(data, Key.left)) {
				goToTab(currentTab - 1);
				return;
			}
			// Shift+Tab also navigates left (alternative for Tab-key muscle memory)
			if (matchesKey(data, Key.shift('tab'))) {
				goToTab(currentTab - 1);
				return;
			}

			// Submit tab
			if (currentTab === questions.length) {
				if (matchesKey(data, Key.enter)) {
					if (allAnswered()) {
						submit(false);
					}
				} else if (matchesKey(data, Key.escape)) {
					submit(true);
				}
				return;
			}

			// Option navigation
			const opts = currentOptions();
			if (matchesKey(data, Key.up)) {
				selectedIndex = Math.max(0, selectedIndex - 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				selectedIndex = Math.min(opts.length - 1, selectedIndex + 1);
				refresh();
				return;
			}

			// Tab supplement: on a selected option, press Tab to add extra info
			const q = currentQuestion();
			if (matchesKey(data, Key.enter) && q) {
				const opt = opts[selectedIndex];
				if (opt.isOther) {
					// Enter "Type something" custom input mode
					customInputMode = true;
					customInputQuestionId = q.id;
					editor.setText('');
					refresh();
					return;
				}
				// If the option is already answered (user re-selected), we re-save
				saveAnswer(q.id, opt.value, opt.label, false, undefined, selectedIndex + 1);
				advanceOrSubmit();
				return;
			}

			// Tab = supplement mode on the selected option
			if (matchesKey(data, Key.tab) && q) {
				const opt = opts[selectedIndex];
				if (opt.isOther) {
					// For "Type something", Tab enters custom input mode
					customInputMode = true;
					customInputQuestionId = q.id;
					editor.setText('');
					refresh();
					return;
				}
				// Enter supplement mode
				supplementMode = true;
				supplementText = '';
				refresh();
				return;
			}

			// Cancel entire questionnaire
			if (matchesKey(data, Key.escape)) {
				submit(true);
			}
		}

		// ── Render ──

		function render(width: number): string[] {
			if (cachedLines) return cachedLines;

			const lines: string[] = [];
			const q = currentQuestion();
			const opts = currentOptions();

			const add = (s: string) => lines.push(truncateToWidth(s, width));
			// For content that should wrap (option descriptions)
			const addContent = (s: string, contIndent?: string) => {
				if (contIndent) {
					const indentWidth = visibleWidth(contIndent);
					const available = indentWidth > 0 ? Math.max(10, width - indentWidth) : width;
					const wrapped = wrapTextWithAnsi(s, available);
					if (wrapped.length > 1 && contIndent) {
						lines.push(wrapped[0]);
						for (let i = 1; i < wrapped.length; i++) {
							lines.push(contIndent + wrapped[i]);
						}
					} else {
						lines.push(...wrapped);
					}
				} else {
					lines.push(truncateToWidth(s, width));
				}
			};

			// Top border
			add(theme.fg('accent', '─'.repeat(width)));

			// Tab bar
			{
				const tabParts: string[] = [];
				for (let i = 0; i < questions.length; i++) {
					const isActive = i === currentTab;
					const isAnswered = answers.has(questions[i].id);
					const lbl = questions[i].label;
					const indicator = isAnswered ? '■' : '□';
					const color = isAnswered ? 'success' : 'muted';
					const tabText = ` ${indicator} ${lbl} `;
					const styled = isActive
						? theme.bg('selectedBg', theme.fg('text', tabText))
						: theme.fg(color, tabText);
					tabParts.push(styled);
				}
				// Submit tab
				const canSubmit = allAnswered();
				const isSubmitTab = currentTab === questions.length;
				const submitText = ' ✓ Submit ';
				const submitStyled = isSubmitTab
					? theme.bg('selectedBg', theme.fg('text', submitText))
					: theme.fg(canSubmit ? 'success' : 'dim', submitText);
				tabParts.push(submitStyled);

				const row = ` ${tabParts.join(' ')}`;
				add(truncateToWidth(row, width));
				add('');
			}

			// Content area
			if (customInputMode && q) {
				// ── Custom input (allowOther) ──
				add(theme.fg('text', ` ${q.prompt}`));
				add('');
				renderOptions(opts, selectedIndex, theme, add, addContent, true);
				add('');
				add(theme.fg('muted', ' Your answer:'));
				for (const editorLine of editor.render(width - 2)) {
					add(` ${editorLine}`);
				}
				add('');
				add(theme.fg('dim', ' Enter to submit changes · Esc to cancel custom input'));
			} else if (supplementMode && q) {
				// ── Supplement mode (Tab) ──
				add(theme.fg('text', ` ${q.prompt}`));
				add('');
				renderOptions(opts, selectedIndex, theme, add, addContent, false);
				add('');
				// Supplement input line
				const isEmpty = !supplementText;
				const placeholder = ' 输入额外信息给大模型...';
				const inputLine =
					theme.fg('dim', ' ┊ ') +
					(isEmpty ? theme.fg('dim', placeholder) : theme.fg('text', supplementText));
				add(inputLine);
				add('');
				add(
					theme.fg('dim', ' Enter to confirm supplement · Esc to cancel · Type to input'),
				);
			} else if (currentTab === questions.length) {
				// ── Submit tab ──
				add(theme.fg('accent', theme.bold(' Ready to submit')));
				add('');
				for (const question of questions) {
					const answer = answers.get(question.id);
					if (answer) {
						const prefix = answer.wasCustom ? '(wrote) ' : `${answer.index || '?'}. `;
						let line = `${theme.fg('muted', ` ${question.label}: `)}${theme.fg('text', prefix + answer.label)}`;
						if (answer.supplement) {
							line += `\n   ${theme.fg('dim', 'supplement:')} ${theme.fg('muted', answer.supplement)}`;
						}
						// Each line may be multi-line due to supplement; split and add separately
						const subLines = line.split('\n');
						for (const sl of subLines) {
							add(sl);
						}
					} else {
						add(
							`${theme.fg('warning', ` ${question.label}:`)} ${theme.fg('dim', '(unanswered)')}`,
						);
					}
				}
				add('');
				if (allAnswered()) {
					add(theme.fg('success', ' Press Enter to submit · Esc to cancel'));
				} else {
					const missing = questions
						.filter((q) => !answers.has(q.id))
						.map((q) => q.label)
						.join(', ');
					add(theme.fg('warning', ` Unanswered: ${missing} (answer all to submit)`));
				}
			} else if (q) {
				// ── Question options ──
				add(theme.fg('text', ` ${q.prompt}`));
				add('');
				renderOptions(opts, selectedIndex, theme, add, addContent, false);
			}

			// Bottom help bar
			add('');
			if (customInputMode) {
				add(theme.fg('dim', ' Enter submit · Esc cancel · Type freely'));
			} else if (supplementMode) {
				add(theme.fg('dim', ' Enter add supplement · Esc cancel supplement · Type freely'));
			} else if (currentTab === questions.length) {
				// Already handled above; add a short reminder
				if (allAnswered()) {
					add(
						theme.fg(
							'dim',
							' ← → navigate questions · Shift+Tab go back · Enter submit · Esc cancel',
						),
					);
				} else {
					add(
						theme.fg('dim', ' ← → navigate questions · Shift+Tab go back · Esc cancel'),
					);
				}
			} else {
				add(
					theme.fg(
						'dim',
						' ↑ ↓ select · ← → switch question · Tab add supplement · Enter confirm · Esc cancel',
					),
				);
			}
			add(theme.fg('accent', '─'.repeat(width)));

			cachedLines = lines;
			return lines;
		}

		return {
			render,
			invalidate: () => {
				cachedLines = undefined;
			},
			handleInput,
			dispose: () => {
				(globalThis as any).__piTmuxDialogState = { isSelecting: false };
			},
		};
	});

	if (result.cancelled) {
		log.info('User cancelled multi-question questionnaire');
		return {
			content: [{ type: 'text', text: 'User cancelled the questionnaire' }],
			details: result,
		};
	}

	log.info('Multi-question completed with %d answers', result.answers.length);

	return {
		content: [{ type: 'text', text: buildContent(result.questions, result.answers) }],
		details: result,
	};
}

// ── Render options helper ──

function renderOptions(
	opts: RenderOption[],
	selectedIndex: number,
	theme: any,
	add: (s: string) => void,
	addContent: (s: string, indent?: string) => void,
	showInputIndicator: boolean,
): void {
	for (let i = 0; i < opts.length; i++) {
		const opt = opts[i];
		const isSelected = i === selectedIndex;
		const isOther = opt.isOther === true;
		const prefix = isSelected ? theme.fg('accent', ' › ') : '   ';
		const color = isSelected ? 'accent' : 'text';
		const label = isOther ? (showInputIndicator ? `${opt.label} ✎` : opt.label) : opt.label;
		add(`${prefix}${theme.fg(color, `${i + 1}. ${label}`)}`);
		if (opt.description) {
			addContent(`     ${theme.fg('muted', opt.description)}`, '     ');
		}
	}
}
