/**
 * custom-compaction index — 扩展装配测试
 *
 * Covers:
 *   - 注册了 /tree 分支切换（session_tree）事件处理器
 *   - session_tree 触发时用「新分支」的 context usage 刷新状态栏，
 *     避免 widget 停留在切换前的陈旧 percent（修复 5059744b 遗漏场景）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import ext, {
	doCompact,
	evaluateProactiveTrigger,
} from '../../../extensions/context/custom-compaction/index.js';
import {
	createCompactionStore,
	__setStoreForTest,
	setTriggerGranularity,
} from '../../../extensions/context/custom-compaction/config.js';
import type { CompactionProfile } from '../../../extensions/context/custom-compaction/types.js';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

type AnyHandler = (event: unknown, ctx: unknown) => unknown;

let tmpRoot: string;
let userFile: string;

beforeEach(() => {
	tmpRoot = join(tmpdir(), `cc-index-test-${randomBytes(4).toString('hex')}`);
	const userDir = join(tmpRoot, 'home', '.pi', 'agent', 'extensions-data', 'custom-compaction');
	mkdirSync(userDir, { recursive: true });
	userFile = join(userDir, 'config.json');
	__setStoreForTest(
		createCompactionStore({ cwd: join(tmpRoot, 'cwd'), homeDir: join(tmpRoot, 'home') }),
	);
});

afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
});

/** context_percent 型 profile，threshold 50%（approaching 线 40%） */
function writeConfig(): void {
	const profile: CompactionProfile = {
		id: 'default',
		name: 'Default',
		model: 'current',
		trigger: { type: 'context_percent', threshold: 50 },
		mechanism: { type: 'summarize' },
		prompt: '',
		autoContinue: true,
		injectContinueText: false,
		autoContinueMessage: 'continue',
	};
	writeFileSync(
		userFile,
		JSON.stringify({ activeProfileId: 'default', profiles: { default: profile } }, null, 2) +
			'\n',
		'utf-8',
	);
}

/** stub pi：收集 on() 注册的 handler，其余 API 空桩 */
function stubPi(): { handlers: Map<string, AnyHandler[]> } {
	const handlers = new Map<string, AnyHandler[]>();
	const pi = {
		on: (ev: string, h: AnyHandler) => {
			const list = handlers.get(ev) ?? [];
			list.push(h);
			handlers.set(ev, list);
		},
		registerCommand: () => undefined,
		registerTool: () => undefined,
		sendMessage: vi.fn(),
		sendUserMessage: vi.fn(),
	} as unknown as Parameters<typeof ext>[0];
	ext(pi);
	return { handlers };
}

/** 构造事件 ctx：theme.fg 透传，setStatus 记录调用 */
function makeCtx(usage: { tokens: number; percent: number | null } | null) {
	const setStatus = vi.fn();
	return {
		ctx: {
			hasUI: true,
			ui: {
				setStatus,
				theme: { fg: (_key: string, s: string) => s },
			},
			getContextUsage: () => usage,
			model: { provider: 'openai', id: 'gpt-4o', contextWindow: 100_000 },
		},
		setStatus,
	};
}

describe('custom-compaction index 装配', () => {
	beforeEach(() => {
		writeConfig();
	});

	it('注册 /tree 分支切换事件并注册 session_tree handler', () => {
		const { handlers } = stubPi();
		expect(handlers.has('session_tree')).toBe(true);
	});

	it('session_tree 触发后用新分支的 usage 刷新状态栏（不残留切换前百分比）', async () => {
		const { handlers } = stubPi();
		const treeHandler = handlers.get('session_tree')?.[0];
		expect(treeHandler).toBeDefined();

		// 旧分支曾到 90%（agent_end 刷入状态栏）；切换后新分支实际只有 12%
		const { ctx, setStatus } = makeCtx({ tokens: 12_000, percent: 12 });
		await treeHandler!({ type: 'session_tree', oldLeafId: 'a', newLeafId: 'b' }, ctx);

		expect(setStatus).toHaveBeenCalledTimes(1);
		expect(setStatus).toHaveBeenCalledWith('custom-compact', '|compact:default-12%/50%');
	});
});

// ── doCompact 状态刷新（修复：压缩开始/完成/失败三时点刷新状态栏） ──

