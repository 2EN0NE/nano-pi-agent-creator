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

import { Text, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

// ── 主题辅助函数（按需传入 theme）──

export type StyleFn = (s: string) => string;

export interface ColLayoutOpts {
	/** 左列宽度占比 (0-1)，默认 0.36 */
	leftRatio?: number;
	/** 列分隔符，默认纯文本 ' │ '；着色由调用方传入（如 separator: theme.fg('muted', ' │ ')） */
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
	const sep = opts.separator ?? ' │ ';
	const sepWidth = visibleWidth(sep);
	const lw = Math.floor(w * leftRatio);
	const rw = w - lw - sepWidth;

	// 按可见宽度补空格：左列含 ANSI 转义或宽字符（中文）时，分隔符列仍对齐
	const padVisible = (s: string, target: number): string =>
		s + ' '.repeat(Math.max(0, target - visibleWidth(s)));

	return {
		lw,
		rw,
		sep,
		row(left: string, right: string): string {
			return `  ${padVisible(left, lw)}${sep}${right}`;
		},
		header(leftTitle: string, rightTitle: string): string {
			return `  ${padVisible(leftTitle, lw)}${sep}${rightTitle}`;
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

/**
 * theme 语义色接线——7 个颜色包装器。
 *
 * answer.ts 的 QnAComponent 与 custom-compaction 的 SettingsComponent 曾各自在
 * 构造函数里逐字重复 `this.dim = (s) => theme.fg('dim', s)` 等 6-7 行，统一由
 * 此函数生成（ADR-0023 语义色映射：dim→dim、cyan→accent、green→success、
 * yellow→warning、red→error、gray→muted）。
 *
 * theme 参数用 `fg: (color: any, ...)` 的宽松签名，以同时兼容 pi 的 `Theme`
 * （fg 的 color 参数为 ThemeColor 窄类型）与 headless 测试的纯对象 mock
 * （makeMockTheme 返回 `{ fg, bg, bold }`，color 为 any）。
 */
export interface ThemeColors {
	dim: StyleFn;
	bold: StyleFn;
	cyan: StyleFn;
	green: StyleFn;
	yellow: StyleFn;
	red: StyleFn;
	gray: StyleFn;
}

export function makeThemeColors(theme: {
	fg: (color: any, text: string) => string;
	bold: (text: string) => string;
}): ThemeColors {
	return {
		dim: (s) => theme.fg('dim', s),
		bold: (s) => theme.bold(s),
		cyan: (s) => theme.fg('accent', s),
		green: (s) => theme.fg('success', s),
		yellow: (s) => theme.fg('warning', s),
		red: (s) => theme.fg('error', s),
		gray: (s) => theme.fg('muted', s),
	};
}

/**
 * 纯横线（无标题，ADR-0023 无角无竖线范式）：`────...`。
 *
 * answer/btw/quit/settings-ui/todos 曾各自 `'─'.repeat(Math.max(0, width))`，
 * 统一由此函数提供（含下界保护）。用作底边框、分隔线或无名字顶边框。
 */
export function bottomBorder(width: number): string {
	return '─'.repeat(Math.max(0, width));
}

/**
 * 左对齐标题横线（ADR-0023 无角无竖线范式）：`<title>────...`。
 *
 * answer/btw/quit/settings-ui 的顶边框曾各自实现
 * `title + '─'.repeat(width - title宽)`，且部分用 `.length` 误算宽度（title 含
 * 中文时超宽）。统一：visibleWidth 计算 + 超宽截断 title + 下界保护。
 *
 * @param title 含前缀的完整标题，如 '── answer '
 * @param width 横线填充到的目标总宽
 */
export function topBorder(title: string, width: number): string {
	const safe =
		visibleWidth(title) > width ? truncateToWidth(title, Math.max(2, width), '') : title;
	return safe + '─'.repeat(Math.max(0, width - visibleWidth(safe)));
}

/**
 * 标题边框组件（Container 子组件）——替代旧范式「DynamicBorder(纯横线) + Text(独立标题)」。
 *
 * ADR-0023 要求顶边框 `── 标题 ──...`（标题嵌入边框），而 Pi 内置 DynamicBorder 只渲染纯横线、
 * 标题需另起一行，导致「纯横线 + 独立标题」的顶边框。本组件把标题嵌入顶边框，
 * `render(width)` 返回单行 `── 标题 ──...`（标题自动去首尾空格，超宽截断 + 下界保护）。
 * 替代 DynamicBorder+Text 旧范式后，所有 Container 型面板的顶边框统一嵌名。
 *
 * @example
 * ```typescript
 * container.addChild(
 *   new TitleBar('Permission Gate Control Panel', (s) => theme.fg('accent', theme.bold(s))),
 * );
 * ```
 */
export class TitleBar {
	private title: string;
	private color: (s: string) => string;

	constructor(title: string, color: (s: string) => string) {
		this.title = title;
		this.color = color;
	}

	render(width: number): string[] {
		return [this.color(topBorder(`── ${this.title.trim()} `, width))];
	}

	invalidate() {}
}
