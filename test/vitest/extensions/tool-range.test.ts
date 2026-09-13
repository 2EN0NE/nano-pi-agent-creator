/**
 * tools.ts — tool-range 实验分流（assignToolRangeArm）测试
 *
 * ADR-0050 决策 3 / B2：实验**默认只观测、不限制**；仅当用户显式报名
 * （extensions-data/tools/config.json `enableToolRange: true`）后，臂结果才写基础层。
 * 覆盖：未报名（不 select、不限制）/ 已报名 core、full / hasUserToolConfig /
 * --preset flag / select 抛异常 等分支。
 * 通过 fake pi 驱动 session_start 事件（不 mock pi-lab 之外的任何 Pi API）。
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import toolsExtension from '../../../extensions/meta/preset/tools.js';

const ALL_TOOLS = ['read', 'bash', 'edit', 'write', 'rg', 'ffgrep', 'fffind', 'grep', 'find', 'ls'];
const ORIGINAL_HOME = process.env.HOME;
let tmpHome: string;
let tmpCwd: string;

beforeEach(() => {
	tmpHome = resolve(tmpdir(), `tool-range-${randomUUID()}`);
	tmpCwd = resolve(tmpHome, 'cwd');
	mkdirSync(tmpCwd, { recursive: true });
	process.env.HOME = tmpHome;
});

afterEach(() => {
	process.env.HOME = ORIGINAL_HOME;
	try {
		rmSync(tmpHome, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
	delete (globalThis as Record<string, unknown>).__labApi;
	delete (globalThis as Record<string, unknown>).__toolsApi;
});

/** 写入项目级 tools 配置（显式报名实验）。 */
function enroll(): void {
	const dir = resolve(tmpCwd, '.pi', 'extensions-data', 'tools');
	mkdirSync(dir, { recursive: true });
	writeFileSync(resolve(dir, 'config.json'), JSON.stringify({ enableToolRange: true }), 'utf8');
}

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
	_selectCalls: () => number;
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
		getActiveTools: () => opts.activeTools ?? [...ALL_TOOLS],
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

function makeCtx(entries: Array<unknown> = []) {
	return {
		cwd: tmpCwd,
		mode: 'print',
		hasUI: false,
		model: { provider: 'deepseek', id: 'deepseek-v4-pro' },
		ui: { notify: () => {} },
		sessionManager: { getSessionId: () => 'sess-1', getEntries: () => entries },
	};
}

async function fireSessionStart(pi: FakePi, ctx: unknown): Promise<void> {
	for (const handler of pi._handlers['session_start'] ?? []) {
		await handler(null, ctx);
	}
}

describe('tool-range 实验分流（ADR-0050 B2）', () => {
	it('未报名（默认）→ 不 select、不施加限制，活动集 = 基础层', async () => {
		const pi = makeFakePi({ selectArm: 'core' });
		toolsExtension(pi as never);
		await fireSessionStart(pi, makeCtx());

		expect(pi._selectCalls()).toBe(0);
		const last = pi._setActiveCalls[pi._setActiveCalls.length - 1];
		expect(last).toEqual(ALL_TOOLS);
	});

	it('已报名 + select=core → 分流到 7 个 core 工具（其余禁用）', async () => {
		enroll();
		const pi = makeFakePi({ selectArm: 'core' });
		toolsExtension(pi as never);
		await fireSessionStart(pi, makeCtx());

		expect(pi._selectCalls()).toBe(1);
		const last = pi._setActiveCalls[pi._setActiveCalls.length - 1];
		expect(last).toEqual(['read', 'bash', 'edit', 'write', 'rg', 'ffgrep', 'fffind']);
	});

	it('已报名 + select=full → 全工具启用零禁用', async () => {
		enroll();
		const pi = makeFakePi({ selectArm: 'full' });
		toolsExtension(pi as never);
		await fireSessionStart(pi, makeCtx());

		const last = pi._setActiveCalls[pi._setActiveCalls.length - 1];
		expect(last).toEqual(ALL_TOOLS);
	});

	it('已报名 + 已有 tools-config entry → 跳过实验分流（select 不被调用）', async () => {
		enroll();
		const entries = [
			{ type: 'custom', customType: 'tools-config', data: { disabledTools: ['edit'] } },
		];
		const pi = makeFakePi({ selectArm: 'core' });
		toolsExtension(pi as never);
		await fireSessionStart(pi, makeCtx(entries));

		expect(pi._selectCalls()).toBe(0);
		// restoreFromBranch 应用基础层（= 全集 - edit），实验不追加
		const last = pi._setActiveCalls[pi._setActiveCalls.length - 1];
		expect(last).not.toContain('edit');
		expect(last).toContain('read');
	});

	it('已报名 + --preset flag 存在 → 跳过实验分流（select 不被调用）', async () => {
		enroll();
		const pi = makeFakePi({ selectArm: 'core', presetFlag: 'test' });
		toolsExtension(pi as never);
		await fireSessionStart(pi, makeCtx());

		expect(pi._selectCalls()).toBe(0);
	});

	it('已报名 + select 抛异常 → 跳过实验注入且不崩溃', async () => {
		enroll();
		const pi = makeFakePi({ selectThrows: true });
		toolsExtension(pi as never);
		await fireSessionStart(pi, makeCtx());

		expect(pi._selectCalls()).toBe(1);
		const last = pi._setActiveCalls[pi._setActiveCalls.length - 1];
		expect(last).toEqual(ALL_TOOLS);
	});
});
