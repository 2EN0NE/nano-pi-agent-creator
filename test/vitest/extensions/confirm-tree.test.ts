/**
 * confirm-tree 阻断确认树 — headless snapshot 测试（ADR-0030）
 *
 * 验证：两层命令树渲染不超宽、颜色点映射、导航/折叠/详情/放行拒绝键位。
 */
import { describe, it, expect } from 'vitest';
import {
	MockTerminal,
	TuiMainScreen,
	assertWithinWidth,
	diffSnapshots,
	renderToSnapshot,
	stripAnsi,
} from '../../../src/tui-testing/index.js';
import {
	ConfirmTree,
	confirmDotColor,
	confirmTierLabel,
	sanitizeCommand,
	type ConfirmTreeDecision,
	type ConfirmTreeLeaf,
	type ConfirmTreeTheme,
	type StrategyScope,
} from '../../../extensions/security/permission-gate/confirm-tree.js';

function mockTheme(): ConfirmTreeTheme {
	return {
		fg: (_c: string, text: string) => text,
		bold: (text: string) => text,
	};
}

function makeTui() {
	return { requestRender: () => {} };
}

const leaves: ConfirmTreeLeaf[] = [
	{ cmd: 'rm -rf dist/', tier: 'critical', reasons: ['destructive'] },
	{ cmd: 'git push --force origin', tier: 'warning', reasons: ['pattern'] },
	{ cmd: 'echo done', tier: null, reasons: [] },
];

function setup() {
	let result: ConfirmTreeDecision | null = null;
	const tui = makeTui();
	const comp = new ConfirmTree(
		'rm -rf dist/ && git push --force origin && echo done',
		leaves,
		tui,
		mockTheme(),
		(r) => {
			result = r;
		},
	);
	return { comp, getResult: () => result };
}

function setupWithAdd(defaultScope: StrategyScope = 'session') {
	const added: Array<{ cmd: string; scope: StrategyScope }> = [];
	const tui = makeTui();
	const comp = new ConfirmTree(
		'rm -rf dist/ && git push --force origin && echo done',
		leaves,
		tui,
		mockTheme(),
		() => {},
		defaultScope,
		(leaf, scope) => {
			added.push({ cmd: leaf.cmd, scope });
		},
	);
	return { comp, added };
}

describe('confirmDotColor / confirmTierLabel / sanitizeCommand', () => {
	it('风险等级映射颜色', () => {
		expect(confirmDotColor('critical')).toBe('error');
		expect(confirmDotColor('warning')).toBe('warning');
		expect(confirmDotColor('info')).toBe('accent');
		expect(confirmDotColor(null)).toBe('text');
	});

	it('tier 短标签', () => {
		expect(confirmTierLabel('critical')).toBe('[crit]');
		expect(confirmTierLabel(null)).toBe('');
	});

	it('sanitizeCommand 清理换行/制表符', () => {
		expect(sanitizeCommand('a\nb\tc')).toBe('a b c');
	});
});

