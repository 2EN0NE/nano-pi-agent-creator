/**
 * pi-session-tree panel — Headless TUI snapshot tests
 *
 * Verifies:
 *   - Panel renders without crash
 *   - No line exceeds terminal width
 *   - Flat layout (no trapezoid indentation chains)
 *   - Key elements present (session ID, g/jump hint, tree nodes)
 *   - Colors present in output (ANSI escape sequences)
 */
import { describe, it, expect, vi } from 'vitest';
import { TuiMainScreen } from '@earendil-works/pi-tui';
import { createPanel } from '../../../extensions/meta/pi-session-tree/ui/panel.js';
import { createSessionTree } from '../../../extensions/meta/pi-session-tree/index.js';
import {
	MockTerminal,
	renderToSnapshot,
	stripAnsi,
	assertWithinWidth,
} from '../../../src/tui-testing/index.js';

vi.mock('@earendil-works/pi-coding-agent', () => ({
	copyToClipboard: () => {},
	rawKeyHint: (key: string, description: string) => `${key} ${description}`,
}));

// ═══ Mock Theme ════════════════════════════════════════════════════

function mockTheme(): any {
	const slots = [
		'accent',
		'border',
		'borderAccent',
		'borderMuted',
		'success',
		'error',
		'warning',
		'muted',
		'dim',
		'text',
		'thinkingText',
		'userMessageText',
		'customMessageText',
		'customMessageLabel',
		'toolTitle',
		'toolOutput',
		'mdHeading',
		'mdLink',
		'mdLinkUrl',
		'mdCode',
		'mdCodeBlock',
		'mdCodeBlockBorder',
		'mdQuote',
		'mdQuoteBorder',
		'mdHr',
		'mdListBullet',
		'toolDiffAdded',
		'toolDiffRemoved',
		'toolDiffContext',
		'syntaxComment',
		'syntaxKeyword',
		'syntaxFunction',
		'syntaxVariable',
		'syntaxString',
		'syntaxNumber',
		'syntaxType',
		'syntaxOperator',
		'syntaxPunctuation',
		'thinkingOff',
		'thinkingMinimal',
		'thinkingLow',
		'thinkingMedium',
		'thinkingHigh',
		'thinkingXhigh',
		'thinkingMax',
		'bashMode',
	];
	const fg: Record<string, string | number> = {};
	for (const s of slots) fg[s] = 7;
	return {
		fg: (_color: string, text: string) => `\x1b[37m${text}\x1b[0m`,
		bg: (_c: string, text: string) => text,
		bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
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

// ═══ Mock Keybindings ══════════════════════════════════════════════

function mockKeybindings(): any {
	return {
		matches: () => false,
		getDefinition: () => undefined,
	};
}

// ═══ Test tree helpers ═════════════════════════════════════════════

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
	return {
		getTree: () => buildTree(entries),
		getLeafId: () => entries[entries.length - 1].id,
		getCwd: () => '/fake',
		getSessionId: () => 'test',
		getSessionDir: () => '/fake',
		getSessionFile: () => '/fake',
		getEntry: (id: string) => {
			for (const e of entries) if (e.id === id) return toSessionEntry(e);
		},
		getLabel: () => undefined,
		getBranch: () => [],
		buildContextEntries: () => [],
		getHeader: () => null,
		getEntries: () => entries.map(toSessionEntry),
		getLeafEntry: () => toSessionEntry(entries[entries.length - 1]),
		getSessionName: () => undefined,
	};
}

/** mockSm + 带状态的标签存储（验证 setLabels → getLabel 持久化） */
function mockSmWithLabels(entries: any[]) {
	const base = mockSm(entries);
	const labels = new Map<string, string>();
	return {
		...base,
		getLabel: (id: string) => labels.get(id),
		appendLabelChange: (id: string, label: string | undefined) => {
			if (label !== undefined) labels.set(id, label);
			else labels.delete(id);
			return id;
		},
	};
}

/** 复刻 createSessionTreeWithPi 的 setLabels（面板实际写入路径） */
function wireSetLabels(tree: any, sm: ReturnType<typeof mockSmWithLabels>) {
	tree.setLabels = (entryId: string, labels: string[]) => {
		const existing = sm.getLabel(entryId) ?? '';
		const existingParts = existing
			.split(',')
			.map((s: string) => s.trim())
			.filter(Boolean);
		const nonTagParts = existingParts.filter((s: string) => !s.startsWith('#'));
		const newTagParts = labels.map((l: string) => (l.startsWith('#') ? l : `#${l}`));
		const merged = [...nonTagParts, ...newTagParts].join(',');
		if (merged !== existing) {
			if (merged) sm.appendLabelChange(entryId, merged);
			else sm.appendLabelChange(entryId, undefined);
		}
	};
}

// ═══ Tests ═════════════════════════════════════════════════════════

describe('pi-session-tree panel — headless snapshot', () => {
	it('renders without crashing', () => {
		const term = new MockTerminal(80, 24);
		const tui = new TuiMainScreen(term);
		const tree = createSessionTree(
			mockSm([
				{
					id: 'r001',
					parentId: null,
					type: 'message',
					timestamp: 't0',
					message: { role: 'user', content: 'hi' },
				},
			]),
		);
		const component = createPanel(
			tui,
			mockTheme(),
			mockKeybindings(),
			() => {},
			tree,
			'test-session-123',
		);
		tui.addChild(component);
		tui.setFocus(component);
		tui.start();
		const snapshot = renderToSnapshot(tui, 80, 24);
		expect(snapshot.length).toBeGreaterThan(5);
	});

	it('renders session ID in header', () => {
		const term = new MockTerminal(80, 24);
		const tui = new TuiMainScreen(term);
		const tree = createSessionTree(
			mockSm([
				{
					id: 'r001',
					parentId: null,
					type: 'message',
					timestamp: 't0',
					message: { role: 'user', content: 'hi' },
				},
			]),
		);
		const component = createPanel(
			tui,
			mockTheme(),
			mockKeybindings(),
			() => {},
			tree,
			'my-session-id-7890',
		);
		tui.addChild(component);
		tui.setFocus(component);
		tui.start();
		const plain = renderToSnapshot(tui, 80, 24).map(stripAnsi);
		const headerLine = plain.find((l) => l.includes('my-sessi'));
		expect(headerLine).toBeDefined();
		expect(headerLine).toContain('my-sessi');
	});

	it('renders jump/hint line with g/m/~ keys', () => {
		const term = new MockTerminal(80, 24);
		const tui = new TuiMainScreen(term);
		const tree = createSessionTree(
			mockSm([
				{
					id: 'r001',
					parentId: null,
					type: 'message',
					timestamp: 't0',
					message: { role: 'user', content: 'hi' },
				},
			]),
		);
		const component = createPanel(tui, mockTheme(), mockKeybindings(), () => {}, tree, 'sid');
		tui.addChild(component);
		tui.setFocus(component);
		tui.start();
		const plain = renderToSnapshot(tui, 80, 24).map(stripAnsi);
		const hintLine = plain.find(
			(l) => l.includes('g') && (l.includes('跳转') || l.includes('标记')),
		);
		expect(hintLine).toBeDefined();
	});

	it('renders tree nodes with content', () => {
		const entries = [
			{
				id: 'r001',
				parentId: null,
				type: 'message',
				timestamp: 't0',
				message: { role: 'user', content: 'hello world' },
			},
			{
				id: 'c001',
				parentId: 'r001',
				type: 'message',
				timestamp: 't1',
				message: { role: 'toolResult', content: 'bash output' },
				toolName: 'bash',
			},
			{
				id: 'cp01',
				parentId: 'c001',
				type: 'compaction',
				timestamp: 't2',
				tokensBefore: 5000,
			},
		];
		const term = new MockTerminal(80, 24);
		const tui = new TuiMainScreen(term);
		const tree = createSessionTree(mockSm(entries));
		const component = createPanel(tui, mockTheme(), mockKeybindings(), () => {}, tree, 'sid');
		tui.addChild(component);
		tui.setFocus(component);
		tui.start();
		const plain = renderToSnapshot(tui, 80, 24).map(stripAnsi);
		expect(plain.some((l) => l.includes('hello world'))).toBe(true);
		expect(plain.some((l) => l.includes('Compaction'))).toBe(true);
		expect(plain.some((l) => l.includes('bash'))).toBe(true);
	});

	it('no line exceeds terminal width', () => {
		const term = new MockTerminal(80, 24);
		const tui = new TuiMainScreen(term);
		const tree = createSessionTree(
			mockSm([
				{
					id: 'r001',
					parentId: null,
					type: 'message',
					timestamp: 't0',
					message: { role: 'user', content: 'a'.repeat(200) },
				},
			]),
		);
		const component = createPanel(tui, mockTheme(), mockKeybindings(), () => {}, tree, 'sid');
		tui.addChild(component);
		tui.setFocus(component);
		tui.start();
		assertWithinWidth(renderToSnapshot(tui, 80, 24), 80);
	});

	it('renders with ANSI color codes', () => {
		const term = new MockTerminal(80, 24);
		const tui = new TuiMainScreen(term);
		const tree = createSessionTree(
			mockSm([
				{
					id: 'r001',
					parentId: null,
					type: 'message',
					timestamp: 't0',
					message: { role: 'user', content: 'hi' },
				},
			]),
		);
		const component = createPanel(tui, mockTheme(), mockKeybindings(), () => {}, tree, 'sid');
		tui.addChild(component);
		tui.setFocus(component);
		tui.start();
		const snapshot = renderToSnapshot(tui, 80, 24);
		expect(snapshot.some((l) => l.includes('\x1b'))).toBe(true);
	});

	it('footer contains help text', () => {
		const term = new MockTerminal(80, 24);
		const tui = new TuiMainScreen(term);
		const tree = createSessionTree(
			mockSm([
				{
					id: 'r001',
					parentId: null,
					type: 'message',
					timestamp: 't0',
					message: { role: 'user', content: 'hi' },
				},
			]),
		);
		const component = createPanel(tui, mockTheme(), mockKeybindings(), () => {}, tree, 'sid');
		tui.addChild(component);
		tui.setFocus(component);
		tui.start();
		const plain = renderToSnapshot(tui, 80, 24).map(stripAnsi);
		expect(plain.some((l) => l.includes('关闭') || l.includes('ctrl+x'))).toBe(true);
	});

	it('no multi-line entries from un-stripped newlines', () => {
		const entries = [
			{
				id: 'r001',
				parentId: null,
				type: 'message',
				timestamp: 't0',
				message: { role: 'user', content: 'run' },
			},
			{
				id: 'c001',
				parentId: 'r001',
				type: 'message',
				timestamp: 't1',
				message: { role: 'toolResult', content: 'line1\nline2\nline3', toolName: 'bash' },
				toolName: 'bash',
			},
		];
		const term = new MockTerminal(80, 24);
		const tui = new TuiMainScreen(term);
		const tree = createSessionTree(mockSm(entries));
		const component = createPanel(tui, mockTheme(), mockKeybindings(), () => {}, tree, 'sid');
		tui.addChild(component);
		tui.setFocus(component);
		tui.start();
		const plain = renderToSnapshot(tui, 80, 24).map(stripAnsi);
		expect(plain.some((l) => l.includes('\\n'))).toBe(false);
	});

	it('flat layout — small tree has limited indent depth', () => {
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
				message: { role: 'toolResult', content: 'T1' },
				toolName: 'bash',
			},
			{
				id: 'a2',
				parentId: 't1',
				type: 'message',
				timestamp: 't3',
				message: { role: 'assistant', content: 'A2' },
			},
			{
				id: 'a3',
				parentId: 'a2',
				type: 'message',
				timestamp: 't4',
				message: { role: 'assistant', content: 'A3' },
			},
		];
		const term = new MockTerminal(80, 24);
		const tui = new TuiMainScreen(term);
		const tree = createSessionTree(mockSm(entries));
		const component = createPanel(tui, mockTheme(), mockKeybindings(), () => {}, tree, 'sid');
		tui.addChild(component);
		tui.setFocus(component);
		tui.start();
		const plain = renderToSnapshot(tui, 80, 24).map(stripAnsi);
		const treeLines = plain.filter((l) => /(user|assistant):|\[.*\]|Compaction/.test(l));
		const leadingSpaces = treeLines.map((l) => l.match(/^( *)/)?.[1]?.length ?? 0);
		const maxIndent = Math.max(...leadingSpaces, 0);
		expect(maxIndent).toBeLessThanOrEqual(6);
		const indentSet = new Set(leadingSpaces);
		expect(indentSet.size).toBeLessThanOrEqual(3);
	});

	it('flat layout — deep 20-entry chain stays flat', () => {
		const entries: any[] = [];
		let prevId: string | null = null;
		for (let i = 0; i < 20; i++) {
			const id = `n${String(i).padStart(2, '0')}`;
			const role = i % 5 === 0 ? 'user' : i % 5 === 3 ? 'toolResult' : 'assistant';
			entries.push({
				id,
				parentId: prevId,
				type: i === 10 ? 'compaction' : 'message',
				timestamp: `t${i}`,
				message:
					role === 'toolResult'
						? { role: 'toolResult', content: `tool${i}`, toolName: 'bash' }
						: { role, content: `msg${i}` },
				toolName: role === 'toolResult' ? 'bash' : undefined,
				tokensBefore: i === 10 ? 5000 : undefined,
			});
			prevId = id;
		}
		const term = new MockTerminal(80, 30);
		const tui = new TuiMainScreen(term);
		const tree = createSessionTree(mockSm(entries));
		const component = createPanel(tui, mockTheme(), mockKeybindings(), () => {}, tree, 'deep');
		tui.addChild(component);
		tui.setFocus(component);
		tui.start();
		const plain = renderToSnapshot(tui, 80, 30).map(stripAnsi);
		const treeLines = plain.filter((l) => /(user|assistant):|\[.*\]|Compaction/.test(l));
		expect(treeLines.length).toBeGreaterThanOrEqual(15);
		const leadingSpaces = treeLines.map((l) => l.match(/^( *)/)?.[1]?.length ?? 0);
		const maxIndent = Math.max(...leadingSpaces, 0);
		expect(maxIndent).toBeLessThanOrEqual(6);
		const indentSet = new Set(leadingSpaces);
		expect(indentSet.size).toBeLessThanOrEqual(3);
	});

	// ── Tag mode ─────────────────────────────────────────

	it('ctrl+l — tag panel opens with type/match/label fields', () => {
		const term = new MockTerminal(80, 24);
		const tui = new TuiMainScreen(term);
		const tree = createSessionTree(
			mockSm([
				{
					id: 'r001',
					parentId: null,
					type: 'message',
					timestamp: 't0',
					message: { role: 'user', content: 'hi' },
				},
			]),
		);
		const component = createPanel(tui, mockTheme(), mockKeybindings(), () => {}, tree, 'sid');
		tui.addChild(component);
		tui.setFocus(component);
		tui.start();
		(component as any).handleInput('L'); // shift+l opens tag panel
		const plain = renderToSnapshot(tui, 80, 24).map(stripAnsi);
		expect(plain.some((l) => l.includes('类型:') && l.includes('全部类型'))).toBe(true);
		expect(plain.some((l) => l.includes('匹配:'))).toBe(true);
		expect(plain.some((l) => l.includes('打标:'))).toBe(true);
		expect(plain.some((l) => l.includes('添加规则'))).toBe(true);
	});

	it('session rule add → rescanLabels writes #labels and tag summary shows counts', () => {
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
		];
		const sm = mockSmWithLabels(entries);
		const tree = createSessionTree(sm);
		wireSetLabels(tree, sm);
		const term = new MockTerminal(80, 24);
		const tui = new TuiMainScreen(term);
		const component = createPanel(tui, mockTheme(), mockKeybindings(), () => {}, tree, 'sid');
		tui.addChild(component);
		tui.setFocus(component);
		tui.start();
		(component as any).handleInput('L'); // shift+l open tag panel
		(component as any).handleInput('\x1b[B'); // down → match field
		(component as any).handleInput('\x1b[B'); // down → label field
		(component as any).handleInput('超时'); // label text
		(component as any).handleInput('\r'); // enter → add rule + rescanLabels
		// typeIndex=0（全部类型）+ 空 matchText → 所有条目打标
		expect(sm.getLabel('u1')).toBe('#超时');
		expect(sm.getLabel('a1')).toBe('#超时');
		const plain = renderToSnapshot(tui, 80, 24).map(stripAnsi);
		expect(plain.some((l) => l.includes('标签:') && l.includes('超时'))).toBe(true);
	});

	it('config rule labels survive rescanLabels (regression: matchesRule semantics)', () => {
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
				message: { role: 'toolResult', content: 'file updated' },
				toolName: 'edit',
			},
		];
		const sm = mockSmWithLabels(entries);
		const tree = createSessionTree(sm);
		// config 规则：仅 tool_call + toolName=edit 匹配（旧版面板子串语义会匹配不到）
		tree.setTagRules([
			{ on: 'tool_call', match: { toolName: 'edit' }, label: '修改', source: 'config' },
		]);
		wireSetLabels(tree, sm);
		// 模拟 turn_end 自动打标已写入 config 标签
		(tree as any).setLabels('a1', ['修改']);
		expect(sm.getLabel('a1')).toBe('#修改');

		const term = new MockTerminal(80, 24);
		const tui = new TuiMainScreen(term);
		const component = createPanel(tui, mockTheme(), mockKeybindings(), () => {}, tree, 'sid');
		tui.addChild(component);
		tui.setFocus(component);
		tui.start();
		(component as any).handleInput('L'); // shift+l open tag panel（加载 config 规则）
		(component as any).handleInput('\x1b[B'); // down → match field
		(component as any).handleInput('\x1b[B'); // down → label field
		(component as any).handleInput('测试'); // 添加 session 规则触发 rescanLabels
		(component as any).handleInput('\r');
		// 回归断言：rescanLabels 后 config 规则标签仍保留（未被子串语义清除）
		expect(sm.getLabel('a1')).toBe('#修改,#测试');
		// 非 tool_call 条目只被 session 规则打标
		expect(sm.getLabel('u1')).toBe('#测试');
	});
});

