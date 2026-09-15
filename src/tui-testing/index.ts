/**
 * TUI Headless Testing —— 不依赖真实终端的 TUI 渲染测试框架
 *
 * 提供三个核心能力：
 *
 * 1. **Headless Snapshot** — 获取 TUI 完整渲染结果（含 overlay、ANSI 颜色）
 * 2. **交互流程模拟** — 通过 dispatchInput() 注入按键，验证交互后状态
 * 3. **PTY 级别模拟** — InteractiveMockTerminal 用于测试终端协议到输入入口（handleTerminalInput）的完整链路
 *
 * 依赖：@earendil-works/pi-tui（仅用其公开类型和 TUI 类）
 *
 * @example
 * ```typescript
 * import { MockTerminal, renderToSnapshot, dispatchInput, stripAnsi, assertWithinWidth, diffSnapshots } from '../../src/tui-testing/index.js';
 * ```
 *
 * 详细文档：docs/tui-headless-testing.md
 *
 * @module tui-testing
 */

import type { TUI } from '@earendil-works/pi-tui';

export { MockTerminal, InteractiveMockTerminal } from './mock-terminal.js';
export {
	renderToSnapshot,
	stripAnsi,
	assertWithinWidth,
	diffSnapshots,
	type SnapshotDiff,
} from './snapshot.js';

/**
 * Headless TUI 实例的构造入口。
 *
 * pi-tui >= 0.84 将运行时 `TUI` 类拆分为 `TuiMainScreen`（主屏）/`TuiAltScreen`
 * （全屏），`TUI` 仅剩类型。headless 测试场景渲染进 mock 终端，使用
 * `TuiMainScreen` 即可：
 *
 * ```typescript
 * const term = new MockTerminal(80, 24);
 * const tui = new TuiMainScreen(term);
 * tui.addChild(myComponent);
 * ```
 */
export { TuiMainScreen } from '@earendil-works/pi-tui';

/**
 * 直接向 TUI 注入按键事件（通过 any 桥接调其运行时输入入口）。
 *
 * 比 InteractiveMockTerminal 更简单：
 * - 无需 tui.start()
 * - 无需特殊 Terminal 类
 * - 直接用 any 桥接，和 compositeOverlays 同模式
 *
 * 链路：dispatchInput → TUI.handleTerminalInput → focusedComponent.handleInput → 状态变化
 *
 * 兼容性：pi-tui >= 0.85 将输入入口由 `handleInput` 改名为 `handleTerminalInput`
 * （`TUI` 类型上仍留可选的 `handleInput`，但运行时 TuiMainScreen/TuiAltScreen
 * 只有 `handleTerminalInput`）。此处按优先级探测，均缺失时 fail-fast。
 *
 * 注意：输入入口内部会调用异步的 requestRender()，
 * 但组件状态是同步改变的 —— 调用后无需等待即可用 renderToSnapshot() 获取最新渲染。
 *
 * @example
 * ```typescript
 * const tui = new TuiMainScreen(new MockTerminal(80, 24));
 * tui.addChild(myComponent);
 * tui.setFocus(myComponent);
 * dispatchInput(tui, '\t');  // 注入 Tab
 * const snap = renderToSnapshot(tui);
 * ```
 */
export function dispatchInput(tui: TUI, data: string): void {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const t = tui as any;
	// pi-tui >= 0.85：TuiMainScreen/TuiAltScreen 的运行时输入入口
	if (typeof t.handleTerminalInput === 'function') {
		t.handleTerminalInput(data);
		return;
	}
	// 兼容旧版 pi-tui / 自定义 TUI 实现
	if (typeof t.handleInput === 'function') {
		t.handleInput(data);
		return;
	}
	throw new Error(
		'dispatchInput: TUI 实例既不支持 handleTerminalInput 也不支持 handleInput，无法注入按键',
	);
}

/**
 * 纯文本 mock theme（headless 测试用）。
 *
 * 所有颜色/样式方法透传文本，便于用 `stripAnsi`/`assertWithinWidth` 断言纯文本布局。
 * 各测试文件原逐字重复 `const mockTheme = { fg: (_,t)=>t, bg: (_,t)=>t, bold: t=>t }`，
 * 统一由此函数提供（ADR-0023 的 headless 三层验收依赖它做无颜色断言）。
 *
 * @example
 * ```typescript
 * const theme = makeMockTheme();
 * const component = new MyComponent(theme);
 * ```
 */
export function makeMockTheme(): any {
	return {
		fg: (_c: unknown, text: string) => text,
		bg: (_c: unknown, text: string) => text,
		bold: (text: string) => text,
	};
}
