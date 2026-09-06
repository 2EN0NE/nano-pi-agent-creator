/**
 * preset-usage 实验（record 型）行为测试
 *
 * 通过 fake pi 驱动 presetExtension（不 mock pi-lab 之外的任何 Pi API），验证：
 *   - session_start 注册 preset-usage 实验（弱依赖 __labApi）
 *   - /preset 切换时结算上一臂停留时长（preset test→plan 切换结算路径，e2e 未覆盖）
 *   - 清除预设（循环快捷键到 (none)）结算当前臂
 *   - session_shutdown 结算当前臂
 *   - 假时钟注入断言具体时长
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import presetExtension, {
	mergeScopedPresets,
	nextCopyName,
	persistPresetToProject,
	DEFAULT_PRESETS,
} from '../../../extensions/meta/preset/index.js';

interface Recorded {
	armId: string;
	metrics: Record<string, number>;
}

interface FakePi {
	on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
	registerCommand(
		name: string,
		def: { handler: (args: string, ctx: unknown) => Promise<void> },
	): void;
	registerFlag(): void;
	registerShortcut(_key: unknown, def: { handler: (ctx: unknown) => Promise<void> }): void;
	getFlag(): string | undefined;
	getThinkingLevel(): string;
	setThinkingLevel(): void;
	getActiveTools(): string[];
	setActiveTools(): void;
	appendEntry(): void;
	setModel(): Promise<boolean>;
	_handlers: Record<string, Array<(event: unknown, ctx: unknown) => unknown>>;
	_commands: Record<string, (args: string, ctx: unknown) => Promise<void>>;
	_shortcuts: Array<(ctx: unknown) => Promise<void>>;
}

const ORIGINAL_HOME = process.env.HOME;
let tmpHome: string;
let tmpCwd: string;

function setupDirs(): void {
	tmpHome = resolve(tmpdir(), `preset-usage-test-${randomUUID()}`);
	tmpCwd = resolve(tmpHome, 'cwd');
	mkdirSync(resolve(tmpCwd, '.pi', 'extensions-data', 'preset'), { recursive: true });
	writeFileSync(
		resolve(tmpCwd, '.pi', 'extensions-data', 'preset', 'config.json'),
		JSON.stringify({ test: { thinkingLevel: 'low' }, plan: { thinkingLevel: 'medium' } }),
		'utf8',
	);
	process.env.HOME = tmpHome;
}

function cleanupDirs(): void {
	process.env.HOME = ORIGINAL_HOME;
	try {
		rmSync(tmpHome, { recursive: true, force: true });
	} catch {
		// ignore
	}
}

function makeFakePi(records: Recorded[]): FakePi {
	const _handlers: Record<string, Array<(event: unknown, ctx: unknown) => unknown>> = {};
	const _commands: Record<string, (args: string, ctx: unknown) => Promise<void>> = {};
	const _shortcuts: Array<(ctx: unknown) => Promise<void>> = [];

	const pi = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			_handlers[event] = [...(_handlers[event] ?? []), handler];
		},
		registerCommand: (
			name: string,
			def: { handler: (args: string, ctx: unknown) => Promise<void> },
		) => {
			_commands[name] = def.handler;
		},
		registerFlag: () => {},
		registerShortcut: (_key: unknown, def: { handler: (ctx: unknown) => Promise<void> }) => {
			_shortcuts.push(def.handler);
		},
		getFlag: () => undefined,
		getThinkingLevel: () => 'off',
		setThinkingLevel: () => {},
		getActiveTools: () => ['read', 'bash'],
		setActiveTools: () => {},
		getAllTools: () => [
			{ name: 'read' },
			{ name: 'bash' },
			{ name: 'edit' },
			{ name: 'write' },
		],
		appendEntry: () => {},
		setModel: async () => true,
		_handlers,
		_commands,
		_shortcuts,
	};

	// 挂 mock __labApi（弱依赖桥），收集 record 调用
	(globalThis as Record<string, unknown>).__labApi = {
		getExperimentManager: () => ({
			registerWeakExperiment: () => ({
				select: async () => 'test',
				record: async (armId: string, outcome: { metrics: Record<string, number> }) => {
					records.push({ armId, metrics: outcome.metrics });
				},
				info: () => ({ name: 'preset-usage', strategy: 'stable-hash', forceArmId: null }),
			}),
		}),
	};

	return pi as unknown as FakePi;
}

const fakeCtx = {
	cwd: () => tmpCwd,
	model: { provider: 'mock', id: 'm1' },
	modelRegistry: { find: () => undefined },
	ui: {
		notify: () => {},
		setStatus: () => {},
		theme: { fg: () => 'status' },
		custom: async () => '(none)',
	},
	sessionManager: { getEntries: () => [] },
};

async function fireEvent(pi: FakePi, event: string, e: unknown, ctx: unknown): Promise<void> {
	for (const handler of pi._handlers[event] ?? []) {
		await handler(e, ctx);
	}
}

describe('preset-usage 实验（record 型）', () => {
	let records: Recorded[];
	let pi: FakePi;

	beforeEach(() => {
		records = [];
		setupDirs();
		pi = makeFakePi(records);
		presetExtension(pi as never);
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
	});

	afterEach(() => {
		vi.useRealTimers();
		delete (globalThis as Record<string, unknown>).__labApi;
		cleanupDirs();
	});

	it('session_start 注册 /preset 命令与面板快捷键（臂 = 配置中的 preset 名）', async () => {
		const ctx = { ...fakeCtx, cwd: tmpCwd };
		await fireEvent(pi, 'session_start', null, ctx);

		expect(pi._commands['preset']).toBeTypeOf('function');
		expect(pi._shortcuts).toHaveLength(1);
	});

	it('切换 preset 时结算上一臂时长，session_shutdown 结算当前臂（test→plan）', async () => {
		const ctx = { ...fakeCtx, cwd: tmpCwd };
		await fireEvent(pi, 'session_start', null, ctx);
		const cmd = pi._commands['preset'];

		// 应用 preset test → 开始计时
		await cmd('test', ctx);
		vi.setSystemTime(new Date('2026-01-01T00:00:03Z')); // test 停留 3s

		// 切换到 plan → 先结算 test 臂，再开始 plan 计时
		await cmd('plan', ctx);
		expect(records).toHaveLength(1);
		expect(records[0]).toEqual({ armId: 'test', metrics: { use_duration_ms: 3000 } });

		vi.setSystemTime(new Date('2026-01-01T00:00:08Z')); // plan 停留 5s
		await fireEvent(pi, 'session_shutdown', null, ctx);

		expect(records).toHaveLength(2);
		expect(records[1]).toEqual({ armId: 'plan', metrics: { use_duration_ms: 5000 } });
	});

	it('清除预设（面板选 (none)）时结算当前臂并离开', async () => {
		const ctx = { ...fakeCtx, cwd: tmpCwd };
		await fireEvent(pi, 'session_start', null, ctx);
		const cmd = pi._commands['preset'];

		await cmd('test', ctx);
		vi.setSystemTime(new Date('2026-01-01T00:00:02Z'));
		// 面板快捷键 → custom 返回 (none)（清除）
		await pi._shortcuts[0](ctx);

		expect(records).toHaveLength(1);
		expect(records[0].armId).toBe('test');
		expect(records[0].metrics.use_duration_ms).toBe(2000);

		// 已离开臂：session_shutdown 不再产生 record
		await fireEvent(pi, 'session_shutdown', null, ctx);
		expect(records).toHaveLength(1);
	});

	it('无 config.json 时生成默认全局 preset（plan/implement/raw）', async () => {
		// 删除项目级 config.json（用户级本就不存在），无任何来源的 preset
		rmSync(resolve(tmpCwd, '.pi', 'extensions-data', 'preset', 'config.json'), {
			force: true,
		});
		const ctx = { ...fakeCtx, cwd: tmpCwd };
		await fireEvent(pi, 'session_start', null, ctx);

		// 用户级 config.json 应被自动生成，含三个内置默认 preset
		const userCfg = JSON.parse(
			readFileSync(
				resolve(tmpHome, '.pi', 'agent', 'extensions-data', 'preset', 'config.json'),
				'utf8',
			),
		);
		expect(Object.keys(userCfg).sort()).toEqual(['implement', 'plan', 'raw']);

		// /preset plan 能激活默认 plan（产生 record）
		const cmd = pi._commands['preset'];
		await cmd('plan', ctx);
		await fireEvent(pi, 'session_shutdown', null, ctx);
		expect(records).toHaveLength(1);
		expect(records[0].armId).toBe('plan');
	});

	it('用户级 config.json 已存在 → ensureDefaultPresets 不覆盖、不合并', async () => {
		// 预写用户级 config.json（仅含自定义 preset，与默认 plan/implement/raw 无关）
		const userCfgPath = resolve(
			tmpHome,
			'.pi',
			'agent',
			'extensions-data',
			'preset',
			'config.json',
		);
		mkdirSync(resolve(tmpHome, '.pi', 'agent', 'extensions-data', 'preset'), {
			recursive: true,
		});
		writeFileSync(userCfgPath, JSON.stringify({ custom: { thinkingLevel: 'low' } }), 'utf8');

		const ctx = { ...fakeCtx, cwd: tmpCwd };
		await fireEvent(pi, 'session_start', null, ctx);

		// 用户级 config.json 内容保持不变：不注入默认 preset，也不合并
		const userCfg = JSON.parse(readFileSync(userCfgPath, 'utf8'));
		expect(userCfg).toEqual({ custom: { thinkingLevel: 'low' } });
		expect(Object.keys(userCfg)).toEqual(['custom']);
	});

	it('DEFAULT_PRESETS 三个内置默认 preset 字段正确', () => {
		// plan：调研规划，不修改代码
		expect(DEFAULT_PRESETS.plan).toMatchObject({
			provider: 'cli-proxy-api',
			model: 'deepseek-v4-pro',
			thinkingLevel: 'high',
			tools: ['read', 'grep', 'find', 'ls'],
		});
		expect(DEFAULT_PRESETS.plan.instructions).toContain('不修改任何代码');

		// implement：TDD + 端到端 + UAT
		expect(DEFAULT_PRESETS.implement).toMatchObject({
			provider: 'cli-proxy-api',
			model: 'deepseek-v4-pro',
			thinkingLevel: 'medium',
		});
		expect(DEFAULT_PRESETS.implement.instructions).toContain('UAT');
		expect(DEFAULT_PRESETS.implement.tools).toBeUndefined();
		expect(DEFAULT_PRESETS.implement.skills).toBeUndefined();

		// raw：默认工具集 + 禁技能 + 不填 model/thinkingLevel
		expect(DEFAULT_PRESETS.raw).toMatchObject({
			tools: ['read', 'bash', 'powershell', 'edit', 'write', 'grep', 'find', 'ls'],
			skills: [],
		});
		expect(DEFAULT_PRESETS.raw.provider).toBeUndefined();
		expect(DEFAULT_PRESETS.raw.model).toBeUndefined();
		expect(DEFAULT_PRESETS.raw.thinkingLevel).toBeUndefined();
	});

	it('skills 偏离时状态栏显示「已偏离:skills」', async () => {
		const setStatus = vi.fn();
		const ctx = {
			...fakeCtx,
			cwd: tmpCwd,
			ui: {
				...fakeCtx.ui,
				setStatus,
				theme: { ...fakeCtx.ui.theme, fg: (_c: string, t: string) => t },
			},
		};
		await fireEvent(pi, 'session_start', null, ctx);
		// raw preset：skills=[]（全部禁止）。mock 当前有 skill 启用 → 偏离
		(globalThis as Record<string, unknown>).__skillsApi = {
			getEnabledSkills: () => ['grilling'],
		};
		await pi._commands['preset']('raw', ctx);
		// turn_start 触发 updateStatus（检测偏离 + 刷新状态栏）
		await fireEvent(pi, 'turn_start', null, ctx);
		const driftCall = setStatus.mock.calls.find(
			(c: unknown[]) =>
				c[0] === 'preset' && typeof c[1] === 'string' && c[1].includes('已偏离'),
		);
		expect(driftCall).toBeDefined();
		expect(driftCall![1]).toContain('skills');
		delete (globalThis as Record<string, unknown>).__skillsApi;
	});

	it('instructions 偏离时状态栏显示「已偏离:instructions」', async () => {
		const setStatus = vi.fn();
		const ctx = {
			...fakeCtx,
			cwd: tmpCwd,
			ui: {
				...fakeCtx.ui,
				setStatus,
				theme: { ...fakeCtx.ui.theme, fg: (_c: string, t: string) => t },
			},
		};
		// 删除项目级 config，让 plan 从用户级默认（DEFAULT_PRESETS.plan 含 instructions）resolve
		rmSync(resolve(tmpCwd, '.pi', 'extensions-data', 'preset', 'config.json'), {
			force: true,
		});
		await fireEvent(pi, 'session_start', null, ctx);
		// plan 默认 preset 有 instructions；mock prompt-editor 覆盖（禁用）→ 偏离
		(globalThis as Record<string, unknown>).__promptEditorApi = {
			getOverride: (key: string) =>
				key === 'preset_instructions:preset' ? { enabled: false } : undefined,
		};
		await pi._commands['preset']('plan', ctx);
		await fireEvent(pi, 'turn_start', null, ctx);
		const driftCall = setStatus.mock.calls.find(
			(c: unknown[]) =>
				c[0] === 'preset' && typeof c[1] === 'string' && c[1].includes('已偏离'),
		);
		expect(driftCall).toBeDefined();
		expect(driftCall![1]).toContain('instructions');
		delete (globalThis as Record<string, unknown>).__promptEditorApi;
	});

	it('mergeScopedPresets 三级合并 + 同名 shadow（session > project > user）', () => {
		const user = {
			plan: { thinkingLevel: 'high' as const },
			shared: { thinkingLevel: 'low' as const },
		};
		const project = {
			plan: { thinkingLevel: 'medium' as const },
			proj: { thinkingLevel: 'off' as const },
		};
		const session = new Map([['shared', { thinkingLevel: 'xhigh' as const }]]);

		const merged = mergeScopedPresets(user, project, session);
		const byName = Object.fromEntries(merged.map((m) => [m.name, m]));

		// 同名 shadow：project 的 plan 覆盖 user 的 plan
		expect(byName.plan.scope).toBe('project');
		expect(byName.plan.preset.thinkingLevel).toBe('medium');
		// session 的 shared 覆盖 user 的 shared
		expect(byName.shared.scope).toBe('session');
		expect(byName.shared.preset.thinkingLevel).toBe('xhigh');
		// 仅项目级存在的 proj
		expect(byName.proj.scope).toBe('project');
		// 三个来源都合并进来
		expect(merged).toHaveLength(3);
	});

	it('nextCopyName 复制副本名：原名-复制，重名递增 -复制2', () => {
		expect(nextCopyName('plan', () => false)).toBe('plan-复制');
		expect(nextCopyName('plan', (n) => n === 'plan-复制')).toBe('plan-复制2');
		expect(nextCopyName('plan', (n) => ['plan-复制', 'plan-复制2'].includes(n))).toBe(
			'plan-复制3',
		);
	});

	it('persistPresetToProject 写入项目级 config.json 并保留其他 preset', () => {
		// setupDirs 已写项目级 config.json（test/plan）
		const updated = persistPresetToProject(tmpCwd, 'debug', { thinkingLevel: 'off' });
		expect(updated.debug.thinkingLevel).toBe('off');
		expect(updated.test).toBeDefined();
		expect(updated.plan).toBeDefined();

		const raw = readFileSync(
			resolve(tmpCwd, '.pi', 'extensions-data', 'preset', 'config.json'),
			'utf8',
		);
		const parsed = JSON.parse(raw) as Record<string, { thinkingLevel?: string }>;
		expect(parsed.debug.thinkingLevel).toBe('off');
		expect(parsed.test).toBeDefined();
		expect(parsed.plan).toBeDefined();
	});
});
