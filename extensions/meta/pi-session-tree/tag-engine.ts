/**
 * Tag rule matching engine for pi-session-tree
 *
 * Pure logic — no Pi deps. TagRules specify which entries get which labels.
 * Applied to SessionEntry-like objects (any object with type + optional fields).
 */

export interface TagRule {
	/** Entry type to match */
	on:
		| 'compaction'
		| 'tool_call'
		| 'user_message'
		| 'assistant_message'
		| 'model_change'
		| 'error';
	/** Optional key-value match conditions */
	match?: Record<string, string>;
	/** Label to apply when matched */
	label: string;
	/**
	 * Source of the rule.
	 * 注意：持久化在 config.json 中的规则可能没有该字段（历史 schema），
	 * 使用方须容忍 undefined（视为 config 规则）。
	 */
	source?: 'config' | 'session';
}

/** A simplified entry for matching */
export interface MatchableEntry {
	id: string;
	type: string;
	message?: { role?: string; content?: string; toolName?: string };
	toolName?: string;
	tokensBefore?: number;
	modelId?: string;
	thinkingLevel?: string;
	customType?: string;
}

/** Map on-type to entry type check */
function typeMatches(rule: TagRule, entry: MatchableEntry): boolean {
	switch (rule.on) {
		case 'compaction':
			return entry.type === 'compaction';
		case 'tool_call':
			return entry.type === 'message' && entry.message?.role === 'toolResult';
		case 'user_message':
			return entry.type === 'message' && entry.message?.role === 'user';
		case 'assistant_message':
			return entry.type === 'message' && entry.message?.role === 'assistant';
		case 'model_change':
			return entry.type === 'model_change';
		case 'error':
			return (
				(entry.type === 'message' &&
					entry.message?.role === 'assistant' &&
					!!(entry as any).errorMessage) ||
				entry.type === 'error' ||
				// 兼容历史语义（旧版 turn_end 内联匹配）：toolResult 内容含 'error' 子串
				(entry.type === 'message' &&
					entry.message?.role === 'toolResult' &&
					typeof entry.message.content === 'string' &&
					entry.message.content.includes('error'))
			);
	}
}

/**
 * Check optional match conditions.
 * - `contentPattern`: 正则语义（兼容历史 config 规则，面板输入的子串匹配走 FieldTagRule）
 * - 其余 key（toolName/role 等）: 精确匹配（===）
 */
function matchConditions(rule: TagRule, entry: MatchableEntry): boolean {
	if (!rule.match || Object.keys(rule.match).length === 0) return true;
	for (const [key, value] of Object.entries(rule.match)) {
		if (key === 'contentPattern') {
			// config.json 为用户可编辑输入：非法正则按不匹配处理，避免击穿调用方（turn_end/面板）
			let re: RegExp;
			try {
				re = new RegExp(value, 'i');
			} catch {
				return false;
			}
			if (!re.test(getEntryText(entry))) return false;
			continue;
		}
		const entryVal = getEntryField(entry, key);
		if (entryVal !== value) return false;
	}
	return true;
}

/** Extract plain text from an entry's message content (string or multi-block array) */
function getEntryText(entry: MatchableEntry): string {
	const content = entry.message?.content;
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) {
		const texts: string[] = [];
		for (const block of content as Array<{ text?: string }>) {
			if (block.text) texts.push(block.text);
		}
		return texts.join(' ');
	}
	return '';
}

function getEntryField(entry: MatchableEntry, key: string): string | undefined {
	// Direct entry fields
	if (key in entry && typeof (entry as any)[key] === 'string') return (entry as any)[key];
	// message fields
	if (entry.message) {
		if (key === 'toolName' && entry.message.toolName) return entry.message.toolName;
		if (key === 'contentPattern' && entry.message.content) return entry.message.content;
		if (key === 'role' && entry.message.role) return entry.message.role;
	}
	return undefined;
}

/** Check if a rule matches an entry */
export function ruleMatches(rule: TagRule, entry: MatchableEntry): boolean {
	return typeMatches(rule, entry) && matchConditions(rule, entry);
}

