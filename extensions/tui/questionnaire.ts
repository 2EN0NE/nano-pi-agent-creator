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

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
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
import { topBorder } from '../../src/tui/helpers.js';
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
	/** 是否允许多选（空格切换选择，Enter 确认） */
	multiSelect?: boolean;
}

interface Answer {
	id: string;
	/**
	 * 单选：被选选项的 value。
	 * 多选：所有选中项 value 用 ', ' 拼接的字符串；结构化数据见 values/labels/indexes。
	 */
	value: string;
	/** 单选：被选选项的 label；多选：所有选中项 label 用 ', ' 拼接。 */
	label: string;
	wasCustom: boolean;
	/** Tab supplement text (extra info user entered via Tab key) */
	supplement?: string;
	index?: number;
	/** 多选模式：所有选中项的值/标签/序号 */
	values?: string[];
	labels?: string[];
	indexes?: number[];
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
	value: Type.String({ description: '选中时返回的值' }),
	label: Type.String({ description: '选项的显示标签' }),
	description: Type.Optional(Type.String({ description: '标签下方显示的可选描述' })),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: '此问题的唯一标识' }),
	label: Type.Optional(
		Type.String({
			description: "标签栏的简短上下文标签，例如 'Scope'、'Priority'（默认 Q1、Q2）",
		}),
	),
	prompt: Type.String({ description: '要显示的完整问题文本' }),
	options: Type.Array(QuestionOptionSchema, {
		description: '可供选择的选项',
	}),
	allowOther: Type.Optional(
		Type.Boolean({
			description: "允许 '输入其他' 选项（默认：true）",
		}),
	),
	multiSelect: Type.Optional(
		Type.Boolean({
			description:
				'是否允许多选（空格切换选择，Enter 确认；与 allowOther 同用时，"输入其他" 的自定义回答将作为该问题唯一答案，默认：false）',
		}),
	),
});

