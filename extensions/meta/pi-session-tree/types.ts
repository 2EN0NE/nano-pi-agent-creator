/**
 * @zenone/pi-session-tree — 类型定义
 *
 * 自有 TreeNode 抽象，封装 Pi 原生 SessionEntry，
 * 附加计算字段（depth, branchIndex）隔离 Pi 版本变化。
 */

import type { SessionEntry } from '@earendil-works/pi-coding-agent';

// ── TreeNode ──────────────────────────────────────────────────────

/** 自有树节点，封装 Pi 原生 SessionEntry */
export interface TreeNode {
	/** 节点 ID（= Pi entry.id） */
	id: string;
	/** 父节点 ID（= Pi entry.parentId） */
	parentId: string | null;
	/** Pi entry 类型 */
	type: EntryType;
	/** ISO 时间戳 */
	timestamp: string;
	/** 距根节点的深度（0 为根） */
	depth: number;
	/** 在兄弟节点中的索引（0 为第一个） */
	branchIndex: number;
	/** 子节点列表 */
	children: TreeNode[];
	/** 用户标签 */
	label?: string;
	/** 原始 Pi entry，供高级访问 */
	raw: SessionEntry;
}

// ── Entry types ────────────────────────────────────────────────────

/** Pi SessionEntry 的类型字面量 */
export type EntryType =
	| 'message'
	| 'model_change'
	| 'compaction'
	| 'branch_summary'
	| 'custom'
	| 'custom_message'
	| 'label'
	| 'thinking_level_change'
	| 'session_info';

// ── Query results ──────────────────────────────────────────────────

/** 快照 */
export interface TreeSnapshot {
	leafId: string | null;
	entryCount: number;
	timestamp: string;
}

/** 快照差异 */
export interface TreeDiff {
	added: number;
	removed: number;
	previousLeafId: string | null;
	currentLeafId: string | null;
}

/** 路径段（时序分组） */
export interface PathSegment {
	type: EntryType;
	count: number;
	entries: TreeNode[];
}

// ── Retry detection ────────────────────────────────────────────────

export interface RetryResult {
	isRetry: boolean;
	confidence: number; // 0-1
	method: 'bm25' | 'llm';
}
