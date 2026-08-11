/**
 * Sentence-level completion detection for task completion reminders.
 *
 * Pipeline (inspired by pi-thinking-steps event-driven approach):
 *   1. Split LLM response into sentences (Chinese + English punctuation)
 *   2. Classify each sentence by event type
 *   3. Weighted scoring with negation hard-veto
 *   4. Only trigger when score >= threshold AND session has pending todos
 */

import { createLogger } from '@zenone/pi-logger';
import { isTodoDone, isTodoClosed } from './storage.js';

const log = createLogger('todos:completion');

// ── Completion keywords (Chinese + English) ──────────

const COMPLETION_KEYWORDS = [
	// English — strong completion signals
	'done',
	'completed',
	'finished',
	'all set',
	'wrapped up',
	'ready for review',
	'merged',
	'deployed',
	'released',
	'resolved',
	'solved',
	// English — weaker signals (might appear in non-completion context)
	'fixed',
	'ready to go',
	'no more changes',
	// Chinese — strong completion signals
	'完成了',
	'已完',
	'已结束',
	'搞定',
	'做完了',
	'结束了',
	'提交了',
	'合并了',
	'修复了',
	'发布了',
	'已部署',
	// Chinese — weaker signals
	'可以了',
	'没什么了',
	'就这些',
	'没有其他问题了',
];

/** Keywords that in isolation are weak but gain weight when multiple appear. */
const WEAK_COMPLETION_KEYWORDS = new Set([
	'fixed',
	'ready to go',
	'no more changes',
	'可以了',
	'没什么了',
	'就这些',
	'没有其他问题了',
]);

// ── Negation detection ───────────────────────────────

/** English negation words that precede a completion keyword. */
const EN_NEGATION_PRECEDERS =
	/\b(?:not|never|no|don't|doesn't|didn't|haven't|hasn't|hadn't|won't|wouldn't|shouldn't|cannot|can't)\s+/i;

/** Chinese negation characters that precede a completion keyword. */
const CN_NEGATION_PRECEDERS = /[不没未非别]/;

/** Pre-completion negation: "not done", "没完成", "还没...完" */
const NEGATION_PHRASE_RE =
	/\b(?:not\s+(?:yet\s+)?|never\s+)(?:done|completed|finished|resolved|fixed|merged|deployed|released)\b/i;

/** Chinese negation phrases before completion signals. */
const CN_NEGATION_PHRASES = [
	/不(?:会|能|会再|要|该|应|必)/,
	/没(?:有|能)?(?:做|完|完成|结束|搞定|提交|合并|修复|发布|部署)/,
	/未(?:能|有)?(?:做|完|完成|结束|搞定|提交|合并|修复|发布|部署)/,
	/还没(?:有)?(?:做|完|完成|结束)/,
	/尚未(?:做|完|完成|结束)/,
	/无法(?:做|完|完成|结束)/,
];

// ── Question detection ───────────────────────────────

const QUESTION_RE = /[?？]$/;
const CN_QUESTION_MARKERS = /[吗呢][。！？]?$|[?？]/;

// ── Meta-reference detection ─────────────────────────
// Model is talking about the todo system itself, not declaring completion.

const META_REFERENCE_PATTERNS = [
	/\b(?:todo|TODO)[-\s]+(?:TODO-)?[a-f0-9]+\s+(?:is|was)\s+(?:done|completed|closed|open)/i,
	/\bthe\s+todo\s+(?:is|was|status|states?)\b/i,
	/\bmarked\s+(?:as|the\s+todo)/i,
	/\b(?:close|mark|update|set)\s+(?:the\s+)?todo/i,
	// Chinese
	/(?:todo|TODO)[-\s]+(?:TODO-)?[a-f0-9]+\s*(?:的)?状态/,
	/标记(?:为|了)?(?:完成|已完)/,
	/把\s*(?:todo|TODO)\s*(?:标记|设为)/i,
];

// ── Conditional / future-tense detection ──────────────

const CONDITIONAL_START_RE = /^(?:if|once|when|after|一旦|如果|假如|要是|等|等[到会]|当)/i;

// ── Sentence splitting ───────────────────────────────

/**
 * Split text into sentences, handling both English (.!?) and Chinese (。！？) punctuation.
 */
function splitSentences(text: string): string[] {
	// Split on sentence-ending punctuation, keeping the delimiter with its sentence
	const parts = text.split(/(?<=[.!?。！？\n])\s*/);
	return parts.map((s) => s.trim()).filter((s) => s.length > 0);
}

// ── Sentence classification ──────────────────────────

type SentenceEvent =
	| { type: 'completion_declaration'; weight: number }
	| { type: 'negation' }
	| { type: 'question' }
	| { type: 'meta_reference' }
	| { type: 'conditional' }
	| { type: 'none' };

/**
 * Check if a completion keyword appears in the sentence with a preceding negation.
 * Handles both English ("not done") and Chinese ("没完成").
 */
function hasNegationBeforeKeyword(sentence: string, keywordIndex: number): boolean {
	// Look back up to 30 chars before the keyword
	const start = Math.max(0, keywordIndex - 30);
	const preceding = sentence.slice(start, keywordIndex);

	// English negation
	if (EN_NEGATION_PRECEDERS.test(preceding)) return true;

	// Chinese negation: check the character immediately before and nearby
	const cnContext = sentence.slice(Math.max(0, keywordIndex - 10), keywordIndex);
	for (const re of CN_NEGATION_PHRASES) {
		if (re.test(cnContext)) return true;
	}

	// Simple character-level check: 不/没/未 right before the keyword
	const charBefore = sentence[keywordIndex - 1] || '';
	if (CN_NEGATION_PRECEDERS.test(charBefore)) return true;

	return false;
}

