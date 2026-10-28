/**
 * selector — 豁免运维面的文案层（ADR-0068 D8）
 *
 * 覆盖 D8 里「文案单一来源」与「中文映射」两条：面板信息栏、确认页、非 TUI 多行文本
 * 共用同一份常量；owner id 是仲裁键，展示名只作用于界面。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

type AnyFn = (...args: unknown[]) => unknown;

function makeFakePi(flags: Record<string, unknown>) {
	const handlers = new Map<string, AnyFn[]>();
	const pi = {
		registerFlag(name: unknown, opts: unknown) {
			const o = opts as { default?: unknown };
			flags[name as string] ??= o.default;
		},
		getFlag(name: unknown) {
			return flags[name as string];
		},
		registerCommand: () => {},
		on(event: unknown, handler: unknown) {
			const list = handlers.get(event as string) ?? [];
			list.push(handler as AnyFn);
			handlers.set(event as string, list);
			return () => {};
		},
	};
	return { pi, handlers };
}

async function freshModule(licensed: boolean) {
	vi.resetModules();
	const mod = await import('../../../extensions/meta/selector/unattended');
	const flags: Record<string, unknown> = {};
	const { pi } = makeFakePi(flags);
	mod.initUnattended(pi as never);
	flags['unattended-confirm'] = licensed;
	return { mod };
}

beforeEach(() => {
	delete (globalThis as Record<string, unknown>).__piUnattendedState;
	delete (globalThis as Record<string, unknown>).__confirmGateApi;
	vi.resetModules();
});

describe('ownerLabel — 占用者显示名', () => {
	it('内置映射：manual 与 e2e-channel 有中文名', async () => {
		const { mod } = await freshModule(true);
		expect(mod.ownerLabel('manual')).toBe('本机手动');
		expect(mod.ownerLabel('e2e-channel')).toBe('测试通道');
	});

	it('显式 label 覆盖内置映射', async () => {
		const { mod } = await freshModule(true);
		mod.arm('manual', { label: '微信桥' });
		expect(mod.ownerLabel('manual')).toBe('微信桥');
	});

	it('未登记原样显示并括注，不隐藏', async () => {
		const { mod } = await freshModule(true);
		expect(mod.ownerLabel('some-bridge')).toBe('some-bridge（未登记）');
	});

	it('arm() 不带第二参数时行为与旧版一致（返回函数 + 计数）', async () => {
		const { mod } = await freshModule(true);
		const d1 = mod.arm('wechat');
		const d2 = mod.arm('wechat');
		expect(d1).toBeTypeOf('function');
		d1?.();
		expect(mod.isArmed()).toBe(true);
		d2?.();
		expect(mod.isArmed()).toBe(false);
		expect(mod.ownerLabel('wechat')).toBe('wechat（未登记）');
	});
});

describe('statusHeadline / statusDetailLines — 非 TUI 文本', () => {
	it('首行与旧版单行格式逐字一致（外部 grep 不破）', async () => {
		const { mod } = await freshModule(true);
		mod.arm('wechat');
		const s = mod.unattendedStatus();
		expect(mod.statusHeadline(s)).toBe('远端豁免：armed（license=true，owners=wechat）');
		expect(mod.statusHeadline({ ...s, owners: [], mode: 'licensed-idle' })).toBe(
			'远端豁免：licensed-idle（license=true，owners=(none)）',
		);
	});

	it('追加行覆盖影响面三个事实：不弹哪些、硬拦截、生命周期', async () => {
		const { mod } = await freshModule(true);
		mod.arm('wechat');
		const lines = mod.statusDetailLines(mod.unattendedStatus()).join('\n');
		expect(lines).toContain('硬拦截');
		expect(lines).toMatch(/\/reload/);
		expect(lines).toContain('unattended_');
	});
});

describe('UNATTENDED_ACTIONS — 面板与文本共用的动作说明', () => {
	it('三项标签齐全', async () => {
		const { mod } = await freshModule(true);
		expect(mod.UNATTENDED_ACTIONS.disarm.label).toBe('解除豁免');
		expect(mod.UNATTENDED_ACTIONS.scope.label).toBe('影响与边界');
		expect(mod.UNATTENDED_ACTIONS.close.label).toBe('关闭');
	});

	it('解除说明写明「全部占用」与「通道会重新生效」', async () => {
		const { mod } = await freshModule(true);
		const text = mod.UNATTENDED_ACTIONS.disarm.lines.join('');
		expect(text).toContain('全部占用');
		expect(text).toContain('重新生效');
	});
});
