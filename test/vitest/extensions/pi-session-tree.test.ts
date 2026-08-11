/**
 * @zenone/pi-session-tree — Vitest tests
 *
 * Covers:
 *   - createSessionTree factory
 *   - TreeNode type wrapping
 *   - A. Node queries: findByType, findByLabel, findAncestor
 *   - B. Path queries: pathToLeaf, pathBetween, distance, LCA, entriesBetween
 *   - C. Structure: branchCount, maxDepth, pathLength, treeComplexity
 *   - D. Aggregation: countByType, toolCallDistribution, compactionHistory, entryTypeTimeline
 */
import { describe, it, expect } from 'vitest';
import { createSessionTree } from '@zenone/pi-session-tree';

// ============================================================================
// Test helpers — mock SessionManager that returns a minimal tree
// ============================================================================

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

interface MockEntry {
	id: string;
	parentId: string | null;
	type: string;
	timestamp: string;
	label?: string;
	message?: { role: string; content: string | Array<{ type: string; text: string }> };
	details?: any;
}

function toSessionEntry(e: MockEntry): any {
	return {
		id: e.id,
		parentId: e.parentId,
		type: e.type,
		timestamp: e.timestamp,
		label: e.label,
		message: e.message,
		details: e.details,
	};
}

function buildTree(entries: MockEntry[]): any[] {
	const byId = new Map<string, MockEntry>();
	const children = new Map<string | null, MockEntry[]>();

	for (const e of entries) {
		byId.set(e.id, e);
		const pid = e.parentId;
		if (!children.has(pid)) children.set(pid, []);
		children.get(pid)!.push(e);
	}

	function buildNode(e: MockEntry): any {
		const kids = children.get(e.id) ?? [];
		return {
			entry: toSessionEntry(e),
			children: kids.map(buildNode),
			label: e.label,
		};
	}

	const roots = children.get(null) ?? [];
	return roots.map(buildNode);
}

// ============================================================================
// Tests
// ============================================================================

describe('createSessionTree', () => {
	it('creates a tree from a session manager', () => {
		const sm = mockSessionManager([]);
		const tree = createSessionTree(sm);
		expect(tree).toBeDefined();
		expect(typeof tree.pathToLeaf).toBe('function');
	});
});

describe('pathToLeaf', () => {
	it('returns empty array for empty session', () => {
		const sm = mockSessionManager([]);
		const tree = createSessionTree(sm);
		expect(tree.pathToLeaf()).toEqual([]);
	});

	it('returns single node for single-entry session', () => {
		const sm = mockSessionManager([
			{ id: '1', parentId: null, type: 'message', timestamp: '2025-01-01T00:00:00Z' },
		]);
		const tree = createSessionTree(sm);
		const path = tree.pathToLeaf();
		expect(path).toHaveLength(1);
		expect(path[0].id).toBe('1');
		expect(path[0].depth).toBe(0);
		expect(path[0].type).toBe('message');
	});

	it('returns root-to-leaf path for linear session', () => {
		const sm = mockSessionManager([
			{ id: '1', parentId: null, type: 'message', timestamp: '2025-01-01T00:00:00Z' },
			{ id: '2', parentId: '1', type: 'model_change', timestamp: '2025-01-01T00:00:01Z' },
			{ id: '3', parentId: '2', type: 'message', timestamp: '2025-01-01T00:00:02Z' },
		]);
		const tree = createSessionTree(sm);
		const path = tree.pathToLeaf();
		expect(path).toHaveLength(3);
		expect(path[0].id).toBe('1');
		expect(path[0].depth).toBe(0);
		expect(path[1].id).toBe('2');
		expect(path[1].depth).toBe(1);
		expect(path[2].id).toBe('3');
		expect(path[2].depth).toBe(2);
	});
});

