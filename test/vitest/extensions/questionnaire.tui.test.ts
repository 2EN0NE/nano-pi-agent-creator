/**
 * questionnaire renderOptions — headless snapshot tests
 *
 * 覆盖审查发现 [P2]：多选渲染（复选框 `[x]`/`[ ]`、颜色分支、isOther 豁免）
 * 在 2+ 宽度下不超宽、渲染正确。renderOptions 是模块级纯函数，
 * 不依赖 pi 生命周期，可直接用 mockTheme 断言。
 */
import { describe, it, expect } from 'vitest';
import { assertWithinWidth, stripAnsi } from '../../../src/tui-testing/index.js';
import { renderOptions } from '../../../extensions/tui/questionnaire.js';

/** 透传主题：所有颜色/样式方法返回纯文本，便于宽度与文本断言。 */
function passthroughTheme(): any {
	return {
		fg: (_c: string, text: string) => text,
		bg: (_c: string, text: string) => text,
		bold: (text: string) => text,
	};
}

/** 记录主题：捕获每次 fg 调用的颜色名与文本，用于颜色分支断言。 */
function recordingTheme(): { theme: any; calls: { color: string; text: string }[] } {
	const calls: { color: string; text: string }[] = [];
	return {
		theme: {
			fg: (color: string, text: string) => {
				calls.push({ color, text });
				return text;
			},
			bg: (_c: string, text: string) => text,
			bold: (text: string) => text,
		},
		calls,
	};
}

type Opt = { value: string; label: string; description?: string; isOther?: boolean };

function render(
	opts: Opt[],
	selectedIndex: number,
	multiSelect: boolean,
	toggled: Set<number>,
	theme: any,
): string[] {
	const lines: string[] = [];
	const add = (s: string) => lines.push(s);
	const addContent = (s: string) => lines.push(s);
	renderOptions(opts, selectedIndex, theme, add, addContent, false, multiSelect, toggled);
	return lines;
}

const opts: Opt[] = [
	{ value: 'a', label: '选项 A', description: '第一项描述' },
	{ value: 'b', label: '选项 B' },
	{ value: 'c', label: '选项 C' },
	{ value: '__other__', label: '输入其他。', isOther: true },
];

describe('questionnaire renderOptions (multi-select headless)', () => {
	it('多选复选框在多宽度下不超宽、不崩溃', () => {
		for (const w of [40, 80, 120]) {
			const lines = render(opts, 0, true, new Set([0, 1]), passthroughTheme());
			assertWithinWidth(lines, w);
		}
	});

	it('多选渲染 [x]/[ ] 复选框，且 isOther 项豁免复选框', () => {
		const joined = render(opts, 0, true, new Set([0]), passthroughTheme())
			.map(stripAnsi)
			.join('\n');
		expect(joined).toContain('[x] 1. 选项 A');
		expect(joined).toContain('[ ] 2. 选项 B');
		expect(joined).toContain('[ ] 3. 选项 C');
		// isOther 项不渲染复选框
		expect(joined).toContain('4. 输入其他。');
		expect(joined).not.toContain('[x] 4.');
		expect(joined).not.toContain('[ ] 4.');
	});

	it('多选颜色分支：勾选项 success、未勾选 text、选中 accent', () => {
		const rec = recordingTheme();
		// selected=0, toggled={1}：0=accent(选中), 1=success(勾选), 2=text, 3=text(isOther)
		render(opts, 0, true, new Set([1]), rec.theme);
		const find = (needle: string) => rec.calls.find((c) => c.text.includes(needle));
		expect(find('[x] 2. 选项 B')?.color).toBe('success');
		expect(find('[ ] 1. 选项 A')?.color).toBe('accent');
		expect(find('[ ] 3. 选项 C')?.color).toBe('text');
		expect(find('4. 输入其他。')?.color).toBe('text');
	});

	it('单选（multiSelect=false）不渲染复选框', () => {
		const joined = render(opts, 0, false, new Set(), passthroughTheme())
			.map(stripAnsi)
			.join('\n');
		expect(joined).toContain('1. 选项 A');
		expect(joined).toContain('2. 选项 B');
		expect(joined).not.toContain('[x]');
		expect(joined).not.toContain('[ ]');
	});
});
