/**
 * @zenone/pi-session-tree — Vitest tests
 *
 * Covers:
 *   - createSessionTree factory
 *   - TreeNode type wrapping
 *   - A. Node queries: findByType, findByLabel, findAncestor
 *   - B. Path queries: pathToLeaf, pathBetween, distance, LCA, entriesBetween
 *   - C. Structure: branchCount, maxDepth, pathLength, treeComplexity
 *   - D. analyze (range analysis)
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
	message?: {
		role: string;
		content: string | Array<{ type: string; text: string }>;
		toolName?: string;
	};
	details?: any;
	tokensBefore?: number;
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
		tokensBefore: e.tokensBefore,
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

describe('analyze', () => {
	it('counts entry types correctly', () => {
		const sm = mockSessionManager([
			{ id: '1', parentId: null, type: 'message', timestamp: 't1' },
			{ id: '2', parentId: '1', type: 'message', timestamp: 't2' },
			{ id: '3', parentId: '2', type: 'compaction', timestamp: 't3' },
		]);
		const tree = createSessionTree(sm);
		const report = tree.analyze('1', '3');
		expect(report.byType['message']).toBe(2);
		expect(report.byType['compaction']).toBe(1);
	});

	it('extracts compaction history', () => {
		const sm = mockSessionManager([
			{ id: '1', parentId: null, type: 'message', timestamp: 't1' },
			{
				id: '2',
				parentId: '1',
				type: 'compaction',
				timestamp: 't2',
				tokensBefore: 100000,
			},
		]);
		const tree = createSessionTree(sm);
		const report = tree.analyze('1', '2');
		expect(report.compactions).toHaveLength(1);
		expect(report.compactions[0].tokensBefore).toBe(100000);
	});

	it('extracts user questions', () => {
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
				message: { role: 'user', content: 'fix bug' },
			},
		]);
		const tree = createSessionTree(sm);
		const report = tree.analyze('1', '2');
		expect(report.userQuestions).toHaveLength(2);
		expect(report.userQuestions[0]).toBe('hello world');
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

describe('analyzeComplexity', () => {
	it('returns low with zeroed dimensions for empty session', () => {
		const sm = mockSessionManager([]);
		const tree = createSessionTree(sm);
		expect(tree.analyzeComplexity()).toEqual({
			level: 'low',
			dimensions: {
				branchPoints: 0,
				maxDepth: 0,
				compactionCount: 0,
				toolTypeCount: 0,
				userQuestionCount: 0,
				turnsPerQuestion: 0,
			},
		});
	});

	it('computes all 6 dimensions and aggregate level from a known tree', () => {
		const sm = mockSessionManager([
			{
				id: '1',
				parentId: null,
				type: 'message',
				timestamp: 't1',
				message: { role: 'user', content: 'q1' },
			},
			{
				id: '2',
				parentId: '1',
				type: 'message',
				timestamp: 't2',
				message: { role: 'assistant', content: 'a1' },
			},
			{
				id: '3',
				parentId: '2',
				type: 'message',
				timestamp: 't3',
				message: { role: 'toolResult', content: '', toolName: 'bash' },
			},
			{
				id: '4',
				parentId: '2',
				type: 'message',
				timestamp: 't4',
				message: { role: 'user', content: 'q2' },
			},
			{
				id: '5',
				parentId: '4',
				type: 'message',
				timestamp: 't5',
				message: { role: 'assistant', content: 'a2' },
			},
		]);
		const tree = createSessionTree(sm);
		const r = tree.analyzeComplexity();
		expect(r.dimensions).toEqual({
			branchPoints: 1,
			maxDepth: 3,
			compactionCount: 0,
			toolTypeCount: 1,
			userQuestionCount: 2,
			turnsPerQuestion: 1,
		});
		// branchPoints=1 恰好是 medium 下界，是唯一非 low 维 → 综合 medium
		expect(r.level).toBe('medium');
	});

	it('branchPoints >= 3 dominates to high', () => {
		// 3 个分支点：r(2 孩子) + b1(2 孩子) + c1(2 孩子)
		const sm = mockSessionManager([
			{
				id: 'r',
				parentId: null,
				type: 'message',
				timestamp: 't0',
				message: { role: 'user', content: 'q' },
			},
			{
				id: 'b1',
				parentId: 'r',
				type: 'message',
				timestamp: 't1',
				message: { role: 'assistant', content: 'a' },
			},
			{
				id: 'b2',
				parentId: 'r',
				type: 'message',
				timestamp: 't1',
				message: { role: 'assistant', content: 'a' },
			},
			{
				id: 'c1',
				parentId: 'b1',
				type: 'message',
				timestamp: 't2',
				message: { role: 'assistant', content: 'a' },
			},
			{
				id: 'c2',
				parentId: 'b1',
				type: 'message',
				timestamp: 't2',
				message: { role: 'assistant', content: 'a' },
			},
			{
				id: 'd1',
				parentId: 'c1',
				type: 'message',
				timestamp: 't3',
				message: { role: 'assistant', content: 'a' },
			},
			{
				id: 'd2',
				parentId: 'c1',
				type: 'message',
				timestamp: 't3',
				message: { role: 'assistant', content: 'a' },
			},
		]);
		const tree = createSessionTree(sm);
		const r = tree.analyzeComplexity();
		expect(r.dimensions.branchPoints).toBe(3);
		expect(r.level).toBe('high');
	});

	it('compactionCount >= 2 dominates to high', () => {
		const sm = mockSessionManager([
			{
				id: '1',
				parentId: null,
				type: 'message',
				timestamp: 't1',
				message: { role: 'user', content: 'q' },
			},
			{ id: '2', parentId: '1', type: 'compaction', timestamp: 't2' },
			{ id: '3', parentId: '2', type: 'compaction', timestamp: 't3' },
		]);
		const tree = createSessionTree(sm);
		const r = tree.analyzeComplexity();
		expect(r.dimensions.compactionCount).toBe(2);
		expect(r.level).toBe('high');
	});

	it('maxDepth >= 30 dominates to high', () => {
		const entries: MockEntry[] = [];
		for (let i = 0; i <= 30; i++) {
			entries.push({
				id: `n${i}`,
				parentId: i === 0 ? null : `n${i - 1}`,
				type: 'message',
				timestamp: `t${i}`,
				message: { role: i % 2 === 0 ? 'user' : 'assistant', content: 'x' },
			});
		}
		const tree = createSessionTree(mockSessionManager(entries));
		const r = tree.analyzeComplexity();
		expect(r.dimensions.maxDepth).toBe(30);
		expect(r.level).toBe('high');
	});

	it('turnsPerQuestion >= 5 dominates to high', () => {
		const entries: MockEntry[] = [
			{
				id: 'u',
				parentId: null,
				type: 'message',
				timestamp: 't0',
				message: { role: 'user', content: 'q' },
			},
		];
		for (let i = 1; i <= 5; i++) {
			entries.push({
				id: `a${i}`,
				parentId: i === 1 ? 'u' : `a${i - 1}`,
				type: 'message',
				timestamp: `t${i}`,
				message: { role: 'assistant', content: 'a' },
			});
		}
		const tree = createSessionTree(mockSessionManager(entries));
		const r = tree.analyzeComplexity();
		expect(r.dimensions.turnsPerQuestion).toBe(5);
		expect(r.level).toBe('high');
	});

	it('toolTypeCount dedupes tool names and maps 3 distinct tools to medium', () => {
		const sm = mockSessionManager([
			{
				id: 'u',
				parentId: null,
				type: 'message',
				timestamp: 't0',
				message: { role: 'user', content: 'q' },
			},
			{
				id: 'a',
				parentId: 'u',
				type: 'message',
				timestamp: 't1',
				message: { role: 'assistant', content: 'a' },
			},
			{
				id: 't1',
				parentId: 'a',
				type: 'message',
				timestamp: 't2',
				message: { role: 'toolResult', content: '', toolName: 'bash' },
			},
			{
				id: 't2',
				parentId: 't1',
				type: 'message',
				timestamp: 't3',
				message: { role: 'toolResult', content: '', toolName: 'read' },
			},
			{
				id: 't3',
				parentId: 't2',
				type: 'message',
				timestamp: 't4',
				message: { role: 'toolResult', content: '', toolName: 'write' },
			},
		]);
		const tree = createSessionTree(sm);
		const r = tree.analyzeComplexity();
		expect(r.dimensions.toolTypeCount).toBe(3);
		expect(r.level).toBe('medium');
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
