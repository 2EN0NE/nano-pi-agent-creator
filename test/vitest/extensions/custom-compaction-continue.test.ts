/**
 * custom-compaction continue — 隐形 continue 纯函数测试
 *
 * Covers:
 *   - isInvisibleContinueMarker：识别隐形 continue 的 custom marker
 *   - filterInvisibleContinueMarker：从消息数组移除 marker
 *   - resolveContinueDecision：三态 continue 决策（none / invisible / message）
 */
import { describe, it, expect } from 'vitest';
import {
	isInvisibleContinueMarker,
	filterInvisibleContinueMarker,
	filterContextMessages,
	resolveContinueDecision,
	INVISIBLE_CONTINUE_CUSTOM_TYPE,
	type ContinueDecision,
} from '../../../extensions/context/custom-compaction/continue.js';
import type { CompactionProfile } from '../../../extensions/context/custom-compaction/types.js';

// ── Helper ──────────────────────────────────────────────────────

function makeProfile(overrides: Partial<CompactionProfile> = {}): CompactionProfile {
	return {
		id: 'default',
		name: 'Default',
		model: 'current',
		trigger: { type: 'context_percent', threshold: 20 },
		mechanism: { type: 'summarize' },
		prompt: '',
		autoContinue: true,
		injectContinueText: false,
		autoContinueMessage: '',
		...overrides,
	};
}

// ── isInvisibleContinueMarker ───────────────────────────────────

describe('isInvisibleContinueMarker', () => {
	it('recognizes the marker by role=custom + matching customType', () => {
		expect(
			isInvisibleContinueMarker({
				role: 'custom',
				customType: INVISIBLE_CONTINUE_CUSTOM_TYPE,
			}),
		).toBe(true);
	});

	it('rejects a user message carrying the same customType', () => {
		expect(
			isInvisibleContinueMarker({
				role: 'user',
				customType: INVISIBLE_CONTINUE_CUSTOM_TYPE,
			}),
		).toBe(false);
	});

	it('rejects a custom message with a different customType', () => {
		expect(isInvisibleContinueMarker({ role: 'custom', customType: 'other' })).toBe(false);
	});

	it('rejects non-object inputs', () => {
		expect(isInvisibleContinueMarker(null)).toBe(false);
		expect(isInvisibleContinueMarker(undefined)).toBe(false);
		expect(isInvisibleContinueMarker('custom')).toBe(false);
	});
});

// ── filterInvisibleContinueMarker ───────────────────────────────

describe('filterInvisibleContinueMarker', () => {
	it('removes the marker and keeps other messages', () => {
		const user = { role: 'user', content: [{ type: 'text', text: 'hi' }] };
		const marker = {
			role: 'custom',
			customType: INVISIBLE_CONTINUE_CUSTOM_TYPE,
			content: [],
		};
		expect(filterInvisibleContinueMarker([user, marker])).toEqual([user]);
	});

	it('returns an equivalent array when no marker is present', () => {
		const user = { role: 'user', content: [{ type: 'text', text: 'hi' }] };
		expect(filterInvisibleContinueMarker([user])).toEqual([user]);
	});
});

// ── filterContextMessages ───────────────────────────────────────

describe('filterContextMessages', () => {
	it('returns { messages } (filtered) when a marker is removed', () => {
		const user = { role: 'user', content: [] };
		const marker = { role: 'custom', customType: INVISIBLE_CONTINUE_CUSTOM_TYPE };
		expect(filterContextMessages([user, marker])).toEqual({ messages: [user] });
	});

	it('returns undefined (no-op) when no marker is present', () => {
		const user = { role: 'user', content: [] };
		expect(filterContextMessages([user])).toBeUndefined();
	});

	it('returns undefined for an empty array', () => {
		expect(filterContextMessages([])).toBeUndefined();
	});
});

// ── resolveContinueDecision ─────────────────────────────────────

describe('resolveContinueDecision', () => {
	it('returns none when autoContinue is false (regardless of inject flag)', () => {
		expect(resolveContinueDecision(makeProfile({ autoContinue: false }))).toEqual({
			kind: 'none',
		} satisfies ContinueDecision);
		expect(
			resolveContinueDecision(makeProfile({ autoContinue: false, injectContinueText: true })),
		).toEqual({ kind: 'none' } satisfies ContinueDecision);
	});

	it('returns invisible when autoContinue is true and injectContinueText is false', () => {
		expect(resolveContinueDecision(makeProfile({ autoContinue: true }))).toEqual({
			kind: 'invisible',
		} satisfies ContinueDecision);
	});

	it('returns message with text when injectContinueText is true', () => {
		expect(
			resolveContinueDecision(
				makeProfile({
					autoContinue: true,
					injectContinueText: true,
					autoContinueMessage: '请继续完成剩余任务',
				}),
			),
		).toEqual({ kind: 'message', text: '请继续完成剩余任务' } satisfies ContinueDecision);
	});

	it('falls back to "continue" when injectContinueText is true but message is empty', () => {
		expect(
			resolveContinueDecision(
				makeProfile({
					autoContinue: true,
					injectContinueText: true,
					autoContinueMessage: '',
				}),
			),
		).toEqual({ kind: 'message', text: 'continue' } satisfies ContinueDecision);
	});
});
