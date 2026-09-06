/**
 * Mock LLM Provider — custom-rename 专用测试辅助扩展
 *
 * 在共享 mock-llm（test/e2e/helpers/mock-llm.ts）基础上，
 * 提供 2 条回复：
 *   1. 首轮 agent 回复："Mock LLM is ready."
 *   2. rename LLM 的标题回复："修复登录超时"
 *
 * 这样 custom-rename 的首轮成功命名链路可以完整走通：
 *   首轮 stop → turn_end 触发 → callRenameLLM（completeSimple 消耗第 2 条）
 *   → cleanTitle → setSessionName → 日志 `renamed to "修复登录超时"`。
 */
import { registerFauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/compat';
import type { ExtensionAPI, ProviderConfig } from '@earendil-works/pi-coding-agent';

const MOCK_PROVIDER = 'mock-llm';
const MOCK_MODEL_ID = 'mock-model-1';

export default function (pi: ExtensionAPI) {
	const faux = registerFauxProvider({
		provider: MOCK_PROVIDER,
		models: [{ id: MOCK_MODEL_ID, name: 'Mock Model' }],
	});

	faux.setResponses([
		fauxAssistantMessage('Mock LLM is ready.'),
		fauxAssistantMessage('修复登录超时'),
	]);

	pi.registerProvider(MOCK_PROVIDER, {
		name: 'Mock LLM Provider',
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
				console.error('[mock-llm] FAILED to switch to mock model');
			}
		} else {
			console.error('[mock-llm] mock model not found in registry');
		}
	});
}
