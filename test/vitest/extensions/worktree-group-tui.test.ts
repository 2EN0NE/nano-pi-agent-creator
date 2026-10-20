/**
 * pi-worktree — 组相关 TUI（headless snapshot，ADR-0062 票 03/05/06）
 *
 * 按项目「TUI 测试强制要求」验证：
 *   - 一级 switcher 的 Groups 段：渲染 + 2 宽度不超宽 + Enter 进组菜单 + g 开建组向导
 *   - 候选多选：锁定项灰显禁选（space 无效、不进执行集）
 *   - 统一对齐面板：默认全选、Esc = 跳过（返回 null）
 *   - 建组向导：6 步走通（组名 → 目标 → 成员 → 策略 → env → 确认），Esc 任一步取消
 *
 * 断言既落在**渲染**（文本/宽度），也落在**返回值**（面板选择 = 后续执行集）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { showWorktreeTui, type GroupRowItem } from '../../../extensions/meta/worktree/lib/ui.js';
import {
	runGroupWizard,
	showGroupCandidatePanel,
	showGroupMenu,
	showUnifiedAlignPanel,
} from '../../../extensions/meta/worktree/lib/group-ui.js';
import { runGroupMenuFlow } from '../../../extensions/meta/worktree/lib/group-ops.js';
import { createWorktree } from '../../../extensions/meta/worktree/lib/worktree.js';
import { resolveWorktreePath } from '../../../extensions/meta/worktree/lib/paths.js';
import { loadGroups, saveGroup } from '../../../extensions/meta/worktree/lib/groups.js';
import type { GroupCandidates } from '../../../extensions/meta/worktree/lib/groups.js';
import { stripAnsi, assertWithinWidth } from '../../../src/tui-testing/index.js';

// ── mock theme（无色透传） ──

function mockTheme(): any {
	return {
		fg: (_c: string, t: string) => t,
		bg: (_c: string, t: string) => t,
		bold: (t: string) => t,
		italic: (t: string) => t,
		underline: (t: string) => t,
		inverse: (t: string) => t,
		strikethrough: (t: string) => t,
		getFgAnsi: () => '',
		getBgAnsi: () => '',
		getColorMode: () => 'truecolor' as const,
	};
}

/** 挂载任意 custom 组件：捕获实例、返回值、keybindings 桩 */
function mount<T>(run: (ctx: any) => Promise<T>): {
	component: () => any;
	result: () => T | undefined;
	promise: Promise<T>;
} {
	let comp: any = null;
	let value: T | undefined;
	const tui = { requestRender: () => {} } as any;
	const ctx = {
		hasUI: true,
		cwd: '/nonexistent',
		ui: {
			custom: (cb: any) => {
				comp = cb(
					tui,
					mockTheme(),
					{ matches: () => false, getDefinition: () => undefined },
					(v: T) => {
						value = v;
					},
				);
				return Promise.resolve(undefined);
			},
			notify: () => {},
			confirm: async () => true,
		},
	} as any;
	const promise = run(ctx).catch(() => undefined as unknown as T);
	return { component: () => comp, result: () => value, promise };
}

function assertWidths(render: (w: number) => string[], widths: number[]): void {
	for (const w of widths) {
		expect(() => assertWithinWidth(render(w), w)).not.toThrow();
	}
}

// ═══════════════════════════════════════════
// 一级列表：Groups 段
// ═══════════════════════════════════════════

