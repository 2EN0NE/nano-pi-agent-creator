/**
 * merge 成功两选项面板 — Headless TUI snapshot tests（ticket 09）
 *
 * 按项目「TUI 测试强制要求」验证：
 *   - 中文标题「已合并 <source> -> <target>」+ 两选项 + 底部提示，2+ 宽度不超宽、不崩溃
 *   - ↑↓ 导航切换选中、Enter 确认、Esc 关闭（返回 dismiss）
 */
import { describe, it, expect } from 'vitest';
import { showMergeSuccessPanel } from '../../../extensions/meta/worktree/lib/ui.ts';
import { stripAnsi, assertWithinWidth } from '../../../src/tui-testing/index.js';

function mockTheme(): any {
	return {
		fg: (_c: string, text: string) => text,
		bg: (_c: string, text: string) => text,
		bold: (text: string) => text,
	};
}

function mountPanel(sourceBranch: string, targetBranch: string) {
	let component: any = null;
	let doneValue: any = undefined;
	const tui = { requestRender: () => {} } as any;
	const ctx = {
		hasUI: true,
		ui: {
			custom: (cb: any) => {
				component = cb(
					tui,
					mockTheme(),
					{} as any, // kb 参数未使用：面板 handleInput 走真实 getKeybindings()
					(v: any) => {
						doneValue = v;
					},
				);
				return Promise.resolve(undefined);
			},
		},
	} as any;
	void showMergeSuccessPanel(ctx, sourceBranch, targetBranch);
	return {
		render: (width: number) => component.render(width),
		handleInput: (data: string) => component.handleInput(data),
		getDone: () => doneValue,
	};
}

describe('showMergeSuccessPanel (headless)', () => {
	it('渲染中文标题 + 两选项 + 底部提示，多宽度不超宽', () => {
		const { render } = mountPanel('wt/pi-lab', 'main');
		for (const w of [40, 80, 120]) {
			assertWithinWidth(render(w), w);
		}
		const text = stripAnsi(render(80).join('\n'));
		expect(text).toContain('已合并 wt/pi-lab -> main');
		expect(text).toContain('切换到 main');
		expect(text).toContain('回到主菜单');
		expect(text).toContain('上下键导航');
	});

	it('Enter 默认选中第一项 → switch', () => {
		const { handleInput, getDone } = mountPanel('wt/pi-lab', 'main');
		handleInput('\r');
		expect(getDone()).toEqual({ action: 'switch' });
	});

	it('Down + Enter → menu', () => {
		const { handleInput, getDone } = mountPanel('wt/pi-lab', 'main');
		handleInput('\x1b[B');
		handleInput('\r');
		expect(getDone()).toEqual({ action: 'menu' });
	});

	it('Esc → dismiss', () => {
		const { handleInput, getDone } = mountPanel('wt/pi-lab', 'main');
		handleInput('\x1b');
		expect(getDone()).toEqual({ action: 'dismiss' });
	});

	it('↑↓ 导航切换选中箭头（render 输出变化）', () => {
		const { render, handleInput } = mountPanel('wt/pi-lab', 'main');
		const before = stripAnsi(render(80).join('\n'));
		handleInput('\x1b[B');
		const after = stripAnsi(render(80).join('\n'));
		expect(after).not.toEqual(before);
	});
});
