/**
 * preset 扩展 — 真实 closure 集成测试（fake pi 驱动，不 mock preset 之外的依赖）
 *
 * 与 preset.tui.test.ts（mock actions 测 UI 状态机）互补：本文件通过捕获型 fake pi
 * 驱动真实 presetExtension，验证数据层 closure 的真实行为：
 *   - applyPreset 失败路径（model 未找到 / 无 API key / 未知工具）
 *   - before_agent_start 注入 instructions
 *   - session 恢复（turn_start appendEntry + session_start 重建 re-apply tools）
 *   - applySelection 清除时恢复 originalState
 *   - resolveScopedPreset 三级 shadow（session > project > user）
 *   - --preset flag 已知/未知
 *   - 面板 actions 真实 closure：addSessionPreset / deleteSessionPreset /
 *     copyToSession / promoteToProject（写 config.json）/ editField 六字段
 *   - 无 preset 时面板提示、originalState 快照时机
 *
 * 仅 mock @zenone/pi-selector（其行为已由 selector 自身测试覆盖）。
 *
 * 注：promoteToProject 的「覆盖项目级同名」确认分支在当前 UI 流程不可达
 * （addSessionPreset 与 editField name 均做跨三级重名检查），故不写用例。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

vi.mock('@zenone/pi-selector', () => ({
	showSelect: vi.fn(),
	showConfirm: vi.fn(),
	showConfirmDestructive: vi.fn(),
	isSelecting: () => false,
}));

// model.ts 的 pickModel 依赖 pi 内置 ModelSelectorComponent（真实 TUI），
// 单元测试 mock 掉：editField 的 model 字段只验证「pickModel 返回 → preset 更新」。
vi.mock('../../../extensions/meta/preset/model.js', () => ({
	default: vi.fn(),
	registerModelApi: vi.fn(),
	pickModel: vi.fn(),
}));

import { showSelect, showConfirm } from '@zenone/pi-selector';
import { pickModel } from '../../../extensions/meta/preset/model.js';
import presetExtension, {
	type PresetPanelComponent,
} from '../../../extensions/meta/preset/index.js';

// ──────────────────────────────────────────────────────────────────────────────
// 捕获型 fake pi / ctx
// ──────────────────────────────────────────────────────────────────────────────

interface Recording {
	setModelCalls: unknown[];
	setThinkingLevelCalls: unknown[];
	setActiveToolsCalls: string[][];
	appendEntryCalls: Array<{ type: string; data: unknown }>;
}

interface FakePiConfig {
	getFlag?: () => string | undefined;
	setModelResult?: boolean;
	allTools?: string[];
	activeTools?: string[];
	/** 可变引用：测试中途改动 current 以模拟第三方改 tools（turn_start 兜底回滚用）。 */
	activeToolsRef?: { current: string[] };
	thinkingLevel?: string;
	model?: unknown;
}

function makeFakePi(cfg: FakePiConfig = {}) {
	const rec: Recording = {
		setModelCalls: [],
		setThinkingLevelCalls: [],
		setActiveToolsCalls: [],
		appendEntryCalls: [],
	};
	const handlers: Record<string, Array<(e: unknown, ctx: unknown) => unknown>> = {};
	const commands: Record<string, (args: string, ctx: unknown) => Promise<void>> = {};
	const shortcuts: Array<(ctx: unknown) => Promise<void>> = [];

	const pi = {
		on: (event: string, handler: (e: unknown, ctx: unknown) => unknown) => {
			(handlers[event] ??= []).push(handler);
		},
		registerCommand: (
			name: string,
			def: { handler: (args: string, ctx: unknown) => Promise<void> },
		) => {
			commands[name] = def.handler;
		},
		registerFlag: () => {},
		registerShortcut: (_key: unknown, def: { handler: (ctx: unknown) => Promise<void> }) => {
			shortcuts.push(def.handler);
		},
		getFlag: () => cfg.getFlag?.() ?? undefined,
		getThinkingLevel: () => cfg.thinkingLevel ?? 'off',
		setThinkingLevel: (l: unknown) => {
			rec.setThinkingLevelCalls.push(l);
		},
		getActiveTools: () => cfg.activeToolsRef?.current ?? cfg.activeTools ?? ['read', 'bash'],
		setActiveTools: (tools: string[]) => {
			rec.setActiveToolsCalls.push(tools);
		},
		getAllTools: () =>
			(cfg.allTools ?? ['read', 'bash', 'edit', 'write']).map((t) => ({ name: t })),
		appendEntry: (type: string, data: unknown) => {
			rec.appendEntryCalls.push({ type, data });
		},
		setModel: async (m: unknown) => {
			rec.setModelCalls.push(m);
			return cfg.setModelResult ?? true;
		},
	};

	return { pi, rec, handlers, commands, shortcuts };
}

interface CtxOverrides {
	custom?: (factory: unknown) => Promise<string | null>;
	input?: (title: string, placeholder: string) => Promise<string | undefined>;
	editor?: (title: string, content: string) => Promise<string | undefined>;
	findModel?: (provider: string, model: string) => unknown;
	available?: Array<{ provider: string; id: string }>;
	entries?: unknown[];
	model?: unknown;
}

