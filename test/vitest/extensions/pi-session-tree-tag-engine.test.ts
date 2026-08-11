/**
 * Tag engine unit tests — pure logic, no TUI
 */
import { describe, it, expect } from 'vitest';
import {
	ruleMatches,
	applyRules,
	computeScanWindow,
	type TagScanState,
	previewRule,
	parseFormula,
	formatRule,
	type TagRule,
	type MatchableEntry,
	entryMatchesField,
	applyFieldRules,
	previewFieldMatches,
	formatFieldRule,
	matchesRule,
	type FieldTagRule,
	TYPE_OPTIONS,
} from '../../../extensions/meta/pi-session-tree/tag-engine.js';

function entry(
	overrides: Partial<MatchableEntry> & { id: string },
): { id: string } & MatchableEntry {
	return {
		type: 'message',
		message: { role: 'user', content: '' },
		...overrides,
	} as { id: string } & MatchableEntry;
}

const genId = () => `id_${Math.random().toString(36).slice(2, 8)}`;

const compaction: MatchableEntry = { id: genId(), type: 'compaction', tokensBefore: 50000 };
const toolBash: MatchableEntry = {
	id: genId(),
	type: 'message',
	message: { role: 'toolResult', toolName: 'bash', content: 'ls output' },
	toolName: 'bash',
};
const toolEdit: MatchableEntry = {
	id: genId(),
	type: 'message',
	message: { role: 'toolResult', toolName: 'edit', content: '+ line' },
	toolName: 'edit',
};
const userMsg: MatchableEntry = {
	id: genId(),
	type: 'message',
	message: { role: 'user', content: 'hello' },
};
const assistantMsg: MatchableEntry = {
	id: genId(),
	type: 'message',
	message: { role: 'assistant', content: 'hi there' },
};
const modelChange: MatchableEntry = { id: genId(), type: 'model_change', modelId: 'gpt-4' };

describe('ruleMatches', () => {
	it('matches compaction rule', () => {
		const rule: TagRule = { on: 'compaction', label: '压缩', source: 'config' };
		expect(ruleMatches(rule, compaction)).toBe(true);
		expect(ruleMatches(rule, userMsg)).toBe(false);
	});

	it('matches tool_call rule', () => {
		const rule: TagRule = { on: 'tool_call', label: '工具', source: 'config' };
		expect(ruleMatches(rule, toolBash)).toBe(true);
		expect(ruleMatches(rule, userMsg)).toBe(false);
	});

	it('matches tool_call with toolName filter', () => {
		const rule: TagRule = {
			on: 'tool_call',
			match: { toolName: 'edit' },
			label: '修改',
			source: 'config',
		};
		expect(ruleMatches(rule, toolEdit)).toBe(true);
		expect(ruleMatches(rule, toolBash)).toBe(false);
	});

	it('matches user_message rule', () => {
		const rule: TagRule = { on: 'user_message', label: '提问', source: 'config' };
		expect(ruleMatches(rule, userMsg)).toBe(true);
		expect(ruleMatches(rule, assistantMsg)).toBe(false);
	});

	it('matches assistant_message rule', () => {
		const rule: TagRule = { on: 'assistant_message', label: '回复', source: 'config' };
		expect(ruleMatches(rule, assistantMsg)).toBe(true);
		expect(ruleMatches(rule, userMsg)).toBe(false);
	});

	it('matches model_change rule', () => {
		const rule: TagRule = { on: 'model_change', label: '切换', source: 'config' };
		expect(ruleMatches(rule, modelChange)).toBe(true);
		expect(ruleMatches(rule, compaction)).toBe(false);
	});
});

describe('applyRules', () => {
	it('applies multiple rules to entries', () => {
		const entries = [
			entry({ id: 'e1', type: 'compaction' }),
			entry({ id: 'e2', type: 'message', message: { role: 'user', content: 'q' } }),
			entry({
				id: 'e3',
				type: 'message',
				message: { role: 'toolResult', toolName: 'edit', content: 'x' },
			}),
		];
		const rules: TagRule[] = [
			{ on: 'compaction', label: '压缩', source: 'config' },
			{ on: 'tool_call', label: '工具', source: 'config' },
			{ on: 'tool_call', match: { toolName: 'edit' }, label: '修改', source: 'config' },
			{ on: 'user_message', label: '提问', source: 'config' },
		];
		const result = applyRules(entries, rules);
		expect(result.get('e1')).toEqual(['压缩']);
		expect(result.get('e2')).toEqual(['提问']);
		expect(result.get('e3')).toEqual(['工具', '修改']);
	});
});

