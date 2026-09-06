/**
 * smart-context 压缩管线纯函数测试 — 安全阀边界（compression-aggression 实验依赖）
 *
 * 覆盖 isWindowTight（小窗口 / 高用量阈值 0.6 / contextWindow 边界）
 * 与 profileForArm（臂 → profile 映射）。
 * 这些是「窗口紧张走安全阀强制 aggressive、不进实验」的分流前置判断，
 * 边界条件改坏会静默把本应走安全阀的会话送入实验分流，污染 A/B 数据。
 */
import { describe, it, expect } from 'vitest';
import {
	isWindowTight,
	profileForArm,
	createCompressor,
} from '../../../extensions/context/smart-context/src/compression/pipeline.js';
import { createContentStore } from '../../../extensions/context/smart-context/src/compression/store.js';

const SMALL_WINDOW = 200_000; // 与 pipeline.ts 内部阈值一致

function makeCtx(opts: {
	contextWindow?: number;
	usedTokens?: number;
	noModel?: boolean;
	noUsage?: boolean;
}) {
	const ctx: Record<string, unknown> = {};
	if (!opts.noModel) {
		ctx.getModel = () => ({ contextWindow: opts.contextWindow });
	}
	if (!opts.noUsage) {
		ctx.getContextUsage = () => ({ tokens: opts.usedTokens });
	}
	return ctx;
}

describe('isWindowTight — 小窗口阈值', () => {
	it('contextWindow 缺失 → false（不触发安全阀）', () => {
		expect(isWindowTight(makeCtx({ usedTokens: 0 }))).toBe(false);
	});

	it('contextWindow=0 → false（非法窗口不触发）', () => {
		expect(isWindowTight(makeCtx({ contextWindow: 0, usedTokens: 0 }))).toBe(false);
	});

	it('contextWindow < 200000 → true（小窗口）', () => {
		expect(isWindowTight(makeCtx({ contextWindow: SMALL_WINDOW - 1, usedTokens: 0 }))).toBe(
			true,
		);
	});

	it('contextWindow == 200000 → 不因小窗口触发', () => {
		expect(isWindowTight(makeCtx({ contextWindow: SMALL_WINDOW, usedTokens: 0 }))).toBe(false);
	});

	it('contextWindow > 200000 → 不因小窗口触发', () => {
		expect(isWindowTight(makeCtx({ contextWindow: SMALL_WINDOW + 1, usedTokens: 0 }))).toBe(
			false,
		);
	});
});

describe('isWindowTight — 高用量阈值（0.6 边界）', () => {
	// 用 200000 窗口避开小窗口分支，孤立验证高用量分支
	it('用量比恰好 0.6 → true（>= 边界）', () => {
		expect(isWindowTight(makeCtx({ contextWindow: 200_000, usedTokens: 120_000 }))).toBe(true);
	});

	it('用量比 0.6 之下 → false', () => {
		expect(isWindowTight(makeCtx({ contextWindow: 200_000, usedTokens: 118_000 }))).toBe(false);
	});

	it('用量比 0.6 之上 → true', () => {
		expect(isWindowTight(makeCtx({ contextWindow: 200_000, usedTokens: 120_001 }))).toBe(true);
	});

	it('usedTokens 缺失 → 高用量分支不触发', () => {
		expect(isWindowTight(makeCtx({ contextWindow: 200_000 }))).toBe(false);
	});

	it('getModel / getContextUsage 缺失 → false（优雅降级）', () => {
		expect(isWindowTight(makeCtx({ noModel: true, noUsage: true }))).toBe(false);
	});
});