const QuestionnaireParams = Type.Object({
	questions: Type.Array(QuestionSchema, {
		description: '向用户提出的问题',
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
	let base: string;
	if (a.values && a.values.length > 0) {
		const items = a.indexes
			? a.indexes.map((idx, i) => `${idx}. ${a.labels?.[i] ?? a.values?.[i] ?? ''}`)
			: (a.labels ?? a.values);
		base = `${qLabel}: user selected: ${items.join(', ')}`;
	} else if (a.index) {
		base = `${qLabel}: user selected: ${a.index}. ${a.label}`;
	} else {
		base = `${qLabel}: user selected: ${a.label}`;
	}
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
		label: '问卷',
		description:
			'向用户提出一个或多个问题。单个问题时显示简单选项列表；多个问题时显示带导航与提交确认步骤的标签页界面。',
		parameters: QuestionnaireParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (ctx.mode !== 'tui') {
				return errorResult('错误：UI 不可用（正在非交互模式运行）');
			}
			if (params.questions.length === 0) {
				return errorResult('错误：未提供问题');
			}

			// Normalize questions with defaults
			const questions: Question[] = params.questions.map((q, i) => ({
				...q,
				label: q.label || `Q${i + 1}`,
				allowOther: q.allowOther !== false,
				multiSelect: q.multiSelect === true,
			}));

			// ── Single question without multi-select: delegate to showSelect ──
			const anyMultiSelect = questions.some((q) => q.multiSelect === true);
			if (questions.length === 1 && !anyMultiSelect) {
				return handleSingleQuestion(questions[0], ctx);
			}

			// ── Multi-select or multiple questions: custom tabbed UI ──
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
				return new Text(theme.fg('warning', '已取消'), 0, 0);
			}
			const lines = details.answers.map((a) => {
				if (a.wasCustom) {
					return `${theme.fg('success', '[OK] ')}${theme.fg('accent', a.id)}: ${theme.fg('muted', '(wrote) ')}${a.label}`;
				}
				let display: string;
				if (a.indexes && a.indexes.length > 0) {
					display = a.indexes
						.map((idx, i) => `${idx}. ${a.labels?.[i] ?? a.values?.[i] ?? ''}`)
						.join(', ');
				} else if (a.index) {
					display = `${a.index}. ${a.label}`;
				} else {
					display = a.label;
				}
				let result = `${theme.fg('success', '[OK] ')}${theme.fg('accent', a.id)}: ${display}`;
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
	ctx: ExtensionContext,
): Promise<{
	content: { type: 'text'; text: string }[];
	details: QuestionnaireResult;
	terminate?: boolean;
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
			terminate: true,
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
	ctx: ExtensionContext,
): Promise<{
	content: { type: 'text'; text: string }[];
	details: QuestionnaireResult;
	terminate?: boolean;
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
		let wrapMode = false;
		let cachedLines: string[] | undefined;
		const answers = new Map<string, Answer>();
		/** 多选模式：每个问题的已勾选选项下标集合 */
		const multiSelectedIndices = new Map<string, Set<number>>();

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
		const dialogCb = (globalThis as any).__piOnDialogChange;
		if (dialogCb) dialogCb(true);

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
				opts.push({ value: '__other__', label: '输入其他。', isOther: true });
			}
			return opts;
		}

		function allAnswered(): boolean {
			return questions.every((q) => answers.has(q.id));
		}

		function isMultiSelectQuestion(q?: Question): q is Question {
			return q?.multiSelect === true;
		}

		function toggledSetFor(q: Question): Set<number> {
			let set = multiSelectedIndices.get(q.id);
			if (!set) {
				set = new Set();
				multiSelectedIndices.set(q.id, set);
			}
			return set;
		}

		/** Track last-selected index per tab so returning preserves scroll position */
		const tabSelectedIndices = new Map<number, number>();

		function resolveTabSelectedIndex(tab: number): number {
			// If this question tab has an answer, jump to the answered option
			const q = questions[tab];
			if (q) {
				const answer = answers.get(q.id);
				if (answer) {
					const opts: RenderOption[] = [...q.options];
					if (q.allowOther) {
						opts.push({ value: '__other__', label: '输入其他。', isOther: true });
					}
					// If answer was custom, point to the "Type something." option
					if (answer.wasCustom) {
						const otherIdx = opts.findIndex((o) => o.isOther);
						if (otherIdx >= 0) return otherIdx;
					}
					// Multi-select: restore toggled set and jump to first selected option
					if (q.multiSelect && answer.indexes && answer.indexes.length > 0) {
						const set = toggledSetFor(q);
						set.clear();
						for (const idx of answer.indexes) {
							set.add(idx - 1);
						}
						return answer.indexes[0] - 1;
					}
					// Match by value
					const idx = opts.findIndex((o) => !o.isOther && o.value === answer.value);
					if (idx >= 0) return idx;
				}
			}
			// Fall back to last scroll position, or 0
			return tabSelectedIndices.get(tab) ?? 0;
		}

		function goToTab(tab: number) {
			// Save current scroll position before leaving
			tabSelectedIndices.set(currentTab, selectedIndex);
			currentTab = ((tab % totalTabs) + totalTabs) % totalTabs;
			selectedIndex = resolveTabSelectedIndex(currentTab);
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

		/**
		 * 保存当前问题的选择（单选：当前高亮项；多选：所有已勾选项）。
		 * 返回 false 表示多选模式下尚未勾选任何选项。
		 */
		function saveCurrentSelection(supplement?: string): boolean {
			const q = currentQuestion();
			if (!q) return false;
			const opts = currentOptions();
			if (q.multiSelect) {
				const set = toggledSetFor(q);
				const sorted = [...set]
					.filter((i) => i >= 0 && i < opts.length && !opts[i].isOther)
					.sort((a, b) => a - b);
				if (sorted.length === 0) return false;
				const values = sorted.map((i) => opts[i].value);
				const labels = sorted.map((i) => opts[i].label);
				const indexes = sorted.map((i) => i + 1);
				answers.set(q.id, {
					id: q.id,
					value: values.join(', '),
					label: labels.join(', '),
					values,
					labels,
					indexes,
					wasCustom: false,
					supplement,
				});
				return true;
			}
			const opt = opts[selectedIndex];
			if (!opt) return false;
			saveAnswer(q.id, opt.value, opt.label, false, supplement, selectedIndex + 1);
			return true;
		}

		// Editor submit callback for custom input (allowOther)
		editor.onSubmit = (value) => {
			if (!customInputQuestionId) return;
			const trimmed = value.trim() || '(no response)';
			saveAnswer(customInputQuestionId, trimmed, trimmed, true);
			// 多选问题：自定义文本即该问题的最终答案（覆盖勾选项，与单选 "输入其他"
			// 语义一致）。必须同步清空该问题的勾选集合，否则提交后回访时复选框仍按
			// 残留 set 渲染 [x]，与存储的 wasCustom 答案矛盾，再次 Enter 还会把
			// 已废弃的勾选项写回并覆盖自定义文本。
			const customQ = questions.find((qq) => qq.id === customInputQuestionId);
			if (customQ?.multiSelect) {
				multiSelectedIndices.get(customQ.id)?.clear();
			}
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
						supplementMode = false;
						supplementText = '';
						if (!saveCurrentSelection(supplement)) {
							refresh();
							return;
						}
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
			// Space toggles selection in multi-select mode
			if (isMultiSelectQuestion(q) && matchesKey(data, Key.space)) {
				const opt = opts[selectedIndex];
				if (!opt.isOther) {
					const set = toggledSetFor(q);
					if (set.has(selectedIndex)) {
						set.delete(selectedIndex);
					} else {
						set.add(selectedIndex);
					}
					refresh();
				}
				return;
			}
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
				// Multi-select: confirm all toggled options; single-select: confirm current
				if (!saveCurrentSelection()) {
					refresh();
					return;
				}
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

			// Ctrl+Shift+O toggle wrap/expand mode
			if (matchesKey(data, Key.ctrlShift('o'))) {
				wrapMode = !wrapMode;
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
			const multi = isMultiSelectQuestion(q);
			const toggled = multi ? toggledSetFor(q) : new Set<number>();

			const add = (s: string) => lines.push(truncateToWidth(s, width));
			// For content that should wrap (option descriptions)
			const addContent = (s: string, contIndent?: string) => {
				if (wrapMode || contIndent) {
					const indentWidth = contIndent ? visibleWidth(contIndent) : 0;
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

			// Top border（标题嵌入，ADR-0023）
			add(theme.fg('accent', topBorder('── questionnaire ', width)));

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
				const submitText = ' [确定] 提交 ';
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
				renderOptions(opts, selectedIndex, theme, add, addContent, true, multi, toggled);
				add('');
				add(theme.fg('muted', ' Your answer:'));
				for (const editorLine of editor.render(width - 2)) {
					add(` ${editorLine}`);
				}
				add('');
				add(theme.fg('dim', ' Enter 提交修改 · Esc 取消自定义输入'));
			} else if (supplementMode && q) {
				// ── Supplement mode (Tab) ──
				add(theme.fg('text', ` ${q.prompt}`));
				add('');
				renderOptions(opts, selectedIndex, theme, add, addContent, false, multi, toggled);
				add('');
				// Supplement input line
				const isEmpty = !supplementText;
				const placeholder = ' 输入额外信息给大模型...';
				const inputLine =
					theme.fg('dim', ' ┊ ') +
					(isEmpty ? theme.fg('dim', placeholder) : theme.fg('text', supplementText));
				add(inputLine);
				add('');
				add(theme.fg('dim', ' Enter 确认补充 · Esc 取消 · 输入内容'));
			} else if (currentTab === questions.length) {
				// ── Submit tab ──
				add(theme.fg('accent', theme.bold(' 准备提交')));
				add('');
				for (const question of questions) {
					const answer = answers.get(question.id);
					if (answer) {
						let prefix: string;
						let displayLabel: string;
						if (answer.wasCustom) {
							prefix = '(wrote) ';
							displayLabel = answer.label;
						} else if (answer.indexes && answer.indexes.length > 0) {
							prefix = '';
							displayLabel = answer.indexes
								.map(
									(idx, i) =>
										`${idx}. ${answer.labels?.[i] ?? answer.values?.[i] ?? ''}`,
								)
								.join(', ');
						} else {
							prefix = `${answer.index || '?'}. `;
							displayLabel = answer.label;
						}
						let line = `${theme.fg('muted', ` ${question.label}: `)}${theme.fg('text', prefix + displayLabel)}`;
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
					add(theme.fg('success', ' 按 Enter 提交 · Esc 取消'));
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
				renderOptions(opts, selectedIndex, theme, add, addContent, false, multi, toggled);
			}

			// Bottom help bar
			add('');
			if (customInputMode) {
				add(theme.fg('dim', ' Enter 提交 · Esc 取消 · 自由输入'));
			} else if (supplementMode) {
				add(theme.fg('dim', ' Enter 添加补充 · Esc 取消补充 · 自由输入'));
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
				const hint = multi
					? ' ↑ ↓ 移动 · 空格 多选 · ← → 切换问题 · Tab 补充 · Ctrl+Shift+O 展开 · Enter 确认 · Esc 取消'
					: ' ↑ ↓ select · ← → switch question · Tab supplement · Ctrl+Shift+O expand · Enter confirm · Esc cancel';
				add(theme.fg('dim', hint));
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
				const cb = (globalThis as any).__piOnDialogChange;
				if (cb) cb(false);
			},
		};
	});

	if (result.cancelled) {
		log.info('User cancelled multi-question questionnaire');
		return {
			content: [{ type: 'text', text: 'User cancelled the questionnaire' }],
			details: result,
			terminate: true,
		};
	}

	log.info('Multi-question completed with %d answers', result.answers.length);

	return {
		content: [{ type: 'text', text: buildContent(result.questions, result.answers) }],
		details: result,
	};
}

// ── Render options helper ──

/** 导出供 headless snapshot 测试使用（不依赖 pi 生命周期的纯渲染函数）。 */
export function renderOptions(
	opts: RenderOption[],
	selectedIndex: number,
	theme: any,
	add: (s: string) => void,
	addContent: (s: string, indent?: string) => void,
	showInputIndicator: boolean,
	multiSelect: boolean,
	toggled: Set<number>,
): void {
	for (let i = 0; i < opts.length; i++) {
		const opt = opts[i];
		const isSelected = i === selectedIndex;
		const isOther = opt.isOther === true;
		const isToggled = multiSelect && !isOther && toggled.has(i);
		const prefix = isSelected ? theme.fg('accent', ' › ') : '   ';
		const color = isSelected ? 'accent' : isToggled ? 'success' : 'text';
		const checkbox = multiSelect && !isOther ? (isToggled ? '[x] ' : '[ ] ') : '';
		const label = isOther
			? showInputIndicator
				? `${opt.label} [输入]`
				: opt.label
			: opt.label;
		add(`${prefix}${theme.fg(color, `${checkbox}${i + 1}. ${label}`)}`);
		if (opt.description) {
			addContent(`     ${theme.fg('muted', opt.description)}`, '     ');
		}
	}
}
