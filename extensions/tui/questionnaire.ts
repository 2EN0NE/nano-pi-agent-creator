/**
 * Questionnaire Tool - Unified tool for asking single or multiple questions
 *
 * Each question is presented via the shared @zenone/pi-selector, which provides:
 * - ↑↓ option navigation, Enter to confirm, Esc to cancel
 * - Tab supplement input (extra info to LLM)
 * - Ctrl+O to expand/collapse long detail
 * - isSelecting() signal for tmux border color integration
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { showSelect } from "@zenone/pi-selector";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createLogger } from "@zenone/pi-logger";

const log = createLogger("questionnaire");

log.debug("Extension loaded");

// Types
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
	index?: number;
}

interface QuestionnaireResult {
	questions: Question[];
	answers: Answer[];
	cancelled: boolean;
}

// Schema
const QuestionOptionSchema = Type.Object({
	value: Type.String({ description: "The value returned when selected" }),
	label: Type.String({ description: "Display label for the option" }),
	description: Type.Optional(
		Type.String({ description: "Optional description shown below label" }),
	),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Unique identifier for this question" }),
	label: Type.Optional(
		Type.String({
			description:
				"Short contextual label for tab bar, e.g. 'Scope', 'Priority' (defaults to Q1, Q2)",
		}),
	),
	prompt: Type.String({ description: "The full question text to display" }),
	options: Type.Array(QuestionOptionSchema, {
		description: "Available options to choose from",
	}),
	allowOther: Type.Optional(
		Type.Boolean({
			description: "Allow 'Type something' option (default: true)",
		}),
	),
});

const QuestionnaireParams = Type.Object({
	questions: Type.Array(QuestionSchema, {
		description: "Questions to ask the user",
	}),
});

function errorResult(
	message: string,
	questions: Question[] = [],
): {
	content: { type: "text"; text: string }[];
	details: QuestionnaireResult;
} {
	return {
		content: [{ type: "text", text: message }],
		details: { questions, answers: [], cancelled: true },
	};
}

export default function questionnaire(pi: ExtensionAPI) {
	pi.registerTool({
		name: "questionnaire",
		label: "Questionnaire",
		description:
			"Ask the user one or more questions. For single questions, shows a simple option list. For multiple questions, shows them one at a time in sequence. Each question supports Tab to provide supplementary info.",
		parameters: QuestionnaireParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (ctx.mode !== "tui") {
				return errorResult(
					"Error: UI not available (running in non-interactive mode)",
				);
			}
			if (params.questions.length === 0) {
				return errorResult("Error: No questions provided");
			}

			// Normalize questions with defaults
			const questions: Question[] = params.questions.map((q, i) => ({
				...q,
				label: q.label || `Q${i + 1}`,
				allowOther: q.allowOther !== false,
			}));

			const answers: Answer[] = [];

			for (let qi = 0; qi < questions.length; qi++) {
				const q = questions[qi];
				const options = q.options.map((o) => ({
					value: o.value,
					label: o.label,
					description: o.description,
				}));

				const progress =
					questions.length > 1 ? ` (${qi + 1}/${questions.length})` : "";
				const title = `${q.prompt}${progress}`;

				const result = await showSelect(ctx, title, options, {
					allowOther: q.allowOther,
					otherPlaceholder: "输入自定义答案...",
				});

				if (result === null) {
					// User cancelled (Esc)
					log.info(
						"User cancelled questionnaire at question %s/%s",
						qi + 1,
						questions.length,
					);
					return {
						content: [
							{ type: "text", text: "User cancelled the questionnaire" },
						],
						details: { questions, answers, cancelled: true },
					};
				}

				const answerIndex = result.supplement
					? undefined
					: options.findIndex((o) => o.value === result.value) + 1;
				answers.push({
					id: q.id,
					value: result.value,
					label: result.label,
					wasCustom: !!result.supplement,
					index:
						answerIndex !== undefined && answerIndex > 0
							? answerIndex
							: undefined,
				});

				log.info(
					"Question %s/%s answered: %s",
					qi + 1,
					questions.length,
					result.label,
				);
			}

			const answerLines = answers.map((a) => {
				const qLabel = questions.find((q) => q.id === a.id)?.label || a.id;
				if (a.wasCustom) {
					return `${qLabel}: user wrote: ${a.label}`;
				}
				return `${qLabel}: user selected: ${a.index}. ${a.label}`;
			});

			log.info("Questionnaire completed with %d answers", answers.length);

			return {
				content: [{ type: "text", text: answerLines.join("\n") }],
				details: { questions, answers, cancelled: false },
			};
		},

		renderCall(args, theme, _context) {
			const qs = (args.questions as Question[]) || [];
			const count = qs.length;
			const labels = qs.map((q) => q.label || q.id).join(", ");
			let text = theme.fg("toolTitle", theme.bold("questionnaire "));
			text += theme.fg("muted", `${count} question${count !== 1 ? "s" : ""}`);
			if (labels) {
				text += theme.fg("dim", ` (${truncateToWidth(labels, 40)})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as QuestionnaireResult | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}
			const lines = details.answers.map((a) => {
				if (a.wasCustom) {
					return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${theme.fg("muted", "(wrote) ")}${a.label}`;
				}
				const display = a.index ? `${a.index}. ${a.label}` : a.label;
				return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${display}`;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
