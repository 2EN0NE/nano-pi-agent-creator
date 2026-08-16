import { describe, it, expect, vi } from 'vitest';
import { ShortcutRegistry } from '../../../extensions/meta/pi-shortcuts/core/registry.ts';
import { ShortcutDispatcher } from '../../../extensions/meta/pi-shortcuts/core/dispatcher.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('ShortcutDispatcher — 子键分发状态机', () => {
	it('activate 后进入监听', () => {
		const reg = new ShortcutRegistry();
		reg.register({ name: 'files', keys: ['f'], description: '文件', handler: () => {} });
		const d = new ShortcutDispatcher({ registry: reg });
		d.activate();
		expect(d.isActive()).toBe(true);
	});

	it('精确匹配执行 handler 并退出', () => {
		const handler = vi.fn();
		const reg = new ShortcutRegistry();
		reg.register({ name: 'files', keys: ['f'], description: '文件', handler });
		const d = new ShortcutDispatcher({ registry: reg });
		d.activate();
		d.handleKey('f');
		expect(handler).toHaveBeenCalledTimes(1);
		expect(d.isActive()).toBe(false);
	});

	it('前缀匹配继续等待，第二键精确匹配', () => {
		const handler = vi.fn();
		const reg = new ShortcutRegistry();
		reg.register({ name: 'files', keys: ['f', 'o'], description: '打开', handler });
		const d = new ShortcutDispatcher({ registry: reg });
		d.activate();
		d.handleKey('f');
		expect(d.isActive()).toBe(true); // 还有子键未按，继续等待
		d.handleKey('o');
		expect(handler).toHaveBeenCalledTimes(1);
		expect(d.isActive()).toBe(false);
	});

	it('Esc 取消退出', () => {
		const reg = new ShortcutRegistry();
		reg.register({ name: 'files', keys: ['f'], description: '文件', handler: () => {} });
		const d = new ShortcutDispatcher({ registry: reg });
		d.activate();
		d.handleKey('escape');
		expect(d.isActive()).toBe(false);
	});

	it('无匹配退出', () => {
		const reg = new ShortcutRegistry();
		reg.register({ name: 'files', keys: ['f'], description: '文件', handler: () => {} });
		const d = new ShortcutDispatcher({ registry: reg });
		d.activate();
		d.handleKey('x');
		expect(d.isActive()).toBe(false);
	});

	it('超时退出', async () => {
		const reg = new ShortcutRegistry();
		reg.register({ name: 'files', keys: ['f'], description: '文件', handler: () => {} });
		const d = new ShortcutDispatcher({ registry: reg, timeoutMs: 10 });
		d.activate();
		await sleep(30);
		expect(d.isActive()).toBe(false);
	});

	it('非 active 时 handleKey 忽略', () => {
		const handler = vi.fn();
		const reg = new ShortcutRegistry();
		reg.register({ name: 'files', keys: ['f'], description: '文件', handler });
		const d = new ShortcutDispatcher({ registry: reg });
		d.handleKey('f'); // 未 activate
		expect(handler).not.toHaveBeenCalled();
		expect(d.isActive()).toBe(false);
	});
});
