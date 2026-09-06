/**
 * custom-compaction types — Vitest tests
 *
 * Covers:
 *   - modelMatchScore matching logic (exact / prefix / substring / no-match)
 *   - selectBestProfile selection priority and tie-breaking
 *   - toModelSpec helper
 *   - Edge cases (undefined matchModel, empty profiles, no model spec)
 */
import { describe, it, expect } from 'vitest';
import {
	modelMatchScore,
	toModelSpec,
	type CompactionProfile,
	type CompactionConfig,
	type RoutingRule,
} from '../../../extensions/context/custom-compaction/types.js';
import {
	shouldTrigger,
	isApproaching,
	selectTriggeredProfile,
	selectProfileFromTriggered,
} from '../../../extensions/context/custom-compaction/trigger.js';

// ── Helpers ─────────────────────────────────────────────────────

function makeProfile(
	overrides: Partial<CompactionProfile> & { id: string; name: string },
): CompactionProfile {
	return {
		model: 'current',
		trigger: { type: 'context_percent', threshold: 20 },
		mechanism: { type: 'summarize' },
		prompt: '',
		autoContinue: true,
		injectContinueText: false,
		autoContinueMessage: 'continue',
		...overrides,
	};
}

function makeConfig(profiles: CompactionProfile[]): CompactionConfig {
	const record: Record<string, CompactionProfile> = {};
	for (const p of profiles) record[p.id] = p;
	return {
		profiles: record,
		enabledProfileIds: Object.keys(record),
		triggerGranularity: 'agent_turn',
		routingRules: [],
	};
}

// ── toModelSpec ──────────────────────────────────────────────────

describe('toModelSpec', () => {
	it('builds provider/id string', () => {
		expect(toModelSpec({ provider: 'openai', id: 'gpt-4o' })).toBe('openai/gpt-4o');
	});

	it('returns undefined when provider is missing', () => {
		expect(toModelSpec({ id: 'gpt-4o' })).toBeUndefined();
		expect(toModelSpec({ provider: 'openai' })).toBeUndefined();
	});

	it('returns undefined when input is undefined', () => {
		expect(toModelSpec(undefined)).toBeUndefined();
	});

	it('returns undefined when input is empty object', () => {
		expect(toModelSpec({})).toBeUndefined();
	});
});

// ── modelMatchScore ─────────────────────────────────────────────

describe('modelMatchScore', () => {
	it('returns undefined for undefined matchModel (universal fallback)', () => {
		expect(modelMatchScore(undefined, 'openai/gpt-4o')).toBeUndefined();
	});

	it('returns 0 for exact match (case-insensitive)', () => {
		expect(modelMatchScore('openai/gpt-4o', 'openai/gpt-4o')).toBe(0);
		expect(modelMatchScore('openai/GPT-4O', 'openai/gpt-4o')).toBe(0);
	});

	it('returns 1 for prefix match', () => {
		expect(modelMatchScore('openai/', 'openai/gpt-4o')).toBe(1);
		expect(modelMatchScore('openai/', 'openai/gpt-4o-mini')).toBe(1);
	});

	it('returns 2 for substring match', () => {
		expect(modelMatchScore('gpt-4o', 'openai/gpt-4o')).toBe(2);
		expect(modelMatchScore('gpt-4o-mini', 'openai/gpt-4o-mini')).toBe(2);
	});

	it('returns undefined for no match', () => {
		expect(modelMatchScore('anthropic/', 'openai/gpt-4o')).toBeUndefined();
		expect(modelMatchScore('claude', 'openai/gpt-4o')).toBeUndefined();
	});

	it('exact match takes priority over prefix (dedup)', () => {
		// "openai/gpt-4o" matches itself exactly (0) and as prefix (starts with itself)
		// Should return 0 (exact), not 1 (prefix) — exact check runs first
		expect(modelMatchScore('openai/gpt-4o', 'openai/gpt-4o')).toBe(0);
	});
});

// ── Trigger helpers ─────────────────────────────────────────────

function makeTrigger(
	type: 'context_percent' | 'fixed' | 'reserve',
	threshold: number,
): CompactionProfile['trigger'] {
	return { type, threshold };
}

// ── shouldTrigger ───────────────────────────────────────────────

