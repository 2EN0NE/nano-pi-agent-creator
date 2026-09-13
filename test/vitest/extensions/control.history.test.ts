/**
 * control 的会话历史压缩（ADR-0052 `D1`/`D5`：`get_history` 的载荷口径）
 *
 * 目标：外部（org 看板）能"只读地问出"成员最近在干什么，但**绝不外传完整会话**。
 * 这里覆盖纯函数口径：认得的消息形状 → 事件行；三重上限（条数 / 单条 / 总量）同时生效；
 * 认不得的形状跳过而不抛错（外部观测不该因消息形状变化而失败）。
 */
import { describe, it, expect } from 'vitest';
import {
	MAX_HISTORY_LIMIT,
	MIN_HISTORY_LIMIT,
	clampHistoryLimit,
	compactHistory,
} from '../../../extensions/auto/control/history.js';

describe('clampHistoryLimit', () => {
	it('合法值原样返回', () => {
		expect(clampHistoryLimit(7)).toBe(7);
		expect(clampHistoryLimit(1.9)).toBe(1);
	});

	it('越界夹到 1..50', () => {
		expect(clampHistoryLimit(0)).toBe(MIN_HISTORY_LIMIT);
		expect(clampHistoryLimit(-5)).toBe(MIN_HISTORY_LIMIT);
		expect(clampHistoryLimit(9999)).toBe(MAX_HISTORY_LIMIT);
	});

	it('非法/缺失 → 默认条数（不是 0，也不抛错）', () => {
		const def = clampHistoryLimit(undefined);
		expect(def).toBeGreaterThan(0);
		expect(clampHistoryLimit('abc')).toBe(def);
		expect(clampHistoryLimit(Number.NaN)).toBe(def);
		expect(clampHistoryLimit(Number.POSITIVE_INFINITY)).toBe(def);
	});
});

describe('compactHistory', () => {
	it('assistant 文本 → 文本事件行', () => {
		const out = compactHistory([
			{
				role: 'assistant',
				content: [{ type: 'text', text: '正在改 applyTools' }],
				timestamp: 111,
			},
		]);
		expect(out).toEqual([
			{ role: 'assistant', kind: 'text', text: '正在改 applyTools', timestamp: 111 },
		]);
	});

	it('工具调用 → 带工具名与文件路径的事件行', () => {
		const out = compactHistory([
			{
				role: 'assistant',
				content: [
					{ type: 'toolCall', name: 'edit', arguments: { path: 'src/a.ts', old: 'x' } },
				],
			},
		]);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ kind: 'toolCall', toolName: 'edit', path: 'src/a.ts' });
	});

	it('edit 的工具结果 → 带 diff（供"在改什么文件"判读）', () => {
		const out = compactHistory([
			{
				role: 'toolResult',
				toolName: 'edit',
				content: [{ type: 'text', text: 'ok' }],
				details: { diff: '@@ -1 +1 @@\n-a\n+b' },
			},
		]);
		expect(out[0]).toMatchObject({ role: 'tool', kind: 'toolResult', toolName: 'edit' });
		expect(out[0].diff).toContain('@@');
	});

	it('错误消息 → error 行（isError 标记）', () => {
		const out = compactHistory([
			{ role: 'assistant', content: [], errorMessage: 'rate limited' },
			{ role: 'toolResult', toolName: 'bash', isError: true, content: 'boom' },
		]);
		expect(out[0]).toMatchObject({ kind: 'error', isError: true, text: 'rate limited' });
		expect(out[1]).toMatchObject({ kind: 'error', isError: true, toolName: 'bash' });
	});

	it('user 文本 → 文本行（派活指令也是"它在干啥"的上下文）', () => {
		const out = compactHistory([{ role: 'user', content: '把这个 bug 修了' }]);
		expect(out[0]).toMatchObject({ role: 'user', kind: 'text', text: '把这个 bug 修了' });
	});

	it('认不得的形状：跳过且不抛错', () => {
		const out = compactHistory([
			null,
			42,
			'string',
			{ role: 'unknown', content: 'x' },
			{ role: 'assistant', content: 'not-an-array' },
			{ role: 'assistant', content: [{ type: 'thinking', text: 'ignored' }] },
		]);
		expect(out).toEqual([]);
	});

	it('空输入 → 空数组', () => {
		expect(compactHistory([])).toEqual([]);
	});

	it('条数上限：只保留最近 N 条（顺序不变）', () => {
		const messages = Array.from({ length: 10 }, (_, i) => ({
			role: 'assistant',
			content: [{ type: 'text', text: `msg-${i}` }],
		}));
		const out = compactHistory(messages, { maxEntries: 3 });
		expect(out.map((e) => e.text)).toEqual(['msg-7', 'msg-8', 'msg-9']);
	});

	it('单条上限：超长文本被截断（含标记）', () => {
		const out = compactHistory(
			[{ role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(500) }] }],
			{ maxTextChars: 100 },
		);
		expect(out[0].text.length).toBeLessThanOrEqual(100);
		expect(out[0].text).toContain('truncated');
	});

	it('总量上限：多条累计不超预算（且仍保留最近的）', () => {
		const messages = Array.from({ length: 5 }, (_, i) => ({
			role: 'assistant',
			content: [{ type: 'text', text: `${i}`.repeat(200) }],
		}));
		const out = compactHistory(messages, { maxTotalChars: 500, maxTextChars: 200 });
		const total = out.reduce((n, e) => n + e.text.length + (e.diff?.length ?? 0), 0);
		expect(total).toBeLessThanOrEqual(500);
		expect(out.length).toBeGreaterThan(0);
		expect(out[out.length - 1].text.startsWith('4')).toBe(true);
	});

	it('write 的 JSON 信封不出现（改用源码本体），路径单独带上', () => {
		const out = compactHistory([
			{
				role: 'assistant',
				content: [
					{
						type: 'toolCall',
						name: 'write',
						arguments: { path: 'a.ts', content: 'export {}' },
					},
				],
			},
		]);
		expect(out[0].text).toBe('export {}');
		expect(out[0].path).toBe('a.ts');
	});
});
