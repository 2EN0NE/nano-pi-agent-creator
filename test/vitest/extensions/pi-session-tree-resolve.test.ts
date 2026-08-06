/**
 * pi-session-tree resolve() — Vitest tests
 *
 * Covers: @, @^, @~N, @~N:type, @^^type, mN, id prefix, a..b range
 */
import { describe, it, expect } from 'vitest';
import { createSessionTree } from '@zenone/pi-session-tree';

// ============================================================================
// Test helpers
// ============================================================================

interface MockEntry {
	id: string;
	parentId: string | null;
	type: string;
	timestamp: string;
	label?: string;
	customType?: string;
	message?: { role: string; content: string };
	toolName?: string;
	tokensBefore?: number;
	modelId?: string;
	thinkingLevel?: string;
	data?: any;
}

function toSessionEntry(e: MockEntry): any {
	return {
		id: e.id,
		parentId: e.parentId,
		type: e.type,
		timestamp: e.timestamp,
		label: e.label,
		customType: e.customType,
		message: e.message
			? {
					role: e.message.role,
					content: e.message.content,
					toolName: e.toolName,
				}
			: undefined,
		toolName: e.toolName,
		tokensBefore: e.tokensBefore,
		modelId: e.modelId,
		thinkingLevel: e.thinkingLevel,
		data: e.data,
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
		return { entry: toSessionEntry(e), children: kids, label: e.label };
	}
	return (children.get('__root__') || []).map(buildNode);
}

function mockSessionManager(
	entries: MockEntry[],
	opts?: { marks?: Array<{ n: number; nodeId: string }> },
) {
	// pi-lens-ignore: pi-lens/no-unused-vars
	const marks = opts?.marks ?? [];
	return {
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
		getEntries: () => entries.map(toSessionEntry),
		getLeafEntry: () =>
			entries.length > 0 ? toSessionEntry(entries[entries.length - 1]) : undefined,
		getSessionName: () => undefined,
	};
}

// ============================================================================
// Test tree
// ============================================================================

/** Build a tree: r1→c1→g1→t1→c2→cp1→c3(@leaf) */
function standardTree(): MockEntry[] {
	return [
		{
			id: 'r000000001',
			parentId: null,
			type: 'message',
			timestamp: 't0',
			message: { role: 'user', content: 'root' },
		},
		{
			id: 'c000000001',
			parentId: 'r000000001',
			type: 'message',
			timestamp: 't1',
			message: { role: 'assistant', content: 'child1' },
		},
		{
			id: 'g000000001',
			parentId: 'c000000001',
			type: 'message',
			timestamp: 't2',
			message: { role: 'user', content: 'grandchild' },
		},
		{
			id: 't000000001',
			parentId: 'g000000001',
			type: 'message',
			timestamp: 't3',
			message: { role: 'toolResult', content: 'bash output' },
			toolName: 'bash',
		},
		{
			id: 'c000000002',
			parentId: 't000000001',
			type: 'message',
			timestamp: 't4',
			message: { role: 'assistant', content: 'child2' },
		},
		{
			id: 'cp00000001',
			parentId: 'c000000002',
			type: 'compaction',
			timestamp: 't5',
			tokensBefore: 5000,
		},
		{
			id: 'c000000003',
			parentId: 'cp00000001',
			type: 'message',
			timestamp: 't6',
			message: { role: 'user', content: 'leaf user' },
		},
	];
}

// ============================================================================
// Tests
// ============================================================================

