/**
 * worktree 切换器面板 — Headless TUI snapshot tests
 *
 * 按项目「TUI 测试强制要求」验证：
 *   - 标题嵌入上边框（── pi-worktree ──...），2+ 宽度不超宽、不崩溃
 *   - cwd 位于 worktree 时，cwd 行显示 worktree 名
 */
import { describe, it, expect } from 'vitest';
import { showWorktreeTui } from '../../../extensions/meta/worktree/lib/ui.js';
import { stripAnsi, assertWithinWidth } from '../../../src/tui-testing/index.js';

// ── Mock theme（无色，纯文本透传，便于 stripAnsi 后断言） ──

function mockTheme(): any {
	return {
		fg: (_color: string, text: string) => text,
		bg: (_c: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		underline: (text: string) => text,
		inverse: (text: string) => text,
		strikethrough: (text: string) => text,
		getFgAnsi: () => '',
		getBgAnsi: () => '',
		getColorMode: () => 'truecolor' as const,
	};
}

// ── 挂载面板：mock ctx.ui.custom 捕获组件 ──
// 路径传 /nonexistent（getAheadBehind/getDirtyCount 的 git 调用失败返回 0，不抛异常）

function mountPanel(
	worktrees: Array<{ name: string; branch: string; path: string }>,
	currentName: string | null,
): { render: (width: number) => string[]; handleInput: (data: string) => void } {
	let component: any = null;
	const tui = { requestRender: () => {} } as any;
	const ctx = {
		ui: {
			custom: (cb: any) => {
				component = cb(
					tui,
					mockTheme(),
					{ matches: () => false, getDefinition: () => undefined },
					() => {},
				);
				return Promise.resolve(undefined);
			},
		},
	} as any;
	void showWorktreeTui(ctx, worktrees, currentName, '', '/nonexistent/repo-root');
	return {
		render: (width: number) => component.render(width),
		handleInput: (data: string) => component.handleInput(data),
	};
}

describe('worktree switcher panel (headless snapshot)', () => {
	const worktrees = [
		{ name: 'Virgo-Spica', branch: 'wt/tui-design', path: '/nonexistent/wt1' },
		{ name: 'Aries-Hamal', branch: 'wt/hamal', path: '/nonexistent/wt2' },
	];

	it('标题嵌入上边框（── pi-worktree ──...），2+ 宽度不超宽、不崩溃', () => {
		const { render } = mountPanel(worktrees, null);
		for (const width of [60, 80, 120]) {
			const lines = render(width);
			expect(() => assertWithinWidth(lines, width)).not.toThrow();
			const first = stripAnsi(lines[0]);
			expect(first).toMatch(/^── pi-worktree /);
			// 首行 = 标题 + 右侧填充 ─ 到恰好 width
			expect(first.length).toBe(width);
			// 底部边框行也应为 width
			expect(stripAnsi(lines[lines.length - 1]).length).toBe(width);
		}
	});

	it('cwd 位于 worktree 时：cwd 行显示 worktree 名', () => {
		const { render } = mountPanel(worktrees, 'Virgo-Spica');
		const lines = stripAnsi(render(80).join('\n'));
		expect(lines).toContain('cwd: Virgo-Spica');
		expect(lines).toContain('Virgo-Spica');
		expect(lines).toContain('Aries-Hamal');
	});

	it('cwd 在主仓库时：cwd 行显示 main', () => {
		const { render } = mountPanel(worktrees, null);
		const lines = stripAnsi(render(80).join('\n'));
		expect(lines).toContain('cwd: main');
	});

	it('窄宽度不崩溃（标题行被截断兜底）', () => {
		const { render } = mountPanel(worktrees, null);
		const lines = render(30);
		expect(() => assertWithinWidth(lines, 30)).not.toThrow();
	});
});