describe('branchCount', () => {
	it('returns 0 for linear session', () => {
		const sm = mockSessionManager([
			{ id: '1', parentId: null, type: 'message', timestamp: 't1' },
			{ id: '2', parentId: '1', type: 'message', timestamp: 't2' },
		]);
		const tree = createSessionTree(sm);
		expect(tree.branchCount()).toBe(0);
	});

	it('counts fork points', () => {
		const sm = mockSessionManager([
			{ id: '1', parentId: null, type: 'message', timestamp: 't1' },
			{ id: '2a', parentId: '1', type: 'message', timestamp: 't2' },
			{ id: '2b', parentId: '1', type: 'message', timestamp: 't2' },
		]);
		const tree = createSessionTree(sm);
		expect(tree.branchCount()).toBe(1);
	});
});

describe('maxDepth', () => {
	it('returns 0 for empty session', () => {
		const sm = mockSessionManager([]);
		const tree = createSessionTree(sm);
		expect(tree.maxDepth()).toBe(0);
	});

	it('returns depth for linear session', () => {
		const sm = mockSessionManager([
			{ id: '1', parentId: null, type: 'message', timestamp: 't1' },
			{ id: '2', parentId: '1', type: 'message', timestamp: 't2' },
			{ id: '3', parentId: '2', type: 'message', timestamp: 't3' },
		]);
		const tree = createSessionTree(sm);
		expect(tree.maxDepth()).toBe(2);
	});

	it('returns max depth for branched session', () => {
		const sm = mockSessionManager([
			{ id: '1', parentId: null, type: 'message', timestamp: 't1' },
			{ id: '2a', parentId: '1', type: 'message', timestamp: 't2' },
			{ id: '3a', parentId: '2a', type: 'message', timestamp: 't3' },
			{ id: '2b', parentId: '1', type: 'message', timestamp: 't2' },
		]);
		const tree = createSessionTree(sm);
		expect(tree.maxDepth()).toBe(2);
	});
});

describe('findByType', () => {
	it('finds all entries of a given type', () => {
		const sm = mockSessionManager([
			{ id: '1', parentId: null, type: 'message', timestamp: 't1' },
			{ id: '2', parentId: '1', type: 'model_change', timestamp: 't2' },
			{ id: '3', parentId: '2', type: 'message', timestamp: 't3' },
		]);
		const tree = createSessionTree(sm);
		expect(tree.findByType('message')).toHaveLength(2);
		expect(tree.findByType('model_change')).toHaveLength(1);
		expect(tree.findByType('compaction')).toHaveLength(0);
	});
});

describe('findByLabel', () => {
	it('finds entry with matching label', () => {
		const sm = mockSessionManager([
			{ id: '1', parentId: null, type: 'message', timestamp: 't1', label: 'start' },
			{ id: '2', parentId: '1', type: 'message', timestamp: 't2' },
		]);
		const tree = createSessionTree(sm);
		const found = tree.findByLabel('start');
		expect(found).toBeDefined();
		expect(found!.id).toBe('1');
	});

	it('returns undefined for unknown label', () => {
		const sm = mockSessionManager([
			{ id: '1', parentId: null, type: 'message', timestamp: 't1' },
		]);
		const tree = createSessionTree(sm);
		expect(tree.findByLabel('nonexistent')).toBeUndefined();
	});
});

describe('findAncestor', () => {
	it('finds nearest ancestor of given type', () => {
		const sm = mockSessionManager([
			{ id: '1', parentId: null, type: 'message', timestamp: 't1' },
			{ id: '2', parentId: '1', type: 'model_change', timestamp: 't2' },
			{ id: '3', parentId: '2', type: 'message', timestamp: 't3' },
		]);
		const tree = createSessionTree(sm);
		const ancestor = tree.findAncestor('3', 'model_change');
		expect(ancestor).toBeDefined();
		expect(ancestor!.id).toBe('2');
	});

	it('returns undefined if no such ancestor', () => {
		const sm = mockSessionManager([
			{ id: '1', parentId: null, type: 'message', timestamp: 't1' },
			{ id: '2', parentId: '1', type: 'message', timestamp: 't2' },
		]);
		const tree = createSessionTree(sm);
		expect(tree.findAncestor('2', 'compaction')).toBeUndefined();
	});
});

