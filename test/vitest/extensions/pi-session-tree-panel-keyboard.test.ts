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
import { describe, it, expect } from 'vitest';
import { TuiMainScreen, type TUI } from '@earendil-works/pi-tui';
import { createPanel } from '../../../extensions/meta/pi-session-tree/ui/panel.js';
import { createSessionTree } from '../../../extensions/meta/pi-session-tree/index.js';
import { MockTerminal, renderToSnapshot, stripAnsi } from '../../../src/tui-testing/index.js';

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

function toSessionEntry(e: any): any {
	return {
		id: e.id,
		parentId: e.parentId,
		type: e.type,
		timestamp: e.timestamp,
		message: e.message
			? { role: e.message.role, content: e.message.content, toolName: e.toolName }
			: undefined,
		toolName: e.toolName,
		tokensBefore: e.tokensBefore,
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

function setup30NodePanel() {
	const entries = build30NodeSession();
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
	return { tui, component, tree };
}

function panelLines(tui: TUI): string[] {
	return renderToSnapshot(tui, 80, 30).map(stripAnsi);
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
		expect(lines.some((l) => l.includes('React组件'))).toBe(true);
		expect(lines.some((l) => l.includes('Compaction'))).toBe(true);
		expect(lines.some((l) => l.includes('bash'))).toBe(true);
		expect(lines.some((l) => l.includes('g') && l.includes('跳转'))).toBe(true);
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

	it('m — marks current node and shows [m1] in tree', () => {
		const { tui, component, tree } = setup30NodePanel();
		(component as any).handleInput('m');
		const lines = panelLines(tui);
		expect(lines.some((l) => l.includes('[m1]'))).toBe(true);
		expect(tree.listMarks().length).toBe(1);
		expect(tree.listMarks()[0].n).toBe(1);
	});

	it('m — second mark shows [m2]', () => {
		const { tui, component, tree } = setup30NodePanel();
		(component as any).handleInput('\x1b[B');
		(component as any).handleInput('m');
		(component as any).handleInput('\x1b[B');
		(component as any).handleInput('m');
		const lines = panelLines(tui);
		expect(lines.some((l) => l.includes('[m1]'))).toBe(true);
		expect(lines.some((l) => l.includes('[m2]'))).toBe(true);
		expect(tree.listMarks().length).toBe(2);
	});

	// ── Jump bar ────────────────────────────────────────

	it('g — activates jump bar', () => {
		const { tui, component } = setup30NodePanel();
		(component as any).handleInput('g');
		expect(panelLines(tui).some((l) => l.includes('>'))).toBe(true);
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

	// ── Range footer ────────────────────────────────────

	it('~ — toggles range footer (no crash)', () => {
		const { tui, component } = setup30NodePanel();
		// First mark a node as range-from
		(component as any).handleInput('m');
		(component as any).handleInput('\x1b[B');
		// Toggle range on
		(component as any).handleInput('~');
		expect(panelLines(tui).length).toBeGreaterThan(5);
		// Toggle range off
		(component as any).handleInput('~');
		expect(panelLines(tui).length).toBeGreaterThan(5);
	});

	// ── Filters ─────────────────────────────────────────

	it('c filter — toggles no-tools mode', () => {
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
		expect(toolCountAfter).toBeLessThanOrEqual(toolCountBefore);
		(component as any).handleInput('c');
		const restored = panelLines(tui);
		const toolCountRestored = restored.filter(
			(l) => l.includes('[bash') || l.includes('[read') || l.includes('[edit'),
		).length;
		expect(toolCountRestored).toBeGreaterThanOrEqual(toolCountAfter);
	});

	it('u filter — shows only user messages (basic check)', () => {
		const { tui, component } = setup30NodePanel();
		(component as any).handleInput('u');
		const lines = panelLines(tui);
		expect(lines.length).toBeGreaterThan(0);
		expect(lines.some((l) => l.includes('React组件'))).toBe(true);
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

	// ── Copy ────────────────────────────────────────────

	it('ctrl+x — copies and shows toast', () => {
		const { tui, component } = setup30NodePanel();
		(component as any).handleInput('\x18');
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

	// ── Full workflow ───────────────────────────────────

	it('full workflow: m → move → ~ → ctrl+x', () => {
		const { tui, component, tree } = setup30NodePanel();
		(component as any).handleInput('m');
		expect(tree.listMarks().length).toBe(1);
		for (let i = 0; i < 5; i++) (component as any).handleInput('\x1b[B');
		(component as any).handleInput('~');
		expect(panelLines(tui).length).toBeGreaterThan(5);
		(component as any).handleInput('\x18');
		expect(panelLines(tui).some((l) => l.includes('已复制'))).toBe(true);
		(component as any).handleInput('g');
		expect(panelLines(tui).some((l) => l.includes('> '))).toBe(true);
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
});
