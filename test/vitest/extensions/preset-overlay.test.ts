/**
 * preset overlay 语义测试（ADR-0049 / ADR-0050）
 *
 * 覆盖新状态模型的核心语义（单元层，fake pi 驱动 presetExtension）：
 *   - tools overlay：白名单封闭集 / 未声明不约束 / 遮蔽运行时新注册工具 / 清除即撤回
 *   - skills overlay：[] 全部禁止 / 清除即撤回（不污染基础层）
 *   - 恢复路径：/reload 不复活已清除的 preset（决策 2）
 *
 * 仅 mock @zenone/pi-selector 与 model.ts（与 preset.integration.test.ts 同口径）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

vi.mock('@zenone/pi-selector', () => ({
	showSelect: vi.fn(),
	showConfirm: vi.fn(),
	showConfirmDestructive: vi.fn(),
	isSelecting: () => false,
}));
vi.mock('../../../extensions/meta/preset/model.js', () => ({
	default: vi.fn(),
	registerModelApi: vi.fn(),
	pickModel: vi.fn(),
}));

import presetExtension from '../../../extensions/meta/preset/index.js';
import { formatSkillsForPrompt, type Skill } from '@earendil-works/pi-coding-agent';

const ORIGINAL_HOME = process.env.HOME;
let tmpHome: string;
let tmpCwd: string;

function setupDirs(projectConfig?: Record<string, unknown>): void {
	tmpHome = resolve(tmpdir(), `preset-overlay-${randomUUID()}`);
	tmpCwd = resolve(tmpHome, 'cwd');
	mkdirSync(resolve(tmpCwd, '.pi', 'extensions-data', 'preset'), { recursive: true });
	if (projectConfig) {
		writeFileSync(
			resolve(tmpCwd, '.pi', 'extensions-data', 'preset', 'config.json'),
			JSON.stringify(projectConfig),
			'utf8',
		);
	}
	process.env.HOME = tmpHome;
}

beforeEach(() => {
	process.env.HOME = ORIGINAL_HOME;
});
afterEach(() => {
	process.env.HOME = ORIGINAL_HOME;
	try {
		rmSync(tmpHome, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
	delete (globalThis as Record<string, unknown>).__toolsApi;
	delete (globalThis as Record<string, unknown>).__skillsApi;
});

interface FakePiOpts {
	allTools?: string[];
	activeTools?: string[];
}

function makeFakePi(opts: FakePiOpts = {}) {
	const allTools = opts.allTools ?? ['read', 'bash', 'edit', 'write'];
	const rec = { setActiveToolsCalls: [] as string[][] };
	const handlers: Record<string, Array<(e: unknown, ctx: unknown) => unknown>> = {};
	const commands: Record<string, (args: string, ctx: unknown) => Promise<void>> = {};
	// 活动集随 setActiveTools 变化（模拟 pi runtime，供 overlay 撤回类断言）
	let active = opts.activeTools ?? [...allTools];

	const pi = {
		on: (event: string, handler: (e: unknown, ctx: unknown) => unknown) => {
			(handlers[event] ??= []).push(handler);
		},
		registerCommand: (
			name: string,
			def: { handler: (a: string, c: unknown) => Promise<void> },
		) => {
			commands[name] = def.handler;
		},
		registerFlag: () => {},
		registerShortcut: () => {},
		getFlag: () => undefined,
		getThinkingLevel: () => 'off',
		setThinkingLevel: () => {},
		getActiveTools: () => [...active],
		setActiveTools: (tools: string[]) => {
			rec.setActiveToolsCalls.push(tools);
			active = [...tools];
		},
		getAllTools: () => allTools.map((name) => ({ name })),
		appendEntry: () => {},
		setModel: async () => true,
		sendMessage: () => {},
	};
	return { pi, rec, handlers, commands, allTools };
}

function makeCtx(overrides: { entries?: unknown[]; customResult?: string } = {}) {
	const notifyCalls: Array<{ message: string; type: string }> = [];
	const ctx = {
		cwd: tmpCwd,
		hasUI: true,
		model: { provider: 'mock', id: 'm1' },
		modelRegistry: {
			getAvailable: () => [],
			hasConfiguredAuth: () => true,
			find: (p: string, m: string) => ({ provider: p, id: m }),
		},
		ui: {
			notify: (message: string, type: string) => notifyCalls.push({ message, type }),
			setStatus: () => {},
			theme: { fg: (_c: string, t: string) => t },
			custom: async () => overrides.customResult ?? '(none)',
			input: async () => undefined,
			editor: async () => undefined,
		},
		sessionManager: {
			getSessionId: () => 'sess-overlay',
			getEntries: () => overrides.entries ?? [],
			getBranch: () => [],
		},
		getSystemPromptOptions: () => ({ skills: [] }),
		getSystemPrompt: () => '',
	};
	return { ctx, notifyCalls };
}

async function fire(
	handlers: Record<string, Array<(e: unknown, ctx: unknown) => unknown>>,
	event: string,
	e: unknown,
	ctx: unknown,
): Promise<void> {
	for (const h of handlers[event] ?? []) await h(e, ctx);
}

/** 与 fire 相同，但收集各 handler 的返回值（用于断言 systemPrompt 等可观测结果）。 */
async function fireOne(
	handlers: Record<string, Array<(e: unknown, ctx: unknown) => unknown>>,
	event: string,
	e: unknown,
	ctx: unknown,
): Promise<unknown[]> {
	const out: unknown[] = [];
	for (const h of handlers[event] ?? []) out.push(await h(e, ctx));
	return out;
}