describe('pathBetween', () => {
	it('returns path segment between two nodes', () => {
		const sm = mockSessionManager([
			{ id: '1', parentId: null, type: 'message', timestamp: 't1' },
			{ id: '2', parentId: '1', type: 'model_change', timestamp: 't2' },
			{ id: '3', parentId: '2', type: 'message', timestamp: 't3' },
		]);
		const tree = createSessionTree(sm);
		const path = tree.pathBetween('1', '3');
		expect(path).toHaveLength(3);
		expect(path[0].id).toBe('1');
		expect(path[2].id).toBe('3');
	});
});

describe('distance', () => {
	it('returns steps between two nodes', () => {
		const sm = mockSessionManager([
			{ id: '1', parentId: null, type: 'message', timestamp: 't1' },
			{ id: '2', parentId: '1', type: 'message', timestamp: 't2' },
			{ id: '3', parentId: '2', type: 'message', timestamp: 't3' },
		]);
		const tree = createSessionTree(sm);
		expect(tree.distance('1', '3')).toBe(2);
	});
});

describe('LCA', () => {
	it('finds lowest common ancestor in branched tree', () => {
		const sm = mockSessionManager([
			{ id: '1', parentId: null, type: 'message', timestamp: 't1' },
			{ id: '2a', parentId: '1', type: 'message', timestamp: 't2' },
			{ id: '2b', parentId: '1', type: 'message', timestamp: 't2' },
		]);
		const tree = createSessionTree(sm);
		const lca = tree.LCA('2a', '2b');
		expect(lca).toBeDefined();
		expect(lca!.id).toBe('1');
	});
});

describe('countByType', () => {
	it('counts entries of a given type on path', () => {
		const sm = mockSessionManager([
			{ id: '1', parentId: null, type: 'message', timestamp: 't1' },
			{ id: '2', parentId: '1', type: 'message', timestamp: 't2' },
			{ id: '3', parentId: '2', type: 'compaction', timestamp: 't3' },
		]);
		const tree = createSessionTree(sm);
		const path = tree.pathToLeaf();
		expect(tree.countByType(path, 'message')).toBe(2);
		expect(tree.countByType(path, 'compaction')).toBe(1);
	});
});

describe('compactionHistory', () => {
	it('extracts compaction entries from path', () => {
		const sm = mockSessionManager([
			{ id: '1', parentId: null, type: 'message', timestamp: 't1' },
			{
				id: '2',
				parentId: '1',
				type: 'compaction',
				timestamp: 't2',
				details: { tokensBefore: 100000 },
			},
		]);
		const tree = createSessionTree(sm);
		const path = tree.pathToLeaf();
		const history = tree.compactionHistory(path);
		expect(history).toHaveLength(1);
		expect(history[0].timestamp).toBe('t2');
	});
});

describe('entryTypeTimeline', () => {
	it('segments path by entry type', () => {
		const sm = mockSessionManager([
			{ id: '1', parentId: null, type: 'message', timestamp: 't1' },
			{ id: '2', parentId: '1', type: 'message', timestamp: 't2' },
			{ id: '3', parentId: '2', type: 'model_change', timestamp: 't3' },
			{ id: '4', parentId: '3', type: 'message', timestamp: 't4' },
		]);
		const tree = createSessionTree(sm);
		const timeline = tree.entryTypeTimeline(tree.pathToLeaf());
		expect(timeline).toHaveLength(3);
		expect(timeline[0].type).toBe('message');
		expect(timeline[0].count).toBe(2);
		expect(timeline[1].type).toBe('model_change');
		expect(timeline[1].count).toBe(1);
		expect(timeline[2].type).toBe('message');
		expect(timeline[2].count).toBe(1);
	});
});

describe('treeComplexity', () => {
	it('returns 0 for single node', () => {
		const sm = mockSessionManager([
			{ id: '1', parentId: null, type: 'message', timestamp: 't1' },
		]);
		const tree = createSessionTree(sm);
		expect(tree.treeComplexity()).toBe(0);
	});

	it('returns higher score for branched deep tree', () => {
		const sm = mockSessionManager([
			{ id: '1', parentId: null, type: 'message', timestamp: 't1' },
			{ id: '2a', parentId: '1', type: 'message', timestamp: 't2' },
			{ id: '3a', parentId: '2a', type: 'message', timestamp: 't3' },
			{ id: '2b', parentId: '1', type: 'message', timestamp: 't2' },
		]);
		const tree = createSessionTree(sm);
		expect(tree.treeComplexity()).toBeGreaterThan(0);
	});
});

