/**
 * resources-tree widget — headless 窄宽度回归测试
 *
 * 回归：renderCollapsed 的 footer 行（"Ctrl+Shift+Z toggle · /resource-tree settings"）
 * 曾是固定文本无 truncateToWidth 兜底，在 24 列窄终端下超宽崩溃
 * （Rendered line exceeds terminal width: 48 > 24）。修复后验证窄宽度下每行不超宽。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { assertWithinWidth, makeMockTheme } from '../../../src/tui-testing/index.js';
import { renderCollapsed } from '../../../extensions/context/resources-tree/widget/core.js';
import { state } from '../../../extensions/context/resources-tree/state.js';

function resetState(): void {
	state.pi = null;
	state.loadedContextFiles = null;
	state.xmlSkillCount = 5;
	state.fsSkillCount = 3;
	state.recentToolNames = [];
	state.recentSkillNames = [];
	state.toolUsageCounts.clear();
	state.skillUsageCounts.clear();
	state.totalToolCalls = 0;
	state.totalSkillLoads = 0;
}

describe('resources-tree renderCollapsed', () => {
	beforeEach(resetState);

	it('24 列窄宽度下每行不超宽（footer 行 truncate 兜底回归）', () => {
		const lines = renderCollapsed(24, makeMockTheme() as never);
		expect(lines).toHaveLength(3);
		assertWithinWidth(lines, 24);
	});

	it('80 列正常宽度下每行不超宽', () => {
		assertWithinWidth(renderCollapsed(80, makeMockTheme() as never), 80);
	});
});
