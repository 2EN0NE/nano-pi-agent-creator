/**
 * Mock LLM Provider — permission-gate 测试辅助扩展
 *
 * 扩展标准 mock-llm：用 fauxToolCall 生成危险的 bash 命令，
 * 触发 permission-gate 的拦截逻辑，测试动态策略自动放行。
 *
 * 用法：
 *   bash test/scripts/run-e2e.sh --ext permission-gate
 *
 * 控制接口（通过 pi.events）：
 *   pi.events.emit('mock-llm:set-responses', [...])
 *   pi.events.emit('mock-llm:append-responses', [...])
 */

import {
	createFauxCore,
	fauxAssistantMessage,
	fauxToolCall,
	type FauxResponseStep,
} from '@earendil-works/pi-ai';
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
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		models: faux.models.map((m: any) => ({
			id: m.id,
			name: m.name ?? m.id,
			reasoning: m.reasoning,
			input: m.input as ('text' | 'image')[],
			cost: m.cost,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
		})),
	});

	// 默认 mock 回复：生成一个危险的 bash 工具调用 + 后续文本
	faux.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall('bash', {
					command: 'rm -rf ./permission-gate-test-target',
				}),
			],
			{ stopReason: 'toolUse' as any },
		),
		fauxAssistantMessage('The command has been executed successfully.'),
	]);

	// 暴露控制接口
	pi.events.on('mock-llm:set-responses', (responses: unknown) => {
		faux.setResponses(responses as FauxResponseStep[]);
	});
	pi.events.on('mock-llm:append-responses', (responses: unknown) => {
		faux.appendResponses(responses as FauxResponseStep[]);
	});

	// session 启动时切换到 mock 模型
	pi.on('session_start', async (_event, ctx) => {
		const model = ctx.modelRegistry.find(MOCK_PROVIDER, MOCK_MODEL_ID);
		if (model) {
			const ok = await pi.setModel(model);
			if (!ok) {
				console.error('[mock-llm] FAILED to switch to mock model');
			}
		} else {
			console.error('[mock-llm] Mock model not found in registry');
		}
	});
}
