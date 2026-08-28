/**
 * merge 冲突面板 + 内嵌提示词 — 测试（ticket 10）
 *
 * 覆盖：
 *   - buildConflictResolvePrompt：第 5 步按 merge/rebase 定制 + 冲突文件清单
 *   - showConflictPanel：中文 4 选项 + ↑↓/Enter/Esc 交互（headless）
 */
import { describe, it, expect } from 'vitest';
import {
	buildConflictResolvePrompt,
	showConflictPanel,
} from '../../../extensions/meta/worktree/lib/ui.ts';
import { stripAnsi, assertWithinWidth } from '../../../src/tui-testing/index.js';

// ── buildConflictResolvePrompt ──

describe('buildConflictResolvePrompt', () => {
	const base = {
		sourceBranch: 'wt/pi-lab',
		targetBranch: 'main',
		conflicts: [{ file: 'src/a.ts' }, { file: 'src/b.ts' }],
	};

	it('merge 策略：第 5 步是 git commit，不含 rebase --continue', () => {
		const prompt = buildConflictResolvePrompt({ ...base, strategy: 'merge' });
		expect(prompt).toContain('git commit');
		expect(prompt).not.toContain('rebase --continue');
	});

	it('rebase 策略：第 5 步是 git rebase --continue 且提醒多轮', () => {
		const prompt = buildConflictResolvePrompt({ ...base, strategy: 'rebase' });
		expect(prompt).toContain('git rebase --continue');
		expect(prompt).toContain('直到所有 commit');
	});

	it('包含冲突文件清单与分支名', () => {
		const prompt = buildConflictResolvePrompt({ ...base, strategy: 'merge' });
		expect(prompt).toContain('wt/pi-lab');
		expect(prompt).toContain('main');
		expect(prompt).toContain('src/a.ts');
		expect(prompt).toContain('src/b.ts');
	});

	it('含「只 resolve 不要 --abort」约束', () => {
		const prompt = buildConflictResolvePrompt({ ...base, strategy: 'merge' });
		expect(prompt).toContain('--abort');
		expect(prompt).toContain('resolve');
	});

	it('stash-pop 策略：第 5 步仅 git add（无需 commit），标题说明合并已成功', () => {
		const prompt = buildConflictResolvePrompt({ ...base, strategy: 'stash-pop' });
		expect(prompt).toContain('合并已成功');
		expect(prompt).toContain('stash pop');
		expect(prompt).toContain('git add');
		expect(prompt).toContain('无需 commit');
		expect(prompt).not.toContain('git rebase --continue');
	});
});

// ── showConflictPanel ──

function mockTheme(): any {
	return {
		fg: (_c: string, text: string) => text,
		bg: (_c: string, text: string) => text,
		bold: (text: string) => text,
	};
}

function mountPanel(
	conflicts: Array<{ file: string; lines: string }>,
	variant: 'merge' | 'stash-pop' = 'merge',
) {
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
	void showConflictPanel(ctx, conflicts, '/repo', undefined, variant);
	return {
		render: (width: number) => component.render(width),
		handleInput: (data: string) => component.handleInput(data),
		getDone: () => doneValue,
	};
}

describe('showConflictPanel (headless)', () => {
	const conflicts = [{ file: 'src/a.ts', lines: '@@ 1,2 @@' }];

	it('渲染中文 4 选项 + 冲突文件，多宽度不超宽', () => {
		const { render } = mountPanel(conflicts);
		for (const w of [40, 80, 120]) {
			assertWithinWidth(render(w), w);
		}
		const text = stripAnsi(render(80).join('\n'));
		expect(text).toContain('冲突');
		expect(text).toContain('src/a.ts');
		expect(text).toContain('让 Agent 尝试修复');
		expect(text).toContain('打开终端自己解决');
		expect(text).toContain('中止并回滚');
		expect(text).toContain('停留');
	});

	it('Enter 默认选中第一项 → agent', () => {
		const { handleInput, getDone } = mountPanel(conflicts);
		handleInput('\r');
		expect(getDone()).toEqual({ action: 'agent' });
	});

	it('Down x3 + Enter → stay（第 4 项）', () => {
		const { handleInput, getDone } = mountPanel(conflicts);
		handleInput('\x1b[B');
		handleInput('\x1b[B');
		handleInput('\x1b[B');
		handleInput('\r');
		expect(getDone()).toEqual({ action: 'stay' });
	});

	it('Esc → stay', () => {
		const { handleInput, getDone } = mountPanel(conflicts);
		handleInput('\x1b');
		expect(getDone()).toEqual({ action: 'stay' });
	});

	it('stash-pop 变体：渲染 3 选项（无 abort）+ 标题区分，多宽度不超宽', () => {
		const { render } = mountPanel(conflicts, 'stash-pop');
		for (const w of [40, 80, 120]) {
			assertWithinWidth(render(w), w);
		}
		const text = stripAnsi(render(80).join('\n'));
		expect(text).toContain('恢复未提交改动时冲突');
		expect(text).toContain('让 Agent 尝试修复');
		expect(text).toContain('打开终端自己解决');
		expect(text).toContain('停留');
		expect(text).not.toContain('中止并回滚');
	});

	it('stash-pop 变体：Down x2 + Enter → stay（第 3 项）', () => {
		const { handleInput, getDone } = mountPanel(conflicts, 'stash-pop');
		handleInput('\x1b[B');
		handleInput('\x1b[B');
		handleInput('\r');
		expect(getDone()).toEqual({ action: 'stay' });
	});
});