/** theme.fg 把颜色 key 编码进文本，便于断言状态从「压缩中」脱离 */
function makeCompactCtx(usage: { tokens: number; percent: number | null } | null): {
	ctx: Parameters<typeof doCompact>[1];
	setStatus: ReturnType<typeof vi.fn>;
	compactOpts: { onComplete?: () => void; onError?: (e: Error) => void };
} {
	const setStatus = vi.fn();
	const compactOpts: { onComplete?: () => void; onError?: (e: Error) => void } = {};
	const ctx = {
		hasUI: true,
		ui: {
			setStatus,
			theme: { fg: (key: string, s: string) => `[${key}]${s}` },
			notify: vi.fn(),
		},
		getContextUsage: () => usage,
		model: { provider: 'openai', id: 'gpt-4o', contextWindow: 100_000 },
		// ctx.compact 是 fire-and-forget：仅捕获回调，不自动执行，
		// 由测试手动触发 onComplete/onError（模拟真实异步时序）
		compact: (opts: { onComplete?: () => void; onError?: (e: Error) => void }) => {
			compactOpts.onComplete = opts.onComplete;
			compactOpts.onError = opts.onError;
		},
	} as unknown as Parameters<typeof doCompact>[1];
	return { ctx, setStatus, compactOpts };
}

describe('doCompact 状态刷新（压缩开始/完成/失败）', () => {
	// pi 桩：autoContinue=false 的 profile 不会走到 sendMessage/sendUserMessage
	const piStub = { on: vi.fn(), registerCommand: vi.fn() } as unknown as ExtensionAPI;
	// 决策 profile（threshold 仅影响 describeTrigger；渲染以 store 的 default 为准）
	const profile: CompactionProfile = {
		id: 'default',
		name: 'Default',
		model: 'current',
		trigger: { type: 'context_percent', threshold: 50 },
		mechanism: { type: 'summarize' },
		prompt: '',
		autoContinue: false,
		injectContinueText: false,
		autoContinueMessage: 'continue',
	};

	it('压缩开始刷新为 accent「压缩中」，完成后刷新回普通态', async () => {
		writeConfig();
		const { ctx, setStatus, compactOpts } = makeCompactCtx({ tokens: 12_000, percent: 12 });

		await doCompact(piStub, ctx, profile, 'manual');

		// 开始时点：accent 压缩中
		expect(setStatus).toHaveBeenLastCalledWith(
			'custom-compact',
			'[accent]|compact:default-12%/50%',
		);

		// 完成后：脱离「压缩中」（compactingInProgress=false → 普通态）
		compactOpts.onComplete!();
		expect(setStatus).toHaveBeenLastCalledWith(
			'custom-compact',
			'[text]|compact:default-12%/50%',
		);
	});

	it('压缩失败后同样刷新，不再停留「压缩中」', async () => {
		writeConfig();
		const { ctx, setStatus, compactOpts } = makeCompactCtx({ tokens: 12_000, percent: 12 });

		await doCompact(piStub, ctx, profile, 'manual');
		compactOpts.onError!(new Error('mock compaction failure'));

		expect(setStatus).toHaveBeenLastCalledWith(
			'custom-compact',
			'[text]|compact:default-12%/50%',
		);
	});

	it('压缩完成后 ctx stale（setStatus 抛错）时不向上抛，安全降级', async () => {
		writeConfig();
		const { ctx, setStatus, compactOpts } = makeCompactCtx({ tokens: 12_000, percent: 12 });

		await doCompact(piStub, ctx, profile, 'manual');

		// 会话替换后 ctx 变 stale：压缩开始时 ctx 新鲜（真实场景），
		// 只在 onComplete 阶段 setStatus 抛错 → 应被 try/catch 吞掉
		setStatus.mockImplementation(() => {
			throw new Error('ctx replaced: session switched');
		});
		expect(() => compactOpts.onComplete!()).not.toThrow();
	});
});

// ── Ticket 05: message_end 刷新 widget 分子 ─────────────────────

describe('message_end widget 刷新（Ticket 05）', () => {
	beforeEach(() => {
		writeConfig();
	});

	it('message_end 触发 widget 分子刷新（assistant 消息）', async () => {
		const { handlers } = stubPi();
		const handler = handlers.get('message_end')?.[0];
		expect(handler).toBeDefined();

		const { ctx, setStatus } = makeCtx({ tokens: 45_000, percent: 45 });
		await handler!({ type: 'message_end', message: { role: 'assistant' } }, ctx);

		expect(setStatus).toHaveBeenCalledWith('custom-compact', '|compact:default-45%/50%');
	});

	it('流式 message_update 不注册（避免逐 token 重绘）', () => {
		const { handlers } = stubPi();
		expect(handlers.has('message_update')).toBe(false);
	});
});

