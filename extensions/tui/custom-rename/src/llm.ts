import type {
	AssistantMessage,
	Message,
	Model,
	Api,
	ModelThinkingLevel,
} from '@earendil-works/pi-ai';
import { completeSimple } from '@earendil-works/pi-ai/compat';
import type { Context as LlmContext, SimpleStreamOptions } from '@earendil-works/pi-ai/compat';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createLogger } from '@zenone/pi-logger';

import { type RenameSessionConfig, cleanTitle, parseModelRef } from './pure.js';

const log = createLogger('custom-rename:llm');

// ──────────────────────── prompt 常量 ────────────────────────

/**
 * rename 专属 systemPrompt（slug 词组风格约束，< 200 字符）。
 * 只为标题生成服务，不搭便车整个 agent prompt，省 input token 成本。
 */
export const RENAME_SYSTEM_PROMPT =
	'你是会话标题生成器。根据对话生成 slug 式标题：名词或动名词词组，不要完整句子、不要主谓宾、不要代词或「已/完成了」这类时态表述、不要句尾标点。英文用小写 kebab-case。使用对话所用的语言，3-6 个词。只输出标题文本。';

/**
 * 追加到对话末尾的 user 指令（与 RENAME_SYSTEM_PROMPT 双处一致约束）。
 * 含正例（「修复登录超时」「refactor-config-loader」）与反例（「我帮你修复了登录 bug」）few-shot 锚定。
 */
export const RENAME_INSTRUCTION =
	'根据以上对话，为这个会话生成一个 slug 式标题。要求：\n- 名词或动名词词组，例：「修复登录超时」「重构配置加载」「refactor-config-loader」\n- 反例（错误）：「我帮你修复了登录 bug」「This session is about fixing bugs」\n- 英文小写 kebab-case，中文直接用词组，不要句号\n使用对话所用的语言。只输出标题文本。';

// ──────────────────────── 纯函数 ────────────────────────

/** entry 的宽松类型（structural typing，兼容 pi 的 SessionEntry[] 但不依赖 pi 类型）。 */
interface EntryLike {
	type: string;
	message?: unknown;
}

// ──────────────────────── 标题输入构造（两段信号） ────────────────────────

/** unknown → Record 的运行时守卫。 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

/** 拼接 content 内 type==="text" blocks 的文本（join(" ")，跳过非 text block 与非 string text）。 */
function joinTextBlocks(content: unknown): string {
	if (!Array.isArray(content)) return '';
	const texts: string[] = [];
	for (const block of content) {
		if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
			texts.push(block.text);
		}
	}
	return texts.join(' ');
}

/**
 * 取 session entries 中首条 user message 的 prompt 文本（标题输入信号之一）。
 *
 * content 为 string 直接返回；为 blocks 数组时拼接 type==='text' 的 text（多 block 用 join(' ')），
 * 跳过 ImageContent（标题模型可能不支持图片输入）。无 user message 返回 null。
 */
export function extractUserPromptText(entries: ReadonlyArray<EntryLike>): string | null {
	for (const entry of entries) {
		if (entry.type !== 'message' || !isRecord(entry.message)) continue;
		const message = entry.message;
		if (message.role !== 'user') continue;
		if (typeof message.content === 'string') return message.content;
		return joinTextBlocks(message.content);
	}
	return null;
}

/**
 * 从触发 turn 的 assistant message（turn_end 的 event.message）提取最终回复文本。
 * 拼接 content 内 type==='text' 的 text（join(' ')，跳过 thinking/toolCall）；无 text 返回 ''。
 */
export function extractFinalText(message: unknown): string {
	return isRecord(message) ? joinTextBlocks(message.content) : '';
}

/** 输入段截断上限（Unicode 码点数，中文场景约 4k token/段）。 */
const MAX_TITLE_INPUT_CODE_POINTS = 4000;

/**
 * 按 Unicode 码点截断标题输入段。Array.from 按码点切分，星面字符（emoji 等）不会被劈成半个代理对；
 * 超长才追加 '…' 后缀，≤ 上限（含恰好等于）原样返回。
 */
export function truncateForTitle(text: string): string {
	const chars = Array.from(text);
	if (chars.length <= MAX_TITLE_INPUT_CODE_POINTS) return text;
	return chars.slice(0, MAX_TITLE_INPUT_CODE_POINTS).join('') + '…';
}

/**
 * 合成 assistant 条目的输入侧类型：剥掉 pi 输出侧记账必填字段
 * （api/provider/model/usage/stopReason/timestamp），只留输入路径消费的字段。
 */
type AssistantTextInput = Omit<
	AssistantMessage,
	'api' | 'provider' | 'model' | 'usage' | 'stopReason' | 'timestamp'
>;

/**
 * 构造标题 LLM 的 messages：[user(prompt), assistant(finalText 仅非空时), user(instruction)]。
 * 两段文本信号（任务意图 + 轮次结论）恰好与标题语义对齐，不含 toolCall/toolResult 等过程数据。
 * finalText 为空（纯工具结束的 round）时降级为两条。
 */
export function buildTitleMessages(
	userPrompt: string,
	finalText: string,
	instruction: string,
): Message[] {
	const messages: Message[] = [
		{ role: 'user', content: [{ type: 'text', text: userPrompt }], timestamp: Date.now() },
	];
	if (finalText !== '') {
		const assistantText: AssistantTextInput = {
			role: 'assistant',
			content: [{ type: 'text', text: finalText }],
		};
		messages.push(assistantText as Message);
	}
	messages.push({
		role: 'user',
		content: [{ type: 'text', text: instruction }],
		timestamp: Date.now(),
	});
	return messages;
}