describe('switcher 的 Groups 段', () => {
	const groups: GroupRowItem[] = [
		{ name: 'fta', summary: '6 members · dev · squash · copy', locked: false },
		{ name: 'broken', summary: '2 members · (未解析) · merge · copy', locked: true },
	];

	it('渲染 Groups 段 + 4 种宽度不超宽', async () => {
		const m = mount((ctx) => showWorktreeTui(ctx, [], null, '', '/nonexistent', groups));
		const c = m.component();
		assertWidths((w) => c.render(w), [60, 80, 120, 200]);
		const text = stripAnsi(c.render(80).join('\n'));
		expect(text).toContain('Groups');
		expect(text).toContain('fta');
		expect(text).toContain('6 members · dev · squash · copy');
		// 解析失败的组带 ! 提示（仍可进入看原因）
		expect(text).toContain('! broken');
	});

	it('Enter 在组行 → action=group-ops（不是 operations）', () => {
		const m = mount((ctx) => showWorktreeTui(ctx, [], null, '', '/nonexistent', groups));
		const c = m.component();
		// 默认光标落在「当前所在」的 main 行；Groups 段在列表上方，向上可达
		c.handleInput('\x1b[A');
		c.handleInput('\x1b[A');
		expect(m.result()).toBeUndefined();
		c.handleInput('\r');
		expect(m.result()).toEqual({ action: 'group-ops', target: 'fta' });
	});

	it('解析失败的组仍可进入（看得到原因，不静默消失）', () => {
		const m = mount((ctx) => showWorktreeTui(ctx, [], null, '', '/nonexistent', groups));
		const c = m.component();
		c.handleInput('\x1b[A'); // main → broken
		c.handleInput('\r');
		expect(m.result()).toEqual({ action: 'group-ops', target: 'broken' });
	});

	it('g 键 → action=group-new（建组向导入口）', () => {
		const m = mount((ctx) => showWorktreeTui(ctx, [], null, '', '/nonexistent', groups));
		m.component().handleInput('g');
		expect(m.result()).toEqual({ action: 'group-new' });
	});

	it('无组时：不出现 Groups 段，Enter 仍是旧行为（main 直切）', () => {
		const m = mount((ctx) => showWorktreeTui(ctx, [], null, '', '/nonexistent'));
		const text = stripAnsi(m.component().render(80).join('\n'));
		expect(text).not.toContain('Groups');
		expect(text).toContain('Worktrees');
		m.component().handleInput('\r');
		expect(m.result()?.action).toBe('switch');
	});
});

// ═══════════════════════════════════════════
// 候选多选：锁定项禁选
// ═══════════════════════════════════════════

describe('候选多选面板（锁定项灰显禁选）', () => {
	const cand: GroupCandidates = {
		group: 'fta',
		base: { branch: 'dev', source: 'baseRef', isLocal: true },
		selectable: ['alpha'],
		items: [
			{
				name: 'alpha',
				branch: 'wt/alpha',
				path: '/nonexistent/alpha',
				exists: true,
				ahead: 2,
				dirty: 0,
				status: 'ready',
				locked: false,
				reason: '2 个提交待合入',
			},
			{
				name: 'dirty-one',
				branch: 'wt/dirty-one',
				path: '/nonexistent/d',
				exists: true,
				ahead: 0,
				dirty: 3,
				status: 'dirty',
				locked: true,
				reason: '有 3 处未提交改动',
			},
		],
	};

	it('渲染：锁定项 [-] 且带原因，宽度安全', async () => {
		const m = mount((ctx) => showGroupCandidatePanel(ctx, cand, 'merge'));
		const c = m.component();
		assertWidths((w) => c.render(w), [60, 80, 120]);
		const text = stripAnsi(c.render(80).join('\n'));
		expect(text).toContain('[x] alpha');
		expect(text).toContain('[-] dirty-one');
		expect(text).toContain('有 3 处未提交改动');
	});

	it('space 打不开锁定项；Enter 只返回可选项', async () => {
		const m = mount((ctx) => showGroupCandidatePanel(ctx, cand, 'merge'));
		const c = m.component();
		c.handleInput('\u001b[B'); // down → 锁定项
		c.handleInput(' '); // 试图打开锁定项（应无效）
		c.handleInput('\r');
		expect(m.result()).toEqual(['alpha']);
	});

	it('全部取消选择 → 返回 null（不执行任何成员）', async () => {
		const m = mount((ctx) => showGroupCandidatePanel(ctx, cand, 'merge'));
		const c = m.component();
		c.handleInput(' '); // 关闭唯一可选项
		c.handleInput('\r');
		expect(m.result()).toBeNull();
	});
});

