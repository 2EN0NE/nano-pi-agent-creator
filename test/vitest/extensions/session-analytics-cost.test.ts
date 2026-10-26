/**
 * session-analytics 成本统计 — 口径对齐内置 footer
 *
 * 历史问题：解析只认 `type === 'message'`，把 `usage`（缓存保温）、`compaction`、
 * `branch_summary` 三类计费条目的成本全部漏掉 —— 任何压缩过的会话都会被低估。
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseSessionFile } from '../../../extensions/observability/session-analytics.ts';

function u(opts: { input?: number; output?: number; cacheRead?: number; total?: number } = {}) {
	return {
		input: opts.input ?? 0,
		output: opts.output ?? 0,
		cacheRead: opts.cacheRead ?? 0,
		cacheWrite: 0,
		totalTokens: (opts.input ?? 0) + (opts.output ?? 0) + (opts.cacheRead ?? 0),
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: opts.total ?? 0,
		},
	};
}

const TS = '2026-01-01T00:00:00.000Z';

/** 会话文件命名必须匹配 `YYYY-MM-DDTHH-mm-ss-SSSZ_...`，否则拿不到 startedAt */
const FILE_NAME = '2026-01-01T00-00-00-000Z_e2e-analytics.jsonl';

function writeSession(lines: unknown[]): { dir: string; file: string } {
	const dir = mkdtempSync(join(tmpdir(), 'session-analytics-'));
	const file = join(dir, FILE_NAME);
	writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
	return { dir, file };
}

describe('session-analytics — 非 message 条目的计费', () => {
	it('usage / compaction / branch_summary 的成本与 token 都计入', async () => {
		const { dir, file } = writeSession([
			{ type: 'session', id: 's', timestamp: TS, cwd: '/tmp/proj' },
			{
				type: 'message',
				id: 'a1',
				parentId: null,
				timestamp: TS,
				provider: 'anthropic',
				model: 'claude-sonnet',
				message: {
					role: 'assistant',
					content: [],
					provider: 'anthropic',
					model: 'claude-sonnet',
					usage: u({ input: 100, output: 50, total: 0.01 }),
				},
			},
			{
				type: 'usage',
				id: 'u1',
				parentId: 'a1',
				timestamp: TS,
				kind: 'cache_warm',
				provider: 'anthropic',
				model: 'claude-sonnet',
				usage: u({ cacheRead: 5000, total: 0.02 }),
			},
			{
				type: 'compaction',
				id: 'c1',
				parentId: 'u1',
				timestamp: TS,
				summary: 's',
				usage: u({ input: 400, total: 0.03 }),
			},
			{
				type: 'branch_summary',
				id: 'b1',
				parentId: 'c1',
				timestamp: TS,
				summary: 's',
				usage: u({ input: 200, total: 0.04 }),
			},
		]);

		try {
			const parsed = await parseSessionFile(file);
			expect(parsed).not.toBeNull();

			// 四类来源合计 —— 旧实现只有 0.01
			expect(parsed!.totalCost).toBeCloseTo(0.1);
			expect(parsed!.costByModel.get('anthropic/claude-sonnet')).toBeCloseTo(0.03);
			expect(parsed!.costByModel.get('Tools/summaries')).toBeCloseTo(0.07);

			// 非 message 条目不计入对话消息数
			expect(parsed!.messages).toBe(1);
			expect(parsed!.messagesByModel.get('anthropic/claude-sonnet')).toBe(1);

			// token 也要一并计入（否则"缓存保温"这类大 cacheRead 完全隐形）
			const tokensFromUsage = parsed!.tokensByModel.get('anthropic/claude-sonnet') ?? 0;
			expect(tokensFromUsage).toBeGreaterThanOrEqual(5000);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('缓存单统计等于各模型桶之和（同一份账不得对不上）', async () => {
		const { dir, file } = writeSession([
			{ type: 'session', id: 's', timestamp: TS, cwd: '/tmp/proj' },
			{
				type: 'message',
				id: 'a1',
				parentId: null,
				timestamp: TS,
				provider: 'openai',
				model: 'gpt-4o',
				message: {
					role: 'assistant',
					content: [],
					provider: 'openai',
					model: 'gpt-4o',
					usage: u({ input: 10, total: 0.05 }),
				},
			},
			{
				type: 'compaction',
				id: 'c1',
				parentId: 'a1',
				timestamp: TS,
				summary: 's',
				usage: u({ input: 10, total: 0.05 }),
			},
		]);

		try {
			const parsed = await parseSessionFile(file);
			const bucketSum = [...parsed!.costByModel.values()].reduce((a, b) => a + b, 0);
			expect(bucketSum).toBeCloseTo(parsed!.totalCost);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it('faux（mock）模型的 compaction / branch_summary 不计入（与 message/usage 同口径）', async () => {
		const { dir, file } = writeSession([
			{ type: 'session', id: 's', timestamp: TS, cwd: '/tmp/proj' },
			{
				type: 'message',
				id: 'a1',
				parentId: null,
				timestamp: TS,
				provider: 'anthropic',
				model: 'claude-sonnet',
				message: {
					role: 'assistant',
					content: [],
					provider: 'anthropic',
					model: 'claude-sonnet',
					usage: u({ input: 10, total: 0.01 }),
				},
			},
			{
				type: 'message',
				id: 'a2',
				parentId: 'a1',
				timestamp: TS,
				provider: 'faux',
				model: 'faux-1',
				message: {
					role: 'assistant',
					content: [],
					provider: 'faux',
					model: 'faux-1',
					usage: u({ input: 999, total: 9 }),
				},
			},
			{
				type: 'compaction',
				id: 'c1',
				parentId: 'a2',
				timestamp: TS,
				summary: 's',
				usage: u({ input: 888, total: 8 }),
			},
		]);

		try {
			const parsed = await parseSessionFile(file);
			expect(parsed).not.toBeNull();
			// 只剩真实模型那一条的 0.01；faux 的 message 与 compaction 都被过滤
			expect(parsed!.totalCost).toBeCloseTo(0.01);
			expect(parsed!.costByModel.has('Tools/summaries')).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
