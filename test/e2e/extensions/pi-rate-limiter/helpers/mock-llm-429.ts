/**
 * Mock LLM Provider — 429 Error Simulator
 *
 * 一个专门模拟连续 429 限流错误的测试辅助扩展。
 * 返回 N 个 error 响应（stopReason: "error", errorMessage 匹配 is432LikeError），
 * 最后返回一个正常 success 响应。
 *
 * 适用于测试 pi-rate-limiter 的 fork-on-consecutive-429 特性：
 *   连续 3 次 429 → /rate-limit-retry 命令触发 → fork 新会话重试
 *
 * 用法：
 *   在测试脚本中手动拷贝到隔离沙箱，作为 --extensions 依赖注入。
 *
 * 配置：
 *   通过环境变量设定：
 *     MOCK_429_COUNT=3     — 连续 429 错误次数（默认 3）
 *     MOCK_FINAL_TEXT="OK" — 最终成功的文本（默认 "Mock 429: success after retry"）
 */

import { createFauxCore, fauxAssistantMessage, type FauxResponseStep } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const MOCK_PROVIDER = 'mock-llm-429';
const MOCK_MODEL_ID = 'mock-429-model-1';

export default function (pi: ExtensionAPI) {
	// ── 从环境变量读取配置 ──
	const errorCount = Number(process.env.MOCK_429_COUNT) || 3;
	const finalText = process.env.MOCK_429_FINAL_TEXT || 'Mock 429: success after retry';

	// ── 创建 faux provider 核心 ──
	const faux = createFauxCore({
		provider: MOCK_PROVIDER,
		models: [{ id: MOCK_MODEL_ID, name: 'Mock 429 Model' }],
	});

	// ── 注册为 Pi 的可用 provider ──
	pi.registerProvider(MOCK_PROVIDER, {
		name: 'Mock 429 LLM Provider',
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

	// ── 构造响应序列：N 个 429 错误 + 1 个成功 ──
	const responses: FauxResponseStep[] = [];
	for (let i = 0; i < errorCount; i++) {
		responses.push(
			fauxAssistantMessage(`Mock 429 error #${i + 1}`, {
				stopReason: 'error',
				errorMessage: `432 rate limit exceeded (mock #${i + 1})`,
			}),
		);
	}
	responses.push(fauxAssistantMessage(finalText));
	faux.setResponses(responses);

	// ── session 启动时切换到 mock 模型 ──
	pi.on('session_start', async (_event, ctx) => {
		const model = ctx.modelRegistry.find(MOCK_PROVIDER, MOCK_MODEL_ID);
		if (model) {
			const ok = await pi.setModel(model);
			if (!ok) {
				console.error('[mock-llm-429] FAILED to switch to mock model');
			}
		} else {
			console.error('[mock-llm-429] Mock model not found in registry');
		}
	});
}