describe('ConfirmTree 渲染', () => {
	it('在 80 / 120 宽度下渲染不超宽、不崩溃', () => {
		for (const w of [80, 120]) {
			const { comp } = setup();
			const lines = comp.render(w);
			assertWithinWidth(lines, w);
		}
	});

	it('树渲染含根 + 叶子 + 颜色点标记', () => {
		const { comp } = setup();
		const out = comp.render(80).map(stripAnsi).join('\n');
		expect(out).toContain('Permission Gate');
		expect(out).toContain('rm -rf dist/ && git push');
		expect(out).toContain('●');
		expect(out).toContain('└─');
		expect(out).toContain('[crit]');
		expect(out).toContain('[warn]');
		expect(out).toContain('a 添加为策略');
	});

	it('enter 放行、esc 拒绝', () => {
		const a = setup();
		a.comp.handleInput('enter');
		expect(a.getResult()).toBe('allow');

		const b = setup();
		b.comp.handleInput('escape');
		expect(b.getResult()).toBe('deny');
	});

	it('多叶子时提示行保持可见，超出窗口滚动', () => {
		const many: ConfirmTreeLeaf[] = Array.from({ length: 40 }, (_, i) => ({
			cmd: `cmd ${i}`,
			tier: 'info',
			reasons: [],
		}));
		const tui = makeTui();
		const comp = new ConfirmTree('root-command', many, tui, mockTheme(), () => {});
		const lines = comp.render(80).map(stripAnsi);
		// 默认 24 行视口 → maxVisibleLeaves = 19；总高 = 标题+根+19叶子+滚动指示+空行+提示
		expect(lines.length).toBe(24);
		expect(lines[lines.length - 1]).toContain('enter 放行');
		expect(lines[lines.length - 1]).toContain('esc 拒绝');
		expect(lines.join('\n')).toContain('1-19/40 子命令');

		// 下移到第 30 个叶子 → 窗口滚动，提示行仍在
		for (let i = 0; i < 30; i++) comp.handleInput('down');
		const scrolled = comp.render(80).map(stripAnsi);
		expect(scrolled[scrolled.length - 1]).toContain('enter 放行');
		expect(scrolled.join('\n')).toContain('12-30/40 子命令');
	});

	it('多行命令根节点被压平为单行，不破坏行数', () => {
		const tui = makeTui();
		const comp = new ConfirmTree(
			'for d in a b; do\n  echo "$d"\ndone',
			[{ cmd: 'echo "$d"', tier: 'info', reasons: [] }],
			tui,
			mockTheme(),
			() => {},
		);
		const lines = comp.render(80).map(stripAnsi);
		// 标题 + 根 + 1 叶子 + 空行 + 提示行 = 5 行，根命令不得展开成多行
		expect(lines.length).toBe(5);
		expect(lines[1]).toContain('for d in a b; do');
		expect(lines[1]).not.toContain('\n');
		expect(lines.join('\n')).toContain('enter 放行  esc 拒绝');
	});
});

describe('ConfirmTree 交互', () => {
	it('→ 进入叶子详情、← 退出详情', () => {
		const { comp } = setup();
		// 先下移光标到第一个叶子
		comp.handleInput('down');
		const before = comp.render(80).map(stripAnsi).join('\n');
		expect(before).not.toContain('子命令详情');

		comp.handleInput('right');
		const detail = comp.render(80).map(stripAnsi).join('\n');
		expect(detail).toContain('子命令详情');
		expect(detail).toContain('等级:');
		expect(detail).toContain('命中:');

		comp.handleInput('left');
		const after = comp.render(80).map(stripAnsi).join('\n');
		expect(after).not.toContain('子命令详情');
	});

	it('alt+left 折叠叶子、alt+right 展开', () => {
		const { comp } = setup();
		comp.handleInput('alt+left');
		const folded = comp.render(80).map(stripAnsi).join('\n');
		expect(folded).toContain('条子命令');
		expect(folded).not.toContain('●');

		comp.handleInput('alt+right');
		const expanded = comp.render(80).map(stripAnsi).join('\n');
		expect(expanded).toContain('●');
	});

	it('上下导航在根与叶子间循环', () => {
		const { comp } = setup();
		comp.handleInput('down');
		const first = comp.render(80).map(stripAnsi).join('\n');
		expect(first).toContain('> ');
		comp.handleInput('down');
		comp.handleInput('down');
		comp.handleInput('down');
		// 3 个叶子 + 1 根 = 4 个节点，down 4 次回到根
		const back = comp.render(80).map(stripAnsi).join('\n');
		expect(back).toContain('> ');
	});
});

describe('ConfirmTree 添加为策略', () => {
	it('a 键进入级别选择，级别顺序默认置顶 + 会话>项目>用户', () => {
		const { comp } = setupWithAdd('project');
		comp.handleInput('down'); // 光标到第一个叶子
		comp.handleInput('a');
		const out = comp.render(80).map(stripAnsi).join('\n');
		expect(out).toContain('选择持久化层级');
		// 顺序：project（默认）置顶，然后 session、user
		expect(out.indexOf('项目')).toBeLessThan(out.indexOf('会话'));
		expect(out.indexOf('会话')).toBeLessThan(out.indexOf('用户'));
	});

	it('enter 确认调用 onAddStrategy，esc 取消回到树', () => {
		const { comp, added } = setupWithAdd('session');
		comp.handleInput('down'); // 光标到第一个叶子 rm
		comp.handleInput('a');
		comp.handleInput('enter'); // 默认 session 置顶
		expect(added).toEqual([{ cmd: 'rm -rf dist/', scope: 'session' }]);
		const out = comp.render(80).map(stripAnsi).join('\n');
		expect(out).not.toContain('选择持久化层级');
	});

	it('esc 取消级别选择，不调用 onAddStrategy', () => {
		const { comp, added } = setupWithAdd('session');
		comp.handleInput('down');
		comp.handleInput('a');
		comp.handleInput('escape');
		expect(added).toEqual([]);
		const out = comp.render(80).map(stripAnsi).join('\n');
		expect(out).not.toContain('选择持久化层级');
	});
});

