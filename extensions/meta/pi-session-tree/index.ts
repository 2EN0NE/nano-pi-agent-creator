/**
 * @zenone/pi-session-tree — 会话树查询服务
 *
 * 封装 Pi 原生 SessionManager.getTree()，
 * 提供类型感知的查询接口。
 *
 * 双重模式：
 *   - 库模式：import { createSessionTree } from '@zenone/pi-session-tree'
 *   - 扩展模式：pi 自动加载 default export，注册 /tree-stats（结构统计）
 *     与 /custom-session-tree（TUI 面板：树渲染 + 过滤 + 搜索 + 跳转 + 标记 + tag 打标）
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	SessionEntry,
	SessionTreeNode,
} from '@earendil-works/pi-coding-agent';
// pi-lens-ignore: pi-lens/no-unused-vars
import { createConfigStore } from '@zenone/pi-config';
import type { TagRule } from './types.js';
import { applyRules, computeScanWindow, type MatchableEntry } from './tag-engine.js';
import type {
	TreeNode,
	EntryType,
	TreeSnapshot,
	TreeDiff,
	PathSegment,
	RetryResult,
	RangeReport,
	ComplexityLevel,
	ComplexityDimensions,
	ComplexityReport,
} from './types.js';
// 说明：.semgrep.yml 的 pi.logger-imported-but-unused 规则存在误报（import 节点上 pattern-not const 声明恒成立），
// 下方 nosemgrep 注释用于抑制该误报；const log = createLogger(...) 在下方实例化并被 log.info/error 实际使用。
import { createLogger } from '@zenone/pi-logger'; // nosemgrep: pi.logger-imported-but-unused

const log = createLogger('pi-session-tree');

// ── Internal ───────────────────────────────────────────────────────

/** 从消息内容中提取纯文本 */
function extractText(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) {
		return content
			.filter((c) => c.type === 'text' && typeof c.text === 'string')
			.map((c) => c.text!)
			.join(' ');
	}
	return '';
}

/** 分词 */
function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^\w\s]/g, ' ')
		.split(/\s+/)
		.filter((t) => t.length > 1);
}

/** 两文本间的 BM25 相似度分数 */
function pairwiseBM25(text1: string, text2: string): number {
	const tokens1 = tokenize(text1);
	const tokens2 = tokenize(text2);
	if (tokens1.length === 0 || tokens2.length === 0) return 0;

	const docs = [tokens1, tokens2];
	const N = 2;
	const df = new Map<string, number>();
	for (const doc of docs) {
		const seen = new Set<string>();
		for (const t of doc) {
			if (!seen.has(t)) {
				seen.add(t);
				df.set(t, (df.get(t) ?? 0) + 1);
			}
		}
	}

	const idf = new Map<string, number>();
	for (const [term, d] of df) {
		idf.set(term, Math.log((N - d + 0.5) / (d + 0.5) + 1));
	}

	const k1 = 1.2;
	const b = 0.75;
	const avgDl = (tokens1.length + tokens2.length) / 2;
	const dl = tokens2.length;

	const tf = new Map<string, number>();
	for (const t of tokens2) tf.set(t, (tf.get(t) ?? 0) + 1);

	let score = 0;
	for (const term of tokens1) {
		const i = idf.get(term);
		if (!i) continue;
		const f = tf.get(term) ?? 0;
		if (f === 0) continue;
		score += i * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (dl / avgDl))));
	}
	return score;
}

/** 将 Pi SessionTreeNode 转为自有 TreeNode */
function wrapNode(piNode: SessionTreeNode, depth: number, branchIndex: number): TreeNode {
	const children = piNode.children.map((child, i) => wrapNode(child, depth + 1, i));
	const entry = piNode.entry;
	return {
		id: entry.id,
		parentId: entry.parentId,
		type: entry.type as EntryType,
		timestamp: entry.timestamp,
		depth,
		branchIndex,
		children,
		label: piNode.label,
		raw: entry,
	};
}

/** 从根节点遍历收集所有节点 */
function collectNodes(roots: TreeNode[]): TreeNode[] {
	const result: TreeNode[] = [];
	function walk(n: TreeNode) {
		result.push(n);
		for (const c of n.children) walk(c);
	}
	for (const r of roots) walk(r);
	return result;
}

// ── Complexity analysis ────────────────────────────────────────────

/** 6 维 → 等级的下界 [medium 下界, high 下界]，左闭右开（<med → low, <high → medium, else high） */
const COMPLEXITY_THRESHOLDS: Record<keyof ComplexityDimensions, [number, number]> = {
	branchPoints: [1, 3],
	maxDepth: [10, 30],
	compactionCount: [1, 2],
	toolTypeCount: [3, 6],
	userQuestionCount: [5, 15],
	turnsPerQuestion: [2, 5],
};

