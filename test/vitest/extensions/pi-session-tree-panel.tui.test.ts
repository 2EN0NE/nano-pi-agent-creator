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
import { describe, it, expect } from 'vitest';
import { TuiMainScreen, type TUI } from '@earendil-works/pi-tui';
import { createPanel } from '../../../extensions/meta/pi-session-tree/ui/panel.js';
import { createSessionTree } from '../../../extensions/meta/pi-session-tree/index.js';
import {
	MockTerminal,
	renderToSnapshot,
	stripAnsi,
	assertWithinWidth,
} from '../../../src/tui-testing/index.js';

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
	const _bg: Record<string, string | number> = {
		selectedBg: 0,
		userMessageBg: 0,
		customMessageBg: 0,
		toolPendingBg: 0,
		toolSuccessBg: 0,
		toolErrorBg: 0,
	};
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
});
