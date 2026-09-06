/**
 * smart-context lab — compression-aggression 实验接入测试
 *
 * 覆盖：
 *   - initExperiments：注册 compression-aggression，臂 = balanced / aggressive
 *   - 降级：pi-lab 缺失 / 注册被阻断时自然降级
 *   - selectCompressionArm：安全阀（窗口紧张强制 aggressive 不 record）+
 *     窗口充足时 select 分流
 *   - recordSavedChars / recordRecoverContext：armId 归因正确
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
	initExperiments,
	isLabActive,
	selectCompressionArm,
	recordSavedChars,
	recordRecoverContext,
	resetLabState,
	runCompressionWithExperiment,
} from '../../../extensions/context/smart-context/src/lab.js';

// ── helpers ──────────────────────────────────────────────────────

const originalGlobal = (globalThis as Record<string, unknown>).__labApi;

interface Recorded {
	armId: string;
	metrics: Record<string, number>;
	context?: unknown;
}

function mockLabApi(records: Recorded[], selectResult: string = 'balanced') {
	(globalThis as Record<string, unknown>).__labApi = {
		getExperimentManager: () => ({
			registerWeakExperiment: (def: unknown) => {
				const name = (def as { name: string }).name;
				return {
					select: async () => selectResult,
					record: async (
						armId: string,
						outcome: { metrics: Record<string, number> },
						context?: unknown,
					) => {
						records.push({ armId, metrics: outcome.metrics, context });
					},
					info: () => ({ name, strategy: 'stable-hash', forceArmId: null }),
				};
			},
		}),
	};
}

function restoreGlobalLabApi(): void {
	if (originalGlobal === undefined) {
		delete (globalThis as Record<string, unknown>).__labApi;
	} else {
		(globalThis as Record<string, unknown>).__labApi = originalGlobal;
	}
}

const ctx = {
	model: { provider: 'deepseek', id: 'deepseek-v4-pro' },
	sessionManager: { getSessionId: () => 'session-1' },
};

afterEach(() => {
	restoreGlobalLabApi();
	resetLabState();
});

// ── initExperiments ─────────────────────────────────────────────

describe('initExperiments', () => {
	it('registers compression-aggression with balanced/aggressive arms', () => {
		const defs: Array<{
			owner: string;
			name: string;
			arms: Array<{ id: string }>;
			metrics: Array<{ id: string }>;
		}> = [];
		(globalThis as Record<string, unknown>).__labApi = {
			getExperimentManager: () => ({
				registerWeakExperiment: (def: unknown) => {
					defs.push(def as never);
					return { select: vi.fn(), record: vi.fn(), info: vi.fn() };
				},
			}),
		};

		initExperiments(ctx);

		expect(defs).toHaveLength(1);
		expect(defs[0].owner).toBe('smart-context');
		expect(defs[0].name).toBe('compression-aggression');
		expect(defs[0].arms.map((a) => a.id)).toEqual(['balanced', 'aggressive']);
		expect(defs[0].metrics.map((m) => m.id)).toEqual(['saved_chars', 'recover_context_calls']);
	});

	it('degrades when pi-lab is not available', () => {
		delete (globalThis as Record<string, unknown>).__labApi;
		initExperiments(ctx);
		expect(isLabActive()).toBe(false);
	});

	it('degrades when registration is blocked (returns undefined)', () => {
		(globalThis as Record<string, unknown>).__labApi = {
			getExperimentManager: () => ({
				registerWeakExperiment: () => undefined,
			}),
		};
		initExperiments(ctx);
		expect(isLabActive()).toBe(false);
	});
});

// ── selectCompressionArm（安全阀 + select 分流）───────────────────

describe('selectCompressionArm', () => {
	it('returns balanced without experiment when window is not tight', async () => {
		delete (globalThis as Record<string, unknown>).__labApi;
		initExperiments(ctx);
		expect(await selectCompressionArm(ctx, false)).toEqual({
			armId: 'balanced',
			inExperiment: false,
		});
	});

	it('returns aggressive without experiment when window is tight (fallback to original)', async () => {
		delete (globalThis as Record<string, unknown>).__labApi;
		initExperiments(ctx);
		expect(await selectCompressionArm(ctx, true)).toEqual({
			armId: 'aggressive',
			inExperiment: false,
		});
	});

	it('forces aggressive without recording when window is tight (safety valve)', async () => {
		const records: Recorded[] = [];
		mockLabApi(records, 'balanced');
		initExperiments(ctx);

		const arm = await selectCompressionArm(ctx, true);

		expect(arm).toEqual({ armId: 'aggressive', inExperiment: false });
		// 安全阀：不 record，且不更新 recentArm（recover_context 不应归因到被迫臂）
		await recordRecoverContext();
		expect(records).toHaveLength(0);
	});

	it('selects via pi-lab when window is not tight', async () => {
		const records: Recorded[] = [];
		mockLabApi(records, 'aggressive');
		initExperiments(ctx);

		expect(await selectCompressionArm(ctx, false)).toEqual({
			armId: 'aggressive',
			inExperiment: true,
		});
	});

	it('normalizes unknown arm ids to balanced', async () => {
		const records: Recorded[] = [];
		mockLabApi(records, 'unexpected-arm');
		initExperiments(ctx);

		expect(await selectCompressionArm(ctx, false)).toEqual({
			armId: 'balanced',
			inExperiment: true,
		});
	});
});

// ── record 归因 ─────────────────────────────────────────────────

describe('record attribution', () => {
	it('records saved_chars to the selected arm', async () => {
		const records: Recorded[] = [];
		mockLabApi(records, 'balanced');
		initExperiments(ctx);

		const arm = await selectCompressionArm(ctx, false);
		await recordSavedChars(arm.armId, 1234);

		expect(records).toHaveLength(1);
		expect(records[0].armId).toBe('balanced');
		expect(records[0].metrics).toEqual({ saved_chars: 1234 });
	});

	it('does not record saved_chars when no experiment', async () => {
		const records: Recorded[] = [];
		delete (globalThis as Record<string, unknown>).__labApi;
		initExperiments(ctx);

		await recordSavedChars('balanced', 100);
		expect(records).toHaveLength(0);
	});

	it('records recover_context_calls to the most recent arm', async () => {
		const records: Recorded[] = [];
		mockLabApi(records, 'aggressive');
		initExperiments(ctx);

		await selectCompressionArm(ctx, false);
		await recordRecoverContext();

		expect(records).toHaveLength(1);
		expect(records[0].armId).toBe('aggressive');
		expect(records[0].metrics).toEqual({ recover_context_calls: 1 });
	});

	it('does not record recover_context_calls before any selection', async () => {
		const records: Recorded[] = [];
		mockLabApi(records, 'balanced');
		initExperiments(ctx);

		await recordRecoverContext();
		expect(records).toHaveLength(0);
	});
});

// ── 压缩链路集成（runCompressionWithExperiment：select→profile→compress→record）──

describe('runCompressionWithExperiment（压缩链路集成）', () => {
	// ≥4 条消息才走压缩路径（与 pipeline.compress 的跳过条件一致）
	const fiveMessages = [1, 2, 3, 4, 5].map((i) => ({
		role: 'user',
		content: `msg ${i} `.repeat(10),
	}));

	interface CompressorMock {
		compress: (
			messages: unknown[],
			ctx: unknown,
			profile?: { protectedTurns: number },
		) => Promise<unknown[]>;
		seenProfiles: string[];
	}

	// 通过 protectedTurns 区分 profile（balanced=4 / aggressive=2）
	function makeCompressorMock(shorten = true): CompressorMock {
		const seenProfiles: string[] = [];
		return {
			compress: async (messages, _ctx, profile) => {
				seenProfiles.push(profile?.protectedTurns === 2 ? 'aggressive' : 'balanced');
				return shorten ? messages.slice(0, 2) : messages;
			},
			seenProfiles,
		};
	}

	it('窗口充足时 select 分臂 → compress 收到对应 profile → saved>0 时 record', async () => {
		const records: Recorded[] = [];
		mockLabApi(records, 'balanced');
		initExperiments(ctx);
		const comp = makeCompressorMock();

		const run = await runCompressionWithExperiment(comp, fiveMessages, ctx, false);

		expect(run.armId).toBe('balanced');
		expect(run.inExperiment).toBe(true);
		expect(comp.seenProfiles).toEqual(['balanced']);
		expect(run.saved).toBeGreaterThan(0);
		expect(run.before).toBeGreaterThan(run.after);
		expect(run.messages).toHaveLength(2);
		// record 归因到分到的臂，saved_chars = 实际节省字符数
		expect(records).toHaveLength(1);
		expect(records[0].armId).toBe('balanced');
		expect(records[0].metrics.saved_chars).toBe(run.saved);
	});

	it('窗口紧张（安全阀）强制 aggressive 且不 record，即使 select 返回 balanced', async () => {
		const records: Recorded[] = [];
		mockLabApi(records, 'balanced');
		initExperiments(ctx);
		const comp = makeCompressorMock();

		const run = await runCompressionWithExperiment(comp, fiveMessages, ctx, true);

		expect(run.armId).toBe('aggressive');
		expect(run.inExperiment).toBe(false);
		expect(comp.seenProfiles).toEqual(['aggressive']);
		expect(records).toHaveLength(0);
	});

	it('无实验时走原行为（窗口充足→balanced），不 record', async () => {
		const records: Recorded[] = [];
		delete (globalThis as Record<string, unknown>).__labApi;
		initExperiments(ctx);
		const comp = makeCompressorMock();

		const run = await runCompressionWithExperiment(comp, fiveMessages, ctx, false);

		expect(run.armId).toBe('balanced');
		expect(run.inExperiment).toBe(false);
		expect(records).toHaveLength(0);
	});

	it('压缩未节省（saved=0）时不 record', async () => {
		const records: Recorded[] = [];
		mockLabApi(records, 'aggressive');
		initExperiments(ctx);
		const comp = makeCompressorMock(false);

		const run = await runCompressionWithExperiment(comp, fiveMessages, ctx, false);

		expect(run.saved).toBe(0);
		expect(run.inExperiment).toBe(true);
		expect(records).toHaveLength(0);
	});
});
