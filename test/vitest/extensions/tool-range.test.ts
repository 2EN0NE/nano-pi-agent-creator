/**
 * tools.ts — tool-range 实验分流（assignToolRangeArm）skip 路径测试
 *
 * 覆盖报告缺口：hasUserToolConfig（已有 tools-config entry）/ --preset flag /
 * select 抛异常 三类「跳过实验分流」分支，以及无用户配置时的 core/full 分流。
 * 通过 fake pi 驱动 session_start 事件（不 mock pi-lab 之外的任何 Pi API），
 * 断言 setActiveTools 被调用的工具集与 labSelect 是否被调用。
 *
 * 已知限制：用户在 /tools 面板启用实验禁用工具 → 退出实验注入的 override 路径
 * 深藏在 ctx.ui.custom 的 SettingsList onChange 回调中，单元测试无法无 TUI 驱动，
 * 由 e2e（test/e2e/extensions/tools/smoke.test.sh 场景 7）覆盖。
 */
import { describe, it, expect, afterEach } from 'vitest';
import toolsExtension from '../../../extensions/meta/preset/tools.js';

const ALL_TOOLS = ['read', 'bash', 'edit', 'write', 'rg', 'ffgrep', 'fffind', 'grep', 'find', 'ls'];

interface FakePi {
	on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
	registerCommand(): void;
	getAllTools(): Array<{ name: string }>;
	getActiveTools(): string[];
	setActiveTools(names: string[]): void;
	appendEntry(): void;
	getFlag(name: string): string | undefined;
	_handlers: Record<string, Array<(event: unknown, ctx: unknown) => unknown>>;
	_setActiveCalls: string[][];
	_selectCalls: number;
}

function makeFakePi(opts: {
	selectArm?: string;
	selectThrows?: boolean;
	presetFlag?: string;
	entries?: Array<{ type: string; customType: string; data?: unknown }>;
	activeTools?: string[];
}): FakePi {
	const _handlers: Record<string, Array<(event: unknown, ctx: unknown) => unknown>> = {};
	const _setActiveCalls: string[][] = [];
	let _selectCalls = 0;

	(globalThis as Record<string, unknown>).__labApi = {
		getExperimentManager: () => ({
			registerWeakExperiment: () => ({
				select: async () => {
					_selectCalls += 1;
					if (opts.selectThrows) throw new Error('select boom');
					return opts.selectArm ?? 'core';
				},
				record: async () => {},
				info: () => ({ name: 'tool-range', strategy: 'stable-hash', forceArmId: null }),
			}),
		}),
	};

	const pi = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			_handlers[event] = [...(_handlers[event] ?? []), handler];
		},
		registerCommand: () => {},
		getAllTools: () => ALL_TOOLS.map((name) => ({ name })),
		getActiveTools: () => opts.activeTools ?? [],
		setActiveTools: (names: string[]) => {
			_setActiveCalls.push(names);
		},
		appendEntry: () => {},
		getFlag: (name: string) => (name === 'preset' ? opts.presetFlag : undefined),
		_handlers,
		_setActiveCalls,
		_selectCalls: () => _selectCalls,
	} as unknown as FakePi;

	return pi;
}

const BASE_CTX = {
	mode: 'print',
	hasUI: false,
	model: { provider: 'deepseek', id: 'deepseek-v4-pro' },
	ui: { notify: () => {} },
	sessionManager: { getSessionId: () => 'sess-1', getEntries: () => [] as Array<unknown> },
};

async function fireSessionStart(pi: FakePi, ctx: unknown): Promise<void> {
	for (const handler of pi._handlers['session_start'] ?? []) {
		await handler(null, ctx);
	}
}

afterEach(() => {
	delete (globalThis as Record<string, unknown>).__labApi;
	delete (globalThis as Record<string, unknown>).__toolsApi;
});

describe('tool-range 实验分流', () => {
	it('无用户配置 + select=core → 分流到 7 个 core 工具（其余禁用）', async () => {
		const pi = makeFakePi({ selectArm: 'core' });
		toolsExtension(pi as never);
		await fireSessionStart(pi, BASE_CTX);

		// select 被调用一次；实验分流 applyTools 是最后一次 setActiveTools
		expect((pi as unknown as { _selectCalls: () => number })._selectCalls()).toBe(1);
		const last = pi._setActiveCalls[pi._setActiveCalls.length - 1];
		expect(last).toEqual(['read', 'bash', 'edit', 'write', 'rg', 'ffgrep', 'fffind']);
	});

	it('无用户配置 + select=full → 全工具启用零禁用', async () => {
		const pi = makeFakePi({ selectArm: 'full' });
		toolsExtension(pi as never);
		await fireSessionStart(pi, BASE_CTX);

		const last = pi._setActiveCalls[pi._setActiveCalls.length - 1];
		expect(last).toEqual(ALL_TOOLS);
	});

	it('已有 tools-config entry → 跳过实验分流（select 不被调用）', async () => {
		const pi = makeFakePi({
			selectArm: 'core',
			entries: [
				{
					type: 'custom',
					customType: 'tools-config',
					data: { enabledTools: ['read', 'bash'] },
				},
			],
		});
		toolsExtension(pi as never);
		const ctx = {
			...BASE_CTX,
			sessionManager: {
				getSessionId: () => 'sess-1',
				getEntries: () => [
					{
						type: 'custom',
						customType: 'tools-config',
						data: { enabledTools: ['read', 'bash'] },
					},
				],
			},
		};
		await fireSessionStart(pi, ctx);

		expect((pi as unknown as { _selectCalls: () => number })._selectCalls()).toBe(0);
		// restoreFromBranch 会恢复 savedEnabled（唯一一次 setActiveTools），实验不追加
		expect(pi._setActiveCalls).toHaveLength(1);
		expect(pi._setActiveCalls[0]).toEqual(['read', 'bash']);
	});

	it('--preset flag 存在 → 跳过实验分流（select 不被调用，不 applyTools）', async () => {
		const pi = makeFakePi({ selectArm: 'core', presetFlag: 'test' });
		toolsExtension(pi as never);
		await fireSessionStart(pi, BASE_CTX);

		expect((pi as unknown as { _selectCalls: () => number })._selectCalls()).toBe(0);
		// 无 savedEnabled 且 getActiveTools 为空 → restore/reapply 均不 applyTools
		expect(pi._setActiveCalls).toHaveLength(0);
	});

	it('select 抛异常 → 跳过实验分流且不崩溃', async () => {
		const pi = makeFakePi({ selectThrows: true });
		toolsExtension(pi as never);
		await fireSessionStart(pi, BASE_CTX);

		expect((pi as unknown as { _selectCalls: () => number })._selectCalls()).toBe(1);
		expect(pi._setActiveCalls).toHaveLength(0);
	});
});
