/**
 * pi-session-tree analyze() — Vitest tests
 *
 * Covers: RangeReport, including byType, userQuestions, branchPoints,
 * compactions, toolCalls, labels, timeSpan
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
	summary?: string;
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
			? { role: e.message.role, content: e.message.content, toolName: e.toolName }
			: undefined,
		toolName: e.toolName,
		tokensBefore: e.tokensBefore,
		summary: e.summary,
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

function mockSessionManager(entries: MockEntry[]) {
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

function standardTree(): MockEntry[] {
	return [
		{
			id: 'r001',
			parentId: null,
			type: 'message',
			timestamp: '2025-01-01T00:00:00Z',
			message: { role: 'user', content: '帮我修复登录bug' },
		},
		{
			id: 'c001',
			parentId: 'r001',
			type: 'message',
			timestamp: '2025-01-01T00:01:00Z',
			message: { role: 'assistant', content: '好的' },
		},
		{
			id: 'g001',
			parentId: 'c001',
			type: 'message',
			timestamp: '2025-01-01T00:02:00Z',
			message: { role: 'user', content: '还需要改密码重置' },
		},
		{
			id: 't001',
			parentId: 'g001',
			type: 'message',
			timestamp: '2025-01-01T00:03:00Z',
			message: { role: 'toolResult', content: 'ok' },
			toolName: 'edit',
		},
		{
			id: 'c002',
			parentId: 't001',
			type: 'message',
			timestamp: '2025-01-01T00:04:00Z',
			message: { role: 'assistant', content: '改好了' },
		},
		{
			id: 'cp01',
			parentId: 'c002',
			type: 'compaction',
			timestamp: '2025-01-01T00:05:00Z',
			tokensBefore: 8000,
			summary: 'compressed context',
		},
		{
			id: 'c003',
			parentId: 'cp01',
			type: 'message',
			timestamp: '2025-01-01T00:06:00Z',
			message: { role: 'user', content: '继续加个功能' },
		},
	];
}

// ============================================================================
// Tests
// ============================================================================

describe('analyze — RangeReport', () => {
	it('returns correct segment count', () => {
		const tree = createSessionTree(mockSessionManager(standardTree()));
		const report = tree.analyze('r001', 'c003');
		expect(report.segmentCount).toBe(7);
	});

	it('byType counts all entry types', () => {
		const tree = createSessionTree(mockSessionManager(standardTree()));
		const report = tree.analyze('r001', 'c003');
		expect(report.byType['message']).toBe(6);
		expect(report.byType['compaction']).toBe(1);
	});

	it('extracts user questions', () => {
		const tree = createSessionTree(mockSessionManager(standardTree()));
		const report = tree.analyze('r001', 'c003');
		expect(report.userQuestions).toHaveLength(3);
		expect(report.userQuestions[0]).toBe('帮我修复登录bug');
	});

	it('extracts compactions with token count', () => {
		const tree = createSessionTree(mockSessionManager(standardTree()));
		const report = tree.analyze('c002', 'c003');
		expect(report.compactions).toHaveLength(1);
		expect(report.compactions[0].tokensBefore).toBe(8000);
	});

	it('counts tool calls', () => {
		const tree = createSessionTree(mockSessionManager(standardTree()));
		const report = tree.analyze('r001', 'c003');
		expect(report.toolCalls).toEqual({ edit: 1 });
	});

	it('counts agent messages', () => {
		const tree = createSessionTree(mockSessionManager(standardTree()));
		const report = tree.analyze('r001', 'c003');
		expect(report.agentMessages).toBe(2); // c001, c002
	});

	it('extracts labels from labeled nodes', () => {
		const entries = standardTree();
		entries.find((e) => e.id === 'c001')!.label = '#bugfix';
		entries.find((e) => e.id === 't001')!.label = '#edit';
		const tree = createSessionTree(mockSessionManager(entries));
		const report = tree.analyze('r001', 'c003');
		expect(report.labels).toHaveLength(2);
		expect(report.labels[0].label).toBe('#bugfix');
	});

	it('returns correct timeSpan', () => {
		const tree = createSessionTree(mockSessionManager(standardTree()));
		const report = tree.analyze('r001', 'c003');
		expect(report.timeSpan.start).toBe('2025-01-01T00:00:00Z');
		expect(report.timeSpan.end).toBe('2025-01-01T00:06:00Z');
	});

	it('range with single node returns segmentCount 1', () => {
		const tree = createSessionTree(mockSessionManager(standardTree()));
		const report = tree.analyze('r001', 'r001');
		expect(report.segmentCount).toBe(1);
	});
});
