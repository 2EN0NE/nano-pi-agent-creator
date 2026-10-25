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
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { showSelect } from '@zenone/pi-selector';
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
import { resolveDeclaredDefaultTools } from '../../../extensions/meta/preset/tools.js';
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
	/** pi 的 `defaultTools` 设置（undefined = 未配置）。 */
	defaultTools?: string[];
	/** 工具来源：'builtin' 的工具默认只在内置默认四件里启用。 */
	builtinTools?: string[];
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
		getSettings: () => ({ defaultTools: opts.defaultTools }),
		getAllTools: () =>
			allTools.map((name) => ({
				name,
				sourceInfo: {
					source: (opts.builtinTools ?? ['read', 'bash', 'edit', 'write']).includes(name)
						? 'builtin'
						: 'extension',
				},
			})),
		appendEntry: () => {},
		setModel: async () => true,
		sendMessage: () => {},
	};
	return { pi, rec, handlers, commands, allTools };
}

function makeCtx(
	overrides: { entries?: unknown[]; customResult?: string; mode?: 'tui' | 'print' } = {},
) {
	const notifyCalls: Array<{ message: string; type: string }> = [];
	const ctx = {
		cwd: tmpCwd,
		...{ mode: overrides.mode },
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

describe('默认工具选择与复位（ADR-0065）', () => {
	it('defaultTools 未配置 → 内置默认四件 ∪ 非内置工具', async () => {
		setupDirs({ plan: { tools: ['read'] } });
		const { pi, handlers, commands } = makeFakePi({
			allTools: ['read', 'bash', 'edit', 'write', 'ffgrep', 'todos'],
			activeTools: ['read'],
		});
		presetExtension(pi as never);
		const { ctx } = makeCtx();
		await fire(handlers, 'session_start', null, ctx);
		await commands['preset']('plan', ctx);

		const { ctx: clearCtx } = makeCtx({ customResult: '(none)' });
		await commands['preset']('', clearCtx);

		const api = (globalThis as { __toolsApi?: { getEffective: () => string[] } }).__toolsApi;
		expect(api?.getEffective()).toEqual(['read', 'bash', 'edit', 'write', 'ffgrep', 'todos']);
	});

	it('defaultTools 解析：纯名单替换默认集，+/- 修饰依次增删', () => {
		expect(resolveDeclaredDefaultTools(['read', 'bash'])).toEqual(['read', 'bash']);
		expect(resolveDeclaredDefaultTools(['-bash', '+ffgrep'])).toEqual([
			'read',
			'edit',
			'write',
			'ffgrep',
		]);
		// 与 pi 语义一致：显式空名单 = 一个内置工具都不启用
		expect(resolveDeclaredDefaultTools([])).toEqual([]);
	});

	it('defaultTools 配置后，清除 preset 只启用该选择（不复活其它内置工具）', async () => {
		setupDirs({ plan: { tools: ['read'] } });
		const { pi, handlers, commands } = makeFakePi({
			allTools: ['read', 'bash', 'edit', 'write', 'ffgrep'],
			activeTools: ['read'],
			defaultTools: ['-bash', '+ffgrep'],
		});
		presetExtension(pi as never);
		const { ctx } = makeCtx();
		await fire(handlers, 'session_start', null, ctx);
		await commands['preset']('plan', ctx);

		const { ctx: clearCtx } = makeCtx({ customResult: '(none)' });
		await commands['preset']('', clearCtx);

		const api = (globalThis as { __toolsApi?: { getEffective: () => string[] } }).__toolsApi;
		// 内置：read/edit/write（-bash）+ 非内置 ffgrep
		expect(api?.getEffective()).toEqual(['read', 'edit', 'write', 'ffgrep']);
	});

	it('会话恢复：preset-state 已清除 → 复位到默认工具选择', async () => {
		setupDirs();
		const { pi, rec, handlers } = makeFakePi({
			allTools: ['read', 'bash', 'edit', 'write', 'ffgrep'],
			activeTools: ['read'], // pi 从会话记录恢复出的受限集
		});
		presetExtension(pi as never);
		const { ctx } = makeCtx({
			entries: [{ type: 'custom', customType: 'preset-state', data: { name: null } }],
		});
		await fire(handlers, 'session_start', null, ctx);

		expect(rec.setActiveToolsCalls.at(-1)).toEqual(['read', 'bash', 'edit', 'write', 'ffgrep']);
	});

	it('会话恢复：从未涉及 preset → 不干预 pi 的工具状态', async () => {
		setupDirs();
		const { pi, rec, handlers } = makeFakePi({
			allTools: ['read', 'bash', 'edit', 'write'],
			activeTools: ['read'],
		});
		presetExtension(pi as never);
		const { ctx } = makeCtx({ entries: [] });
		await fire(handlers, 'session_start', null, ctx);

		expect(rec.setActiveToolsCalls).toEqual([]);
	});
	it('门禁：tools.ts 不得从 getActiveTools() 反推禁用集（ADR-0065）', () => {
		const source = readFileSync(
			resolve(process.cwd(), 'extensions/meta/preset/tools.ts'),
			'utf8',
		);
		expect(source).not.toMatch(/new Set\([^)]*getActiveTools\(\)/s);
		expect(source).not.toContain('disabledTools');
	});
});

describe('陈旧引用交互式修复（ADR-0065）', () => {
	beforeEach(() => {
		vi.mocked(showSelect).mockReset();
	});

	it('无陈旧项 → 不弹面板，直接激活', async () => {
		setupDirs({ plan: { tools: ['read'] } });
		const { pi, handlers, commands } = makeFakePi({ allTools: ['read', 'bash'] });
		presetExtension(pi as never);
		const { ctx } = makeCtx({ mode: 'tui' });
		await fire(handlers, 'session_start', null, ctx);
		await commands['preset']('plan', ctx);

		expect(showSelect).not.toHaveBeenCalled();
	});

	it('有陈旧工具 → 面板默认动作是「修改并保存」，写回新值并激活', async () => {
		setupDirs({ plan: { tools: ['read', 'nope'] } });
		const { pi, handlers, commands } = makeFakePi({ allTools: ['read', 'bash'] });
		presetExtension(pi as never);
		const { ctx } = makeCtx({ mode: 'tui' });
		await fire(handlers, 'session_start', null, ctx);

		vi.mocked(showSelect)
			.mockResolvedValueOnce({ value: 'fix', label: '修改并保存' })
			.mockResolvedValueOnce({ value: 'bash', label: 'bash' });
		await commands['preset']('plan', ctx);

		const firstCall = vi.mocked(showSelect).mock.calls[0];
		expect(String(firstCall[2]?.[0]?.value)).toBe('fix');
		const saved = JSON.parse(
			readFileSync(
				resolve(tmpCwd, '.pi', 'extensions-data', 'preset', 'config.json'),
				'utf8',
			),
		);
		expect(saved.plan.tools).toEqual(['read', 'bash']);
		const api = (globalThis as { __toolsApi?: { getEffective: () => string[] } }).__toolsApi;
		expect(api?.getEffective()).toEqual(['read', 'bash']);
	});

	it('有陈旧工具 → 选「移除」写回并激活', async () => {
		setupDirs({ plan: { tools: ['read', 'nope'] } });
		const { pi, handlers, commands } = makeFakePi({ allTools: ['read', 'bash'] });
		presetExtension(pi as never);
		const { ctx } = makeCtx({ mode: 'tui' });
		await fire(handlers, 'session_start', null, ctx);

		vi.mocked(showSelect).mockResolvedValueOnce({ value: 'remove', label: '移除' });
		await commands['preset']('plan', ctx);

		const saved = JSON.parse(
			readFileSync(
				resolve(tmpCwd, '.pi', 'extensions-data', 'preset', 'config.json'),
				'utf8',
			),
		);
		expect(saved.plan.tools).toEqual(['read']);
	});

	it('修改途中取消 → 磁盘与内存都不被改（同一问题项可再次修复）', async () => {
		setupDirs({ plan: { tools: ['read', 'nope'] } });
		const { pi, handlers, commands } = makeFakePi({ allTools: ['read', 'bash'] });
		presetExtension(pi as never);
		const { ctx } = makeCtx({ mode: 'tui' });
		await fire(handlers, 'session_start', null, ctx);

		// 选「修改并保存」，但在候选这一步 Esc
		vi.mocked(showSelect)
			.mockResolvedValueOnce({ value: 'fix', label: '修改并保存' })
			.mockResolvedValueOnce(null);
		await commands['preset']('plan', ctx);

		const saved = JSON.parse(
			readFileSync(
				resolve(tmpCwd, '.pi', 'extensions-data', 'preset', 'config.json'),
				'utf8',
			),
		);
		expect(saved.plan.tools).toEqual(['read', 'nope']);

		// 内存未被污染：再次切同一 preset 仍能看到同一个问题项
		vi.mocked(showSelect).mockReset();
		vi.mocked(showSelect).mockResolvedValueOnce({ value: 'cancel', label: '取消' });
		await commands['preset']('plan', ctx);
		const detail = String(vi.mocked(showSelect).mock.calls[0]?.[3]?.detail);
		expect(detail).toContain('nope');
	});

	it('面板契约：动作顺序 修改→移除→取消，候选标题显示当前值', async () => {
		setupDirs({ plan: { tools: ['read', 'nope'] } });
		const { pi, handlers, commands } = makeFakePi({ allTools: ['read', 'bash'] });
		presetExtension(pi as never);
		const { ctx } = makeCtx({ mode: 'tui' });
		await fire(handlers, 'session_start', null, ctx);

		vi.mocked(showSelect).mockResolvedValueOnce({ value: 'cancel', label: '取消' });
		await commands['preset']('plan', ctx);
		const first = vi.mocked(showSelect).mock.calls[0];
		expect((first[2] ?? []).map((o) => o.value)).toEqual(['fix', 'remove', 'cancel']);
		expect(String(first[1])).toContain('1 项');
		expect(String(first[3]?.detail)).toContain('nope');

		vi.mocked(showSelect).mockReset();
		vi.mocked(showSelect)
			.mockResolvedValueOnce({ value: 'fix', label: '修改并保存' })
			.mockResolvedValueOnce({ value: 'bash', label: 'bash' });
		await commands['preset']('plan', ctx);
		expect(String(vi.mocked(showSelect).mock.calls[1]?.[1])).toContain('nope（当前值）');
	});
	it('取消 → 不激活、不改配置', async () => {
		setupDirs({ plan: { tools: ['read', 'nope'] } });
		const { pi, handlers, commands } = makeFakePi({ allTools: ['read', 'bash'] });
		presetExtension(pi as never);
		const { ctx } = makeCtx({ mode: 'tui' });
		await fire(handlers, 'session_start', null, ctx);

		vi.mocked(showSelect).mockResolvedValueOnce({ value: 'cancel', label: '取消' });
		await commands['preset']('plan', ctx);

		const saved = JSON.parse(
			readFileSync(
				resolve(tmpCwd, '.pi', 'extensions-data', 'preset', 'config.json'),
				'utf8',
			),
		);
		expect(saved.plan.tools).toEqual(['read', 'nope']);
		const api = (globalThis as { __toolsApi?: { getEffective: () => string[] } }).__toolsApi;
		expect(api?.getEffective()).not.toEqual(['read']);
	});

	it('--preset 启动时取消修复 → 不激活 preset，工具回到默认工具选择', async () => {
		setupDirs({ plan: { tools: ['read', 'nope'] } });
		const { pi, rec, handlers } = makeFakePi({
			allTools: ['read', 'bash', 'edit', 'write'],
			activeTools: ['read'], // pi 从会话记录恢复出的旧限制
		});
		(pi as unknown as { getFlag: (n: string) => unknown }).getFlag = (n: string) =>
			n === 'preset' ? 'plan' : undefined;
		presetExtension(pi as never);
		const { ctx } = makeCtx({ mode: 'tui' });

		vi.mocked(showSelect).mockResolvedValueOnce({ value: 'cancel', label: '取消' });
		await fire(handlers, 'session_start', null, ctx);

		// 取消 = 无 preset：工具轴必须复位，不得留着 transcript 恢复出的旧限制
		expect(rec.setActiveToolsCalls.at(-1)).toEqual(['read', 'bash', 'edit', 'write']);
	});

	it('技能清单未收集（isLoaded=false）→ 不把 preset 的技能判成陈旧、不弹面板', async () => {
		setupDirs({ plan: { skills: ['real-skill'] } });
		const { pi, handlers, commands } = makeFakePi();
		presetExtension(pi as never);
		const { ctx } = makeCtx({ mode: 'tui' });
		await fire(handlers, 'session_start', null, ctx);

		// skills 扩展此时尚未在 before_agent_start 里收集技能名（真实运行时的会话起始状态）
		const api = (globalThis as { __skillsApi?: { isLoaded: () => boolean } }).__skillsApi;
		expect(api?.isLoaded()).toBe(false);

		await commands['preset']('plan', ctx);
		expect(showSelect).not.toHaveBeenCalled();
	});

	it('技能清单已收集 → 缺失的技能照常判陈旧', async () => {
		setupDirs({ plan: { skills: ['real-skill'] } });
		const { pi, handlers, commands } = makeFakePi();
		presetExtension(pi as never);
		// 模拟 before_agent_start 收集完成后的状态
		(globalThis as Record<string, unknown>).__skillsApi = {
			isLoaded: () => true,
			getSkillNames: () => ['other-skill'],
		};
		const { ctx } = makeCtx({ mode: 'tui' });
		await fire(handlers, 'session_start', null, ctx);
		await commands['preset']('plan', ctx);

		const first = vi.mocked(showSelect).mock.calls[0];
		expect(String(first?.[3]?.detail)).toContain('real-skill');
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
	/**
	 * 按 pi 的渲染形态拼出「已渲染的提示词」：`<skills>` section 包住
	 * `formatSkillsForPrompt` 的输出（pi 的 buildSystemPromptSections 就是这么包的）。
	 */
	function renderPrompt(skills: Skill[]): string {
		const block = formatSkillsForPrompt(skills).trim();
		return block ? `base\n<skills>\n${block}\n</skills>` : 'base';
	}

	/**
	 * 触发 before_agent_start 并返回扩展裁剪后的可见技能名。
	 *
	 * pi 的契约（1.3.0 起，与 1.4.0 实现一致）：扩展就地裁剪 `event.systemPromptOptions.skills`，
	 * pi 用同一 options 懒渲染 system prompt —— 不需要、也不应该返回
	 * `{ systemPrompt }`（那会走 forceSystemPrompt 钉死整段提示词，ADR-0066）。
	 */
	async function visibleSkillsAfter(
		handlers: Record<string, Array<(e: unknown, c: unknown) => unknown>>,
		ctx: unknown,
	): Promise<{ names: string[]; results: unknown[] }> {
		const options: { skills: unknown[]; cwd: string } = { skills: [...SKILLS], cwd: tmpCwd };
		const results = await fireOne(
			handlers,
			'before_agent_start',
			{ systemPrompt: 'base', systemPromptOptions: options },
			ctx,
		);
		const names = ((options.skills ?? []) as Array<{ name: string }>).map((s) => s.name);
		return { names, results };
	}

	it('skills: [] → 全部禁止（system prompt 移除技能块 + /skill: 被拦截）；清除后回到基础层', async () => {
		setupDirs({ plan: { skills: [] } });
		const { pi, handlers, commands } = makeFakePi();
		presetExtension(pi as never);
		const { ctx } = makeCtx();
		await fire(handlers, 'session_start', null, ctx);
		await commands['preset']('plan', ctx);

		// 通过 before_agent_start 加载技能清单，触发 pending overlay 应用
		const { names, results } = await visibleSkillsAfter(handlers, ctx);

		const api = (globalThis as { __skillsApi?: { getEnabledSkills: () => string[] } })
			.__skillsApi;
		expect(api?.getEnabledSkills()).toEqual([]);

		// 用户可感知结果：pi 实际渲染用的 options.skills 为空（不再有技能块）
		expect(names).toEqual([]);
		// 且没有走 force 路径（否则整段提示词被钉死，失去 section diff）
		expect(
			results.some((r) => typeof r === 'object' && r !== null && 'systemPrompt' in r),
		).toBe(false);

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

		const { names } = await visibleSkillsAfter(handlers, ctx);

		const api = (globalThis as { __skillsApi?: { getEnabledSkills: () => string[] } })
			.__skillsApi;
		expect(api?.getEnabledSkills()).toEqual(['a']);

		// pi 渲染用的 options.skills 只剩白名单（无需字符串手术）
		expect(names).toEqual(['a']);

		// /skill:b 被拦截，/skill:a 放行
		expect(await fireOne(handlers, 'input', { text: '/skill:b' }, ctx)).toContainEqual({
			action: 'handled',
		});
		expect(await fireOne(handlers, 'input', { text: '/skill:a' }, ctx)).not.toContainEqual({
			action: 'handled',
		});
	});

	it('skills: [a] + 更早的 handler 已 force 整段提示词 → 白名单仍生效', async () => {
		setupDirs({ plan: { skills: ['a'] } });
		const { pi, handlers, commands } = makeFakePi();
		presetExtension(pi as never);
		const { ctx } = makeCtx();
		await fire(handlers, 'session_start', null, ctx);
		await commands['preset']('plan', ctx);

		// 模拟 goal.ts 一类扩展：先按未过滤的 options 渲染，然后 `return { systemPrompt }`，
		// pi 会把它记进 forceSystemPrompt，并在发请求前整段覆盖 sections。
		// 末尾的 FORCED-SUFFIX 代表该扩展自己追加的内容——裁剪不得把它丢掉。
		const SUFFIX = '\n\nFORCED-SUFFIX-from-earlier-handler';
		const options: { skills: unknown[]; cwd: string; forceSystemPrompt?: string } = {
			skills: [...SKILLS],
			cwd: tmpCwd,
			forceSystemPrompt: renderPrompt(SKILLS) + SUFFIX,
		};
		const event = {
			systemPromptOptions: options,
			get systemPrompt() {
				return options.forceSystemPrompt ?? 'base';
			},
		};
		const results = await fireOne(handlers, 'before_agent_start', event, ctx);

		expect(((options.skills ?? []) as Array<{ name: string }>).map((s) => s.name)).toEqual([
			'a',
		]);
		// force 文本被就地裁剪，而不是再返回一个 systemPrompt 去覆盖别人的追加内容
		expect(options.forceSystemPrompt).toContain('<name>a</name>');
		expect(options.forceSystemPrompt).not.toContain('<name>b</name>');
		// 该扩展自己追加的尾巴必须保留（只删技能条目，不动别的内容）
		expect(options.forceSystemPrompt).toContain('FORCED-SUFFIX-from-earlier-handler');
		expect(
			results.some((r) => typeof r === 'object' && r !== null && 'systemPrompt' in r),
		).toBe(false);
	});

	it('基座不回渲染 options（systemPrompt 为静态快照）→ 返回裁剪后的提示词', async () => {
		setupDirs({ plan: { skills: ['a'] } });
		const { pi, handlers, commands } = makeFakePi();
		presetExtension(pi as never);
		const { ctx } = makeCtx();
		await fire(handlers, 'session_start', null, ctx);
		await commands['preset']('plan', ctx);

		// 旧基座的 systemPrompt 是先渲染好的字符串（改 options 不生效）→ 只能改文本
		const results = await fireOne(
			handlers,
			'before_agent_start',
			{
				systemPrompt: renderPrompt(SKILLS),
				systemPromptOptions: { skills: [...SKILLS], cwd: tmpCwd },
			},
			ctx,
		);
		const patched = results.find(
			(r): r is { systemPrompt: string } =>
				typeof r === 'object' && r !== null && 'systemPrompt' in r,
		);
		expect(patched?.systemPrompt).toContain('<name>a</name>');
		expect(patched?.systemPrompt).not.toContain('<name>b</name>');
	});

	it('force 文本含 $ 替换模式（$$ / $&）时逐字保留，不被 String.replace 展开', async () => {
		setupDirs({ plan: { skills: ['a'] } });
		const { pi, handlers, commands } = makeFakePi();
		presetExtension(pi as never);
		const { ctx } = makeCtx();
		await fire(handlers, 'session_start', null, ctx);
		await commands['preset']('plan', ctx);

		// 真实场景：AGENTS.md / 自定义 prompt 里出现 shell 片段。字符串形式的
		// String.replace 会把 `$$` 压成 `$`、把 `$&` 展开成被替换的 section。
		const SHELL_SUFFIX = '\n\nrun: echo $$ pid; assert $& ok';
		const options: { skills: unknown[]; cwd: string; forceSystemPrompt?: string } = {
			skills: [...SKILLS],
			cwd: tmpCwd,
			forceSystemPrompt: renderPrompt(SKILLS) + SHELL_SUFFIX,
		};
		await fireOne(
			handlers,
			'before_agent_start',
			{
				systemPromptOptions: options,
				get systemPrompt() {
					return options.forceSystemPrompt ?? 'base';
				},
			},
			ctx,
		);

		expect(options.forceSystemPrompt).toContain(SHELL_SUFFIX);
		expect(options.forceSystemPrompt).not.toContain('<name>b</name>');
	});

	it('force 文本里有两份技能块时，两份都被裁剪（不只第一份）', async () => {
		setupDirs({ plan: { skills: ['a'] } });
		const { pi, handlers, commands } = makeFakePi();
		presetExtension(pi as never);
		const { ctx } = makeCtx();
		await fire(handlers, 'session_start', null, ctx);
		await commands['preset']('plan', ctx);

		const options: { skills: unknown[]; cwd: string; forceSystemPrompt?: string } = {
			skills: [...SKILLS],
			cwd: tmpCwd,
			// 第二份只含被禁技能 b：只裁第一份时它会漏网
			forceSystemPrompt: `${renderPrompt(SKILLS)}\n\n${renderPrompt([SKILLS[1]])}`,
		};
		await fireOne(
			handlers,
			'before_agent_start',
			{
				systemPromptOptions: options,
				get systemPrompt() {
					return options.forceSystemPrompt ?? 'base';
				},
			},
			ctx,
		);

		expect(options.forceSystemPrompt).not.toContain('<name>b</name>');
		expect(options.forceSystemPrompt).toContain('<name>a</name>');
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
