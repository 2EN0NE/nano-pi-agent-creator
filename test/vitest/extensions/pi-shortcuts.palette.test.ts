import { describe, it, expect, vi } from 'vitest';
import { showPalette } from '../../../extensions/meta/pi-shortcuts/ui/palette.ts';
import { ShortcutRegistry } from '../../../extensions/meta/pi-shortcuts/core/registry.ts';
import { stripAnsi, assertWithinWidth } from '../../../src/tui-testing/index.ts';

function mockTheme(): any {
	return {
		fg: (_color: string, text: string) => text,
		bg: (_c: string, text: string) => text,
		bold: (text: string) => text,
		dim: (text: string) => text,
		getFgAnsi: () => '',
		getBgAnsi: () => '',
		getColorMode: () => 'truecolor' as const,
	};
}

function mountPalette(registry: ShortcutRegistry, prefixKey: string, rows = 24) {
	let component: any = null;
	let doneCalled = false;
	const tui = { requestRender: () => {}, terminal: { rows, columns: 80 } };
	const ctx = {
		mode: 'tui',
		ui: {
			custom: (cb: any) => {
				component = cb(tui, mockTheme(), { matches: () => false }, () => {
					doneCalled = true;
				});
				return Promise.resolve(undefined);
			},
		},
	} as any;
	void showPalette(ctx, registry, prefixKey);
	return {
		component,
		isDone: () => doneCalled,
	};
}

describe('pi-shortcuts palette — headless snapshot', () => {
	it('渲染不超宽（80 列）', () => {
		const reg = new ShortcutRegistry();
		reg.register({ name: 'files', keys: ['f'], description: '文件浏览器', handler: () => {} });
		reg.register({
			name: 'prompt-editor',
			keys: ['p'],
			description: 'Prompt 编辑器',
			handler: () => {},
		});
		const { component } = mountPalette(reg, 'ctrl+shift+space');
		const snapshot = component.render(80).map(stripAnsi);
		assertWithinWidth(snapshot, 80);
		expect(snapshot.join('\n')).toContain('文件浏览器');
		expect(snapshot.join('\n')).toContain('Prompt 编辑器');
	});

	it('窄宽度（40 列）渲染不超宽', () => {
		const reg = new ShortcutRegistry();
		reg.register({
			name: 'files',
			keys: ['f'],
			description: '这是一个很长的说明用来测试窄宽度下的截断行为',
			handler: () => {},
		});
		const { component } = mountPalette(reg, 'ctrl+shift+space');
		const snapshot = component.render(40).map(stripAnsi);
		assertWithinWidth(snapshot, 40);
	});

	it('按子键触发 handler 并关闭', () => {
		const handler = vi.fn();
		const reg = new ShortcutRegistry();
		reg.register({ name: 'files', keys: ['f'], description: '文件浏览器', handler });
		const { component, isDone } = mountPalette(reg, 'ctrl+shift+space');
		component.render(80);
		component.handleInput('f');
		expect(handler).toHaveBeenCalledTimes(1);
		expect(isDone()).toBe(true);
	});

	it('Esc 关闭不触发 handler', () => {
		const handler = vi.fn();
		const reg = new ShortcutRegistry();
		reg.register({ name: 'files', keys: ['f'], description: '文件浏览器', handler });
		const { component, isDone } = mountPalette(reg, 'ctrl+shift+space');
		component.render(80);
		component.handleInput('\x1b'); // Esc
		expect(handler).not.toHaveBeenCalled();
		expect(isDone()).toBe(true);
	});

	it('多级子键：第一键保持，第二键触发', () => {
		const handler = vi.fn();
		const reg = new ShortcutRegistry();
		reg.register({ name: 'files', keys: ['f', 'o'], description: '打开', handler });
		const { component, isDone } = mountPalette(reg, 'ctrl+shift+space');
		component.render(80);
		component.handleInput('f');
		expect(handler).not.toHaveBeenCalled();
		expect(isDone()).toBe(false); // 还有子键未按
		component.handleInput('o');
		expect(handler).toHaveBeenCalledTimes(1);
		expect(isDone()).toBe(true);
	});
});

describe('pi-shortcuts palette — 分页与导航', () => {
	function registerN(reg: ShortcutRegistry, n: number): void {
		for (let i = 0; i < n; i++) {
			reg.register({
				name: `ext-${i}`,
				keys: [String.fromCharCode(97 + (i % 26))],
				description: `功能${i}`,
				handler: () => {},
			});
		}
	}

	it('条目超过一屏时 footer 显示分页导航', () => {
		// rows=10 → pageSize = max(3, 10-6) = 4；6 个 entry → 2 页
		const reg = new ShortcutRegistry();
		registerN(reg, 6);
		const { component } = mountPalette(reg, 'alt+.', 10);
		const text = component.render(80).map(stripAnsi).join('\n');
		expect(text).toContain('第 1/2 页');
		expect(text).toContain('Tab 向后');
		expect(text).toContain('Shift+Tab 向前');
		// 第一页只显示 4 个 entry，第 5 个（功能4）不在
		expect(text).toContain('功能0');
		expect(text).not.toContain('功能4');
	});

	it('Tab 翻下一页，Shift+Tab 翻回上一页', () => {
		const reg = new ShortcutRegistry();
		registerN(reg, 6);
		const { component } = mountPalette(reg, 'alt+.', 10);
		component.render(80);

		component.handleInput('\t'); // Tab → 第 2 页
		let text = component.render(80).map(stripAnsi).join('\n');
		expect(text).toContain('第 2/2 页');
		expect(text).toContain('功能4');

		component.handleInput('\x1b[Z'); // Shift+Tab → 第 1 页
		text = component.render(80).map(stripAnsi).join('\n');
		expect(text).toContain('第 1/2 页');
		expect(text).toContain('功能0');
	});

	it('Enter 关闭不触发 handler', () => {
		const handler = vi.fn();
		const reg = new ShortcutRegistry();
		reg.register({ name: 'files', keys: ['f'], description: '文件浏览器', handler });
		const { component, isDone } = mountPalette(reg, 'alt+.');
		component.render(80);
		component.handleInput('\r'); // Enter
		expect(handler).not.toHaveBeenCalled();
		expect(isDone()).toBe(true);
	});

	it('单页时 footer 不显示翻页导航', () => {
		const reg = new ShortcutRegistry();
		registerN(reg, 2);
		const { component } = mountPalette(reg, 'alt+.', 10);
		const text = component.render(80).map(stripAnsi).join('\n');
		expect(text).not.toContain('Tab 向后');
		expect(text).toContain('Esc 关闭');
	});
});