// ──────────────────────────────────────────────────────────────────────────────

describe('preset overlay — tools（ADR-0049 决策 3/5）', () => {
	it('激活工具白名单 → 有效集 = 白名单（封闭集）', async () => {
		setupDirs({ plan: { tools: ['read', 'bash'] } });
		const { pi, handlers, commands } = makeFakePi();
		presetExtension(pi as never);
		const { ctx } = makeCtx();
		await fire(handlers, 'session_start', null, ctx);

		await commands['preset']('plan', ctx);

		const api = (globalThis as { __toolsApi?: { getEffective: () => string[] } }).__toolsApi;
		expect(api?.getEffective()).toEqual(['read', 'bash']);
	});

	it('preset 未声明 tools → 不约束（有效集 = 基础层全量）', async () => {
		setupDirs({ plan: { thinkingLevel: 'high' } });
		const { pi, handlers, commands } = makeFakePi();
		presetExtension(pi as never);
		const { ctx } = makeCtx();
		await fire(handlers, 'session_start', null, ctx);

		await commands['preset']('plan', ctx);

		const api = (globalThis as { __toolsApi?: { getEffective: () => string[] } }).__toolsApi;
		expect(api?.getEffective()).toEqual(['read', 'bash', 'edit', 'write']);
	});

	it('封闭集遮蔽运行时新注册的工具（before_agent_start 重算）', async () => {
		setupDirs({ plan: { tools: ['read'] } });
		const { pi, handlers, commands, allTools } = makeFakePi();
		presetExtension(pi as never);
		const { ctx } = makeCtx();
		await fire(handlers, 'session_start', null, ctx);
		await commands['preset']('plan', ctx);

		// 运行时新注册一个工具（注册方行为）
		allTools.push('mock_tool');
		await fire(
			handlers,
			'before_agent_start',
			{ systemPrompt: '', systemPromptOptions: { skills: [], cwd: tmpCwd } },
			ctx,
		);

		const api = (globalThis as { __toolsApi?: { getEffective: () => string[] } }).__toolsApi;
		expect(api?.getEffective()).toEqual(['read']);
		expect(api?.getEffective()).not.toContain('mock_tool');
	});

	it('session_tree 不得把 overlay 排除的工具写进基础层（清除后仍全量）', async () => {
		setupDirs({ plan: { tools: ['read'] } });
		const { pi, handlers, commands, allTools } = makeFakePi();
		presetExtension(pi as never);
		const { ctx } = makeCtx();
		await fire(handlers, 'session_start', null, ctx);
		await commands['preset']('plan', ctx);
		const api = (globalThis as { __toolsApi?: { getEffective: () => string[] } }).__toolsApi;
		expect(api?.getEffective()).toEqual(['read']);

		// /tree 导航触发 session_tree（session 内无 tools-config entry）
		await fire(handlers, 'session_tree', null, ctx);
		expect(api?.getEffective()).toEqual(['read']);

		// 清除预设 → 基础层原样保留（不残留 overlay 排除集）
		const { ctx: clearCtx } = makeCtx({ customResult: '(none)' });
		await commands['preset']('', clearCtx);
		expect(api?.getEffective()).toEqual(allTools);
	});

	it('overlay 激活时 tool_call 被拒（白名单外工具不可执行）', async () => {
		setupDirs({ plan: { tools: ['read'] } });
		const { pi, handlers, commands } = makeFakePi();
		presetExtension(pi as never);
		const { ctx } = makeCtx();
		await fire(handlers, 'session_start', null, ctx);
		await commands['preset']('plan', ctx);

		// 白名单内 → 放行；白名单外 → block（ADR-0050 契约2）
		const allowed = await fireOne(handlers, 'tool_call', { toolName: 'read' }, ctx);
		expect(allowed.some((r) => (r as { block?: boolean })?.block)).toBe(false);

		const blocked = await fireOne(handlers, 'tool_call', { toolName: 'bash' }, ctx);
		expect(blocked).toContainEqual(
			expect.objectContaining({
				block: true,
				reason: expect.stringContaining('preset'),
			}),
		);
	});

	it('清除 preset → 撤回 overlay，回到基础层', async () => {
		setupDirs({ plan: { tools: ['read'] } });
		const { pi, handlers, commands } = makeFakePi();
		presetExtension(pi as never);
		const { ctx } = makeCtx();
		await fire(handlers, 'session_start', null, ctx);
		await commands['preset']('plan', ctx);

		// 打开面板 → 选中 (none) → 清除
		const { ctx: clearCtx } = makeCtx({ customResult: '(none)' });
		await commands['preset']('', clearCtx);

		const api = (globalThis as { __toolsApi?: { getEffective: () => string[] } }).__toolsApi;
		expect(api?.getEffective()).toEqual(['read', 'bash', 'edit', 'write']);
	});
});

