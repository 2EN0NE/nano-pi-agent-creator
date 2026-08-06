/**
 * MockTerminal —— 替代真实终端的 headless 实现
 *
 * 实现 @earendil-works/pi-tui 的 Terminal 接口，
 * 用于在完全不依赖 process.stdout / stdin 的环境中运行 TUI。
 *
 * 提供两个变体：
 * - MockTerminal：纯 snapshot 渲染（不需要交互）
 * - InteractiveMockTerminal：可注入按键（支持交互流程测试）
 *
 * @module tui-testing/mock-terminal
 */

import type { Terminal } from '@earendil-works/pi-tui';

/**
 * 基础 MockTerminal —— 快照渲染专用。
 * 所有终端 I/O 方法为空实现，仅提供 columns/rows。
 *
 * 用法：
 * ```typescript
 * const term = new MockTerminal(80, 24);
 * const tui = new TUI(term);
 * ```
 */
export class MockTerminal implements Terminal {
	private _columns: number;
	private _rows: number;

	constructor(columns = 80, rows = 24) {
		this._columns = columns;
		this._rows = rows;
	}

	/** 动态修改终端尺寸，模拟 resize 事件 */
	setSize(columns: number, rows: number): void {
		this._columns = columns;
		this._rows = rows;
	}

	get columns(): number {
		return this._columns;
	}
	get rows(): number {
		return this._rows;
	}
	get kittyProtocolActive(): boolean {
		return false;
	}

	// 以下方法全部空实现 —— snapshot 渲染不需要真实终端 I/O
	start(_onInput?: (data: string) => void, _onResize?: () => void): void {}
	stop(): void {}
	write(): void {}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	async drainInput(): Promise<void> {}
}

/**
 * 交互式 MockTerminal —— 支持注入终端按键。
 *
 * 在 TUI.start() 时保存 onInput 回调，
 * 测试侧通过 sendInput() 模拟终端输入。
 *
 * 用法：
 * ```typescript
 * const term = new InteractiveMockTerminal(80, 24);
 * const tui = new TUI(term);
 * tui.start();                 // 建立 terminal → handleInput 链路
 * term.sendInput('\t');        // 模拟 Tab 键
 * term.sendInput('\x1b');      // 模拟 Escape
 * ```
 */
export class InteractiveMockTerminal extends MockTerminal {
	private _onInput?: (data: string) => void;

	/**
	 * 保存 TUI.start() 传入的 onInput 回调。
	 * 这是截获 handleInput 的合法入口
	 * （TUI 内部将 this.handleInput 通过此回调注册）。
	 */
	start(onInput: (data: string) => void, _onResize: () => void): void {
		this._onInput = onInput;
	}

	/**
	 * 模拟终端发送原始终端序列。
	 *
	 * 链路：sendInput → onInput → TUI.handleInput → focusedComponent.handleInput → 状态改变
	 *
	 * 注：handleInput 内部会同步修改组件状态 + 调用异步的 requestRender()。
	 * 由于组件状态是同步改变的，调用后无需等待即可通过 renderToSnapshot() 获取最新渲染。
	 *
	 * @throws 如果 TUI.start() 还未调用
	 */
	sendInput(data: string): void {
		if (!this._onInput) {
			throw new Error('TUI not started — call tui.start() before sendInput()');
		}
		this._onInput(data);
	}
}
