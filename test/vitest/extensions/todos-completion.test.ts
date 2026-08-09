/**
 * todos completion-detector — unit tests
 *
 * Covers:
 *   - detectCompletionIntent with English / Chinese / mixed completion phrases
 *   - detectCompletionIntent with non-completion text
 *   - buildCompletionReminder with no match / no pending todos / match + pending
 *   - extractLastAssistantText from agent_end messages
 */
import { describe, it, expect } from 'vitest';
import {
	detectCompletionIntent,
	buildCompletionReminder,
	extractLastAssistantText,
} from '../../../extensions/accuracy/todos/completion-detector.js';

// ── detectCompletionIntent ──────────────────────────

describe('detectCompletionIntent', () => {
	it('detects English completion phrases', () => {
		expect(detectCompletionIntent('All done! Ready for review.')).toBeGreaterThan(0);
	});

	it('detects single "done" keyword', () => {
		expect(detectCompletionIntent("That's done.")).toBe(1);
	});

	it('detects "completed"', () => {
		expect(detectCompletionIntent('Task completed successfully.')).toBe(1);
	});

	it('detects "finished"', () => {
		expect(detectCompletionIntent('I have finished the refactoring.')).toBe(1);
	});

	it('detects "fixed"', () => {
		expect(detectCompletionIntent('The bug is fixed now.')).toBe(1);
	});

	it('detects "resolved"', () => {
		// 'resolved' substring-matches both 'resolved' and 'solved' patterns
		expect(detectCompletionIntent('All issues resolved.')).toBeGreaterThanOrEqual(1);
	});

	it('detects "deployed"', () => {
		expect(detectCompletionIntent('The app has been deployed.')).toBe(1);
	});

	it('detects Chinese completion phrases', () => {
		expect(detectCompletionIntent('这些都已经完成了，没有其他问题了。')).toBeGreaterThan(0);
	});

	it('detects "搞定了"', () => {
		// '搞定了' substring-matches both '搞定' and '搞定了' patterns
		expect(detectCompletionIntent('搞定了！')).toBeGreaterThanOrEqual(1);
	});

	it('detects "做完了"', () => {
		expect(detectCompletionIntent('全部做完了。')).toBe(1);
	});

	it('detects "提交了"', () => {
		expect(detectCompletionIntent('代码已经提交了。')).toBe(1);
	});

	it('detects "合并了"', () => {
		expect(detectCompletionIntent('PR 合并了。')).toBe(1);
	});

	it('detects "修复了"', () => {
		expect(detectCompletionIntent('bug 修复了。')).toBe(1);
	});

	it('detects "发布了"', () => {
		expect(detectCompletionIntent('新版本发布了。')).toBe(1);
	});

	it('detects "已部署"', () => {
		expect(detectCompletionIntent('已部署到生产环境。')).toBe(1);
	});

	it('returns 0 for non-completion text', () => {
		expect(detectCompletionIntent('I need help with something.')).toBe(0);
	});

	it('returns 0 for empty string', () => {
		expect(detectCompletionIntent('')).toBe(0);
	});

	it('returns 0 for a question', () => {
		expect(detectCompletionIntent('Can you explain how this works?')).toBe(0);
	});

	it('returns 0 for error message', () => {
		expect(
			detectCompletionIntent('Error: something went wrong during the build process.'),
		).toBe(0);
	});

	it('detects multiple completion keywords', () => {
		const score = detectCompletionIntent('All done! The fix is deployed and the PR is merged.');
		expect(score).toBeGreaterThanOrEqual(4); // done, fixed, deployed, merged
	});

	it('is case-insensitive', () => {
		expect(detectCompletionIntent('DONE')).toBe(1);
		expect(detectCompletionIntent('Fixed')).toBe(1);
	});

	it('matches substrings (e.g., "fixed" in "prefixed")', () => {
		// "fixed" appears inside "prefixed" — this is a substring match
		expect(detectCompletionIntent('The name is prefixed with xyz.')).toBe(1);
	});
});

// ── buildCompletionReminder ─────────────────────────

