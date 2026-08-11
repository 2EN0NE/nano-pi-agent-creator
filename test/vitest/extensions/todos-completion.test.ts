/**
 * todos completion-detector — unit tests (sentence-level event classification)
 *
 * Covers:
 *   - detectCompletionIntent: sentence-level with negation / question / meta / conditional handling
 *   - buildCompletionReminder: threshold gating + display limits
 *   - extractLastAssistantText: message extraction
 */
import { describe, it, expect } from 'vitest';
import {
	detectCompletionIntent,
	buildCompletionReminder,
	extractLastAssistantText,
} from '../../../extensions/accuracy/todos/completion-detector.js';

// ── detectCompletionIntent — basic detection ─────────

describe('detectCompletionIntent — declaration detection', () => {
	it('detects single strong completion keyword (score >= threshold)', () => {
		expect(detectCompletionIntent('All done! Ready for review.')).toBeGreaterThanOrEqual(2);
	});

	it('detects "completed"', () => {
		expect(detectCompletionIntent('Task completed successfully.')).toBeGreaterThanOrEqual(2);
	});

	it('detects "finished"', () => {
		expect(detectCompletionIntent('I have finished the refactoring.')).toBeGreaterThanOrEqual(
			2,
		);
	});

	it('detects Chinese completion: 完成了', () => {
		expect(detectCompletionIntent('这些都已经完成了。')).toBeGreaterThanOrEqual(2);
	});

	it('detects Chinese completion: 搞定了', () => {
		expect(detectCompletionIntent('搞定了！')).toBeGreaterThanOrEqual(2);
	});

	it('detects Chinese completion: 做完了', () => {
		expect(detectCompletionIntent('全部做完了。')).toBeGreaterThanOrEqual(2);
	});

	it('detects Chinese completion: 提交了', () => {
		expect(detectCompletionIntent('代码已经提交了。')).toBeGreaterThanOrEqual(2);
	});

	it('detects multiple strong keywords cumulatively', () => {
		const score = detectCompletionIntent('All done! The fix is deployed and the PR is merged.');
		expect(score).toBeGreaterThanOrEqual(4);
	});

	it('returns 0 for non-completion text', () => {
		expect(detectCompletionIntent('I need help with something.')).toBe(0);
	});

	it('returns 0 for empty string', () => {
		expect(detectCompletionIntent('')).toBe(0);
	});
});

// ── detectCompletionIntent — negation ────────────────

describe('detectCompletionIntent — negation (hard veto)', () => {
	it('returns 0 for "not done"', () => {
		expect(detectCompletionIntent('I am not done yet.')).toBe(0);
	});

	it('returns 0 for "not completed"', () => {
		expect(detectCompletionIntent('This is not completed.')).toBe(0);
	});

	it('returns 0 for "never finished"', () => {
		expect(detectCompletionIntent('I never finished that task.')).toBe(0);
	});

	it('returns 0 for Chinese negation: 没完成', () => {
		expect(detectCompletionIntent('还没完成。')).toBe(0);
	});

	it('returns 0 for Chinese negation: 没做完', () => {
		expect(detectCompletionIntent('这个没做完，还需要继续。')).toBe(0);
	});

	it('returns 0 when completion keyword appears but another sentence negates', () => {
		// "All done!" is in one sentence, but "not done" in another → veto
		expect(detectCompletionIntent('Part A is done. Part B is not done.')).toBe(0);
	});

	it('returns 0 for "尚未完成" (Chinese formal negation)', () => {
		expect(detectCompletionIntent('该功能尚未完成。')).toBe(0);
	});

	it('returns 0 for "无法完成" (Chinese inability negation)', () => {
		expect(detectCompletionIntent('由于权限问题无法完成。')).toBe(0);
	});
});

// ── detectCompletionIntent — question ────────────────

describe('detectCompletionIntent — question handling', () => {
	it('ignores completion keyword in a question', () => {
		expect(detectCompletionIntent('Is this done?')).toBe(0);
	});

	it('ignores Chinese question with 吗', () => {
		expect(detectCompletionIntent('这个完成了吗？')).toBe(0);
	});

	it('does NOT treat 啊/吧/呀 as question markers (statements)', () => {
		// "搞定了啊" is a completion statement, not a question
		expect(detectCompletionIntent('搞定了啊！')).toBeGreaterThanOrEqual(2);
	});

	it('does NOT treat 吧 as question marker (statement)', () => {
		// 就这些 is weak (weight 1) but should NOT be zeroed out by 吧
		expect(detectCompletionIntent('就这些吧。')).toBeGreaterThan(0);
	});
});

// ── detectCompletionIntent — weak keywords ───────────

describe('detectCompletionIntent — weak keywords', () => {
	it('single weak keyword does not reach threshold', () => {
		// "fixed" is weak (weight=1), score=1 < threshold=2
		expect(detectCompletionIntent('The bug is fixed.')).toBeLessThan(2);
	});

	it('two weak keywords can reach threshold', () => {
		const score = detectCompletionIntent('The bug is fixed. No more changes needed.');
		expect(score).toBeGreaterThanOrEqual(2);
	});

	it('single Chinese weak keyword: 可以了', () => {
		// "可以了" is weak (weight=1), score=1 < threshold=2
		expect(detectCompletionIntent('可以了。')).toBeLessThan(2);
	});

	it('weak + strong combo reaches threshold', () => {
		const score = detectCompletionIntent('The bug is fixed. All done!');
		expect(score).toBeGreaterThanOrEqual(3);
	});

	it('strongest signal wins even when weak keyword appears first', () => {
		// "fixed" (weak) comes before "all done" (strong) in the same sentence
		const score = detectCompletionIntent('I fixed the bug, all done!');
		expect(score).toBeGreaterThanOrEqual(3);
	});
});

