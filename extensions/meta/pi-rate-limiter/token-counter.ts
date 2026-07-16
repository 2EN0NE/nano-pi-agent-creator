/**
 * Token counter with graceful degradation.
 *
 * Tries js-tiktoken first (accurate, model-aware token counting for OpenAI models
 * via encodingForModel). Falls back to character-based estimation if js-tiktoken
 * is not available or the model isn't supported.
 *
 * This module is designed so that if npm install fails (network issues, etc.),
 * the extension continues working with its existing character-based estimation.
 */

import { logger } from './utils.js';

// ---------------------------------------------------------------------------
// Lazy-loaded tiktoken module (loaded once on first use)
// ---------------------------------------------------------------------------

let tikTokenMod: { encodingForModel: Function; getEncoding: Function } | null = null;
let loadAttempted = false;

async function getTikTokenModule(): Promise<typeof tikTokenMod> {
	if (loadAttempted) return tikTokenMod;
	loadAttempted = true;
	try {
		const mod = await import('js-tiktoken');
		tikTokenMod = mod as unknown as typeof tikTokenMod;
		logger.info('token-counter: loaded js-tiktoken for accurate token counting');
		return tikTokenMod;
	} catch (err) {
		logger.warn(
			'token-counter: js-tiktoken not available, falling back to character estimation',
		);
		return null;
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Count tokens for a single text string using model-aware tokenizer.
 * Returns null if the tokenizer is unavailable or the model isn't supported.
 */
export async function accurateTokenCount(
	text: string,
	modelId?: string,
): Promise<number | null> {
	const mod = await getTikTokenModule();
	if (!mod || !text) return null;

	try {
		let enc: any;
		if (modelId && typeof mod.encodingForModel === 'function') {
			try {
				enc = mod.encodingForModel(modelId);
			} catch {
				// Model not in tiktoken's built-in list (e.g. claude models)
				// Fall back to cl100k_base as a reasonable default
				enc = mod.getEncoding('cl100k_base');
			}
		} else {
			enc = mod.getEncoding('cl100k_base');
		}
		return enc.encode(text).length;
	} catch (err) {
		logger.debug('token-counter: encoding failed', err);
		return null;
	}
}

/**
 * Count tokens for all text content in a provider payload using model-aware
 * tokenizer. Returns accurate count if possible, null if fallback needed.
 *
 * The caller should use:
 *   const count = await estimateTokensAccurate(payload, modelId)
 *                ?? estimateTokensFromPayload(payload, ratio);
 */
export async function estimateTokensAccurate(
	payload: unknown,
	modelId?: string,
): Promise<number | null> {
	if (!payload || typeof payload !== 'object') return null;
	const p = payload as Record<string, unknown>;
	const messages = p.messages;
	if (!Array.isArray(messages)) return null;

	// Collect all text
	const texts: string[] = [];

	for (const msg of messages) {
		if (!msg || typeof msg !== 'object') continue;
		const m = msg as Record<string, unknown>;
		const content = m.content;

		if (typeof content === 'string') {
			texts.push(content);
		} else if (Array.isArray(content)) {
			for (const block of content) {
				if (block && typeof block === 'object') {
					const text = (block as Record<string, unknown>).text;
					if (typeof text === 'string') texts.push(text);
				}
			}
		}
	}

	// Some providers put system prompt at payload.system
	const system = p.system;
	if (typeof system === 'string') texts.push(system);

	if (texts.length === 0) return null;

	// Count tokens for each text (shared encoding per modelId)
	let total = 0;
	for (const text of texts) {
		const count = await accurateTokenCount(text, modelId);
		if (count === null) return null; // Tokenizer unavailable or failed
		total += count;
	}

	return total;
}
