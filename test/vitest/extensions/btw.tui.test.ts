/**
 * btw BtwOverlay — headless tests
 *
 * 验证（T07）：纯横线边框（无竖线、无角字符）、2+ 宽度下不超宽。
 */
import { describe, it, expect } from 'vitest';
import {
	MockTerminal,
	TuiMainScreen,
	assertWithinWidth,
	stripAnsi,
	makeMockTheme,
} from '../../../src/tui-testing/index.js';
import { BtwOverlay } from '../../../extensions/tui/btw.js';

const mockTheme: any = makeMockTheme();

function makeOverlay(): BtwOverlay {
	const tui = new TuiMainScreen(new MockTerminal(80, 30));
	return new BtwOverlay(
		tui as any,
		mockTheme,
		{ matches: () => false } as any,
		() => ['You: hi', '', 'assistant answer'],
		() => 'idle',
		() => {},
		() => {},
	);
}

describe('btw BtwOverlay', () => {
	it('纯横线边框：无竖线、无角字符', () => {
		const overlay = makeOverlay();
		const text = overlay.render(80).map(stripAnsi).join('\n');
		expect(text).not.toContain('│');
		expect(text).not.toContain('┌');
		expect(text).not.toContain('┐');
		expect(text).not.toContain('├');
		expect(text).not.toContain('└');
		expect(text).not.toContain('┘');
		expect(text).toContain('── btw');
	});

	it('2+ 宽度下渲染不超宽', () => {
		for (const w of [60, 80, 120]) {
			const overlay = makeOverlay();
			assertWithinWidth(overlay.render(w), w);
		}
	});
});
