/**
 * Invisible continue — resume the agentic loop after compaction without
 * injecting a visible user message.
 *
 * Absorbed from pi-invisible-continue's technique: a hidden custom marker
 * starts a canonical session turn, and a context hook removes the marker
 * before provider serialization so the LLM sees no new prompt text.
 *
 * Known trade-off (session is append-only): the marker is persisted as a
 * role="custom" entry — pi sessions cannot delete entries. While this
 * extension is active the `context` hook filters it on every LLM call so it
 * never reaches the provider. If the extension is later disabled, or the
 * session is resumed in an environment without it, convertToLlm turns the
 * marker into an empty user message (harmless noise, not a crash).
 */

import { DEFAULT_AUTO_CONTINUE_MESSAGE, type CompactionProfile } from './types.js';

/** Hidden custom message type used to resume the loop invisibly. */
export const INVISIBLE_CONTINUE_CUSTOM_TYPE = 'custom-compaction:invisible-continue';

/** True when a message is the invisible-continue marker. */
export function isInvisibleContinueMarker(message: unknown): boolean {
	if (!message || typeof message !== 'object') return false;
	const candidate = message as { role?: unknown; customType?: unknown };
	return candidate.role === 'custom' && candidate.customType === INVISIBLE_CONTINUE_CUSTOM_TYPE;
}

/** Remove invisible-continue markers from a message array. */
export function filterInvisibleContinueMarker<T>(messages: readonly T[]): T[] {
	return messages.filter((m) => !isInvisibleContinueMarker(m));
}

/**
 * Context-event handler result for the invisible-continue filter.
 *
 * Returns `{ messages }` (the filtered array) only when a marker was removed;
 * returns `undefined` (no-op, keep the default messages) otherwise. This is
 * the exact return contract of `pi.on('context', ...)`.
 */
export function filterContextMessages<T>(messages: readonly T[]): { messages: T[] } | undefined {
	const filtered = filterInvisibleContinueMarker(messages);
	if (filtered.length !== messages.length) return { messages: filtered };
	return undefined;
}

/** How to resume after compaction. */
export type ContinueDecision =
	{ kind: 'none' } | { kind: 'invisible' } | { kind: 'message'; text: string };

/**
 * Resolve how to continue after compaction from a profile.
 * - autoContinue=false → none
 * - injectContinueText=false → invisible (hidden marker, LLM sees no text)
 * - injectContinueText=true → message (visible user text)
 */
export function resolveContinueDecision(profile: CompactionProfile): ContinueDecision {
	if (!profile.autoContinue) return { kind: 'none' };
	if (!profile.injectContinueText) return { kind: 'invisible' };
	return {
		kind: 'message',
		text: profile.autoContinueMessage || DEFAULT_AUTO_CONTINUE_MESSAGE,
	};
}
