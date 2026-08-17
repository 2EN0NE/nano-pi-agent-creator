/**
 * custom-compaction lab — pi-lab experiment integration tests
 *
 * Covers:
 *   - applyLabOverrides: mechanism/prompt/threshold arm overrides, clone isolation
 *   - arm mapping helpers (mechanismAdapterId / promptForArm / thresholdValue)
 *   - detectRollback: rollback signal detection + one-shot semantics
 *   - selectArms: arm selection via globalThis.__labApi bridge (mock)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	applyLabOverrides,
	detectRollback,
	initExperiments,
	isLabActive,
	markCompactStart,
	markCompactEnd,
	resetLabState,
	selectArms,
	rememberModel,
	reportProcessMetrics,
	reportSatisfaction,
	getActiveCompactArms,
	clearActiveCompact,
	clearRecentCompact,
	mechanismAdapterId,
	promptForArm,
	thresholdValue,
	MECHANISM_ARMS,
	PROMPT_ARMS,
	THRESHOLD_ARMS,
	type LabArmSelection,
} from '../../../extensions/context/custom-compaction/lab.js';
import {
	registerAdapter,
	__clearAdaptersForTest,
} from '../../../extensions/context/custom-compaction/mechanisms/index.js';
import {
	createDefaultProfile,
	type CompactionProfile,
} from '../../../extensions/context/custom-compaction/types.js';

// ── helpers ──────────────────────────────────────────────────────

function makeProfile(overrides: Partial<CompactionProfile> = {}): CompactionProfile {
	return { ...createDefaultProfile(), ...overrides };
}

const arms: LabArmSelection = {
	mechanism: 'smart-compact',
	prompt: 'narrative',
	threshold: '70',
};

/** 注册一个「真实拦截压缩」的 smart_compact adapter（机制实验注册前提：handlesCompaction） */
function registerRealSmartCompactAdapter(): void {
	registerAdapter({
		id: 'smart_compact',
		name: 'Test Real Smart Compact',
		description: 'test: beforeCompact 真实拦截',
		beforeCompact: async () => true,
		handlesCompaction: true,
	});
}

// ── applyLabOverrides ────────────────────────────────────────────

describe('applyLabOverrides', () => {
	it('returns the same profile when arms is null (no experiment)', () => {
		const p = makeProfile();
		expect(applyLabOverrides(p, null)).toBe(p);
	});

	it('maps smart-compact arm to adapter mechanism with smart_compact adapterId', () => {
		const p = makeProfile();
		const eff = applyLabOverrides(p, { ...arms, mechanism: 'smart-compact' });
		expect(eff.mechanism.type).toBe('adapter');
		expect(eff.mechanism.adapterId).toBe('smart_compact');
	});

	it('maps summarize arm to summarize mechanism', () => {
		const p = makeProfile();
		const eff = applyLabOverrides(p, { ...arms, mechanism: 'summarize' });
		expect(eff.mechanism.type).toBe('summarize');
		expect(eff.mechanism.adapterId).toBeUndefined();
	});

	it('keeps original mechanism when mechanism arm is null (experiment not registered)', () => {
		const p = makeProfile({
			mechanism: { type: 'pass_through' },
			prompt: 'custom prompt',
		});
		const eff = applyLabOverrides(p, { ...arms, mechanism: null });
		// 机制实验未激活 → 不覆盖用户配置的机制（防 pass_through/adapter 被静默改成 summarize）
		expect(eff.mechanism.type).toBe('pass_through');
	});

	it('keeps original prompt when prompt arm is null (experiment not registered)', () => {
		const p = makeProfile({ prompt: 'my custom prompt' });
		const eff = applyLabOverrides(p, { ...arms, prompt: null });
		expect(eff.prompt).toBe('my custom prompt');
	});

	it('applies narrative prompt arm', () => {
		const p = makeProfile({ prompt: 'custom prompt' });
		const eff = applyLabOverrides(p, { ...arms, prompt: 'narrative' });
		expect(eff.prompt).toContain('narrative summary');
	});

	it('applies structured prompt arm', () => {
		const p = makeProfile({ prompt: 'custom prompt' });
		const eff = applyLabOverrides(p, { ...arms, prompt: 'structured' });
		expect(eff.prompt).toContain('structured markdown');
	});

	it('applies threshold arm to context_percent trigger', () => {
		const p = makeProfile({ trigger: { type: 'context_percent', threshold: 20 } });
		const eff = applyLabOverrides(p, arms);
		expect(eff.trigger.threshold).toBe(70);
	});

	it('does NOT apply threshold arm to fixed/reserve triggers', () => {
		const fixed = makeProfile({ trigger: { type: 'fixed', threshold: 200000 } });
		expect(applyLabOverrides(fixed, arms).trigger.threshold).toBe(200000);
		const reserve = makeProfile({ trigger: { type: 'reserve', threshold: 10000 } });
		expect(applyLabOverrides(reserve, arms).trigger.threshold).toBe(10000);
	});

	it('returns a clone — does not mutate the original profile', () => {
		const p = makeProfile({
			prompt: 'custom',
			trigger: { type: 'context_percent', threshold: 20 },
		});
		const eff = applyLabOverrides(p, arms);
		// 原对象不受影响
		expect(p.prompt).toBe('custom');
		expect(p.trigger.threshold).toBe(20);
		expect(p.mechanism.type).toBe('summarize');
		// 覆盖后的对象是新的
		expect(eff).not.toBe(p);
		expect(eff.trigger).not.toBe(p.trigger);
	});
});