// ── evaluateProactiveTrigger 编排（ADR-0036 启用集→触发集→路由→doCompact）──

const evalPiStub = {
	on: vi.fn(),
	registerCommand: vi.fn(),
	sendMessage: vi.fn(),
	sendUserMessage: vi.fn(),
} as unknown as ExtensionAPI;

describe('evaluateProactiveTrigger 编排', () => {
	beforeEach(() => {
		writeConfig(); // default threshold 50，默认 agent_turn 粒度
	});

	it('无 profile 满足触发 → 不调用 compact', async () => {
		const { ctx, compactOpts } = makeCompactCtx({ tokens: 10_000, percent: 10 });
		await evaluateProactiveTrigger(evalPiStub, ctx);
		expect(compactOpts.onComplete).toBeUndefined();
	});

	it('触发 → 调用 doCompact（写入 compact 回调）', async () => {
		const { ctx, compactOpts } = makeCompactCtx({ tokens: 60_000, percent: 60 });
		await evaluateProactiveTrigger(evalPiStub, ctx);
		expect(compactOpts.onComplete).toBeDefined();
		compactOpts.onComplete!(); // 重置 compactingInProgress，避免测试顺序依赖
	});

	it('contextUsage 为 null → 早退', async () => {
		const { ctx, compactOpts } = makeCompactCtx(null);
		await evaluateProactiveTrigger(evalPiStub, ctx);
		expect(compactOpts.onComplete).toBeUndefined();
	});

	it('contextUsage.tokens === null → 早退', async () => {
		const { ctx, compactOpts } = makeCompactCtx({
			tokens: null as unknown as number,
			percent: null,
		});
		await evaluateProactiveTrigger(evalPiStub, ctx);
		expect(compactOpts.onComplete).toBeUndefined();
	});
});

// ── 触发粒度事件接线（ADR-0036：granularity 决定哪个事件触发评估）──

describe('触发粒度事件接线', () => {
	it('agent_turn（默认）：agent_end handler 触发评估', async () => {
		writeConfig();
		const { handlers } = stubPi();
		const agentEnd = handlers.get('agent_end')?.[0];
		expect(agentEnd).toBeDefined();

		const { ctx, compactOpts } = makeCompactCtx({ tokens: 60_000, percent: 60 });
		await agentEnd!({}, ctx);
		expect(compactOpts.onComplete).toBeDefined();
		compactOpts.onComplete!();
	});

	it('user_turn 粒度：message_end 仅 user 角色触发评估', async () => {
		writeConfig();
		setTriggerGranularity('user_turn', 'user');
		const { handlers } = stubPi();
		const messageEnd = handlers.get('message_end')?.[0];
		expect(messageEnd).toBeDefined();

		const { ctx, compactOpts } = makeCompactCtx({ tokens: 60_000, percent: 60 });
		// assistant 消息：仅 widget 刷新，不触发评估
		await messageEnd!({ type: 'message_end', message: { role: 'assistant' } }, ctx);
		expect(compactOpts.onComplete).toBeUndefined();

		// user 消息：触发评估 → compact
		await messageEnd!({ type: 'message_end', message: { role: 'user' } }, ctx);
		expect(compactOpts.onComplete).toBeDefined();
		compactOpts.onComplete!();
	});

	it('tool 粒度：tool_execution_end handler 触发评估', async () => {
		writeConfig();
		setTriggerGranularity('tool', 'user');
		const { handlers } = stubPi();
		const toolEnd = handlers.get('tool_execution_end')?.[0];
		expect(toolEnd).toBeDefined();

		const { ctx, compactOpts } = makeCompactCtx({ tokens: 60_000, percent: 60 });
		await toolEnd!({}, ctx);
		expect(compactOpts.onComplete).toBeDefined();
		compactOpts.onComplete!();
	});

	it('agent_turn 粒度下 message_end 不触发评估（仅 widget 刷新）', async () => {
		writeConfig(); // 默认 agent_turn
		const { handlers } = stubPi();
		const messageEnd = handlers.get('message_end')?.[0];

		const { ctx, compactOpts } = makeCompactCtx({ tokens: 60_000, percent: 60 });
		await messageEnd!({ type: 'message_end', message: { role: 'user' } }, ctx);
		// agent_turn 粒度下 user 消息不触发评估（message_end 里 granularity !== user_turn）
		expect(compactOpts.onComplete).toBeUndefined();
	});
});
