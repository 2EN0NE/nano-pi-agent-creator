/**
 * confirm-tree 阻断确认树 — headless snapshot 测试（ADR-0030）
 *
 * 验证：两层命令树渲染不超宽、颜色点映射、导航/折叠/详情/放行拒绝键位。
 */
import { describe, it, expect } from 'vitest';
import { assertWithinWidth, stripAnsi } from '../../../src/tui-testing/index.js';
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
