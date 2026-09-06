/**
 * merge 失败面板 — Headless TUI snapshot tests（本地优先改造）
 *
 * 验证 showMergeFailurePanel：
 *   - 中文标题「合并失败」+ 失败原因 + 建议 + 5 选项 + 底部提示，2+ 宽度不超宽
 *   - ↑↓ 导航切换选中、Enter 确认、Esc 关闭
 *   - 选项顺序：agent 首位、pull 非首位（第 4 位）、close 末尾
 */
import { describe, it, expect } from 'vitest';
import { showMergeFailurePanel } from '../../../extensions/meta/worktree/lib/ui.ts';
import { stripAnsi, assertWithinWidth } from '../../../src/tui-testing/index.js';

function mockTheme(): any {
	return {
		fg: (_c: string, text: string) => text,
		bg: (_c: string, text: string) => text,
		bold: (text: string) => text,
	};
}

function mountPanel(failureTitle: string, suggestion: string) {
	let component: any = null;
	let doneValue: any = undefined;
	const tui = { requestRender: () => {} } as any;
	const ctx = {
		hasUI: true,
		ui: {
			custom: (cb: any) => {
				component = cb(tui, mockTheme(), {} as any, (v: any) => {
					doneValue = v;
				});
				return Promise.resolve(undefined);
			},
		},
	} as any;
	void showMergeFailurePanel(ctx, failureTitle, suggestion);
	return {
		render: (width: number) => component.render(width),
		handleInput: (data: string) => component.handleInput(data),
		getDone: () => doneValue,
	};
}

describe('showMergeFailurePanel (headless)', () => {
	it('渲染失败原因 + 建议 + 5 选项 + 底部提示，多宽度不超宽', () => {
		const { render } = mountPanel('无法切换到 dev，已回滚', '检查目标分支是否存在');
		for (const w of [40, 80, 120]) {
			assertWithinWidth(render(w), w);
		}
		const text = stripAnsi(render(80).join('\n'));
		expect(text).toContain('合并失败');
		expect(text).toContain('无法切换到 dev，已回滚');
		expect(text).toContain('检查目标分支是否存在');
		expect(text).toContain('让 Agent 处理');
		expect(text).toContain('重试合并');
		expect(text).toContain('打开终端手动处理');
		expect(text).toContain('拉取最新后重试');
		expect(text).toContain('关闭');
		expect(text).toContain('上下键导航');
	});

	it('选项顺序：agent 首位、pull 第 4 位（非首位）、close 末尾', () => {
		const { render } = mountPanel('失败', '建议');
		const text = stripAnsi(render(80).join('\n'));
		const iAgent = text.indexOf('让 Agent 处理');
		const iPull = text.indexOf('拉取最新后重试');
		const iClose = text.indexOf('关闭');
		expect(iAgent).toBeGreaterThanOrEqual(0);
		expect(iPull).toBeGreaterThan(iAgent); // pull 在 agent 之后
		expect(iClose).toBeGreaterThan(iPull); // close 在 pull 之后
	});

	it('Enter 默认选中第一项 → agent', () => {
		const { handleInput, getDone } = mountPanel('失败', '建议');
		handleInput('\r');
		expect(getDone()).toEqual({ action: 'agent' });
	});

	it('Down×3 + Enter → pull（第 4 项）', () => {
		const { handleInput, getDone } = mountPanel('失败', '建议');
		handleInput('\x1b[B');
		handleInput('\x1b[B');
		handleInput('\x1b[B');
		handleInput('\r');
		expect(getDone()).toEqual({ action: 'pull' });
	});

	it('Esc → close', () => {
		const { handleInput, getDone } = mountPanel('失败', '建议');
		handleInput('\x1b');
		expect(getDone()).toEqual({ action: 'close' });
	});

	it('↑↓ 导航切换选中箭头（render 输出变化）', () => {
		const { render, handleInput } = mountPanel('失败', '建议');
		const before = stripAnsi(render(80).join('\n'));
		handleInput('\x1b[B');
		const after = stripAnsi(render(80).join('\n'));
		expect(after).not.toEqual(before);
	});
});
