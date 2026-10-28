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
import { visibleWidth } from '@earendil-works/pi-tui';
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

	it('确认页 Enter：调用 disarmAll、通知，并关闭面板（不留幽灵面板）', () => {
		const h = hub(makeStatus('armed', ['wechat'], { wechat: 1 }));
		const panel = h.build();
		panel.handleInput('\r'); // 进确认
		panel.handleInput('\r'); // 确认

		expect(h.calls).toContain('disarmAll');
		expect(h.calls.some((c) => c.startsWith('notify:'))).toBe(true);
		// UAT 实测：若留在面板，焦点落到只读项，Enter 无反应 → 像卡死
		expect(h.calls).toContain('close');
	});

	it('只读项 Enter 进详情页、Esc 返回菜单（不得 no-op）', () => {
		const h = hub(makeStatus('licensed-idle'));
		const panel = h.build();
		panel.handleInput('\r');
		const detail = text(panel);
		expect(detail).toContain('影响与边界');
		expect(detail).toContain('硬拦截');
		expect(detail).toContain('Esc 返回');

		panel.handleInput('\x1b');
		expect(text(panel)).toContain('↑↓ 选择 · Enter 继续');
		expect(h.calls).not.toContain('close');
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

/**
 * 视口约束（本次 UAT 事故的正式保障）。
 *
 * 事故成因：custom 缺省（overlay:false）= 替换主区域，面板一高就把输入 dock 挤出视口，
 * 表现为「整个 TUI 卡死」。这里把「面板总高必须给 header/状态栏/输入框留出空间」
 * 变成硬断言——以后往面板里加文案，超限会直接红。
 */
const CHROME_ROWS = 6; // header 2 + 状态栏 1 + 输入框 2 + 余量 1

function panelFor(kind: 'armed' | 'idle' | 'off' | 'confirm' | 'detail'): UnattendedPanel {
	const armed = () =>
		hub(makeStatus('armed', ['wechat', 'manual'], { wechat: 2, manual: 1 })).build();
	if (kind === 'armed') return armed();
	if (kind === 'idle') return hub(makeStatus('licensed-idle')).build();
	if (kind === 'off') return hub(makeStatus('off')).build();
	const panel = kind === 'confirm' ? armed() : hub(makeStatus('licensed-idle')).build();
	panel.handleInput('\r'); // armed → 确认页；idle → 只读详情页
	return panel;
}

describe('豁免运维面板 — 视口约束', () => {
	const viewports: ReadonlyArray<readonly [number, number]> = [
		[80, 24],
		[60, 20],
		[100, 30],
	];
	const kinds = ['armed', 'idle', 'off', 'confirm', 'detail'] as const;

	for (const [cols, rows] of viewports) {
		it(`${cols}x${rows}：所有视图总高 ≤ ${rows - CHROME_ROWS} 行、行宽 ≤ ${cols}`, () => {
			for (const kind of kinds) {
				const lines = panelFor(kind).render(cols);
				expect(lines.length, `${kind} 视图总高`).toBeLessThanOrEqual(rows - CHROME_ROWS);
				for (const line of lines) {
					expect(visibleWidth(line), `${kind} 视图行宽`).toBeLessThanOrEqual(cols);
				}
			}
		});
	}

	// 核心回归锁：行数必须**完全一致**（§7.3）。行数随视图变化会让 overlay 高度抖动，
	// fullscreen 下渲染溢出 —— UAT 实测就是「整屏冻结、连 Ctrl+C 都没反应」。
	it('menu / confirm / detail 三视图行数完全一致（§7.3 最小高度填充）', () => {
		const heights = kinds.map((kind) => ({
			kind,
			height: panelFor(kind).render(80).length,
		}));
		const distinct = new Set(heights.map((h) => h.height));
		expect(distinct.size, JSON.stringify(heights)).toBe(1);
		// 具体值不设断言（改文案时允许调整），只锁「三者必须相等」这个不变量
	});

	// 注：Ctrl+C 由 pi 在路由到组件前拦截（实测 overlay 打开时按 C-c 组件收不到 \x03），
	// 因此这里不写「Ctrl+C 关闭」的断言——那会是假保障。退出路径只有 Esc。
});