// ── arm mapping helpers ──────────────────────────────────────────

describe('arm mapping helpers', () => {
	it('mechanismAdapterId maps smart-compact to smart_compact', () => {
		expect(mechanismAdapterId('smart-compact')).toBe('smart_compact');
		expect(mechanismAdapterId('summarize')).toBeUndefined();
	});

	it('thresholdValue parses numeric arm ids', () => {
		expect(thresholdValue('70')).toBe(70);
		expect(thresholdValue('60')).toBe(60);
		expect(thresholdValue(null)).toBeNull();
	});

	it('promptForArm returns distinct prompt variants', () => {
		const narrative = promptForArm('narrative');
		const structured = promptForArm('structured');
		expect(narrative).not.toBe(structured);
		expect(narrative).toContain('narrative');
		expect(structured).toContain('structured');
	});

	it('arm catalogs contain expected ids', () => {
		expect(MECHANISM_ARMS.map((a) => a.id)).toEqual(['summarize', 'smart-compact']);
		expect(PROMPT_ARMS.map((a) => a.id)).toEqual(['structured', 'narrative']);
		expect(THRESHOLD_ARMS.map((a) => a.id)).toEqual(['60', '70', '80']);
	});
});

// ── selectArms ───────────────────────────────────────────────────

describe('selectArms', () => {
	const originalGlobal = (globalThis as Record<string, unknown>).__labApi;

	afterEach(() => {
		if (originalGlobal === undefined) {
			delete (globalThis as Record<string, unknown>).__labApi;
		} else {
			(globalThis as Record<string, unknown>).__labApi = originalGlobal;
		}
		resetLabState();
	});

	it('returns null when pi-lab is not available (degradation)', async () => {
		delete (globalThis as Record<string, unknown>).__labApi;
		const ctx = { model: { provider: 'openai', id: 'gpt-4o' } } as never;
		expect(await selectArms(ctx)).toBeNull();
	});

	it('returns null when no experiment registered', async () => {
		(globalThis as Record<string, unknown>).__labApi = {
			getExperimentManager: () => ({
				registerWeakExperiment: () => undefined, // blocked
			}),
		};
		const ctx = { model: { provider: 'openai', id: 'gpt-4o' } } as never;
		// initExperiments 会注册 3 个实验；这里直接测试 selectArms 需先有实验
		// 未注册时 _experiments 为空 → null
		expect(await selectArms(ctx)).toBeNull();
	});
});

// ── selectArms 正面路径（mock pi-lab） ───────────────────────────

