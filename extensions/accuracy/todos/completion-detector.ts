/**
 * BM25-style keyword detection for task completion.
 * Scans LLM responses for task-completion-related semantic patterns.
 * When matched, injects a passive reminder to close/release the todo.
 */

import { createLogger } from '@zenone/pi-logger';

const log = createLogger('todos:completion');

// Completion-related keywords/phrases (BM25-like term frequency matching)
const COMPLETION_PATTERNS = [
	// English
	'done',
	'completed',
	'finished',
	'all done',
	'all set',
	'wrapped up',
	'wrapping up',
	'that should be it',
	'that is it',
	"that's it",
	'no more changes',
	'ready to go',
	'ready for review',
	'pull request',
	'pr is ready',
	'pr created',
	'pr submitted',
	'merged',
	'deployed',
	'released',
	'fixed',
	'resolved',
	'solved',
	// Chinese
	'完成了',
	'已完成',
	'已完',
	'已结束',
	'搞定',
	'搞定了',
	'做完了',
	'结束',
	'可以了',
	'没有其他问题了',
	'没有其他事情',
	'没什么了',
	'就这些',
	'提交了',
	'合并了',
	'修复了',
	'发布了',
	'已部署',
];

/**
 * Check if a text contains completion-related keywords.
 * Returns the number of matched keywords (BM25-like TF scoring).
 */
export function detectCompletionIntent(text: string): number {
	if (!text) return 0;

	const lower = text.toLowerCase();
	let matchCount = 0;

	for (const pattern of COMPLETION_PATTERNS) {
		const idx = lower.indexOf(pattern.toLowerCase());
		if (idx !== -1) {
			matchCount++;
			log.debug('completion pattern matched: "%s" at position %d', pattern, idx);
		}
	}

	return matchCount;
}

/**
 * Build a passive reminder for the agent about open todos.
 * Only returns non-empty string if the LLM response indicates completion intent.
 */
export function buildCompletionReminder(
	llmResponse: string,
	openTodos: Array<{ id: string; title: string; status: string }>,
): string | null {
	const matchScore = detectCompletionIntent(llmResponse);

	if (matchScore === 0) return null;

	const pendingTodos = openTodos.filter(
		(t) => !['closed', 'done'].includes(t.status.toLowerCase()),
	);

	if (pendingTodos.length === 0) return null;

	log.info(
		'completion intent detected (score=%d), %d pending todos',
		matchScore,
		pendingTodos.length,
	);

	const todoRefs = pendingTodos.map((t) => `${t.id} "${t.title}"`).join(', ');

	return (
		`[Note: It looks like you may have completed some tasks. ` +
		`The following todos are still open: ${todoRefs}. ` +
		`If any are done, please close them using the todo tool.]`
	);
}