describe('preset overlay — skills（ADR-0049 决策 5）', () => {
	const SKILLS: Skill[] = [
		{
			name: 'a',
			description: 'skill a',
			filePath: '/tmp/skills/a/SKILL.md',
			baseDir: '/tmp/skills/a',
			sourceInfo: {
				path: '/tmp/skills/a/SKILL.md',
				source: 'test',
				scope: 'user',
				origin: 'top-level',
			},
			disableModelInvocation: false,
		},
		{
			name: 'b',
			description: 'skill b',
			filePath: '/tmp/skills/b/SKILL.md',
			baseDir: '/tmp/skills/b',
			sourceInfo: {
				path: '/tmp/skills/b/SKILL.md',
				source: 'test',
				scope: 'user',
				origin: 'top-level',
			},
			disableModelInvocation: false,
		},
	];
	const FULL_XML = formatSkillsForPrompt(SKILLS);

	/** 从 before_agent_start 返回值中取出被改写的 systemPrompt（无改写则返回原值）。 */
	function patchedPrompt(results: unknown[], fallback: string): string {
		const hit = results.find(
			(r): r is { systemPrompt: string } =>
				typeof r === 'object' && r !== null && 'systemPrompt' in r,
		);
		return hit?.systemPrompt ?? fallback;
	}

	it('skills: [] → 全部禁止（system prompt 移除技能块 + /skill: 被拦截）；清除后回到基础层', async () => {
		setupDirs({ plan: { skills: [] } });
		const { pi, handlers, commands } = makeFakePi();
		presetExtension(pi as never);
		const { ctx } = makeCtx();
		await fire(handlers, 'session_start', null, ctx);
		await commands['preset']('plan', ctx);

		// 通过 before_agent_start 加载技能清单，触发 pending overlay 应用
		const systemPrompt = `base\n${FULL_XML}`;
		const results = await fireOne(
			handlers,
			'before_agent_start',
			{ systemPrompt, systemPromptOptions: { skills: SKILLS } },
			ctx,
		);

		const api = (globalThis as { __skillsApi?: { getEnabledSkills: () => string[] } })
			.__skillsApi;
		expect(api?.getEnabledSkills()).toEqual([]);

		// 用户可感知结果：system prompt 中不再出现技能块。
		// （此前用例只断言内部 getEnabledSkills，overlay 未接到 prompt 过滤的缺陷因此漏网）
		const patched = patchedPrompt(results, systemPrompt);
		expect(patched).not.toContain('<available_skills>');
		expect(patched).not.toContain('skill a');

		// /skill:a 手动调用被拦截
		expect(await fireOne(handlers, 'input', { text: '/skill:a' }, ctx)).toContainEqual({
			action: 'handled',
		});

		// 清除预设 → 撤回 overlay
		const { ctx: clearCtx } = makeCtx({ customResult: '(none)' });
		await commands['preset']('', clearCtx);
		expect(api?.getEnabledSkills()).toEqual(['a', 'b']);
	});

	it('skills: [a] → system prompt 仅保留白名单技能', async () => {
		setupDirs({ plan: { skills: ['a'] } });
		const { pi, handlers, commands } = makeFakePi();
		presetExtension(pi as never);
		const { ctx } = makeCtx();
		await fire(handlers, 'session_start', null, ctx);
		await commands['preset']('plan', ctx);

		const systemPrompt = `base\n${FULL_XML}`;
		const results = await fireOne(
			handlers,
			'before_agent_start',
			{ systemPrompt, systemPromptOptions: { skills: SKILLS } },
			ctx,
		);

		const api = (globalThis as { __skillsApi?: { getEnabledSkills: () => string[] } })
			.__skillsApi;
		expect(api?.getEnabledSkills()).toEqual(['a']);

		const patched = patchedPrompt(results, systemPrompt);
		expect(patched).toContain('<name>a</name>');
		expect(patched).not.toContain('<name>b</name>');

		// /skill:b 被拦截，/skill:a 放行
		expect(await fireOne(handlers, 'input', { text: '/skill:b' }, ctx)).toContainEqual({
			action: 'handled',
		});
		expect(await fireOne(handlers, 'input', { text: '/skill:a' }, ctx)).not.toContainEqual({
			action: 'handled',
		});
	});
});

