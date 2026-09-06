/**
 * custom-rename llm — 标题输入构造纯函数 + callRenameLLM（mock completeSimple 边界）。
 */
import type { Api, Model } from '@earendil-works/pi-ai';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@earendil-works/pi-ai/compat', async (importOriginal) => {
	const mod = await importOriginal<typeof import('@earendil-works/pi-ai/compat')>();
	return { ...mod, completeSimple: vi.fn() };
});

import { completeSimple } from '@earendil-works/pi-ai/compat';
import {
	RENAME_INSTRUCTION,
	RENAME_SYSTEM_PROMPT,
	buildTitleMessages,
	callRenameLLM,
	extractFinalText,
	extractUserPromptText,
	truncateForTitle,
} from '../../../extensions/tui/custom-rename/src/llm.js';
import type { RenameSessionConfig } from '../../../extensions/tui/custom-rename/src/pure.js';

afterEach(() => {
	vi.restoreAllMocks();
});

const STUB_MODEL: Model<Api> = {
	id: 'stub-model',
	name: 'Stub Model',
	api: 'anthropic-messages',
	provider: 'stub',
	baseUrl: 'https://stub.invalid',
	reasoning: false,
	input: ['text'],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
};

const BASE_CONFIG: RenameSessionConfig = {
	enabled: true,
	model: { type: 'ref', ref: 'stub/stub-model' },
	maxTitleLength: 50,
	thinkingLevel: 'off',
};

const FINAL_MESSAGE = {
	stopReason: 'stop',
	content: [
		{ type: 'thinking', thinking: '思考过程不进标题输入' },
		{ type: 'text', text: '已修复：调整了超时配置' },
	],
};

function createCtx(
	entries: unknown[] = [
		{ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
	],
	modelRegistryOverride?: Partial<Record<string, unknown>>,
): ExtensionContext {
	return {
		sessionManager: {
			getEntries: () => entries,
			getSessionId: () => 'test-session-id',
		},
		signal: new AbortController().signal,
		modelRegistry: {
			find: vi.fn(() => STUB_MODEL),
			hasConfiguredAuth: vi.fn(() => true),
			getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: 'k' })),
			...modelRegistryOverride,
		},
	} as unknown as ExtensionContext;
}

// ── 纯函数 ──

