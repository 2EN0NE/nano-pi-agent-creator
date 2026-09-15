/**
 * tui-testing — dispatchInput 基础设施回归测试
 *
 * 背景：pi-tui >= 0.85 把 TUI 的运行时输入入口由 `handleInput` 改名为
 * `handleTerminalInput`（`TUI` 类型上仍留可选的 `handleInput`）。
 * dispatchInput 曾硬编码调用 `handleInput`，对 TuiMainScreen 直接抛
 * `tui.handleInput is not a function`，导致 AGENTS.md 推荐的交互写法失效。
 *
 * 覆盖：
 *   - 走真实输入入口 `handleTerminalInput` 送达 focused 组件
 *   - 与 renderToSnapshot 联动（状态同步改变）
 *   - release 事件按 TUI 规则过滤
 *   - 旧版仅有 `handleInput` 的实现回退可用
 *   - 两者皆无时 fail-fast
 */
import { describe, it, expect } from 'vitest';
import type { Component, TUI } from '@earendil-works/pi-tui';
import {
	MockTerminal,
	TuiMainScreen,
	dispatchInput,
	renderToSnapshot,
	stripAnsi,
} from '../../../src/tui-testing/index.js';

class Recorder implements Component {
	readonly received: string[] = [];
	private text = 'idle';

	render(): string[] {
		return [this.text];
	}

	invalidate(): void {}

	handleInput(data: string): void {
		this.received.push(data);
		this.text = `got:${data}`;
	}
}

describe('dispatchInput', () => {
	it('经真实输入入口 handleTerminalInput 送达 focused 组件', () => {
		const tui = new TuiMainScreen(new MockTerminal(20, 5));
		const rec = new Recorder();
		tui.addChild(rec);
		tui.setFocus(rec);

		dispatchInput(tui, 'x');
		expect(rec.received).toEqual(['x']);
	});

	it('按键后 renderToSnapshot 反映状态变化', () => {
		const tui = new TuiMainScreen(new MockTerminal(20, 5));
		const rec = new Recorder();
		tui.addChild(rec);
		tui.setFocus(rec);

		expect(renderToSnapshot(tui, 20, 5).map(stripAnsi)).toContain('idle');
		dispatchInput(tui, 'x');
		expect(renderToSnapshot(tui, 20, 5).map(stripAnsi)).toContain('got:x');
	});

	it('release 事件按 TUI 规则过滤（默认 wantsKeyRelease=false）', () => {
		const tui = new TuiMainScreen(new MockTerminal(20, 5));
		const rec = new Recorder();
		tui.addChild(rec);
		tui.setFocus(rec);

		// Kitty CSI-u release：o(111) + shift|ctrl(6) + 事件类型 3(release)
		dispatchInput(tui, '\x1b[111;6:3u');
		expect(rec.received).toEqual([]);
	});

	it('回退兼容仅有 handleInput 的旧版实现', () => {
		const calls: string[] = [];
		const legacy = { handleInput: (d: string) => calls.push(d) } as unknown as TUI;
		dispatchInput(legacy, 'x');
		expect(calls).toEqual(['x']);
	});

	it('两种输入入口都缺失时 fail-fast', () => {
		expect(() => dispatchInput({} as TUI, 'x')).toThrow(/handleTerminalInput/);
	});
});