/** Apply a set of rules to all entries, returning entryId → label set */
export function applyRules(
	entries: Array<{ id: string } & MatchableEntry>,
	rules: TagRule[],
): Map<string, string[]> {
	const result = new Map<string, string[]>();
	for (const entry of entries) {
		const labels: string[] = [];
		for (const rule of rules) {
			if (ruleMatches(rule, entry)) {
				labels.push(rule.label);
			}
		}
		if (labels.length > 0) {
			result.set(entry.id, labels);
		}
	}
	return result;
}

// ═══ Incremental scan state ════════════════════════════════════════

/** 跨 turn 的增量扫描状态 */
export interface TagScanState {
	rulesKey: string | null;
	lastScannedEntryId: string | null;
}

/**
 * 计算本次自动打标扫描窗口。
 * - 规则集合变化（含清空）→ 全量扫描（startIdx=0），调用方须对所有条目重算标签以清除失效标签
 * - 规则不变 → 自上次扫描位置之后的条目增量扫描
 * 纯函数：不修改传入 state，返回 nextState 供调用方保存。
 */
export function computeScanWindow(
	entries: Array<{ id: string }>,
	rules: TagRule[],
	state: TagScanState,
): { startIdx: number; rulesChanged: boolean; nextState: TagScanState } {
	const rulesKey = JSON.stringify(rules);
	const rulesChanged = rulesKey !== state.rulesKey;
	let startIdx = 0;
	if (!rulesChanged && state.lastScannedEntryId) {
		const idx = entries.findIndex((e) => e.id === state.lastScannedEntryId);
		if (idx >= 0) startIdx = idx + 1;
	}
	return {
		startIdx,
		rulesChanged,
		nextState: { rulesKey, lastScannedEntryId: state.lastScannedEntryId },
	};
}

/** Preview which entries match a single rule */
export function previewRule(
	entries: Array<{ id: string } & MatchableEntry>,
	rule: TagRule,
): Array<{ id: string } & MatchableEntry> {
	return entries.filter((e) => ruleMatches(rule, e));
}

/** Parse a formula string into a TagRule */
export function parseFormula(formula: string): TagRule | null {
	// Normalize → to ->
	const normalised = formula.replace(/→/g, '->');
	const arrowIdx = normalised.lastIndexOf('->');
	if (arrowIdx < 0) return null;
	const left = normalised.slice(0, arrowIdx).trim();
	const label = normalised.slice(arrowIdx + 2).trim();
	if (!left || !label) return null;

	const parts = left.split(/\s+/);
	const on = parts[0] as TagRule['on'];
	if (!isValidOn(on)) return null;

	const match: Record<string, string> = {};
	for (let i = 1; i < parts.length; i++) {
		const eqIdx = parts[i].indexOf('=');
		if (eqIdx > 0) {
			const k = parts[i].slice(0, eqIdx);
			const v = parts[i].slice(eqIdx + 1);
			match[k] = v;
		}
	}

	return {
		on,
		match: Object.keys(match).length > 0 ? match : undefined,
		label,
		source: 'session',
	};
}

function isValidOn(s: string): s is TagRule['on'] {
	return [
		'compaction',
		'tool_call',
		'user_message',
		'assistant_message',
		'model_change',
		'error',
	].includes(s);
}

/** Format a TagRule back to a display string */
export function formatRule(rule: TagRule): string {
	const parts: string[] = [rule.on];
	if (rule.match) {
		for (const [k, v] of Object.entries(rule.match)) {
			parts.push(`${k}=${v}`);
		}
	}
	return `${parts.join(' ')} → ${rule.label}`;
}

// ═══ Multi-field panel types ═══════════════════════════════════════

/** Tag rule created from the multi-field panel (type + substring + label) */
export interface FieldTagRule {
	typeIndex: number; // 0=全部, 1=compaction, 2=tool_call, 3=user_message, 4=assistant_message, 5=model_change, 6=error
	matchText: string; // substring filter, empty = no filter
	label: string;
	source: 'config' | 'session';
	/** 配置规则原型引用（source === 'config' 时存在），保留 match 条件语义用于匹配 */
	tagRule?: TagRule;
}

