/**
 * POC: 交互流程 headless 测试
 *
 * 验证通过 MockTerminal 保存 onInput 回调，
 * 实现"终端按键 → TUI.handleInput → 组件状态变更 → snapshot 比对"的完整链路。
 *
 * 这是 headless snapshot 方案的交互层扩展，
 * 配合 renderToSnapshot() 实现"按键 → 渲染 → diff"的闭环。
 */
import { describe, it, expect } from 'vitest';
import {
	TUI,
	type Component,
	type Terminal,
	type Focusable,
	type OverlayHandle,
	CURSOR_MARKER,
	visibleWidth,
	truncateToWidth,
} from '@earendil-works/pi-tui';

// ============================================================================
// InteractiveMockTerminal —— 保存 onInput 回调，支持 sendInput()
// ============================================================================

class InteractiveMockTerminal implements Terminal {
	private _columns: number;
	private _rows: number;
	private _onInput?: (data: string) => void;

	constructor(columns = 80, rows = 24) {
		this._columns = columns;
		this._rows = rows;
	}

	setSize(columns: number, rows: number) {
		this._columns = columns;
		this._rows = rows;
	}

	/** 通过 TUI.start() 传入的回调，即 tui.handleInput */
	start(onInput: (data: string) => void, _onResize: () => void): void {
		this._onInput = onInput;
	}

	/** 模拟终端发送按键序列 */
	sendInput(data: string): void {
		if (!this._onInput) throw new Error('TUI not started — call tui.start() first');
		this._onInput(data);
	}

	get columns() {
		return this._columns;
	}
	get rows() {
		return this._rows;
	}
	get kittyProtocolActive() {
		return false;
	}

