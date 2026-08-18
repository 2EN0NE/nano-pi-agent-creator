/**
 * custom-compaction compactor — 过程指标与 supplement 语义测试
 *
 * Covers:
 *   - estimateSavedTokens：savedTokens 估算纯函数（边界：tokensBefore=0、空摘要）
 *   - setCompactResult / getAndClearCompactResult：一次压缩只消费一次
 *   - setPendingSupplement / getAndClearPendingSupplement：补充说明一次消费
 *
 * 背景：doCompact onComplete/onError 会无条件清理 supplement（防残留到下次压缩）。
 * 这里固化模块级的一次消费语义——消费点（session_before_compact）取走即清空，
 * 未被消费的（pass_through / 失败回退）由 doCompact 在压缩结束后兜底清理。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
	estimateSavedTokens,
	setCompactResult,
	getAndClearCompactResult,
	setPendingSupplement,
	getAndClearPendingSupplement,
} from '../../../extensions/context/custom-compaction/compactor.js';

beforeEach(() => {
	// 模块级状态隔离
	setPendingSupplement(undefined);
	getAndClearCompactResult();
});

// ── estimateSavedTokens ─────────────────────────────────────────

describe('estimateSavedTokens', () => {
	it('estimates saved tokens as tokensBefore - summaryChars/4', () => {
		expect(estimateSavedTokens(10000, 2000)).toBe(9500); // 2000/4 = 500
	});

	it('floors at zero when summary is longer than the source', () => {
		expect(estimateSavedTokens(100, 10000)).toBe(0);
	});

	it('handles zero tokensBefore', () => {
		expect(estimateSavedTokens(0, 2000)).toBe(0);
	});

	it('handles empty summary', () => {
		expect(estimateSavedTokens(5000, 0)).toBe(5000);
	});

	it('rounds half chars up (Math.round)', () => {
		expect(estimateSavedTokens(1000, 10)).toBe(997); // 10/4 = 2.5 → Math.round → 3
	});
});

// ── CompactResult 一次消费 ──────────────────────────────────────

describe('CompactResult one-shot semantics', () => {
	it('returns null when nothing recorded', () => {
		expect(getAndClearCompactResult()).toBeNull();
	});

	it('records and consumes exactly once', () => {
		setCompactResult({ tokensBefore: 1000, summaryLength: 200, savedTokens: 950 });
		expect(getAndClearCompactResult()).toEqual({
			tokensBefore: 1000,
			summaryLength: 200,
			savedTokens: 950,
		});
		// 第二次读取为 null（一次压缩只报一次指标）
		expect(getAndClearCompactResult()).toBeNull();
	});
});

// ── Supplement 一次消费 ─────────────────────────────────────────

describe('supplement one-shot semantics', () => {
	it('is undefined when nothing set', () => {
		expect(getAndClearPendingSupplement()).toBeUndefined();
	});

	it('consumes and clears on read (getAndClear)', () => {
		setPendingSupplement('请保留所有文件路径');
		expect(getAndClearPendingSupplement()).toBe('请保留所有文件路径');
		expect(getAndClearPendingSupplement()).toBeUndefined();
	});

	it('overwrite: later set replaces earlier', () => {
		setPendingSupplement('first');
		setPendingSupplement('second');
		expect(getAndClearPendingSupplement()).toBe('second');
	});

	it('explicit clear (undefined) empties the pending supplement', () => {
		setPendingSupplement('will be cleared');
		setPendingSupplement(undefined);
		expect(getAndClearPendingSupplement()).toBeUndefined();
	});
});

// ── buildCompactionHandler：使用 profile 自定义 prompt ────────────
// 移除实验臂覆盖后，compactor 直接读 profile.prompt（不再有 lab 覆盖）。

import { buildCompactionHandler } from '../../../extensions/context/custom-compaction/compactor.js';

// vi.mock 必须在使用前声明（vitest hoisted）；这里用 importOriginal 保留真实实现，
// 只替换 compactor 的外部依赖点
vi.mock('@earendil-works/pi-ai/compat', async (importOriginal) => {
	const mod = await importOriginal<typeof import('@earendil-works/pi-ai/compat')>();
	return { ...mod, complete: vi.fn() };
});
vi.mock('../../../extensions/context/custom-compaction/config.js', async (importOriginal) => {
	const mod =
		await importOriginal<
			typeof import('../../../extensions/context/custom-compaction/config.js')
		>();
	return { ...mod, getEffectiveProfile: vi.fn() };
});
vi.mock(
	'../../../extensions/context/custom-compaction/mechanisms/index.js',
	async (importOriginal) => {
		const mod =
			await importOriginal<
				typeof import('../../../extensions/context/custom-compaction/mechanisms/index.js')
			>();
		return { ...mod, getAdapter: vi.fn() };
	},
);
import { vi } from 'vitest';
import { complete } from '@earendil-works/pi-ai/compat';
import { getEffectiveProfile } from '../../../extensions/context/custom-compaction/config.js';
import { getAdapter } from '../../../extensions/context/custom-compaction/mechanisms/index.js';
import {
	createDefaultProfile,
	type CompactionProfile,
} from '../../../extensions/context/custom-compaction/types.js';

describe('buildCompactionHandler — uses profile prompt', () => {
	beforeEach(() => {
		// mock.calls 跨测试累积（vitest 默认不自动 clear），每个用例清空后取 calls[0]
		vi.mocked(complete).mockClear();
	});

	function makeProfile(overrides: Partial<CompactionProfile> = {}): CompactionProfile {
		return {
			...createDefaultProfile(),
			prompt: 'PROFILE_CUSTOM_PROMPT',
			...overrides,
		};
	}

	function makeCtx(): any {
		return {
			model: { provider: 'mock', id: 'm1' },
			modelRegistry: {
				getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: 'key' }),
			},
			ui: { notify: vi.fn() },
		};
	}

	function makeEvent(): any {
		return {
			reason: 'manual',
			willRetry: false,
			preparation: {
				messagesToSummarize: [{ role: 'user', content: 'hi' }],
				turnPrefixMessages: [],
				tokensBefore: 1000,
				firstKeptEntryId: 'first',
				previousSummary: undefined,
			},
			signal: { aborted: false },
		};
	}

	async function summarize(): Promise<string> {
		vi.mocked(getEffectiveProfile).mockReturnValue(makeProfile());
		vi.mocked(getAdapter).mockReturnValue(undefined);
		vi.mocked(complete).mockResolvedValue({
			content: [{ type: 'text', text: 'summary ok' }],
			stopReason: 'end_turn',
		} as any);

		const handler = buildCompactionHandler();
		await handler(makeEvent(), makeCtx());

		const call = vi.mocked(complete).mock.calls[0];
		expect(call).toBeDefined();
		const messages = (call[1] as { messages: Array<{ content: Array<{ text: string }> }> })
			.messages;
		return messages[0].content[0].text as string;
	}

	it('uses the profile custom prompt directly (no lab arm override)', async () => {
		const text = await summarize();
		expect(text).toContain('PROFILE_CUSTOM_PROMPT');
	});
});