/** 单维值 → 0(low)/1(medium)/2(high) */
function dimensionLevel(dimension: keyof ComplexityDimensions, value: number): number {
	const [med, high] = COMPLEXITY_THRESHOLDS[dimension];
	if (value < med) return 0;
	if (value < high) return 1;
	return 2;
}

const COMPLEXITY_LEVELS: ComplexityLevel[] = ['low', 'medium', 'high'];

/** 找从根到目标节点的路径 */
function findPath(roots: TreeNode[], targetId: string): TreeNode[] {
	function search(nodes: TreeNode[], path: TreeNode[]): TreeNode[] | null {
		for (const n of nodes) {
			const p = [...path, n];
			if (n.id === targetId) return p;
			const r = search(n.children, p);
			if (r) return r;
		}
		return null;
	}
	return search(roots, []) ?? [];
}

/** DFS 偏移：从 fromId 向前/后 offset 步（负=后），跳过无文本 assistant。
 *  from 节点本身始终保留（即使是无文本 assistant 的当前 leaf），否则 findIndex 落空、跳转静默失效。
 *  注意：仅跳过无文本 assistant——面板的 filterMode/搜索/折叠等动态过滤是 resolve 无法感知的 UI 状态，
 *  落点被动态隐藏时由面板 revealNode + 切 all 兜底揭示。 */
function offsetNode(roots: TreeNode[], fromId: string, offset: number): TreeNode | null {
	const all = collectNodes(roots).filter((n) => !isNoTextAssistant(n, fromId));
	const idx = all.findIndex((n) => n.id === fromId);
	if (idx < 0) return null;
	const tgt = idx + offset;
	return tgt >= 0 && tgt < all.length ? all[tgt] : null;
}

/** 判断「无文本且非 error/aborted 的 assistant 消息」（与 panel 渲染 shouldShow 的跳过规则一致）
 *  @param exceptId 例外节点：该节点即使是无文本 assistant 也视为可见——
 *        panel 对「当前 leaf」的例外，以及 offsetNode 保留 from 锚点，避免跳转静默失效。 */
export function isNoTextAssistant(node: TreeNode, exceptId?: string | null): boolean {
	if (node.type !== 'message') return false;
	if (exceptId != null && node.id === exceptId) return false;
	const msg = (node.raw as any)?.message;
	if (msg?.role !== 'assistant') return false;
	const hasText =
		typeof msg.content === 'string'
			? msg.content.trim().length > 0
			: Array.isArray(msg.content)
				? msg.content.some((c: any) => c.type === 'text' && c.text)
				: false;
	const isErrorOrAborted =
		msg.stopReason && msg.stopReason !== 'stop' && msg.stopReason !== 'toolUse';
	return !hasText && !isErrorOrAborted;
}

// ── Public API ─────────────────────────────────────────────────────

export interface SessionTreeAPI {
	// ① Locate
	/** 解析表达式 → 单个节点 或 范围 { from, to } */
	resolve(
		expr: string,
		opts?: { from?: string },
	): TreeNode | { from: TreeNode; to: TreeNode } | null;

	// A. Node
	findByType(type: EntryType): TreeNode[];
	findByLabel(label: string): TreeNode | undefined;
	findAncestor(id: string, type: EntryType): TreeNode | undefined;

	// B. Path
	pathToLeaf(fromId?: string): TreeNode[];
	pathBetween(fromId: string, toId: string): TreeNode[];
	distance(fromId: string, toId: string): number;
	LCA(id1: string, id2: string): TreeNode | undefined;
	entriesBetween(fromId: string, toId: string): TreeNode[];

	// C. Structure
	branchCount(): number;
	maxDepth(): number;
	pathLength(id?: string): number;
	treeComplexity(): number;

	/** 当前会话的复杂度分析（6 维指标 + 综合等级） */
	analyzeComplexity(): ComplexityReport;

	// ② Analyze
	/** 从 fromId 到 toId 之间的结构化范围报告 */
	analyze(fromId: string, toId: string): RangeReport;
	/** DFS 全序中两点之间的节点（含端点，自动排序，顺序无关） */
	rangeNodes(fromId: string, toId: string): TreeNode[];
	/** 获取所有标签 */
	extractLabels(): { label: string; targetId: string }[];

	// Tag rules
	/** 获取自动标注规则 */
	getTagRules(): TagRule[];
	/** 设置自动标注规则 */
	setTagRules(rules: TagRule[]): void;
	/** 给多个节点批量打标签（自动加 # 前缀，合并已有非 # 标签） */
	setLabels(entryId: string, labels: string[]): void;
	/** 获取所有原始 entries（用于 tag 引擎全量扫描） */
	getAllEntries(): MatchableEntry[];

