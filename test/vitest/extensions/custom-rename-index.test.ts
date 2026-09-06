/**
 * custom-rename index — turn_end handler 触发条件测试（mock loadRenameConfig + callRenameLLM）。
 *
 * 触发语义（v2）：
 *   - 会话未命名（getSessionName 空）且成功回复 ≥1 → 首个可触发 turn 即发起
 *     （新会话 = 首轮；/reload 后多轮历史未命名会话 = reload 后第一个成功回复）
 *   - rename 成功后会话有名字 → 后续自动 skip（天然只命名一次）
 *   - 失败重试受节流约束：距上次尝试 < 2 个成功回复不重试
 */
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../extensions/tui/custom-rename/src/pure.js', async (importOriginal) => {
	const mod =
		await importOriginal<typeof import('../../../extensions/tui/custom-rename/src/pure.js')>();
	return { ...mod, loadRenameConfig: vi.fn() };
});
vi.mock('../../../extensions/tui/custom-rename/src/llm.js', async (importOriginal) => {
	const mod =
		await importOriginal<typeof import('../../../extensions/tui/custom-rename/src/llm.js')>();
	return { ...mod, callRenameLLM: vi.fn(), resolveRenameModel: vi.fn() };
});

import {
	callRenameLLM,
	resolveRenameModel,
} from '../../../extensions/tui/custom-rename/src/llm.js';
import renameSessionExtension, {
	__resetRenameInFlightForTest,
} from '../../../extensions/tui/custom-rename/src/index.js';
import {
	loadRenameConfig,
	type RenameSessionConfig,
} from '../../../extensions/tui/custom-rename/src/pure.js';