describe('selectArms with registered experiments (positive path)', () => {
	const originalGlobal = (globalThis as Record<string, unknown>).__labApi;

	/** 按实验名→臂 id 映射 mock pi-lab 的注册与选臂 */
	function mockLabApi(armsByExp: Record<string, string>): void {
		(globalThis as Record<string, unknown>).__labApi = {
			getExperimentManager: () => ({
				registerWeakExperiment: (def: unknown) => {
					const name = (def as { name: string }).name;
					const armId = armsByExp[name];
					if (!armId) return undefined;
					return {
						select: async () => armId,
						record: vi.fn(async () => {}),
						info: () => ({ name, strategy: 'stable-hash', forceArmId: null }),
						stats: async () => ({ [armId]: { totalCalls: 1, metrics: {} } }),
					};
				},
			}),
		};
	}

	afterEach(() => {
		if (originalGlobal === undefined) {
			delete (globalThis as Record<string, unknown>).__labApi;
		} else {
			(globalThis as Record<string, unknown>).__labApi = originalGlobal;
		}
		// 清空实验注册（pi-lab 不可用时 initExperiments 置空 _experiments）
		initExperiments({} as never);
		resetLabState();
		__clearAdaptersForTest();
	});

	it('registers prompt+threshold but SKIPS mechanism when smart_compact is pass-through', async () => {
		mockLabApi({
			'mechanism-strategy': 'smart-compact',
			'prompt-strategy': 'narrative',
			'threshold-strategy': '80',
		});
		// 默认（无 handlesCompaction adapter）：机制实验不注册
		initExperiments({} as never);
		expect(isLabActive()).toBe(true);

		const ctx = { model: { provider: 'openai', id: 'gpt-4o' } } as never;
		const selection = await selectArms(ctx);
		// mechanism 实验被跳过 → 臂为 null（不覆盖 profile 原机制）
		expect(selection).toEqual({
			mechanism: null,
			prompt: 'narrative',
			threshold: '80',
		});
	});

	it('registers mechanism experiment when a real-handling smart_compact adapter exists', async () => {
		mockLabApi({
			'mechanism-strategy': 'smart-compact',
			'prompt-strategy': 'narrative',
			'threshold-strategy': '80',
		});
		// 注册一个真实拦截压缩的 adapter → 机制实验激活
		registerRealSmartCompactAdapter();
		initExperiments({} as never);

		const selection = await selectArms({ model: {} } as never);
		expect(selection).toEqual({
			mechanism: 'smart-compact',
			prompt: 'narrative',
			threshold: '80',
		});
	});

	it('falls back to null for experiments not registered', async () => {
		mockLabApi({ 'mechanism-strategy': 'summarize' });
		initExperiments({} as never);

		// mechanism 实验被跳过（无真实 adapter），其余未 mock → 无实验 → null
		expect(await selectArms({ model: {} } as never)).toBeNull();
	});

	it('ignores unknown arm ids returned by pi-lab', async () => {
		mockLabApi({
			'mechanism-strategy': 'bogus-arm',
			'prompt-strategy': 'narrative',
			'threshold-strategy': '80',
		});
		initExperiments({} as never);

		const selection = await selectArms({} as never);
		// 机制实验未注册 → null；未知臂被忽略的维度保持 null；正常维度取臂
		expect(selection?.mechanism).toBeNull();
		expect(selection?.prompt).toBe('narrative');
		expect(selection?.threshold).toBe('80');
	});

	it('returns null when pi-lab select throws (degradation)', async () => {
		(globalThis as Record<string, unknown>).__labApi = {
			getExperimentManager: () => ({
				registerWeakExperiment: (def: unknown) => ({
					name: (def as { name: string }).name,
					select: async () => {
						throw new Error('boom');
					},
					record: async () => {},
					info: () => ({ name: 'x', strategy: 'stable-hash', forceArmId: null }),
					stats: async () => ({}),
				}),
			}),
		};
		initExperiments({} as never);
		expect(await selectArms({} as never)).toBeNull();
	});

	it('records process metrics to each experiment with its own arm (parallel attribution)', async () => {
		registerRealSmartCompactAdapter();
		const records: Array<{ exp: string; armId: string; metrics: Record<string, number> }> = [];
		const armByExp: Record<string, string> = {
			'mechanism-strategy': 'smart-compact',
			'prompt-strategy': 'narrative',
			'threshold-strategy': '80',
		};
		(globalThis as Record<string, unknown>).__labApi = {
			getExperimentManager: () => ({
				registerWeakExperiment: (def: unknown) => {
					const name = (def as { name: string }).name;
					const armId = armByExp[name];
					if (!armId) return undefined;
					return {
						select: async () => armId,
						record: async (a: string, outcome: { metrics: Record<string, number> }) => {
							records.push({ exp: name, armId: a, metrics: outcome.metrics });
						},
						info: () => ({ name, strategy: 'stable-hash', forceArmId: null }),
						stats: async () => ({ [armId]: { totalCalls: 1, metrics: {} } }),
					};
				},
			}),
		};
		initExperiments({} as never);
		rememberModel({ provider: 'openai', id: 'gpt-4o' });
		const ctx = { model: { provider: 'openai', id: 'gpt-4o' } } as never;
		const arms = await selectArms(ctx);

		markCompactStart({} as never, arms, 'e1', 'auto');
		const reported = await reportProcessMetrics({
			latencyMs: 123,
			savedTokens: 5000,
			summaryLength: 2000,
		});
		expect(reported).toBe(true);
		expect(records).toHaveLength(3);
		// 各实验收到自己的臂 + 相同的过程指标（并行归因）
		expect(records.find((r) => r.exp === 'mechanism-strategy')).toMatchObject({
			armId: 'smart-compact',
			metrics: { latency_ms: 123, saved_tokens: 5000, summary_length: 2000 },
		});
		expect(records.find((r) => r.exp === 'prompt-strategy')).toMatchObject({
			armId: 'narrative',
		});
		expect(records.find((r) => r.exp === 'threshold-strategy')).toMatchObject({ armId: '80' });
	});

	it('reports process metrics only once per compaction (one-shot)', async () => {
		registerRealSmartCompactAdapter();
		const recordCalls: string[] = [];
		(globalThis as Record<string, unknown>).__labApi = {
			getExperimentManager: () => ({
				registerWeakExperiment: (def: unknown) => ({
					name: (def as { name: string }).name,
					select: async () => 'summarize',
					record: async (a: string) => {
						recordCalls.push(a);
					},
					info: () => ({ name: 'x', strategy: 'stable-hash', forceArmId: null }),
					stats: async () => ({}),
				}),
			}),
		};
		initExperiments({} as never);
		const arms = await selectArms({} as never);

		markCompactStart({} as never, arms, 'e1', 'auto');
		expect(await reportProcessMetrics({ latencyMs: 1, savedTokens: 1, summaryLength: 1 })).toBe(
			true,
		);
		// 第二次上报被 latch 拦截
		expect(await reportProcessMetrics({ latencyMs: 2, savedTokens: 2, summaryLength: 2 })).toBe(
			false,
		);
		expect(recordCalls.length).toBeGreaterThan(0);
	});

	it('reportSatisfaction broadcasts binary signal to each experiment arm', async () => {
		registerRealSmartCompactAdapter();
		const records: Array<{ armId: string; metrics: Record<string, number> }> = [];
		(globalThis as Record<string, unknown>).__labApi = {
			getExperimentManager: () => ({
				registerWeakExperiment: (def: unknown) => {
					const name = (def as { name: string }).name;
					const armId =
						name === 'mechanism-strategy'
							? 'smart-compact'
							: name === 'prompt-strategy'
								? 'narrative'
								: '80';
					return {
						select: async () => armId,
						record: async (a: string, outcome: { metrics: Record<string, number> }) => {
							records.push({ armId: a, metrics: outcome.metrics });
						},
						info: () => ({ name, strategy: 'stable-hash', forceArmId: null }),
						stats: async () => ({}),
					};
				},
			}),
		};
		initExperiments({} as never);
		const arms = await selectArms({} as never);
		markCompactStart({} as never, arms, 'e1', 'auto');

		await reportSatisfaction(false);
		expect(records).toHaveLength(3);
		for (const r of records) {
			expect(r.metrics).toEqual({ satisfaction: 0 });
		}
	});
});