describe('previewRule', () => {
	it('returns matching entries', () => {
		const entries = [
			entry({ id: 'e1', type: 'compaction' }),
			entry({ id: 'e2', type: 'message', message: { role: 'user', content: 'q' } }),
		];
		const rule: TagRule = { on: 'compaction', label: '压缩', source: 'session' };
		const result = previewRule(entries, rule);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe('e1');
	});
});

describe('parseFormula', () => {
	it('parses simple formula', () => {
		const r = parseFormula('compaction → 压缩');
		expect(r).not.toBeNull();
		expect(r!.on).toBe('compaction');
		expect(r!.label).toBe('压缩');
		expect(r!.source).toBe('session');
	});

	it('parses formula with -> arrow', () => {
		const r = parseFormula('tool_call toolName=edit -> 修改');
		expect(r).not.toBeNull();
		expect(r!.on).toBe('tool_call');
		expect(r!.match).toEqual({ toolName: 'edit' });
		expect(r!.label).toBe('修改');
	});

	it('returns null for invalid on type', () => {
		expect(parseFormula('invalid_type → nope')).toBeNull();
	});

	it('returns null for missing arrow', () => {
		expect(parseFormula('compaction 压缩')).toBeNull();
	});
});

describe('formatRule', () => {
	it('formats simple rule', () => {
		expect(formatRule({ on: 'compaction', label: '压缩', source: 'config' })).toBe(
			'compaction → 压缩',
		);
	});

	it('formats rule with match', () => {
		expect(
			formatRule({
				on: 'tool_call',
				match: { toolName: 'edit' },
				label: '修改',
				source: 'session',
			}),
		).toBe('tool_call toolName=edit → 修改');
	});
});

// ── Multi-field (FieldTagRule) tests ───────────────────────────

const withId = <T extends Record<string, unknown>>(obj: T): T & { id: string } => ({
	id: `id_${Math.random().toString(36).slice(2, 8)}`,
	...obj,
});

describe('entryMatchesField', () => {
	const entry = withId({
		type: 'message',
		message: { role: 'user', content: 'timeout error in API call' },
	} as any);

	it('matches all types when typeIndex=0', () => {
		expect(
			entryMatchesField({ typeIndex: 0, matchText: '', label: '', source: 'session' }, entry),
		).toBe(true);
	});

	it('matches specific type correctly', () => {
		// "error" type (index 6) should NOT match a "message" type entry
		expect(
			entryMatchesField({ typeIndex: 6, matchText: '', label: '', source: 'session' }, entry),
		).toBe(false);
		// Message is not in TYPE_OPTIONS — let's use index 0 (all)
	});

	it('filters by keyword on entry full text', () => {
		expect(
			entryMatchesField(
				{ typeIndex: 0, matchText: 'timeout', label: '', source: 'session' },
				entry,
			),
		).toBe(true);
		expect(
			entryMatchesField(
				{ typeIndex: 0, matchText: 'nonexistent', label: '', source: 'session' },
				entry,
			),
		).toBe(false);
	});

	it('returns false for invalid regex', () => {
		expect(
			entryMatchesField(
				{ typeIndex: 0, matchText: '[[[', label: '', source: 'session' },
				entry,
			),
		).toBe(false);
	});

	it('intersects type + keyword', () => {
		const compaction = withId({ type: 'compaction', tokensBefore: 50000 } as any);
		// compaction type (index 1), matching "50000" in text
		expect(
			entryMatchesField(
				{ typeIndex: 1, matchText: '50', label: '', source: 'session' },
				compaction,
			),
		).toBe(true);
		// But keyword "timeout" on compaction
		expect(
			entryMatchesField(
				{ typeIndex: 1, matchText: 'timeout', label: '', source: 'session' },
				compaction,
			),
		).toBe(false);
	});
});