// ── E. Content ──────────────────────────────────────────────

describe('extractUserMessages', () => {
	it('extracts user message texts from path', () => {
		const sm = mockSessionManager([
			{
				id: '1',
				parentId: null,
				type: 'message',
				timestamp: 't1',
				message: { role: 'user', content: 'hello world' },
			},
			{
				id: '2',
				parentId: '1',
				type: 'message',
				timestamp: 't2',
				message: { role: 'assistant', content: 'hi there' },
			},
			{
				id: '3',
				parentId: '2',
				type: 'message',
				timestamp: 't3',
				message: { role: 'user', content: 'fix bug' },
			},
		]);
		const tree = createSessionTree(sm);
		const msgs = tree.extractUserMessages(tree.pathToLeaf());
		expect(msgs).toHaveLength(2);
		expect(msgs[0]).toBe('hello world');
		expect(msgs[1]).toBe('fix bug');
	});

	it('handles array content', () => {
		const sm = mockSessionManager([
			{
				id: '1',
				parentId: null,
				type: 'message',
				timestamp: 't1',
				message: {
					role: 'user',
					content: [
						{ type: 'text', text: 'part one' },
						{ type: 'text', text: 'part two' },
					],
				},
			},
		]);
		const tree = createSessionTree(sm);
		const msgs = tree.extractUserMessages(tree.pathToLeaf());
		expect(msgs).toHaveLength(1);
		expect(msgs[0]).toBe('part one part two');
	});
});

describe('detectKeywords', () => {
	it('finds entries containing keywords', () => {
		const sm = mockSessionManager([
			{
				id: '1',
				parentId: null,
				type: 'message',
				timestamp: 't1',
				message: { role: 'user', content: 'please commit the changes' },
			},
			{
				id: '2',
				parentId: '1',
				type: 'message',
				timestamp: 't2',
				message: { role: 'user', content: 'fix the typo' },
			},
		]);
		const tree = createSessionTree(sm);
		const found = tree.detectKeywords(tree.pathToLeaf(), ['commit', '提交']);
		expect(found).toHaveLength(1);
		expect(found[0].id).toBe('1');
	});

	it('case-insensitive matching', () => {
		const sm = mockSessionManager([
			{
				id: '1',
				parentId: null,
				type: 'message',
				timestamp: 't1',
				message: { role: 'user', content: 'COMMIT NOW' },
			},
		]);
		const tree = createSessionTree(sm);
		expect(tree.detectKeywords(tree.pathToLeaf(), ['commit'])).toHaveLength(1);
	});
});

describe('extractLabels', () => {
	it('returns all labels with target ids', () => {
		const sm = mockSessionManager([
			{ id: '1', parentId: null, type: 'message', timestamp: 't1', label: 'checkpoint-1' },
			{ id: '2', parentId: '1', type: 'message', timestamp: 't2' },
			{ id: '3', parentId: '2', type: 'message', timestamp: 't3', label: 'done' },
		]);
		const tree = createSessionTree(sm);
		const labels = tree.extractLabels();
		expect(labels).toHaveLength(2);
		expect(labels[0].label).toBe('checkpoint-1');
		expect(labels[1].label).toBe('done');
	});
});

// ── F. Window ───────────────────────────────────────────────

describe('lastN', () => {
	it('returns last N entries on path', () => {
		const sm = mockSessionManager([
			{ id: '1', parentId: null, type: 'message', timestamp: 't1' },
			{ id: '2', parentId: '1', type: 'message', timestamp: 't2' },
			{ id: '3', parentId: '2', type: 'message', timestamp: 't3' },
		]);
		const tree = createSessionTree(sm);
		const last = tree.lastN(2);
		expect(last).toHaveLength(2);
		expect(last[0].id).toBe('2');
		expect(last[1].id).toBe('3');
	});
});

