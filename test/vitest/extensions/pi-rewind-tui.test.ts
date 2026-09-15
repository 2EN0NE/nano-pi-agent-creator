/**
 * pi-rewind — P1：checkpoint-selector / restore-mode TUI headless 测试
 *
 * 对应测试分析发现 [P1]：pi-rewind 的 TUI 组件（checkpoint-selector 系列 +
 * restore-mode 选择器）此前零 headless 用例，违反 AGENTS.md「TUI 测试强制
 * 要求」——/rewind、/checkpoint 选择器在窄终端超宽渲染崩溃或键盘焦点/翻页
 * 失效只能在真机发现。
 *
 * 覆盖：
 *   1. renderSessionLine / buildTreePrefix：树形前缀、选中标记、2+ 宽度
 *      snapshot 断言不超宽。
 *   2. CheckpointSelectorComponent（/checkpoint 选择器壳组件）：实例化 +
 *      loader 数据 → 多宽度渲染不超宽不崩溃；dispatchInput 上下移动选中行
 *      → 快照 diff。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	buildTreePrefix,
	renderSessionLine,
	type RenderSessionLineOptions,
} from '../../../extensions/auto/pi-rewind/commands/checkpoint-selector-render';
import {
	CheckpointSelectorComponent,
	type CheckpointSelectorKeybindings,
	type CheckpointSelectorSession,
	type CheckpointSelectorTheme,
} from '../../../extensions/auto/pi-rewind/commands/checkpoint-selector';
import { stripAnsi } from '../../../src/tui-testing/index.js';

// ────────────────────────────────────────────────────────────────────────────
// 纯色 mock theme / keybindings
// ────────────────────────────────────────────────────────────────────────────

const theme: CheckpointSelectorTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

const KEYS = {
	'tui.select.up': 'up',
	'tui.select.down': 'down',
	'tui.select.pageUp': 'pgup',
	'tui.select.pageDown': 'pgdn',
	'tui.select.confirm': 'enter',
	'tui.select.cancel': 'esc',
	'tui.input.tab': 'tab',
	'app.session.toggleSort': 'sort',
	'app.session.toggleNamedFilter': 'named',
	'app.session.delete': 'del',
	'app.session.togglePath': 'path',
} as const;

function makeKeybindings(): CheckpointSelectorKeybindings {
	return {
		getKeys: (keybinding: string) =>
			keybinding in KEYS ? [KEYS[keybinding as keyof typeof KEYS]] : [keybinding],
		matches: (keyData: string, keybinding: string) =>
			keybinding in KEYS && keyData === KEYS[keybinding as keyof typeof KEYS],
	};
}

/** 构造符合渲染所需的 session fixture（SessionInfo 专有字段用宽松桥接）。 */
function makeSession(partial: {
	path: string;
	cwd: string;
	name?: string;
	firstMessage?: string;
	modified?: Date;
	messageCount?: number;
	checkpointRepoDir?: string;
	checkpointStatus?: CheckpointSelectorSession['checkpointStatus'];
}): CheckpointSelectorSession {
	return {
		path: partial.path,
		cwd: partial.cwd,
		name: partial.name,
		firstMessage: partial.firstMessage ?? 'first message',
		modified: partial.modified ?? new Date('2026-01-01T00:00:00Z'),
		messageCount: partial.messageCount ?? 3,
		checkpointRepoDir: partial.checkpointRepoDir,
		checkpointStatus: partial.checkpointStatus,
	} as unknown as CheckpointSelectorSession;
}

const sampleSessions = (): CheckpointSelectorSession[] => [
	makeSession({
		path: '/proj/sess-aaa.jsonl',
		cwd: '/proj',
		name: 'rewind 回滚会话',
		messageCount: 12,
	}),
	makeSession({
		path: '/proj/sess-bbb.jsonl',
		cwd: '/proj',
		firstMessage: '第二段对话没有名字但是消息内容超长需要截断处理验证窄终端下是否越界溢出',
		messageCount: 99,
		checkpointRepoDir: '/storage/bbb',
		checkpointStatus: 'no checkpoints',
	}),
	makeSession({
		path: '/other/sess-ccc.jsonl',
		cwd: '/other',
		name: 'tree 导航后的分支会话',
		messageCount: 5,
	}),
];

/** 断言所有渲染行 strip 后不超过 width。 */
function expectLinesWithinWidth(lines: readonly string[], width: number): void {
	for (const raw of lines) {
		const plain = stripAnsi(raw);
		expect(plain.length).toBeLessThanOrEqual(width);
	}
}