describe('applyFieldRules', () => {
	const entries = [
		withId({ type: 'compaction', tokensBefore: 30000 } as any),
		withId({
			type: 'tool_call',
			toolName: 'edit',
			message: { role: 'tool', content: 'edit file' },
		} as any),
		withId({
			type: 'message',
			message: { role: 'user', content: 'please fix the timeout bug' },
		} as any),
	];

	it('applies multiple rules and returns entry→labels map', () => {
		const rules = [
			{ typeIndex: 1, matchText: '', label: '压缩', source: 'session' as const },
			{ typeIndex: 0, matchText: 'timeout', label: '超时', source: 'session' as const },
		];
		const result = applyFieldRules(entries, rules);
		// Entry 0 (compaction) gets '压缩'
		expect(result.get(entries[0].id)).toEqual(['压缩']);
		// Entry 2 (user message with timeout) gets '超时'
		expect(result.get(entries[2].id)).toEqual(['超时']);
		// Entry 1 (tool_call) gets nothing
		expect(result.has(entries[1].id)).toBe(false);
	});

	it('returns empty map for no rules', () => {
		expect(applyFieldRules(entries, []).size).toBe(0);
	});

	it('multiple rules can match same entry', () => {
		const rules = [
			{ typeIndex: 0, matchText: 'timeout', label: '超时', source: 'session' as const },
			{ typeIndex: 0, matchText: 'bug', label: '缺陷', source: 'session' as const },
		];
		const result = applyFieldRules(entries, rules);
		expect(result.get(entries[2].id)).toEqual(['超时', '缺陷']);
	});
});

describe('matchesRule — config rules keep match semantics (regression)', () => {
	const toolEdit = withId({
		type: 'message',
		message: { role: 'toolResult', toolName: 'edit', content: 'file updated' },
	} as any);
	const toolBash = withId({
		type: 'message',
		message: { role: 'toolResult', toolName: 'bash', content: 'ls done' },
	} as any);

	it('config rule with match{toolName} matches only the right tool', () => {
		const configRule: TagRule = {
			on: 'tool_call',
			match: { toolName: 'edit' },
			label: '修改',
			source: 'config',
		};
		// 面板转换：config 规则 → FieldTagRule（保留 tagRule 原型）
		const field: FieldTagRule = {
			typeIndex: TYPE_OPTIONS.indexOf('tool_call' as any),
			matchText: '',
			label: '修改',
			source: 'config',
			tagRule: configRule,
		};
		expect(matchesRule(field, toolEdit)).toBe(true);
		expect(matchesRule(field, toolBash)).toBe(false);
	});

	it('session rule uses substring matching regardless of tagRule', () => {
		const field: FieldTagRule = {
			typeIndex: 0,
			matchText: 'updated',
			label: '修改',
			source: 'session',
		};
		expect(matchesRule(field, toolEdit)).toBe(true);
		expect(matchesRule(field, toolBash)).toBe(false);
	});

	it('config rule without tagRule falls back to FieldTagRule substring (compat)', () => {
		const field: FieldTagRule = {
			typeIndex: 0,
			matchText: 'updated',
			label: '修改',
			source: 'config',
		};
		expect(matchesRule(field, toolEdit)).toBe(true);
	});

	it('contentPattern keeps regex semantics (legacy config rules)', () => {
		const configRule: TagRule = {
			on: 'tool_call',
			match: { contentPattern: 'error|fail' },
			label: '报错',
			source: 'config',
		};
		const field: FieldTagRule = {
			typeIndex: TYPE_OPTIONS.indexOf('tool_call' as any),
			matchText: '',
			label: '报错',
			source: 'config',
			tagRule: configRule,
		};
		const errEntry = entry({
			id: genId(),
			message: { role: 'toolResult', toolName: 'bash', content: 'build failed with error' },
		});
		const okEntry = entry({
			id: genId(),
			message: { role: 'toolResult', toolName: 'bash', content: 'all good' },
		});
		// 正则 alternation 匹配 error 或 fail
		expect(matchesRule(field, errEntry)).toBe(true);
		expect(matchesRule(field, okEntry)).toBe(false);
		// ruleMatches 直连同样保持正则语义
		expect(ruleMatches(configRule, errEntry)).toBe(true);
		expect(ruleMatches(configRule, okEntry)).toBe(false);
	});

	it('contentPattern matches multi-block array content', () => {
		const configRule: TagRule = {
			on: 'assistant_message',
			match: { contentPattern: '^分析' },
			label: '分析',
			source: 'config',
		};
		const blockEntry = entry({
			id: genId(),
			message: {
				role: 'assistant',
				content: [{ type: 'text', text: '分析结果如下' }],
			} as any,
		});
		expect(ruleMatches(configRule, blockEntry)).toBe(true);
	});
});

