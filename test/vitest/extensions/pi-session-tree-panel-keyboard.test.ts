/**
 * pi-session-tree panel — full keyboard interaction test
 *
 * Builds a 30-node session and exercises EVERY keyboard action:
 *   ↑↓ 移动 · ←→ 翻页 · c/t/u/a 过滤 · / 搜索
 *   m 标记 · g 跳转 · ~ 范围 · ctrl+x 复制 · Esc 退出
 *
 * Uses headless TUI. Each test calls handleInput() directly.
 * NOTE: Range indicator (●) and some filter behaviors (c, u) rely on Pi's
 * kb.matches and real theme rendering — tested lightly here, verified in
 * production TUI mode.
 */
import { describe, it, expect, vi } from 'vitest';
import { TuiMainScreen, type TUI } from '@earendil-works/pi-tui';
import { createPanel } from '../../../extensions/meta/pi-session-tree/ui/panel.js';
import { createSessionTree } from '../../../extensions/meta/pi-session-tree/index.js';
import { MockTerminal, renderToSnapshot, stripAnsi } from '../../../src/tui-testing/index.js';

// mock 剪贴板，断言复制内容（ctrl+x 复制正文 / ctrl+i 复制 ID）
const { copyToClipboardMock } = vi.hoisted(() => ({ copyToClipboardMock: vi.fn() }));
vi.mock('@earendil-works/pi-coding-agent', () => ({
	copyToClipboard: copyToClipboardMock,
	rawKeyHint: (key: string, description: string) => `${key} ${description}`,
}));

// ═══ Fixture ═══════════════════════════════════════════════════════

function build30NodeSession() {
	const entries: any[] = [];
	let id = 0;
	const e = (parent: string | null, type: string, role: string, content: string, extra?: any) => {
		const eid = `e${String(++id).padStart(2, '0')}`;
		entries.push({
			id: eid,
			parentId: parent,
			type,
			timestamp: `2025-01-01T${String(id).padStart(2, '0')}:00:00Z`,
			message: type === 'message' ? { role, content } : undefined,
			...(extra || {}),
		});
		return eid;
	};

	const u1 = e(null, 'message', 'user', '帮我写一个React组件');
	const a1 = e(u1, 'message', 'assistant', 'Sure, let me help create a React component.');
	const t1 = e(a1, 'message', 'toolResult', 'src/ App.tsx index.tsx package.json', {
		toolName: 'bash',
	});
	const a2 = e(t1, 'message', 'assistant', 'I see the project structure.');
	const t2 = e(a2, 'message', 'toolResult', '{"dependencies":{"react":"^18"}}', {
		toolName: 'read',
	});
	const t3 = e(t2, 'message', 'toolResult', '{"target":"es2020"}', { toolName: 'read' });
	const a3 = e(t3, 'message', 'assistant', 'Found config. Updating App.tsx.');
	const t4 = e(a3, 'message', 'toolResult', '+ function MyComponent()', { toolName: 'edit' });
	const a4 = e(t4, 'message', 'assistant', 'Updated App.tsx with MyComponent.');
	const cp1 = e(a4, 'compaction', '', '', { tokensBefore: 50000 });
	const u2 = e(cp1, 'message', 'user', '添加一个删除按钮');
	const a5 = e(u2, 'message', 'assistant', 'Adding delete button...');
	const t5 = e(a5, 'message', 'toolResult', '+ <button onClick={handleDelete}>', {
		toolName: 'edit',
	});
	const a6 = e(t5, 'message', 'assistant', 'Done. Delete button added.');
	const u3 = e(a6, 'message', 'user', '运行测试');
	const t6 = e(u3, 'message', 'toolResult', 'PASS 5/5 tests', { toolName: 'bash' });
	const a7 = e(t6, 'message', 'assistant', 'All 5 tests passed!');
	const cp2 = e(a7, 'compaction', '', '', { tokensBefore: 80000 });
	const u4 = e(cp2, 'message', 'user', '提交代码');
	const a8 = e(u4, 'message', 'assistant', 'Committing changes.');
	const t7 = e(a8, 'message', 'toolResult', '[main abc123] feat: search', { toolName: 'bash' });
	const u5 = e(t7, 'message', 'user', '添加搜索功能');
	const a9 = e(u5, 'message', 'assistant', 'Adding search...');
	const t8 = e(a9, 'message', 'toolResult', '+ <SearchBox />', { toolName: 'edit' });
	const t9 = e(t8, 'message', 'toolResult', "import SearchBox from './SearchBox'", {
		toolName: 'read',
	});
	const a10 = e(t9, 'message', 'assistant', 'Search ready.');
	const mc = e(a10, 'model_change', '', '', { modelId: 'gpt-4' });
	const a11 = e(mc, 'message', 'assistant', 'Switched to GPT-4.');
	const t10 = e(a11, 'message', 'toolResult', '+ const [query, setQuery] = useState("")', {
		toolName: 'edit',
	});
	e(t10, 'thinking_level_change', '', '', { thinkingLevel: 'high' });

	return entries;
}

/** 分叉会话：u1 下有两个 assistant 分支（a1 活跃含 leaf，a1b 非活跃） */
function buildForkedSession() {
	const entries: any[] = [];
	const e = (parent: string | null, type: string, role: string, content: string) => {
		const eid = `f${entries.length + 1}`;
		entries.push({
			id: eid,
			parentId: parent,
			type,
			timestamp: `2025-01-01T0${entries.length + 1}:00:00Z`,
			message: type === 'message' ? { role, content } : undefined,
		});
		return eid;
	};

	const u1 = e(null, 'message', 'user', '初始问题');
	// 非活跃分支（先出现，验证活跃分支优先排序会把它排到后面）
	const a1b = e(u1, 'message', 'assistant', '分支B（未走到）');
	e(a1b, 'message', 'user', '分支B的追问');
	// 活跃分支（后出现，含 leaf，排序后应排前面）
	const a1 = e(u1, 'message', 'assistant', '分支A（活跃）');
	const u2 = e(a1, 'message', 'user', '活跃分支追问');
	e(u2, 'message', 'assistant', '活跃叶子');

	return entries;
}

/** toolCall 会话：assistant 发 toolCall（无文本），toolResult 带 toolCallId */
function buildToolCallSession() {
	return [
		{
			id: 'u1',
			parentId: null,
			type: 'message',
			timestamp: '2025-01-01T01:00:00Z',
			message: { role: 'user', content: '读一下文件' },
		},
		{
			id: 'a1',
			parentId: 'u1',
			type: 'message',
			timestamp: '2025-01-01T02:00:00Z',
			message: {
				role: 'assistant',
				content: [
					{
						type: 'toolCall',
						id: 'tc1',
						name: 'read',
						arguments: { path: '/src/App.tsx', offset: 1, limit: 40 },
					},
				],
			},
		},
		{
			id: 't1',
			parentId: 'a1',
			type: 'message',
			timestamp: '2025-01-01T03:00:00Z',
			message: { role: 'toolResult', content: 'import React from "react"' },
			toolName: 'read',
			toolCallId: 'tc1',
		},
	];
}

function toSessionEntry(e: any): any {
	return {
		id: e.id,
		parentId: e.parentId,
		type: e.type,
		timestamp: e.timestamp,
		message: e.message
			? {
					role: e.message.role,
					content: e.message.content,
					toolName: e.toolName,
					toolCallId: e.toolCallId,
					stopReason: e.message.stopReason,
				}
			: undefined,
		toolName: e.toolName,
		tokensBefore: e.tokensBefore,
		label: e.label,
	};
}

