/**
 * quit 金额聚合 — headless 单元测试
 *
 * 验证：
 *  1. aggregateModelUsage 对齐内置 footer 口径：累加 usage.cost.total，
 *     assistant 按 provider/responseModel 分桶，toolResult/compaction/branch_summary
 *     归入 Tools/summaries。
 *  2. aggregateBranchCosts：树遍历每条 root→leaf 路径，共享祖先重复计入，
 *     当前分支标记正确。
 */
import { describe, it, expect } from 'vitest';
import { aggregateBranchCosts, aggregateModelUsage } from '../../../extensions/tui/quit.js';
import type { SessionEntry, SessionTreeNode } from '@earendil-works/pi-coding-agent';

function usage(
	partial: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		total?: number;
	} = {},
): SessionEntry extends never ? never : Record<string, unknown> {
	return {
		input: partial.input ?? 0,
		output: partial.output ?? 0,
		cacheRead: partial.cacheRead ?? 0,
		cacheWrite: partial.cacheWrite ?? 0,
		totalTokens: (partial.input ?? 0) + (partial.output ?? 0),
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: partial.total ?? 0,
		},
	};
}

function assistant(
	id: string,
	parentId: string | null,
	opts: {
		provider?: string;
		model?: string;
		responseModel?: string;
		u?: Record<string, unknown>;
	} = {},
): SessionEntry {
	return {
		type: 'message',
		id,
		parentId,
		timestamp: '2026-01-01T00:00:00.000Z',
		message: {
			role: 'assistant',
			provider: opts.provider ?? 'anthropic',
			model: opts.model ?? 'claude-sonnet',
			responseModel: opts.responseModel,
			content: [],
			usage: opts.u ?? usage(),
		},
	} as unknown as SessionEntry;
}

function toolResult(id: string, parentId: string | null, u: Record<string, unknown>): SessionEntry {
	return {
		type: 'message',
		id,
		parentId,
		timestamp: '2026-01-01T00:00:00.000Z',
		message: { role: 'toolResult', content: [], usage: u },
	} as unknown as SessionEntry;
}

function summaryEntry(
	type: 'compaction' | 'branch_summary',
	id: string,
	parentId: string | null,
	u: Record<string, unknown>,
): SessionEntry {
	return {
		type,
		id,
		parentId,
		timestamp: '2026-01-01T00:00:00.000Z',
		usage: u,
	} as unknown as SessionEntry;
}

function node(entry: SessionEntry, children: SessionTreeNode[] = []): SessionTreeNode {
	return { entry, children } as SessionTreeNode;
}

describe('aggregateModelUsage（官方口径）', () => {
	it('assistant 累加 usage.cost.total，按 provider/responseModel 分桶', () => {
		const entries = [
			assistant('a1', null, {
				provider: 'anthropic',
				model: 'claude-sonnet',
				responseModel: 'claude-sonnet-4',
				u: usage({ input: 100, output: 50, total: 0.01 }),
			}),
			assistant('a2', 'a1', {
				provider: 'anthropic',
				model: 'claude-sonnet',
				responseModel: 'claude-sonnet-4',
				u: usage({ input: 200, output: 100, total: 0.02 }),
			}),
		];

		const { modelUsage, totalCost } = aggregateModelUsage(entries);

		expect(totalCost).toBeCloseTo(0.03);
		expect(modelUsage).toHaveLength(1);
		expect(modelUsage[0].provider).toBe('anthropic');
		expect(modelUsage[0].model).toBe('claude-sonnet-4'); // responseModel 优先于 model
		expect(modelUsage[0].requests).toBe(2);
		expect(modelUsage[0].inputTokens).toBe(300);
		expect(modelUsage[0].totalCost).toBeCloseTo(0.03);
	});

	it('toolResult/compaction/branch_summary 归入 Tools/summaries 桶', () => {
		const entries = [
			assistant('a1', null, {
				provider: 'openai',
				model: 'gpt-4o',
				u: usage({ total: 0.01 }),
			}),
			toolResult('t1', 'a1', usage({ total: 0.02 })),
			summaryEntry('compaction', 'c1', 'a1', usage({ total: 0.03 })),
			summaryEntry('branch_summary', 'b1', 'a1', usage({ total: 0.04 })),
		];

		const { modelUsage, totalCost } = aggregateModelUsage(entries);

		expect(totalCost).toBeCloseTo(0.1);
		const tools = modelUsage.find((m) => m.provider === 'Tools' && m.model === 'summaries');
		expect(tools).toBeDefined();
		expect(tools!.requests).toBe(3);
		expect(tools!.totalCost).toBeCloseTo(0.09);
	});
});

describe('aggregateBranchCosts（各分支叶子金额）', () => {
	it('每条 root→leaf 路径分别聚合，共享祖先重复计入，当前分支标记正确', () => {
		const root = assistant('root', null, { u: usage({ total: 0.05 }) });
		const childA = assistant('A', 'root', { u: usage({ total: 0.01 }) });
		const leafA = assistant('leafA', 'A', { u: usage({ total: 0.02 }) });
		const childB = assistant('B', 'root', { u: usage({ total: 0.1 }) });
		const leafB = assistant('leafB', 'B', { u: usage({ total: 0.2 }) });

		const tree = [node(root, [node(childA, [node(leafA)]), node(childB, [node(leafB)])])];

		const result = aggregateBranchCosts(tree, 'leafB');

		expect(result).toHaveLength(2);
		const current = result.find((b) => b.isCurrent)!;
		const other = result.find((b) => !b.isCurrent)!;

		expect(current.leafId).toBe('leafB');
		expect(current.cost).toBeCloseTo(0.05 + 0.1 + 0.2); // 共享祖先 root 计入
		expect(other.leafId).toBe('leafA');
		expect(other.cost).toBeCloseTo(0.05 + 0.01 + 0.02);

		// 当前分支排最前
		expect(result[0].isCurrent).toBe(true);
	});

	it('无分叉时只有一条分支路径', () => {
		const root = assistant('root', null, { u: usage({ total: 0.05 }) });
		const leaf = assistant('leaf', 'root', { u: usage({ total: 0.03 }) });
		const tree = [node(root, [node(leaf)])];

		const result = aggregateBranchCosts(tree, 'leaf');

		expect(result).toHaveLength(1);
		expect(result[0].cost).toBeCloseTo(0.08);
		expect(result[0].isCurrent).toBe(true);
	});
});
