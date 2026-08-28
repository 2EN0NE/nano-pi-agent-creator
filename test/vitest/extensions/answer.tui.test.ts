/**
 * answer QnAComponent — headless snapshot tests
 *
 * 验证（T04）：纯横线边框 + 主题色后，渲染在 2+ 宽度下不超宽；
 * 按键导航切换题目后状态正确。
 */
import { describe, it, expect } from 'vitest';
import {
	MockTerminal,
	TuiMainScreen,
	assertWithinWidth,
	stripAnsi,
} from '../../../src/tui-testing/index.js';
import { QnAComponent } from '../../../extensions/tui/answer.js';

function mockTheme(): any {
	return {
		fg: (_c: string, text: string) => text,
		bg: (_c: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		underline: (text: string) => text,
		inverse: (text: string) => text,
	};
}

const questions = [
	{ question: 'What is your preferred database?' },
	{ question: '你的数据库偏好是什么？这是一个较长的中文问题，用于验证换行与宽度兜底。' },
];

describe('answer QnAComponent', () => {
	it('在 80 / 120 宽度下渲染不超宽、不崩溃', () => {
		for (const w of [80, 120]) {
			const tui = new TuiMainScreen(new MockTerminal(w, 24));
			const comp = new QnAComponent(questions, tui as any, mockTheme() as any, () => {});
			const lines = comp.render(w);
			assertWithinWidth(lines, w);
		}
	});

	it('纯横线边框：无竖线、无圆角字符', () => {
		const tui = new TuiMainScreen(new MockTerminal(80, 24));
		const comp = new QnAComponent(questions, tui as any, mockTheme() as any, () => {});
		const out = comp.render(80).map(stripAnsi).join('\n');
		expect(out).not.toContain('│');
		expect(out).not.toContain('╭');
		expect(out).not.toContain('╮');
		expect(out).not.toContain('╰');
		expect(out).not.toContain('╯');
		expect(out).toContain('── answer');
	});

	it('Enter 导航到下一题（标题 1/2 → 2/2）', () => {
		const tui = new TuiMainScreen(new MockTerminal(80, 24));
		const comp = new QnAComponent(questions, tui as any, mockTheme() as any, () => {});

		const before = comp.render(80).map(stripAnsi).join('\n');
		expect(before).toContain('(1/2)');

		comp.handleInput('\r'); // Enter
		const after = comp.render(80).map(stripAnsi).join('\n');
		expect(after).toContain('(2/2)');
	});
});