// ──────────────────────── 模型解析与 LLM 调用 ────────────────────────

/** rename LLM 超时（输入 ≤8k token + 输出 64 token，30s 宽裕；超时归一为失败静默跳过）。 */
const RENAME_TIMEOUT_MS = 30_000;

/**
 * 按 selector 解析模型（仅 ref 精确指定）。返回 null = 不可用，调用方静默跳过。
 * 走 ctx.modelRegistry（pi 三源合并后的模型注册表），hasConfiguredAuth 过滤掉未配置凭证的模型。
 * ref 拆分统一走 pure.parseModelRef（与 env 覆盖校验同一实现，见 pure.ts）。
 *
 * 导出给 index.ts 触发点做前置检查（模型不可用 → 用户可见 warning 而非静默跳过）。
 */
export function resolveRenameModel(
	ctx: ExtensionContext,
	selector: { type: 'ref'; ref: string },
): Model<Api> | null {
	const parsed = parseModelRef(selector.ref);
	if (!parsed) return null;
	const model = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
	if (!model) return null;
	if (!ctx.modelRegistry.hasConfiguredAuth(model)) return null;
	return model;
}

/**
 * 从 AssistantMessage.content 提取所有 text block 拼接并 trim。无 text block → 返回 ""。
 */
function extractText(resp: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
	return resp.content
		.filter((block) => block.type === 'text')
		.map((block) => block.text ?? '')
		.join(' ')
		.trim();
}

type CallLLMResult =
	| { ok: true; content: string }
	| { ok: false; error: string; recoverable: boolean; stopReason?: 'error' | 'aborted' };

/**
 * 发起一次 LLM 调用（completeSimple），返回归一化结果。
 *
 * 流程：凭证注入（getApiKeyAndHeaders，判别联合 narrow）→ completeSimple（tools:[]，不塞工具）
 * → stopReason error/aborted 归一为 ok:false → extractText 返回 ok:true → throw 归一为 ok:false。
 */
async function callLLM(
	ctx: ExtensionContext,
	opts: {
		model: Model<Api>;
		systemPrompt: string;
		messages: Message[];
		maxTokens?: number;
		signal?: AbortSignal;
		timeoutMs?: number;
		sessionId?: string;
		reasoning?: ModelThinkingLevel;
	},
): Promise<CallLLMResult> {
	try {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(opts.model);
		if (!auth.ok) {
			return { ok: false, error: auth.error, recoverable: true };
		}

		const context: LlmContext = {
			systemPrompt: opts.systemPrompt,
			messages: opts.messages,
			tools: [],
		};
		const options: SimpleStreamOptions = {
			apiKey: auth.apiKey,
			headers: auth.headers,
			...(opts.signal ? { signal: opts.signal } : {}),
			...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}),
			...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
			...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
			...(opts.reasoning && opts.reasoning !== 'off' ? { reasoning: opts.reasoning } : {}),
		};
		const resp = await completeSimple(opts.model, context, options);

		if (resp.stopReason === 'error' || resp.stopReason === 'aborted') {
			const errorText = extractText(resp) || 'unknown error';
			return { ok: false, error: errorText, recoverable: true, stopReason: resp.stopReason };
		}
		return { ok: true, content: extractText(resp) };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
			recoverable: true,
		};
	}
}

// ──────────────────────── 标题生成入口 ────────────────────────

/**
 * 发起 rename LLM 调用，返回提取+清洗后的标题（空串/异常返回 null 表示应跳过 rename）。
 *
 * finalMessage：触发 turn 的 event.message（stopReason==='stop' 的 turn_end 自带最终
 * assistant message，final text 零遍历可得）。
 *
 * 本函数是 async；调用方（turn_end handler）用 fire-and-forget 包裹，禁止 await
 * 本函数（会阻塞 handler）。
 */
export async function callRenameLLM(
	ctx: ExtensionContext,
	config: RenameSessionConfig,
	finalMessage: unknown,
): Promise<string | null> {
	const model = resolveRenameModel(ctx, config.model);
	if (!model) {
		log.warn('model not available, skipping');
		return null;
	}

	const userPrompt = extractUserPromptText(
		ctx.sessionManager.getEntries() as ReadonlyArray<EntryLike>,
	);
	if (userPrompt === null) {
		log.warn('skip: no user prompt');
		return null;
	}
	// 空 prompt（空串 / 纯 image 等无 text block）→ 无任务意图信号，跳过。
	// 此时 LLM 基于空输入生成的标题不可控，直接保留原 label 更稳。
	if (userPrompt === '') {
		log.warn('skip: empty user prompt');
		return null;
	}
	const finalText = extractFinalText(finalMessage);

	const messages = buildTitleMessages(
		truncateForTitle(userPrompt),
		truncateForTitle(finalText),
		RENAME_INSTRUCTION,
	);

	const sessionId = ctx.sessionManager.getSessionId();
	const result = await callLLM(ctx, {
		model,
		systemPrompt: RENAME_SYSTEM_PROMPT,
		messages,
		maxTokens: 64,
		timeoutMs: RENAME_TIMEOUT_MS,
		signal: ctx.signal,
		sessionId,
		reasoning: config.thinkingLevel,
	});
	if (!result.ok) {
		log.warn('rename LLM call failed', { error: result.error ?? 'unknown error' });
		return null;
	}

	const title = cleanTitle(result.content, config.maxTitleLength);
	if (!title) {
		log.warn('skip: title empty');
		return null;
	}
	return title;
}
