import { describe, it, expect } from 'vitest';
import { visibleWidth } from '@earendil-works/pi-tui';
import { colLayout, topBorder } from '../../../src/tui/helpers.js';

// 计算一行里分隔符 │ 前的可见列宽（含行首 2 空格前缀）
function sepCol(line: string): number {
	const idx = line.indexOf('│');
	return visibleWidth(line.slice(0, idx));
}

describe('colLayout', () => {
	it('含 ANSI 转义的左列对齐（竖线不偏移）', () => {
		const layout = colLayout({ width: 40 });
		const colored = (s: string) => `\x1b[36m${s}\x1b[0m`;
		const a = layout.row(colored('abc'), 'r1');
		const b = layout.row('xyz', 'r2');
		expect(sepCol(a)).toBe(sepCol(b));
	});

	it('含中文（宽字符）左列对齐', () => {
		const layout = colLayout({ width: 40 });
		const a = layout.row('名称', 'r1');
		const b = layout.row('namespace', 'r2');
		expect(sepCol(a)).toBe(sepCol(b));
	});

	it('header 与 row 分隔符同列', () => {
		const layout = colLayout({ width: 40 });
		const h = layout.header('命名空间', '实验');
		const r = layout.row('foo', 'bar');
		expect(sepCol(h)).toBe(sepCol(r));
	});

	it('默认分隔符为纯文本，不含 ANSI 转义', () => {
		const layout = colLayout({ width: 40 });
		expect(layout.sep).not.toContain('\x1b');
	});

	it('自定义分隔符生效', () => {
		const layout = colLayout({ width: 40, separator: ' | ' });
		expect(layout.sep).toBe(' | ');
		expect(layout.row('a', 'b')).toContain(' | ');
	});
});

describe('topBorder', () => {
	it('中文标题超宽时按可见宽度截断（不超宽）', () => {
		const title = '── Actions for TODO-aabbccdd "这是一个非常非常长的中文任务标题..."';
		expect(visibleWidth(title)).toBeGreaterThan(60);
		expect(visibleWidth(topBorder(title, 60))).toBeLessThanOrEqual(60);
		expect(visibleWidth(topBorder(title, 40))).toBeLessThanOrEqual(40);
	});

	it('短标题正常渲染：标题保留 + 横线填满到目标宽', () => {
		const w = topBorder('── answer ', 40);
		expect(visibleWidth(w)).toBe(40);
		expect(w.startsWith('── answer ')).toBe(true);
	});
});