	// F. Window
	lastN(n: number, fromId?: string): TreeNode[];

	// H. Snapshot
	snapshot(): TreeSnapshot;
	diff(prev: TreeSnapshot): TreeDiff;

	// Retry detection
	detectRetry(fromEntryId: string, toEntryId: string): Promise<RetryResult>;

	// Tree access
	getRootNodes(): TreeNode[];
	/** 当前 leaf 节点 id（无文本 assistant 跳过规则的例外） */
	getLeafId(): string | null;
}

/**
 * 创建会话树查询服务实例。
 *
 * @param sessionManager Pi 的 ReadonlySessionManager
 * @returns SessionTreeAPI
 */
export function createSessionTree(sessionManager: {
	getTree: () => SessionTreeNode[];
	getLeafId: () => string | null;
	getEntry: (id: string) => SessionEntry | undefined;
	getCwd: () => string;
	getSessionId: () => string;
	getSessionDir: () => string;
	getSessionFile: () => string | undefined;
	getEntries: () => SessionEntry[];
	getLeafEntry: () => SessionEntry | undefined;
	getHeader: () => { id: string; cwd: string; parentSession?: string } | null;
	getSessionName: () => string | undefined;
	buildContextEntries: () => SessionEntry[];
	getLabel: (id: string) => string | undefined;
	getBranch: (fromId?: string) => SessionEntry[];
}): SessionTreeAPI {
	function getRoots(): TreeNode[] {
		return sessionManager.getTree().map((n, i) => wrapNode(n, 0, i));
	}

	function getLeafPath(): TreeNode[] {
		const leafId = sessionManager.getLeafId();
		if (!leafId) return [];
		const roots = getRoots();
		return findPath(roots, leafId);
	}

	let tagRules: TagRule[] = [];

	const api: SessionTreeAPI = {
		// ── ① Locate ──────────────────────────────────────────

		resolve(
			expr: string,
			opts?: { from?: string },
		): TreeNode | { from: TreeNode; to: TreeNode } | null {
			if (!expr) return null;

			// Range: split on ".."
			const dotIdx = expr.indexOf('..');
			if (dotIdx >= 0) {
				const left = expr.slice(0, dotIdx);
				const right = expr.slice(dotIdx + 2);
				const from = left ? api.resolve(left, opts) : null;
				const to = right ? api.resolve(right, opts) : null;
				if (from && to && !('from' in from) && !('from' in to)) {
					const fromN = from as TreeNode;
					const toN = to as TreeNode;
					// Ensure from is before to in the leaf path
					const leafPath = getLeafPath();
					const fromIdx = leafPath.findIndex((n) => n.id === fromN.id);
					const toIdx = leafPath.findIndex((n) => n.id === toN.id);
					if (fromIdx >= 0 && toIdx >= 0) {
						return fromIdx <= toIdx
							? { from: fromN, to: toN }
							: { from: toN, to: fromN };
					}
					return { from: fromN, to: toN };
				}
				return null;
			}

			// @^ — parent
			if (expr === '@^') {
				const leafPath = getLeafPath();
				return leafPath.length >= 2 ? leafPath[leafPath.length - 2] : null;
			}

			// @~N:type — walk back N steps of type
			const backTypeMatch = expr.match(/^@~(\d+):(\w+)$/);
			if (backTypeMatch) {
				const n = parseInt(backTypeMatch[1], 10);
				const type = backTypeMatch[2];
				const leafPath = getLeafPath();
				let count = 0;
				// Walk from parent backward (don't count the leaf itself)
				for (let i = leafPath.length - 2; i >= 0; i--) {
					if (type === 'user' || type === 'assistant') {
						const raw = leafPath[i].raw as any;
						const msg = raw?.message;
						if (msg && msg.role === type) {
							count++;
							if (count === n) return leafPath[i];
						}
					} else if (leafPath[i].type === type) {
						count++;
						if (count === n) return leafPath[i];
					}
				}
				return null;
			}

			// @~N — walk back N steps (any type, skipping no-text assistant)
			const backMatch = expr.match(/^@~(\d+)$/);
			if (backMatch) {
				const n = parseInt(backMatch[1], 10);
				const leafPath = getLeafPath();
				// 从父节点往回数 N 步（仅跳过无文本 assistant；filterMode/搜索等动态过滤见 ADR-0007，由面板 revealNode+切 all 兜底）
				let count = 0;
				for (let i = leafPath.length - 2; i >= 0; i--) {
					if (isNoTextAssistant(leafPath[i])) continue;
					count++;
					if (count === n) return leafPath[i];
				}
				return null;
			}

			// @ — current leaf
			if (expr === '@') {
				const leafId = sessionManager.getLeafId();
				if (!leafId) return null;
				const roots = getRoots();
				const path = findPath(roots, leafId);
				return path.length > 0 ? path[path.length - 1] : null;
			}

			// @^^type — nearest ancestor of type
			const ancMatch = expr.match(/^@\^\^(\w+)$/);
			if (ancMatch) {
				const type = ancMatch[1];
				const leafId = sessionManager.getLeafId();
				if (!leafId) return null;
				return api.findAncestor(leafId, type as EntryType) ?? null;
			}

			// ID prefix (≥1 alphanumeric chars, unambiguous)
			if (/^[0-9a-zA-Z]+$/.test(expr)) {
				const allNodes = collectNodes(getRoots());
				const matches = allNodes.filter((n) => n.id.startsWith(expr));
				return matches.length === 1 ? matches[0] : null;
			}

			// ── Forward/backward offset (+N / -N) ────────────────

			// combo: baseExpr +N  or  baseExpr -N
			const comboMatch = expr.match(/^(.+?)\s+([+-])(\d+)$/);
			if (comboMatch) {
				const base = api.resolve(comboMatch[1], opts);
				if (!base || 'from' in base) return null;
				return offsetNode(
					getRoots(),
					base.id,
					comboMatch[2] === '+'
						? parseInt(comboMatch[3], 10)
						: -parseInt(comboMatch[3], 10),
				);
			}

			// standalone: +N  or  -N (needs opts.from)
			const soloMatch = expr.match(/^([+-])(\d+)$/);
			if (soloMatch) {
				const fromId = opts?.from;
				if (!fromId) return null;
				return offsetNode(
					getRoots(),
					fromId,
					soloMatch[1] === '+' ? parseInt(soloMatch[2], 10) : -parseInt(soloMatch[2], 10),
				);
			}

			return null;
		},

		// ── A. Node ──────────────────────────────────────────

		findByType(type: EntryType): TreeNode[] {
			return collectNodes(getRoots()).filter((n) => n.type === type);
		},

		findByLabel(label: string): TreeNode | undefined {
			return collectNodes(getRoots()).find((n) => n.label === label);
		},

		findAncestor(id: string, type: EntryType): TreeNode | undefined {
			const path = findPath(getRoots(), id);
			for (let i = path.length - 2; i >= 0; i--) {
				if (path[i].type === type) return path[i];
			}
			return undefined;
		},

		// ── B. Path ──────────────────────────────────────────

		pathToLeaf(fromId?: string): TreeNode[] {
			const leafId = sessionManager.getLeafId();
			if (!leafId) return [];
			const roots = getRoots();
			const path = findPath(roots, leafId);
			if (!fromId) return path;
			const idx = path.findIndex((n) => n.id === fromId);
			return idx >= 0 ? path.slice(idx) : path;
		},

		pathBetween(fromId: string, toId: string): TreeNode[] {
			const roots = getRoots();
			const toPath = findPath(roots, toId);
			const idx = toPath.findIndex((n) => n.id === fromId);
			if (idx < 0) return [];
			return toPath.slice(idx);
		},

		distance(fromId: string, toId: string): number {
			const path = this.pathBetween(fromId, toId);
			return path.length > 1 ? path.length - 1 : 0;
		},

		LCA(id1: string, id2: string): TreeNode | undefined {
			const roots = getRoots();
			const p1 = findPath(roots, id1);
			const p2 = findPath(roots, id2);
			let lca: TreeNode | undefined;
			for (let i = 0; i < Math.min(p1.length, p2.length); i++) {
				if (p1[i].id === p2[i].id) lca = p1[i];
				else break;
			}
			return lca;
		},

		entriesBetween(fromId: string, toId: string): TreeNode[] {
			return this.pathBetween(fromId, toId);
		},

		// ── C. Structure ─────────────────────────────────────

		branchCount(): number {
			return collectNodes(getRoots()).filter((n) => n.children.length > 1).length;
		},

		maxDepth(): number {
			const nodes = collectNodes(getRoots());
			return nodes.length > 0 ? Math.max(...nodes.map((n) => n.depth)) : 0;
		},

		pathLength(id?: string): number {
			const roots = getRoots();
			if (id) return findPath(roots, id).length - 1;
			const leafId = sessionManager.getLeafId();
			if (!leafId) return 0;
			return findPath(roots, leafId).length - 1;
		},

		treeComplexity(): number {
			const bc = this.branchCount();
			const md = this.maxDepth();
			return bc * 10 + md;
		},

		analyzeComplexity(): ComplexityReport {
			const nodes = collectNodes(getRoots());
			const dimensions: ComplexityDimensions = {
				branchPoints: 0,
				maxDepth: 0,
				compactionCount: 0,
				toolTypeCount: 0,
				userQuestionCount: 0,
				turnsPerQuestion: 0,
			};
			if (nodes.length === 0) {
				return { level: 'low', dimensions };
			}

			const toolTypes = new Set<string>();
			let userQuestions = 0;
			let agentMessages = 0;

			for (const n of nodes) {
				if (n.depth > dimensions.maxDepth) dimensions.maxDepth = n.depth;
				if (n.children.length > 1) dimensions.branchPoints++;
				if (n.type === 'compaction') dimensions.compactionCount++;
				if (n.type === 'message') {
					const msg = (n.raw as any).message;
					if (msg?.role === 'user') userQuestions++;
					else if (msg?.role === 'assistant') agentMessages++;
					else if (msg?.role === 'toolResult' && msg.toolName)
						toolTypes.add(msg.toolName);
				}
			}

			dimensions.toolTypeCount = toolTypes.size;
			dimensions.userQuestionCount = userQuestions;
			dimensions.turnsPerQuestion = userQuestions > 0 ? agentMessages / userQuestions : 0;

			let levelIndex = 0;
			for (const key of Object.keys(dimensions) as (keyof ComplexityDimensions)[]) {
				levelIndex = Math.max(levelIndex, dimensionLevel(key, dimensions[key]));
			}

			return { level: COMPLEXITY_LEVELS[levelIndex], dimensions };
		},

		// ── ② Analyze ──────────────────────────────────────────

		analyze(fromId: string, toId: string): RangeReport {
			// DFS 全序中两点之间的节点（含端点，自动排序）——
			// 标记顺序无关，任意两节点（含祖先-后代/兄弟/跨分支）都能得到范围。
			const path = api.rangeNodes(fromId, toId);

			// byType
			const byType: Record<string, number> = {};
			for (const n of path) {
				byType[n.type] = (byType[n.type] ?? 0) + 1;
			}

			// userQuestions
			const userQuestions: string[] = [];
			let agentMessages = 0;
			for (const n of path) {
				if (n.type === 'message') {
					const msg = (n.raw as any).message;
					if (msg?.role === 'user') {
						const content = msg.content;
						if (typeof content === 'string') userQuestions.push(content);
						else if (Array.isArray(content))
							userQuestions.push(
								content
									.filter((c: any) => c.type === 'text')
									.map((c: any) => c.text)
									.join(' '),
							);
					} else if (msg?.role === 'assistant') {
						agentMessages++;
					}
				}
			}

			// branchPoints: nodes with children.length > 1
			const branchPoints = path
				.filter((n) => n.children.length > 1)
				.map((n) => ({ id: n.id, depth: n.depth }));

			// compactions
			const compactions = path
				.filter((n) => n.type === 'compaction')
				.map((n) => ({
					tokensBefore: (n.raw as any).tokensBefore ?? 0,
					summary: (n.raw as any).summary ?? '',
				}));

			// toolCalls
			const toolCalls: Record<string, number> = {};
			for (const n of path) {
				if (n.type === 'message') {
					const msg = (n.raw as any).message;
					if (msg?.role === 'toolResult' && msg.toolName) {
						toolCalls[msg.toolName] = (toolCalls[msg.toolName] ?? 0) + 1;
					}
				}
			}

			// labels
			const labels = path
				.filter((n) => n.label)
				.map((n) => ({ label: n.label!, targetId: n.id }));

			// retryPatterns — placeholder, detectRetry is async
			const retryPatterns: RetryResult[] = [];

			// timeSpan
			const timeSpan = {
				start: path.length > 0 ? path[0].timestamp : '',
				end: path.length > 0 ? path[path.length - 1].timestamp : '',
			};

			return {
				segmentCount: path.length,
				byType,
				userQuestions,
				agentMessages,
				branchPoints,
				compactions,
				toolCalls,
				labels,
				retryPatterns,
				timeSpan,
			};
		},

		rangeNodes(fromId: string, toId: string): TreeNode[] {
			// DFS 全序中两点之间的节点（含端点），自动排序（lo/hi），顺序无关。
			const all = collectNodes(getRoots());
			const fromIdx = all.findIndex((n) => n.id === fromId);
			const toIdx = all.findIndex((n) => n.id === toId);
			if (fromIdx < 0 || toIdx < 0) return [];
			const lo = Math.min(fromIdx, toIdx);
			const hi = Math.max(fromIdx, toIdx);
			return all.slice(lo, hi + 1);
		},

		extractLabels(): { label: string; targetId: string }[] {
			return collectNodes(getRoots())
				.filter((n) => n.label)
				.map((n) => ({ label: n.label!, targetId: n.id }));
		},

		// Tag rules
		getTagRules(): TagRule[] {
			return tagRules;
		},
		setTagRules(rules: TagRule[]): void {
			tagRules = rules;
		},

		getAllEntries(): MatchableEntry[] {
			return sessionManager.getEntries() as MatchableEntry[];
		},

		// ── F. Window ────────────────────────────────────────

		lastN(n: number, fromId?: string): TreeNode[] {
			const path = this.pathToLeaf(fromId);
			return path.slice(-n);
		},

		setLabels(_entryId: string, _labels: string[]): void {
			// Stub — for real label persistence use createSessionTreeWithPi(sm)
		},

		// ── H. Snapshot ──────────────────────────────────────

		snapshot(): TreeSnapshot {
			return {
				leafId: sessionManager.getLeafId(),
				entryCount: sessionManager.getEntries().length,
				timestamp: new Date().toISOString(),
			};
		},

		diff(prev: TreeSnapshot): TreeDiff {
			const cur = this.snapshot();
			return {
				added: cur.entryCount - prev.entryCount,
				removed: 0,
				previousLeafId: prev.leafId,
				currentLeafId: cur.leafId,
			};
		},

		// ── Retry detection ────────────────────────────────

		async detectRetry(fromEntryId: string, toEntryId: string): Promise<RetryResult> {
			const fromEntry = sessionManager.getEntry(fromEntryId);
			const toEntry = sessionManager.getEntry(toEntryId);

			// Both must be user messages
			if (!fromEntry || !toEntry) {
				return { isRetry: false, confidence: 0, method: 'bm25' };
			}
			if (fromEntry.type !== 'message' || toEntry.type !== 'message') {
				return { isRetry: false, confidence: 0, method: 'bm25' };
			}

			const fromMsg = (fromEntry as any).message;
			const toMsg = (toEntry as any).message;
			if (!fromMsg || !toMsg) {
				return { isRetry: false, confidence: 0, method: 'bm25' };
			}

			const fromText = extractText(fromMsg.content);
			const toText = extractText(toMsg.content);
			if (!fromText || !toText) {
				return { isRetry: false, confidence: 0, method: 'bm25' };
			}

			// BM25 comparison
			const score = pairwiseBM25(fromText, toText);

			const RETRY_THRESHOLD = 0.5;
			return {
				isRetry: score >= RETRY_THRESHOLD,
				confidence: score,
				method: 'bm25',
			};
		},

		getRootNodes(): TreeNode[] {
			return getRoots();
		},

		getLeafId(): string | null {
			return sessionManager.getLeafId();
		},
	};

	return api;
}

