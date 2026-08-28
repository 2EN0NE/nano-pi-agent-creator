/**
 * todos TodoDetailOverlayComponent — headless tests
 *
 * 验证（ADR-0023）：纯横线边框（无 ┌┐└┘├┤│）、2+ 宽度下不超宽、
 * 含中文宽字符不超宽、长 body 滚动后仍不超宽。
 */
import { describe, it, expect } from 'vitest';
import { assertWithinWidth, stripAnsi, makeMockTheme } from '../../../src/tui-testing/index.js';
import { TodoDetailOverlayComponent } from '../../../extensions/accuracy/todos/ui/actions.js';
import type { TodoRecord } from '../../../extensions/accuracy/todos/types.js';

const mockTheme: any = makeMockTheme();

// 不响应任何按键的 keybindings（渲染/宽度测试用）
const inertKeys = { matches: () => false };

// 可识别方向键的 keybindings（滚动测试用）
const scrollKeys = {
	matches: (keyData: string, binding: string) =>
		binding === 'tui.select.down' && keyData === '\u001b[B',
};

function makeTodo(overrides: Partial<TodoRecord> = {}): TodoRecord {
	return {
		id: 'aabbccdd',
		title: '测试任务',
		tags: ['bug', 'urgent'],
		status: 'open',
		created_at: '2024-01-01T00:00:00Z',
		project_id: 'project',
		body: '这是一个包含中文的详细任务描述，用于验证换行与宽度兜底。',
		...overrides,
	};
}

function makeOverlay(todo: TodoRecord = makeTodo()) {
	return new TodoDetailOverlayComponent(mockTheme, inertKeys, todo, { onAction: () => {} });
}

describe('TodoDetailOverlayComponent', () => {
	it('纯横线边框：无竖线、无角字符', () => {
		const text = makeOverlay().render(80).map(stripAnsi).join('\n');
		expect(text).not.toContain('│');
		expect(text).not.toContain('┌');
		expect(text).not.toContain('┐');
		expect(text).not.toContain('└');
		expect(text).not.toContain('┘');
		expect(text).not.toContain('├');
		expect(text).not.toContain('┤');
	});

	it('2+ 宽度下渲染不超宽', () => {
		for (const w of [80, 60, 40]) {
			assertWithinWidth(makeOverlay().render(w), w);
		}
	});

	it('含中文宽字符（标题/正文）时不超宽', () => {
		const todo = makeTodo({
			title: '这是一个很长的中文标题用于测试宽度计算是否正确',
			body: '中文正文内容包含大量宽字符，验证 visibleWidth 与 truncateToWidth 的配合。\n第二行也有中文。',
		});
		for (const w of [80, 60]) {
			assertWithinWidth(makeOverlay(todo).render(w), w);
		}
	});

	it('长 body 滚动后仍不超宽、不崩溃', () => {
		const longBody = Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 行中文内容行`).join(
			'\n',
		);
		const overlay = new TodoDetailOverlayComponent(
			mockTheme,
			scrollKeys,
			makeTodo({ body: longBody }),
			{ onAction: () => {} },
		);
		assertWithinWidth(overlay.render(60), 60);

		// 向下滚动多次，仍不超宽
		for (let i = 0; i < 10; i++) {
			overlay.handleInput('\u001b[B'); // Down 键（tui.select.down）
			assertWithinWidth(overlay.render(60), 60);
		}
	});
});
