/**
 * Mock LLM Provider — 测试辅助扩展
 *
 * 通过 pi.registerProvider() + streamSimple 注册一个虚假的模型 provider，
 * 在 session_start 时自动将 Pi 切换到该 mock 模型，使所有 LLM 调用返回
 * 预定义的 mock 回复，无需真实 API Key 和网络请求。
 *
 * 本扩展遵循 test/extensions/<target>/helpers/ 的约定，
 * 供 pi-rate-limiter 等插件的 e2e 测试使用。
 *
 * 用法：
 *   在 test 脚本中手动拷贝到隔离沙箱，作为 --extensions 依赖注入。
 *
 * 通过 pi.events 控制 mock 回复：
 *   pi.events.emit('mock-llm:set-responses', [...])
 *   pi.events.emit('mock-llm:append-responses', [...])
 *
 * 导入：
 *   import { fauxText, fauxToolCall, fauxThinking, fauxAssistantMessage }
 *     from '@earendil-works/pi-ai';
 */

import { createFauxCore, fauxAssistantMessage, type FauxResponseStep } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const MOCK_PROVIDER = 'mock-llm';
const MOCK_MODEL_ID = 'mock-model-1';

export default function (pi: ExtensionAPI) {
	// ── 创建 faux provider 核心 ──
	const faux = createFauxCore({
		provider: MOCK_PROVIDER,
		models: [{ id: MOCK_MODEL_ID, name: 'Mock Model' }],
	});

	// ── 注册为 Pi 的可用 provider ──
	// 注意：streamSimple 被 Pi 的 agent session 调用以获取 LLM 回复。
	// baseUrl / apiKey 是占位值（streamSimple 不发起真实 HTTP 请求）。
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

	// ── 默认 mock 回复（可在测试中通过 events 覆盖） ──
	faux.setResponses([fauxAssistantMessage('Mock LLM is ready.')]);

	// ── 暴露控制接口给测试脚本 ──
	pi.events.on('mock-llm:set-responses', (responses: FauxResponseStep[]) => {
		faux.setResponses(responses);
	});
	pi.events.on('mock-llm:append-responses', (responses: FauxResponseStep[]) => {
		faux.appendResponses(responses);
	});

	// ── session 启动时切换到 mock 模型 ──
	pi.on('session_start', async (_event, ctx) => {
		const model = ctx.modelRegistry.find(MOCK_PROVIDER, MOCK_MODEL_ID);
		if (model) {
			const ok = await pi.setModel(model);
			if (!ok) {
				console.error('[mock-llm] FAILED to switch to mock model — tests may hit real API');
			}
		} else {
			console.error('[mock-llm] Mock model not found in registry');
		}
	});
}
