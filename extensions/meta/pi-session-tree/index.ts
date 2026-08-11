/**
 * @zenone/pi-session-tree — 会话树查询服务
 *
 * 封装 Pi 原生 SessionManager.getTree()，
 * 提供类型感知的查询接口。
 *
 * 双重模式：
 *   - 库模式：import { createSessionTree } from '@zenone/pi-session-tree'
 *   - 扩展模式：pi 自动加载 default export，注册 /tree-stats 命令
 */

import type { ExtensionAPI, SessionEntry, SessionTreeNode } from '@earendil-works/pi-coding-agent';
import { createLogger } from '@zenone/pi-logger';
import type {
	TreeNode,
	EntryType,
	TreeSnapshot,
	TreeDiff,
	PathSegment,
	RetryResult,
} from './types.js';

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

// ── Public API ─────────────────────────────────────────────────────

export interface SessionTreeAPI {
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

	// D. Aggregation
	countByType(path: TreeNode[], type: EntryType): number;
	toolCallDistribution(path: TreeNode[]): Record<string, number>;
	compactionHistory(path: TreeNode[]): { tokensBefore?: number; timestamp: string }[];
	entryTypeTimeline(path: TreeNode[]): PathSegment[];

	// E. Content
	extractUserMessages(path: TreeNode[]): string[];
	detectKeywords(path: TreeNode[], keywords: string[]): TreeNode[];
	extractLabels(): { label: string; targetId: string }[];

	// F. Window
	lastN(n: number, fromId?: string): TreeNode[];
	entriesSinceLastCompaction(): TreeNode[];

	// G. Annotation
	annotate(entryId: string, customType: string, data: unknown): Promise<void>;
	getAnnotations(customType: string): TreeNode[];

	// H. Snapshot
	snapshot(): TreeSnapshot;
	diff(prev: TreeSnapshot): TreeDiff;

	// Retry detection
	detectRetry(fromEntryId: string, toEntryId: string): Promise<RetryResult>;
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

	const api: SessionTreeAPI = {
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

		// ── D. Aggregation ───────────────────────────────────

		countByType(path: TreeNode[], type: EntryType): number {
			return path.filter((n) => n.type === type).length;
		},

		toolCallDistribution(_path: TreeNode[]): Record<string, number> {
			// Placeholder — will be implemented when tool_result entries are parsed
			return {};
		},

		compactionHistory(path: TreeNode[]): { tokensBefore?: number; timestamp: string }[] {
			return path
				.filter((n) => n.type === 'compaction')
				.map((n) => ({
					tokensBefore: (n.raw as any).tokensBefore,
					timestamp: n.timestamp,
				}));
		},

		entryTypeTimeline(path: TreeNode[]): PathSegment[] {
			const segments: PathSegment[] = [];
			for (const n of path) {
				const last = segments[segments.length - 1];
				if (last && last.type === n.type) {
					last.count++;
					last.entries.push(n);
				} else {
					segments.push({ type: n.type, count: 1, entries: [n] });
				}
			}
			return segments;
		},

		// ── E. Content ───────────────────────────────────────

		extractUserMessages(path: TreeNode[]): string[] {
			return path
				.filter((n) => n.type === 'message' && (n.raw as any).message?.role === 'user')
				.map((n) => {
					const content = (n.raw as any).message?.content;
					if (typeof content === 'string') return content;
					if (Array.isArray(content))
						return content
							.filter((c: any) => c.type === 'text')
							.map((c: any) => c.text)
							.join(' ');
					return '';
				});
		},

		detectKeywords(path: TreeNode[], keywords: string[]): TreeNode[] {
			return path.filter((n) => {
				const content = (n.raw as any).message?.content;
				const text =
					typeof content === 'string'
						? content
						: Array.isArray(content)
							? content
									.filter((c: any) => c.type === 'text')
									.map((c: any) => c.text)
									.join(' ')
							: '';
				return keywords.some((kw) => text.toLowerCase().includes(kw.toLowerCase()));
			});
		},

		extractLabels(): { label: string; targetId: string }[] {
			return collectNodes(getRoots())
				.filter((n) => n.label)
				.map((n) => ({ label: n.label!, targetId: n.id }));
		},

		// ── F. Window ────────────────────────────────────────

		lastN(n: number, fromId?: string): TreeNode[] {
			const path = this.pathToLeaf(fromId);
			return path.slice(-n);
		},

		entriesSinceLastCompaction(): TreeNode[] {
			const path = getLeafPath();
			let lastCompactionIdx = -1;
			for (let i = path.length - 1; i >= 0; i--) {
				if (path[i].type === 'compaction') {
					lastCompactionIdx = i;
					break;
				}
			}
			return lastCompactionIdx >= 0 ? path.slice(lastCompactionIdx) : path;
		},

		// ── G. Annotation ────────────────────────────────────

		async annotate(_entryId: string, _customType: string, _data: unknown): Promise<void> {
			// Stub — for annotation support use createSessionTreeWithPi(sm, pi)
			log.warn(
				'annotate() called without Pi ExtensionAPI — annotation discarded. Use createSessionTreeWithPi() instead.',
			);
		},

		getAnnotations(_customType: string): TreeNode[] {
			return collectNodes(getRoots()).filter(
				(n) => n.type === 'custom' && (n.raw as any).customType === _customType,
			);
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
	};

	return api;
}

// ── Extension ──────────────────────────────────────────────────────

/**
 * Pi 扩展入口 — 注册 /tree-stats 命令和 TUI 面板。
 */
export default function piSessionTreeExtension(pi: ExtensionAPI) {
	log.info('Extension loaded');

	pi.registerCommand('tree-stats', {
		description: 'Show session tree structure metrics and query results',
		handler: async (_args, ctx) => {
			const sm = ctx.sessionManager as Parameters<typeof createSessionTree>[0];
			const tree = createSessionTreeWithPi(sm, pi);
			const branchCount = tree.branchCount();
			const depth = tree.maxDepth();
			const complexity = tree.treeComplexity();
			const path = tree.pathToLeaf();
			const labels = tree.extractLabels();

			const lines = [
				`Branch points: ${branchCount}`,
				`Max depth: ${depth}`,
				`Path length: ${path.length}`,
				`Complexity score: ${complexity}`,
				`Labels: ${labels.map((l) => l.label).join(', ') || '(none)'}`,
				`Compactions: ${tree.countByType(path, 'compaction')}`,
				`Model changes: ${tree.countByType(path, 'model_change')}`,
			];

			if (ctx.hasUI) {
				ctx.ui.notify(lines.join('  |  '), 'info');
			}
		},
	});

	log.info('Commands registered');
}

// ── Annotation-aware factory ───────────────────────────────────────

/** 带 Pi ExtensionAPI 的 createSessionTree（支持 annotate） */
function createSessionTreeWithPi(
	sessionManager: Parameters<typeof createSessionTree>[0],
	pi: ExtensionAPI,
): SessionTreeAPI {
	const base = createSessionTree(sessionManager);

	// Override annotate to use real pi.appendEntry
	base.annotate = async (entryId: string, customType: string, data: unknown) => {
		const entry = sessionManager.getEntry(entryId);
		if (!entry) {
			log.warn('annotate: entry not found | id=%s', entryId);
			return;
		}
		pi.appendEntry(customType, data);
		log.debug('annotate: custom entry appended | type=%s entryId=%s', customType, entryId);
	};

	return base;
}

export { createSessionTreeWithPi };
export type { TreeNode, EntryType, TreeSnapshot, TreeDiff, PathSegment, RetryResult };
