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
	selectBestProfile,
	toModelSpec,
	type CompactionProfile,
	type CompactionConfig,
} from '../../../extensions/context/custom-compaction/types.js';
import {
	shouldTrigger,
	isApproaching,
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
		autoContinueMessage: 'continue',
		...overrides,
	};
}

function makeConfig(profiles: CompactionProfile[], activeProfileId?: string): CompactionConfig {
	const record: Record<string, CompactionProfile> = {};
	for (const p of profiles) record[p.id] = p;
	return {
		profiles: record,
		activeProfileId: activeProfileId ?? profiles[0]?.id ?? 'default',
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

// ── selectBestProfile ───────────────────────────────────────────

describe('selectBestProfile', () => {
	it('returns undefined for empty profiles', () => {
		expect(selectBestProfile(makeConfig([]), 'openai/gpt-4o')).toBeUndefined();
	});

	it('returns first profile as last resort when nothing matches', () => {
		const p = makeProfile({ id: 'only', name: 'Only' });
		expect(selectBestProfile(makeConfig([p]), 'openai/gpt-4o')).toBe(p);
	});

	it('prefers exact match over prefix over substring over universal', () => {
		const universal = makeProfile({ id: 'u', name: 'Universal' });
		const prefix = makeProfile({ id: 'p', name: 'Prefix', matchModel: 'openai/' });
		const substring = makeProfile({ id: 's', name: 'Substring', matchModel: 'gpt-4o' });
		const exact = makeProfile({
			id: 'e',
			name: 'Exact',
			matchModel: 'openai/gpt-4o',
		});

		const config = makeConfig([universal, prefix, substring, exact]);
		expect(selectBestProfile(config, 'openai/gpt-4o')?.id).toBe('e');
	});

	it('prefers prefix over substring over universal', () => {
		const universal = makeProfile({ id: 'u', name: 'Universal' });
		const prefix = makeProfile({ id: 'p', name: 'Prefix', matchModel: 'openai/' });
		const substring = makeProfile({ id: 's', name: 'Substring', matchModel: 'gpt-4o' });

		// For "openai/gpt-4o":
		// - prefix matches (score 1)
		// - substring matches (score 2)
		// Should pick prefix (lower score)
		const config = makeConfig([universal, substring, prefix]);
		expect(selectBestProfile(config, 'openai/gpt-4o')?.id).toBe('p');
	});

	it('prefers substring over universal', () => {
		const universal = makeProfile({ id: 'u', name: 'Universal' });
		const substring = makeProfile({ id: 's', name: 'Substring', matchModel: 'gpt' });

		const config = makeConfig([universal, substring]);
		expect(selectBestProfile(config, 'openai/gpt-4o')?.id).toBe('s');
	});

	it('falls back to universal when no matchModel matches', () => {
		const universal = makeProfile({ id: 'u', name: 'Universal' });
		const anthropic = makeProfile({ id: 'a', name: 'Anthropic', matchModel: 'anthropic/' });

		const config = makeConfig([anthropic, universal]);
		expect(selectBestProfile(config, 'openai/gpt-4o')?.id).toBe('u');
	});

	it('tie-breaks by longer matchModel when same score', () => {
		// Both are prefix matches (score 1), but "openai/gpt-4o-mini" is longer
		const shorter = makeProfile({ id: 'short', name: 'Short', matchModel: 'openai/' });
		const longer = makeProfile({
			id: 'long',
			name: 'Long',
			matchModel: 'openai/gpt-4o-mini',
		});

		const config = makeConfig([shorter, longer]);
		expect(selectBestProfile(config, 'openai/gpt-4o-mini')?.id).toBe('long');
	});

	it('tie-breaks by longer matchModel for substring matches', () => {
		const shorter = makeProfile({ id: 'short', name: 'Short', matchModel: '4o' });
		const longer = makeProfile({
			id: 'long',
			name: 'Long',
			matchModel: 'gpt-4o',
		});

		const config = makeConfig([shorter, longer]);
		expect(selectBestProfile(config, 'openai/gpt-4o')?.id).toBe('long');
	});

	it('prefers universal fallback when no model spec is available', () => {
		const universal = makeProfile({ id: 'u', name: 'Universal' });
		const specific = makeProfile({ id: 's', name: 'Specific', matchModel: 'openai/' });

		const config = makeConfig([specific, universal]);
		expect(selectBestProfile(config, undefined)?.id).toBe('u');
	});

	it('falls back to first profile when no universal and no model spec', () => {
		const specific = makeProfile({ id: 's', name: 'Specific', matchModel: 'openai/' });

		const config = makeConfig([specific]);
		expect(selectBestProfile(config, undefined)?.id).toBe('s');
	});

	it('case-insensitive matching', () => {
		const p = makeProfile({ id: 'c', name: 'Case', matchModel: 'OPENAI/GPT-4O' });
		const config = makeConfig([p]);
		expect(selectBestProfile(config, 'openai/gpt-4o')?.id).toBe('c');
	});

	it('works with only universal profiles', () => {
		const p = makeProfile({ id: 'd', name: 'Default' });
		const config = makeConfig([p]);
		expect(selectBestProfile(config, 'openai/gpt-4o')?.id).toBe('d');
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
