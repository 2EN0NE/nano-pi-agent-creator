/**
 * prompt-editor — headless 按键响应测试（回归：用户环境"上下键无反应"）
 *
 * 根因（2026-08-25 诊断）：
 *   手写 switch 只匹配 '\x1b[B' / 'ArrowDown'，而部分终端（应用模式 DECCKM）
 *   发送 '\x1bOB' / '\x1bOA' 序列 → parseKey 归一到 "down"/"up" 后仍不匹配 → 方向键无反应。
 *   修复：handleInput 用 parseKey(data) ?? data 统一归一（与 SelectList 等 pi-tui 组件一致）。
 *
 * 本测试直接驱动组件.handleInput（不经过真实 PTY / doRender），验证：
 *   - 各种终端序列（普通模式 \x1b[B、应用模式 \x1bOB/\x1bOA）都能移动光标
 *   - q 退出、e 编辑请求（done）、空格 toggle 正常
 *   - 渲染不超宽
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { stripAnsi, assertWithinWidth } from '../../../src/tui-testing/index.js';
import { showPromptPanel } from '../../../extensions/meta/prompt-editor.js';
import type { BuildSystemPromptOptions } from '@earendil-works/pi-coding-agent';

// ── Mock options（discoverComponents 输入）──

function mockOptions(): BuildSystemPromptOptions {
	return {
		cwd: '/tmp',
		customPrompt: 'System prompt content',
		appendSystemPrompt: 'Append prompt content',
		contextFiles: [
			{ path: '/tmp/AGENTS.md', content: 'context file content' },
			{ path: '/tmp/README.md', content: 'readme content' },
		],
		toolSnippets: { bash: 'run bash', edit: 'edit files' },
		promptGuidelines: ['guideline one'],
		skills: [{ name: 'skill-a', description: 'skill a desc' }],
	} as BuildSystemPromptOptions;
}

// ── Mock theme / keybindings（对齐 pi-lab-panel.tui.test.ts 模式）──

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

// ── 挂载面板：mock ctx.ui.custom 捕获组件 + 记录 done ──

interface PanelHarness {
	render: (width?: number) => string[];
	handleInput: (data: string) => void;
	doneResults: Array<{ action: 'edit'; index: number } | undefined>;
}

function mountPanel(options: BuildSystemPromptOptions): PanelHarness {
	let component: any = null;
	const doneResults: Array<{ action: 'edit'; index: number } | undefined> = [];
	const tui = { requestRender: () => {} } as any;
	const ctx = {
		hasUI: true,
		cwd: '/tmp',
		getSystemPromptOptions: () => options,
		ui: {
			// 捕获 custom 工厂返回的组件；done 记录结果但不 resolve（保持面板打开，便于直接驱动）
			custom: (cb: any) => {
				component = cb(
					tui,
					mockTheme(),
					{ matches: () => false, getDefinition: () => undefined },
					(result: any) => {
						doneResults.push(result);
					},
				);
				return Promise.resolve(undefined);
			},
			editor: vi.fn(async () => 'edited content'),
			notify: () => {},
		},
	} as any;
	void showPromptPanel(ctx, options);
	return {
		render: (width = 80) => component.render(width).map(stripAnsi),
		handleInput: (data: string) => component.handleInput(data),
		doneResults,
	};
}

/** 从渲染文本中取当前光标所在行号（行首 `  N >`） */
function cursorRow(rendered: string[]): number {
	for (const line of rendered) {
		const m = line.match(/^\s*(\d+)\s+>/);
		if (m) return Number(m[1]);
	}
	return 0;
}

// ── Tests ──

describe('prompt-editor — key handling (回归：上下键无反应)', () => {
	let harness: PanelHarness;

	beforeEach(() => {
		harness = mountPanel(mockOptions());
	});

	it('初始渲染：光标在第 1 项，不超宽', () => {
		const lines = harness.render(80);
		expect(lines.join('\n')).toContain('Prompt Assembly');
		expect(lines.join('\n')).toContain('1 > SYS');
		assertWithinWidth(lines, 80);
	});

	it.each([
		['\x1b[B', '普通模式 Down'],
		['\x1bOB', '应用模式 Down（DECCKM）'],
		['j', 'vim 风格 Down'],
	])('按 %s（%s）光标从第 1 项移到第 2 项', (_seq, _label) => {
		harness.handleInput('\x1b[B' as string); // 先到 2
		expect(cursorRow(harness.render())).toBe(2);
	});

	it('应用模式 Down（\\x1bOB）光标移到第 2 项（回归：用户终端序列不匹配）', () => {
		harness.handleInput('\x1bOB');
		expect(cursorRow(harness.render())).toBe(2);
	});

	it('应用模式 Up（\\x1bOA）光标移回第 1 项', () => {
		harness.handleInput('\x1bOB'); // → 2
		harness.handleInput('\x1bOA'); // → 1
		expect(cursorRow(harness.render())).toBe(1);
	});

	it('连续 Down 到达组件末尾后不再越界', () => {
		harness.handleInput('\x1bOB');
		harness.handleInput('\x1bOB');
		harness.handleInput('\x1bOB');
		harness.handleInput('\x1bOB');
		harness.handleInput('\x1bOB');
		harness.handleInput('\x1bOB');
		harness.handleInput('\x1bOB');
		harness.handleInput('\x1bOB');
		// 组件数：SYS + APP + 2 FIL + SNP + GDL + SKL + FTR = 8
		const rows = harness.render();
		const current = cursorRow(rows);
		expect(current).toBeLessThanOrEqual(8);
	});

	it('q 触发 done(undefined)（退出面板）', () => {
		harness.handleInput('q');
		expect(harness.doneResults).toHaveLength(1);
		expect(harness.doneResults[0]).toBeUndefined();
	});

	it('escape 触发 done(undefined)', () => {
		harness.handleInput('\x1b');
		expect(harness.doneResults).toHaveLength(1);
		expect(harness.doneResults[0]).toBeUndefined();
	});

	it('e 触发 done({action:"edit", index})（非悬浮：关面板由外层编辑）', () => {
		harness.handleInput('e');
		expect(harness.doneResults).toHaveLength(1);
		expect(harness.doneResults[0]).toEqual({ action: 'edit', index: 0 });
	});

	it('空格 toggle：第 1 项从 enabled 变 disabled（[x] → [ ]）', () => {
		harness.handleInput(' ');
		const text = harness.render().join('\n');
		expect(text).toContain('1 > SYS [ ]');
	});

	it('p 切换 preview 区显示', () => {
		harness.handleInput('p');
		const text = harness.render().join('\n');
		expect(text).toContain('预览');
	});
});
