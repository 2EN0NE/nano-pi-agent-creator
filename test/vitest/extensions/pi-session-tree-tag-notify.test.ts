/**
 * pi-session-tree — turn_end 自动打标提醒纯函数测试
 *
 * summarizeNewLabels 是 index.ts turn_end 增量扫描提醒逻辑的纯函数部分：
 * 把增量扫描命中的标签汇总为去重逗号分隔字符串（空 = 不触发 UI 提醒）。
 * 集成侧（setLabels 循环 + ctx.ui.setStatus）在 index.ts 扩展工厂内，
 * 由本纯函数 + 代码评审保证一致。
 */
import { describe, it, expect } from 'vitest';
import { summarizeNewLabels } from '../../../extensions/meta/pi-session-tree/index.js';

describe('summarizeNewLabels', () => {
	it('returns empty string for an empty map (no reminder)', () => {
		expect(summarizeNewLabels(new Map())).toBe('');
	});

	it('returns empty string when no labels matched', () => {
		const m = new Map<string, string[]>([
			['e1', []],
			['e2', []],
		]);
		expect(summarizeNewLabels(m)).toBe('');
	});

	it('joins distinct labels from a single entry', () => {
		const m = new Map<string, string[]>([['e1', ['提问', '阻塞']]]);
		expect(summarizeNewLabels(m)).toBe('提问,阻塞');
	});

	it('dedupes labels across entries', () => {
		const m = new Map<string, string[]>([
			['e1', ['提问']],
			['e2', ['提问', '阻塞']],
			['e3', ['阻塞']],
		]);
		expect(summarizeNewLabels(m)).toBe('提问,阻塞');
	});

	it('keeps insertion order of first occurrence', () => {
		const m = new Map<string, string[]>([
			['e2', ['阻塞', '提问']],
			['e1', ['提问']],
		]);
		expect(summarizeNewLabels(m)).toBe('阻塞,提问');
	});

	it('handles non-ASCII labels (Chinese tag values)', () => {
		const m = new Map<string, string[]>([['e1', ['满意', 'GOOD']]]);
		expect(summarizeNewLabels(m)).toBe('满意,GOOD');
	});
});