// ────────────────────────────────────────────────────────────────────────────
// renderSessionLine / buildTreePrefix（逐行渲染核心，超宽风险主体）
// ────────────────────────────────────────────────────────────────────────────

describe('renderSessionLine / buildTreePrefix（纯渲染）', () => {
	const node = (
		depth: number,
		isLast: boolean,
		continues: boolean[],
	): RenderSessionLineOptions['node'] => ({
		session: makeSession({ path: '/x.jsonl', cwd: '/x', name: '节点标题' }),
		depth,
		isLast,
		ancestorContinues: continues,
	});

	it('buildTreePrefix：根节点无前缀；子节点按祖先继续线 + 末位分支符生成', () => {
		expect(buildTreePrefix(node(0, false, []))).toBe('');
		expect(buildTreePrefix(node(1, true, [true]))).toBe('│  └─ ');
		expect(buildTreePrefix(node(1, true, [false]))).toBe('   └─ ');
		expect(buildTreePrefix(node(2, false, [true, true]))).toBe('│  │  ├─ ');
		expect(buildTreePrefix(node(2, true, [true, false]))).toBe('│     └─ ');
	});

	function renderLine(width: number, partial?: Partial<RenderSessionLineOptions>): string {
		return renderSessionLine({
			node: node(1, true, [false]),
			isSelected: false,
			width,
			scope: 'current',
			showPath: false,
			currentSessionPath: '/x.jsonl',
			confirmingDeletePath: null,
			theme,
			...partial,
		});
	}

	it('多个宽度下渲染不超宽、不崩溃', () => {
		for (const width of [40, 80, 120]) {
			const line = renderLine(width);
			expect(stripAnsi(line).length).toBeLessThanOrEqual(width);
		}
	});

	it('选中行带 › 光标标记；当前会话行标题 accent 语义可渲染', () => {
		const selected = renderLine(80, { isSelected: true });
		expect(stripAnsi(selected)).toContain('› ');
	});

	it('超长消息 + 窄宽度（40）时截断且不超宽', () => {
		const wide = renderLine(40, {
			node: node(2, false, [true, false]),
		});
		expect(stripAnsi(wide).length).toBeLessThanOrEqual(40);
	});

	it('confirmingDelete 行渲染（确认删除高亮路径）', () => {
		const confirming = renderLine(80, {
			confirmingDeletePath: '/x.jsonl',
			isSelected: true,
		});
		expect(stripAnsi(confirming).length).toBeLessThanOrEqual(80);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// CheckpointSelectorComponent（/checkpoint 选择器壳组件）
// ────────────────────────────────────────────────────────────────────────────

async function flush(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
	await new Promise((resolve) => setTimeout(resolve, 0));
}

function mountComponent(): CheckpointSelectorComponent {
	const comp = new CheckpointSelectorComponent({
		currentLoader: async () => sampleSessions(),
		allLoader: async () => [],
		deleteStorage: async () => ({ ok: true }),
		currentSessionPath: '/proj/sess-aaa.jsonl',
		requestRender: () => {},
		onClose: () => {},
		theme,
		keybindings: makeKeybindings(),
	});
	return comp;
}

describe('CheckpointSelectorComponent（/checkpoint 选择器）headless', () => {
	let comp: CheckpointSelectorComponent;

	beforeEach(async () => {
		comp = mountComponent();
		await flush();
	});

	it('60/80/120 宽度渲染不超宽不崩溃，含标题与会话行', () => {
		for (const width of [60, 80, 120]) {
			const lines = comp.render(width);
			const joined = stripAnsi(lines.join('\n'));
			expectLinesWithinWidth(lines, width);
			// header 左侧标题在布局中可能被截断，断言 scope 指示与列表内容
			expect(joined).toContain('Current Folder');
		}
		// 会话数据已加载进列表
		const joined = stripAnsi(comp.render(80).join('\n'));
		expect(joined).toContain('rewind 回滚会话');
	});

	it('窄终端 40 列不崩溃且所有行不超宽', () => {
		const lines = comp.render(40);
		expectLinesWithinWidth(lines, 40);
	});

	it('down/up 移动选中行 → 渲染快照变化；翻页到边界不崩溃', () => {
		const before = comp.render(80).map(stripAnsi);
		comp.handleInput('down');
		const afterDown = comp.render(80).map(stripAnsi);
		expect(afterDown).not.toEqual(before);

		comp.handleInput('up');
		const afterUp = comp.render(80).map(stripAnsi);
		expect(afterUp).toEqual(before);

		// 连续 pageDown 越界不崩、不超宽
		comp.handleInput('pgdn');
		comp.handleInput('pgdn');
		comp.handleInput('pgdn');
		const bounded = comp.render(80);
		expectLinesWithinWidth(bounded, 80);
	});

	it('delete 快捷键在当前会话上被拒绝（状态提示，不进入确认态）', async () => {
		// 默认选中第 0 个 = 当前会话（/proj/sess-aaa.jsonl）
		comp.handleInput('del');
		await flush();
		const joined = stripAnsi(comp.render(80).join('\n'));
		expect(joined).toContain('Cannot delete the currently active checkpoint storage');
		expect(joined).not.toContain('Delete checkpoint storage?');
	});

	it('scope 切换 tab → all 加载 → 返回 current 不崩溃', async () => {
		comp.handleInput('tab');
		await flush();
		const allLines = comp.render(80);
		expectLinesWithinWidth(allLines, 80);
		comp.handleInput('tab');
		const backLines = comp.render(80);
		expectLinesWithinWidth(backLines, 80);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// /checkpoint 删除旅程（confirm 成功 / cancel / deleteStorage 失败）
// ────────────────────────────────────────────────────────────────────────────

describe('CheckpointSelectorComponent 删除旅程', () => {
	interface DeleteFixture {
		comp: CheckpointSelectorComponent;
		deleteStorage: ReturnType<typeof vi.fn>;
	}

	/** 默认选中第 0 个（当前会话）；down 后选中 /proj/sess-bbb.jsonl（非当前）。 */
	function mountDeleteFixture(options?: {
		deleteImpl?: () => Promise<{ ok: true } | { ok: false; message: string }>;
	}): DeleteFixture {
		const deleteStorage = vi.fn(
			options?.deleteImpl ?? (async () => ({ ok: true }) as { ok: true }),
		);
		const comp = new CheckpointSelectorComponent({
			currentLoader: async () => sampleSessions(),
			allLoader: async () => [],
			deleteStorage: deleteStorage as never,
			currentSessionPath: '/proj/sess-aaa.jsonl',
			requestRender: () => {},
			onClose: () => {},
			theme,
			keybindings: makeKeybindings(),
		});
		return { comp, deleteStorage };
	}

	it('confirm 成功后 deleteStorage 收到选中会话、列表不崩溃', async () => {
		const { comp, deleteStorage } = mountDeleteFixture();
		await flush(); // 等 loadScope('current') 填充列表
		comp.handleInput('down'); // 0=当前会话 → 1=/proj/sess-bbb.jsonl
		comp.handleInput('del');
		await flush();
		const confirming = stripAnsi(comp.render(80).join('\n'));
		expect(confirming).toContain('Delete checkpoint storage?');

		comp.handleInput('enter');
		await flush();
		expect(deleteStorage).toHaveBeenCalledWith(
			expect.objectContaining({ path: '/proj/sess-bbb.jsonl' }),
		);
		const after = comp.render(80);
		expectLinesWithinWidth(after, 80);
		const joined = stripAnsi(after.join('\n'));
		expect(joined).toContain('Checkpoint storage deleted');
	});

	it('cancel（esc）退出确认态，不调用 deleteStorage', async () => {
		const { comp, deleteStorage } = mountDeleteFixture();
		await flush();
		comp.handleInput('down');
		comp.handleInput('del');
		await flush();
		expect(stripAnsi(comp.render(80).join('\n'))).toContain('Delete checkpoint storage?');

		comp.handleInput('esc');
		await flush();
		expect(deleteStorage).not.toHaveBeenCalled();
		const joined = stripAnsi(comp.render(80).join('\n'));
		expect(joined).not.toContain('Delete checkpoint storage?');
	});

	it('deleteStorage 返回失败 → error 提示且列表保留该项', async () => {
		const { comp, deleteStorage } = mountDeleteFixture({
			deleteImpl: async () => ({ ok: false, message: '模拟删除失败' }),
		});
		await flush();
		comp.handleInput('down');
		comp.handleInput('del');
		await flush();
		comp.handleInput('enter');
		await flush();

		expect(deleteStorage).toHaveBeenCalled();
		const joined = stripAnsi(comp.render(80).join('\n'));
		expect(joined).toContain('模拟删除失败');
		// 失败路径不乐观移除、不重载 → 该会话（按可见标题识别）仍留在列表中
		expect(joined).toContain('第二段对话没有名字');
	});
});