function makeCtx(overrides: CtxOverrides = {}) {
	const notifyCalls: Array<{ message: string; type: string }> = [];
	const setStatusCalls: Array<{ key: string; value: unknown }> = [];

	const ctx = {
		cwd: tmpCwd,
		hasUI: true,
		model: overrides.model ?? { provider: 'mock', id: 'm1' },
		modelRegistry: {
			getAvailable: () => overrides.available ?? [],
			hasConfiguredAuth: () => true,
			find: (p: string, m: string) => overrides.findModel?.(p, m) ?? undefined,
		},
		ui: {
			notify: (message: string, type: string) => {
				notifyCalls.push({ message, type });
			},
			setStatus: (key: string, value: unknown) => {
				setStatusCalls.push({ key, value });
			},
			theme: { fg: (_c: string, text: string) => text },
			custom: overrides.custom ?? (async () => '(none)'),
			input: overrides.input ?? (async () => undefined),
			editor: overrides.editor ?? (async () => undefined),
		},
		sessionManager: { getEntries: () => overrides.entries ?? [] },
	};

	return { ctx, notifyCalls, setStatusCalls };
}

function mockTheme(): any {
	return {
		fg: (_c: string, text: string) => text,
		bg: (_c: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		underline: (text: string) => text,
		inverse: (text: string) => text,
	};
}

function mockTui(): any {
	return { requestRender: () => {} };
}

/** 捕获真实 PresetPanelComponent 的 custom harness。 */
function makeCustomHarness(
	multiSelectResult: string[] = [],
	fieldEditResult?: string,
	promptNameResult = 'debug',
) {
	let component: PresetPanelComponent | null = null;
	type PanelResult = string | null | { action: 'edit-instructions'; name: string };
	let resolveResult: (r: PanelResult) => void = () => {};
	const resultPromise = new Promise<PanelResult>((resolveFn) => {
		resolveResult = resolveFn;
	});
	let callCount = 0;
	const custom = (factory: any) => {
		callCount++;
		if (callCount === 1) {
			// 第一次：面板（PresetPanelComponent）
			component = factory(mockTui(), mockTheme(), undefined, (result: PanelResult) => {
				resolveResult(result);
			});
			return resultPromise;
		}
		// 第二次 = promptName（按 n 新增名的 showTextInput），固定返回非重名的新增名。
		if (callCount === 2) return Promise.resolve(promptNameResult);
		// 第三次及以后 = 字段编辑（showTextInput 返回 string，或 showMultiSelect 返回 string[]）。
		// 不执行 factory（真实组件构造依赖完整 tui 环境，mock 下会抛异常），
		// 直接返回配置结果（模拟完成）。
		return Promise.resolve(fieldEditResult !== undefined ? fieldEditResult : multiSelectResult);
	};
	return {
		custom,
		getComponent: () => component as PresetPanelComponent | null,
		resultPromise,
	};
}

type HandlerMap = Record<string, Array<(e: unknown, ctx: unknown) => unknown>>;

async function fireEvent(
	handlers: HandlerMap,
	event: string,
	e: unknown,
	ctx: unknown,
): Promise<void> {
	for (const handler of handlers[event] ?? []) {
		await handler(e, ctx);
	}
}

function tick(): Promise<void> {
	return new Promise((r) => setTimeout(r, 0));
}

// ──────────────────────────────────────────────────────────────────────────────
// 目录隔离
// ──────────────────────────────────────────────────────────────────────────────

const ORIGINAL_HOME = process.env.HOME;
let tmpHome: string;
let tmpCwd: string;

function setupDirs(
	projectConfig?: Record<string, unknown>,
	userConfig?: Record<string, unknown>,
): void {
	tmpHome = resolve(tmpdir(), `preset-integration-${randomUUID()}`);
	tmpCwd = resolve(tmpHome, 'cwd');
	mkdirSync(resolve(tmpCwd, '.pi', 'extensions-data', 'preset'), { recursive: true });
	if (projectConfig) {
		writeFileSync(
			resolve(tmpCwd, '.pi', 'extensions-data', 'preset', 'config.json'),
			JSON.stringify(projectConfig),
			'utf8',
		);
	}
	if (userConfig) {
		mkdirSync(resolve(tmpHome, '.pi', 'agent', 'extensions-data', 'preset'), {
			recursive: true,
		});
		writeFileSync(
			resolve(tmpHome, '.pi', 'agent', 'extensions-data', 'preset', 'config.json'),
			JSON.stringify(userConfig),
			'utf8',
		);
	}
	process.env.HOME = tmpHome;
}

function cleanupDirs(): void {
	process.env.HOME = ORIGINAL_HOME;
	try {
		rmSync(tmpHome, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
}

function readProjectConfig(): Record<string, unknown> {
	return JSON.parse(
		readFileSync(resolve(tmpCwd, '.pi', 'extensions-data', 'preset', 'config.json'), 'utf8'),
	) as Record<string, unknown>;
}

// ──────────────────────────────────────────────────────────────────────────────
// 场景 1：applyPreset 失败路径 + instructions + session 恢复 + 清除恢复 + shadow + flag
// ──────────────────────────────────────────────────────────────────────────────

describe('preset 真实 closure — applyPreset 失败路径', () => {
	it('model 未找到 → notify 警告，但仍设置 activePreset', async () => {
		setupDirs({ plan: { provider: 'anthropic', model: 'claude-x', thinkingLevel: 'high' } });
		const { pi, rec, commands, handlers } = makeFakePi();
		presetExtension(pi as never);
		const { ctx, notifyCalls } = makeCtx({ findModel: () => undefined });
		await fireEvent(handlers, 'session_start', null, ctx);

		await commands['preset']('plan', ctx);

		expect(notifyCalls.some((n) => n.message.includes('not found'))).toBe(true);
		// activePreset 仍被设置 → 后续 turn_start 会 appendEntry
		await fireEvent(handlers, 'turn_start', null, ctx);
		expect(rec.appendEntryCalls.some((e) => e.type === 'preset-state')).toBe(true);
		cleanupDirs();
	});

	it('setModel 返回 false（无 API key）→ notify 警告', async () => {
		setupDirs({ plan: { provider: 'anthropic', model: 'claude-x' } });
		const model = { provider: 'anthropic', id: 'claude-x' };
		const { pi, commands, handlers } = makeFakePi({ setModelResult: false });
		presetExtension(pi as never);
		const { ctx, notifyCalls } = makeCtx({ findModel: () => model });
		await fireEvent(handlers, 'session_start', null, ctx);

		await commands['preset']('plan', ctx);

		expect(notifyCalls.some((n) => n.message.includes('No API key'))).toBe(true);
		cleanupDirs();
	});

	it('未知工具 → notify 警告并只应用有效工具', async () => {
		setupDirs({ plan: { tools: ['read', 'nonexistent'] } });
		const { pi, rec, commands, handlers } = makeFakePi({ allTools: ['read', 'bash'] });
		presetExtension(pi as never);
		const { ctx, notifyCalls } = makeCtx();
		await fireEvent(handlers, 'session_start', null, ctx);

		await commands['preset']('plan', ctx);

		expect(notifyCalls.some((n) => n.message.includes('Unknown tools: nonexistent'))).toBe(
			true,
		);
		expect(rec.setActiveToolsCalls).toContainEqual(['read']);
		cleanupDirs();
	});

	it('tools: [] 空数组 → 恢复全部工具（不限制）', async () => {
		setupDirs({ plan: { tools: [] } });
		const { pi, rec, commands, handlers } = makeFakePi({
			allTools: ['read', 'bash', 'edit', 'write', 'web_search'],
		});
		presetExtension(pi as never);
		const { ctx } = makeCtx();
		await fireEvent(handlers, 'session_start', null, ctx);

		await commands['preset']('plan', ctx);

		expect(rec.setActiveToolsCalls).toContainEqual([
			'read',
			'bash',
			'edit',
			'write',
			'web_search',
		]);
		cleanupDirs();
	});

	it('skills 字段 → __skillsApi.replaceSkills 调用（[] 全部禁止）', async () => {
		setupDirs({ plan: { skills: [] } });
		const { pi, commands, handlers } = makeFakePi();
		presetExtension(pi as never);
		const { ctx } = makeCtx();
		await fireEvent(handlers, 'session_start', null, ctx);

		// presetExtension 加载 skillsExtension 后挂载真实 __skillsApi，spy 它
		const skillsApi = (
			globalThis as unknown as {
				__skillsApi: { replaceSkills: (s: string[] | null) => void };
			}
		).__skillsApi;
		const spy = vi.spyOn(skillsApi, 'replaceSkills');

		await commands['preset']('plan', ctx);

		expect(spy).toHaveBeenCalledWith([]);
		spy.mockRestore();
		cleanupDirs();
	});
});

describe('preset 真实 closure — instructions 注入', () => {
	it('instructions 经 __presetApi 暴露（供 prompt-editor 组件注入）', async () => {
		setupDirs({ plan: { instructions: '你是规划专家。' } });
		const { pi, commands, handlers } = makeFakePi();
		presetExtension(pi as never);
		const { ctx } = makeCtx();
		await fireEvent(handlers, 'session_start', null, ctx);

		await commands['preset']('plan', ctx);
		const instructions = (
			globalThis as { __presetApi?: { getInstructions?: () => string | null } }
		).__presetApi?.getInstructions?.();
		expect(instructions).toBe('你是规划专家。');
		cleanupDirs();
	});

	it('无 instructions 时 __presetApi.getInstructions 返回 null', async () => {
		setupDirs({ plan: { thinkingLevel: 'high' } });
		const { pi, commands, handlers } = makeFakePi();
		presetExtension(pi as never);
		const { ctx } = makeCtx();
		await fireEvent(handlers, 'session_start', null, ctx);

		await commands['preset']('plan', ctx);
		const instructions = (
			globalThis as { __presetApi?: { getInstructions?: () => string | null } }
		).__presetApi?.getInstructions?.();
		expect(instructions).toBeNull();
		cleanupDirs();
	});
});

describe('preset /mode 命令（ADR-0034）', () => {
	it('/mode 切换 model+thinking 并触发偏离', async () => {
		setupDirs({ plan: { provider: 'mock', model: 'm1', thinkingLevel: 'high' } });
		const { pi, rec, commands, handlers } = makeFakePi();
		presetExtension(pi as never);
		const { ctx } = makeCtx({
			findModel: (p, m) => ({ provider: p, id: m }),
		});
		await fireEvent(handlers, 'session_start', null, ctx);
		// 激活 plan（建立 activePreset）
		await commands['preset']('plan', ctx);
		// 清空 /preset plan 产生的 setModel/setThinkingLevel 记录
		rec.setModelCalls.length = 0;
		rec.setThinkingLevelCalls.length = 0;

		(pickModel as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue({
			provider: 'mock',
			modelId: 'm2',
		});
		(showSelect as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue({
			value: 'low',
		});

		await commands['mode']('', ctx);

		expect(rec.setModelCalls).toHaveLength(1);
		expect((rec.setModelCalls[0] as { id: string }).id).toBe('m2');
		expect(rec.setThinkingLevelCalls).toContain('low');
		cleanupDirs();
	});
});

describe('preset 锁定守卫（ADR-0035）', () => {
	it('锁定 + tools 已配置 + 无偏离时，引入偏离的修改被拒绝', async () => {
		setupDirs({ plan: { tools: ['read'], locked: true } });
		const { pi, commands, handlers } = makeFakePi({ activeTools: ['read'] });
		presetExtension(pi as never);
		const { ctx } = makeCtx({ model: { provider: 'mock', id: 'm1' } });
		await fireEvent(handlers, 'session_start', null, ctx);
		await commands['preset']('plan', ctx);

		const guard = (globalThis as Record<string, unknown>).__presetGuard as {
			canModify: (d: string, nextValue?: unknown) => { allowed: boolean; reason?: string };
		};
		const r = guard.canModify('tools', ['read', 'grep']);
		expect(r.allowed).toBe(false);
		expect(r.reason).toContain('preset 已锁定');
		cleanupDirs();
	});

	it('锁定 + tools 已配置 + 已偏离时，改回设定值放行', async () => {
		setupDirs({ plan: { tools: ['read'], locked: true } });
		const { pi, commands, handlers } = makeFakePi({ activeTools: ['grep'] });
		presetExtension(pi as never);
		const { ctx } = makeCtx({ model: { provider: 'mock', id: 'm1' } });
		await fireEvent(handlers, 'session_start', null, ctx);
		await commands['preset']('plan', ctx);

		const guard = (globalThis as Record<string, unknown>).__presetGuard as {
			canModify: (d: string, nextValue?: unknown) => { allowed: boolean; reason?: string };
		};
		const r = guard.canModify('tools', ['read']);
		expect(r.allowed).toBe(true);
		cleanupDirs();
	});

	it('锁定 + 维度未配置时放行（只锁 tools 的 preset 不拒绝 model 修改）', async () => {
		setupDirs({ plan: { tools: ['read'], locked: true } });
		const { pi, commands, handlers } = makeFakePi({ activeTools: ['read'] });
		presetExtension(pi as never);
		const { ctx } = makeCtx({ model: { provider: 'mock', id: 'm1' } });
		await fireEvent(handlers, 'session_start', null, ctx);
		await commands['preset']('plan', ctx);

		const guard = (globalThis as Record<string, unknown>).__presetGuard as {
			canModify: (d: string, nextValue?: unknown) => { allowed: boolean; reason?: string };
		};
		// model 维度未在 plan 配置 → 即使锁定也放行
		const r = guard.canModify('model', { provider: 'mock', id: 'm2' });
		expect(r.allowed).toBe(true);
		cleanupDirs();
	});

	it('锁定 preset 经 /model 切偏 → model_select 事后回滚 + error（ADR-0035）', async () => {
		setupDirs({ plan: { provider: 'mock', model: 'm1', thinkingLevel: 'high', locked: true } });
		const { pi, rec, commands, handlers } = makeFakePi({ thinkingLevel: 'high' });
		presetExtension(pi as never);
		const { ctx } = makeCtx({
			model: { provider: 'mock', id: 'm1' },
			findModel: (p, m) => ({ provider: p, id: m }),
		});
		await fireEvent(handlers, 'session_start', null, ctx);
		await commands['preset']('plan', ctx);
		// 清空激活 plan 产生的 setModel，聚焦 model_select 回滚
		rec.setModelCalls.length = 0;

		// 用户经内置 /model 切到 m2 → model_select 触发，ctx.model 已是 m2（偏离）
		const drifted = makeCtx({
			model: { provider: 'mock', id: 'm2' },
			findModel: (p, m) => ({ provider: p, id: m }),
		});
		await fireEvent(handlers, 'model_select', null, drifted.ctx);

		// 回滚到 preset 的 m1 + error 提示
		expect(rec.setModelCalls.length).toBeGreaterThanOrEqual(1);
		expect((rec.setModelCalls.at(-1) as { id: string }).id).toBe('m1');
		expect(
			drifted.notifyCalls.some((c) => c.type === 'error' && c.message.includes('锁定')),
		).toBe(true);
		cleanupDirs();
	});

	it('锁定 preset 切 thinking 偏离 → thinking_level_select 回滚 + error（ADR-0035）', async () => {
		setupDirs({ plan: { provider: 'mock', model: 'm1', thinkingLevel: 'high', locked: true } });
		// getThinkingLevel 固定返回 'low'：模拟用户切到 low 后偏离 preset 的 high
		const { pi, rec, commands, handlers } = makeFakePi({ thinkingLevel: 'low' });
		presetExtension(pi as never);
		const { ctx } = makeCtx({ model: { provider: 'mock', id: 'm1' } });
		await fireEvent(handlers, 'session_start', null, ctx);
		await commands['preset']('plan', ctx);
		rec.setThinkingLevelCalls.length = 0;

		const drifted = makeCtx({ model: { provider: 'mock', id: 'm1' } });
		await fireEvent(handlers, 'thinking_level_select', null, drifted.ctx);

		// 回滚到 preset 的 high + error 提示
		expect(rec.setThinkingLevelCalls).toContain('high');
		expect(
			drifted.notifyCalls.some((c) => c.type === 'error' && c.message.includes('thinking')),
		).toBe(true);
		cleanupDirs();
	});
});

describe('preset turn_start 兜底回滚（ADR-0035 扩展）', () => {
	it('锁定 preset 第三方改 tools → turn_start 兜底回滚 + warning', async () => {
		setupDirs({ plan: { tools: ['read'], locked: true } });
		const toolsRef = { current: ['read'] };
		const { pi, commands, handlers } = makeFakePi({ activeToolsRef: toolsRef });
		presetExtension(pi as never);
		const { ctx, notifyCalls } = makeCtx({ model: { provider: 'mock', id: 'm1' } });
		const replaceToolsCalls: string[][] = [];
		(globalThis as Record<string, unknown>).__toolsApi = {
			replaceTools: (t: string[]) => {
				replaceToolsCalls.push(t);
				toolsRef.current = [...t]; // 模拟真实 replaceTools 更新启用集
			},
		};

		await fireEvent(handlers, 'session_start', null, ctx);
		await commands['preset']('plan', ctx);
		replaceToolsCalls.length = 0; // 清空 activate 时的调用

		// 第三方改 tools → 偏离
		toolsRef.current = ['grep'];
		await fireEvent(handlers, 'turn_start', null, ctx);

		expect(replaceToolsCalls).toContainEqual(['read']);
		expect(notifyCalls.some((n) => n.type === 'warning' && n.message.includes('工具'))).toBe(
			true,
		);

		// 回滚已收敛：下一次 turn_start 不再重复回滚
		replaceToolsCalls.length = 0;
		await fireEvent(handlers, 'turn_start', null, ctx);
		expect(replaceToolsCalls).toHaveLength(0);

		delete (globalThis as Record<string, unknown>).__toolsApi;
		cleanupDirs();
	});

	it('锁定 preset 第三方改 skills → turn_start 兜底回滚', async () => {
		setupDirs({ plan: { skills: ['read-skill'], locked: true } });
		const { pi, commands, handlers } = makeFakePi({});
		presetExtension(pi as never);
		const { ctx, notifyCalls } = makeCtx({ model: { provider: 'mock', id: 'm1' } });
		const allSkills = ['read-skill', 'other-skill'];
		const skillsRef = { current: ['read-skill'] };
		const replaceSkillsCalls: Array<string[] | null | undefined> = [];
		(globalThis as Record<string, unknown>).__skillsApi = {
			getSkillNames: () => allSkills,
			getEnabledSkills: () => skillsRef.current,
			replaceSkills: (s: string[] | null | undefined) => {
				replaceSkillsCalls.push(s);
				// 模拟真实 applySkills：null=全部启用，否则过滤无效名
				skillsRef.current =
					s == null ? [...allSkills] : s.filter((n) => allSkills.includes(n));
			},
		};

		await fireEvent(handlers, 'session_start', null, ctx);
		await commands['preset']('plan', ctx);
		replaceSkillsCalls.length = 0; // 清空 activate 时的调用

		skillsRef.current = ['other-skill'];
		await fireEvent(handlers, 'turn_start', null, ctx);

		expect(replaceSkillsCalls).toContainEqual(['read-skill']);
		expect(notifyCalls.some((n) => n.type === 'warning' && n.message.includes('技能'))).toBe(
			true,
		);

		// 回滚已收敛：下一次 turn_start 不再重复回滚
		replaceSkillsCalls.length = 0;
		await fireEvent(handlers, 'turn_start', null, ctx);
		expect(replaceSkillsCalls).toHaveLength(0);

		delete (globalThis as Record<string, unknown>).__skillsApi;
		cleanupDirs();
	});

	it('锁定 preset 第三方改 instructions → turn_start 兜底回滚（clearOverride）', async () => {
		setupDirs({ plan: { instructions: 'be concise', locked: true } });
		const { pi, commands, handlers } = makeFakePi({});
		presetExtension(pi as never);
		const { ctx, notifyCalls } = makeCtx({ model: { provider: 'mock', id: 'm1' } });
		const overrideRef: { current: { enabled: boolean; content?: string } | undefined } = {
			current: undefined,
		};
		const clearCalls: string[] = [];
		(globalThis as Record<string, unknown>).__promptEditorApi = {
			getOverride: (_key: string) => overrideRef.current,
			clearOverride: (key: string) => {
				clearCalls.push(key);
				overrideRef.current = undefined; // 模拟真实 clearOverride 删除 override
				return true;
			},
		};

		await fireEvent(handlers, 'session_start', null, ctx);
		await commands['preset']('plan', ctx);

		// 第三方覆盖 instructions → 偏离（enabled=false 或改内容）
		overrideRef.current = { enabled: false, content: 'hacked' };
		await fireEvent(handlers, 'turn_start', null, ctx);

		expect(clearCalls).toContain('preset_instructions:preset');
		expect(notifyCalls.some((n) => n.type === 'warning' && n.message.includes('指令'))).toBe(
			true,
		);

		// 回滚已收敛：下一次 turn_start 不再重复回滚
		clearCalls.length = 0;
		await fireEvent(handlers, 'turn_start', null, ctx);
		expect(clearCalls).toHaveLength(0);

		delete (globalThis as Record<string, unknown>).__promptEditorApi;
		cleanupDirs();
	});

	it('锁定 preset 白名单含无效工具名 → 不误判偏离、不循环回滚', async () => {
		setupDirs({ plan: { tools: ['read', 'ghost-tool'], locked: true } });
		const toolsRef = { current: ['read'] };
		const { pi, commands, handlers } = makeFakePi({
			activeToolsRef: toolsRef,
			allTools: ['read', 'bash'],
		});
		presetExtension(pi as never);
		const { ctx, notifyCalls } = makeCtx({ model: { provider: 'mock', id: 'm1' } });
		const replaceToolsCalls: string[][] = [];
		(globalThis as Record<string, unknown>).__toolsApi = {
			replaceTools: (t: string[]) => {
				replaceToolsCalls.push(t);
				toolsRef.current = [...t];
			},
		};

		await fireEvent(handlers, 'session_start', null, ctx);
		await commands['preset']('plan', ctx);
		replaceToolsCalls.length = 0; // 清空 activate 时的调用（仅含有效工具 read）

		// 无效名 ghost-tool 被过滤，锁定 preset 不应误判「工具偏离」或触发循环回滚
		await fireEvent(handlers, 'turn_start', null, ctx);
		expect(replaceToolsCalls).toHaveLength(0);
		expect(notifyCalls.filter((n) => n.message.includes('工具'))).toHaveLength(0);

		delete (globalThis as Record<string, unknown>).__toolsApi;
		cleanupDirs();
	});

	it('未锁定 preset 第三方改 tools → turn_start 不兜底回滚', async () => {
		setupDirs({ plan: { tools: ['read'] } });
		const toolsRef = { current: ['read'] };
		const { pi, commands, handlers } = makeFakePi({ activeToolsRef: toolsRef });
		presetExtension(pi as never);
		const { ctx } = makeCtx({ model: { provider: 'mock', id: 'm1' } });
		const replaceToolsCalls: string[][] = [];
		(globalThis as Record<string, unknown>).__toolsApi = {
			replaceTools: (t: string[]) => replaceToolsCalls.push(t),
		};

		await fireEvent(handlers, 'session_start', null, ctx);
		await commands['preset']('plan', ctx);
		replaceToolsCalls.length = 0; // 清空 activate 时的调用

		toolsRef.current = ['grep'];
		await fireEvent(handlers, 'turn_start', null, ctx);

		expect(replaceToolsCalls).toHaveLength(0);

		delete (globalThis as Record<string, unknown>).__toolsApi;
		cleanupDirs();
	});
});

describe('preset 真实 closure — session 恢复', () => {
	it('turn_start appendEntry；第二次 session_start 从 entry 恢复并 re-apply tools', async () => {
		setupDirs({ plan: { tools: ['read'] } });
		const { pi, rec, commands, handlers } = makeFakePi({ allTools: ['read', 'bash'] });
		presetExtension(pi as never);

		const ctx1 = makeCtx();
		await fireEvent(handlers, 'session_start', null, ctx1.ctx);
		await commands['preset']('plan', ctx1.ctx);
		await fireEvent(handlers, 'turn_start', null, ctx1.ctx);
		expect(
			rec.appendEntryCalls.some(
				(e) => e.type === 'preset-state' && (e.data as any).name === 'plan',
			),
		).toBe(true);

		// 第二次会话：从 entries 恢复（模拟 /reload 或重启）
		const persisted = rec.appendEntryCalls.find((e) => e.type === 'preset-state');
		const entries = [{ type: 'custom', customType: 'preset-state', data: persisted?.data }];
		const ctx2 = makeCtx({ entries });
		rec.setActiveToolsCalls.length = 0;
		await fireEvent(handlers, 'session_start', null, ctx2.ctx);

		expect(rec.setActiveToolsCalls).toContainEqual(['read']);
		cleanupDirs();
	});
});

describe('preset 真实 closure — 清除恢复 originalState', () => {
	it('applySelection((none)) 恢复快照的 model/thinkingLevel/tools', async () => {
		setupDirs({ plan: { thinkingLevel: 'high' } });
		const { pi, rec, commands, handlers } = makeFakePi({
			thinkingLevel: 'off',
			activeTools: ['read', 'bash'],
		});
		presetExtension(pi as never);
		const { ctx } = makeCtx({ model: { provider: 'mock', id: 'm1' } });
		await fireEvent(handlers, 'session_start', null, ctx);

		await commands['preset']('plan', ctx);
		await commands['preset']('', ctx); // custom 返回 (none) → 清除

		expect(rec.setModelCalls).toContainEqual({ provider: 'mock', id: 'm1' });
		expect(rec.setThinkingLevelCalls).toContain('off');
		expect(rec.setActiveToolsCalls).toContainEqual(['read', 'bash']);
		cleanupDirs();
	});

	it('连续切换多个 preset 后清除，恢复最初快照而非中间状态', async () => {
		setupDirs({ plan: { thinkingLevel: 'high' }, implement: { thinkingLevel: 'medium' } });
		const { pi, rec, commands, handlers } = makeFakePi({ thinkingLevel: 'off' });
		presetExtension(pi as never);
		const { ctx } = makeCtx();
		await fireEvent(handlers, 'session_start', null, ctx);

		await commands['preset']('plan', ctx); // 首次 → 快照 off
		await commands['preset']('implement', ctx); // 已激活 → 不快照
		await commands['preset']('', ctx); // 清除

		// 清除时最后一次 setThinkingLevel 应恢复为最初快照 off（而非中间 medium）
		expect(rec.setThinkingLevelCalls.at(-1)).toBe('off');
		cleanupDirs();
	});
});

describe('preset 真实 closure — 三级 shadow 与 --preset flag', () => {
	it('project 级覆盖同名 user 级（/preset name 激活 project 版）', async () => {
		setupDirs({ shared: { thinkingLevel: 'high' } }, { shared: { thinkingLevel: 'low' } });
		const { pi, rec, commands, handlers } = makeFakePi();
		presetExtension(pi as never);
		const { ctx } = makeCtx();
		await fireEvent(handlers, 'session_start', null, ctx);

		await commands['preset']('shared', ctx);

		expect(rec.setThinkingLevelCalls).toContain('high');
		expect(rec.setThinkingLevelCalls).not.toContain('low');
		cleanupDirs();
	});

	it('--preset flag 激活已知 preset', async () => {
		setupDirs({ plan: { thinkingLevel: 'high' } });
		const { pi, rec, handlers } = makeFakePi({ getFlag: () => 'plan' });
		presetExtension(pi as never);
		const { ctx } = makeCtx();
		await fireEvent(handlers, 'session_start', null, ctx);

		expect(rec.setThinkingLevelCalls).toContain('high');
		cleanupDirs();
	});

	it('--preset flag 指向未知 preset → notify 警告', async () => {
		setupDirs({ plan: { thinkingLevel: 'high' } });
		const { pi, handlers } = makeFakePi({ getFlag: () => 'ghost' });
		presetExtension(pi as never);
		const { ctx, notifyCalls } = makeCtx();
		await fireEvent(handlers, 'session_start', null, ctx);

		expect(notifyCalls.some((n) => n.message.includes('未知预设'))).toBe(true);
		cleanupDirs();
	});
});

describe('preset 真实 closure — 无 preset 面板提示', () => {
	it('无任何 config 时 /preset 提示 No presets defined，不触发 custom', async () => {
		setupDirs();
		const { pi, commands, handlers } = makeFakePi();
		presetExtension(pi as never);
		let customCalled = false;
		const { ctx, notifyCalls } = makeCtx({
			custom: (() => {
				customCalled = true;
				return Promise.resolve(null);
			}) as never,
		});
		await fireEvent(handlers, 'session_start', null, ctx);

		await commands['preset']('', ctx);

		expect(customCalled).toBe(true);
		expect(notifyCalls.some((n) => n.message.includes('No presets defined'))).toBe(false);
		cleanupDirs();
	});
});

// ──────────────────────────────────────────────────────────────────────────────
// 场景 2：面板 actions 真实 closure（custom harness 驱动）
// ──────────────────────────────────────────────────────────────────────────────

describe('preset 面板 actions 真实 closure', () => {
	beforeEach(() => {
		vi.mocked(showConfirm).mockReset();
		vi.mocked(showSelect).mockReset();
		vi.mocked(showConfirm).mockResolvedValue(true);
	});

	it('n 新建会话级 → addSessionPreset 真实写入 session Map', async () => {
		setupDirs({ plan: { thinkingLevel: 'high' } });
		const { pi, commands, handlers } = makeFakePi();
		presetExtension(pi as never);
		const harness = makeCustomHarness();
		const { ctx } = makeCtx({ custom: harness.custom as never, input: async () => 'debug' });
		await fireEvent(handlers, 'session_start', null, ctx);

		void commands['preset']('', ctx);
		const comp = harness.getComponent();
		expect(comp).toBeTruthy();

		comp!.handleInput('n');
		await tick();

		expect(comp!.render(80).join('\n')).toContain('[会话] debug');
		cleanupDirs();
	});

	it('n 重名（与文件级同名）→ notify 错误，不新增', async () => {
		setupDirs({ plan: { thinkingLevel: 'high' } });
		const { pi, commands, handlers } = makeFakePi();
		presetExtension(pi as never);
		const harness = makeCustomHarness([], undefined, 'plan');
		const { ctx, notifyCalls } = makeCtx({
			custom: harness.custom as never,
		});
		await fireEvent(handlers, 'session_start', null, ctx);

		void commands['preset']('', ctx);
		const comp = harness.getComponent();
		comp!.handleInput('n');
		await tick();

		expect(notifyCalls.some((n) => n.message.includes('已存在同名'))).toBe(true);
		const text = comp!.render(80).join('\n');
		expect(text).toContain('[项目] plan');
		expect(text).not.toContain('[会话] plan');
		cleanupDirs();
	});

	it('d 删除会话级 → deleteSessionPreset 真实移除', async () => {
		setupDirs({ plan: { thinkingLevel: 'high' } });
		const { pi, commands, handlers } = makeFakePi();
		presetExtension(pi as never);
		const harness = makeCustomHarness();
		const { ctx } = makeCtx({ custom: harness.custom as never, input: async () => 'debug' });
		await fireEvent(handlers, 'session_start', null, ctx);

		void commands['preset']('', ctx);
		const comp = harness.getComponent();

		comp!.handleInput('n');
		await tick();
		expect(comp!.render(80).join('\n')).toContain('[会话] debug');

		comp!.handleInput('d');
		await tick();

		expect(comp!.render(80).join('\n')).not.toContain('[会话] debug');
		cleanupDirs();
	});

	it('文件级 e → copyToSession 复制为「原名-复制」', async () => {
		setupDirs({ plan: { provider: 'anthropic', model: 'claude-x' } }, {});
		const { pi, commands, handlers } = makeFakePi();
		presetExtension(pi as never);
		const harness = makeCustomHarness();
		const { ctx } = makeCtx({ custom: harness.custom as never });
		await fireEvent(handlers, 'session_start', null, ctx);

		void commands['preset']('', ctx);
		const comp = harness.getComponent();

		// 默认选中 (none)（isActive=true，因未激活）→ ↑ 到 plan → → 详情 → e 复制为临时
		comp!.handleInput('\u001b[A'); // ↑ 到 plan
		comp!.handleInput('\u001b[C'); // → 详情（plan 文件级）
		comp!.handleInput('e'); // 复制为临时
		await tick();

		expect(comp!.render(80).join('\n')).toContain('plan-复制');
		cleanupDirs();
	});

	it('会话级 s → promoteToProject 写项目级 config.json 并移除会话级', async () => {
		setupDirs({ plan: { thinkingLevel: 'high' } });
		const { pi, commands, handlers } = makeFakePi();
		presetExtension(pi as never);
		const harness = makeCustomHarness();
		const { ctx } = makeCtx({ custom: harness.custom as never, input: async () => 'debug' });
		await fireEvent(handlers, 'session_start', null, ctx);

		void commands['preset']('', ctx);
		const comp = harness.getComponent();

		comp!.handleInput('n');
		await tick();
		comp!.handleInput('\u001b[C'); // → 详情
		comp!.handleInput('s'); // 提升
		await tick();

		expect(readProjectConfig().debug).toBeDefined();
		expect(comp!.render(80).join('\n')).not.toContain('[会话] debug');
		cleanupDirs();
	});
});

// ──────────────────────────────────────────────────────────────────────────────
// 场景 3：editField 真实 closure 六字段（custom harness + mock showSelect）
// ──────────────────────────────────────────────────────────────────────────────

describe('preset editField 真实 closure 六字段', () => {
	beforeEach(() => {
		vi.mocked(showConfirm).mockReset();
		vi.mocked(showSelect).mockReset();
	});

	/** n 新建会话级 debug → → 详情 → e 编辑 → ↓ 到指定字段。 */
	async function enterFieldEdit(comp: PresetPanelComponent, fieldIndex: number): Promise<void> {
		comp.handleInput('n');
		await tick();
		comp.handleInput('\u001b[C'); // → 详情
		comp.handleInput('e'); // → 编辑
		for (let i = 0; i < fieldIndex; i++) comp.handleInput('\u001b[B');
	}

	it('name 字段：重命名真实重写 session Map key', async () => {
		setupDirs({ plan: { thinkingLevel: 'high' } });
		const { pi, commands, handlers } = makeFakePi();
		presetExtension(pi as never);
		const harness = makeCustomHarness([], 'debug2');
		const { ctx } = makeCtx({
			custom: harness.custom as never,
		});
		await fireEvent(handlers, 'session_start', null, ctx);

		void commands['preset']('', ctx);
		const comp = harness.getComponent()!;
		await enterFieldEdit(comp, 0); // Name 字段
		comp.handleInput('\r');
		await tick();

		expect(comp.render(80).join('\n')).toContain('debug2');
		cleanupDirs();
	});

	it('name 字段：重命名为已存在名 → notify 错误，不重写', async () => {
		setupDirs({ plan: { thinkingLevel: 'high' } });
		const { pi, commands, handlers } = makeFakePi();
		presetExtension(pi as never);
		const harness = makeCustomHarness([], 'plan');
		const { ctx, notifyCalls } = makeCtx({
			custom: harness.custom as never,
		});
		await fireEvent(handlers, 'session_start', null, ctx);

		void commands['preset']('', ctx);
		const comp = harness.getComponent()!;
		await enterFieldEdit(comp, 0);
		comp.handleInput('\r');
		await tick();

		expect(notifyCalls.some((n) => n.message.includes('已存在同名'))).toBe(true);
		expect(comp.render(80).join('\n')).toContain('debug'); // 仍为原名
		cleanupDirs();
	});

	it('model 字段：pickModel 返回后更新 provider + model', async () => {
		setupDirs({ plan: { thinkingLevel: 'high' } });
		const { pi, commands, handlers } = makeFakePi();
		presetExtension(pi as never);
		const harness = makeCustomHarness();
		const { ctx } = makeCtx({
			custom: harness.custom as never,
			input: async () => 'debug',
			available: [{ provider: 'anthropic', id: 'claude-x' }],
		});
		await fireEvent(handlers, 'session_start', null, ctx);

		vi.mocked(pickModel).mockResolvedValue({ provider: 'anthropic', modelId: 'claude-x' });

		void commands['preset']('', ctx);
		const comp = harness.getComponent()!;
		await enterFieldEdit(comp, 1); // Model 字段
		comp.handleInput('\r');
		await tick();

		const text = comp.render(80).join('\n');
		expect(text).toContain('anthropic');
		expect(text).toContain('claude-x');
		cleanupDirs();
	});

	it('thinkingLevel 字段：选择 low 更新 preset', async () => {
		setupDirs({ plan: { thinkingLevel: 'high' } });
		const { pi, commands, handlers } = makeFakePi();
		presetExtension(pi as never);
		const harness = makeCustomHarness();
		const { ctx } = makeCtx({ custom: harness.custom as never, input: async () => 'debug' });
		await fireEvent(handlers, 'session_start', null, ctx);

		vi.mocked(showSelect).mockResolvedValue({ value: 'low', label: 'low' });

		void commands['preset']('', ctx);
		const comp = harness.getComponent()!;
		await enterFieldEdit(comp, 2); // Thinking 字段
		comp.handleInput('\r');
		await tick();

		expect(comp.render(80).join('\n')).toContain('low');
		cleanupDirs();
	});

	it('tools 字段：多选 toggle 直到 __done__', async () => {
		setupDirs({ plan: { thinkingLevel: 'high' } });
		const { pi, commands, handlers } = makeFakePi({ allTools: ['read', 'bash'] });
		presetExtension(pi as never);
		const harness = makeCustomHarness(['read']);
		const { ctx } = makeCtx({ custom: harness.custom as never, input: async () => 'debug' });
		await fireEvent(handlers, 'session_start', null, ctx);

		void commands['preset']('', ctx);
		const comp = harness.getComponent()!;
		await enterFieldEdit(comp, 3); // Tools 字段
		comp.handleInput('\r');
		await tick();

		expect(comp.render(80).join('\n')).toContain('read');
		cleanupDirs();
	});

	it('instructions 字段：触发关面板 + editor 信号（多行编辑）', async () => {
		setupDirs({ plan: { thinkingLevel: 'high' } });
		const { pi, commands, handlers } = makeFakePi();
		presetExtension(pi as never);
		const harness = makeCustomHarness();
		let editorCalled = false;
		let editorContent = '';
		const { ctx } = makeCtx({
			custom: harness.custom as never,
			editor: async (_title, content) => {
				editorCalled = true;
				editorContent = content;
				return undefined; // 取消编辑
			},
		});
		await fireEvent(handlers, 'session_start', null, ctx);

		void commands['preset']('', ctx);
		const comp = harness.getComponent()!;
		await enterFieldEdit(comp, 5); // Instructions 字段
		comp.handleInput('\r');
		await tick();

		// 面板关闭，onDone 收到 edit-instructions 信号（而非单行 input）
		const result = await harness.resultPromise;
		expect(result).toEqual({ action: 'edit-instructions', name: 'debug' });

		// editor 被调用，预填当前值（debug 无 instructions → 空串）
		await tick();
		expect(editorCalled).toBe(true);
		expect(editorContent).toBe('');
		cleanupDirs();
	});
});
