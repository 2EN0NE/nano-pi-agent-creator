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

import { registerFauxProvider } from '@earendil-works/pi-ai/compat';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionAPI, ProviderConfig } from '@earendil-works/pi-coding-agent';

const MOCK_PROVIDER = 'mock-llm';
const MOCK_MODEL_ID = 'mock-model-1';

// ── MOCK_LLM_TOOL_SCRIPT（ADR-0045 D3）：按脚本注入工具调用 ─────────────────────
//
// 多 agent 自主闭环 e2e 的外置大脑：让"两个真实 pi 进程"能各自按剧本行动
// （A 派发 → B 认领/交付 → A 验收），从而验证**机制支持 agent 自主**。
//
// 注意：本文件被 run-e2e.sh **单文件拷贝**成 `<sandbox>/.pi/extensions/mock-llm/index.ts`，
// 因此纯逻辑必须内联在此（不能拆到同目录文件）。

/** 脚本的一步：一次工具调用，或一段文本（吸收中间轮次 / 收尾） */
export interface ToolScriptStep {
	tool?: string;
	args?: Record<string, unknown>;
	text?: string;
}

/**
 * 解析 `MOCK_LLM_TOOL_SCRIPT`。空/未设置 → 空数组（不影响现有用例）。
 * 非法输入 **fail fast 并注明变量名**——静默跳过会让 e2e 变成"跑了但没验证"。
 */
export function parseToolScript(raw: string | undefined): ToolScriptStep[] {
	if (!raw || !raw.trim()) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		throw new Error(
			`MOCK_LLM_TOOL_SCRIPT 不是合法 JSON：${e instanceof Error ? e.message : String(e)}`,
		);
	}
	if (!Array.isArray(parsed)) throw new Error('MOCK_LLM_TOOL_SCRIPT 必须是 JSON 数组');
	return parsed.map((el, i): ToolScriptStep => {
		if (typeof el !== 'object' || el === null) {
			throw new Error(`MOCK_LLM_TOOL_SCRIPT[${i}] 必须是对象`);
		}
		const { tool, args, text } = el as { tool?: unknown; args?: unknown; text?: unknown };
		if (text !== undefined) {
			if (typeof text !== 'string') {
				throw new Error(`MOCK_LLM_TOOL_SCRIPT[${i}].text 必须是字符串`);
			}
			return { text };
		}
		if (typeof tool !== 'string') {
			throw new Error(`MOCK_LLM_TOOL_SCRIPT[${i}] 需要 tool（字符串）或 text`);
		}
		if (args !== undefined && (typeof args !== 'object' || args === null)) {
			throw new Error(`MOCK_LLM_TOOL_SCRIPT[${i}].args 必须是对象`);
		}
		return { tool, args: (args ?? {}) as Record<string, unknown> };
	});
}

/** 递归收集请求消息里的全部文本（含嵌套 content 数组） */
function collectText(value: unknown, out: string[]): void {
	if (typeof value === 'string') {
		out.push(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const v of value) collectText(v, out);
		return;
	}
	if (value && typeof value === 'object') {
		for (const v of Object.values(value as Record<string, unknown>)) collectText(v, out);
	}
}

/**
 * 从**请求消息**里抽取运行时占位符的值。
 *
 * 任务号 `M-xxxxxx` 由 org 运行时生成，脚本无法预知，故写 `{{taskId}}` 由这里填。
 */
export function extractScriptVars(messages: unknown): Record<string, string> {
	const texts: string[] = [];
	collectText(messages, texts);
	const taskId = texts.join('\n').match(/\bM-[a-z0-9]{6,}\b/)?.[0] ?? '';
	return { taskId };
}

/** 递归替换 `{{key}}`；未知 key → 空串（不把语法泄漏给模型） */
export function applyVars(value: unknown, vars: Record<string, string>): unknown {
	if (typeof value === 'string') {
		return value.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => vars[k] ?? '');
	}
	if (Array.isArray(value)) return value.map((v) => applyVars(v, vars));
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			out[k] = applyVars(v, vars);
		}
		return out;
	}
	return value;
}