// ── detectRollback ───────────────────────────────────────────────

describe('detectRollback', () => {
	beforeEach(() => resetLabState());
	afterEach(() => resetLabState());

	// 祖先链 = 当前 leaf 含自身的 parentId 链（leaf → ... → root）。
	// 线性会话：e1 → e2 → e3 → e4 → e5
	const chainOf = (leaf: string): string[] => {
		const all = ['e1', 'e2', 'e3', 'e4', 'e5'];
		const idx = all.indexOf(leaf);
		if (idx < 0) return [];
		return all.slice(0, idx + 1).reverse();
	};

	it('returns false when no recent compact record', () => {
		expect(detectRollback({} as never, 'e5', chainOf('e5'))).toBe(false);
	});

	it('returns false when current leaf is after the compact point (normal progress)', () => {
		// 压缩前 e3，压缩后 leafAfter=e4，用户正常继续到 e5（e5 祖先链含 e4）
		markCompactStart({} as never, arms, 'e3', 'auto');
		markCompactEnd({} as never, 'e4');
		expect(detectRollback({} as never, 'e5', chainOf('e5'))).toBe(false);
	});

	it('returns false when current leaf IS the compact-after leaf', () => {
		// 压缩后立即（leaf 停在压缩后节点）
		markCompactStart({} as never, arms, 'e3', 'auto');
		markCompactEnd({} as never, 'e4');
		expect(detectRollback({} as never, 'e4', chainOf('e4'))).toBe(false);
	});

	it('returns true when user moved back before the compact point', () => {
		// 压缩前 e3，用户回退到 e2（压缩节点之前）→ 不满信号
		markCompactStart({} as never, arms, 'e3', 'auto');
		markCompactEnd({} as never, 'e4');
		expect(detectRollback({} as never, 'e2', chainOf('e2'))).toBe(true);
	});

	it('returns true on append-only fork: user rolls back and sends a new message', () => {
		// pi 会话 append-only：回退到 e2 后发新消息 → fork 节点追加在末尾（index 最大）。
		// 旧实现用 index 位置比较（curIdx <= beforeIdx）在此场景永不命中。
		// 祖先链判定：fork 节点 f6 的祖先链为 [f6, e2, e1]，不含 leafAfter=e4 → 回退。
		markCompactStart({} as never, arms, 'e3', 'auto');
		markCompactEnd({} as never, 'e4');
		expect(detectRollback({} as never, 'f6', ['f6', 'e2', 'e1'])).toBe(true);
	});

	it('returns false when fork node descends from the compact-after leaf', () => {
		// 用户在压缩后节点 e4 之后继续 → fork 节点祖先链含 e4 → 正常推进，不回退
		markCompactStart({} as never, arms, 'e3', 'auto');
		markCompactEnd({} as never, 'e4');
		expect(detectRollback({} as never, 'e5', ['e5', 'e4', 'e3', 'e2', 'e1'])).toBe(false);
	});

	it('reports rollback only once per compact record (one-shot)', () => {
		markCompactStart({} as never, arms, 'e3', 'auto');
		markCompactEnd({} as never, 'e4');
		expect(detectRollback({} as never, 'e2', chainOf('e2'))).toBe(true);
		// 第二次调用（后续 agent_end）不再重复上报
		expect(detectRollback({} as never, 'e2', chainOf('e2'))).toBe(false);
	});

	it('resetLabState clears the rollback latch', () => {
		markCompactStart({} as never, arms, 'e3', 'auto');
		markCompactEnd({} as never, 'e4');
		expect(detectRollback({} as never, 'e2', chainOf('e2'))).toBe(true);
		resetLabState();
		// 记录已清 → 不再触发
		expect(detectRollback({} as never, 'e2', chainOf('e2'))).toBe(false);
	});

	it('clearRecentCompact clears the record (compaction failure path)', () => {
		// 压缩失败（onError）→ clearRecentCompact：即使 leaf 未推进也不报回退
		markCompactStart({} as never, arms, 'e3', 'auto');
		clearRecentCompact();
		expect(detectRollback({} as never, 'e2', chainOf('e2'))).toBe(false);
		// 再次 markCompactStart 后可正常记录
		markCompactStart({} as never, arms, 'e3', 'auto');
		markCompactEnd({} as never, 'e4');
		expect(detectRollback({} as never, 'e2', chainOf('e2'))).toBe(true);
	});

	it('returns false when ancestor chain failed to build (empty)', () => {
		markCompactStart({} as never, arms, 'e3', 'auto');
		markCompactEnd({} as never, 'e4');
		// 调用方 getAncestorChain 构建失败（sessionManager 不可用）→ 空链，保守不回退
		expect(detectRollback({} as never, 'e5', [])).toBe(false);
	});

	it('falls back to leafBefore when markCompactEnd was never called', () => {
		// 异常路径：压缩未完成（leafAfter=null）→ 锚点退化为 leafBefore=e3。
		// e5 祖先链含 e3 → 视为仍在压缩后分支（无法区分正常/回退，保守不回退）
		markCompactStart({} as never, arms, 'e3', 'auto');
		expect(detectRollback({} as never, 'e5', chainOf('e5'))).toBe(false);
		// 回退到 e2（祖先链不含 e3）→ 仍能识别
		expect(detectRollback({} as never, 'e2', chainOf('e2'))).toBe(true);
	});
});