// ── Auto-tag 增量扫描提醒 ───────────────────────────────────────

/**
 * 汇总增量扫描命中的标签为去重逗号分隔字符串。
 * 空字符串 = 无新标签（不触发 UI 提醒）。纯函数，不依赖 pi 生命周期。
 */
export function summarizeNewLabels(labelMap: ReadonlyMap<string, string[]>): string {
	const seen = new Set<string>();
	for (const labels of labelMap.values()) {
		for (const l of labels) seen.add(l);
	}
	return [...seen].join(',');
}

// ── Extension ──────────────────────────────────────────────────────

/**
 * Pi 扩展入口 — 注册命令和 TUI 面板。
 */
export default function piSessionTreeExtension(pi: ExtensionAPI) {
	log.info('Extension loaded');

	const treeStatsHandler = async (_args: unknown, ctx: ExtensionCommandContext) => {
		const sm = ctx.sessionManager as Parameters<typeof createSessionTree>[0];
		const tree = createSessionTreeWithPi(sm);
		const branchCount = tree.branchCount();
		const depth = tree.maxDepth();
		const complexity = tree.treeComplexity();
		const complexityReport = tree.analyzeComplexity();
		const path = tree.pathToLeaf();
		const report = tree.analyze(path[0].id, path[path.length - 1].id);
		const labels = tree.extractLabels();

		const d = complexityReport.dimensions;
		const lines = [
			`Complexity: ${complexityReport.level} [branch ${d.branchPoints} | depth ${d.maxDepth} | compact ${d.compactionCount} | tools ${d.toolTypeCount} | questions ${d.userQuestionCount} | turns ${d.turnsPerQuestion.toFixed(1)}]`,
			`Branch points: ${branchCount}`,
			`Max depth: ${depth}`,
			`Path length: ${path.length}`,
			`Complexity score: ${complexity}`,
			`Labels: ${labels.map((l) => l.label).join(', ') || '(none)'}`,
			`Compactions: ${report.byType['compaction'] ?? 0}`,
			`Model changes: ${report.byType['model_change'] ?? 0}`,
		];
		ctx.ui.notify(lines.join('  |  '), 'info');
	};

	const sessionTreeHandler = async (_args: unknown, ctx: ExtensionCommandContext) => {
		if (!ctx.hasUI) {
			// TUI 模式下才打开面板，print 模式走 tree-stats
			treeStatsHandler(_args, ctx);
			return;
		}
		const sm = ctx.sessionManager as Parameters<typeof createSessionTree>[0];
		const tree = createSessionTreeWithPi(sm);
		// 面板需要读到 config 规则（ctrl+l 的规则列表/tag summary/rescanLabels），
		// 该实例独立于 session_start 实例，须单独注入
		tree.setTagRules(tagStore.get().rules);
		const sessionId = sm.getSessionId();
		const { openPanel } = await import('./ui/panel.js');
		await openPanel(ctx, tree, sessionId);
	};

	pi.registerCommand('tree-stats', {
		description: '显示会话树结构指标',
		handler: treeStatsHandler,
	});

	pi.registerCommand('custom-session-tree', {
		description: '打开会话树检查器 TUI 面板',
		handler: sessionTreeHandler,
	});

	// ── Agent tools ──────────────────────────────────────────

	pi.registerTool({
		name: 'session_tree_resolve',
		label: '解析会话树表达式',
		description:
			'解析会话树表达式（如 "@~3:user" 或 "m1..@"）为节点信息。返回节点 id、类型、角色和摘要。',
		parameters: {
			type: 'object',
			properties: {
				expr: {
					type: 'string',
					description: '会话树表达式，例如 @、@~3:user、@^^compaction、m1',
				},
			},
			required: ['expr'],
		},
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const sm = ctx.sessionManager as Parameters<typeof createSessionTree>[0];
			const tree = createSessionTreeWithPi(sm);
			const result = tree.resolve(params.expr as string);
			if (!result)
				return {
					content: [{ type: 'text', text: '表达式未解析到任何内容。' }],
					details: {},
				};
			if ('from' in result) {
				return {
					content: [
						{ type: 'text', text: `范围从 ${result.from.id} 到 ${result.to.id}` },
					],
					details: {},
				};
			}
			const node = result;
			const raw = node.raw as any;
			const msg = raw?.message;
			const summary = msg?.content
				? typeof msg.content === 'string'
					? msg.content.slice(0, 200)
					: JSON.stringify(msg.content).slice(0, 200)
				: '';
			return {
				content: [
					{
						type: 'text',
						text: JSON.stringify({
							id: node.id,
							type: node.type,
							role: msg?.role,
							summary,
						}),
					},
				],
				details: {},
			};
		},
	});

	pi.registerTool({
		name: 'session_tree_query',
		label: '查询会话树范围',
		description:
			'解析范围表达式（如 "@~3:user..@" 或 "m1..@"）并返回节点及结构化分析（计数、用户问题、工具调用、压缩、分支点）。',
		parameters: {
			type: 'object',
			properties: {
				expr: {
					type: 'string',
					description: '范围表达式，例如 @~3..@、m1..@、@^^compaction..@',
				},
			},
			required: ['expr'],
		},
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const sm = ctx.sessionManager as Parameters<typeof createSessionTree>[0];
			const tree = createSessionTreeWithPi(sm);
			const result = tree.resolve(params.expr as string);
			if (!result || !('from' in result)) {
				return {
					content: [{ type: 'text', text: 'Expression must be a range (use ..).' }],
					details: {},
				};
			}
			const analysis = tree.analyze(result.from.id, result.to.id);
			const nodes = tree.entriesBetween(result.from.id, result.to.id).map((n) => {
				const msg = (n.raw as any)?.message;
				return {
					id: n.id,
					type: n.type,
					role: msg?.role,
					toolName: msg?.toolName,
					summary: typeof msg?.content === 'string' ? msg.content.slice(0, 100) : '',
				};
			});
			return {
				content: [{ type: 'text', text: JSON.stringify({ nodes, analysis }) }],
				details: {},
			};
		},
	});

	log.info('Commands and tools registered');

	// ── Tag rules engine ─────────────────────────────────────

	const tagStore = createConfigStore<{ rules: TagRule[] }>({
		pluginName: 'pi-session-tree',
		defaults: { rules: [] },
	});

	let sessionTree: SessionTreeAPI | null = null;
	let lastScannedEntryId: string | null = null;
	let lastRulesKey: string | null = null;
	/** 是否已设置了打标提醒 status（无新标签时需清除，避免状态栏残留） */
	let tagNotifyActive = false;

	pi.on('session_start', async (_event, ctx) => {
		tagStore.reload();
		const sm = ctx.sessionManager as Parameters<typeof createSessionTree>[0];
		sessionTree = createSessionTreeWithPi(sm);
		sessionTree.setTagRules(tagStore.get().rules);
		tagNotifyActive = false;
	});

	// 自动打标：turn_end 时用配置规则扫描新增条目。
	// setLabels 幂等保证重复扫描不会产生重复标签。
	pi.on('turn_end', async (_event, ctx) => {
		if (!sessionTree) {
			const sm = ctx.sessionManager as Parameters<typeof createSessionTree>[0];
			sessionTree = createSessionTreeWithPi(sm);
			sessionTree.setTagRules(tagStore.get().rules);
		}
		const tree = sessionTree;
		const rules = tagStore.get().rules;

		const entries = tree.getAllEntries();
		// 规则集合变化（含清空）时全量重扫：对每个条目写入当前匹配标签，
		// 未匹配的写入空标签以清除历史 #标签（与面板 rescanLabels 一致）；
		// 否则增量扫描自上次以来的新增条目。
		const { startIdx, rulesChanged, nextState } = computeScanWindow(entries, rules, {
			rulesKey: lastRulesKey,
			lastScannedEntryId,
		});
		lastRulesKey = nextState.rulesKey;
		const fresh = entries.slice(startIdx);
		if (fresh.length === 0) return;

		const labelMap = applyRules(fresh as Array<{ id: string } & MatchableEntry>, rules);
		if (rulesChanged) {
			// 全量重扫：所有条目按当前规则重算（含空 → 清除旧 #标签）
			// 不触发 UI 提醒（避免规则变更/启动时刷屏）
			for (const entry of fresh) {
				tree.setLabels(entry.id, labelMap.get(entry.id) ?? []);
			}
		} else {
			// 增量扫描：只处理新增条目，命中即提醒（幂等——同条目不重复扫）。
			// 首次扫描（lastScannedEntryId 为 null，覆盖全部历史）不提醒，
			// 避免启动/首轮对历史条目刷屏。
			for (const [entryId, labels] of labelMap) {
				tree.setLabels(entryId, labels);
			}
			if (lastScannedEntryId !== null) {
				const newLabels = summarizeNewLabels(labelMap);
				if (newLabels) {
					log.info('Auto-tag applied (turn_end):', newLabels);
					if (ctx.hasUI) {
						ctx.ui.setStatus('pi-session-tree-tag', `|打标:${newLabels}`);
					}
					tagNotifyActive = true;
				} else if (tagNotifyActive) {
					// 本轮无新标签 → 清除旧提醒，避免状态栏残留过期信息
					if (ctx.hasUI) {
						ctx.ui.setStatus('pi-session-tree-tag', '');
					}
					tagNotifyActive = false;
				}
			}
		}
		lastScannedEntryId = entries[entries.length - 1]?.id ?? null;
	});

	log.info('Tag rules engine initialized');
}