describe('统一对齐面板', () => {
	it('默认全选；Esc = 跳过（null）', async () => {
		const m = mount((ctx) => showUnifiedAlignPanel(ctx, ['alpha', 'beta'], 'dev'));
		const c = m.component();
		const text = stripAnsi(c.render(80).join('\n'));
		expect(text).toContain('统一对齐到 dev');
		expect(text).toContain('[x] alpha');
		expect(text).toContain('[x] beta');
		c.handleInput('\r');
		expect(m.result()).toEqual(['alpha', 'beta']);

		const m2 = mount((ctx) => showUnifiedAlignPanel(ctx, ['alpha'], 'dev'));
		m2.component().handleInput('\u001b');
		expect(m2.result()).toBeNull();
	});
});

// ═══════════════════════════════════════════
// 建组向导
// ═══════════════════════════════════════════

describe('建组向导（6 步）', () => {
	let baseDir: string;
	let repo: string;

	beforeEach(() => {
		baseDir = resolve(
			tmpdir(),
			'pi-wt-wizard-' + Date.now() + '-' + Math.random().toString(36).slice(2),
		);
		repo = join(baseDir, 'repo');
		mkdirSync(repo, { recursive: true });
		execSync('git init --initial-branch main -q', { cwd: repo });
		execSync('git commit --allow-empty -m init -q', { cwd: repo });
		execSync('git branch dev', { cwd: repo });
		expect(createWorktree(repo, 'alpha', 'none', undefined, {}).ok).toBe(true);
		expect(createWorktree(repo, 'beta', 'none', undefined, {}).ok).toBe(true);
	});

	afterEach(() => {
		rmSync(`${repo}-worktrees`, { recursive: true, force: true });
		rmSync(baseDir, { recursive: true, force: true });
	});

	it('默认全选成员 + 默认 squash/copy；每步渲染不超宽', async () => {
		const m = mount((ctx) => runGroupWizard(ctx, repo));
		const c = m.component();
		assertWidths((w) => c.render(w), [60, 80, 120]);
		expect(stripAnsi(c.render(80).join('\n'))).toContain('新建组 1/6');

		for (const ch of ['f', 't', 'a']) c.handleInput(ch); // 组名
		c.handleInput('\r'); // → 2/6 目标分支
		expect(stripAnsi(c.render(80).join('\n'))).toContain('目标分支');
		assertWidths((w) => c.render(w), [60, 80, 120]);
		c.handleInput('\r'); // → 3/6 成员
		const memberText = stripAnsi(c.render(80).join('\n'));
		expect(memberText).toContain('[x] alpha');
		expect(memberText).toContain('[x] beta');
		c.handleInput('\r'); // → 4/6 策略
		expect(stripAnsi(c.render(80).join('\n'))).toContain('squash');
		c.handleInput('\r'); // → 5/6 env
		const envText = stripAnsi(c.render(80).join('\n'));
		expect(envText).toContain('node_modules 策略');
		expect(envText).toContain('空间：');
		c.handleInput('\r'); // → 6/6 确认
		const confirmText = stripAnsi(c.render(80).join('\n'));
		expect(confirmText).toContain('确认声明');
		expect(confirmText).toContain('2 个：alpha, beta');
		c.handleInput('\r'); // 保存

		const r = m.result();
		expect(r?.name).toBe('fta');
		expect(r?.group.members).toEqual(['alpha', 'beta']);
		expect(r?.group.mergeStrategy).toBe('squash');
		expect(r?.group.env?.nodeModules).toBe('copy');
		// 默认走解析链：不写死 baseRef
		expect(r?.group.baseRef).toBeUndefined();
	});

	it('成员可取消勾选；目标分支可选列表中的具体分支', async () => {
		const m = mount((ctx) => runGroupWizard(ctx, repo));
		const c = m.component();
		c.handleInput('x');
		c.handleInput('\r'); // name
		c.handleInput('\u001b[B'); // 目标分支：跳过「自动」→ 第一个本地分支
		c.handleInput('\r');
		c.handleInput('\r'); // 成员：保持默认全选
		c.handleInput('\r'); // 策略
		c.handleInput('\r'); // env
		c.handleInput('\r'); // 确认
		const r = m.result();
		expect(r?.name).toBe('x');
		expect(typeof r?.group.baseRef).toBe('string');
		expect(r?.group.members.length).toBe(2);
	});

	it('Esc 在任一步 = 整体取消（返回 null，不落半成品）', async () => {
		const m = mount((ctx) => runGroupWizard(ctx, repo));
		const c = m.component();
		c.handleInput('a');
		c.handleInput('\u001b');
		expect(m.result()).toBeNull();
	});

	it('改组：回显现有声明（组名/策略/成员）', async () => {
		const m = mount((ctx) =>
			runGroupWizard(ctx, repo, {
				existingName: 'fta',
				existing: {
					members: ['beta'],
					baseRef: 'dev',
					mergeStrategy: 'merge',
					env: { nodeModules: 'symlink', symlinkTargetIds: [] },
				},
			}),
		);
		const c = m.component();
		const text = stripAnsi(c.render(80).join('\n'));
		expect(text).toContain('编辑组 1/6');
		expect(text).toContain('> fta');
		c.handleInput('\r'); // 名称回车 = 用当前值
		c.handleInput('\r');
		const memberText = stripAnsi(c.render(80).join('\n'));
		expect(memberText).toContain('[x] beta');
		expect(memberText).toContain('alpha'); // 未勾选
		c.handleInput('\r');
		expect(stripAnsi(c.render(80).join('\n'))).toContain('merge');
		c.handleInput('\r');
		expect(stripAnsi(c.render(80).join('\n'))).toContain('整目录软链');
		c.handleInput('\r');
		c.handleInput('\r');
		const r = m.result();
		expect(r?.name).toBe('fta');
		expect(r?.group.members).toEqual(['beta']);
		expect(r?.group.baseRef).toBe('dev');
		expect(r?.group.mergeStrategy).toBe('merge');
		expect(r?.group.env?.nodeModules).toBe('symlink');
	});
});