describe('resolve — single node', () => {
	it('@ returns current leaf', () => {
		const tree = createSessionTree(mockSessionManager(standardTree()));
		const result = tree.resolve('@');
		expect(result).not.toBeNull();
		expect(result).toHaveProperty('id', 'c000000003');
	});

	it('@^ returns parent', () => {
		const tree = createSessionTree(mockSessionManager(standardTree()));
		const result = tree.resolve('@^');
		expect(result).not.toBeNull();
		expect(result).toHaveProperty('id', 'cp00000001');
	});

	it('@~1 returns parent (same as @^)', () => {
		const tree = createSessionTree(mockSessionManager(standardTree()));
		const result = tree.resolve('@~1');
		expect(result).not.toBeNull();
		expect(result).toHaveProperty('id', 'cp00000001');
	});

	it('@~3 walks back 3 steps', () => {
		const tree = createSessionTree(mockSessionManager(standardTree()));
		const result = tree.resolve('@~3');
		expect(result).not.toBeNull();
		expect(result).toHaveProperty('id', 't000000001');
	});

	it('@~1:user — 1st user msg back from leaf', () => {
		const tree = createSessionTree(mockSessionManager(standardTree()));
		// leaf=c3(user), walk back counting user: g1(user) is 1st, r1(user) is 2nd
		const result = tree.resolve('@~1:user');
		expect(result).not.toBeNull();
		expect(result).toHaveProperty('id', 'g000000001');
	});

	it('@~2:user — 2nd user msg back', () => {
		const tree = createSessionTree(mockSessionManager(standardTree()));
		const result = tree.resolve('@~2:user');
		expect(result).not.toBeNull();
		expect(result).toHaveProperty('id', 'r000000001');
	});

	it('@~1:compaction — 1st compaction back', () => {
		const tree = createSessionTree(mockSessionManager(standardTree()));
		const result = tree.resolve('@~1:compaction');
		expect(result).not.toBeNull();
		expect(result).toHaveProperty('id', 'cp00000001');
	});

	it('@^^compaction finds nearest compaction ancestor', () => {
		const tree = createSessionTree(mockSessionManager(standardTree()));
		const result = tree.resolve('@^^compaction');
		expect(result).not.toBeNull();
		expect(result).toHaveProperty('id', 'cp00000001');
	});

	it('@^^message finds nearest message ancestor (parent)', () => {
		const tree = createSessionTree(mockSessionManager(standardTree()));
		// leaf=c3, parent=cp1(compaction), next up=c2(message)
		const result = tree.resolve('@^^message');
		expect(result).not.toBeNull();
		expect(result).toHaveProperty('id', 'c000000002');
	});

	it('ID prefix matches node (>= 6 hex chars)', () => {
		const tree = createSessionTree(mockSessionManager(standardTree()));
		const result = tree.resolve('cp000000');
		expect(result).not.toBeNull();
		expect(result).toHaveProperty('id', 'cp00000001');
	});

	it('short ID prefix matches if unambiguous', () => {
		const tree = createSessionTree(mockSessionManager(standardTree()));
		// "cp00" matches cp00000001 (1 match, unambiguous)
		const result = tree.resolve('cp00');
		expect(result).not.toBeNull();
		expect((result as any).id).toBe('cp00000001');
	});

	it('ID prefix ambiguous returns null', () => {
		const tree = createSessionTree(mockSessionManager(standardTree()));
		// "c00000000" matches both c000000001 and c000000002 and c000000003
		expect(tree.resolve('c000000')).toBeNull();
	});

	it('invalid expression returns null', () => {
		const tree = createSessionTree(mockSessionManager(standardTree()));
		expect(tree.resolve('')).toBeNull();
		expect(tree.resolve('xyz')).toBeNull();
		expect(tree.resolve('@~')).toBeNull();
	});

	it('@~99:user beyond available returns null', () => {
		const tree = createSessionTree(mockSessionManager(standardTree()));
		expect(tree.resolve('@~99:user')).toBeNull();
	});

	it('@~99 beyond available returns null', () => {
		const tree = createSessionTree(mockSessionManager(standardTree()));
		expect(tree.resolve('@~99')).toBeNull();
	});
});

describe('resolve — range', () => {
	it('@~3..@ returns range from 3 steps back to leaf', () => {
		const tree = createSessionTree(mockSessionManager(standardTree()));
		const result = tree.resolve('@~3..@');
		expect(result).not.toBeNull();
		expect(result).toHaveProperty('from');
		expect(result).toHaveProperty('to');
		const r = result as any;
		expect(r.from.id).toBe('t000000001');
		expect(r.to.id).toBe('c000000003');
	});

	it('@~2:user..@ returns range from 2nd user msg back to leaf', () => {
		const tree = createSessionTree(mockSessionManager(standardTree()));
		const result = tree.resolve('@~2:user..@');
		expect(result).not.toBeNull();
		const r = result as any;
		expect(r.from.id).toBe('r000000001');
		expect(r.to.id).toBe('c000000003');
	});

	it('a..b with two ID prefixes', () => {
		const tree = createSessionTree(mockSessionManager(standardTree()));
		const result = tree.resolve('g000000..c000000002');
		expect(result).not.toBeNull();
		const r = result as any;
		expect(r.from.id).toBe('g000000001');
		expect(r.to.id).toBe('c000000002');
	});
});

describe('resolve — mN marks', () => {
	it('m1 returns marked node when mark exists', () => {
		const entries = standardTree();
		const leafIdx = entries.length - 1;
		// Add mark annotation BEFORE the leaf so leaf stays last
		entries.splice(leafIdx, 0, {
			id: 'mark_ann_1',
			parentId: 'g000000001',
			type: 'custom',
			timestamp: 't-ann',
			message: { role: 'assistant', content: '' },
			customType: 'mark',
			data: { index: 1 },
		});
		const tree = createSessionTree(mockSessionManager(entries));
		const result = tree.resolve('m1');
		expect(result).not.toBeNull();
		expect(result).toHaveProperty('id', 'g000000001');
	});

	it('m1 returns null when mark does not exist', () => {
		const tree = createSessionTree(mockSessionManager(standardTree()));
		expect(tree.resolve('m1')).toBeNull();
	});

	it('m1..@ returns range from mark to leaf', () => {
		const entries = standardTree();
		const leafIdx = entries.length - 1;
		entries.splice(leafIdx, 0, {
			id: 'mark_ann_2',
			parentId: 'g000000001',
			type: 'custom',
			timestamp: 't-ann',
			message: { role: 'assistant', content: '' },
			customType: 'mark',
			data: { index: 1 },
		});
		const tree = createSessionTree(mockSessionManager(entries));
		const result = tree.resolve('m1..@');
		expect(result).not.toBeNull();
		const r = result as any;
		expect(r.from.id).toBe('g000000001');
		expect(r.to.id).toBe('c000000003');
	});
});