// ── 活跃选臂生命周期（active compact arms） ─────────────────────

describe('getActiveCompactArms / clearActiveCompact', () => {
	beforeEach(() => resetLabState());
	afterEach(() => resetLabState());

	it('returns null when no compact is in progress', () => {
		expect(getActiveCompactArms()).toBeNull();
	});

	it('is set by markCompactStart and consumed by compactor', () => {
		markCompactStart({} as never, arms, 'e1', 'auto');
		expect(getActiveCompactArms()).toEqual(arms);
	});

	it('markCompactStart with null arms keeps active arms null (no lab)', () => {
		markCompactStart({} as never, null, 'e1', 'auto');
		expect(getActiveCompactArms()).toBeNull();
	});

	it('clearActiveCompact clears the active arms', () => {
		markCompactStart({} as never, arms, 'e1', 'auto');
		clearActiveCompact();
		expect(getActiveCompactArms()).toBeNull();
		// 最近压缩记录（反馈归因）不受影响：正常推进到 e3 不触发回退
		expect(detectRollback({} as never, 'e3', ['e0', 'e1', 'e2', 'e3'])).toBe(false);
	});

	it('resetLabState clears active arms', () => {
		markCompactStart({} as never, arms, 'e1', 'auto');
		resetLabState();
		expect(getActiveCompactArms()).toBeNull();
	});
});

