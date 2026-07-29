/**
 * Mock LLM Provider — completion-detection test variant
 *
 * Same as test/helpers/mock-llm.ts but responds with a completion phrase
 * to trigger the todos completion detector.
 *
 * 默认回复："All done! The fix is ready for review."
 */

import { registerFauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ProviderConfig } from '@earendil-works/pi-coding-agent';

const MOCK_PROVIDER = 'mock-llm-completion';
const MOCK_MODEL_ID = 'mock-model-completion';

export default function (pi: ExtensionAPI) {
	const faux = registerFauxProvider({
		provider: MOCK_PROVIDER,
		models: [{ id: MOCK_MODEL_ID, name: 'Mock Completion Model' }],
	});

	// Completion-triggering response + follow-up response
	faux.setResponses([
		fauxAssistantMessage('All done! The fix is ready for review.'),
		fauxAssistantMessage('OK, I will check the todos.'),
		fauxAssistantMessage('Done.'),
	]);

	pi.registerProvider(MOCK_PROVIDER, {
		name: 'Mock Completion LLM Provider',
		api: faux.api as ProviderConfig['api'],
		baseUrl: 'http://localhost:0',
		apiKey: 'mock-key-noop',
		models: faux.models.map((m) => ({
			id: m.id,
			name: m.name ?? m.id,
			api: faux.api as ProviderConfig['api'],
			provider: MOCK_PROVIDER,
			apiKey: 'mock-key-noop',
			baseUrl: 'http://localhost:0',
			input: m.input ?? (['text', 'image'] as const),
			reasoning: m.reasoning ?? false,
			cost: m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: m.contextWindow ?? 128000,
			maxTokens: m.maxTokens ?? 16384,
		})),
	});

	pi.on('session_start', async (_event, ctx) => {
		const model = ctx.modelRegistry.find(MOCK_PROVIDER, MOCK_MODEL_ID);
		if (model) {
			const ok = await pi.setModel(model);
			if (!ok) {
				console.error('[mock-llm-completion] FAILED to switch to mock model');
			}
		} else {
			console.error('[mock-llm-completion] mock model not found in registry');
		}
	});
}
