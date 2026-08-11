/**
 * 临时诊断：带 label 标签的树行在 91 列窄终端下是否超宽/wrap（P4 叠印机制定位）
 * 验证：truncateToWidth 后行宽 ≤ 面板宽度、行数稳定
 */
import { describe, it, expect, vi } from 'vitest';
import { TuiMainScreen } from '@earendil-works/pi-tui';
import { createPanel } from '../../../extensions/meta/pi-session-tree/ui/panel.js';
import { createSessionTree } from '../../../extensions/meta/pi-session-tree/index.js';
import { MockTerminal, renderToSnapshot, stripAnsi } from '../../../src/tui-testing/index.js';

vi.mock('@earendil-works/pi-coding-agent', () => ({
	copyToClipboard: () => {},
	rawKeyHint: (key: string, description: string) => `${key} ${description}`,
}));

function mockTheme(): any {
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

function mockKeybindings(): any {
	return { matches: () => false, getDefinition: () => undefined };
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

// 长内容节点（接近 91 列的真实场景）
const LONG_USER = '# 自动化测试审查指南  你是一名资深测试架构师，正在分析一个系统的自动化测试保障';
const LONG_BASH = 'total 1784 drwxr-xr-x@ 26 jojo staff 832 Aug 7 10:07 .';
const LONG_TOOL =
	'./tests/unit/test_llm_config.py ./tests/unit/test_fingerprint.py ./tests/unit/test_rag.py';

function buildEntries() {
	const entries: any[] = [
		{
			id: 'r0',
			parentId: null,
			type: 'message',
			timestamp: 't0',
			message: { role: 'system', content: 'Model: deepseek-v4-pro' },
		},
		{
			id: 'r1',
			parentId: 'r0',
			type: 'message',
			timestamp: 't1',
			message: { role: 'system', content: 'Thinking: high' },
		},
		{
			id: 'r2',
			parentId: 'r1',
			type: 'message',
			timestamp: 't2',
			message: { role: 'system', content: 'plannotator' },
		},
		{
			id: 'r3',
			parentId: 'r2',
			type: 'message',
			timestamp: 't3',
			message: { role: 'user', content: LONG_USER },
		},
		{
			id: 'r4',
			parentId: 'r3',
			type: 'message',
			timestamp: 't4',
			message: { role: 'assistant', content: 'Let me start by systematically analyzing' },
		},
		{
			id: 'r5',
			parentId: 'r4',
			type: 'message',
			timestamp: 't5',
			message: { role: 'assistant', content: '' },
			toolName: 'bash',
		},
		{
			id: 'r6',
			parentId: 'r5',
			type: 'message',
			timestamp: 't6',
			message: { role: 'toolResult', content: LONG_BASH },
		},
		{
			id: 'r7',
			parentId: 'r5',
			type: 'message',
			timestamp: 't7',
			message: { role: 'toolResult', content: LONG_TOOL },
		},
		{
			id: 'r8',
			parentId: 'r5',
			type: 'message',
			timestamp: 't8',
			message: {
				role: 'toolResult',
				content: '# See https://pre-commit.com for more information',
			},
		},
	];
	return entries;
}

describe('label 渲染诊断（91 列）', () => {
	function render(entries: any[], labels: Map<string, string>) {
		const term = new MockTerminal(91, 23);
		const tui = new TuiMainScreen(term);
		const sm = mockSmWithLabels(entries);
		if (labels.size > 0) for (const [id, v] of labels) sm.appendLabelChange(id, v);
		const tree = createSessionTree(sm);
		wireSetLabels(tree, sm);
		const component = createPanel(tui, mockTheme(), mockKeybindings(), () => {}, tree, 'sid');
		tui.addChild(component);
		return { tui, term, tree, sm };
	}

	it('无标签：行宽正常', () => {
		const { tui } = render(buildEntries(), new Map());
		const snap = renderToSnapshot(tui, 91, 23);
		const stripped = snap.map(stripAnsi);
		const over = stripped.filter((l) => l.length > 91);
		console.log('无标签行数:', stripped.length, '超宽:', over.length);
		expect(over.length).toBe(0);
	});

	it('带标签：行宽/行数（叠印机制验证）', () => {
		const labels = new Map<string, string>();
		for (const e of buildEntries()) labels.set(e.id, '#code-review');
		const { tui } = render(buildEntries(), labels);
		const snap = renderToSnapshot(tui, 91, 23);
		const stripped = snap.map(stripAnsi);
		const over = stripped.filter((l) => l.length > 91);
		console.log('带标签行数:', stripped.length, '超宽:', over.length);
		for (const l of over.slice(0, 5))
			console.log('  超宽行:', l.slice(0, 100), 'len=', l.length);
		const tagLines = stripped.filter((l) => l.includes('#code-review'));
		console.log('标签行数:', tagLines.length);
		expect(over.length).toBe(0);
	});
});
