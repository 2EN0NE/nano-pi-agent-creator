/**
 * selector — 远端豁免闸门（ADR-0068）
 *
 * 覆盖：三态、arm/disarm 引用计数、`isAttended`、以及 `showSelect`/`showConfirm`
 * 在 armed 下的跳过语义（不弹框 / 采用声明式默认 / 未声明则取消）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

type AnyFn = (...args: unknown[]) => unknown;

interface FakePi {
	registerFlag: AnyFn;
	getFlag: AnyFn;
	registerCommand: AnyFn;
	on: AnyFn;
}

function makeFakePi(flags: Record<string, unknown>): {
	pi: FakePi;
	handlers: Map<string, AnyFn[]>;
	commands: Map<string, AnyFn>;
} {
	const handlers = new Map<string, AnyFn[]>();
	const commands = new Map<string, AnyFn>();
	const pi: FakePi = {
		registerFlag(name: unknown, opts: unknown) {
			const o = opts as { default?: unknown };
			flags[name as string] ??= o.default;
		},
		getFlag(name: unknown) {
			return flags[name as string];
		},
		registerCommand(name: unknown, def: unknown) {
			commands.set(name as string, (def as { handler: AnyFn }).handler);
		},
		on(event: unknown, handler: unknown) {
			const list = handlers.get(event as string) ?? [];
			list.push(handler as AnyFn);
			handlers.set(event as string, list);
			return () => {};
		},
	};
	return { pi, handlers, commands };
}

function makeCtx() {
	const custom = vi.fn();
	const ctx = {
		hasUI: true,
		cwd: '/tmp/project',
		ui: {
			custom,
			setStatus: vi.fn(),
			notify: vi.fn(),
		},
	};
	return {
		ctx: ctx as unknown as Parameters<
			typeof import('../../../extensions/meta/selector').showSelect
		>[0],
		custom,
	};
}

/** 每个用例重新加载模块，避免模块级状态（license / owners）串味 */
async function freshModule(licensed: boolean) {
	vi.resetModules();
	const mod = await import('../../../extensions/meta/selector/unattended');
	const flags: Record<string, unknown> = {};
	const { pi, handlers, commands } = makeFakePi(flags);
	mod.initUnattended(pi as never);
	flags['unattended-confirm'] = licensed;
	const { ctx } = makeCtx();
	const start = handlers.get('session_start')?.[0];
	await start?.({ type: 'session_start', reason: 'startup' }, ctx);
	return { mod, ctx, commands };
}

beforeEach(() => {
	// 闸门状态挂在 globalThis（跨模块实例共享），resetModules 清不掉，需显式清
	delete (globalThis as Record<string, unknown>).__piUnattendedState;
	delete (globalThis as Record<string, unknown>).__confirmGateApi;
	vi.resetModules();
});

describe('unattended — 三态与引用计数', () => {
	it('未带 flag：off，arm 返回 undefined 且不改变状态', async () => {
		const { mod } = await freshModule(false);
		expect(mod.unattendedStatus().mode).toBe('off');
		expect(mod.arm('wechat')).toBeUndefined();
		expect(mod.isArmed()).toBe(false);
	});

	it('带 flag 未 arm：licensed-idle；arm 后 armed；disarm 可回退', async () => {
		const { mod } = await freshModule(true);
		expect(mod.unattendedStatus().mode).toBe('licensed-idle');
		const disarm = mod.arm('wechat');
		expect(disarm).toBeTypeOf('function');
		expect(mod.unattendedStatus()).toMatchObject({
			mode: 'armed',
			armed: true,
			owners: ['wechat'],
		});
		disarm?.();
		expect(mod.unattendedStatus().mode).toBe('licensed-idle');
	});

	it('多个 owner 引用计数：撤一个仍 armed', async () => {
		const { mod } = await freshModule(true);
		const d1 = mod.arm('wechat');
		mod.arm('telegram');
		d1?.();
		expect(mod.isArmed()).toBe(true);
		expect(mod.unattendedStatus().owners).toEqual(['telegram']);
	});

	it('isAttended：armed 时即使 hasUI 也为 false', async () => {
		const { mod } = await freshModule(true);
		expect(mod.isAttended({ hasUI: true })).toBe(true);
		mod.arm('wechat');
		expect(mod.isAttended({ hasUI: true })).toBe(false);
	});

	it('弱桥接在工厂期安装：早于本扩展 session_start 的通道也能读到接口', async () => {
		vi.resetModules();
		const mod = await import('../../../extensions/meta/selector/unattended');
		const flags: Record<string, unknown> = { 'unattended-confirm': true };
		// 只做 initUnattended（= 扩展工厂期），**不**触发 session_start：
		// 通道插件的 session_start 可能更早，此刻桥必须已经可用，否则它按 D4「接口不存在」放弃。
		mod.initUnattended(makeFakePi(flags).pi as never);
		const api = (globalThis as Record<string, unknown>).__confirmGateApi as {
			hasLicense: () => boolean;
			isArmed: () => boolean;
			arm: (owner: string) => (() => void) | undefined;
		};
		expect(api).toBeDefined();
		expect(api.hasLicense()).toBe(true);
		expect(api.isArmed()).toBe(false);
		expect(api.arm('wechat')).toBeTypeOf('function');
		expect(api.isArmed()).toBe(true);
	});

	it('许可在工厂期就绪：无需 session_start 即可 arm（消除加载顺序依赖）', async () => {
		vi.resetModules();
		const mod = await import('../../../extensions/meta/selector/unattended');
		// 模拟 argv 已解析：flag 值在扩展加载前就在 runtime.flagValues 里
		const flags: Record<string, unknown> = { 'unattended-confirm': true };
		mod.initUnattended(makeFakePi(flags).pi as never);
		expect(mod.hasLicense()).toBe(true);
		expect(mod.arm('wechat')).toBeTypeOf('function');
		expect(mod.isArmed()).toBe(true);
	});

	it('许可在 argv 解析后才可读时，arm() 会回读 flag（不依赖 session_start 顺序）', async () => {
		vi.resetModules();
		const mod = await import('../../../extensions/meta/selector/unattended');
		// 模拟真实时序：扩展加载时 argv 还没解析完 → 工厂期读到的是默认值 false
		const flags: Record<string, unknown> = {};
		mod.initUnattended(makeFakePi(flags).pi as never);
		expect(mod.hasLicense()).toBe(false);

		// argv 解析完成；此时 selector 自己的 session_start 可能还没跑（handler 顺序不定）
		flags['unattended-confirm'] = true;
		expect(mod.arm('wechat')).toBeTypeOf('function');
		expect(mod.isArmed()).toBe(true);
	});

	// 同一 owner 多次 arm（重连而旧连接未及 disarm）：各自有凭据，撤一次不应打回 licensed-idle，
	// 否则先断开的连接会把仍在连接中的通道一起放回「弹框等应答」，远端操作重新挂起。
	it('同一 owner 重复 arm 各自计数：撤一次仍 armed，撤净才退回', async () => {
		const { mod } = await freshModule(true);
		const d1 = mod.arm('wechat');
		const d2 = mod.arm('wechat');
		expect(mod.unattendedStatus()).toMatchObject({ mode: 'armed', owners: ['wechat'] });
		d1?.();
		expect(mod.isArmed()).toBe(true);
		d2?.();
		expect(mod.isArmed()).toBe(false);
		expect(mod.unattendedStatus().mode).toBe('licensed-idle');
	});

	it('arm() 返回的解除函数重复调用是幂等的（不会多扣计数）', async () => {
		const { mod } = await freshModule(true);
		const d1 = mod.arm('wechat');
		mod.arm('wechat');
		d1?.();
		d1?.();
		expect(mod.isArmed()).toBe(true);
	});
});

