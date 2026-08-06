/**
 * ./src/tui/ 公共 TUI 辅助
 *
 * pi-tui 无原生 Grid/Table 组件。本模块提供：
 *   - colLayout    — 两列布局描述（左/右宽度计算 + 行渲染）
 *   - divider      — 全宽分隔线
 *   - checkAlignment — 离线对齐检测（用于测试）
 *
 * 用法示例见 docs/tui-helpers.md。
 */

import { Text } from '@earendil-works/pi-tui';

// ── 主题辅助函数（按需传入 theme）──

export type StyleFn = (s: string) => string;

export interface ColLayoutOpts {
	/** 左列宽度占比 (0-1)，默认 0.36 */
	leftRatio?: number;
	/** 列分隔符样式，默认 dim(' │ ') */
	separator?: string;
	/** 总可用宽度（不含左边距） */
	width: number;
}

export interface ColLayout {
	/** 左列宽度 */
	lw: number;
	/** 右列宽度 */
	rw: number;
	/** 分隔符 */
	sep: string;
	/** 渲染一行：左，右 */
	row(left: string, right: string): string;
	/** 渲染表头：左标题，右标题 */
	header(leftTitle: string, rightTitle: string): string;
}

/**
 * 创建两列布局描述。
 * 用法：
 *   const c = colLayout({ width: currentWidth - 2 });
 *   // 表头
 *   container.addChild(new Text(c.header('命名空间', '实验'), 0, 0));
 *   // 数据行
 *   for (...) { container.addChild(new Text(c.row(left, right), 0, 0)); }
 */
export function colLayout(opts: ColLayoutOpts): ColLayout {
	const leftRatio = opts.leftRatio ?? 0.36;
	const w = opts.width;
	const lw = Math.floor(w * leftRatio);
	const rw = w - lw - 3; // 3 = " │ "
	const sep = opts.separator ?? '\x1b[2m │ \x1b[0m'; // dim

	return {
		lw,
		rw,
		sep,
		row(left: string, right: string): string {
			const l = left.padEnd(lw);
			const r = right;
			return `  ${l}${sep}${r}`;
		},
		header(leftTitle: string, rightTitle: string): string {
			return `  ${leftTitle.padEnd(lw)}${sep}${rightTitle}`;
		},
	};
}

/**
 * 全宽分隔线（accent 色）。
 */
export function divider(width: number, fn: StyleFn): Text {
	return new Text(fn('\u2500'.repeat(width)), 0, 0);
}

/**
 * dim 色的全宽分隔线。
 */
export function dimDivider(width: number, fn: StyleFn): Text {
	return new Text(fn('\u2500'.repeat(width)), 0, 0);
}

// ── 对齐检测（离线 / 测试用）──

export interface AlignmentResult {
	/** 是否通过（所有含 seps 的行在 tolerance 列内对齐） */
	ok: boolean;
	/** 分隔符在各行中的列位置列表（含 ANSI 的去 visibleWidth 后位置） */
	positions: number[];
	/** 预期列位置（基于众数） */
	expectedColumn: number;
	/** 最大偏差（列） */
	maxDeviation: number;
}

/**
 * 离线检测多行中分隔符（如 "│"）是否在同一列位置。
 *
 * 适用场景：测试脚本中，提取渲染输出的各行，验证两列/多列面板的竖线对齐。
 *
 * @param lines   已去掉 ANSI 转义的纯文本行数组
 * @param sep     分隔符字符，默认 '│'
 * @param tolerance 允许的最大列偏差，默认 1
 */
export function checkAlignment(lines: string[], sep = '│', tolerance = 1): AlignmentResult {
	const positions: number[] = [];
	for (const line of lines) {
		const idx = line.indexOf(sep);
		if (idx !== -1) positions.push(idx);
	}

	if (positions.length < 2) {
		return { ok: true, positions, expectedColumn: positions[0] ?? 0, maxDeviation: 0 };
	}

	// 以众数为预期列
	const freq = new Map<number, number>();
	for (const p of positions) {
		freq.set(p, (freq.get(p) ?? 0) + 1);
	}
	let expectedColumn = positions[0];
	let maxFreq = 0;
	for (const [p, f] of freq) {
		if (f > maxFreq) {
			maxFreq = f;
			expectedColumn = p;
		}
	}

	let maxDeviation = 0;
	for (const p of positions) {
		maxDeviation = Math.max(maxDeviation, Math.abs(p - expectedColumn));
	}

	return {
		ok: maxDeviation <= tolerance,
		positions,
		expectedColumn,
		maxDeviation,
	};
}