describe('shouldTrigger', () => {
	describe('context_percent', () => {
		const trigger = makeTrigger('context_percent', 30);

		it('returns false when usage is below threshold', () => {
			expect(shouldTrigger(trigger, { tokens: 30000, percent: 15 }, undefined)).toBe(false);
		});

		it('returns true when usage equals threshold', () => {
			expect(shouldTrigger(trigger, { tokens: 60000, percent: 30 }, undefined)).toBe(true);
		});

		it('returns true when usage exceeds threshold', () => {
			expect(shouldTrigger(trigger, { tokens: 90000, percent: 50 }, undefined)).toBe(true);
		});

		it('returns false when percent is null', () => {
			expect(shouldTrigger(trigger, { tokens: 90000, percent: null }, undefined)).toBe(false);
		});

		it('model-specific: same usage triggers differently for different thresholds', () => {
			const usage = { tokens: 80000, percent: 40 };
			expect(shouldTrigger(makeTrigger('context_percent', 30), usage, undefined)).toBe(true);
			expect(shouldTrigger(makeTrigger('context_percent', 50), usage, undefined)).toBe(false);
			expect(shouldTrigger(makeTrigger('context_percent', 40), usage, undefined)).toBe(true);
		});
	});

	describe('fixed', () => {
		const trigger = makeTrigger('fixed', 50_000);

		it('returns false when tokens are below threshold', () => {
			expect(shouldTrigger(trigger, { tokens: 30_000, percent: null }, undefined)).toBe(
				false,
			);
		});

		it('returns true when tokens equal threshold', () => {
			expect(shouldTrigger(trigger, { tokens: 50_000, percent: null }, undefined)).toBe(true);
		});

		it('returns true when tokens exceed threshold', () => {
			expect(shouldTrigger(trigger, { tokens: 70_000, percent: null }, undefined)).toBe(true);
		});

		it('model-specific: same tokens trigger differently for different thresholds', () => {
			const usage = { tokens: 60_000, percent: null };
			expect(shouldTrigger(makeTrigger('fixed', 80_000), usage, undefined)).toBe(false);
			expect(shouldTrigger(makeTrigger('fixed', 50_000), usage, undefined)).toBe(true);
		});
	});

	describe('reserve', () => {
		const contextWindow = 100_000;
		const trigger = makeTrigger('reserve', 10_000);

		it('returns false when remaining exceeds threshold', () => {
			expect(shouldTrigger(trigger, { tokens: 85_000, percent: null }, contextWindow)).toBe(
				false,
			);
		});

		it('returns true when remaining equals threshold', () => {
			expect(shouldTrigger(trigger, { tokens: 90_000, percent: null }, contextWindow)).toBe(
				true,
			);
		});

		it('returns true when remaining is below threshold', () => {
			expect(shouldTrigger(trigger, { tokens: 97_000, percent: null }, contextWindow)).toBe(
				true,
			);
		});

		it('falls back to percent-derived window when contextWindow is undefined', () => {
			expect(shouldTrigger(trigger, { tokens: 95_000, percent: 95 }, undefined)).toBe(true);
		});

		it('model-specific: same remaining triggers differently per threshold', () => {
			const usage = { tokens: 95_000, percent: null };
			expect(shouldTrigger(makeTrigger('reserve', 10_000), usage, contextWindow)).toBe(true);
			expect(shouldTrigger(makeTrigger('reserve', 2_000), usage, contextWindow)).toBe(false);
		});
	});
});

// ── isApproaching ───────────────────────────────────────────────