// ── record context 与 select contextKey 一致性 ───────────────────

describe('record contextKey consistency with select', () => {
	const originalGlobal = (globalThis as Record<string, unknown>).__labApi;

	function mockLabApiWithContextCapture(): {
		selectContexts: unknown[];
		recordContexts: unknown[];
	} {
		const selectContexts: unknown[] = [];
		const recordContexts: unknown[] = [];
		(globalThis as Record<string, unknown>).__labApi = {
			getExperimentManager: () => ({
				registerWeakExperiment: (def: unknown) => {
					const name = (def as { name: string }).name;
					const armId =
						name === 'threshold-strategy'
							? '70'
							: name === 'prompt-strategy'
								? 'structured'
								: 'summarize';
					return {
						select: async (c?: unknown) => {
							selectContexts.push(c);
							return armId;
						},
						record: async (_a: string, _o: unknown, c?: unknown) => {
							recordContexts.push(c);
						},
						info: () => ({ name, strategy: 'stable-hash', forceArmId: null }),
						stats: async () => ({}),
					};
				},
			}),
		};
		return { selectContexts, recordContexts };
	}

	afterEach(() => {
		if (originalGlobal === undefined) {
			delete (globalThis as Record<string, unknown>).__labApi;
		} else {
			(globalThis as Record<string, unknown>).__labApi = originalGlobal;
		}
		initExperiments({} as never);
		resetLabState();
		__clearAdaptersForTest();
	});

	it('select 与 record 收到同一形状的 context，经同一 contextKey fn 落同一桶', async () => {
		const { selectContexts, recordContexts } = mockLabApiWithContextCapture();
		registerRealSmartCompactAdapter();
		initExperiments({} as never);

		const model = { provider: 'openai', id: 'gpt-4o' };
		const arms = await selectArms({ model } as never);
		// selectArms 顺带缓存模型
		markCompactStart({} as never, arms, 'e1', 'auto');
		await reportProcessMetrics({ latencyMs: 1, savedTokens: 1, summaryLength: 1 });

		const keyOf = (c: unknown) => {
			const m = (c as { model?: { provider?: string; id?: string } })?.model;
			return `${m?.provider}:${m?.id}`;
		};
		// 所有 select/record 的 context 都能提取出同一模型键（不再是 unknown:unknown / 斜杠 spec）
		expect(selectContexts.length).toBeGreaterThan(0);
		expect(recordContexts.length).toBe(3); // 三个实验各 record 一次
		for (const c of selectContexts) expect(keyOf(c)).toBe('openai:gpt-4o');
		for (const c of recordContexts) expect(keyOf(c)).toBe('openai:gpt-4o');
	});

	it('无模型信息时 select/record 都落到 unknown:unknown 桶', async () => {
		const { selectContexts, recordContexts } = mockLabApiWithContextCapture();
		registerRealSmartCompactAdapter();
		initExperiments({} as never);

		const arms = await selectArms({} as never);
		markCompactStart({} as never, arms, 'e1', 'auto');
		await reportSatisfaction(false);

		const keyOf = (c: unknown) => {
			const m = (c as { model?: { provider?: string; id?: string } })?.model;
			return `${m?.provider ?? 'unknown'}:${m?.id ?? 'unknown'}`;
		};
		for (const c of selectContexts) expect(keyOf(c)).toBe('unknown:unknown');
		for (const c of recordContexts) expect(keyOf(c)).toBe('unknown:unknown');
	});
});