// ── detectCompletionIntent — meta reference ──────────

describe('detectCompletionIntent — meta reference filtering', () => {
	it('ignores "the todo is done" (talking about todo status itself)', () => {
		expect(detectCompletionIntent('The todo TODO-abc is done.')).toBe(0);
	});

	it('ignores "marked as done" (talking about marking action)', () => {
		expect(detectCompletionIntent('I marked the todo as done.')).toBe(0);
	});

	it('ignores Chinese meta reference: 状态', () => {
		expect(detectCompletionIntent('TODO-abc 的状态是 done。')).toBe(0);
	});
});

// ── detectCompletionIntent — conditional ─────────────

describe('detectCompletionIntent — conditional context', () => {
	it('ignores "once ... done" (conditional)', () => {
		expect(detectCompletionIntent('Once the tests pass, it will be done.')).toBeLessThan(2);
	});

	it('ignores Chinese conditional: 一旦...完成', () => {
		expect(detectCompletionIntent('一旦测试通过就完成了。')).toBeLessThan(2);
	});
});

// ── detectCompletionIntent — mixed scenarios ─────────

describe('detectCompletionIntent — mixed scenarios', () => {
	it('completion in one sentence, non-completion in another', () => {
		expect(detectCompletionIntent('Let me check something. All done!')).toBeGreaterThanOrEqual(
			2,
		);
	});

	it('only considers last 5 sentences', () => {
		const long = 'Line 1. Line 2. Line 3. Line 4. Line 5. All done!';
		// "All done!" is the 6th sentence, still in last 5
		expect(detectCompletionIntent(long)).toBeGreaterThanOrEqual(2);
	});

	it('completion buried far back is ignored', () => {
		const long = 'All done! Line 2. Line 3. Line 4. Line 5. Line 6. Line 7. Line 8.';
		// "All done!" is sentence 1, which is beyond last 5 (sentences 4-8)
		expect(detectCompletionIntent(long)).toBe(0);
	});

	it('handles real-world Chinese multi-sentence response', () => {
		const text = '让我检查一下代码。嗯，看起来所有改动都已经完成了。没有其他需要修改的地方了。';
		expect(detectCompletionIntent(text)).toBeGreaterThanOrEqual(2);
	});
});

// ── buildCompletionReminder ──────────────────────────

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

	it('limits displayed todos to 3 with "等N个" suffix', () => {
		const manyTodos = [
			{ id: 'aaa', title: 'Task 1', status: 'open' },
			{ id: 'bbb', title: 'Task 2', status: 'open' },
			{ id: 'ccc', title: 'Task 3', status: 'open' },
			{ id: 'ddd', title: 'Task 4', status: 'open' },
			{ id: 'eee', title: 'Task 5', status: 'open' },
		];
		const result = buildCompletionReminder('All done!', manyTodos);
		expect(result).not.toBeNull();
		expect(result).toContain('Task 1');
		expect(result).toContain('Task 2');
		expect(result).toContain('Task 3');
		expect(result).not.toContain('Task 4');
		expect(result).not.toContain('Task 5');
		expect(result).toContain('5 个 todo 未关闭');
		expect(result).toContain('等2个');
	});

	it('does not add "等N个" when todos <= 3', () => {
		const result = buildCompletionReminder('All done! Ready for review.', pendingTodos);
		expect(result).not.toBeNull();
		expect(result).not.toContain('等');
	});

	it('returns null when weak keyword below threshold', () => {
		// Single "fixed" = score 1, below threshold 2
		const result = buildCompletionReminder('The bug is fixed.', pendingTodos);
		expect(result).toBeNull();
	});
});

// ── extractLastAssistantText ─────────────────────────

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

	it('only extracts LAST assistant message', () => {
		const messages = [
			{ role: 'assistant', content: 'First response' },
			{ role: 'user', content: 'more' },
			{ role: 'assistant', content: 'Second response' },
		];
		expect(extractLastAssistantText(messages)).toBe('Second response');
	});

	it('returns null when no assistant messages', () => {
		expect(extractLastAssistantText([{ role: 'user', content: 'hello' }])).toBeNull();
	});

	it('returns null for empty/null/undefined messages', () => {
		expect(extractLastAssistantText([])).toBeNull();
		expect(extractLastAssistantText(null as any)).toBeNull();
		expect(extractLastAssistantText(undefined as any)).toBeNull();
	});

	it('skips assistant messages with null content (tool_calls)', () => {
		const messages = [
			{ role: 'assistant', content: 'All done! The fix is deployed.' },
			{ role: 'assistant', content: null },
		];
		expect(extractLastAssistantText(messages)).toBe('All done! The fix is deployed.');
	});
});
