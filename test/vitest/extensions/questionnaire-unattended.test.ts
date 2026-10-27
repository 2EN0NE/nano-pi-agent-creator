/**
 * questionnaire — 远端豁免模式下的闸门（ADR-0068 D6 #10 / D7）
 *
 * 多问题 / 多选走 `ctx.ui.custom`（不经过 selector），必须自己拦：
 * armed 时按取消返回，不得进入自定义 UI（否则无人应答即永久挂起）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Tool = {
	name: string;
	execute: (
		toolCallId: string,
		params: unknown,
		signal: unknown,
		onUpdate: unknown,
		ctx: unknown,
	) => Promise<{
		content: Array<{ type: string; text: string }>;
		details: { cancelled?: boolean };
	}>;
};

const TWO_QUESTIONS = {
	questions: [
		{
			id: 'scope',
			prompt: '范围？',
			options: [
				{ value: 'a', label: 'A' },
				{ value: 'b', label: 'B' },
			],
		},
		{
			id: 'priority',
			prompt: '优先级？',
			options: [
				{ value: 'p1', label: 'P1' },
				{ value: 'p2', label: 'P2' },
			],
		},
	],
};

/** 加载工具并（可选）armed 闸门；闸门状态挂 globalThis，故每个用例显式清 */
async function loadTool(armed: boolean) {
	delete (globalThis as Record<string, unknown>).__piUnattendedState;
	vi.resetModules();

	const selector = await import('@zenone/pi-selector');
	// 模拟 argv 已解析：flag 值在扩展加载前就在 runtime.flagValues 里
	const flags: Record<string, unknown> = { 'unattended-confirm': true };
	selector.initUnattended({
		registerFlag: (name: string, opts: { default?: unknown }) => {
			flags[name] ??= opts.default;
		},
		getFlag: (name: string) => flags[name],
		registerCommand: () => {},
		on: () => () => {},
	} as never);
	if (armed) selector.arm('wechat');

	const tools: Tool[] = [];
	const questionnaire = await import('../../../extensions/tui/questionnaire');
	(questionnaire.default as (pi: unknown) => void)({
		registerTool: (tool: Tool) => tools.push(tool),
	});
	return { tool: tools[0], custom: vi.fn() };
}

function makeCtx(custom: ReturnType<typeof vi.fn>) {
	return { hasUI: true, mode: 'tui', ui: { custom } };
}

beforeEach(() => {
	vi.resetModules();
});

describe('questionnaire — 多问题路径', () => {
	it('armed：不进入自定义 UI，直接按取消返回', async () => {
		const { tool, custom } = await loadTool(true);
		const result = await tool.execute(
			't1',
			TWO_QUESTIONS,
			undefined,
			undefined,
			makeCtx(custom),
		);

		expect(custom).not.toHaveBeenCalled();
		expect(result.details.cancelled).toBe(true);
		expect(result.content[0].text).toContain('cancelled');
	});

	it('未 armed：仍走自定义 UI', async () => {
		const { tool, custom } = await loadTool(false);
		custom.mockResolvedValue({
			questions: TWO_QUESTIONS.questions,
			answers: [],
			cancelled: true,
		});

		const result = await tool.execute(
			't2',
			TWO_QUESTIONS,
			undefined,
			undefined,
			makeCtx(custom),
		);

		expect(custom).toHaveBeenCalledTimes(1);
		expect(result.details.cancelled).toBe(true);
	});
});