/** 成员目录里的脚本文件名（被唤醒进程无法从 env 收脚本，改由 cwd 文件提供；shell 侧按此硬编码，见 smoke.test.sh） */
const TOOL_SCRIPT_FILE = '.mock-llm-script.json';

function readCwdScriptFile(): string | undefined {
	try {
		return readFileSync(join(process.cwd(), TOOL_SCRIPT_FILE), 'utf8');
	} catch {
		return undefined;
	}
}

export default function (pi: ExtensionAPI) {
	const faux = registerFauxProvider({
		provider: MOCK_PROVIDER,
		models: [{ id: MOCK_MODEL_ID, name: 'Mock Model' }],
	});

	// MOCK_LLM_TOOL_CALLS=N：注入 N 个 bash 工具调用（长命令路径），
	// 使 chat 区渲染超长工具行（>91 列 → wrap），复现窄终端行定位错位。
	// MOCK_LLM_BASH_COMMAND="..."：自定义注入的 bash 命令（{i} 替换为序号）。
	// 默认仍为 pi-session-tree 的 cat 命令；bash-timeout 用它注入 sleep 验证超时。
	const toolCalls = Number.parseInt(process.env.MOCK_LLM_TOOL_CALLS ?? '0', 10);
	const bashCommand = process.env.MOCK_LLM_BASH_COMMAND ?? '';
	// MOCK_LLM_REPEAT=N：补足 N 个相同响应，用于多条消息构造稳定长树
	// （>20 节点触发面板滚动路径的 e2e 测试，避免 tool call 异步写入的时序不稳定）
	const repeat = Number.parseInt(process.env.MOCK_LLM_REPEAT ?? '0', 10);
	// MOCK_LLM_DANGEROUS_COMMAND="..."：注入危险 bash 命令触发 permission-gate 拦截
	// （树状阻断框 e2e 用）。MOCK_LLM_DANGEROUS_REPEAT=N：前 N 次 agent 请求各触发一次
	// tool call（其后无限返回 text），适配 permission-gate 确认框导致的 turn 边界变化。
	const dangerousCommand = process.env.MOCK_LLM_DANGEROUS_COMMAND;
	const dangerousRepeat = Number.parseInt(process.env.MOCK_LLM_DANGEROUS_REPEAT ?? '1', 10);
	// MOCK_LLM_RECORD_CONTEXT=1：记录每次请求的 context（provider 序列化后的
	// messages）到 stdout，供 e2e 断言"LLM 收到零文本"——invisible continue
	// marker 应已被 context hook 过滤，不出现在任何请求里。
	const recordContext = process.env.MOCK_LLM_RECORD_CONTEXT === '1';
	const INVISIBLE_MARKER = 'custom-compaction:invisible-continue';

	// MOCK_LLM_TOOL_SCRIPT：顺序回放脚本（ADR-0045 D3）——多 agent 自主闭环的"外置大脑"。
	// 优先于其它模式（显式 opt-in）。每次 LLM 请求消费一步；用尽后回落到收尾文本，
	// 否则 agent 会因 "No more faux responses queued" 卡住。
	//
	// 回退：环境变量缺失时读 **cwd** 下的 `.mock-llm-script.json`。
	// 用途是 ADR-0048 `E1`——被「唤醒」拉起的成员进程只继承 PATH/HOME/ORG_ROOT，
	// 无法从唤醒者注入 MOCK_LLM_TOOL_SCRIPT；脚本改放成员目录，成员自己读到。
	const script = parseToolScript(process.env.MOCK_LLM_TOOL_SCRIPT ?? readCwdScriptFile());
	if (script.length > 0) {
		let cursor = 0;
		const scriptLoop = async (context: unknown) => {
			const vars = extractScriptVars((context as { messages?: unknown })?.messages);
			const step = script[cursor];
			cursor += 1;
			faux.appendResponses([scriptLoop]); // 无限链：后续请求仍有响应
			if (!step) return fauxAssistantMessage('Mock LLM script finished.');
			if (typeof step.text === 'string') {
				return fauxAssistantMessage(applyVars(step.text, vars) as string);
			}
			const args = applyVars(step.args ?? {}, vars) as Record<string, unknown>;
			return fauxAssistantMessage([fauxToolCall(step.tool as string, args)], {
				stopReason: 'toolUse' as never,
			});
		};
		faux.setResponses([scriptLoop]);
	} else if (dangerousCommand) {
		let toolsLeft = dangerousRepeat;
		const loop = async () => {
			faux.appendResponses([loop]);
			if (toolsLeft > 0) {
				toolsLeft--;
				return fauxAssistantMessage([fauxToolCall('bash', { command: dangerousCommand })], {
					stopReason: 'toolUse' as never,
				});
			}
			return fauxAssistantMessage('The command has been executed.');
		};
		faux.setResponses([loop]);
	} else if (recordContext) {
		// loop 无限响应：压缩 summarization 请求 + 自动继续 turn 都需要响应，
		// 否则 "No more faux responses queued" 导致 agent 卡住。
		// context 是 { messages: Message[] }（pi-ai Context），非数组。
		// 注意：convertToLlm 会把 custom 消息的 customType 丢弃、content 保留，
		// 故 marker 泄漏的可见信号是「空 user 消息」（marker content 为 []）。
		const loop = async (context: unknown, _options: unknown, state: { callCount: number }) => {
			const messages = (context as { messages?: Array<Record<string, unknown>> })?.messages;
			const hasMarker =
				Array.isArray(messages) && messages.some((m) => m.customType === INVISIBLE_MARKER);
			const emptyUser =
				Array.isArray(messages) &&
				messages.some(
					(m) =>
						m.role === 'user' &&
						(Array.isArray(m.content) ? m.content.length === 0 : !m.content),
				);
			console.log(
				`[mock-llm-context] has-invisible-marker=${hasMarker} empty-user=${emptyUser} call=${state.callCount}`,
			);
			faux.appendResponses([loop]);
			// 前 toolCalls 轮返回 bash 工具调用，让 agent 执行产生多轮 entry，
			// 供压缩的 findCutPoint 在多条消息之间切分（单条超长 user 消息无法压缩）。
			if (state.callCount <= toolCalls) {
				return fauxAssistantMessage([
					fauxToolCall('bash', { command: `echo "mock tool call ${state.callCount}"` }),
					{ type: 'text', text: `Tool call ${state.callCount}.` },
				]);
			}
			return fauxAssistantMessage('Mock LLM is ready.');
		};
		faux.setResponses([loop]);
	} else if (toolCalls > 0) {
		const blocks: Parameters<typeof fauxAssistantMessage>[0] = [];
		for (let i = 0; i < toolCalls; i++) {
			const command = bashCommand
				? bashCommand.replaceAll('{i}', String(i))
				: `cat /var/folders/h3/k2s6vqq91nvgbvmxrvdrhlx00000gn/T/pi-session-tree-handoff-${i}.md`;
			blocks.push(
				fauxToolCall('bash', {
					command,
				}),
			);
		}
		blocks.push({ type: 'text', text: 'Tool calls done.' });
		// 无限响应（函数自追加）：工具结果处理后的 agent 后续请求永远返回继续，
		// 避免 "No more faux responses queued" 导致 agent 卡住
		const loop = async () => {
			faux.appendResponses([loop]);
			return fauxAssistantMessage('Continuing.');
		};
		faux.setResponses([fauxAssistantMessage(blocks), loop]);
	} else if (repeat > 0) {
		// 超长回复（>91 列）：复现窄终端 chat 区 wrap 行定位错位
		const LONG_REPLY =
			'This is a very long assistant reply that exceeds the ninety one column terminal width and wraps onto a second physical line in the chat area.';
		faux.setResponses(Array.from({ length: repeat }, () => fauxAssistantMessage(LONG_REPLY)));
	} else {
		faux.setResponses([fauxAssistantMessage('Mock LLM is ready.')]);
	}

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