export const TYPE_OPTIONS = [
	'全部类型',
	'compaction',
	'tool_call',
	'user_message',
	'assistant_message',
	'model_change',
	'error',
] as const;

/** Types that map to specific entry type checks (index 1-6 maps to TYPE_OPTIONS[1-6]) */
function fieldTypeMatches(typeIndex: number, entry: MatchableEntry): boolean {
	if (typeIndex === 0) return true; // all
	const on = TYPE_OPTIONS[typeIndex] as TagRule['on'];
	return typeMatches({ on, label: '', source: 'session' }, entry);
}

/** Extract full text from an entry for regex matching */
function entryFullText(entry: MatchableEntry): string {
	if (entry.type === 'message' && entry.message) {
		const c = entry.message.content;
		if (typeof c === 'string') return c;
		if (Array.isArray(c)) {
			const texts: string[] = [];
			for (const block of c as any[]) {
				if (block.text) texts.push(block.text);
			}
			return texts.join(' ');
		}
		return '';
	}
	if (entry.type === 'compaction')
		return `compaction ${Math.round((entry.tokensBefore ?? 0) / 1000)}k tokens`;
	if (entry.type === 'model_change') return `model_change ${entry.modelId ?? ''}`;
	if (entry.type === 'thinking_level_change')
		return `thinking_level ${entry.thinkingLevel ?? ''}`;
	if (entry.type === 'custom') return `custom ${entry.customType ?? ''}`;
	return entry.type;
}

/** Check if an entry matches a field rule (type ∩ regex) */
export function entryMatchesField(rule: FieldTagRule, entry: MatchableEntry): boolean {
	if (!fieldTypeMatches(rule.typeIndex, entry)) return false;
	if (rule.matchText) {
		const fullText = entryFullText(entry).toLowerCase();
		if (!fullText.includes(rule.matchText.toLowerCase())) return false;
	}
	return true;
}

/** 统一匹配入口：config 规则走 TagRule 语义（保留 match 条件），session 规则走 FieldTagRule 子串匹配 */
export function matchesRule(rule: FieldTagRule, entry: MatchableEntry): boolean {
	if (rule.source === 'config' && rule.tagRule) return ruleMatches(rule.tagRule, entry);
	return entryMatchesField(rule, entry);
}

/** Preview entries matching the current field inputs */
export function previewFieldMatches(
	entries: MatchableEntry[],
	typeIndex: number,
	matchText: string,
	limit = 3,
): MatchableEntry[] {
	const rule: FieldTagRule = { typeIndex, matchText, label: '', source: 'session' };
	return entries.filter((e) => entryMatchesField(rule, e)).slice(0, limit);
}

/** Count total matching entries (no limit) */
export function countFieldMatches(
	entries: MatchableEntry[],
	typeIndex: number,
	matchText: string,
): number {
	const rule: FieldTagRule = { typeIndex, matchText, label: '', source: 'session' };
	return entries.filter((e) => entryMatchesField(rule, e)).length;
}

/** Apply field rules to all entries, returning entryId → label set */
export function applyFieldRules(
	entries: MatchableEntry[],
	rules: FieldTagRule[],
): Map<string, string[]> {
	const result = new Map<string, string[]>();
	for (const entry of entries) {
		const labels: string[] = [];
		for (const rule of rules) {
			if (entryMatchesField(rule, entry)) {
				labels.push(rule.label);
			}
		}
		if (labels.length > 0) result.set(entry.id, labels);
	}
	return result;
}

/** Format a FieldTagRule for display */
export function formatFieldRule(rule: FieldTagRule): string {
	const typeLabel = TYPE_OPTIONS[rule.typeIndex];
	const parts: string[] = [typeLabel];
	if (rule.matchText) parts.push(`/${rule.matchText}/`);
	return `${parts.join(' ')} → ${rule.label}`;
}
