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
