/**
 * TUI Headless Testing —— 不依赖真实终端的 TUI 渲染测试框架
 *
 * 提供三个核心能力：
 *
 * 1. **Headless Snapshot** — 获取 TUI 完整渲染结果（含 overlay、ANSI 颜色）
 * 2. **交互流程模拟** — 通过 dispatchInput() 注入按键，验证交互后状态
 * 3. **PTY 级别模拟** — InteractiveMockTerminal 用于测试终端协议到 handleInput 的完整链路
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
 * 直接向 TUI 注入按键事件（通过 any 桥接调用私有 handleInput）。
 *
 * 比 InteractiveMockTerminal 更简单：
 * - 无需 tui.start()
 * - 无需特殊 Terminal 类
 * - 直接用 any 桥接，和 compositeOverlays 同模式
 *
 * 链路：dispatchInput → TUI.handleInput → focusedComponent.handleInput → 状态变化
 *
 * 注意：handleInput 内部会调用异步的 requestRender()，
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
	(tui as any).handleInput(data);
}