/**
 * Classify a single sentence by scanning for completion keywords and context.
 */
function classifySentence(sentence: string): SentenceEvent {
	const lower = sentence.toLowerCase();

	// 1. Question check
	if (QUESTION_RE.test(sentence) || CN_QUESTION_MARKERS.test(sentence)) {
		return { type: 'question' };
	}

	// 2. Meta-reference check
	for (const re of META_REFERENCE_PATTERNS) {
		if (re.test(sentence)) return { type: 'meta_reference' };
	}

	// 3. Negation phrase check (whole-sentence patterns like "not done")
	if (NEGATION_PHRASE_RE.test(lower)) return { type: 'negation' };

	// 4. Conditional check
	if (CONDITIONAL_START_RE.test(sentence)) return { type: 'conditional' };

	// 5. Scan for completion keywords — prefer strongest signal over earliest position
	let bestKeyword = '';
	let bestIndex = -1;
	let hasStrong = false;
	let hasWeak = false;

	for (const kw of COMPLETION_KEYWORDS) {
		const idx = lower.indexOf(kw.toLowerCase());
		if (idx === -1) continue;
		if (bestIndex === -1 || idx < bestIndex) {
			bestKeyword = kw;
			bestIndex = idx;
		}
		if (WEAK_COMPLETION_KEYWORDS.has(kw)) hasWeak = true;
		else hasStrong = true;
	}

	if (bestIndex === -1) return { type: 'none' };

	// Check for negation before the earliest keyword occurrence
	if (hasNegationBeforeKeyword(sentence, bestIndex)) {
		log.debug('completion keyword "%s" negated in: %s', bestKeyword, sentence.substring(0, 80));
		return { type: 'negation' };
	}

	// Completion declaration found — strong signal wins over weak
	const weight = hasStrong ? 3 : hasWeak ? 1 : 0;
	log.debug(
		'completion declaration: "%s" (weight=%d) in: %s',
		bestKeyword,
		weight,
		sentence.substring(0, 80),
	);
	return { type: 'completion_declaration', weight };
}

// ── Scoring ──────────────────────────────────────────

const SCORE_THRESHOLD = 2;

/**
 * Calculate completion confidence score from classified sentences.
 * Any negation sentence → hard veto (returns 0).
 */
function calculateScore(events: SentenceEvent[]): number {
	let total = 0;

	for (const event of events) {
		switch (event.type) {
			case 'negation':
				// Hard veto: if model says "not done", skip entirely
				return 0;
			case 'completion_declaration':
				total += event.weight;
				break;
			case 'question':
			case 'meta_reference':
			case 'conditional':
				// Neutral — don't count, don't penalize
				break;
			case 'none':
				break;
		}
	}

	return total;
}

// ── Public API ───────────────────────────────────────

/**
 * Analyze LLM response for completion intent using sentence-level event classification.
 * Returns a confidence score (0 = no completion intent, higher = stronger).
 */
export function detectCompletionIntent(text: string): number {
	if (!text) return 0;

	const sentences = splitSentences(text);
	if (sentences.length === 0) return 0;

	// Only analyze the last 5 sentences (most recent thoughts)
	const relevant = sentences.slice(-5);
	const events = relevant.map(classifySentence);

	return calculateScore(events);
}

/**
 * Build a passive reminder for the agent about open todos.
 * Returns null if:
 *   - No completion intent detected (score < threshold)
 *   - No pending todos among the given list
 */
export function buildCompletionReminder(
	llmResponse: string,
	openTodos: Array<{ id: string; title: string; status: string }>,
): string | null {
	const score = detectCompletionIntent(llmResponse);

	if (score < SCORE_THRESHOLD) return null;

	const pendingTodos = openTodos.filter((t) => !isTodoDone(t.status) && !isTodoClosed(t.status));

	if (pendingTodos.length === 0) return null;

	log.info('completion intent detected (score=%d), %d pending todos', score, pendingTodos.length);

	const displayTodos = pendingTodos.slice(0, 3);
	const todoRefs = displayTodos.map((t) => `TODO-${t.id} "${t.title}"`).join(', ');
	const suffix = pendingTodos.length > 3 ? ` 等${pendingTodos.length - 3}个` : '';

	return (
		`你提到完成了一些工作，但还有 ${pendingTodos.length} 个 todo 未关闭：${todoRefs}${suffix}。` +
		`如果其中确实有已完成的，请用 todo 工具标记为完成。`
	);
}

// ── Last assistant text extraction ─────────────────

const isTextPart = (part: unknown): part is { type: 'text'; text: string } =>
	Boolean(
		part &&
		typeof part === 'object' &&
		'type' in part &&
		(part as Record<string, unknown>).type === 'text' &&
		'text' in part,
	);

/**
 * Extract the last assistant message text from agent_end event messages.
 * Handles both string content and ContentBlock[] (multi-modal) formats.
 */
export function extractLastAssistantText(
	messages: Array<{ role?: string; content?: unknown }> | null | undefined,
): string | null {
	if (!messages) return null;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== 'assistant') continue;

		const content = message.content;
		if (typeof content === 'string') {
			return content.trim() || null;
		}

		if (Array.isArray(content)) {
			const text = content
				.filter(isTextPart)
				.map((part) => part.text)
				.join('\n')
				.trim();
			return text || null;
		}

		// content is neither string nor array (e.g. null for tool_calls) —
		// continue scanning earlier assistant messages
	}
	return null;
}
