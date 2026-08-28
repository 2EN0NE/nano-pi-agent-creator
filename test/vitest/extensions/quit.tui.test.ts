/**
 * quit renderCard — headless tests
 *
 * 验证（T06）：纯横线边框（无 ┌┐│）、含中文宽字符不超宽、theme 缺失时无硬编码 ANSI。
 */
import { describe, it, expect } from 'vitest';
import { assertWithinWidth, stripAnsi } from '../../../src/tui-testing/index.js';
import { renderCard, type SessionCardData } from '../../../extensions/tui/quit.js';

const mockTheme: any = {
	fg: (_c: any, text: string) => text,
	bg: (_c: any, text: string) => text,
	bold: (text: string) => text,
};

function makeData(): SessionCardData {
	return {
		sessionId: 'test-session-123',
		sessionFile: '/tmp/test.json',
		toolCalls: { total: 5, success: 4, failed: 1 },
		branchLabels: { branchCount: 2, labelCount: 1, lastLabel: 'GOOD' },
		totalDurationMs: 65000,
		agentActiveMs: 30000,
		apiCallMs: 20000,
		toolExecMs: 10000,
		modelUsage: [
			{
				provider: 'openai',
				model: 'gpt-4o',
				requests: 5,
				inputTokens: 1000,
				outputTokens: 500,
				totalCost: 0.5,
			},
		],
		totalCost: 0.5,
	} as SessionCardData;
}

describe('quit renderCard', () => {
	it('纯横线边框：无竖线、无方角字符', () => {
		const lines = renderCard(makeData(), mockTheme);
		const text = lines.map(stripAnsi).join('\n');
		expect(text).not.toContain('│');
		expect(text).not.toContain('┌');
		expect(text).not.toContain('┐');
		expect(text).not.toContain('├');
		expect(text).not.toContain('┤');
		expect(text).not.toContain('└');
		expect(text).not.toContain('┘');
		expect(text).toContain('── quit');
	});

	it('含中文宽字符时每行不超宽（2+ 宽度，含窄终端）', () => {
		for (const w of [80, 60, 40]) {
			const lines = renderCard(makeData(), mockTheme, w);
			assertWithinWidth(lines, w);
		}
	});

	it('theme 缺失时降级为纯文本（无硬编码 ANSI）', () => {
		const lines = renderCard(makeData(), undefined);
		for (const l of lines) {
			expect(l).not.toContain('\x1b');
		}
	});
});