describe('isApproaching', () => {
	describe('context_percent', () => {
		const trigger = makeTrigger('context_percent', 50);

		it('returns false when well below 80% of threshold', () => {
			expect(isApproaching(trigger, { tokens: 10000, percent: 10 }, undefined)).toBe(false);
		});

		it('returns true when at exactly 80% of threshold', () => {
			expect(isApproaching(trigger, { tokens: 40000, percent: 40 }, undefined)).toBe(true);
		});

		it('returns true when between 80% and threshold', () => {
			expect(isApproaching(trigger, { tokens: 45000, percent: 45 }, undefined)).toBe(true);
		});

		it('returns false when at threshold (triggered, not approaching)', () => {
			expect(isApproaching(trigger, { tokens: 50000, percent: 50 }, undefined)).toBe(false);
		});

		it('returns false when above threshold', () => {
			expect(isApproaching(trigger, { tokens: 60000, percent: 60 }, undefined)).toBe(false);
		});

		it('returns false when percent is null', () => {
			expect(isApproaching(trigger, { tokens: 40000, percent: null }, undefined)).toBe(false);
		});

		it('model-specific: 80% line scales with model threshold', () => {
			const usage = { tokens: 80000, percent: 40 };
			expect(isApproaching(makeTrigger('context_percent', 50), usage, undefined)).toBe(true);
			expect(isApproaching(makeTrigger('context_percent', 60), usage, undefined)).toBe(false);
			expect(isApproaching(makeTrigger('context_percent', 30), usage, undefined)).toBe(false);
		});
	});

	describe('fixed', () => {
		const trigger = makeTrigger('fixed', 50_000);

		it('returns false when well below 80% of threshold', () => {
			expect(isApproaching(trigger, { tokens: 20_000, percent: null }, undefined)).toBe(
				false,
			);
		});

		it('returns true when at 80% of threshold', () => {
			expect(isApproaching(trigger, { tokens: 40_000, percent: null }, undefined)).toBe(true);
		});

		it('returns true when between 80% and threshold', () => {
			expect(isApproaching(trigger, { tokens: 45_000, percent: null }, undefined)).toBe(true);
		});

		it('returns false when at threshold (triggered, not approaching)', () => {
			expect(isApproaching(trigger, { tokens: 50_000, percent: null }, undefined)).toBe(
				false,
			);
		});

		it('model-specific: 80% line scales with model threshold', () => {
			const usage = { tokens: 40_000, percent: null };
			expect(isApproaching(makeTrigger('fixed', 50_000), usage, undefined)).toBe(true);
			expect(isApproaching(makeTrigger('fixed', 60_000), usage, undefined)).toBe(false);
		});
	});

	describe('reserve', () => {
		const contextWindow = 100_000;
		const trigger = makeTrigger('reserve', 10_000);

		it('returns false when plenty of room (remaining > threshold * 1.5)', () => {
			expect(isApproaching(trigger, { tokens: 70_000, percent: null }, contextWindow)).toBe(
				false,
			);
		});

		it('returns true when remaining in approaching zone', () => {
			expect(isApproaching(trigger, { tokens: 88_000, percent: null }, contextWindow)).toBe(
				true,
			);
		});

		it('returns true when at exactly threshold * 1.5 (approaching boundary)', () => {
			expect(isApproaching(trigger, { tokens: 85_000, percent: null }, contextWindow)).toBe(
				true,
			);
		});

		it('returns false when triggered (remaining <= threshold)', () => {
			expect(isApproaching(trigger, { tokens: 95_000, percent: null }, contextWindow)).toBe(
				false,
			);
		});

		it('model-specific: approaching zone scales with model threshold', () => {
			const usage = { tokens: 88_000, percent: null };
			expect(isApproaching(makeTrigger('reserve', 10_000), usage, contextWindow)).toBe(true);
			expect(isApproaching(makeTrigger('reserve', 5_000), usage, contextWindow)).toBe(false);
		});
	});
});

// ── selectTriggeredProfile (ADR-0036 启用集择一) ─────────────────

describe('selectTriggeredProfile', () => {
	const usage = { tokens: 60_000, percent: 60 };

	it('空启用集 → undefined', () => {
		expect(selectTriggeredProfile([], usage, undefined)).toBeUndefined();
	});

	it('无 profile 满足触发 → undefined', () => {
		const p = makeProfile({
			id: 'a',
			name: 'A',
			trigger: { type: 'context_percent', threshold: 80 },
		});
		expect(selectTriggeredProfile([p], usage, undefined)).toBeUndefined();
	});

	it('单个触发 → 返回它', () => {
		const p = makeProfile({
			id: 'a',
			name: 'A',
			trigger: { type: 'context_percent', threshold: 20 },
		});
		expect(selectTriggeredProfile([p], usage, undefined)).toBe(p);
	});

	it('同 type 多触发 → 阈值倒序（大优先）', () => {
		const low = makeProfile({
			id: 'low',
			name: 'Low',
			trigger: { type: 'context_percent', threshold: 20 },
		});
		const high = makeProfile({
			id: 'high',
			name: 'High',
			trigger: { type: 'context_percent', threshold: 50 },
		});
		// 60% 下两个都触发；阈值倒序 → 选 50%（high）
		expect(selectTriggeredProfile([low, high], usage, undefined)?.id).toBe('high');
	});

	it('只从触发集里择一（未触发的排除）', () => {
		const triggered = makeProfile({
			id: 't',
			name: 'T',
			trigger: { type: 'context_percent', threshold: 30 },
		});
		const notTriggered = makeProfile({
			id: 'n',
			name: 'N',
			trigger: { type: 'context_percent', threshold: 90 },
		});
		expect(selectTriggeredProfile([notTriggered, triggered], usage, undefined)?.id).toBe('t');
	});

	it('不同 type 多触发 → 按 type 名稳定排序', () => {
		const percent = makeProfile({
			id: 'p',
			name: 'P',
			trigger: { type: 'context_percent', threshold: 50 },
		});
		const fixed = makeProfile({
			id: 'f',
			name: 'F',
			trigger: { type: 'fixed', threshold: 1000 },
		});
		// context_percent < fixed（字典序），两个都触发 → 选 percent
		expect(selectTriggeredProfile([fixed, percent], usage, undefined)?.id).toBe('p');
	});
});

