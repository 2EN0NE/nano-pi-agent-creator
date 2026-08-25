/**
 * custom-compaction lab — pi-lab 纯数据收集接入测试
 *
 * 覆盖：
 *   - initExperiments：注册 1 个 profile-satisfaction 实验，臂 = profile id
 *   - 降级：pi-lab 缺失时自然降级（record 空操作）
 *   - record 归因：过程指标/满意度/重压的 armId = 生效 profile.id（不再有选臂/覆盖）
 *   - detectRollback：回退信号检测 + one-shot 语义（不变量，逻辑保留）
 *   - getLabStatus：返回单个实验状态
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import {
	initExperiments,
	isLabActive,
	markCompactStart,
	markCompactEnd,
	reportProcessMetrics,
	reportSatisfaction,
	reportRecompact,
	detectRollback,
	rememberModel,
	resetLabState,
	clearRecentCompact,
	getLabStatus,
} from '../../../extensions/context/custom-compaction/lab.js';
import { createDefaultProfile } from '../../../extensions/context/custom-compaction/types.js';

// ── helpers ──────────────────────────────────────────────────────

const originalGlobal = (globalThis as Record<string, unknown>).__labApi;

function makeProfile(overrides: Partial<ReturnType<typeof createDefaultProfile>> = {}) {
	return { ...createDefaultProfile(), ...overrides };
}

/** mock pi-lab：registerWeakExperiment 返回一个记录 armId/metrics 的实验 */
function mockLabApi(records: Array<{ armId: string; metrics: Record<string, number> }>) {
	(globalThis as Record<string, unknown>).__labApi = {
		getExperimentManager: () => ({
			registerWeakExperiment: (def: unknown) => {
				const name = (def as { name: string }).name;
				return {
					record: async (armId: string, outcome: { metrics: Record<string, number> }) => {
						records.push({ armId, metrics: outcome.metrics });
					},
					info: () => ({ name, strategy: 'stable-hash', forceArmId: null }),
					stats: async () => ({}),
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

afterEach(() => {
	restoreGlobalLabApi();
	resetLabState();
});

// ── initExperiments ─────────────────────────────────────────────

describe('initExperiments', () => {
	it('registers a single profile-satisfaction experiment with arms = profile ids', () => {
		const defs: Array<{ name: string; arms: Array<{ id: string }> }> = [];
		(globalThis as Record<string, unknown>).__labApi = {
			getExperimentManager: () => ({
				registerWeakExperiment: (def: unknown) => {
					defs.push(def as { name: string; arms: Array<{ id: string }> });
					return {
						record: vi.fn(async () => {}),
						info: () => ({
							name: 'profile-satisfaction',
							strategy: 'stable-hash',
							forceArmId: null,
						}),
						stats: async () => ({}),
					};
				},
			}),
		};

		initExperiments({} as never, [
			makeProfile({ id: 'default', name: 'Default' }),
			makeProfile({ id: 'smart-compact', name: 'Smart' }),
		]);

		expect(defs).toHaveLength(1);
		expect(defs[0].name).toBe('profile-satisfaction');
		expect(defs[0].arms.map((a) => a.id)).toEqual(['default', 'smart-compact']);
	});

	it('degrades when pi-lab is not available', () => {
		delete (globalThis as Record<string, unknown>).__labApi;
		initExperiments({} as never, [makeProfile()]);
		expect(isLabActive()).toBe(false);
	});

	it('degrades when registration is blocked (returns undefined)', () => {
		(globalThis as Record<string, unknown>).__labApi = {
			getExperimentManager: () => ({
				registerWeakExperiment: () => undefined,
			}),
		};
		initExperiments({} as never, [makeProfile()]);
		expect(isLabActive()).toBe(false);
	});
});

// ── record 归因（armId = profile id，不再有选臂/覆盖） ────────────

describe('record attribution (armId = profile id)', () => {
	it('records process metrics with armId = active profile id', async () => {
		const records: Array<{ armId: string; metrics: Record<string, number> }> = [];
		mockLabApi(records);
		initExperiments({} as never, [makeProfile()]);
		rememberModel({ provider: 'openai', id: 'gpt-4o' });

		markCompactStart({} as never, 'my-profile', 'e1', 'auto');
		const reported = await reportProcessMetrics({
			latencyMs: 1,
			savedTokens: 2,
			summaryLength: 3,
		});

		expect(reported).toBe(true);
		expect(records).toHaveLength(1);
		expect(records[0].armId).toBe('my-profile');
		expect(records[0].metrics).toEqual({ latency_ms: 1, saved_tokens: 2, summary_length: 3 });
	});

	it('records satisfaction with armId = active profile id', async () => {
		const records: Array<{ armId: string; metrics: Record<string, number> }> = [];
		mockLabApi(records);
		initExperiments({} as never, [makeProfile()]);

		markCompactStart({} as never, 'p1', 'e1', 'auto');
		await reportSatisfaction(false);

		expect(records).toHaveLength(1);
		expect(records[0].armId).toBe('p1');
		expect(records[0].metrics).toEqual({ satisfaction: 0 });
	});

	it('records recompact signal within 30min of auto compact', async () => {
		const records: Array<{ armId: string; metrics: Record<string, number> }> = [];
		mockLabApi(records);
		initExperiments({} as never, [makeProfile()]);

		markCompactStart({} as never, 'p1', 'e1', 'auto');
		await reportRecompact();

		expect(records).toHaveLength(1);
		expect(records[0].armId).toBe('p1');
		expect(records[0].metrics).toEqual({ satisfaction: 0 });
	});

	it('does NOT report recompact for manual compaction', async () => {
		const records: Array<{ armId: string; metrics: Record<string, number> }> = [];
		mockLabApi(records);
		initExperiments({} as never, [makeProfile()]);

		markCompactStart({} as never, 'p1', 'e1', 'manual');
		await reportRecompact();

		expect(records).toHaveLength(0);
	});

	it('does not record when no experiment is registered', async () => {
		delete (globalThis as Record<string, unknown>).__labApi;
		initExperiments({} as never, [makeProfile()]);
		// 无实验时 markCompactStart 不产生记录 → 后续 report 空操作
		markCompactStart({} as never, 'p1', 'e1', 'auto');
		expect(await reportProcessMetrics({ latencyMs: 1, savedTokens: 1, summaryLength: 1 })).toBe(
			false,
		);
	});

	it('reports process metrics only once per compaction (one-shot)', async () => {
		const records: Array<{ armId: string; metrics: Record<string, number> }> = [];
		mockLabApi(records);
		initExperiments({} as never, [makeProfile()]);

		markCompactStart({} as never, 'p1', 'e1', 'auto');
		expect(await reportProcessMetrics({ latencyMs: 1, savedTokens: 1, summaryLength: 1 })).toBe(
			true,
		);
		expect(await reportProcessMetrics({ latencyMs: 2, savedTokens: 2, summaryLength: 2 })).toBe(
			false,
		);
		expect(records).toHaveLength(1);
	});
});

// ── detectRollback（不变量：逻辑保留，仅归因改为 profile id） ─────

describe('detectRollback', () => {
	beforeEach(() => resetLabState());
	afterEach(() => resetLabState());

	// 祖先链 = 当前 leaf 含自身的 parentId 链（leaf → ... → root）。
	const chainOf = (leaf: string): string[] => {
		const all = ['e1', 'e2', 'e3', 'e4', 'e5'];
		const idx = all.indexOf(leaf);
		if (idx < 0) return [];
		return all.slice(0, idx + 1).reverse();
	};
	// 鸭子类型 tree：detectDiverge(anchor) = anchor 不在当前 leaf 祖先链上（pi-session-tree 原语语义）
	const mockTree = (leaf: string) => ({
		detectDiverge: (anchor: string) => !chainOf(leaf).includes(anchor),
	});

	it('returns false when no recent compact record', () => {
		expect(detectRollback({} as never, mockTree('e5'))).toBe(false);
	});

	it('returns false when current leaf is after the compact point (normal progress)', () => {
		markCompactStart({} as never, 'p1', 'e3', 'auto');
		markCompactEnd({} as never, 'e4');
		expect(detectRollback({} as never, mockTree('e5'))).toBe(false);
	});

	it('returns true when user moved back before the compact point', () => {
		markCompactStart({} as never, 'p1', 'e3', 'auto');
		markCompactEnd({} as never, 'e4');
		expect(detectRollback({} as never, mockTree('e2'))).toBe(true);
	});

	it('reports rollback only once per compact record (one-shot)', () => {
		markCompactStart({} as never, 'p1', 'e3', 'auto');
		markCompactEnd({} as never, 'e4');
		expect(detectRollback({} as never, mockTree('e2'))).toBe(true);
		expect(detectRollback({} as never, mockTree('e2'))).toBe(false);
	});

	it('clearRecentCompact clears the record (compaction failure path)', () => {
		markCompactStart({} as never, 'p1', 'e3', 'auto');
		clearRecentCompact();
		expect(detectRollback({} as never, mockTree('e2'))).toBe(false);
	});

	it('returns false when tree unavailable (null)', () => {
		markCompactStart({} as never, 'p1', 'e3', 'auto');
		markCompactEnd({} as never, 'e4');
		expect(detectRollback({} as never, null)).toBe(false);
	});
});

// ── getLabStatus ────────────────────────────────────────────────

describe('getLabStatus', () => {
	it('returns inactive when no experiment', async () => {
		delete (globalThis as Record<string, unknown>).__labApi;
		initExperiments({} as never, [makeProfile()]);
		expect(await getLabStatus()).toEqual({ active: false, experiments: [] });
	});

	it('returns a single experiment with current profile as arm', async () => {
		const records: Array<{ armId: string; metrics: Record<string, number> }> = [];
		mockLabApi(records);
		initExperiments({} as never, [makeProfile()]);
		markCompactStart({} as never, 'p1', 'e1', 'auto');

		const status = await getLabStatus();
		expect(status.active).toBe(true);
		expect(status.experiments).toHaveLength(1);
		expect(status.experiments[0].name).toBe('profile-satisfaction');
		expect(status.experiments[0].currentArm).toBe('p1');
	});
});
