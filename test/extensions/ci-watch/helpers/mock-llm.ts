/**
 * Mock LLM Provider — ci-watch 测试辅助扩展
 *
 * 注册虚假 LLM provider，使 pi 无需真实 API Key 即可启动，
 * 让扩展的 session_start / 命令注册等流程可以完整执行。
 *
 * 用法：在 smoke.test.sh 中手动拷贝到隔离沙箱。
 *
 * 默认回复："Mock LLM is ready."
 */

import { createFauxCore, fauxAssistantMessage } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const MOCK_PROVIDER = 'mock-llm';
const MOCK_MODEL_ID = 'mock-model-1';

export default function (pi: ExtensionAPI) {
	const faux = createFauxCore({
		provider: MOCK_PROVIDER,
		models: [{ id: MOCK_MODEL_ID, name: 'Mock Model' }],
	});

	pi.registerProvider(MOCK_PROVIDER, {
		name: 'Mock LLM Provider',
		api: faux.api,
		baseUrl: 'http://localhost:0',
		apiKey: 'mock-key-noop',
		streamSimple: faux.streamSimple,
		models: faux.models.map((m) => ({
			id: m.id,
			name: m.name ?? m.id,
			reasoning: m.reasoning,
			input: m.input as ('text' | 'image')[],
			cost: m.cost,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
		})),
	});

	// 默认回复
	faux.setResponses([fauxAssistantMessage('Mock LLM is ready.')]);

	pi.on('session_start', async (_event, ctx) => {
		const model = ctx.modelRegistry.find(MOCK_PROVIDER, MOCK_MODEL_ID);
		if (model) {
			const ok = await pi.setModel(model);
			if (!ok) {
				console.error('[mock-llm] FAILED to switch to mock model');
			}
		}
	});
}