describe('ConfirmTree 详情逐条命中（hits）', () => {
	it('带 hits 的叶子详情逐条展示来源标记 + 解释文案', () => {
		const leavesWithHits: ConfirmTreeLeaf[] = [
			{
				cmd: 'sudo rm -rf /etc',
				tier: 'critical',
				reasons: ['permission-related', 'system-dir-write', 'pattern'],
				hits: [
					{
						tier: 'critical',
						reason: 'permission-related',
						source: 'builtin',
						explain: '以提权身份执行，绕过当前用户权限边界',
					},
					{
						tier: 'critical',
						reason: 'system-dir-write',
						source: 'builtin',
						explain: '写入系统目录 /etc',
					},
					{
						tier: 'critical',
						reason: 'pattern',
						source: 'pattern',
						explain: 'rm -rf 递归强制删除，误删不可恢复',
					},
				],
			},
		];
		const tui = makeTui();
		const comp = new ConfirmTree(
			'sudo rm -rf /etc',
			leavesWithHits,
			tui,
			mockTheme(),
			() => {},
		);
		comp.handleInput('down'); // 光标到叶子
		comp.handleInput('right'); // 进详情
		const out = comp.render(80).map(stripAnsi).join('\n');
		expect(out).toContain('[内置·权限命令]');
		expect(out).toContain('以提权身份执行');
		expect(out).toContain('[内置·系统目录写入]');
		expect(out).toContain('写入系统目录 /etc');
		expect(out).toContain('[拦截模式]');
		expect(out).toContain('rm -rf 递归强制删除');
	});

	it('无 hits 的叶子回退旧扁平 reasons 单行（兼容）', () => {
		const { comp } = setup();
		comp.handleInput('down');
		comp.handleInput('right');
		const out = comp.render(80).map(stripAnsi).join('\n');
		expect(out).toContain('命中: 破坏性命令');
	});
});