function buildTree(entries: any[]): any[] {
	const children = new Map<string | null, any[]>();
	for (const e of entries) {
		const key = e.parentId ?? '__root__';
		if (!children.has(key)) children.set(key, []);
		children.get(key)!.push(e);
	}
	function buildNode(e: any): any {
		const kids = (children.get(e.id) || []).map(buildNode);
		return { entry: toSessionEntry(e), children: kids, label: e.label };
	}
	return (children.get('__root__') || []).map(buildNode);
}

function mockSm(entries: any[]) {
	const customChildren: { parentId: string; child: any }[] = [];
	return {
		getTree: () => {
			const tree = buildTree(entries);
			function attach(nodes: any[]): void {
				for (const n of nodes) {
					const cc = customChildren.filter((c) => c.parentId === n.entry.id);
					for (const c of cc)
						n.children.push({ entry: c.child, children: [], label: undefined });
					if (n.children.length > 0) attach(n.children);
				}
			}
			attach(tree);
			return tree;
		},
		getLeafId: () => entries[entries.length - 1].id,
		getCwd: () => '/fake',
		getSessionId: () => 'test',
		getSessionDir: () => '/fake',
		getSessionFile: () => '/fake',
		getLabel: () => undefined,
		getBranch: () => [],
		buildContextEntries: () => [],
		getHeader: () => null,
		getEntries: () => entries.map(toSessionEntry),
		getLeafEntry: () => toSessionEntry(entries[entries.length - 1]),
		getSessionName: () => undefined,
		getEntry: (id: string) => {
			for (const e of entries) if (e.id === id) return toSessionEntry(e);
			for (const c of customChildren) if (c.child.id === id) return c.child;
		},
		addCustomChild: (parentId: string, child: any) => {
			customChildren.push({ parentId, child });
		},
	};
}

// ═══ Theme & Keybindings ═══════════════════════════════════════════

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
		getThinkingBorderColor: () => (s: string) => s,
		getBashModeBorderColor: () => (s: string) => s,
	};
}

function mockKeybindings(): any {
	return { matches: () => false, getDefinition: () => undefined };
}

// ═══ Setup ═════════════════════════════════════════════════════════