describe('entriesSinceLastCompaction', () => {
	it('returns entries since last compaction', () => {
		const sm = mockSessionManager([
			{ id: '1', parentId: null, type: 'message', timestamp: 't1' },
			{ id: '2', parentId: '1', type: 'compaction', timestamp: 't2' },
			{ id: '3', parentId: '2', type: 'message', timestamp: 't3' },
			{ id: '4', parentId: '3', type: 'message', timestamp: 't4' },
		]);
		const tree = createSessionTree(sm);
		const recent = tree.entriesSinceLastCompaction();
		expect(recent.length).toBeGreaterThanOrEqual(2);
		expect(recent.some((n) => n.type === 'compaction')).toBe(true);
	});

	it('returns full path when no compaction', () => {
		const sm = mockSessionManager([
			{ id: '1', parentId: null, type: 'message', timestamp: 't1' },
		]);
		const tree = createSessionTree(sm);
		const recent = tree.entriesSinceLastCompaction();
		expect(recent).toHaveLength(1);
	});
});

// ── H. Snapshot ─────────────────────────────────────────────

describe('snapshot', () => {
	it('captures current tree state', () => {
		const sm = mockSessionManager([
			{ id: '1', parentId: null, type: 'message', timestamp: 't1' },
		]);
		const tree = createSessionTree(sm);
		const snap = tree.snapshot();
		expect(snap.entryCount).toBe(1);
		expect(snap.leafId).toBe('1');
		expect(snap.timestamp).toBeDefined();
	});
});

describe('diff', () => {
	it('detects added entries', () => {
		const sm = mockSessionManager([
			{ id: '1', parentId: null, type: 'message', timestamp: 't1' },
		]);
		const tree = createSessionTree(sm);
		const prev = { leafId: null, entryCount: 0, timestamp: 't0' };
		const d = tree.diff(prev);
		expect(d.added).toBe(1);
		expect(d.removed).toBe(0);
	});
});

// ── Retry detection ─────────────────────────────────────────

describe('detectRetry', () => {
	it('detects identical messages as retry', async () => {
		const msg = 'please fix the bug in payment service';
		const sm = mockSessionManager([
			{
				id: '1',
				parentId: null,
				type: 'message',
				timestamp: 't1',
				message: { role: 'user', content: msg },
			},
			{
				id: '2',
				parentId: '1',
				type: 'message',
				timestamp: 't2',
				message: { role: 'user', content: msg },
			},
		]);
		const tree = createSessionTree(sm);
		const result = await tree.detectRetry('1', '2');
		expect(result.isRetry).toBe(true);
		expect(result.confidence).toBeGreaterThan(0.7);
		expect(result.method).toBe('bm25');
	});

	it('detects very similar messages as retry', async () => {
		const sm = mockSessionManager([
			{
				id: '1',
				parentId: null,
				type: 'message',
				timestamp: 't1',
				message: { role: 'user', content: 'fix the payment service bug' },
			},
			{
				id: '2',
				parentId: '1',
				type: 'message',
				timestamp: 't2',
				message: { role: 'user', content: 'please fix bug in payment service' },
			},
		]);
		const tree = createSessionTree(sm);
		const result = await tree.detectRetry('1', '2');
		expect(result.isRetry).toBe(true);
		expect(result.method).toBe('bm25');
	});

	it('detects completely different messages as not retry', async () => {
		const sm = mockSessionManager([
			{
				id: '1',
				parentId: null,
				type: 'message',
				timestamp: 't1',
				message: { role: 'user', content: 'fix the payment service bug' },
			},
			{
				id: '2',
				parentId: '1',
				type: 'message',
				timestamp: 't2',
				message: { role: 'user', content: 'add new feature for user authentication' },
			},
		]);
		const tree = createSessionTree(sm);
		const result = await tree.detectRetry('1', '2');
		expect(result.isRetry).toBe(false);
		expect(result.method).toBe('bm25');
	});

	it('returns not retry for non-message entries', async () => {
		const sm = mockSessionManager([
			{ id: '1', parentId: null, type: 'message', timestamp: 't1' },
			{ id: '2', parentId: '1', type: 'model_change', timestamp: 't2' },
		]);
		const tree = createSessionTree(sm);
		const result = await tree.detectRetry('1', '2');
		expect(result.isRetry).toBe(false);
	});
});
