/**
 * Mock LLM Provider — 共享测试辅助扩展
 *
 * 注册虚假 LLM provider，使 pi 无需真实 API Key 即可启动，
 * 让扩展的 session_start / 命令注册等流程可以完整执行。
 *
 * 默认回复："Mock LLM is ready."
 *
 * 使用方式（在 smoke.test.sh 中）：
 *   run_pi_and_check --extensions "mock-llm,目标扩展" --prompt "hi"
 *
 * 通过在依赖列表中列出 "mock-llm" 即可自动纳入沙箱。
 * （run_pi_and_check 会从 test/helpers/ 搜索扩展文件）。
 *
 * 架构说明：
 *   registerFauxProvider() 在 pi-ai 层注册了 stream/streamSimple 函数，
 *   然后通过 pi.registerProvider() 将模型同步到 ModelRegistry，
 *   使 ctx.modelRegistry.find() 和 pi.setModel() 可以正常工作。
 */

import { registerFauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ProviderConfig } from '@earendil-works/pi-coding-agent';

const MOCK_PROVIDER = 'mock-llm';
const MOCK_MODEL_ID = 'mock-model-1';

export default function (pi: ExtensionAPI) {
	const faux = registerFauxProvider({
		provider: MOCK_PROVIDER,
		models: [{ id: MOCK_MODEL_ID, name: 'Mock Model' }],
	});

	// 默认回复
	faux.setResponses([fauxAssistantMessage('Mock LLM is ready.')]);

	// 注册到 ModelRegistry，使 ctx.modelRegistry 能通过 find() 找到 mock 模型
	// faux.api 是 registerFauxProvider 内部生成的 UUID（如 faux:1234567890:xxxx），
	// 同时也是 pi-ai 层 stream 函数的注册 key。
	// 模型将 api 设为同一 UUID，使得 pi 调用模型时能正确找到 stream 函数。
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
