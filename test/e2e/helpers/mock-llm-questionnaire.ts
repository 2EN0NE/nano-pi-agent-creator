/**
 * Mock LLM for questionnaire TUI tests.
 *
 * 第一个响应让模型调用 `questionnaire` 工具（带 multiSelect 问题），
 * 触发问卷 UI；后续响应返回纯文本，便于断言答案已提交。
 *
 * 使用方式：
 *   tui_expect_test "mock-llm-questionnaire,questionnaire" '...'
 */

import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
// registerFauxProvider 只在 /compat 子路径导出（主入口无此符号，见 AGENTS.md 与 mock-llm.ts 惯例）
import { registerFauxProvider } from '@earendil-works/pi-ai/compat';
import type { ExtensionAPI, ProviderConfig } from '@earendil-works/pi-coding-agent';
import type { Model } from '@earendil-works/pi-ai';

const PROVIDER = 'mock-llm-questionnaire';
const MODEL_ID = 'mock-model-1';

export default function (pi: ExtensionAPI) {
	const faux = registerFauxProvider({
		provider: PROVIDER,
		models: [{ id: MODEL_ID, name: 'Mock Model' }],
	});

	faux.setResponses([
		// 第一次调用：让模型发起 questionnaire 工具调用（多选）
		fauxAssistantMessage(
			[
				fauxText('Let me ask a question.'),
				fauxToolCall('questionnaire', {
					questions: [
						{
							id: 'q1',
							label: 'Q1',
							prompt: '请选择多个选项',
							options: [
								{ value: 'a', label: '选项 A' },
								{ value: 'b', label: '选项 B' },
								{ value: 'c', label: '选项 C' },
							],
							multiSelect: true,
						},
					],
				}),
			],
			{ stopReason: 'toolUse' },
		),
		// 问卷提交后：返回确认文本
		fauxAssistantMessage('Thanks, answer received.'),
	]);

	pi.registerProvider(PROVIDER, {
		name: 'Mock LLM Questionnaire Provider',
		api: faux.api as ProviderConfig['api'],
		baseUrl: 'http://localhost:0',
		apiKey: 'mock-key-noop',
		models: faux.models.map((m: Model<string>) => ({
			id: m.id,
			name: m.name ?? m.id,
			api: faux.api as ProviderConfig['api'],
			provider: PROVIDER,
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
		const model = ctx.modelRegistry.find(PROVIDER, MODEL_ID);
		if (model) {
			const ok = await pi.setModel(model);
			if (!ok) {
				console.error('[mock-llm-questionnaire] FAILED to switch to mock model');
			}
		} else {
			console.error('[mock-llm-questionnaire] mock model not found in registry');
		}
	});
}