describe('ConfirmTree 展开全貌（ctrl+shift+O）', () => {
	// Kitty CSI-u：'o' codepoint 111 + shift(1)|ctrl(4) 修饰符 → modValue 6
	const CTRL_SHIFT_O = '\x1b[111;6u';

	function longCommand(segments: number): string {
		return Array.from({ length: segments }, (_, i) => `segment${i}`).join(' ');
	}

	it('ctrl+shift+O 的 repeat 事件不触发展开/折叠（避免长按抖动）', () => {
		// Kitty CSI-u repeat：'o'(111) + shift|ctrl(6) + 事件类型 2(repeat)
		const CTRL_SHIFT_O_REPEAT = '\x1b[111;6:2u';
		const tui = makeTui();
		const comp = new ConfirmTree(longCommand(30), [], tui, mockTheme(), () => {});

		// press 展开后，repeat 不应折叠
		comp.handleInput(CTRL_SHIFT_O);
		comp.handleInput(CTRL_SHIFT_O_REPEAT);
		const expanded = comp.render(60).map(stripAnsi).join('\n');
		expect(expanded).toContain('segment29');
		expect(expanded).toContain('ctrl+shift+O 折叠');

		// press 折叠后，repeat 不应再展开
		comp.handleInput(CTRL_SHIFT_O);
		comp.handleInput(CTRL_SHIFT_O_REPEAT);
		const collapsed = comp.render(60).map(stripAnsi).join('\n');
		expect(collapsed).not.toContain('segment29');
		expect(collapsed).not.toContain('ctrl+shift+O 折叠');
	});

	it('展开态叶子不渲染冻结的 > 选中标记（光标已冻结，仅 ↑↓ 滚动）', () => {
		const { comp } = setup();
		comp.handleInput('down'); // 光标到第一个叶子（非展开态显示 >）
		comp.handleInput(CTRL_SHIFT_O);
		const out = comp.render(80).map(stripAnsi);
		// 展开态无任何行以 > 开头（根与叶子均不渲染选中标记）
		expect(out.some((line) => line.startsWith('> '))).toBe(false);
	});

	it('ctrl+shift+O 展开主命令为多行，再按折叠回单行', () => {
		const tui = makeTui();
		const comp = new ConfirmTree(longCommand(30), [], tui, mockTheme(), () => {});

		const before = comp.render(60).map(stripAnsi);
		// 非展开态：标题 + 根（单行截断） + 空行 + 提示行 = 4 行
		expect(before.length).toBe(4);
		expect(before.join('\n')).toContain('segment0');
		expect(before.join('\n')).not.toContain('segment29'); // 单行截断看不到末段

		comp.handleInput(CTRL_SHIFT_O);
		const expanded = comp.render(60).map(stripAnsi);
		expect(expanded.length).toBeGreaterThan(4);
		expect(expanded.join('\n')).toContain('segment29'); // 全貌可见
		expect(expanded.join('\n')).toContain('ctrl+shift+O 折叠');
		expect(expanded.join('\n')).toContain('↑↓ 滚动');

		comp.handleInput(CTRL_SHIFT_O);
		const back = comp.render(60).map(stripAnsi);
		expect(back.length).toBe(4);
		expect(back.join('\n')).not.toContain('segment29');
	});

	it('展开后内容超出视口高度时 ↑↓ 滚动查看', () => {
		const tui = makeTui();
		const comp = new ConfirmTree(longCommand(300), [], tui, mockTheme(), () => {});
		comp.handleInput(CTRL_SHIFT_O);

		const first = comp.render(60).map(stripAnsi).join('\n');
		expect(first).toContain('segment0');
		expect(first).not.toContain('segment299'); // 底部未滚动到

		// 向下滚到底部
		for (let i = 0; i < 500; i++) comp.handleInput('down');
		const last = comp.render(60).map(stripAnsi).join('\n');
		expect(last).toContain('segment299');
		expect(last).not.toContain('segment0');

		// 向上回到顶部
		for (let i = 0; i < 500; i++) comp.handleInput('up');
		const back = comp.render(60).map(stripAnsi).join('\n');
		expect(back).toContain('segment0');
	});

	it('子命令详情中 ctrl+shift+O 展开命令全貌', () => {
		const longLeaf: ConfirmTreeLeaf = {
			cmd: longCommand(30),
			tier: 'critical',
			reasons: ['destructive'],
		};
		const tui = makeTui();
		const comp = new ConfirmTree('root', [longLeaf], tui, mockTheme(), () => {});
		comp.handleInput('down'); // 光标到叶子
		comp.handleInput('right'); // 进详情

		const before = comp.render(50).map(stripAnsi).join('\n');
		expect(before).toContain('命令: segment0');
		expect(before).not.toContain('segment29'); // 单行截断

		comp.handleInput(CTRL_SHIFT_O);
		const expanded = comp.render(50).map(stripAnsi).join('\n');
		expect(expanded).toContain('命令: segment0');
		expect(expanded).toContain('segment29'); // 全貌可见
	});

	it('展开态 enter 放行、esc 拒绝仍生效', () => {
		const a = setup();
		a.comp.handleInput(CTRL_SHIFT_O);
		a.comp.handleInput('enter');
		expect(a.getResult()).toBe('allow');

		const b = setup();
		b.comp.handleInput(CTRL_SHIFT_O);
		b.comp.handleInput('escape');
		expect(b.getResult()).toBe('deny');
	});

	it('展开态在 40/60/80/120 宽度下渲染不超宽、行数不超过视口', () => {
		for (const w of [40, 60, 80, 120]) {
			const tui = { requestRender: () => {}, terminal: { rows: 24, columns: w } };
			const comp = new ConfirmTree(
				longCommand(60),
				[{ cmd: longCommand(60), tier: 'critical', reasons: ['destructive'] }],
				tui,
				mockTheme(),
				() => {},
			);
			comp.handleInput(CTRL_SHIFT_O);
			const lines = comp.render(w);
			// wrapTextWithAnsi 换行路径的回归护栏：每行不超宽（ADR-0023 崩溃防线）
			assertWithinWidth(lines, w);
			// 展开态 = 标题(1) + viewport(rows-2) + 提示行(1)，总高 ≤ 视口
			expect(lines.length).toBeLessThanOrEqual(24);
		}
	});

	it('展开态叶子 tier 标签（[crit]/[warn]）始终可见，不被命令换行截断', () => {
		const tui = makeTui();
		const comp = new ConfirmTree(
			'root',
			[
				{ cmd: longCommand(30), tier: 'critical', reasons: ['destructive'] },
				{ cmd: 'echo done', tier: 'warning', reasons: ['pattern'] },
			],
			tui,
			mockTheme(),
			() => {},
		);
		comp.handleInput(CTRL_SHIFT_O);
		for (const w of [40, 60, 80]) {
			const out = comp.render(w).map(stripAnsi).join('\n');
			expect(out).toContain('[crit]');
			expect(out).toContain('[warn]');
		}
	});

	it('展开态内容超出视口时显示滚动位置指示（n-m/total）', () => {
		const tui = makeTui();
		const comp = new ConfirmTree(longCommand(300), [], tui, mockTheme(), () => {});
		comp.handleInput(CTRL_SHIFT_O);

		// 顶部：从 1 开始
		const top = comp.render(80).map(stripAnsi).join('\n');
		expect(top).toMatch(/\(1-\d+\/\d+\)/);

		// 滚到底：范围指示同步右移，起始不再为 1
		for (let i = 0; i < 500; i++) comp.handleInput('down');
		const bottom = comp.render(80).map(stripAnsi).join('\n');
		expect(bottom).toMatch(/\(\d+-\d+\/\d+\)/);
		expect(bottom).not.toMatch(/\(1-/);
	});

	it('非展开态提示行在 67-80 列仍保留 enter 放行 / esc 拒绝（主操作不被截断）', () => {
		const { comp } = setup();
		for (const w of [67, 70, 72, 75, 80]) {
			const out = comp.render(w).map(stripAnsi).join('\n');
			expect(out).toContain('enter 放行');
			expect(out).toContain('esc 拒绝');
		}
	});
});

describe('ConfirmTree headless snapshot（TUI 渲染树，含 overlay 合成）', () => {
	// Kitty CSI-u：'o' codepoint 111 + shift(1)|ctrl(4) 修饰符 → modValue 6
	const CTRL_SHIFT_O = '\x1b[111;6u';

	function mount(width: number, rows: number) {
		const tui = new TuiMainScreen(new MockTerminal(width, rows));
		const comp = new ConfirmTree(
			'rm -rf dist/ && git push --force origin && echo done',
			[
				{ cmd: 'rm -rf dist/', tier: 'critical', reasons: ['destructive'] },
				{ cmd: 'git push --force origin', tier: 'warning', reasons: ['pattern'] },
			],
			tui as any,
			mockTheme(),
			() => {},
		);
		// ConfirmTree 不是 pi-tui Component（无 invalidate）；测试侧补一个适配器挂到渲染树
		const component = {
			render: (w: number) => comp.render(w),
			invalidate: () => {},
			handleInput: (d: string) => comp.handleInput(d),
		};
		tui.addChild(component as any);
		tui.setFocus(component as any);
		return { tui, comp };
	}

	it('展开前后 snapshot diff 非空、不超宽，且展开标记出现', () => {
		const { tui, comp } = mount(80, 24);
		const before = renderToSnapshot(tui, 80, 24);
		assertWithinWidth(before, 80);

		comp.handleInput(CTRL_SHIFT_O);
		const after = renderToSnapshot(tui, 80, 24);
		assertWithinWidth(after, 80);

		const diff = diffSnapshots(before, after, 'expand');
		expect(diff.changed).toBe(true);
		expect(after.map(stripAnsi).join('\n')).toContain('ctrl+shift+O 折叠');
	});

	it('展开 → 折叠后 snapshot 复原（往返无残留）', () => {
		const { tui, comp } = mount(80, 24);
		const before = renderToSnapshot(tui, 80, 24).map(stripAnsi);

		comp.handleInput(CTRL_SHIFT_O);
		comp.handleInput(CTRL_SHIFT_O);
		const after = renderToSnapshot(tui, 80, 24).map(stripAnsi);

		expect(after).toEqual(before);
	});
});