// ═══════════════════════════════════════════
// 二级组菜单（组行的主入口）与动作分发
// ═══════════════════════════════════════════

/**
 * 分发用挂载：与上面的 mount 不同，这里 `ui.custom` 返回的 Promise 由**组件 done** 决定，
 * 因此可以驱动 `runGroupMenuFlow` 这类「await 面板结果再分发」的流程。
 */
function mountFlow(
	run: (ctx: any) => Promise<void>,
	notes: string[],
): { component: (i?: number) => any; promise: Promise<void> } {
	const comps: any[] = [];
	const tui = { requestRender: () => {} } as any;
	const ctx = {
		hasUI: true,
		cwd: '/nonexistent',
		ui: {
			custom: (cb: any) =>
				new Promise((resolve) => {
					comps.push(
						cb(
							tui,
							mockTheme(),
							{ matches: () => false, getDefinition: () => undefined },
							(v: any) => resolve(v),
						),
					);
				}),
			notify: (m: string, l?: string) => notes.push(`${l ?? 'info'}:${m}`),
			confirm: async () => true,
		},
	} as any;
	return { component: (i = 0) => comps[i], promise: run(ctx) };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('二级组菜单与动作分发（ADR-0062 决策 11：TUI 主入口）', () => {
	let baseDir: string;
	let repo: string;
	const group = { baseRef: 'main', members: ['alpha', 'beta'], mergeStrategy: 'squash' as const };

	beforeEach(() => {
		baseDir = resolve(
			tmpdir(),
			'pi-wt-gmenu-' + Date.now() + '-' + Math.random().toString(36).slice(2),
		);
		repo = join(baseDir, 'repo');
		mkdirSync(repo, { recursive: true });
		execSync('git init --initial-branch main -q', { cwd: repo });
		execSync('git commit --allow-empty -m init -q', { cwd: repo });
	});

	afterEach(() => {
		rmSync(`${repo}-worktrees`, { recursive: true, force: true });
		rmSync(baseDir, { recursive: true, force: true });
	});

	it('渲染：4 宽度不超宽、标题含组名与解析后的目标分支、footer 列成员', async () => {
		const m = mount((ctx) => showGroupMenu(ctx, repo, 'fta', group));
		const c = m.component();
		assertWidths((w) => c.render(w), [40, 60, 80, 120, 200]);
		const text = stripAnsi(c.render(80).join('\n'));
		expect(text).toContain('组 fta');
		expect(text).toContain('main');
		expect(text).toContain('2 members: alpha, beta');
	});

	it('Enter 在各光标位返回对应 action；Esc = null', async () => {
		const first = mount((ctx) => showGroupMenu(ctx, repo, 'fta', group));
		first.component().handleInput('\r');
		expect(first.result()).toBe('merge');

		const last = mount((ctx) => showGroupMenu(ctx, repo, 'fta', group));
		for (let i = 0; i < 4; i++) last.component().handleInput('\u001b[B');
		last.component().handleInput('\r');
		expect(last.result()).toBe('delete');

		const esc = mount((ctx) => showGroupMenu(ctx, repo, 'fta', group));
		esc.component().handleInput('\u001b');
		expect(esc.result()).toBeNull();
	});

	it('runGroupMenuFlow：delete → 只删声明（worktree 与分支不动）', async () => {
		saveGroup(repo, 'fta', group);
		expect(createWorktree(repo, 'alpha', 'none', undefined, {}).ok).toBe(true);

		const notes: string[] = [];
		const flow = mountFlow((ctx) => runGroupMenuFlow(repo, 'fta', ctx), notes);
		await tick();
		for (let i = 0; i < 4; i++) flow.component().handleInput('\u001b[B');
		flow.component().handleInput('\r');
		await flow.promise;

		expect(loadGroups(repo).groups.fta).toBeUndefined();
		expect(existsSync(resolveWorktreePath(repo, 'alpha'))).toBe(true);
		expect(notes.join('\n')).toContain("已删除组声明 'fta'");
	});

	it('runGroupMenuFlow：merge → 进入候选多选（不直接执行）', async () => {
		saveGroup(repo, 'fta', group);
		expect(createWorktree(repo, 'alpha', 'none', undefined, {}).ok).toBe(true);

		const flow = mountFlow((ctx) => runGroupMenuFlow(repo, 'fta', ctx), []);
		await tick();
		flow.component(0).handleInput('\r'); // 菜单默认首项 = merge
		await tick();

		const cand = flow.component(1);
		expect(cand).toBeTruthy();
		const text = stripAnsi(cand.render(80).join('\n'));
		expect(text).toContain('合并成员');
		expect(text).toContain('组 fta');
	});

	it('runGroupMenuFlow：edit → 打开改组向导（回显现有声明）', async () => {
		saveGroup(repo, 'fta', group);

		const flow = mountFlow((ctx) => runGroupMenuFlow(repo, 'fta', ctx), []);
		await tick();
		for (let i = 0; i < 3; i++) flow.component(0).handleInput('\u001b[B'); // → edit
		flow.component(0).handleInput('\r');
		await tick();

		const wizard = flow.component(1);
		expect(wizard).toBeTruthy();
		expect(stripAnsi(wizard.render(80).join('\n'))).toContain('编辑组 1/6');
	});
});
