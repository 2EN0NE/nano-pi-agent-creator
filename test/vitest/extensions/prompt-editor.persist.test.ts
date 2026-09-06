/**
 * prompt-editor — overrides 会话级持久化（T1）
 *
 * 验证：overrides 组件覆盖写入 session branch（appendEntry 'prompt-overrides'），
 * session_start 从 branch 恢复（/reload 后编辑仍生效）。
 */
import { describe, it, expect } from 'vitest';
import promptEditorExtension, {
	showPromptPanel,
} from '../../../extensions/meta/preset/prompt-editor.js';
import { stripAnsi } from '../../../src/tui-testing/index.js';
import type { BuildSystemPromptOptions } from '@earendil-works/pi-coding-agent';

function mockOptions(): BuildSystemPromptOptions {
	return {
		cwd: '/tmp',
		customPrompt: 'System prompt content',
		appendSystemPrompt: 'Append prompt content',
		contextFiles: [{ path: '/tmp/AGENTS.md', content: 'context file content' }],
		toolSnippets: { bash: 'run bash' },
		promptGuidelines: ['guideline one'],
		skills: [{ name: 'skill-a', description: 'skill a desc' }],
	} as unknown as BuildSystemPromptOptions;
}

function mockTheme(): any {
	return {
		fg: (_c: string, text: string) => text,
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

interface AppendEntry {
	customType: string;
	data: unknown;
}

interface PanelHarness {
	render: () => string[];
	handleInput: (data: string) => void;
}

function mountPanel(options: BuildSystemPromptOptions): PanelHarness {
	let component: any = null;
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
			editor: async () => 'edited content',
			notify: () => {},
		},
	} as any;
	void showPromptPanel(ctx, options);
	return {
		render: () => component.render(80).map(stripAnsi),
		handleInput: (data: string) => component.handleInput(data),
	};
}

describe('prompt-editor — overrides 会话级持久化', () => {
	it('toggle 后 appendEntry 持久化 prompt-overrides', async () => {
		const appendEntries: AppendEntry[] = [];
		const pi = {
			on: () => {},
			registerCommand: () => {},
			appendEntry: (customType: string, data: unknown) => {
				appendEntries.push({ customType, data });
			},
		};
		promptEditorExtension(pi as never);

		const harness = mountPanel(mockOptions());
		harness.handleInput(' '); // toggle 第 1 项（SYS）

		expect(appendEntries.some((e) => e.customType === 'prompt-overrides')).toBe(true);
		const persisted = appendEntries.find((e) => e.customType === 'prompt-overrides');
		const data = persisted?.data as { components: Record<string, { enabled: boolean }> };
		expect(data.components).toBeDefined();
	});

	it('session_start 从 branch 恢复 overrides（多组件 + content 字段）', async () => {
		const handlers: Record<string, Array<(e: unknown, ctx: unknown) => unknown>> = {};
		const pi = {
			on: (event: string, handler: (e: unknown, ctx: unknown) => unknown) => {
				(handlers[event] ??= []).push(handler);
			},
			registerCommand: () => {},
			appendEntry: () => {},
		};
		promptEditorExtension(pi as never);

		// 模拟 /reload：branch 里有上一会话的 prompt-overrides，
		// 含两个组件（SYS 禁用 + 上下文文件禁用），均带 content 覆盖。
		// 测试环境无 SYSTEM.md，detectSystemPromptSource 返回 '(built-in default)'。
		const ctx = {
			sessionManager: {
				getBranch: () => [
					{
						type: 'custom',
						customType: 'prompt-overrides',
						data: {
							components: {
								'system_prompt:(built-in default)': {
									enabled: false,
									content: 'edited sys content',
								},
								'context_file:/tmp/AGENTS.md': {
									enabled: false,
									content: 'edited agents content',
								},
							},
						},
					},
				],
			},
		};
		await handlers['session_start'][0](null, ctx);

		// 多组件 + content 字段均被恢复
		const api = (globalThis as Record<string, unknown>).__promptEditorApi as {
			getOverride: (key: string) => { enabled: boolean; content?: string } | undefined;
		};
		expect(api.getOverride('system_prompt:(built-in default)')).toEqual({
			enabled: false,
			content: 'edited sys content',
		});
		expect(api.getOverride('context_file:/tmp/AGENTS.md')).toEqual({
			enabled: false,
			content: 'edited agents content',
		});

		// 挂载面板：SYS 组件应显示 [ ]（disabled，说明恢复生效）
		const harness = mountPanel(mockOptions());
		const text = harness.render().join('\n');
		expect(text).toContain('SYS [ ]');
	});
});
