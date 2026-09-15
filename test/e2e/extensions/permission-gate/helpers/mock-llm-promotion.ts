/**
 * Mock LLM — 提升 / 出处条件 e2e 专用辅助扩展
 *
 * 与同目录 `mock-llm.ts` 的区别：按环境变量 `PG_E2E_COMMANDS`（`;;` 分隔）生成**一串**
 * bash 工具调用，从而能构造「前一条命令创建、后一条命令删除」的真实会话序列——
 * 这正是出处条件判定成立的前提（账本只登记**已实际执行**的命令）。
 *
 * 用法：
 *   PG_E2E_COMMANDS="mkdir -p /tmp/x;;rm -rf /tmp/x" run_pi "$test_home" "..."
 */

import { createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
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

	const commands = (process.env.PG_E2E_COMMANDS ?? 'echo pg-e2e-noop')
		.split(';;')
		.map((s) => s.trim())
		.filter(Boolean);

	faux.setResponses([
		...commands.map((command) =>
			fauxAssistantMessage([fauxToolCall('bash', { command })], {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				stopReason: 'toolUse' as any,
			}),
		),
		fauxAssistantMessage('The commands have been executed.'),
	]);

	pi.on('session_start', async (_event, ctx) => {
		const model = ctx.modelRegistry.find(MOCK_PROVIDER, MOCK_MODEL_ID);
		if (model) await pi.setModel(model);
	});
}
