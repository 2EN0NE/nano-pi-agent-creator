/**
 * plannotator-tui 的选择器 — headless 渲染与按键测试。
 *
 * 验收（ticket 02）：两种宽度不超宽、输入即过滤、Enter 选中当前高亮项、Esc 取消、
 * 无命中给出可读提示。不需要 tui.start()，按键经 `dispatchInput` 直达组件。
 */
import { describe, expect, it } from 'vitest';
import {
	MockTerminal,
	TuiMainScreen,
	assertWithinWidth,
	dispatchInput,
	makeMockTheme,
	stripAnsi,
} from '../../../src/tui-testing/index.js';
import type { FileCandidate } from '../../../extensions/tui/plannotator-tui/git.js';
import { pickCandidate } from '../../../extensions/tui/plannotator-tui/picker.js';

const theme = makeMockTheme();

/** 与真实 keybindings 同样的四个 id → 实际按键；其余按键交给输入框。 */
const KEY_DATA: Record<string, string> = {
	'tui.select.up': '\u001b[A',
	'tui.select.down': '\u001b[B',
	'tui.select.confirm': '\r',
	'tui.select.cancel': '\u001b',
};
const keybindings = {
	matches: (data: string, id: string): boolean => KEY_DATA[id] === data,
};

const candidates: FileCandidate[] = [
	{
		path: '/repo/extensions/tui/files/types.ts',
		display: 'extensions/tui/files/types.ts',
		isDirectory: false,
		status: 'M',
	},
	{
		path: '/repo/extensions/tui/files/ui.ts',
		display: 'extensions/tui/files/ui.ts',
		isDirectory: false,
	},
	{ path: '/repo/docs', display: 'docs/', isDirectory: true },
];

function harness(items: FileCandidate[] = candidates) {
	const tui = new TuiMainScreen(new MockTerminal(80, 24));
	let settle: (value: FileCandidate | null) => void = () => {};
	const result = new Promise<FileCandidate | null>((resolve) => {
		settle = resolve;
	});
	let component: { render(width: number): string[]; handleInput(data: string): void } | null =
		null;

	const ctx = {
		ui: {
			custom: (
				factory: (
					tui: unknown,
					theme: unknown,
					kb: unknown,
					done: (value: FileCandidate | null) => void,
				) => { render(width: number): string[]; handleInput(data: string): void },
			) => {
				component = factory(tui, theme, keybindings, (value) => settle(value));
				tui.addChild(component as never);
				tui.setFocus(component as never);
				return result;
			},
		},
	};

	return {
		tui,
		ctx,
		result,
		lines: (width = 80): string[] => (component ? component.render(width) : []),
		text: (width = 80): string =>
			stripAnsi((component ? component.render(width) : []).join('\n')),
	};
}

async function open(items: FileCandidate[] = candidates) {
	const test = harness(items);
	void pickCandidate(test.ctx as never, '全部文件', items);
	return test;
}

describe('pickCandidate', () => {
	it('渲染标题与候选集，40/80 两种宽度都不超宽', async () => {
		const test = await open();
		for (const width of [40, 80]) {
			assertWithinWidth(test.lines(width), width);
		}
		const text = test.text();
		expect(text).toContain('── 全部文件');
		expect(text).toContain('extensions/tui/files/types.ts');
		expect(text).toContain('docs/');
	});

	it('变更候选集带状态徽标', async () => {
		const test = await open();
		expect(test.text()).toContain('[M] extensions/tui/files/types.ts');
	});

	it('输入即过滤：只剩命中项', async () => {
		const test = await open();
		for (const char of 'types') dispatchInput(test.tui as never, char);
		const text = test.text();
		expect(text).toContain('types.ts');
		expect(text).not.toContain('files/ui.ts');
	});

	it('Enter 返回当前高亮项', async () => {
		const test = await open();
		for (const char of 'types') dispatchInput(test.tui as never, char);
		dispatchInput(test.tui as never, '\r');
		expect(await test.result).toEqual(candidates[0]);
	});

	it('Esc 返回 null', async () => {
		const test = await open();
		dispatchInput(test.tui as never, '\u001b');
		expect(await test.result).toBeNull();
	});

	it('无命中给出可读提示且不崩溃', async () => {
		const test = await open();
		for (const char of 'zzzz') dispatchInput(test.tui as never, char);
		expect(test.text()).toContain('No matching files');
		assertWithinWidth(test.lines(), 80);
	});
});
