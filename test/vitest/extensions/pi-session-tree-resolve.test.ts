/**
 * pi-session-tree resolve() — Vitest tests
 *
 * Covers: @, @^, @~N, @~N:type, @^^type, mN, id prefix, a..b range
 */
import { describe, it, expect } from 'vitest';
import { createSessionTree } from '../../../extensions/meta/pi-session-tree/index.js';

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
	_opts?: { marks?: Array<{ n: number; nodeId: string }> },
) {
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

	it('@~N skips no-text assistant (invisible in panel render)', () => {
		const entries: MockEntry[] = [
			{
				id: 'r000000001',
				parentId: null,
				type: 'message',
				timestamp: 't0',
				message: { role: 'user', content: 'root' },
			},
			{
				id: 'a000000001',
				parentId: 'r000000001',
				type: 'message',
				timestamp: 't1',
				message: { role: 'assistant', content: '' }, // 无文本 assistant，渲染时被跳过
			},
			{
				id: 't000000001',
				parentId: 'a000000001',
				type: 'message',
				timestamp: 't2',
				message: { role: 'toolResult', content: 'out' },
				toolName: 'bash',
			},
			{
				id: 'a000000002',
				parentId: 't000000001',
				type: 'message',
				timestamp: 't3',
				message: { role: 'assistant', content: 'final' },
			},
		];
		const tree = createSessionTree(mockSessionManager(entries));
		// leaf=a000000002, 父链: t1(toolResult) → a1(无文本 assistant) → root(user)
		expect(tree.resolve('@~1')).toHaveProperty('id', 't000000001');
		expect(tree.resolve('@~2')).toHaveProperty('id', 'r000000001'); // 跳过 a1
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

describe('resolve — mN marks (removed — mark is in-memory only)', () => {
	it('mN is no longer supported — resolves to null', () => {
		const tree = createSessionTree(mockSessionManager(standardTree()));
		expect(tree.resolve('m1')).toBeNull();
	});
});

describe('resolve — offset (+N / -N)', () => {
	it('standalone +1 from context', () => {
		const tree = createSessionTree(mockSessionManager(standardTree()));
		const result = tree.resolve('+1', { from: 't000000001' });
		expect(result).not.toBeNull();
		expect((result as any).id).toBe('c000000002');
	});

	it('standalone +2 from context', () => {
		const tree = createSessionTree(mockSessionManager(standardTree()));
		const result = tree.resolve('+2', { from: 't000000001' });
		expect(result).not.toBeNull();
		expect((result as any).id).toBe('cp00000001');
	});

	it('standalone -1 from context', () => {
		const tree = createSessionTree(mockSessionManager(standardTree()));
		const result = tree.resolve('-1', { from: 'c000000002' });
		expect(result).not.toBeNull();
		expect((result as any).id).toBe('t000000001');
	});

	it('standalone +N without from returns null', () => {
		const tree = createSessionTree(mockSessionManager(standardTree()));
		expect(tree.resolve('+3')).toBeNull();
	});

	it('standalone -N without from returns null', () => {
		const tree = createSessionTree(mockSessionManager(standardTree()));
		expect(tree.resolve('-1')).toBeNull();
	});

	it('out of bounds forward returns null', () => {
		const tree = createSessionTree(mockSessionManager(standardTree()));
		// leaf is the last node, +1 is out of bounds
		expect(tree.resolve('+1', { from: 'c000000003' })).toBeNull();
	});

	it('out of bounds backward returns null', () => {
		const tree = createSessionTree(mockSessionManager(standardTree()));
		// root is the first node, -1 is out of bounds
		expect(tree.resolve('-1', { from: 'r000000001' })).toBeNull();
	});

	it('combo @~2 +1 — from 2nd ancestor forward 1', () => {
		const tree = createSessionTree(mockSessionManager(standardTree()));
		// leaf=c3, @~2=c2(assistant), then +1=cp1(compaction)
		const result = tree.resolve('@~2 +1');
		expect(result).not.toBeNull();
		expect((result as any).id).toBe('cp00000001');
	});

	it('combo @~3 +3 — from 3rd ancestor forward 3', () => {
		const tree = createSessionTree(mockSessionManager(standardTree()));
		// leaf=c3, @~3=t1, +3: t1→c2→cp1→c3
		const result = tree.resolve('@~3 +3');
		expect(result).not.toBeNull();
		expect((result as any).id).toBe('c000000003');
	});

	it('combo @~1 -1 — from parent back 1', () => {
		const tree = createSessionTree(mockSessionManager(standardTree()));
		// leaf=c3, @~1=cp1, -1=c2
		const result = tree.resolve('@~1 -1');
		expect(result).not.toBeNull();
		expect((result as any).id).toBe('c000000002');
	});

	it('@ +1 — from leaf forward 1 (out of bounds)', () => {
		const tree = createSessionTree(mockSessionManager(standardTree()));
		expect(tree.resolve('@ +1')).toBeNull();
	});

	it('@ -1 — from leaf back 1 (=parent)', () => {
		const tree = createSessionTree(mockSessionManager(standardTree()));
		const result = tree.resolve('@ -1');
		expect(result).not.toBeNull();
		expect((result as any).id).toBe('cp00000001');
	});

	it('-N skips no-text assistant (aligned with @~N)', () => {
		const entries: MockEntry[] = [
			{
				id: 'r000000001',
				parentId: null,
				type: 'message',
				timestamp: 't0',
				message: { role: 'user', content: 'root' },
			},
			{
				id: 'a000000001',
				parentId: 'r000000001',
				type: 'message',
				timestamp: 't1',
				message: { role: 'assistant', content: '' }, // 无文本 assistant，渲染时被跳过
			},
			{
				id: 't000000001',
				parentId: 'a000000001',
				type: 'message',
				timestamp: 't2',
				message: { role: 'toolResult', content: 'out' },
				toolName: 'bash',
			},
			{
				id: 'a000000002',
				parentId: 't000000001',
				type: 'message',
				timestamp: 't3',
				message: { role: 'assistant', content: 'final' },
			},
		];
		const tree = createSessionTree(mockSessionManager(entries));
		// DFS 可见序（跳过无文本 assistant a1）: r1 → t1 → a2(leaf)
		expect(tree.resolve('-1', { from: 'a000000002' })).toHaveProperty('id', 't000000001');
		expect(tree.resolve('-2', { from: 'a000000002' })).toHaveProperty('id', 'r000000001'); // 跳过 a1
	});

	it('-1 from a no-text assistant leaf keeps the from anchor (regression: silent no-op)', () => {
		const entries: MockEntry[] = [
			{
				id: 'r000000001',
				parentId: null,
				type: 'message',
				timestamp: 't0',
				message: { role: 'user', content: 'root' },
			},
			{
				id: 't000000001',
				parentId: 'r000000001',
				type: 'message',
				timestamp: 't1',
				message: { role: 'toolResult', content: 'out' },
				toolName: 'bash',
			},
			{
				id: 'a000000001',
				parentId: 't000000001',
				type: 'message',
				timestamp: 't2',
				message: { role: 'assistant', content: '' }, // leaf = 无文本 assistant（渲染层对当前 leaf 有例外，仍显示）
			},
		];
		const tree = createSessionTree(mockSessionManager(entries));
		// leaf a1 是无文本 assistant；offsetNode 若把 from 也过滤掉会导致 findIndex=-1 → -1 静默返回 null（回归）。
		// 修复后 from 锚点始终保留，-1 应正确落到可见父节点 t1。
		expect(tree.resolve('-1', { from: 'a000000001' })).toHaveProperty('id', 't000000001');
	});
});

// ── Label flow integration tests ───────────────────────────────────

import {
	entryMatchesField,
	type FieldTagRule,
} from '../../../extensions/meta/pi-session-tree/tag-engine.js';

/** Mock session manager with label support (for label flow tests) */
function mockSessionManagerWithLabels(entries: MockEntry[]) {
	const base = mockSessionManager(entries);
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

describe('label flow — add → rescan → verify', () => {
	const entries: MockEntry[] = [
		{
			id: 'a1',
			parentId: null,
			type: 'message',
			timestamp: 't1',
			message: { role: 'user', content: '请帮我修复 timeout 问题' },
		},
		{
			id: 'a2',
			parentId: 'a1',
			type: 'message',
			timestamp: 't2',
			message: { role: 'assistant', content: '好的，我来分析' },
		},
		{
			id: 'a3',
			parentId: 'a2',
			type: 'compaction',
			timestamp: 't3',
			tokensBefore: 4000,
		},
		{
			id: 'a4',
			parentId: 'a3',
			type: 'message',
			timestamp: 't4',
			message: { role: 'user', content: '继续' },
		},
	];

	/** Create a tree with real setLabels wired to the mock session manager */
	function makeTree(sm: ReturnType<typeof mockSessionManagerWithLabels>) {
		const tree = createSessionTree(sm as any);
		// Override stub — replicate createSessionTreeWithPi logic
		(tree as any).setLabels = (entryId: string, labels: string[]) => {
			const existing = sm.getLabel(entryId) ?? '';
			const existingParts = existing
				.split(',')
				.map((s: string) => s.trim())
				.filter(Boolean);
			const nonTagParts = existingParts.filter((s: string) => !s.startsWith('#'));
			const newTagParts = labels.map((l: string) => (l.startsWith('#') ? l : `#${l}`));
			const merged = [...nonTagParts, ...newTagParts].join(',');
			if (merged !== existing) {
				if (merged) {
					sm.appendLabelChange(entryId, merged);
				} else {
					sm.appendLabelChange(entryId, undefined);
				}
			}
		};
		return tree;
	}

	it('adds one rule and labels match', () => {
		const sm = mockSessionManagerWithLabels(entries);
		const tree = makeTree(sm);
		const allEntries = tree.getAllEntries();

		const rule: FieldTagRule = {
			typeIndex: 0,
			matchText: 'timeout',
			label: '超时',
			source: 'session',
		};

		// Simulate rescanLabels
		for (const entry of allEntries) {
			const labels: string[] = [];
			for (const r of [rule]) {
				if (entryMatchesField(r, entry)) labels.push(r.label);
			}
			tree.setLabels(entry.id, labels);
		}

		// Verify: entry a1 contains 'timeout'
		expect(sm.getLabel('a1')).toBe('#超时');

		// Entry a2 (no timeout) should be empty
		expect(sm.getLabel('a2') ?? '').toBe('');
	});

	it('adds multiple rules with different labels', () => {
		const sm = mockSessionManagerWithLabels(entries);
		const tree = makeTree(sm);
		const allEntries = tree.getAllEntries();

		const rules: FieldTagRule[] = [
			{ typeIndex: 0, matchText: 'timeout', label: '超时', source: 'session' },
			{ typeIndex: 3, matchText: '', label: '用户发言', source: 'session' },
		];

		for (const entry of allEntries) {
			const labels: string[] = [];
			for (const r of rules) {
				if (entryMatchesField(r, entry)) labels.push(r.label);
			}
			tree.setLabels(entry.id, labels);
		}

		expect(sm.getLabel('a1')).toBe('#超时,#用户发言');
		expect(sm.getLabel('a4')).toBe('#用户发言');
		expect(sm.getLabel('a3') ?? '').toBe('');
	});

	it('removes a rule and clears affected labels', () => {
		const sm = mockSessionManagerWithLabels(entries);
		const tree = makeTree(sm);
		const allEntries = tree.getAllEntries();

		const rule: FieldTagRule = {
			typeIndex: 0,
			matchText: 'timeout',
			label: '超时',
			source: 'session',
		};

		for (const entry of allEntries) {
			const labels: string[] = [];
			if (entryMatchesField(rule, entry)) labels.push(rule.label);
			tree.setLabels(entry.id, labels);
		}

		expect(sm.getLabel('a1')).toBe('#超时');

		// Now remove the rule (re-scan with empty rules)
		for (const entry of allEntries) {
			tree.setLabels(entry.id, []);
		}

		expect(sm.getLabel('a1') ?? '').toBe('');
	});

	it('does NOT create label entries for entries that never had labels', () => {
		const sm = mockSessionManagerWithLabels(entries);
		const tree = makeTree(sm);
		const allEntries = tree.getAllEntries();
		let appendCalls = 0;
		const orig = sm.appendLabelChange as (id: string, l: string | undefined) => string;
		sm.appendLabelChange = (id: string, label: string | undefined) => {
			appendCalls++;
			return orig(id, label);
		};

		for (const entry of allEntries) {
			tree.setLabels(entry.id, []);
		}

		expect(appendCalls).toBe(0);
	});

	it('setLabels is idempotent: re-applying same labels does nothing', () => {
		const sm = mockSessionManagerWithLabels(entries);
		const tree = makeTree(sm);
		const allEntries = tree.getAllEntries();
		const rule: FieldTagRule = {
			typeIndex: 0,
			matchText: 'timeout',
			label: '超时',
			source: 'session',
		};

		// First pass
		for (const entry of allEntries) {
			const labels: string[] = [];
			if (entryMatchesField(rule, entry)) labels.push(rule.label);
			tree.setLabels(entry.id, labels);
		}
		expect(sm.getLabel('a1')).toBe('#超时');

		// Second pass — same labels, should be no-op
		let appendCalls = 0;
		const orig = sm.appendLabelChange as (id: string, l: string | undefined) => string;
		sm.appendLabelChange = (id: string, label: string | undefined) => {
			appendCalls++;
			return orig(id, label);
		};

		for (const entry of allEntries) {
			const labels: string[] = [];
			if (entryMatchesField(rule, entry)) labels.push(rule.label);
			tree.setLabels(entry.id, labels);
		}
		expect(appendCalls).toBe(0); // idempotent
		expect(sm.getLabel('a1')).toBe('#超时'); // unchanged
	});

	it('replaces rule: old label removed, new label added', () => {
		const sm = mockSessionManagerWithLabels(entries);
		const tree = makeTree(sm);
		const allEntries = tree.getAllEntries();

		// Rule 1: 'timeout' → '超时'
		for (const entry of allEntries) {
			const labels: string[] = [];
			if (
				entryMatchesField(
					{ typeIndex: 0, matchText: 'timeout', label: '超时', source: 'session' },
					entry,
				)
			)
				labels.push('超时');
			tree.setLabels(entry.id, labels);
		}
		expect(sm.getLabel('a1')).toBe('#超时');

		// Rule 2 (replaces): 'timeout' → '重试'
		for (const entry of allEntries) {
			const labels: string[] = [];
			if (
				entryMatchesField(
					{ typeIndex: 0, matchText: 'timeout', label: '重试', source: 'session' },
					entry,
				)
			)
				labels.push('重试');
			tree.setLabels(entry.id, labels);
		}
		expect(sm.getLabel('a1')).toBe('#重试');
		expect(sm.getLabel('a1')).not.toContain('#超时');
	});
});