// ═══ Ghosting fix: page size adapts to terminal height ════════════

function buildLongSession(n: number): any[] {
	const entries: any[] = [];
	let parentId: string | null = null;
	for (let i = 1; i <= n; i++) {
		const uid = `u${String(i).padStart(3, '0')}`;
		entries.push({
			id: uid,
			parentId,
			type: 'message',
			timestamp: `t${i}`,
			message: { role: 'user', content: `msg ${i}` },
		});
		const aid = `a${String(i).padStart(3, '0')}`;
		entries.push({
			id: aid,
			parentId: uid,
			type: 'message',
			timestamp: `t${i}.5`,
			message: { role: 'assistant', content: 'reply' },
		});
		parentId = aid;
	}
	return entries;
}

describe('panel — page size adapts to terminal height (ghosting fix)', () => {
	// 组件总高必须 ≤ 终端视口高度：否则树行起始落在视口上方，
	// 滚动时 firstChanged < viewportTop → pi 触发 fullRender(true) → 同步输出失效时重影
	const heights = [16, 20, 24, 28, 30];
	for (const h of heights) {
		it(`panel total height <= ${h} terminal rows`, () => {
			const term = new MockTerminal(80, h);
			const tui = new TuiMainScreen(term);
			const tree = createSessionTree(mockSm(buildLongSession(30)));
			const component = createPanel(
				tui,
				mockTheme(),
				mockKeybindings(),
				() => {},
				tree,
				'sid',
			);
			tui.addChild(component);
			tui.setFocus(component);
			tui.start();
			const snapshot = renderToSnapshot(tui, 80, h).map(stripAnsi);
			const nonEmpty = snapshot.filter((l) => l.trim().length > 0).length;
			expect(nonEmpty).toBeLessThanOrEqual(h);
		});
	}

	it('cursor centers in viewport after scrolling (long tree)', () => {
		const term = new MockTerminal(80, 24);
		const tui = new TuiMainScreen(term);
		const tree = createSessionTree(mockSm(buildLongSession(30)));
		const component = createPanel(tui, mockTheme(), mockKeybindings(), () => {}, tree, 'sid');
		tui.addChild(component);
		tui.setFocus(component);
		tui.start();
		// buildLongSession(30) = 60 节点（30 user + 30 assistant），叶子 = a030（index 59）
		// 初始光标定位到叶子（D2）→ cursorLine=59
		// pageSize = 24 - 8 = 16，居中偏移 floor(16/2) = 8
		// 按 10 次 down → cursorLine = (59+10) % 60 = 9 → scrollOffset = clamp(9-8, 0, 60-16) = 1 → pageInfo = (2-17/60)
		for (let i = 0; i < 10; i++) (component as any).handleInput('\x1b[B');
		const plain = renderToSnapshot(tui, 80, 24).map(stripAnsi);
		const pageInfo = plain.find((l) => l.includes('(2-17/60)'));
		expect(pageInfo).toBeTruthy();
	});
});