describe('previewFieldMatches', () => {
	const entries = [
		withId({ type: 'compaction', tokensBefore: 50000 } as any),
		withId({ type: 'compaction', tokensBefore: 30000 } as any),
		withId({ type: 'compaction', tokensBefore: 10000 } as any),
		withId({
			type: 'tool_call',
			toolName: 'bash',
			message: { role: 'tool', content: 'ls -la' },
		} as any),
	];

	it('previews matching entries up to limit', () => {
		const result = previewFieldMatches(entries, 1, ''); // typeIndex 1 = compaction
		expect(result.length).toBe(3); // all 3 compactions
	});

	it('respects limit', () => {
		const result = previewFieldMatches(entries, 1, '', 2);
		expect(result.length).toBe(2);
	});

	it('filters by keyword', () => {
		const result = previewFieldMatches(entries, 1, '50');
		expect(result.length).toBe(1);
	});
});

describe('formatFieldRule', () => {
	it('formats rule without match text', () => {
		expect(
			formatFieldRule({ typeIndex: 1, matchText: '', label: '压缩', source: 'session' }),
		).toBe('compaction → 压缩');
	});

	it('formats rule with match text', () => {
		expect(
			formatFieldRule({
				typeIndex: 0,
				matchText: 'timeout',
				label: '超时',
				source: 'session',
			}),
		).toBe('全部类型 /timeout/ → 超时');
	});
});

// ═══ Incremental scan window ═══════════════════════════════════════

describe('computeScanWindow', () => {
	const rules: TagRule[] = [{ on: 'user_message', label: '提问', source: 'config' }];
	const entries = [
		entry({ id: 'e1', type: 'message', message: { role: 'user', content: 'a' } }),
		entry({ id: 'e2', type: 'message', message: { role: 'user', content: 'b' } }),
		entry({ id: 'e3', type: 'message', message: { role: 'user', content: 'c' } }),
	];

	const freshState = (): TagScanState => ({ rulesKey: null, lastScannedEntryId: null });

	it('首次扫描：全量（rulesChanged=true，startIdx=0）', () => {
		const { startIdx, rulesChanged, nextState } = computeScanWindow(
			entries,
			rules,
			freshState(),
		);
		expect(rulesChanged).toBe(true);
		expect(startIdx).toBe(0);
		expect(nextState.rulesKey).toBe(JSON.stringify(rules));
	});

	it('规则不变：增量扫描自上次位置之后', () => {
		const state: TagScanState = { rulesKey: JSON.stringify(rules), lastScannedEntryId: 'e2' };
		const { startIdx, rulesChanged } = computeScanWindow(entries, rules, state);
		expect(rulesChanged).toBe(false);
		expect(startIdx).toBe(2); // e3 起
	});

	it('规则变化（含清空）：全量重扫', () => {
		// 规则变为空 → rulesKey 变化 → 全量
		const state: TagScanState = { rulesKey: JSON.stringify(rules), lastScannedEntryId: 'e3' };
		const { startIdx, rulesChanged } = computeScanWindow(entries, [], state);
		expect(rulesChanged).toBe(true);
		expect(startIdx).toBe(0);
	});

	it('上次扫描条目已不存在（新会话）：回退全量扫描', () => {
		const state: TagScanState = {
			rulesKey: JSON.stringify(rules),
			lastScannedEntryId: 'ghost',
		};
		const { startIdx, rulesChanged } = computeScanWindow(entries, rules, state);
		expect(rulesChanged).toBe(false);
		expect(startIdx).toBe(0); // findIndex=-1 → 全量
	});

	it('纯函数：不修改传入 state', () => {
		const state: TagScanState = { rulesKey: null, lastScannedEntryId: null };
		computeScanWindow(entries, rules, state);
		expect(state.rulesKey).toBeNull();
		expect(state.lastScannedEntryId).toBeNull();
	});
});