describe('/unattended disarm — 清掉所有 owner（含通道）', () => {
	it('通道崩溃未 disarm 时，命令仍能恢复确认（不只撤 manual）', async () => {
		const { mod, ctx, commands } = await freshModule(true);
		mod.arm('wechat');
		const handler = commands.get('unattended');
		expect(handler).toBeTypeOf('function');

		await handler?.('disarm', ctx);

		expect(mod.isArmed()).toBe(false);
		expect(mod.unattendedStatus().owners).toEqual([]);
		expect((ctx as unknown as { ui: { notify: AnyFn } }).ui.notify).toHaveBeenCalledWith(
			'远端豁免已解除（wechat）',
			'info',
		);
	});

	it('本来未生效时如实回执，不谎报「已解除」', async () => {
		const { mod, ctx, commands } = await freshModule(true);
		await commands.get('unattended')?.('disarm', ctx);
		expect(mod.isArmed()).toBe(false);
		expect((ctx as unknown as { ui: { notify: AnyFn } }).ui.notify).toHaveBeenCalledWith(
			'远端豁免当前未生效，无需解除',
			'info',
		);
	});
});

describe('showSelect / showConfirm — armed 跳过语义', () => {
	it('未 armed：仍走 ctx.ui.custom', async () => {
		const mod = await import('../../../extensions/meta/selector');
		const { ctx, custom } = makeCtx();
		custom.mockResolvedValue({ value: 'g', label: '绿色' });
		const r = await mod.showSelect(
			ctx,
			'颜色',
			[
				{ value: 'r', label: '红色' },
				{ value: 'g', label: '绿色' },
			],
			{ unattendedDefault: 'r' },
		);
		expect(custom).toHaveBeenCalledTimes(1);
		expect(r).toEqual({ value: 'g', label: '绿色' });
	});

	it('armed + 声明默认：不调用 custom，返回默认值', async () => {
		await freshModule(true);
		const mod = await import('../../../extensions/meta/selector');
		const { ctx, custom } = makeCtx();
		mod.arm('wechat');
		const r = await mod.showSelect(
			ctx,
			'颜色',
			[
				{ value: 'r', label: '红色' },
				{ value: 'g', label: '绿色' },
			],
			{ unattendedDefault: 'r' },
		);
		expect(custom).not.toHaveBeenCalled();
		expect(r).toEqual({ value: 'r', label: '红色' });
	});

	it('armed + 未声明默认：不调用 custom，返回 null（fail-closed）', async () => {
		await freshModule(true);
		const mod = await import('../../../extensions/meta/selector');
		const { ctx, custom } = makeCtx();
		mod.arm('wechat');
		expect(await mod.showSelect(ctx, '颜色', [{ value: 'r', label: '红色' }])).toBeNull();
		expect(custom).not.toHaveBeenCalled();
	});

	it('armed + 默认值不在选项内：按取消处理', async () => {
		await freshModule(true);
		const mod = await import('../../../extensions/meta/selector');
		const { ctx } = makeCtx();
		mod.arm('wechat');
		const r = await mod.showSelect(ctx, '颜色', [{ value: 'r', label: '红色' }], {
			unattendedDefault: 'nope',
		});
		expect(r).toBeNull();
	});

	it('armed 下 showConfirm 采用声明的布尔默认值', async () => {
		await freshModule(true);
		const mod = await import('../../../extensions/meta/selector');
		const { ctx, custom } = makeCtx();
		mod.arm('wechat');
		expect(
			await mod.showConfirm(ctx, '继续？', '', 'default', { unattendedDefault: true }),
		).toBe(true);
		expect(await mod.showConfirm(ctx, '继续？', '')).toBe(false);
		expect(custom).not.toHaveBeenCalled();
	});
});
