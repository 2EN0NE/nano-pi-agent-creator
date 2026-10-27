/**
 * 远端豁免 — 与两个 guard 的集成（ADR-0068 D5/D7）
 *
 * 断言「armed 时程序化发起的会话切换不再弹框、且放行」，以及反向「未 armed 时仍弹框」。
 * 走真实的 `confirm-destructive` / `dirty-repo-guard` 事件处理器，只伪造 pi API 与 ctx。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

type AnyFn = (...args: unknown[]) => unknown;

const GUARD_MODULES = {
	'confirm-destructive': () => import('../../../extensions/security/confirm-destructive'),
	'dirty-repo-guard': () => import('../../../extensions/security/dirty-repo-guard'),
} as const;

function makeFakePi(opts: { flags?: Record<string, unknown>; gitStdout?: string } = {}) {
	const handlers = new Map<string, AnyFn[]>();
	const flags = opts.flags ?? {};
	const pi = {
		registerFlag(name: unknown, o: unknown) {
			flags[name as string] ??= (o as { default?: unknown }).default;
		},
		getFlag(name: unknown) {
			return flags[name as string];
		},
		registerCommand() {},
		registerTool() {},
		on(event: unknown, handler: unknown) {
			const list = handlers.get(event as string) ?? [];
			list.push(handler as AnyFn);
			handlers.set(event as string, list);
			return () => {};
		},
		exec: async () => ({ stdout: opts.gitStdout ?? '', stderr: '', code: 0 }),
	};
	return { pi, handlers, flags };
}

function makeCtx() {
	const custom = vi.fn().mockResolvedValue(null);
	const notify = vi.fn();
	const ctx = {
		hasUI: true,
		cwd: '/tmp/project',
		ui: { custom, notify, setStatus: vi.fn() },
		sessionManager: { getEntries: () => [] },
	};
	return { ctx, custom, notify };
}

/** 重新加载「selector 包 + 目标 guard」，保证两者共享同一个闸门状态实例 */
async function load(guard: 'confirm-destructive' | 'dirty-repo-guard', licensed: boolean) {
	vi.resetModules();
	const { pi, handlers, flags } = makeFakePi({ gitStdout: ' M a.ts\n M b.ts\n' });
	const selector = await import('@zenone/pi-selector');
	selector.initUnattended(pi as never);
	flags['unattended-confirm'] = licensed;
	const { ctx } = makeCtx();
	const start = handlers.get('session_start')?.[0];
	await start?.({ type: 'session_start', reason: 'startup' }, ctx);

	const guardHandlers = new Map<string, AnyFn[]>();
	const guardPi = {
		...pi,
		on(event: unknown, handler: unknown) {
			const list = guardHandlers.get(event as string) ?? [];
			list.push(handler as AnyFn);
			guardHandlers.set(event as string, list);
			return () => {};
		},
	};
	const mod = await GUARD_MODULES[guard]();
	(mod.default as AnyFn)(guardPi);
	return { selector, guardHandlers };
}

beforeEach(() => {
	// 闸门状态挂在 globalThis（跨模块实例共享），resetModules 清不掉，需显式清
	delete (globalThis as Record<string, unknown>).__piUnattendedState;
	vi.resetModules();
});

describe('confirm-destructive — /new 不再阻断', () => {
	it('armed：不弹框、放行（返回 undefined）', async () => {
		const { selector, guardHandlers } = await load('confirm-destructive', true);
		selector.arm('wechat');
		const { ctx, custom } = makeCtx();
		const handler = guardHandlers.get('session_before_switch')?.[0];
		const r = await handler?.({ type: 'session_before_switch', reason: 'new' }, ctx);
		expect(custom).not.toHaveBeenCalled();
		expect(r).toBeUndefined();
	});

	it('未 arm：仍弹框', async () => {
		const { guardHandlers } = await load('confirm-destructive', true);
		const { ctx, custom } = makeCtx();
		const handler = guardHandlers.get('session_before_switch')?.[0];
		await handler?.({ type: 'session_before_switch', reason: 'new' }, ctx);
		expect(custom).toHaveBeenCalledTimes(1);
	});
});

describe('dirty-repo-guard — 脏仓库不再阻断', () => {
	it('armed：不弹框、放行（返回 undefined）', async () => {
		const { selector, guardHandlers } = await load('dirty-repo-guard', true);
		selector.arm('wechat');
		const { ctx, custom } = makeCtx();
		const handler = guardHandlers.get('session_before_switch')?.[0];
		const r = await handler?.({ type: 'session_before_switch', reason: 'new' }, ctx);
		expect(custom).not.toHaveBeenCalled();
		expect(r).toBeUndefined();
	});

	it('未 arm：脏仓库仍弹框', async () => {
		const { guardHandlers } = await load('dirty-repo-guard', true);
		const { ctx, custom } = makeCtx();
		const handler = guardHandlers.get('session_before_switch')?.[0];
		await handler?.({ type: 'session_before_switch', reason: 'new' }, ctx);
		expect(custom).toHaveBeenCalledTimes(1);
	});
});