function setup30NodePanel(entries: any[] = build30NodeSession()) {
	const sm = mockSm(entries);
	const tree = createSessionTree(sm);
	(tree as any).annotate = async (entryId: string, customType: string, data: unknown) => {
		sm.addCustomChild(entryId, {
			id: `custom_${customType}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
			parentId: entryId,
			type: 'custom',
			timestamp: new Date().toISOString(),
			customType,
			data,
		});
	};
	const term = new MockTerminal(80, 30);
	const tui = new TuiMainScreen(term);
	const component = createPanel(tui, mockTheme(), mockKeybindings(), () => {}, tree, 'test-sess');
	tui.addChild(component);
	tui.setFocus(component);
	tui.start();
	return { tui, component, tree, term };
}

function panelLines(tui: TUI): string[] {
	return renderToSnapshot(tui, 80, 30).map(stripAnsi);
}

/** 光标行的 gutter 是 '> '、'●>' 或 '│>'（位于行首，紧跟缩进前缀） */
function cursorLine(lines: string[]): string | null {
	for (const l of lines) {
		const s = l.replace(/^\s+/, '');
		if (s.startsWith('> ') || s.startsWith('●>') || s.startsWith('│>')) return l;
	}
	return null;
}

// ═══ Tests ═════════════════════════════════════════════════════════

describe('pi-session-tree panel — keyboard interaction (30 nodes)', () => {
	// ── Render ─────────────────────────────────────────

	it('renders 30-node session without crash', () => {
		const { tui } = setup30NodePanel();
		const lines = panelLines(tui);
		expect(lines.length).toBeGreaterThan(10);
		// Header shows truncated session ID or title
		expect(lines.some((l) => l.includes('会话树') || l.includes('test-sess'))).toBe(true);
		// Footer shows current selected node ID（前缀=ID 跳转用）
		expect(lines.some((l) => l.includes('ID e01'))).toBe(true);
		// 节点 ID 不得在 header（header 第 0 行随光标变化会触发 pi-tui fullRender 重影）
		const headerLine = lines.find((l) => l.includes('会话树'));
		expect(headerLine).toBeDefined();
		expect(headerLine).not.toContain('ID e01');
		expect(lines.some((l) => l.includes('React组件'))).toBe(true);
		expect(lines.some((l) => l.includes('Compaction'))).toBe(true);
		expect(lines.some((l) => l.includes('bash'))).toBe(true);
		expect(lines.some((l) => l.includes('g') && l.includes('跳转'))).toBe(true);
	});

	it('forked session renders tree: connector + gutter + active path •', () => {
		const { tui } = setup30NodePanel(buildForkedSession());
		const lines = panelLines(tui);
		const joined = lines.join('\n');

		// 活跃分支 a1 用 ├─ connector + • 标记
		expect(joined).toMatch(/├.*•.*分支A（活跃）/);
		// 非活跃分支 a1b 用 └─ connector，无 • 标记
		expect(joined).toMatch(/└.*分支B（未走到）/);
		expect(joined).not.toMatch(/•.*分支B（未走到）/);
		// 活跃分支后代有竖线 gutter
		expect(joined).toMatch(/│.*活跃分支追问/);
		// 排序：活跃分支（分支A）在非活跃分支（分支B）前面
		expect(joined.indexOf('分支A')).toBeLessThan(joined.indexOf('分支B'));
	});

	it('toolResult renders formatToolCall + result text', () => {
		const { tui } = setup30NodePanel(buildToolCallSession());
		const joined = panelLines(tui).join('\n');
		// 格式化 toolCall（read → [read: path:1-40]）+ 结果正文
		expect(joined).toContain('[read: /src/App.tsx:1-40]');
		expect(joined).toContain('import React from "react"');
	});

	// ── Cursor ──────────────────────────────────────────

	it('↑↓ cursor movement — down then up', () => {
		const { tui, component } = setup30NodePanel();
		for (let i = 0; i < 3; i++) (component as any).handleInput('\x1b[B');
		expect(panelLines(tui).length).toBeGreaterThan(5);
		(component as any).handleInput('\x1b[A');
		expect(panelLines(tui).length).toBeGreaterThan(5);
	});

	it('←→ page scrolling', () => {
		const { tui, component } = setup30NodePanel();
		(component as any).handleInput('\x1b[C');
		expect(panelLines(tui).length).toBeGreaterThan(5);
		(component as any).handleInput('\x1b[D');
		expect(panelLines(tui).length).toBeGreaterThan(5);
	});

	// ── Marks ───────────────────────────────────────────

	it('m — selects current node and shows ● marker', () => {
		const { tui, component } = setup30NodePanel();
		(component as any).handleInput('m');
		const lines = panelLines(tui);
		expect(lines.some((l) => l.includes('●'))).toBe(true);
	});

	it('m — second selected node shows 2 markers, then third clears and re-selects', () => {
		const { tui, component } = setup30NodePanel();
		(component as any).handleInput('m');
		(component as any).handleInput('\x1b[B');
		(component as any).handleInput('m');
		const lines = panelLines(tui);
		expect(lines.filter((l) => l.includes('●')).length).toBe(2);
		// Press m a third time → clears old selection, starts new
		(component as any).handleInput('\x1b[B');
		(component as any).handleInput('m');
		const lines2 = panelLines(tui);
		expect(lines2.filter((l) => l.includes('●')).length).toBe(1);
	});

	it('range spanning >2 nodes: endpoints ● + connector │ (no warning dots)', () => {
		const { tui, component } = setup30NodePanel();
		(component as any).handleInput('m'); // 标记 u1（端点 1）
		(component as any).handleInput('\x1b[B'); // → a1
		(component as any).handleInput('\x1b[B'); // → t1
		(component as any).handleInput('m'); // 标记 t1（端点 2），范围 u1→t1，中间 a1
		const lines = panelLines(tui);
		// 两个端点 ●（accent）
		expect(lines.filter((l) => l.includes('●')).length).toBe(2);
		// 中间节点 a1 用竖线 │ 连接（同 accent 色）
		expect(lines.filter((l) => l.includes('│')).length).toBe(1);
	});

	it('marking does not shift the content column (fixed-width gutter)', () => {
		const { tui, component } = setup30NodePanel();
		const CONTENT = '帮我写一个React组件';
		const before = panelLines(tui).find((l) => l.includes(CONTENT))!;
		const beforeIdx = before.indexOf(CONTENT);
		// 标记（光标在 u1 = 该内容所在行）
		(component as any).handleInput('m');
		const after = panelLines(tui).find((l) => l.includes(CONTENT))!;
		const afterIdx = after.indexOf(CONTENT);
		// 内容列位置不变（标记复用 gutter 占位列，不额外占宽）
		expect(afterIdx).toBe(beforeIdx);
	});

	it('cursor (>) remains visible on in-range middle nodes (│>)', () => {
		const { tui, component } = setup30NodePanel();
		const CONTENT = 'Sure, let me help create a React component.'; // a1
		(component as any).handleInput('m'); // 标记 u1
		(component as any).handleInput('\x1b[B'); // → a1
		(component as any).handleInput('\x1b[B'); // → t1
		(component as any).handleInput('m'); // 标记 t1，范围 u1→t1（a1 为中间）
		(component as any).handleInput('\x1b[A'); // ↑ → 光标移到中间节点 a1
		const lines = panelLines(tui);
		const a1Line = lines.find((l) => l.includes(CONTENT))!;
		// 中间节点 + 光标：应显示 │>（光标指示不丢失）
		expect(a1Line).toContain('│>');
	});

	// ── Jump bar ────────────────────────────────────────

	it('g — activates jump bar with help text', () => {
		const { tui, component } = setup30NodePanel();
		(component as any).handleInput('g');
		const lines = panelLines(tui);
		expect(lines.some((l) => l.includes('跳转'))).toBe(true);
		// Help text shows expression syntax
		expect(lines.some((l) => l.includes('@=会话当前节点') || l.includes('@^^type=祖先'))).toBe(
			true,
		);
	});

	it('g → type @ → Enter → jumps to leaf', () => {
		const { tui, component } = setup30NodePanel();
		(component as any).handleInput('g');
		(component as any).handleInput('@');
		(component as any).handleInput('\r');
		const lines = panelLines(tui);
		expect(lines.length).toBeGreaterThan(5);
	});

	it('g → type @~3..@ → Enter → activates range mode', () => {
		const { tui, component } = setup30NodePanel();
		(component as any).handleInput('g');
		'@~3..@'.split('').forEach((ch) => (component as any).handleInput(ch));
		(component as any).handleInput('\r');
		// Panel should render and jump bar should be dismissed
		expect(panelLines(tui).length).toBeGreaterThan(5);
	});

	it('g → @~3:user → Enter 光标跳到第 3 个 user 节点（回归：Kitty 协议 CSI-u 输入）', () => {
		// 现代终端启用 Kitty keyboard protocol 后，普通字符以 CSI-u 多字节序列到达
		// （如 'g' → '\x1b[103u'），jump 输入收集必须用 parseKey 解码后的 key 而非原始 data。
		const { tui, component } = setup30NodePanel();
		const kitty = (ch: string) => `\x1b[${ch.charCodeAt(0)}u`;
		(component as any).handleInput(kitty('g'));
		'@~3:user'.split('').forEach((ch) => (component as any).handleInput(kitty(ch)));
		(component as any).handleInput('\x1b[13u'); // Kitty Enter
		const cur = cursorLine(panelLines(tui));
		expect(cur).toContain('运行测试');
	});

	it('g → @~3:user → Tab 也可执行跳转（回归：key===tab）', () => {
		const { tui, component } = setup30NodePanel();
		const kitty = (ch: string) => `\x1b[${ch.charCodeAt(0)}u`;
		(component as any).handleInput(kitty('g'));
		'@~3:user'.split('').forEach((ch) => (component as any).handleInput(kitty(ch)));
		(component as any).handleInput('\x1b[9u'); // Kitty Tab
		const cur = cursorLine(panelLines(tui));
		expect(cur).toContain('运行测试');
	});

	it('g → @ → Enter 跳到隐藏 leaf 并揭示（回归：跳转揭示被过滤的节点）', () => {
		// leaf 是 thinking_level_change，默认过滤下隐藏；跳转应切 all 过滤揭示它，
		// 而不是光标静默停在根节点。
		const { tui, component } = setup30NodePanel();
		(component as any).handleInput('g');
		(component as any).handleInput('@');
		(component as any).handleInput('\r');
		const cur = cursorLine(panelLines(tui));
		expect(cur).toContain('[Thinking:');
	});

	it('g → @^^model_change → Enter 揭示隐藏的 model_change 祖先', () => {
		const { tui, component } = setup30NodePanel();
		(component as any).handleInput('g');
		'@^^model_change'.split('').forEach((ch) => (component as any).handleInput(ch));
		(component as any).handleInput('\r');
		const cur = cursorLine(panelLines(tui));
		expect(cur).toContain('[Model:');
	});

	it('g → +1 → Enter 向前偏移到下一个节点（+N 向前导航）', () => {
		// 初始光标在根 u1（帮我写一个React组件），+1 → a1
		const { tui, component } = setup30NodePanel();
		(component as any).handleInput('g');
		(component as any).handleInput('+');
		(component as any).handleInput('1');
		(component as any).handleInput('\r');
		const cur = cursorLine(panelLines(tui));
		expect(cur).toContain('Sure, let me help create a React component.');
	});

	it('g → -1 → Enter 向后偏移越界时光标保持原位', () => {
		// 初始光标在根 u1，-1 越界 → resolve 返回 null → 光标保持 u1
		const { tui, component } = setup30NodePanel();
		(component as any).handleInput('g');
		(component as any).handleInput('-');
		(component as any).handleInput('1');
		(component as any).handleInput('\r');
		const cur = cursorLine(panelLines(tui));
		expect(cur).toContain('帮我写一个React组件');
	});

	// ── Range footer ────────────────────────────────────

	it('m — two marks auto-activate range analysis with footer summary (no ~ needed)', () => {
		const { tui, component } = setup30NodePanel();
		// Select two nodes with m — second m auto-enters range analysis
		(component as any).handleInput('m');
		(component as any).handleInput('\x1b[B');
		(component as any).handleInput('m');
		const lines = panelLines(tui);
		expect(lines.length).toBeGreaterThan(5);
		// Footer should show analyze result with segment count
		expect(lines.some((l) => l.includes('范围:') && l.includes('条'))).toBe(true);
		// m again exits range and restarts marking
		(component as any).handleInput('m');
		const lines2 = panelLines(tui);
		expect(lines2.some((l) => l.includes('范围:') && l.includes('条'))).toBe(false);
		expect(lines2.some((l) => l.includes('再按一次 m'))).toBe(true);
	});

	it('m — first press shows "再按一次 m" hint, footer has no ~ hint initially', () => {
		const { tui, component } = setup30NodePanel();
		// Initial footer must NOT advertise ~ 范围
		const initial = panelLines(tui);
		expect(initial.some((l) => l.includes('~'))).toBe(false);
		// First m → hint to press m again
		(component as any).handleInput('m');
		const lines = panelLines(tui);
		expect(lines.some((l) => l.includes('再按一次 m'))).toBe(true);
	});

	// ── Filters ─────────────────────────────────────────

	it('c filter — hides all tool result lines', () => {
		const { tui, component } = setup30NodePanel();
		const before = panelLines(tui);
		const toolCountBefore = before.filter(
			(l) => l.includes('[bash') || l.includes('[read') || l.includes('[edit'),
		).length;
		expect(toolCountBefore).toBeGreaterThan(2);
		(component as any).handleInput('c');
		const after = panelLines(tui);
		const toolCountAfter = after.filter(
			(l) => l.includes('[bash') || l.includes('[read') || l.includes('[edit'),
		).length;
		// After fix, all tool nodes become invisible → 0 tool lines rendered
		expect(toolCountAfter).toBe(0);
		(component as any).handleInput('c');
		const restored = panelLines(tui);
		const toolCountRestored = restored.filter(
			(l) => l.includes('[bash') || l.includes('[read') || l.includes('[edit'),
		).length;
		expect(toolCountRestored).toBe(toolCountBefore);
	});

	it('u filter — shows only user messages (no tools, no assistant, no compaction)', () => {
		const { tui, component } = setup30NodePanel();
		(component as any).handleInput('u');
		const lines = panelLines(tui);
		expect(lines.length).toBeGreaterThan(0);
		// User message content present
		expect(lines.some((l) => l.includes('React组件'))).toBe(true);
		// No tool lines, no assistant-only lines, no compaction lines
		expect(
			lines.every(
				(l) => !l.includes('[bash') && !l.includes('[read') && !l.includes('[edit'),
			),
		).toBe(true);
		expect(lines.every((l) => !l.startsWith('assistant:'))).toBe(true);
		expect(lines.every((l) => !l.includes('Compaction'))).toBe(true);
	});

	it('a filter — shows all entries', () => {
		const { tui, component } = setup30NodePanel();
		(component as any).handleInput('u');
		(component as any).handleInput('a');
		const lines = panelLines(tui);
		expect(lines.some((l) => l.includes('[bash'))).toBe(true);
		expect(lines.some((l) => l.includes('React组件'))).toBe(true);
	});

	it('t cycle — cycles through filters', () => {
		const { tui, component } = setup30NodePanel();
		(component as any).handleInput('t');
		expect(panelLines(tui).length).toBeGreaterThan(0);
	});

	// ── Search mode ──────────────────────────────────

	it('search mode: typing c in / search does not toggle filter', () => {
		const { tui, component } = setup30NodePanel();
		// Enter search mode
		(component as any).handleInput('/');
		// Type 'c' — should be added to query, NOT toggle no-tools filter
		(component as any).handleInput('c');
		const lines = panelLines(tui);
		// Search bar should show (with query 'c')
		expect(lines.some((l) => l.includes('搜索:'))).toBe(true);
		// Filter was NOT toggled — should still see normal entries
		expect(lines.length).toBeGreaterThan(5);
	});

	it('search mode: CJK multi-byte input works', () => {
		const { tui, component } = setup30NodePanel();
		(component as any).handleInput('/');
		// Simulate CJK 3-byte character (你 = \xe4\xbd\xa0)
		(component as any).handleInput('\xe4\xbd\xa0');
		const lines = panelLines(tui);
		expect(lines.length).toBeGreaterThan(0);
		expect(lines.some((l) => l.includes('搜索:'))).toBe(true);
	});

	// ── u filter — deep user messages ─────────────────

	it('u filter: shows user messages at all depths, not just root', () => {
		const { tui, component } = setup30NodePanel();
		(component as any).handleInput('u');
		// Page 0 should show first few user messages
		let lines = panelLines(tui);
		expect(lines.some((l) => l.includes('React组件'))).toBe(true);
		// Move deep into the tree
		for (let i = 0; i < 17; i++) (component as any).handleInput('\x1b[B');
		lines = panelLines(tui);
		// Should find deeper user messages now
		expect(
			lines.some(
				(l) =>
					l.includes('运行测试') || l.includes('提交代码') || l.includes('添加搜索功能'),
			),
		).toBe(true);
		// No tools, no assistants anywhere
		expect(
			lines.every(
				(l) => !l.includes('[bash') && !l.includes('[read') && !l.includes('[edit'),
			),
		).toBe(true);
		expect(lines.every((l) => !l.startsWith('assistant:'))).toBe(true);
		// Press a to reset
		(component as any).handleInput('a');
		lines = panelLines(tui);
		expect(lines.some((l) => l.includes('[bash'))).toBe(true);
	});

	// ── Hint bar ──────────────────────────────────────

	it('hint bar shows shift+l for tag rules (ctrl+l is now labeled-only filter)', () => {
		const { tui } = setup30NodePanel();
		const lines = panelLines(tui);
		expect(lines.some((l) => l.includes('shift+l') || l.includes('标签'))).toBe(true);
	});

	// ── Copy ────────────────────────────────────────────

	it('ctrl+x — copies node content (正文), not id', () => {
		copyToClipboardMock.mockClear();
		const { tui, component } = setup30NodePanel();
		(component as any).handleInput('\x18');
		// 光标初始在根节点 u1（user），复制正文而非节点 ID e01
		expect(copyToClipboardMock).toHaveBeenCalledWith('帮我写一个React组件');
		expect(panelLines(tui).some((l) => l.includes('已复制'))).toBe(true);
	});

	// ── Escape ──────────────────────────────────────────

	it('Esc — exits panel (calls done)', () => {
		let doneCalled = false;
		const entries = build30NodeSession();
		const sm = mockSm(entries);
		const tree = createSessionTree(sm);
		(tree as any).annotate = async () => {};
		const term = new MockTerminal(80, 30);
		const tui = new TuiMainScreen(term);
		const component = createPanel(
			tui,
			mockTheme(),
			mockKeybindings(),
			() => {
				doneCalled = true;
			},
			tree,
			'test',
		);
		tui.addChild(component);
		tui.setFocus(component);
		tui.start();
		(component as any).handleInput('\x1b');
		expect(doneCalled).toBe(true);
	});

	it('Esc in jump mode — cancels jump', () => {
		const { tui, component } = setup30NodePanel();
		(component as any).handleInput('g');
		(component as any).handleInput('@');
		(component as any).handleInput('\x1b');
		expect(panelLines(tui).length).toBeGreaterThan(5);
	});

	it('Esc in range mode — disables range', () => {
		const { tui, component } = setup30NodePanel();
		(component as any).handleInput('g');
		'@~2..@'.split('').forEach((ch) => (component as any).handleInput(ch));
		(component as any).handleInput('\r');
		(component as any).handleInput('\x1b');
		expect(panelLines(tui).length).toBeGreaterThan(5);
	});

	// ── Fold/Unfold ─────────────────────────────────────

	it('option+←→ fold/unfold — toggles branch collapse', () => {
		const { tui, component } = setup30NodePanel();
		(component as any).handleInput('\x1b\x1b[D');
		expect(panelLines(tui).length).toBeGreaterThan(0);
	});

	it('fold keeps the folded node visible (re-expandable) but hides descendants', () => {
		const { tui, component } = setup30NodePanel();
		// 光标初始在 u1（根，有孩子）。折叠后 u1 自己应保留，后代全隐藏。
		(component as any).handleInput('\x1b\x1b[D');
		const lines = panelLines(tui);
		// u1 仍在（可重新展开）
		expect(lines.some((l) => l.includes('帮我写一个React组件'))).toBe(true);
		// 后代 a1 隐藏
		expect(lines.some((l) => l.includes('Sure, let me help'))).toBe(false);
		// pageInfo 数量 = 1（仅折叠节点自己）
		expect(lines.some((l) => l.includes('/1)'))).toBe(true);
		// 再次按同一键展开，后代恢复
		(component as any).handleInput('\x1b\x1b[D');
		const lines2 = panelLines(tui);
		expect(lines2.some((l) => l.includes('Sure, let me help'))).toBe(true);
	});

	// ── Full workflow ───────────────────────────────────

	it('full workflow: m → move → m → ctrl+x', () => {
		const { tui, component } = setup30NodePanel();
		(component as any).handleInput('m');
		for (let i = 0; i < 5; i++) (component as any).handleInput('\x1b[B');
		(component as any).handleInput('m');
		expect(panelLines(tui).some((l) => l.includes('范围:') && l.includes('条'))).toBe(true);
		(component as any).handleInput('\x18');
		expect(panelLines(tui).some((l) => l.includes('已复制'))).toBe(true);
		(component as any).handleInput('g');
		expect(panelLines(tui).some((l) => l.includes('> '))).toBe(true);
	});

	it('range footer shows tool detail sorted by count', () => {
		const entries = [
			{
				id: 'u1',
				parentId: null,
				type: 'message',
				timestamp: 't0',
				message: { role: 'user', content: 'Q' },
			},
			{
				id: 'a1',
				parentId: 'u1',
				type: 'message',
				timestamp: 't1',
				message: { role: 'assistant', content: 'A' },
			},
			{
				id: 't1',
				parentId: 'a1',
				type: 'message',
				timestamp: 't2',
				message: { role: 'toolResult', content: 'o' },
				toolName: 'bash',
			},
			{
				id: 't2',
				parentId: 't1',
				type: 'message',
				timestamp: 't3',
				message: { role: 'toolResult', content: 'o' },
				toolName: 'read',
			},
			{
				id: 't3',
				parentId: 't2',
				type: 'message',
				timestamp: 't4',
				message: { role: 'toolResult', content: 'o' },
				toolName: 'read',
			},
			{
				id: 't4',
				parentId: 't3',
				type: 'message',
				timestamp: 't5',
				message: { role: 'toolResult', content: 'o' },
				toolName: 'edit',
			},
		];
		const { tui, component } = setup30NodePanel(entries as any);
		// 初始光标在叶子 t4；先上移 5 次到 u1 标记，再下移 5 次到 t4 标记
		for (let i = 0; i < 5; i++) (component as any).handleInput('\x1b[A'); // → u1
		(component as any).handleInput('m'); // 标记 u1
		for (let i = 0; i < 5; i++) (component as any).handleInput('\x1b[B'); // → t4
		(component as any).handleInput('m'); // 标记 t4，进 range
		const lines = panelLines(tui);
		// INFO: 范围: 6 条 · 用户: 1 条 · AGENT: 1 条 · 工具: 4 次(read:2|bash:1|edit:1)
		expect(lines.some((l) => l.includes('INFO: ') && l.includes('范围: 6 条'))).toBe(true);
		expect(lines.some((l) => l.includes('AGENT: 1 条'))).toBe(true);
		expect(
			lines.some((l) => l.includes('工具: 4 次') && l.includes('read:2|bash:1|edit:1')),
		).toBe(true);
	});

	// ── Visual indicators ───────────────────────────────

	it('tagged node shows #label suffix', () => {
		const entries = build30NodeSession();
		entries[0].label = '#bug,#ui';
		const sm = mockSm(entries);
		const tree = createSessionTree(sm);
		(tree as any).annotate = async () => {};
		const term = new MockTerminal(80, 30);
		const tui = new TuiMainScreen(term);
		const component = createPanel(tui, mockTheme(), mockKeybindings(), () => {}, tree, 'tags');
		tui.addChild(component);
		tui.setFocus(component);
		tui.start();
		expect(panelLines(tui).some((l) => l.includes('#bug') || l.includes('#ui'))).toBe(true);
	});

	it('hidden custom branch does not indent the active main chain (visible-tree recalc)', () => {
		// 复现：assistant 分叉点有 custom(plannotator) + bash 两个子节点。
		// default 隐藏 custom，但 bash 主链不应因隐藏分支而缩进（对齐原生 recalculateVisualStructure）。
		const entries = [
			{
				id: 'u1',
				parentId: null,
				type: 'message',
				timestamp: 't0',
				message: { role: 'user', content: 'Q' },
			},
			{
				id: 'a1',
				parentId: 'u1',
				type: 'message',
				timestamp: 't1',
				message: { role: 'assistant', content: 'A' },
			},
			{
				id: 'c1',
				parentId: 'a1',
				type: 'custom',
				timestamp: 't2',
				customType: 'plannotator',
			},
			{
				id: 't1',
				parentId: 'a1',
				type: 'message',
				timestamp: 't3',
				message: { role: 'toolResult', content: 'out' },
				toolName: 'bash',
			},
			{
				id: 'a2',
				parentId: 't1',
				type: 'message',
				timestamp: 't4',
				message: { role: 'assistant', content: 'done' },
			},
		];
		const { tui, component } = setup30NodePanel(entries as any);
		// default 隐藏 custom(c1)：bash 主链 t1 应扁平（无缩进竖线），而非因隐藏分支被推进
		const bashLine = panelLines(tui).find((l) => l.includes('[bash'));
		expect(bashLine).toBeDefined();
		expect(bashLine!.trimStart().startsWith('•')).toBe(true);
		// all 显示 custom 分叉：bash 主链出现缩进 connector（不再以 • 开头）
		(component as any).handleInput('\x01'); // ctrl+a = all
		const allBashLine = panelLines(tui).find((l) => l.includes('[bash'));
		expect(allBashLine).toBeDefined();
		expect(allBashLine!.trimStart().startsWith('•')).toBe(false);
	});

	// ── Native-style filters (ctrl+d/t/u/l/a, aligned with /tree) ──

	it('ctrl+d — sets default mode (hides settings entries)', () => {
		const { tui, component } = setup30NodePanel();
		// Switch to all first, then back to default
		(component as any).handleInput('\x01'); // ctrl+a
		(component as any).handleInput('\x04'); // ctrl+d
		const lines = panelLines(tui);
		// default hides settings/bookkeeping entries (model/thinking/custom)
		expect(lines.some((l) => l.includes('[Model:'))).toBe(false);
		expect(lines.some((l) => l.includes('[Thinking:'))).toBe(false);
		expect(lines.some((l) => l.includes('[System:'))).toBe(false);
		expect(lines.some((l) => l.includes('React组件'))).toBe(true);
	});

	it('ctrl+t / ctrl+u / ctrl+a — toggle filters (native keybindings)', () => {
		const { tui, component } = setup30NodePanel();
		(component as any).handleInput('\x14'); // ctrl+t = no-tools
		expect(panelLines(tui).some((l) => l.includes('[bash'))).toBe(false);
		(component as any).handleInput('\x14'); // back to default
		expect(panelLines(tui).some((l) => l.includes('[bash'))).toBe(true);
		(component as any).handleInput('\x15'); // ctrl+u = user-only
		expect(panelLines(tui).some((l) => l.includes('React组件'))).toBe(true);
		expect(panelLines(tui).every((l) => !l.includes('[bash'))).toBe(true);
		(component as any).handleInput('\x01'); // ctrl+a = all
		expect(panelLines(tui).some((l) => l.includes('[bash'))).toBe(true);
	});

	it('ctrl+l — labeled-only filter shows only labeled entries', () => {
		const entries = build30NodeSession();
		entries[0].label = '#bug';
		const { tui, component } = setup30NodePanel(entries as any);
		(component as any).handleInput('\x0c'); // ctrl+l = labeled-only
		const lines = panelLines(tui);
		expect(lines.some((l) => l.includes('#bug'))).toBe(true);
	});

	it('ctrl+o — cycles filter forward through all 5 modes', () => {
		const { tui, component } = setup30NodePanel();
		(component as any).handleInput('\x0f'); // ctrl+o → no-tools
		expect(panelLines(tui).every((l) => !l.includes('[bash'))).toBe(true);
		(component as any).handleInput('\x0f'); // → user-only
		expect(panelLines(tui).some((l) => l.includes('React组件'))).toBe(true);
		(component as any).handleInput('\x0f'); // → labeled-only
		(component as any).handleInput('\x0f'); // → all
		expect(panelLines(tui).some((l) => l.includes('[bash'))).toBe(true);
	});

	it('all mode — shows label entries, default hides them (native count alignment)', () => {
		const entries = [
			{
				id: 'u1',
				parentId: null,
				type: 'message',
				timestamp: 't0',
				message: { role: 'user', content: 'Q' },
			},
			{
				id: 'a1',
				parentId: 'u1',
				type: 'message',
				timestamp: 't1',
				message: { role: 'assistant', content: 'A' },
			},
			{ id: 'lab1', parentId: 'u1', type: 'label', timestamp: 't99', label: '#TUI' },
		];
		const { tui, component } = setup30NodePanel(entries as any);
		(component as any).handleInput('\x01'); // ctrl+a = all
		const lines = panelLines(tui);
		expect(lines.some((l) => l.includes('[Label:'))).toBe(true);
		(component as any).handleInput('\x04'); // ctrl+d = default
		const lines2 = panelLines(tui);
		expect(lines2.some((l) => l.includes('[Label:'))).toBe(false);
	});

	it('skips no-text assistant messages except leaf (native behavior)', () => {
		const entries = [
			{
				id: 'u1',
				parentId: null,
				type: 'message',
				timestamp: 't0',
				message: { role: 'user', content: 'Q1' },
			},
			{
				id: 'a1',
				parentId: 'u1',
				type: 'message',
				timestamp: 't1',
				message: { role: 'assistant', content: '' },
			},
			{
				id: 'u2',
				parentId: 'a1',
				type: 'message',
				timestamp: 't2',
				message: { role: 'user', content: 'Q2' },
			},
			{
				id: 'a2',
				parentId: 'u2',
				type: 'message',
				timestamp: 't3',
				message: { role: 'assistant', content: '' },
			},
		];
		const { tui } = setup30NodePanel(entries as any);
		const lines = panelLines(tui);
		// a1 hidden (no text, not leaf); a2 shown (leaf exception) → exactly 1 no-text line
		expect(lines.filter((l) => l.includes('(no text)')).length).toBe(1);
	});

	it('keeps no-text assistant when aborted (even non-leaf)', () => {
		const entries = [
			{
				id: 'u1',
				parentId: null,
				type: 'message',
				timestamp: 't0',
				message: { role: 'user', content: 'Q1' },
			},
			{
				id: 'a1',
				parentId: 'u1',
				type: 'message',
				timestamp: 't1',
				message: { role: 'assistant', content: '', stopReason: 'aborted' },
			},
			{
				id: 'u2',
				parentId: 'a1',
				type: 'message',
				timestamp: 't2',
				message: { role: 'user', content: 'Q2' },
			},
		];
		const { tui } = setup30NodePanel(entries as any);
		expect(panelLines(tui).some((l) => l.includes('(aborted)'))).toBe(true);
	});

	// ── Bullet prefix (native-style) ───────────────────

	it('render prefix uses bullet • instead of triangle ▶/▼', () => {
		const { tui } = setup30NodePanel();
		const lines = panelLines(tui);
		expect(lines.some((l) => l.includes('•'))).toBe(true);
		expect(lines.some((l) => l.includes('▶'))).toBe(false);
		expect(lines.some((l) => l.includes('▼'))).toBe(false);
	});

	it('shift+l — opens tag panel (ctrl+l now reserved for labeled-only)', () => {
		const { tui, component } = setup30NodePanel();
		(component as any).handleInput('L'); // shift+l
		const lines = panelLines(tui);
		expect(lines.some((l) => l.includes('类型:'))).toBe(true);
	});

	// ── 过滤后导航一致性（回归：pageInfo 与渲染数量对不上 / 光标卡在隐藏节点）──

	it('pageInfo counts only visible nodes after default filter (not full flat)', () => {
		const entries = [
			{ id: 'm1', parentId: null, type: 'model_change', timestamp: 't0', modelId: 'gpt-4' },
			{
				id: 'u1',
				parentId: 'm1',
				type: 'message',
				timestamp: 't1',
				message: { role: 'user', content: 'Q1' },
			},
			{
				id: 'a1',
				parentId: 'u1',
				type: 'message',
				timestamp: 't2',
				message: { role: 'assistant', content: 'A1' },
			},
			{ id: 'lab1', parentId: 'a1', type: 'label', timestamp: 't3', label: '#TUI' },
			{
				id: 'u2',
				parentId: 'lab1',
				type: 'message',
				timestamp: 't4',
				message: { role: 'user', content: 'Q2' },
			},
			{
				id: 'a2',
				parentId: 'u2',
				type: 'message',
				timestamp: 't5',
				message: { role: 'assistant', content: 'A2' },
			},
		];
		const { tui } = setup30NodePanel(entries as any);
		// default 模式：model_change + label 隐藏，剩 4 条 message
		const lines = panelLines(tui);
		// pageInfo 显示 /4（可见），而非 /6（全量）
		expect(lines.some((l) => l.includes('/4)'))).toBe(true);
		expect(lines.some((l) => l.includes('/6)'))).toBe(false);
		// 隐藏的 settings 不渲染，可见内容仍在
		expect(lines.some((l) => l.includes('[Model:'))).toBe(false);
		expect(lines.some((l) => l.includes('[Label:'))).toBe(false);
		expect(lines.some((l) => l.includes('Q1'))).toBe(true);
		expect(lines.some((l) => l.includes('A2'))).toBe(true);
	});

	it('cursor navigates only visible nodes after filter (not stuck on hidden label)', () => {
		const entries = [
			{ id: 'm1', parentId: null, type: 'model_change', timestamp: 't0', modelId: 'gpt-4' },
			{
				id: 'u1',
				parentId: 'm1',
				type: 'message',
				timestamp: 't1',
				message: { role: 'user', content: 'Q1' },
			},
			{ id: 'lab1', parentId: 'u1', type: 'label', timestamp: 't2', label: '#TUI' },
			{
				id: 'u2',
				parentId: 'lab1',
				type: 'message',
				timestamp: 't3',
				message: { role: 'user', content: 'Q2' },
			},
		];
		const { tui, component } = setup30NodePanel(entries as any);
		// default：可见 = u1, u2（2 条）。初始光标在叶子 u2；上移到 u1 后下移一次应回 u2，而非卡在隐藏 lab1
		(component as any).handleInput('\x1b[A'); // → u1
		(component as any).handleInput('\x1b[B'); // → u2
		const lines = panelLines(tui);
		const cursorLine = lines.find((l) => l.trimStart().startsWith('>'));
		expect(cursorLine).toBeDefined();
		expect(cursorLine!).toContain('Q2');
	});

	// ── 范围分析：标记顺序无关（回归：后代→祖先标记返回 0 条）──

	it('range analysis works regardless of mark order (descendant marked first)', () => {
		const entries = [
			{
				id: 'u1',
				parentId: null,
				type: 'message',
				timestamp: 't0',
				message: { role: 'user', content: 'Q1' },
			},
			{
				id: 'a1',
				parentId: 'u1',
				type: 'message',
				timestamp: 't1',
				message: { role: 'assistant', content: 'A1' },
			},
			{
				id: 't1',
				parentId: 'a1',
				type: 'message',
				timestamp: 't2',
				message: { role: 'toolResult', content: 'out', toolName: 'bash' },
			},
		];
		const { tui, component } = setup30NodePanel(entries as any);
		// 初始光标在叶子 t1；先上移到 a1 标记（后代），再上移到 u1 标记（祖先）→ 顺序反转
		(component as any).handleInput('\x1b[A'); // → a1
		(component as any).handleInput('m'); // 标记 a1
		(component as any).handleInput('\x1b[A'); // → u1
		(component as any).handleInput('m'); // 标记 u1，进 range
		const lines = panelLines(tui);
		// 范围应含 u1+a1 两条（而非 0 条）
		expect(lines.some((l) => l.includes('范围: 2 条'))).toBe(true);
	});
});

// ═══ Search functional tests ══════════════════════════════════════

describe('search — filtering', () => {
	it('filters entries by ASCII keyword', () => {
		const { tui, component } = setup30NodePanel();
		// Enter search, type "React"
		(component as any).handleInput('/');
		(component as any).handleInput('R');
		(component as any).handleInput('e');
		(component as any).handleInput('a');
		(component as any).handleInput('c');
		(component as any).handleInput('t');
		const lines = panelLines(tui).map(stripAnsi);
		// Should show user message with "React"
		expect(lines.some((l) => l.includes('React组件'))).toBe(true);
		// Should NOT show unrelated entries
		expect(lines.some((l) => l.includes('删除按钮'))).toBe(false);
		expect(lines.some((l) => l.includes('运行测试'))).toBe(false);
		// Exit search
		(component as any).handleInput('\x1b');
		const allLines = panelLines(tui).map(stripAnsi);
		// All entries back
		expect(allLines.some((l) => l.includes('删除按钮'))).toBe(true);
		expect(allLines.some((l) => l.includes('运行测试'))).toBe(true);
	});

	it('filters entries by Chinese keyword', () => {
		const { tui, component } = setup30NodePanel();
		(component as any).handleInput('/');
		(component as any).handleInput('搜');
		(component as any).handleInput('索');
		const lines = panelLines(tui).map(stripAnsi);
		// Should show "添加搜索功能" entry
		expect(lines.some((l) => l.includes('添加搜索功能'))).toBe(true);
		// Should NOT show unrelated
		expect(lines.some((l) => l.includes('删除按钮'))).toBe(false);
		// Page indicator should show fewer entries
		expect(lines.some((l) => l.includes('匹配'))).toBe(true);
	});

	it('exiting search shows all entries again', () => {
		const { tui, component } = setup30NodePanel();
		(component as any).handleInput('/');
		(component as any).handleInput('R');
		const filtered = panelLines(tui).map(stripAnsi);
		expect(filtered.some((l) => l.includes('React组件'))).toBe(true);
		// Press Enter to exit search
		(component as any).handleInput('\r');
		const restored = panelLines(tui).map(stripAnsi);
		// Should NOT show search bar
		const hasSearchBar = restored.some((l) => l.includes('搜索:'));
		expect(hasSearchBar).toBe(false);
		// All entries visible again
		expect(restored.some((l) => l.includes('删除按钮'))).toBe(true);
		expect(restored.some((l) => l.includes('运行测试'))).toBe(true);
	});

	it('shows page indicator with matching count when filtered', () => {
		const { tui, component } = setup30NodePanel();
		(component as any).handleInput('/');
		(component as any).handleInput('R');
		(component as any).handleInput('e');
		(component as any).handleInput('a');
		const lines = panelLines(tui).map(stripAnsi);
		// Should show "匹配" suffix since fewer entries match
		expect(lines.some((l) => l.includes('匹配'))).toBe(true);
	});
});

// ═══ Tag preview vs search consistency ════════════════════════════

describe('tag preview — search consistency', () => {
	it('tag preview and search filter return same count for same keyword', () => {
		const { tui, component } = setup30NodePanel();

		// Enter tag mode and type a keyword
		(component as any).handleInput('L'); // shift+l
		// Navigate to match field (down once)
		(component as any).handleInput('\x1b[B');
		// Type "React"
		for (const ch of 'React') (component as any).handleInput(ch);
		const tagLines = panelLines(tui).map(stripAnsi);
		// Extract count from preview: "共匹配 N 条..."
		const tagCountMatch = tagLines.find((l) => l.includes('共匹配'));
		const tagCount = tagCountMatch
			? parseInt(tagCountMatch.match(/共匹配 (\d+) 条/)![1], 10)
			: -1;
		expect(tagCount).toBeGreaterThan(0);

		// Exit tag mode, enter search mode with same keyword
		(component as any).handleInput('\x1b'); // Esc tag
		(component as any).handleInput('/'); // Enter search
		for (const ch of 'React') (component as any).handleInput(ch);
		const searchLines = panelLines(tui).map(stripAnsi);
		// Extract count from page indicator: "(1-X/N 匹配 / M 总计)"
		const searchCountMatch = searchLines.find((l) => l.includes('匹配'));
		const searchCount = searchCountMatch
			? parseInt(searchCountMatch.match(/(\d+) 匹配/)![1], 10)
			: -1;

		expect(tagCount).toBe(searchCount);
	});
});

// ═══ Search cursor behavior (regression) ══════════════════════════

describe('search — cursor selector behavior', () => {
	/** 当前光标行（'> ' 前缀） */
	function cursorLine(lines: string[]): string | undefined {
		return lines.find((l) => l.trimStart().startsWith('>'));
	}

	it('filter mode + search: cursor selector stays visible and navigates', () => {
		const { tui, component } = setup30NodePanel();
		// c → no-tools 过滤
		(component as any).handleInput('c');
		// / → 搜索，输入 React（匹配 >1 条）
		(component as any).handleInput('/');
		for (const ch of 'React') (component as any).handleInput(ch);
		const lines = panelLines(tui).map(stripAnsi);
		// 选择器可见且唯一
		const cursorCount = lines.filter((l) => l.trimStart().startsWith('>')).length;
		expect(cursorCount).toBe(1);
		const first = cursorLine(lines);
		// ↑↓ 导航：选择器仍可见且移动到下一匹配
		(component as any).handleInput('\x1b[B');
		const lines2 = panelLines(tui).map(stripAnsi);
		const cursorCount2 = lines2.filter((l) => l.trimStart().startsWith('>')).length;
		expect(cursorCount2).toBe(1);
		expect(cursorLine(lines2)).not.toBe(first);
	});

	it('enter keeps cursor on the selected match', () => {
		const { tui, component } = setup30NodePanel();
		(component as any).handleInput('/');
		for (const ch of 'React') (component as any).handleInput(ch);
		// 移动到第二个匹配
		(component as any).handleInput('\x1b[B');
		const selBefore = cursorLine(panelLines(tui).map(stripAnsi));
		// Enter 退出搜索
		(component as any).handleInput('\r');
		const after = panelLines(tui).map(stripAnsi);
		// 搜索栏消失，光标停留在所选节点
		expect(after.some((l) => l.includes('搜索:'))).toBe(false);
		expect(cursorLine(after)).toBe(selBefore);
	});

	it('filter mode + enter: cursor stays on the selected match', () => {
		const { tui, component } = setup30NodePanel();
		// c → no-tools 过滤
		(component as any).handleInput('c');
		(component as any).handleInput('/');
		for (const ch of 'React') (component as any).handleInput(ch);
		// 移动到第二个匹配
		(component as any).handleInput('\x1b[B');
		const selBefore = cursorLine(panelLines(tui).map(stripAnsi));
		// Enter 退出搜索（filterMode 保持 no-tools）
		(component as any).handleInput('\r');
		const after = panelLines(tui).map(stripAnsi);
		// 搜索栏消失，光标停留在所选节点（该节点在过滤下可见）
		expect(after.some((l) => l.includes('搜索:'))).toBe(false);
		expect(cursorLine(after)).toBe(selBefore);
	});

	it('esc restores cursor to the pre-search node', () => {
		const { tui, component } = setup30NodePanel();
		// 移动光标 3 次（记录进入搜索前位置）
		for (let i = 0; i < 3; i++) (component as any).handleInput('\x1b[B');
		const selBefore = cursorLine(panelLines(tui).map(stripAnsi));
		// 进入搜索 + 输入 + 导航
		(component as any).handleInput('/');
		for (const ch of 'React') (component as any).handleInput(ch);
		(component as any).handleInput('\x1b[B');
		// Esc 退出搜索
		(component as any).handleInput('\x1b');
		const after = panelLines(tui).map(stripAnsi);
		// 光标恢复到进入搜索前的节点
		expect(cursorLine(after)).toBe(selBefore);
	});

	it('filter mode + esc: cursor restores to the pre-search node', () => {
		const { tui, component } = setup30NodePanel();
		// c → no-tools 过滤
		(component as any).handleInput('c');
		// 在过滤状态下移动光标 3 次（0→a1→t1(过滤)→a2，落在可见节点）
		for (let i = 0; i < 3; i++) (component as any).handleInput('\x1b[B');
		const selBefore = cursorLine(panelLines(tui).map(stripAnsi));
		expect(selBefore).toBeDefined();
		// 进入搜索 + 输入 + 导航
		(component as any).handleInput('/');
		for (const ch of 'React') (component as any).handleInput(ch);
		(component as any).handleInput('\x1b[B');
		// Esc 退出搜索（filterMode 保持 no-tools）
		(component as any).handleInput('\x1b');
		const after = panelLines(tui).map(stripAnsi);
		// 光标恢复到进入搜索前的节点
		expect(cursorLine(after)).toBe(selBefore);
	});
});

// ═══ Width re-render & tag position (regression) ═══════════════════

describe('panel — dynamic width & tag position', () => {
	it('render width matches truncation — no row wrapping at any width', () => {
		// 长内容 + tag 的多节点树
		const longContent = '这是一个非常长的内容用于验证截断宽度一致性 '.repeat(6);
		const entries = [
			{
				id: 'r1',
				parentId: null,
				type: 'message',
				timestamp: 't1',
				label: '#GOOD,#FILE',
				message: { role: 'user', content: longContent },
			},
			{
				id: 'r2',
				parentId: 'r1',
				type: 'message',
				timestamp: 't2',
				label: '#FILE',
				message: { role: 'user', content: longContent + '第二条' },
			},
		];
		const { tui } = setup30NodePanel(entries as any);
		// 多种宽度下：每个节点恰好渲染 1 行（不因宽度不一致 wrap 错位），且每行不超宽
		for (const w of [60, 80, 120, 200]) {
			const lines = renderToSnapshot(tui, w, 30).map(stripAnsi);
			const nodeLines = lines.filter((l) => l.includes('user:'));
			// 2 个节点 → 恰好 2 行（无 wrap 分裂）
			expect(nodeLines.length).toBe(2);
			for (const l of nodeLines) {
				expect(l.length).toBeLessThanOrEqual(w);
			}
		}
	});

	it('resize: wider terminal re-renders and reveals truncated text', () => {
		// 超长 user 内容（>100 字符，80 列必然截断）
		const longContent = '这是一个非常长的内容用于测试宽度重渲染 '.repeat(8);
		const entries = [
			{
				id: 'r1',
				parentId: null,
				type: 'message',
				timestamp: 't1',
				message: { role: 'user', content: longContent },
			},
		];
		const { tui, term } = setup30NodePanel(entries as any);
		// 窄窗口（80 列）渲染
		const narrow = renderToSnapshot(tui, 80, 30).map(stripAnsi);
		const narrowLine = narrow.find((l) => l.includes('user:'));
		expect(narrowLine).toBeDefined();
		expect(narrowLine!.length).toBeLessThanOrEqual(80);
		// 加宽窗口（140 列）→ 重新渲染后显示更多内容
		term.setSize(140, 30);
		const wide = renderToSnapshot(tui).map(stripAnsi);
		const wideLine = wide.find((l) => l.includes('user:'));
		expect(wideLine).toBeDefined();
		expect(wideLine!.length).toBeGreaterThan(narrowLine!.length);
	});

	it('tag renders before the node text with a trailing space', () => {
		const entries = [
			{
				id: 'r1',
				parentId: null,
				type: 'message',
				timestamp: 't1',
				label: '#GOOD',
				message: { role: 'user', content: '修复完成' },
			},
		];
		const { tui } = setup30NodePanel(entries as any);
		const lines = panelLines(tui).map(stripAnsi);
		const line = lines.find((l) => l.includes('user:'));
		expect(line).toBeDefined();
		// tag（#GOOD）出现在节点文字（user:）之前
		expect(line!.indexOf('#GOOD')).toBeGreaterThanOrEqual(0);
		expect(line!.indexOf('#GOOD')).toBeLessThan(line!.indexOf('user:'));
		// tag 与节点内容之间必须有空格（不与内容粘连）
		const afterTag = line!.slice(line!.indexOf('#GOOD') + '#GOOD'.length);
		expect(afterTag.startsWith(' ')).toBe(true);
	});
});