afterEach(() => {
	// 模块级 renameInFlight / lastAttemptCount 跨测试共享，逐个重置避免污染后续用例
	__resetRenameInFlightForTest();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

const ENABLED_CONFIG: RenameSessionConfig = {
	enabled: true,
	model: { type: 'ref', ref: 'stub/stub-model' },
	maxTitleLength: 50,
	thinkingLevel: 'off',
};
const DISABLED_CONFIG: RenameSessionConfig = {
	enabled: false,
	model: { type: 'ref', ref: '' },
	maxTitleLength: 50,
	thinkingLevel: 'off',
};

// 触发态夹具：stopReason==='stop' 的 assistant 恰 1 条 → 成功计数 1
const ONE_ASSISTANT = [
	{ type: 'message', message: { role: 'user', content: '帮我修复登录超时' } },
	{ type: 'message', message: { role: 'assistant', stopReason: 'stop', content: [] } },
];

/** 造 n 条成功（stop）assistant 回复的 entries（reload 后历史累计场景）。 */
function countStops(n: number): unknown[] {
	return Array.from({ length: n }, () => ({
		type: 'message',
		message: { role: 'assistant', stopReason: 'stop', content: [] },
	}));
}

interface MockSetup {
	pi: ExtensionAPI;
	setSessionNameMock: ReturnType<typeof vi.fn>;
	getSessionNameMock: ReturnType<typeof vi.fn>;
	turnEndHandler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>;
}

function createMockPi(): MockSetup {
	const setSessionNameMock = vi.fn();
	const getSessionNameMock = vi.fn((): string | undefined => undefined);
	let turnEndHandler!: MockSetup['turnEndHandler'];
	const pi = {
		on: vi.fn((event: string, handler: MockSetup['turnEndHandler']) => {
			if (event === 'turn_end') turnEndHandler = handler;
		}),
		registerCommand: vi.fn(),
		getSessionName: getSessionNameMock,
		setSessionName: setSessionNameMock,
	} as unknown as ExtensionAPI;
	return {
		pi,
		setSessionNameMock,
		getSessionNameMock,
		get turnEndHandler() {
			return turnEndHandler;
		},
	};
}

// 通知 spy：每个测试在 beforeEach 重建（见 describe 内 beforeEach）。
let notifyMock: ReturnType<typeof vi.fn>;

function createMockCtx(opts: { entries?: unknown[] } = {}): ExtensionContext {
	return {
		sessionManager: {
			getEntries: () => opts.entries ?? ONE_ASSISTANT,
			getSessionId: () => 'test-session-id',
		},
		signal: new AbortController().signal,
		ui: { notify: notifyMock },
	} as unknown as ExtensionContext;
}

function fire(setup: MockSetup, ctx: ExtensionContext, message?: unknown): Promise<void> {
	return setup.turnEndHandler(
		{
			type: 'turn_end',
			turnIndex: 3,
			message: message ?? {
				stopReason: 'stop',
				content: [{ type: 'text', text: '已完成修复' }],
			},
			toolResults: [],
		},
		ctx,
	) as Promise<void>;
}

describe('renameSessionExtension turn_end handler', () => {
	let setup: MockSetup;

	beforeEach(() => {
		vi.mocked(loadRenameConfig).mockReset();
		vi.mocked(callRenameLLM).mockReset();
		vi.mocked(resolveRenameModel).mockReset();
		// 默认模型可用（truthy），仅「模型不可用」用例改为返回 null
		vi.mocked(resolveRenameModel).mockReturnValue({} as never);
		notifyMock = vi.fn();
		setup = createMockPi();
		renameSessionExtension(setup.pi);
	});

	it('注册后 pi.on 以 turn_end 调用一次，并注册命令', () => {
		expect(setup.pi.on).toHaveBeenCalledWith('turn_end', expect.any(Function));
		expect(setup.pi.registerCommand).toHaveBeenCalled();
	});

	it('config.enabled=false → 不触发 rename', async () => {
		vi.mocked(loadRenameConfig).mockReturnValue(DISABLED_CONFIG);
		await fire(setup, createMockCtx());
		expect(callRenameLLM).not.toHaveBeenCalled();
	});

	it('stopReason 非 stop（toolUse/error/length）→ 不触发', async () => {
		vi.mocked(loadRenameConfig).mockReturnValue(ENABLED_CONFIG);
		for (const stopReason of ['toolUse', 'error', 'aborted', 'length']) {
			await fire(setup, createMockCtx(), { stopReason, content: [] });
		}
		expect(callRenameLLM).not.toHaveBeenCalled();
	});

	it('新会话首轮（count=1，未命名）→ 触发 rename', async () => {
		vi.mocked(loadRenameConfig).mockReturnValue(ENABLED_CONFIG);
		vi.mocked(callRenameLLM).mockResolvedValue('修复登录超时');
		await fire(setup, createMockCtx());
		await vi.waitFor(() => expect(callRenameLLM).toHaveBeenCalledTimes(1));
		await vi.waitFor(() =>
			expect(setup.setSessionNameMock).toHaveBeenCalledWith('修复登录超时'),
		);
	});

	it('多轮历史未命名（reload 场景，成功回复数 ≥2）→ 仍触发 rename', async () => {
		vi.mocked(loadRenameConfig).mockReturnValue(ENABLED_CONFIG);
		vi.mocked(callRenameLLM).mockResolvedValue('修复登录超时');
		// /reload 后 entries 保留：已有 5 条成功回复的未命名会话
		const fiveStops = [
			{ type: 'message', message: { role: 'user', content: '帮我修复登录超时' } },
			...countStops(5),
		];
		await fire(setup, createMockCtx({ entries: fiveStops }));
		await vi.waitFor(() => expect(callRenameLLM).toHaveBeenCalledTimes(1));
	});

	it('会话已命名（getSessionName 非空）→ 不触发（天然只命名一次）', async () => {
		vi.mocked(loadRenameConfig).mockReturnValue(ENABLED_CONFIG);
		setup.getSessionNameMock.mockReturnValue('已有名字');
		await fire(setup, createMockCtx());
		expect(callRenameLLM).not.toHaveBeenCalled();
		expect(setup.setSessionNameMock).not.toHaveBeenCalled();
	});

	it('成功回复数 = 0（无成功历史）→ 不触发', async () => {
		vi.mocked(loadRenameConfig).mockReturnValue(ENABLED_CONFIG);
		const onlyUser = [{ type: 'message', message: { role: 'user', content: 'hi' } }];
		await fire(setup, createMockCtx({ entries: onlyUser }));
		expect(callRenameLLM).not.toHaveBeenCalled();
	});

	it('rename in-flight 期间再次触发 → 不重复调用 LLM；完成后节流放行可再触发', async () => {
		vi.mocked(loadRenameConfig).mockReturnValue(ENABLED_CONFIG);
		let resolveLlm!: (v: string | null) => void;
		vi.mocked(callRenameLLM).mockImplementation(
			() =>
				new Promise<string | null>((res) => {
					resolveLlm = res;
				}),
		);
		// 第一次触发：LLM pending（in-flight，lastAttemptCount=1）
		await fire(setup, createMockCtx());
		await vi.waitFor(() => expect(callRenameLLM).toHaveBeenCalledTimes(1));
		// 第二次触发（LLM 未返回）→ 防重跳过
		await fire(setup, createMockCtx());
		expect(callRenameLLM).toHaveBeenCalledTimes(1);
		// LLM 返回 → 落库 + 释放标志
		resolveLlm('修复登录超时');
		await vi.waitFor(() =>
			expect(setup.setSessionNameMock).toHaveBeenCalledWith('修复登录超时'),
		);
		// 标志释放后再触发：lastAttemptCount=1，需成功回复 ≥3 才过节流（count=3）
		await fire(setup, createMockCtx({ entries: countStops(3) }));
		await vi.waitFor(() => expect(callRenameLLM).toHaveBeenCalledTimes(2));
	});

	it('rename in-flight 期间 LLM 失败（catch）→ 标志释放；重试受节流约束', async () => {
		vi.mocked(loadRenameConfig).mockReturnValue(ENABLED_CONFIG);
		let rejectLlm!: (e: Error) => void;
		vi.mocked(callRenameLLM).mockImplementation(
			() =>
				new Promise<string | null>((_res, rej) => {
					rejectLlm = rej;
				}),
		);
		await fire(setup, createMockCtx());
		await vi.waitFor(() => expect(callRenameLLM).toHaveBeenCalledTimes(1));
		rejectLlm(new Error('boom'));
		// 等 catch 消费 + finally 释放后：count=1 被节流拦截（< lastAttempt+2）
		await new Promise((r) => setTimeout(r, 10));
		await fire(setup, createMockCtx());
		expect(callRenameLLM).toHaveBeenCalledTimes(1);
		// count=3 → 节流放行，重试
		await fire(setup, createMockCtx({ entries: countStops(3) }));
		await vi.waitFor(() => expect(callRenameLLM).toHaveBeenCalledTimes(2));
		expect(setup.setSessionNameMock).not.toHaveBeenCalled();
	});

	it('正常触发 → callRenameLLM 被调，标题落库 setSessionName，notify info 告知用户', async () => {
		vi.mocked(loadRenameConfig).mockReturnValue(ENABLED_CONFIG);
		vi.mocked(callRenameLLM).mockResolvedValue('修复登录超时');
		await fire(setup, createMockCtx());
		await vi.waitFor(() => expect(callRenameLLM).toHaveBeenCalledTimes(1));
		await vi.waitFor(() =>
			expect(setup.setSessionNameMock).toHaveBeenCalledWith('修复登录超时'),
		);
		expect(notifyMock).toHaveBeenCalledWith('会话已重命名为「修复登录超时」', 'info');
	});

	it('模型不可用 → 同一 ref 只 warning 一次；修好模型后下一成功轮自动恢复（无需 reload）', async () => {
		vi.mocked(loadRenameConfig).mockReturnValue(ENABLED_CONFIG);
		vi.mocked(resolveRenameModel).mockReturnValue(null);
		await fire(setup, createMockCtx());
		expect(callRenameLLM).not.toHaveBeenCalled();
		expect(notifyMock).toHaveBeenCalledWith(
			expect.stringContaining('自动重命名未执行'),
			'warning',
		);
		expect(setup.setSessionNameMock).not.toHaveBeenCalled();
		// 同一 ref 仍不可用 → 静默跳过，不重复 warning
		await fire(setup, createMockCtx());
		expect(notifyMock).toHaveBeenCalledTimes(1);
		expect(callRenameLLM).not.toHaveBeenCalled();
		// 用户按提示用 /auto-rename 修好模型（ref 现在可用）→ 下一成功轮即触发，无需 reload
		vi.mocked(resolveRenameModel).mockReturnValue({} as never);
		vi.mocked(callRenameLLM).mockResolvedValue('修复登录超时');
		await fire(setup, createMockCtx());
		await vi.waitFor(() => expect(callRenameLLM).toHaveBeenCalledTimes(1));
		await vi.waitFor(() =>
			expect(setup.setSessionNameMock).toHaveBeenCalledWith('修复登录超时'),
		);
	});

	it('LLM 调用窗口内用户已手动命名 → 落库前重查命中，不覆盖', async () => {
		vi.mocked(loadRenameConfig).mockReturnValue(ENABLED_CONFIG);
		// 会话名可变：触发时未命名 → LLM 调用窗口内用户手动命名
		let sessionName: string | undefined;
		setup.getSessionNameMock.mockImplementation(() => sessionName);
		let resolveLlm!: (v: string | null) => void;
		vi.mocked(callRenameLLM).mockImplementation(
			() =>
				new Promise<string | null>((res) => {
					resolveLlm = res;
				}),
		);
		await fire(setup, createMockCtx()); // 触发时未命名 → LLM pending
		await vi.waitFor(() => expect(callRenameLLM).toHaveBeenCalledTimes(1));
		sessionName = '用户手动名'; // 用户窗口内手动命名
		resolveLlm('修复登录超时');
		await new Promise((r) => setTimeout(r, 10));
		expect(setup.setSessionNameMock).not.toHaveBeenCalled();
	});

	it('callRenameLLM 返回 null（无标题）→ 不落库', async () => {
		vi.mocked(loadRenameConfig).mockReturnValue(ENABLED_CONFIG);
		vi.mocked(callRenameLLM).mockResolvedValue(null);
		await fire(setup, createMockCtx());
		await vi.waitFor(() => expect(callRenameLLM).toHaveBeenCalledTimes(1));
		await new Promise((r) => setTimeout(r, 10));
		expect(setup.setSessionNameMock).not.toHaveBeenCalled();
	});

	it('rename 失败后节流：距上次尝试不足 2 个成功回复不重试，达到后放行', async () => {
		vi.mocked(loadRenameConfig).mockReturnValue(ENABLED_CONFIG);
		vi.mocked(callRenameLLM).mockResolvedValue(null); // 每次尝试都失败（无标题）
		// 首次：count=1（从未尝试）→ 触发失败，lastAttemptCount=1
		await fire(setup, createMockCtx());
		await vi.waitFor(() => expect(callRenameLLM).toHaveBeenCalledTimes(1));
		// count=2（+1）：节流拦截，不重试
		await fire(setup, createMockCtx({ entries: countStops(2) }));
		expect(callRenameLLM).toHaveBeenCalledTimes(1);
		// count=3（+2）：节流放行，重试
		await fire(setup, createMockCtx({ entries: countStops(3) }));
		await vi.waitFor(() => expect(callRenameLLM).toHaveBeenCalledTimes(2));
	});
});
