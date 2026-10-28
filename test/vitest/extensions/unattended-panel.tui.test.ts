/**
 * selector — 豁免运维面板（ADR-0068 D8）
 *
 * 在 seam 上验证行为：渲染出的文本（用户看见什么）与 handleInput 后的状态变化
 * （↑↓ 只改信息栏、Enter 进确认、确认才真的解除）。不触碰内部字段。
 */
import { describe, it, expect } from 'vitest';
import {
	MockTerminal,
	TuiMainScreen,
	renderToSnapshot,
	stripAnsi,
	makeMockTheme,
	assertWithinWidth,
} from '../../../src/tui-testing/index.js';
import { UnattendedPanel } from '../../../extensions/meta/selector/unattended-panel';
import type { ConfirmGateStatus } from '../../../extensions/meta/selector/unattended';

function makeStatus(
	mode: ConfirmGateStatus['mode'],
	owners: string[] = [],
	counts: Record<string, number> = {},
): ConfirmGateStatus {
	return {
		license: mode !== 'off',
		armed: mode === 'armed',
		owners,
		counts,
		mode,
	};
}

function hub(initial: ConfirmGateStatus) {
	let status = initial;
	const calls: string[] = [];
	const build = () =>
		new UnattendedPanel({
			theme: makeMockTheme(),
			deps: {
				status: () => status,
				disarmAll: () => {
					calls.push('disarmAll');
					const cleared = status.owners.slice();
					status = makeStatus('licensed-idle');
					return cleared;
				},
				notify: (m: string) => calls.push(`notify:${m}`),
			},
			onClose: () => calls.push('close'),
		});
	return {
		build,
		calls,
		status: () => status,
	};
}

function screen(width = 80) {
	const tui = new TuiMainScreen(new MockTerminal(width, 24));
	return { tui, width };
}

function text(panel: UnattendedPanel, width = 80): string {
	return panel.render(width).map(stripAnsi).join('\n');
}

describe('豁免运维面板 — 三态与信息栏', () => {
	it('armed：状态/占用两行 + 三项列表，信息栏只显示当前选中项的解释', () => {
		const h = hub(makeStatus('armed', ['wechat', 'manual'], { wechat: 2, manual: 1 }));
		const panel = h.build();
		const t = text(panel);

		expect(t).toContain('豁免运维面');
		expect(t).toContain('armed');
		expect(t).toContain('本机手动');
		expect(t).toContain('wechat（未登记）');
		expect(t).toContain('x2');
		expect(t).toContain('解除豁免');
		expect(t).toContain('影响与边界');
		expect(t).toContain('关闭');
		// 默认选中「解除豁免」：只显示这一项的解释，不首屏全铺
		expect(t).toContain('撤销全部占用');
		expect(t).not.toContain('硬拦截');
	});

	it('↓ 切换只改信息栏，状态区不动', () => {
		const h = hub(makeStatus('armed', ['manual'], { manual: 1 }));
		const panel = h.build();
		const { tui } = screen();
		tui.addChild(panel);
		tui.setFocus(panel);
		const before = renderToSnapshot(tui, 80, 24).map(stripAnsi);

		panel.handleInput('\x1b[B');
		const after = renderToSnapshot(tui, 80, 24).map(stripAnsi);

		expect(after.join('\n')).toContain('硬拦截');
		expect(after.find((l) => l.includes('状态'))).toBe(before.find((l) => l.includes('状态')));
		expect(after.find((l) => l.includes('占用'))).toBe(before.find((l) => l.includes('占用')));
	});

	it('licensed-idle：不出现「解除豁免」，信息栏为弱提示', () => {
		const h = hub(makeStatus('licensed-idle'));
		const t = text(h.build());
		expect(t).toContain('licensed-idle');
		expect(t).not.toContain('解除豁免');
		expect(t).toContain('影响与边界');
	});

	it('off：不出现「解除豁免」，选中项解释里写明如何开启', () => {
		const h = hub(makeStatus('off'));
		const t = text(h.build());
		expect(t).toContain('off');
		// 默认选中第一项（影响与边界），off 分支追加「如何开启」
		expect(t).toContain('未授权');
		expect(t).toContain('--unattended-confirm');
		expect(t).not.toContain('解除豁免');
	});

	it('三态在 80 与 60 列下均不超宽（含确认页）', () => {
		const cases: ConfirmGateStatus[] = [
			makeStatus('armed', ['wechat', 'manual'], { wechat: 2, manual: 1 }),
			makeStatus('licensed-idle'),
			makeStatus('off'),
		];
		for (const initial of cases) {
			for (const width of [80, 60]) {
				const panel = hub(initial).build();
				// 用 visibleWidth（assertWithinWidth），不是码点数：中文行码点数只有显示宽度的一半，
				// `[...line].length` 恰好漏掉面板里真正会超宽的内容。
				assertWithinWidth(panel.render(width), width);
				// armed 时 Enter 进确认页；那一屏列出 owner 名 + 计数，最容易因中文超宽
				panel.handleInput('\r');
				assertWithinWidth(panel.render(width), width);
			}
		}
	});
});

describe('豁免运维面板 — 解除确认', () => {
	it('选中「解除豁免」按 Enter：确认页列出 owner 与计数', () => {
		const h = hub(makeStatus('armed', ['wechat', 'manual'], { wechat: 2, manual: 1 }));
		const panel = h.build();
		panel.handleInput('\r');
		const t = text(panel);
		expect(t).toContain('确认解除');
		expect(t).toContain('wechat（未登记）');
		expect(t).toContain('x2');
		expect(t).toContain('本机手动');
	});

	it('确认页 Enter：调用 disarmAll 并通知，面板留在原地显示已解除', () => {
		const h = hub(makeStatus('armed', ['wechat'], { wechat: 1 }));
		const panel = h.build();
		panel.handleInput('\r'); // 进确认
		panel.handleInput('\r'); // 确认

		expect(h.calls).toContain('disarmAll');
		expect(h.calls.some((c) => c.startsWith('notify:'))).toBe(true);
		expect(text(panel)).toContain('licensed-idle');
		expect(text(panel)).not.toContain('解除豁免');
	});

	it('确认页 Esc：返回菜单且不解除', () => {
		const h = hub(makeStatus('armed', ['wechat'], { wechat: 1 }));
		const panel = h.build();
		panel.handleInput('\r');
		panel.handleInput('\x1b');
		expect(h.calls).not.toContain('disarmAll');
		expect(text(panel)).toContain('解除豁免');
	});

	it('菜单 Esc：关闭面板（不改状态）', () => {
		const h = hub(makeStatus('armed', ['wechat'], { wechat: 1 }));
		const panel = h.build();
		panel.handleInput('\x1b');
		expect(h.calls).toContain('close');
		expect(h.calls).not.toContain('disarmAll');
	});
});
