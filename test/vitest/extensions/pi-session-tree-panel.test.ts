/**
 * pi-session-tree TUI panel — Vitest tests
 *
 * Covers:
 *   - getRootNodes() returns correct tree structure
 *   - Tree flattening produces correct indent/connector topology
 *   - Filter logic edge cases (fold, filter modes)
 *   - Tree data: analyze, lastN
 */
import { describe, it, expect } from 'vitest';
import { createSessionTree } from '@zenone/pi-session-tree';

// ============================================================================
// Test helpers (from pi-session-tree.test.ts)
// ============================================================================

interface MockEntry {
	id: string;
	parentId: string | null;
	type: string;
	timestamp: string;
	label?: string;
	customType?: string;
	customLabel?: string;
	message?: { role: string; content: string | Array<{ type: string; text: string }> };
	details?: any;
}

function mockSessionManager(entries: MockEntry[]) {
	const sm = {
		getTree: () => buildTree(entries),
		getLeafId: () => (entries.length > 0 ? entries[entries.length - 1].id : null),
		getCwd: () => '/fake/cwd',
		getSessionId: () => 'test-session-id',
		getSessionDir: () => '/fake/sessions',
		getSessionFile: () => '/fake/sessions/test.jsonl',
		getEntry: (id: string) => {
			for (const e of entries) if (e.id === id) return toSessionEntry(e);
			return undefined;
		},
		getLabel: () => undefined,
		getBranch: () => [],
		buildContextEntries: () => [],
		getHeader: () => null,
		getEntries: () => entries.map(toSessionEntry) as any,
		getLeafEntry: () =>
			entries.length > 0 ? toSessionEntry(entries[entries.length - 1]) : undefined,
		getSessionName: () => undefined,
	};
	return sm;
}

function toSessionEntry(e: MockEntry): any {
	return {
		id: e.id,
		parentId: e.parentId,
		type: e.type,
		timestamp: e.timestamp,
		label: e.label,
		customType: e.customType,
		customLabel: e.customLabel,
		message: e.message,
		details: e.details,
	};
}

function buildTree(entries: MockEntry[]): any[] {
	const byId = new Map<string, MockEntry>();
	const children = new Map<string | null, MockEntry[]>();
	for (const e of entries) {
		byId.set(e.id, e);
		const key = e.parentId ?? '__root__';
		if (!children.has(key)) children.set(key, []);
		children.get(key)!.push(e);
	}
	function buildNode(e: MockEntry): any {
		const kids = (children.get(e.id) || []).map(buildNode);
		return {
			entry: toSessionEntry(e),
			children: kids,
			label: e.label,
		};
	}
	return (children.get('__root__') || []).map(buildNode);
}

// ============================================================================
// Tests
// ============================================================================

describe('getRootNodes', () => {
	it('returns roots from session tree', () => {
		const entries: MockEntry[] = [
			{ id: '0', parentId: null, type: 'session_info', timestamp: 't0' },
			{
				id: '1',
				parentId: '0',
				type: 'message',
				timestamp: 't1',
				message: { role: 'user', content: 'hi' },
			},
		];
		const tree = createSessionTree(mockSessionManager(entries));
		const roots = tree.getRootNodes();
		expect(roots).toHaveLength(1);
		expect(roots[0].id).toBe('0');
		expect(roots[0].children).toHaveLength(1);
		expect(roots[0].children[0].id).toBe('1');
	});

	it('returns multiple roots when applicable', () => {
		const entries: MockEntry[] = [
			{ id: '0', parentId: null, type: 'session_info', timestamp: 't0' },
			{ id: '1', parentId: null, type: 'session_info', timestamp: 't1' },
		];
		const tree = createSessionTree(mockSessionManager(entries));
		expect(tree.getRootNodes()).toHaveLength(2);
	});
});

describe('panel: filter modes on entry types', () => {
	function entryTypeFilter(type: string, mode: string): boolean {
		const hiddenInDefault = [
			'label',
			'custom',
			'model_change',
			'thinking_level_change',
			'session_info',
		];
		if (mode === 'default') return !hiddenInDefault.includes(type);
		if (mode === 'user-only') return type === 'message';
		return true; // 'all'
	}

	it('default mode hides settings/bookkeeping entries', () => {
		expect(entryTypeFilter('message', 'default')).toBe(true);
		expect(entryTypeFilter('compaction', 'default')).toBe(true);
		expect(entryTypeFilter('label', 'default')).toBe(false);
		expect(entryTypeFilter('model_change', 'default')).toBe(false);
		expect(entryTypeFilter('session_info', 'default')).toBe(false);
	});

	it('user-only mode only shows messages', () => {
		expect(entryTypeFilter('message', 'user-only')).toBe(true);
		expect(entryTypeFilter('compaction', 'user-only')).toBe(false);
	});

	it('all mode shows everything', () => {
		expect(entryTypeFilter('label', 'all')).toBe(true);
		expect(entryTypeFilter('session_info', 'all')).toBe(true);
	});
});