describe('extractUserPromptText', () => {
	it('content 为 string → 直接返回', () => {
		const entries = [
			{ type: 'message', message: { role: 'user', content: '帮我修复登录超时' } },
		];
		expect(extractUserPromptText(entries)).toBe('帮我修复登录超时');
	});

	it('blocks 混合（text+image+text）→ image 跳过，多 text block join(空格)', () => {
		const entries = [
			{
				type: 'message',
				message: {
					role: 'user',
					content: [
						{ type: 'text', text: '帮我修复登录超时' },
						{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
						{ type: 'text', text: '最好加单测' },
					],
				},
			},
		];
		expect(extractUserPromptText(entries)).toBe('帮我修复登录超时 最好加单测');
	});

	it('无 user message → null', () => {
		expect(extractUserPromptText([])).toBeNull();
	});
});

describe('extractFinalText', () => {
	it('text/thinking/toolCall 混合 → 只拼接 text block', () => {
		expect(extractFinalText(FINAL_MESSAGE)).toBe('已修复：调整了超时配置');
	});

	it('全空 content → 空串', () => {
		expect(extractFinalText({ content: [] })).toBe('');
	});
});

describe('truncateForTitle', () => {
	it('恰好 4000 码点 → 原样返回', () => {
		const text = 'a'.repeat(4000);
		expect(truncateForTitle(text)).toBe(text);
	});

	it('不超长 → 原样返回', () => {
		expect(truncateForTitle('你好')).toBe('你好');
	});
});

describe('buildTitleMessages', () => {
	it('finalText 非空 → 3 条 [user, assistant, user]', () => {
		const result = buildTitleMessages('帮我修复登录超时', '已修复', '生成标题指令');
		expect(result.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
	});

	it('finalText 为空 → 2 条降级 [user, user]', () => {
		const result = buildTitleMessages('继续', '', '生成标题指令');
		expect(result.map((m) => m.role)).toEqual(['user', 'user']);
	});
});

describe('RENAME_SYSTEM_PROMPT / RENAME_INSTRUCTION', () => {
	it('SYSTEM_PROMPT < 200 字符', () => {
		expect(RENAME_SYSTEM_PROMPT.length).toBeLessThan(200);
	});

	it('INSTRUCTION 含正反例锚定', () => {
		expect(RENAME_INSTRUCTION).toContain('修复登录超时');
		expect(RENAME_INSTRUCTION).toContain('refactor-config-loader');
		expect(RENAME_INSTRUCTION).toContain('我帮你修复了登录 bug');
	});
});

// ── callRenameLLM ──

describe('callRenameLLM', () => {
	beforeEach(() => {
		vi.mocked(completeSimple).mockReset();
	});

	it('model 不可用（find 返回 undefined）→ 返回 null，不调 completeSimple', async () => {
		const ctx = createCtx(undefined, { find: vi.fn(() => undefined) });
		const result = await callRenameLLM(ctx, BASE_CONFIG, FINAL_MESSAGE);
		expect(result).toBeNull();
		expect(completeSimple).not.toHaveBeenCalled();
	});

	it('user prompt 为空（空串，无任务意图）→ 返回 null，不调 completeSimple', async () => {
		const ctx = createCtx([{ type: 'message', message: { role: 'user', content: '' } }]);
		const result = await callRenameLLM(ctx, BASE_CONFIG, FINAL_MESSAGE);
		expect(result).toBeNull();
		expect(completeSimple).not.toHaveBeenCalled();
	});

	it('user prompt 为空数组 content（无 text block）→ 返回 null，不调 completeSimple', async () => {
		const ctx = createCtx([{ type: 'message', message: { role: 'user', content: [] } }]);
		const result = await callRenameLLM(ctx, BASE_CONFIG, FINAL_MESSAGE);
		expect(result).toBeNull();
		expect(completeSimple).not.toHaveBeenCalled();
	});

	it('completeSimple 返回 stopReason=error → 返回 null（静默跳过）', async () => {
		vi.mocked(completeSimple).mockResolvedValue({
			content: [],
			stopReason: 'error',
		} as never);
		const result = await callRenameLLM(createCtx(), BASE_CONFIG, FINAL_MESSAGE);
		expect(result).toBeNull();
	});

	it('completeSimple 返回 content → cleanTitle 后返回', async () => {
		vi.mocked(completeSimple).mockResolvedValue({
			content: [{ type: 'text', text: '  修复登录bug  ' }],
			stopReason: 'stop',
		} as never);
		const result = await callRenameLLM(createCtx(), BASE_CONFIG, FINAL_MESSAGE);
		expect(result).toBe('修复登录bug');
	});

	it('completeSimple 返回空 content → 返回 null', async () => {
		vi.mocked(completeSimple).mockResolvedValue({
			content: [],
			stopReason: 'stop',
		} as never);
		const result = await callRenameLLM(createCtx(), BASE_CONFIG, FINAL_MESSAGE);
		expect(result).toBeNull();
	});

	it('传给 completeSimple 的 context：systemPrompt/messages 三段/tools 空；options：maxTokens=64/timeoutMs=30000/sessionId', async () => {
		vi.mocked(completeSimple).mockResolvedValue({
			content: [{ type: 'text', text: '标题' }],
			stopReason: 'stop',
		} as never);
		await callRenameLLM(createCtx(), BASE_CONFIG, FINAL_MESSAGE);

		expect(completeSimple).toHaveBeenCalledTimes(1);
		const [model, context, options] = vi.mocked(completeSimple).mock.calls[0];
		expect(model).toBe(STUB_MODEL);
		expect((context as { systemPrompt?: string }).systemPrompt).toBe(RENAME_SYSTEM_PROMPT);
		expect((context as { messages: { role: string }[] }).messages.map((m) => m.role)).toEqual([
			'user',
			'assistant',
			'user',
		]);
		expect((context as { tools?: unknown[] }).tools).toEqual([]);
		expect((options as { maxTokens?: number }).maxTokens).toBe(64);
		expect((options as { timeoutMs?: number }).timeoutMs).toBe(30_000);
		expect((options as { sessionId?: string }).sessionId).toBe('test-session-id');
	});

	it('thinkingLevel=off → 不传 reasoning；thinkingLevel=high → 传 reasoning=high', async () => {
		vi.mocked(completeSimple).mockResolvedValue({
			content: [{ type: 'text', text: '标题' }],
			stopReason: 'stop',
		} as never);
		await callRenameLLM(createCtx(), BASE_CONFIG, FINAL_MESSAGE);
		expect(
			(vi.mocked(completeSimple).mock.calls[0][2] as { reasoning?: unknown }).reasoning,
		).toBeUndefined();

		vi.mocked(completeSimple).mockClear();
		await callRenameLLM(createCtx(), { ...BASE_CONFIG, thinkingLevel: 'high' }, FINAL_MESSAGE);
		expect(
			(vi.mocked(completeSimple).mock.calls[0][2] as { reasoning?: unknown }).reasoning,
		).toBe('high');
	});

	it('maxTitleLength 透传给 cleanTitle（截断生效）', async () => {
		vi.mocked(completeSimple).mockResolvedValue({
			content: [{ type: 'text', text: '一二三四五六七八九十' }],
			stopReason: 'stop',
		} as never);
		const result = await callRenameLLM(
			createCtx(),
			{ ...BASE_CONFIG, maxTitleLength: 5 },
			FINAL_MESSAGE,
		);
		expect(result).toBe('一二三四五');
	});
});