describe('preset 恢复路径（ADR-0049 决策 2）', () => {
	it('/reload 不复活已清除的 preset（socket 层 activeName=null 优先于旧 entry）', async () => {
		setupDirs({ plan: { tools: ['read'], instructions: 'plan-x' } });

		// 第一个实例：激活 → 清除
		const first = makeFakePi();
		presetExtension(first.pi as never);
		const { ctx: ctx1 } = makeCtx();
		await fire(first.handlers, 'session_start', null, ctx1);
		await first.commands['preset']('plan', ctx1);
		const { ctx: clearCtx } = makeCtx({ customResult: '(none)' });
		await first.commands['preset']('', clearCtx);

		// 模拟 /reload：session 里残留一条旧的 preset-state entry
		const entries = [{ type: 'custom', customType: 'preset-state', data: { name: 'plan' } }];
		const second = makeFakePi();
		presetExtension(second.pi as never);
		const { ctx: ctx2 } = makeCtx({ entries });
		await fire(second.handlers, 'session_start', null, ctx2);

		// 未复活：无 activePreset → instructions 为 null
		const presetApi = (
			globalThis as { __presetApi?: { getInstructions?: () => string | null } }
		).__presetApi;
		expect(presetApi?.getInstructions?.()).toBeNull();
	});

	it('/reload 恢复仍激活的 preset（socket 层 activeName 生效）', async () => {
		setupDirs({ plan: { tools: ['read'], instructions: 'plan-x' } });

		const first = makeFakePi();
		presetExtension(first.pi as never);
		const { ctx: ctx1 } = makeCtx();
		await fire(first.handlers, 'session_start', null, ctx1);
		await first.commands['preset']('plan', ctx1);

		const second = makeFakePi();
		presetExtension(second.pi as never);
		const { ctx: ctx2 } = makeCtx();
		await fire(second.handlers, 'session_start', null, ctx2);

		const presetApi = (
			globalThis as { __presetApi?: { getInstructions?: () => string | null } }
		).__presetApi;
		expect(presetApi?.getInstructions?.()).toBe('plan-x');
		const api = (globalThis as { __toolsApi?: { getEffective: () => string[] } }).__toolsApi;
		expect(api?.getEffective()).toEqual(['read']);
	});
});