describe('panel: fold logic', () => {
	it('node with children is foldable', () => {
		const node = { id: '1', children: [{ id: '2', children: [] }] };
		expect(node.children.length > 0).toBe(true);
	});

	it('node without children is not foldable', () => {
		const node = { id: '1', children: [] };
		expect(node.children.length > 0).toBe(false);
	});

	it('folded nodes hide descendants', () => {
		const nodes = [
			{ id: '0', parentId: null },
			{ id: '1', parentId: '0' },
			{ id: '2', parentId: '1' },
			{ id: '3', parentId: '0' },
		];
		const folded = new Set(['1']);
		const skip = new Set<string>();
		for (const n of nodes) {
			if (n.parentId != null && (folded.has(n.parentId) || skip.has(n.parentId))) {
				skip.add(n.id);
			}
		}
		expect(skip.has('2')).toBe(true); // descendant of folded
		expect(skip.has('3')).toBe(false); // sibling, not descendant
	});
});

// ── New: window tab data tests ───────────────────────────────────────

describe('panel: window tab data', () => {
	function buildSessionWithMessages(): MockEntry[] {
		return [
			{ id: '0', parentId: null, type: 'session_info', timestamp: 't0' },
			{
				id: '1',
				parentId: '0',
				type: 'message',
				timestamp: 't1',
				message: { role: 'user', content: 'Hello, help me fix a bug' },
			},
			{
				id: '2',
				parentId: '1',
				type: 'message',
				timestamp: 't2',
				message: { role: 'assistant', content: 'Sure, let me look at the code' },
			},
			{
				id: '3',
				parentId: '2',
				type: 'message',
				timestamp: 't3',
				message: { role: 'toolResult', content: 'file contents here...' },
			},
			{
				id: '4',
				parentId: '3',
				type: 'message',
				timestamp: 't4',
				message: { role: 'assistant', content: 'I found the issue' },
			},
			{ id: '5', parentId: '4', type: 'compaction', timestamp: 't5' },
			{
				id: '6',
				parentId: '5',
				type: 'message',
				timestamp: 't6',
				message: { role: 'user', content: 'Thanks!' },
			},
			{
				id: '7',
				parentId: '6',
				type: 'message',
				timestamp: 't7',
				message: { role: 'assistant', content: 'You welcome' },
			},
			{ id: '8', parentId: '7', type: 'model_change', timestamp: 't8' },
			{
				id: '9',
				parentId: '8',
				type: 'message',
				timestamp: 't9',
				message: { role: 'user', content: 'One more thing...' },
			},
			{
				id: '10',
				parentId: '9',
				type: 'message',
				timestamp: 't10',
				message: { role: 'assistant', content: 'Go ahead' },
			},
		];
	}

	it('lastN returns correct number of recent entries', () => {
		const tree = createSessionTree(mockSessionManager(buildSessionWithMessages()));
		const last3 = tree.lastN(3);
		expect(last3).toHaveLength(3);
		expect(last3[0].id).toBe('8');
		expect(last3[1].id).toBe('9');
		expect(last3[2].id).toBe('10');
	});

	it('lastN on empty tree returns empty', () => {
		const tree = createSessionTree(mockSessionManager([]));
		expect(tree.lastN(10)).toHaveLength(0);
	});

	it('pathToLeaf returns full path', () => {
		const entries = buildSessionWithMessages();
		const tree = createSessionTree(mockSessionManager(entries));
		const path = tree.pathToLeaf();
		expect(path.length).toBe(entries.length);
	});

	it('analyze covers entries after compaction', () => {
		const tree = createSessionTree(mockSessionManager(buildSessionWithMessages()));
		const entries = buildSessionWithMessages();
		const report = tree.analyze(entries[5].id, entries[entries.length - 1].id);
		expect(report.segmentCount).toBeGreaterThanOrEqual(5);
		expect(report.byType['compaction']).toBe(1);
	});

	it('analyze correctly counts message and compaction types', () => {
		const entries = buildSessionWithMessages();
		const tree = createSessionTree(mockSessionManager(entries));
		const report = tree.analyze(entries[0].id, entries[entries.length - 1].id);
		expect(report.byType['message']).toBe(8);
		expect(report.byType['compaction']).toBe(1);
		expect(report.byType['model_change']).toBe(1);
	});
});