describe('buildCompletionReminder', () => {
	const pendingTodos = [
		{ id: 'aaa', title: 'Add login page', status: 'open' },
		{ id: 'bbb', title: 'Fix navbar bug', status: 'open' },
	];

	it('returns null when no completion intent detected', () => {
		const result = buildCompletionReminder('Let me check that...', pendingTodos);
		expect(result).toBeNull();
	});

	it('returns null when completion detected but no pending todos', () => {
		const result = buildCompletionReminder('All done!', [
			{ id: 'ccc', title: 'Old task', status: 'done' },
		]);
		expect(result).toBeNull();
	});

	it('returns null when all todos are soft-deleted', () => {
		const result = buildCompletionReminder('All done!', [
			{ id: 'eee', title: 'Hidden task', status: 'close' },
		]);
		expect(result).toBeNull();
	});

	it('returns null when completion detected but todos are "done" status', () => {
		const result = buildCompletionReminder('All done!', [
			{ id: 'ddd', title: 'Old task', status: 'done' },
		]);
		expect(result).toBeNull();
	});

	it('generates reminder with pending todo references', () => {
		const result = buildCompletionReminder('All done! Ready for review.', pendingTodos);
		expect(result).not.toBeNull();
		expect(result).toContain('TODO-aaa');
		expect(result).toContain('TODO-bbb');
		expect(result).toContain('Add login page');
		expect(result).toContain('Fix navbar bug');
		expect(result).toContain('todo 工具标记为完成');
	});

	it('filters out close todos from reminder', () => {
		const mixedTodos = [
			{ id: 'aaa', title: 'Add login page', status: 'open' },
			{ id: 'bbb', title: 'Fix navbar bug', status: 'close' },
		];
		const result = buildCompletionReminder('All done!', mixedTodos);
		expect(result).not.toBeNull();
		expect(result).toContain('TODO-aaa');
		expect(result).not.toContain('TODO-bbb');
	});

	it('handles empty todo list', () => {
		const result = buildCompletionReminder('All done!', []);
		expect(result).toBeNull();
	});

	it('handles Chinese completion with pending todos', () => {
		const result = buildCompletionReminder('全部完成了。', pendingTodos);
		expect(result).not.toBeNull();
		expect(result).toContain('Add login page');
	});

	it('limits displayed todos to 3 with "and N more" suffix', () => {
		const manyTodos = [
			{ id: 'aaa', title: 'Task 1', status: 'open' },
			{ id: 'bbb', title: 'Task 2', status: 'open' },
			{ id: 'ccc', title: 'Task 3', status: 'open' },
			{ id: 'ddd', title: 'Task 4', status: 'open' },
			{ id: 'eee', title: 'Task 5', status: 'open' },
		];
		const result = buildCompletionReminder('All done!', manyTodos);
		expect(result).not.toBeNull();
		// Should only mention first 3 by title
		expect(result).toContain('Task 1');
		expect(result).toContain('Task 2');
		expect(result).toContain('Task 3');
		expect(result).not.toContain('Task 4');
		expect(result).not.toContain('Task 5');
		// Should mention count and "more"
		expect(result).toContain('5 个 todo 未关闭');
		expect(result).toContain('等2个');
	});

	it('does not add "等N个" when todos <= 3', () => {
		const result = buildCompletionReminder('All done! Ready for review.', pendingTodos);
		expect(result).not.toBeNull();
		expect(result).not.toContain('等');
	});
});

// ── extractLastAssistantText ────────────────────────

describe('extractLastAssistantText', () => {
	it('extracts string content from last assistant message', () => {
		const messages = [
			{ role: 'user', content: 'hello' },
			{ role: 'assistant', content: 'All done! The feature is complete.' },
		];
		expect(extractLastAssistantText(messages)).toBe('All done! The feature is complete.');
	});

	it('extracts from ContentBlock array', () => {
		const messages = [
			{ role: 'user', content: 'help' },
			{
				role: 'assistant',
				content: [{ type: 'text', text: 'Here is the fix.' }],
			},
		];
		expect(extractLastAssistantText(messages)).toBe('Here is the fix.');
	});

	it('joins multiple text blocks', () => {
		const messages = [
			{ role: 'user', content: 'help' },
			{
				role: 'assistant',
				content: [
					{ type: 'text', text: 'Line one.' },
					{ type: 'text', text: 'Line two.' },
				],
			},
		];
		expect(extractLastAssistantText(messages)).toBe('Line one.\nLine two.');
	});

	it('only extracts LAST assistant message (not earlier ones)', () => {
		const messages = [
			{ role: 'assistant', content: 'First response' },
			{ role: 'user', content: 'more' },
			{ role: 'assistant', content: 'Second response' },
		];
		expect(extractLastAssistantText(messages)).toBe('Second response');
	});

	it('returns null when no assistant messages', () => {
		const messages = [{ role: 'user', content: 'hello' }];
		expect(extractLastAssistantText(messages)).toBeNull();
	});

	it('returns null for empty messages array', () => {
		expect(extractLastAssistantText([])).toBeNull();
	});

	it('handles null/undefined messages gracefully', () => {
		expect(extractLastAssistantText(null as any)).toBeNull();
		expect(extractLastAssistantText(undefined as any)).toBeNull();
	});

	it('skips assistant messages with null content', () => {
		const messages = [
			{ role: 'assistant', content: null },
			{ role: 'assistant', content: 'Real response' },
		];
		expect(extractLastAssistantText(messages)).toBe('Real response');
	});

	it('finds earlier text when last assistant message has null content (tool_calls)', () => {
		// Regression test for P1: when the most recent assistant message
		// has content:null (e.g. tool_calls only), scan earlier messages.
		const messages = [
			{ role: 'assistant', content: 'All done! The fix is deployed.' },
			{ role: 'assistant', content: null }, // tool_calls, no text
		];
		expect(extractLastAssistantText(messages)).toBe('All done! The fix is deployed.');
	});

	it('trims whitespace', () => {
		const messages = [{ role: 'assistant', content: '  done.  ' }];
		expect(extractLastAssistantText(messages)).toBe('done.');
	});
});