describe('profileForArm — 臂 → profile 映射', () => {
	it('aggressive → protectedTurns=2 且 compressDespiteCache=true', () => {
		const p = profileForArm('aggressive');
		expect(p.protectedTurns).toBe(2);
		expect(p.compressDespiteCache).toBe(true);
	});

	it('balanced → protectedTurns=4 且 compressDespiteCache=false', () => {
		const p = profileForArm('balanced');
		expect(p.protectedTurns).toBe(4);
		expect(p.compressDespiteCache).toBe(false);
	});

	it('两臂 profile 其他字段均不同（minSavingsRatio/summarizeMinChars）', () => {
		const a = profileForArm('aggressive');
		const b = profileForArm('balanced');
		expect(a.minSavingsRatio).toBeLessThan(b.minSavingsRatio);
		expect(a.summarizeMinChars).toBeLessThan(b.summarizeMinChars);
	});
});

describe('compress — toolCall 块保留（防止 tool/tool_calls 失配 400）', () => {
	/** 构造一条"较长文本 + 一个 toolCall"的 assistant 消息 */
	function assistantWithToolCall(textLen: number) {
		return {
			role: 'assistant',
			content: [
				{ type: 'text', text: 'x'.repeat(textLen) },
				{ type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: '/tmp/a' } },
			],
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
			timestamp: 1,
		};
	}

	function makeCtx() {
		return {
			sessionManager: { getEntries: () => [] },
			getModel: () => ({ contextWindow: 200_000 }),
		};
	}

	it('压缩命中带 toolCall 的 assistant 消息后，toolCall 块仍保留', async () => {
		const store = createContentStore();
		const compressor = createCompressor({
			store,
			// 恒返回固定短摘要，确保 maybeCompressMessage 走 replaceText 分支
			summarizer: {
				summarize: async () => 'short summary',
				getStats: () => ({ calls: 0, cacheHits: 0 }),
			},
		});

		// aggressive：protectedTurns=2。目标 assistant（index 1）位于保护区之前，
		// 确保被压缩。4 条消息中 user 有 3 条，第 2 条 user（index 3）之后的
		// 才是保护区，index 1 的 assistant 会被压缩。
		const messages = [
			{ role: 'user', content: 'q1', timestamp: 0 },
			assistantWithToolCall(800),
			{
				role: 'toolResult',
				toolCallId: 'call-1',
				toolName: 'read',
				content: 'file content',
				timestamp: 2,
			},
			{ role: 'user', content: 'q2', timestamp: 3 },
			{ role: 'assistant', content: [{ type: 'text', text: 'ok' }], timestamp: 4 },
			{ role: 'user', content: 'q3', timestamp: 5 },
		] as any[];

		const out = await compressor.compress(messages, makeCtx(), profileForArm('aggressive'));

		const assistant = out[1] as any;
		const toolCallBlocks = assistant.content.filter((b: any) => b.type === 'toolCall');
		expect(toolCallBlocks).toHaveLength(1);
		expect(toolCallBlocks[0].id).toBe('call-1');
		// 文本部分被压缩（不再是 800 个 x），但 toolCall 保持原样
		expect(assistant.content[0].type).toBe('text');
		expect(assistant.content[0].text.length).toBeLessThan(800);
	});

	it('纯文本 assistant 消息压缩后不残留 toolCall 块（回归对照）', async () => {
		const store = createContentStore();
		const compressor = createCompressor({
			store,
			summarizer: {
				summarize: async () => 'short summary',
				getStats: () => ({ calls: 0, cacheHits: 0 }),
			},
		});

		const messages = [
			{ role: 'user', content: 'q1', timestamp: 0 },
			{
				role: 'assistant',
				content: [{ type: 'text', text: 'y'.repeat(800) }],
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
				timestamp: 1,
			},
			{ role: 'user', content: 'q2', timestamp: 2 },
			{ role: 'assistant', content: [{ type: 'text', text: 'ok' }], timestamp: 3 },
			{ role: 'user', content: 'q3', timestamp: 4 },
		] as any[];

		const out = await compressor.compress(messages, makeCtx(), profileForArm('aggressive'));

		const assistant = out[1] as any;
		expect(assistant.content.filter((b: any) => b.type === 'toolCall')).toHaveLength(0);
	});
});