	// 以下空实现
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

// ============================================================================
// 桥接函数（同前一个 POC）
// ============================================================================

function renderToSnapshot(tui: TUI, width?: number, height?: number): string[] {
	const w = width ?? tui.terminal.columns;
	const h = height ?? tui.terminal.rows;
	let lines: string[] = tui.render(w);
	const tuiAny = tui as any;
	if (tuiAny.overlayStack?.length > 0) {
		lines = tuiAny.compositeOverlays(lines, w, h);
	}
	return tuiAny.applyLineResets(lines);
}

function stripAnsi(str: string): string {
	// eslint-disable-next-line no-control-regex
	return str.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

// ============================================================================
// 可交互组件 —— 一个状态机驱动的计数器面板
// ============================================================================

type Tab = 'count' | 'history';

class CounterPanel implements Component, Focusable {
	focused = false;

	private count = 0;
	private history: string[] = [];
	private tab: Tab = 'count';

	invalidate(): void {}

	/** handleInput 接收终端按键，改变内部状态 */
	handleInput(data: string): void {
		// '+' 或 '=' 增加计数
		if (data === '+' || data === '=') {
			this.count++;
			this.history.push(`+1 → ${this.count}`);
		}
		// '-' 减少计数
		if (data === '-') {
			this.count = Math.max(0, this.count - 1);
			this.history.push(`-1 → ${this.count}`);
		}
		// 'r' 或 '0' 重置
		if (data === 'r' || data === '0') {
			this.count = 0;
			this.history.push(`reset → 0`);
		}
		// Tab 切换 tab
		if (data === '\t') {
			this.tab = this.tab === 'count' ? 'history' : 'count';
		}
	}

	render(width: number): string[] {
		const lines: string[] = [];
		const innerW = Math.max(20, width - 4);

		lines.push(`\x1b[1m  Counter Panel\x1b[0m`);
		lines.push(`  ${'─'.repeat(innerW)}`);

		// Tab bar
		const countTab = this.tab === 'count' ? '\x1b[7m Count \x1b[0m' : ' Count ';
		const histTab = this.tab === 'history' ? '\x1b[7m History \x1b[0m' : ' History ';
		const cursor = this.focused ? CURSOR_MARKER : '';
		lines.push(truncateToWidth(`  ${cursor}[${countTab}] [${histTab}]`, width, '…', false));

		if (this.tab === 'count') {
			lines.push('');
			const countStr = `Current count: \x1b[1;32m${this.count}\x1b[0m`;
			lines.push(truncateToWidth(`  ${countStr}`, width, '…', false));
			lines.push('');
			lines.push(`  Press '+' to increment, '-' to decrement, 'r' to reset`);
		} else {
			lines.push('');
			if (this.history.length === 0) {
				lines.push(`  (no history yet)`);
			} else {
				const recent = this.history.slice(-5);
				for (const entry of recent) {
					lines.push(truncateToWidth(`  \x1b[2m${entry}\x1b[0m`, width, '…', false));
				}
			}
		}

		lines.push(`  ${'─'.repeat(innerW)}`);
		return lines;
	}
}

// ============================================================================
// 测试
// ============================================================================

describe('交互流程 headless 测试', () => {
	/** 创建完整交互环境 */
	function setup() {
		const term = new InteractiveMockTerminal(80, 24);
		const tui = new TUI(term);
		const panel = new CounterPanel();
		tui.addChild(panel);
		tui.setFocus(panel); // 同步设置 focus，让 panel.handleInput 被调用
		tui.start(); // 建立 terminal → handleInput 连接

		const snapshot = () => renderToSnapshot(tui, 80, 24).map(stripAnsi);

		return { term, tui, panel, snapshot };
	}

	it('初始 snapshot 显示 count=0', () => {
		const { snapshot } = setup();
		const lines = snapshot();
		expect(lines.some((l) => l.includes('Current count: 0'))).toBe(true);
	});

	it('按 + 增加计数，snapshot 反映变化', () => {
		const { term, snapshot } = setup();
		expect(snapshot().some((l) => l.includes('Current count: 0'))).toBe(true);

		term.sendInput('+');
		expect(snapshot().some((l) => l.includes('Current count: 1'))).toBe(true);

		term.sendInput('+');
		term.sendInput('+');
		expect(snapshot().some((l) => l.includes('Current count: 3'))).toBe(true);
	});

	it('按 - 减少计数，不低于 0', () => {
		const { term, snapshot } = setup();
		term.sendInput('+');
		term.sendInput('+');
		expect(snapshot().some((l) => l.includes('Current count: 2'))).toBe(true);

		term.sendInput('-');
		expect(snapshot().some((l) => l.includes('Current count: 1'))).toBe(true);

		// 不低于 0
		term.sendInput('-');
		term.sendInput('-');
		expect(snapshot().some((l) => l.includes('Current count: 0'))).toBe(true);
	});

	it('按 r 重置为 0', () => {
		const { term, snapshot } = setup();
		term.sendInput('+');
		term.sendInput('+');
		term.sendInput('+');
		expect(snapshot().some((l) => l.includes('Current count: 3'))).toBe(true);

		term.sendInput('r');
		expect(snapshot().some((l) => l.includes('Current count: 0'))).toBe(true);
	});

	it('按 Tab 切换 tab，snapshot 反映不同 tab 内容', () => {
		const { term, snapshot } = setup();

		// 初始在 count tab
		const snap0 = snapshot();
		expect(snap0.some((l) => l.includes('Current count'))).toBe(true);
		expect(snap0.some((l) => l.includes('no history'))).toBe(false);

		// Tab → history
		term.sendInput('\t');
		const snap1 = snapshot();
		expect(snap1.some((l) => l.includes('no history yet'))).toBe(true);
		expect(snap1.some((l) => l.includes('Current count'))).toBe(false);

		// Tab → 回到 count
		term.sendInput('\t');
		const snap2 = snapshot();
		expect(snap2.some((l) => l.includes('Current count'))).toBe(true);
	});

	it('操作序列的完整 snapshot diff 链', () => {
		const { term, snapshot } = setup();

		const history: string[][] = [snapshot()];

		term.sendInput('+');
		history.push(snapshot());

		term.sendInput('+');
		history.push(snapshot());

		term.sendInput('\t');
		history.push(snapshot());

		term.sendInput('r');
		term.sendInput('\t');
		history.push(snapshot());

		// 每一步都应有变化
		for (let i = 1; i < history.length; i++) {
			expect(history[i]).not.toEqual(history[i - 1]);
		}

		// 最终 snapshot 显示 count=0（已重置）
		const last = history[history.length - 1];
		expect(last.some((l) => l.includes('Current count: 0'))).toBe(true);
	});

	it('overlay + 交互：打开 overlay → 按键 → 关闭 overlay', () => {
		const { term, tui, snapshot } = setup();

		// 创建一个简单的 overlay
		class DismissOverlay implements Component {
			dismissed = false;
			invalidate(): void {}
			handleInput(data: string): void {
				if (data === 'y' || data === ' ') this.dismissed = true;
			}
			render(_width: number): string[] {
				return ['OVERLAY: Press y or space to dismiss'];
			}
		}

		const overlay = new DismissOverlay();
		const handle = tui.showOverlay(overlay, { anchor: 'center', width: 40 });

		// overlay 应出现
		expect(snapshot().some((l) => l.includes('OVERLAY'))).toBe(true);

		// overlay 获得 focus（showOverlay 同步设置了 focus）
		// 按 y 触发 overlay.handleInput → dismissed = true
		term.sendInput('y');

		// overlay 已 dismissed（组件状态），但 handle 仍存在
		// 我们需要调用 handle.hide() 来真正移除它
		handle.hide();

		// overlay 不再出现
		expect(snapshot().some((l) => l.includes('OVERLAY'))).toBe(false);
	});

	it('mock 复杂按键序列 (Ctrl+C, Escape)', () => {
		const { term, snapshot } = setup();

		// Ctrl+C: ASCII ETX (0x03)
		term.sendInput('\x03');
		// 组件不崩溃即可（CounterPanel 不处理 Ctrl+C，只是忽略）
		expect(() => snapshot()).not.toThrow();

		// Escape
		term.sendInput('\x1b');
		expect(() => snapshot()).not.toThrow();
	});
});