// ── selectProfileFromTriggered (ADR-0036 选择算法三层) ───────────

describe('selectProfileFromTriggered', () => {
	const triggeredProfiles = (): CompactionProfile[] => [
		makeProfile({ id: 'a', name: 'A', trigger: { type: 'context_percent', threshold: 20 } }),
		makeProfile({ id: 'b', name: 'B', trigger: { type: 'context_percent', threshold: 50 } }),
	];

	it('空触发集 → undefined', () => {
		expect(selectProfileFromTriggered([], { routingRules: [] })).toBeUndefined();
	});

	it('模型路由规则命中 → 返回 target', () => {
		const rules: RoutingRule[] = [{ model: 'openai/', targetProfileId: 'a' }];
		expect(
			selectProfileFromTriggered(triggeredProfiles(), {
				modelSpec: 'openai/gpt-4o',
				routingRules: rules,
			})?.id,
		).toBe('a');
	});

	it('复杂度路由规则命中 → 返回 target', () => {
		const rules: RoutingRule[] = [{ complexity: 'high', targetProfileId: 'b' }];
		expect(
			selectProfileFromTriggered(triggeredProfiles(), {
				complexityLevel: 'high',
				routingRules: rules,
			})?.id,
		).toBe('b');
	});

	it('路由规则有序：首条命中优先', () => {
		const rules: RoutingRule[] = [
			{ model: 'openai/', targetProfileId: 'a' },
			{ model: 'openai/', targetProfileId: 'b' },
		];
		expect(
			selectProfileFromTriggered(triggeredProfiles(), {
				modelSpec: 'openai/gpt-4o',
				routingRules: rules,
			})?.id,
		).toBe('a');
	});

	it('规则 target 不在触发集 → 跳过，退 tiebreak', () => {
		const rules: RoutingRule[] = [{ model: 'openai/', targetProfileId: 'ghost' }];
		expect(
			selectProfileFromTriggered(triggeredProfiles(), {
				modelSpec: 'openai/gpt-4o',
				routingRules: rules,
			})?.id,
		).toBe('b');
	});

	it('规则模型不匹配 → 跳过，退 tiebreak', () => {
		const rules: RoutingRule[] = [{ model: 'anthropic/', targetProfileId: 'a' }];
		expect(
			selectProfileFromTriggered(triggeredProfiles(), {
				modelSpec: 'openai/gpt-4o',
				routingRules: rules,
			})?.id,
		).toBe('b');
	});

	it('无规则命中 → matchModel 隐式（最具体优先）', () => {
		const specific = makeProfile({
			id: 'specific',
			name: 'S',
			matchModel: 'openai/gpt-4o',
			trigger: { type: 'context_percent', threshold: 30 },
		});
		const generic = makeProfile({
			id: 'generic',
			name: 'G',
			matchModel: 'openai/',
			trigger: { type: 'context_percent', threshold: 40 },
		});
		expect(
			selectProfileFromTriggered([generic, specific], {
				modelSpec: 'openai/gpt-4o',
				routingRules: [],
			})?.id,
		).toBe('specific');
	});

	it('无规则无 matchModel → tiebreak（阈值倒序）', () => {
		expect(selectProfileFromTriggered(triggeredProfiles(), { routingRules: [] })?.id).toBe('b');
	});
});
