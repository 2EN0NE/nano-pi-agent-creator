/**
 * selector — `/unattended` 命令接线（ADR-0068 D8 约束 2）
 *
 * 判据是 `ctx.mode === 'tui'`，不是 `ctx.hasUI`：RPC 下 hasUI 为 true 但
 * `ctx.ui.custom` 是空实现。非 TUI 一律退化为多行文本，首行保留旧单行格式。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

type AnyFn = (...args: unknown[]) => unknown;

function makeFakePi(flags: Record<string, unknown>) {
	const commands = new Map<string, AnyFn>();
	const handlers = new Map<string, AnyFn[]>();
	const pi = {
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
	return { pi, commands, handlers };
}

function makeCtx(mode: string) {
	const custom = vi.fn(async (..._args: unknown[]) => undefined);
	const notify = vi.fn();
	const ctx = {
		hasUI: true,
		mode,
		cwd: '/tmp/project',
		ui: { custom, notify, setStatus: vi.fn() },
	};
	return { ctx: ctx as never, custom, notify };
}

async function fresh(licensed: boolean, mode: string) {
	vi.resetModules();
	const mod = await import('../../../extensions/meta/selector/unattended');
	const flags: Record<string, unknown> = {};
	const { pi, commands } = makeFakePi(flags);
	mod.initUnattended(pi as never);
	flags['unattended-confirm'] = licensed;
	const { ctx, custom, notify } = makeCtx(mode);
	return { mod, commands, ctx, custom, notify };
}

beforeEach(() => {
	delete (globalThis as Record<string, unknown>).__piUnattendedState;
	delete (globalThis as Record<string, unknown>).__confirmGateApi;
	vi.resetModules();
});

describe('/unattended — mode 判据与回退', () => {
	it('tui + 无参：打开面板（custom），不发 notify 文本', async () => {
		const { commands, ctx, custom, notify } = await fresh(true, 'tui');
		await commands.get('unattended')?.('', ctx);
		expect(custom).toHaveBeenCalledOnce();
		// 回归锁：必须是主视图（不传 overlay），与 pi-session-tree 一致。
		// 浮窗（overlay:true）不符合本仓库「优先下半部分主视图」的规范。
		const options = custom.mock.calls[0][1] as { overlay?: boolean } | undefined;
		expect(options?.overlay ?? false).toBe(false);
		expect(notify).not.toHaveBeenCalled();
	});

	it('rpc + 无参：不开 custom（它是空实现），改发多行文本', async () => {
		const { commands, ctx, custom, notify } = await fresh(true, 'rpc');
		await commands.get('unattended')?.('', ctx);
		expect(custom).not.toHaveBeenCalled();
		const text = notify.mock.calls[0][0] as string;
		expect(text.split('\n')[0]).toBe('远端豁免：licensed-idle（license=true，owners=(none)）');
		expect(text).toContain('硬拦截');
	});

	it('print + 无参：同样是多行文本', async () => {
		const { commands, ctx, custom, notify } = await fresh(false, 'print');
		await commands.get('unattended')?.('', ctx);
		expect(custom).not.toHaveBeenCalled();
		const text = notify.mock.calls[0][0] as string;
		expect(text.split('\n')[0]).toBe('远端豁免：off（license=false，owners=(none)）');
		expect(text).toContain('--unattended-confirm');
	});

	it('tui + status：单行 + 提示开面板', async () => {
		const { commands, ctx, notify } = await fresh(true, 'tui');
		await commands.get('unattended')?.('status', ctx);
		const text = notify.mock.calls[0][0] as string;
		expect(text).toContain('远端豁免：licensed-idle');
		expect(text).toContain('/unattended');
		expect(text.split('\n').length).toBe(1);
	});

	it('rpc + status：与无参一致的详细文本（远端唯一能读到的形式）', async () => {
		const { commands, ctx, notify } = await fresh(true, 'rpc');
		await commands.get('unattended')?.('status', ctx);
		const text = notify.mock.calls[0][0] as string;
		expect(text.split('\n').length).toBeGreaterThan(3);
		expect(text).toContain('硬拦截');
	});
});