// ── Annotation-aware factory ───────────────────────────────────────

/** 带 Pi ExtensionAPI 的 createSessionTree（setLabels 持久化标签到 Pi 原生 label 字段） */
function createSessionTreeWithPi(
	sessionManager: Parameters<typeof createSessionTree>[0],
): SessionTreeAPI {
	const base = createSessionTree(sessionManager);

	// Override setLabels for real Pi integration — persists tags to entry labels.
	base.setLabels = (entryId: string, labels: string[]) => {
		try {
			const sm = sessionManager as any;
			const existing = sm.getLabel?.(entryId) ?? '';
			const existingParts = existing
				.split(',')
				.map((s: string) => s.trim())
				.filter(Boolean);
			const nonTagParts = existingParts.filter((s: string) => !s.startsWith('#'));
			const newTagParts = labels.map((l: string) => (l.startsWith('#') ? l : `#${l}`));
			const merged = [...nonTagParts, ...newTagParts].join(',');
			// Only write if label actually changed
			if (merged !== existing) {
				if (merged) {
					sm.appendLabelChange?.(entryId, merged);
				} else {
					sm.appendLabelChange?.(entryId, undefined);
				}
			}
		} catch (e) {
			log.error('setLabels failed for entry %s: %s', entryId, (e as Error).message ?? e);
		}
	};

	return base;
}

export { createSessionTreeWithPi };
export type { TreeNode, EntryType, TreeSnapshot, TreeDiff, PathSegment, RetryResult };
