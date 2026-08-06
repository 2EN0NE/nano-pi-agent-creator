/**
 * Mock LLM Provider — ci-watch 测试辅助扩展（已弃用）
 *
 * ⚠️ 此文件不再被 ci-watch smoke.test.sh 引用。
 * 共享版本位于 test/helpers/mock-llm.ts，所有新测试应使用共享版本。
 *
 * 保留此文件仅作历史参考。
 */

import { registerFauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const MOCK_PROVIDER = 'mock-llm';
const MOCK_MODEL_ID = 'mock-model-1';

export default function (pi: ExtensionAPI) {
	const faux = registerFauxProvider({
		provider: MOCK_PROVIDER,
		models: [{ id: MOCK_MODEL_ID, name: 'Mock Model' }],
	});

	faux.setResponses([fauxAssistantMessage('Mock LLM is ready.')]);

	// 通过 Extension API 双重注册，确保 ctx.modelRegistry 可找到 mock 模型
	// faux.api 包含动态生成的 UUID（如 faux:1234567890:xxxx），必须用于 api 字段
	// 类型标注用 any 绕过 pi-ai 与 pi-coding-agent 的类型版本差异
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	pi.registerProvider(
		MOCK_PROVIDER as any,
		{
			name: 'Mock LLM Provider',
			api: faux.api,
			baseUrl: 'http://localhost:0',
			apiKey: 'mock-key-noop',
			models: faux.models.map((m) => ({
				id: m.id,
				name: m.name ?? m.id,
				api: (faux as any).api,
				provider: MOCK_PROVIDER,
				apiKey: 'mock-key-noop',
				baseUrl: 'http://localhost:0',
				input: ['text'] as const,
				reasoning: false,
				cost: { input: 0, output: 0 },
				contextWindow: 128000,
				maxTokens: 16384,
			})),
		} as any,
	);

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
