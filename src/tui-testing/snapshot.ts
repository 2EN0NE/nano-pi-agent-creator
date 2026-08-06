/**
 * Headless Snapshot —— 获取 TUI 完整渲染结果的桥接层
 *
 * 核心思路：通过 `any` 桥接访问 pi-tui 的私有方法
 * compositeOverlays() 和 applyLineResets()，
 * 在不依赖真实终端的情况下拼装出与实机一致的渲染结果。
 *
 * @module tui-testing/snapshot
 */

import { TUI, visibleWidth } from '@earendil-works/pi-tui';
// eslint-disable-next-line no-control-regex
const ANSI_CSI_REGEX = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC_REGEX = /\x1b\][^\x07]*\x07/g;
const ANSI_APC_REGEX = /\x1b_[^\x07]*\x07/g;

/**
 * 通过 any 桥接获取 TUI 的完整渲染结果。
 *
 * 组装三步：
 *  ① tui.render(w)         — 基础组件树（公开 API）
 *  ② compositeOverlays(...) — 合成 overlay（私有方法，any 桥接）
 *  ③ applyLineResets(...)   — 添加 SGR reset + 终端规范化（私有方法，any 桥接）
 *
 * 返回的每行包含完整 ANSI 转义序列（颜色、超链接等），
 * 每行末尾有 SGR reset (\x1b[0m) 和 OSC 8 超链接关闭 (\x1b]8;;\x07)。
 *
 * 幂等性：相同输入产生相同输出（前提是组件 render() 是纯函数）。
 *
 * @param tui   已挂载组件的 TUI 实例（无需调用 tui.start()）
 * @param width 终端宽度（默认从 tui.terminal.columns 取）
 * @param height 终端高度（默认从 tui.terminal.rows 取）
 * @returns 渲染的行数组（含 ANSI 转义序列）
 *
 * @example
 * ```typescript
 * const term = new MockTerminal(80, 24);
 * const tui = new TUI(term);
 * tui.addChild(myComponent);
 *
 * const snapshot = renderToSnapshot(tui, 80, 24);
 * // snapshot → ["  Title\x1b[0m\x1b]8;;\x07", "  ────\x1b[0m\x1b]8;;\x07", ...]
 * ```
 */
export function renderToSnapshot(tui: TUI, width?: number, height?: number): string[] {
	const w = width ?? tui.terminal.columns;
	const h = height ?? tui.terminal.rows;

	// Step 1: 基础组件树（Container.render，公开 API）
	let lines: string[] = tui.render(w);

	// Step 2: 合成 overlay（private → any 桥接）
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const tuiAny = tui as any;
	if (tuiAny.overlayStack?.length > 0) {
		lines = tuiAny.compositeOverlays(lines, w, h);
	}

	// Step 3: 添加 SGR reset 和终端规范化（private → any 桥接）
	lines = tuiAny.applyLineResets(lines);

	return lines;
}

/**
 * 剥离 ANSI 转义序列，得到纯文本。
 *
 * 处理三类序列：
 *   - CSI (\x1b[...m)：SGR 颜色、光标移动等
 *   - OSC (\x1b]...\x07)：超链接、窗口标题等
 *   - APC (\x1b_...\x07)：CURSOR_MARKER 等
 *
 * 用于生成纯文本 snapshot（便于人工阅读和粗略 diff）。
 */
export function stripAnsi(str: string): string {
	return str.replace(ANSI_CSI_REGEX, '').replace(ANSI_OSC_REGEX, '').replace(ANSI_APC_REGEX, '');
}

/**
 * 断言 snapshot 的所有行 visibleWidth 不超过终端宽度。
 *
 * 用于验证 truncateToWidth 是否生效、是否有溢出风险。
 * 真实 TUI 在 doRender() 中会因超宽行而崩溃，
 * headless 中用此断言做等价验证。
 */
export function assertWithinWidth(lines: string[], maxWidth: number): void {
	for (let i = 0; i < lines.length; i++) {
		const w = visibleWidth(lines[i]);
		if (w > maxWidth) {
			throw new Error(
				`Line ${i} exceeds terminal width (${w} > ${maxWidth}):\n  "${lines[i].slice(0, 120)}"`,
			);
		}
	}
}

/**
 * Snapshot 比较结果。
 */
export interface SnapshotDiff {
	/** 是否有差异 */
	changed: boolean;
	/** 差异描述（前 10 处） */
	diffs: string[];
}

/**
 * 比较两个 snapshot（逐行 diff）。
 *
 * @param a 旧 snapshot
 * @param b 新 snapshot
 * @param label 差异标签（如 "before" vs "after"）
 */
export function diffSnapshots(a: string[], b: string[], label = 'snapshot'): SnapshotDiff {
	const diffs: string[] = [];
	const maxLen = Math.max(a.length, b.length);

	for (let i = 0; i < maxLen; i++) {
		const lineA = a[i] ?? '<missing>';
		const lineB = b[i] ?? '<missing>';
		if (lineA !== lineB) {
			diffs.push(
				`[line ${i}] ${label}:\n  - ${lineA.slice(0, 100)}\n  + ${lineB.slice(0, 100)}`,
			);
			if (diffs.length >= 10) break;
		}
	}

	return { changed: diffs.length > 0, diffs };
}
