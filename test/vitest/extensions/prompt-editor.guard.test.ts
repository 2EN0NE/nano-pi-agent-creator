/**
 * prompt-editor — preset 子工具锁死守卫接线（ADR-0049 决策 4）
 *
 * preset 激活期间，/prompt 面板对 `preset_instructions` 组件的写操作
 * （toggle / edit）必须被 `globalThis.__presetGuard.canModify('instructions', …)`
 * 拒绝并给出 error 告警。本文件驱动真实 prompt-editor 面板，覆盖：
 *   - toggle 被拒：不改变 override、notify error
 *   - 守卫放行时 toggle 正常生效
 *
 * 与 skills-guard.test.ts 同口径：只 mock UI 组件依赖，守卫接线走真实路径。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { assertWithinWidth } from '../../../src/tui-testing/index.js';
import { showPromptPanel } from '../../../extensions/meta/preset/prompt-editor.js';
import type { BuildSystemPromptOptions } from '@earendil-works/pi-coding-agent';

function mockOptions(): BuildSystemPromptOptions {
	return {
		cwd: '/tmp',
		customPrompt: 'System prompt content',
		contextFiles: [],
		toolSnippets: { bash: 'run bash' },
		promptGuidelines: [],
		skills: [],
	} as unknown as BuildSystemPromptOptions;
}

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

interface Harness {
	render: (width?: number) => string[];
	handleInput: (data: string) => void;
	notifyCalls: Array<{ message: string; type: string }>;
	/** 光标所在行的中文标签对应的行号（1-based） */
	rowOf: (needle: string) => number;
}

function mountPanel(options: BuildSystemPromptOptions): Harness {
	let component: any = null;
	const notifyCalls: Array<{ message: string; type: string }> = [];
	const tui = { requestRender: () => {} } as any;
	const ctx = {
		hasUI: true,
		cwd: '/tmp',
		getSystemPromptOptions: () => options,
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
			editor: async () => undefined,
			notify: (message: string, type: string) => notifyCalls.push({ message, type }),
		},
	} as any;
	void showPromptPanel(ctx, options);
	const render = (width = 80) =>
		component.render(width).map((l: string) => l.replace(/\x1b\[[0-9;]*m/g, ''));
	return {
		render,
		handleInput: (data: string) => component.handleInput(data),
		notifyCalls,
		rowOf: (needle: string) => {
			for (const line of render()) {
				if (line.includes(needle)) {
					const m = line.match(/^\s*(\d+)/);
					if (m) return Number(m[1]);
				}
			}
			return 0;
		},
	};
}

describe('prompt-editor — preset 子工具锁死守卫（ADR-0049 决策 4）', () => {
	beforeEach(() => {
		(globalThis as Record<string, unknown>).__presetApi = {
			getInstructions: () => 'be concise',
		};
	});

	afterEach(() => {
		delete (globalThis as Record<string, unknown>).__presetApi;
		delete (globalThis as Record<string, unknown>).__presetGuard;
	});

	function moveCursorTo(harness: Harness, needle: string): number {
		const target = harness.rowOf(needle);
		expect(target).toBeGreaterThan(0);
		for (let i = 1; i < target; i++) harness.handleInput('\x1b[B');
		return target;
	}

	it('preset 激活：toggle 被拒绝（override 不变 + error 告警）', () => {
		(globalThis as Record<string, unknown>).__presetGuard = {
			canModify: () => ({
				allowed: false,
				reason: 'preset「plan」已激活，指令 修改不被允许',
			}),
		};
		const harness = mountPanel(mockOptions());
		moveCursorTo(harness, '预设 Instructions');

		harness.handleInput(' ');

		// 拒绝：仍在 enabled 态（未 toggle 成 [ ]），且给出 error 告警
		const row = harness.render().find((l) => l.includes('预设 Instructions')) ?? '';
		expect(row).toContain('[x]');
		expect(
			harness.notifyCalls.some(
				(c) => c.type === 'error' && c.message.includes('修改不被允许'),
			),
		).toBe(true);
		assertWithinWidth(harness.render(80), 80);
	});

	it('未激活 preset（guard 放行）：toggle 正常生效', () => {
		(globalThis as Record<string, unknown>).__presetGuard = {
			canModify: () => ({ allowed: true }),
		};
		const harness = mountPanel(mockOptions());
		moveCursorTo(harness, '预设 Instructions');

		harness.handleInput(' ');

		const row = harness.render().find((l) => l.includes('预设 Instructions')) ?? '';
		expect(row).toContain('[ ]');
		expect(harness.notifyCalls.some((c) => c.type === 'error')).toBe(false);
	});
});
