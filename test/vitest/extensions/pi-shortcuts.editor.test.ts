import { describe, it, expect } from 'vitest';
import { showEditor } from '../../../extensions/meta/pi-shortcuts/ui/editor.ts';
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

function mockConfigStore(): any {
	let config = { prefixKey: 'ctrl+shift+space', paletteOnPrefix: true, remap: [] };
	return {
		get: () => config,
		save: (next: any, _scope: string) => {
			config = { ...config, ...next };
			return true;
		},
		reload: () => config,
	};
}

function mountEditor(registry: ShortcutRegistry) {
	let component: any = null;
	let doneCalled = false;
	const tui = { requestRender: () => {} };
	const ctx = {
		hasUI: true,
		ui: {
			custom: (cb: any) => {
				component = cb(tui, mockTheme(), { matches: () => false }, () => {
					doneCalled = true;
				});
				return Promise.resolve(undefined);
			},
		},
	} as any;
	void showEditor(ctx, registry, mockConfigStore(), () => {});
	return {
		component,
		isDone: () => doneCalled,
	};
}

function renderLines(component: any, width: number): string[] {
	return component.render(width).map(stripAnsi);
}

describe('pi-shortcuts editor — headless snapshot', () => {
	it('全局 Tab 渲染不超宽（80 列）', () => {
		const reg = new ShortcutRegistry();
		reg.register({
			name: 'files',
			keys: ['f', 'o'],
			description: '打开文件',
			handler: () => {},
		});
		const { component } = mountEditor(reg);
		const snapshot = renderLines(component, 80);
		assertWithinWidth(snapshot, 80);
		const text = snapshot.join('\n');
		expect(text).toContain('快捷键设置');
		expect(text).toContain('全局');
		expect(text).toContain('快捷键');
		expect(text).toContain('前缀键');
		expect(text).toContain('作用域: user');
	});

	it('窄宽度（40 列）渲染不超宽', () => {
		const reg = new ShortcutRegistry();
		reg.register({
			name: 'files',
			keys: ['f', 'o'],
			description: '这是一个很长的说明用来测试窄宽度下的截断行为',
			handler: () => {},
		});
		const { component } = mountEditor(reg);
		const snapshot = renderLines(component, 40);
		assertWithinWidth(snapshot, 40);
	});

	it('上下边框存在且无左右竖线', () => {
		const reg = new ShortcutRegistry();
		reg.register({ name: 'files', keys: ['f'], description: '文件浏览器', handler: () => {} });
		const { component } = mountEditor(reg);
		const text = renderLines(component, 80).join('\n');
		expect(text).toContain('┌');
		expect(text).toContain('└');
		expect(text).not.toContain('│'); // 用户要求：不要左右竖线
	});

	it('Tab 切换到快捷键 Tab，展示动态插件快捷键列表', () => {
		const reg = new ShortcutRegistry();
		reg.register({
			name: 'files',
			keys: ['f', 'o'],
			description: '打开文件',
			handler: () => {},
		});
		reg.register({
			name: 'prompt-editor',
			keys: ['e'],
			description: '编辑提示词',
			handler: () => {},
		});
		const { component } = mountEditor(reg);
		component.render(80);

		// 初始全局 Tab：无 files（entries 在快捷键 Tab）
		expect(renderLines(component, 80).join('\n')).not.toContain('> files');

		// Tab 切换
		component.handleInput('\t');
		const text = renderLines(component, 80).join('\n');
		expect(text).toContain('> files');
		expect(text).toContain('prompt-editor');
		// 列表行显示 description（作用说明）
		expect(text).toContain('打开文件');
		expect(text).toContain('编辑提示词');
	});

	it('快捷键 Tab 内 ↑↓ 导航切换选中项', () => {
		const reg = new ShortcutRegistry();
		reg.register({
			name: 'files',
			keys: ['f', 'o'],
			description: '打开文件',
			handler: () => {},
		});
		reg.register({
			name: 'prompt-editor',
			keys: ['e'],
			description: '编辑提示词',
			handler: () => {},
		});
		const { component } = mountEditor(reg);
		component.render(80);
		component.handleInput('\t'); // 切到快捷键 Tab

		expect(renderLines(component, 80).join('\n')).toContain('> files');

		component.handleInput('\x1b[B'); // ↓
		expect(renderLines(component, 80).join('\n')).toContain('> prompt-editor');

		component.handleInput('\x1b[B'); // ↓ 循环回第 0 项
		expect(renderLines(component, 80).join('\n')).toContain('> files');
	});

	it('l 切换作用域', () => {
		const reg = new ShortcutRegistry();
		reg.register({ name: 'files', keys: ['f'], description: '文件浏览器', handler: () => {} });
		const { component } = mountEditor(reg);
		component.render(80);
		expect(renderLines(component, 80).join('\n')).toContain('作用域: user');
		component.handleInput('l');
		expect(renderLines(component, 80).join('\n')).toContain('作用域: project');
	});

	it('全局 Tab 按 Enter 进入改前缀键编辑态（渲染不超宽）', () => {
		const reg = new ShortcutRegistry();
		reg.register({ name: 'files', keys: ['f'], description: '文件浏览器', handler: () => {} });
		const { component } = mountEditor(reg);
		component.render(80);

		component.handleInput('\r'); // Enter
		const snapshot = renderLines(component, 80);
		assertWithinWidth(snapshot, 80);
		expect(snapshot.join('\n')).toContain('改前缀键');
	});

	it('快捷键 Tab 按 Enter 进入改子键编辑态', () => {
		const reg = new ShortcutRegistry();
		reg.register({
			name: 'files',
			keys: ['f', 'o'],
			description: '打开文件',
			handler: () => {},
		});
		const { component } = mountEditor(reg);
		component.render(80);
		component.handleInput('\t'); // 切到快捷键 Tab

		component.handleInput('\r'); // Enter
		const snapshot = renderLines(component, 80);
		assertWithinWidth(snapshot, 80);
		expect(snapshot.join('\n')).toContain('改子键');
	});

	it('Esc 关闭', () => {
		const reg = new ShortcutRegistry();
		reg.register({ name: 'files', keys: ['f'], description: '文件浏览器', handler: () => {} });
		const { component, isDone } = mountEditor(reg);
		component.render(80);
		component.handleInput('\x1b');
		expect(isDone()).toBe(true);
	});

	it('同插件多功能用竖线串起来分组', () => {
		const reg = new ShortcutRegistry();
		reg.register({
			name: 'files',
			keys: ['f', 'o'],
			description: '打开文件',
			handler: () => {},
		});
		reg.register({
			name: 'files',
			keys: ['f', 'r'],
			description: '在 Finder 中显示',
			handler: () => {},
		});
		reg.register({
			name: 'files',
			keys: ['f', 'q'],
			description: '快速预览',
			handler: () => {},
		});
		const { component } = mountEditor(reg);
		component.render(80);
		component.handleInput('\t'); // 切到快捷键 Tab
		const lines = renderLines(component, 80);
		expect(lines.some((l) => l.includes('│'))).toBe(true);
		expect(lines.some((l) => l.includes('└'))).toBe(true);
		const text = lines.join('\n');
		expect(text).toContain('打开文件');
		expect(text).toContain('在 Finder 中显示');
		expect(text).toContain('快速预览');
	});
});
