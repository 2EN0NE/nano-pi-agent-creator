/**
 * Mock LLM Provider — ci-watch 自动监控 e2e 专用
 *
 * 在共享版（test/helpers/mock-llm.ts）基础上，支持通过环境变量
 * `MOCK_LLM_BASH_OUTPUT` 让 mock 模型先返回一个 bash tool call，
 * 使 agent 真实执行 bash 工具并产生 `tool_result` 事件——
 * ci-watch 的自动监控（tool_result → push 检测 → 轮询）由此走真实路径
 * （仅 mock LLM，bash / tool_result / gh 均真实）。
 *
 * 用法（smoke.test.sh）：
 *   MOCK_LLM_BASH_OUTPUT='To github.com:2EN0NE/repo.git   abc..def  main -> main' \
 *     run_pi "$test_home" "hi"
 *
 * 未设置 MOCK_LLM_BASH_OUTPUT 时行为与共享版一致（纯文本回复）。
 */

import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { registerFauxProvider } from '@earendil-works/pi-ai/compat';
import type { ExtensionAPI, ProviderConfig } from '@earendil-works/pi-coding-agent';

const MOCK_PROVIDER = 'mock-llm';
const MOCK_MODEL_ID = 'mock-model-1';

export default function (pi: ExtensionAPI) {
	const faux = registerFauxProvider({
		provider: MOCK_PROVIDER,
		models: [{ id: MOCK_MODEL_ID, name: 'Mock Model' }],
	});

	const bashOutput = process.env.MOCK_LLM_BASH_OUTPUT;
	// sendUserMessage（fail 通知触发 agent 处理 followUp）会发起额外 LLM 调用，
	// 响应队列耗尽会报 "No more faux responses queued" 致 pi 退出 1——
	// 用 MOCK_LLM_EXTRA_RESPONSES=N 追加 N 条纯文本响应。
	const extraResponses = Number(process.env.MOCK_LLM_EXTRA_RESPONSES ?? 0);
	const responses: Array<ReturnType<typeof fauxAssistantMessage>> = [];
	if (bashOutput) {
		// 先返回一个 bash tool call（输出指定的 push 文本），再返回普通文本收尾
		const escaped = bashOutput.replace(/'/g, `'\\''`);
		responses.push(
			fauxAssistantMessage([
				fauxToolCall('bash', {
					command: `printf '%b' '${escaped}'`,
				}),
			]),
		);
	}
	responses.push(fauxAssistantMessage('Mock LLM is ready.'));
	for (let i = 0; i < extraResponses; i++) {
		responses.push(fauxAssistantMessage(`Mock LLM follow-up ${i + 1}.`));
	}
	faux.setResponses(responses);

	// 注册到 ModelRegistry，使 ctx.modelRegistry 能通过 find() 找到 mock 模型
	// faux.api 是 registerFauxProvider 内部生成的 UUID（如 faux:1234567890:xxxx），
	// 同时也是 pi-ai 层 stream 函数的注册 key。
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
