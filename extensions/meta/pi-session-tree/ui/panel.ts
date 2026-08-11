/**
 * /custom-session-tree TUI 面板
 *
 * 单树视图 + 跳转栏(g) + 范围 footer(~)
 * 交互: ↑↓ 移动 · ←→ 翻页 · alt+←→ 收/展(mac: option) · ctrl+d/t/u/l/a 过滤 · m 标记 · g 跳转
 */

import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { copyToClipboard, rawKeyHint } from '@earendil-works/pi-coding-agent';
import { Container, Spacer, Text, truncateToWidth, parseKey } from '@earendil-works/pi-tui';
import { isNoTextAssistant, type SessionTreeAPI, type TreeNode } from '../index.js';
import {
	type MatchableEntry,
	previewFieldMatches,
	countFieldMatches,
	formatFieldRule,
	type FieldTagRule,
	TYPE_OPTIONS,
	matchesRule,
} from '../tag-engine.js';

// ═══ Constants ══════════════════════════════════════════════════════

type FilterMode = 'default' | 'no-tools' | 'user-only' | 'labeled-only' | 'all';
const FILTER_MODES: FilterMode[] = ['default', 'no-tools', 'user-only', 'labeled-only', 'all'];

/** settings/bookkeeping 条目——default 视图隐藏（对齐原生 /tree） */
const SETTINGS_TYPES = new Set([
	'label',
	'custom',
	'model_change',
	'thinking_level_change',
	'session_info',
]);

/** Tag color palette — theme slots with max visual contrast */
const TAG_PALETTE = ['success', 'error', 'warning', 'customMessageLabel', 'toolTitle'] as const;

// ═══ Helpers ═══════════════════════════════════════════════════════

/** 方向键/翻页键符号化（对齐原生 /tree formatHelpKeys） */
function arrowize(s: string): string {
	return s
		.replace(/\bpageUp\b/g, 'pgup')
		.replace(/\bpageDown\b/g, 'pgdn')
		.replace(/\bup\b/g, '↑')
		.replace(/\bdown\b/g, '↓')
		.replace(/\bleft\b/g, '←')
		.replace(/\bright\b/g, '→');
}

/** 键 + 描述 提示（平台相关：mac option / win alt；方向键符号化） */
function hint(key: string, description: string): string {
	return rawKeyHint(arrowize(key), description);
}

/** Hash a string to a palette index */
function hashTag(tag: string): number {
	let h = 0;
	for (let i = 0; i < tag.length; i++) h = ((h << 5) - h + tag.charCodeAt(i)) | 0;
	return Math.abs(h) % TAG_PALETTE.length;
}

/** Extract tags from a node's label (comma-separated, #-prefixed) */
function getTags(node: TreeNode): string[] {
	if (!node.label) return [];
	return node.label
		.split(',')
		.map((t) => t.trim())
		.filter((t) => t.startsWith('#'));
}

/** Extract mark index from label */
// ═══ Main Panel ════════════════════════════════════════════════════

export function createPanel(
	tui: any,
	theme: any,
	kb: any,
	done: () => void,
	tree: SessionTreeAPI,
	sessionId: string,
) {
	// Use a proper class extending Container so Pi TUI can manage focus
	// 面板实际渲染宽度（由 Container.render(width) 传入，与 Text wrap 一致）。
	// 不能用 tui.terminal.columns——全屏时二者相同，但保证与渲染管线一致更稳。
	let panelWidth = tui.terminal.columns || 80;
	const SessionTreePanel = class extends (Container as any) {
		_focused = false;
		render(width: number) {
			panelWidth = width;
			return super.render(width);
		}
		get focused() {
			return this._focused;
		}
		set focused(v: boolean) {
			this._focused = v;
		}
	};

	const container = new SessionTreePanel() as any;

	// Theme color wrappers
	const accent = (s: string) => theme.fg('accent', s);
	const dim = (s: string) => theme.fg('dim', s);
	const bold = (s: string) => theme.bold(s);
	const muted = (s: string) => theme.fg('muted', s);

	function tagColor(tag: string): (s: string) => string {
		return (s: string) => theme.fg(TAG_PALETTE[hashTag(tag)], s);
	}

	// ── State ─────────────────────────────────────────

	let filterMode: FilterMode = 'default';
	let searchQuery = '';
	let activeSearch = false;
	/** 搜索模式下当前选中的节点 id（visible 列表内导航） */
	let searchCursorId: string | null = null;
	/** 进入搜索前的光标位置（flat 索引），Esc 时恢复 */
	let searchEntryCursor = 0;
	const collapsedBranches = new Set<string>();
	let cursorLine = 0;
	let scrollOffset = 0;
	// 本次 rebuild 的 flat 结果缓存：renderTree 计算一次，renderFooter 复用，
	// 避免重复 flattenTree（含 buildActivePath + buildToolCallMap + 排序，O(n log n)）。
	let currentFlat: FlatItem[] = [];
	// 页面大小自适应（参考原生 /tree 的 maxVisibleLines = floor(terminalHeight/2)）：
	// 面板总高必须 ≤ 终端视口高度，否则树行起始落在视口上方，
	// 滚动时触发 pi 的 fullRender(true)（清屏+整树重绘）→ 同步输出失效时重影。
	// overhead(不含树行) = header(1) + spacer(1) + jumpbar(1) + spacer(1) + pageInfo(1) + spacer(1) + footer(1) = 7
	// 留 1 行余量 → pageSize = rows - 8
	const pageSize = Math.max(5, Math.min(20, (tui.terminal.rows || 24) - 8));

	// Jump bar
	let jumpActive = false;
	let jumpInput = '';

	// Range
	let rangeActive = false;
	let rangeFrom: TreeNode | null = null;
	let rangeTo: TreeNode | null = null;

	/** 当前 leaf id（无文本 assistant 跳过规则的例外，对齐原生 /tree） */
	const currentLeafId = tree.getLeafId?.() ?? null;

	/** 活跃路径节点集（从根到当前 leaf），用于 • 标记（对齐原生 /tree activePathIds） */
	let activePathIds = new Set<string>();
	/** 是否多根（虚拟根场景，缩进显示时 -1） */
	let multipleRoots = false;
	/** toolCall id -> { name, arguments }（对齐原生 /tree toolCallMap，用于 formatToolCall） */
	const toolCallMap = new Map<string, { name: string; arguments: any }>();

	// Selected nodes for range (max 2)
	let selectedNodes: string[] = [];

	// Tag mode
	let tagMode = false;
	let tagFieldFocus = 0; // 0=类型, 1=匹配(正则), 2=打标
	let tagTypeIndex = 0; // 0=全部, 1+=TYPE_OPTIONS index
	let tagMatchText = '';
	let tagLabelText = '';
	let tagRules: FieldTagRule[] = [];
	let tagEntries: MatchableEntry[] = [];

	// Toast
	let copyToast = false;
	/** 跳转揭示隐藏节点（切 all）后的短暂提示 */
	let revealToast = false;
	/** filter 切换前的光标节点 id（切换后保留/上溯降级，对齐原生 lastSelectedId） */
	let lastSelectedId: string | null = null;

	// ── Tree data ──────────────────────────────────────

	function getRoots() {
		return tree.getRootNodes();
	}

	function shouldShow(node: TreeNode): boolean {
		if (searchQuery) {
			const text = displayText(node).toLowerCase();
			if (!text.includes(searchQuery.toLowerCase())) return false;
		}
		const raw = node.raw as any;
		const msg = raw?.message;

		// 对齐原生 /tree：所有模式跳过「无文本且非 error/aborted 的 assistant 消息」（当前 leaf 除外）
		if (isNoTextAssistant(node, currentLeafId)) return false;

		switch (filterMode) {
			case 'no-tools':
				return (
					!SETTINGS_TYPES.has(node.type) &&
					!(node.type === 'message' && msg?.role === 'toolResult')
				);
			case 'user-only':
				return node.type === 'message' && msg?.role === 'user';
			case 'labeled-only':
				return node.label !== undefined;
			case 'all':
				return true;
			default:
				return !SETTINGS_TYPES.has(node.type);
		}
	}

	/** 格式化 toolCall 为紧凑显示（对齐原生 /tree formatToolCall） */
	function formatToolCall(name: string, args: any): string {
		const shortenPath = (p: string) => {
			const home = process.env.HOME || process.env.USERPROFILE || '';
			if (home && p.startsWith(home)) return `~${p.slice(home.length)}`;
			return p;
		};
		switch (name) {
			case 'read': {
				const path = shortenPath(String(args?.path || args?.file_path || ''));
				const offset = args?.offset;
				const limit = args?.limit;
				let display = path;
				if (offset !== undefined || limit !== undefined) {
					const start = offset ?? 1;
					const end = limit !== undefined ? start + limit - 1 : '';
					display += `:${start}${end ? `-${end}` : ''}`;
				}
				return `[read: ${display}]`;
			}
			case 'write': {
				const path = shortenPath(String(args?.path || args?.file_path || ''));
				return `[write: ${path}]`;
			}
			case 'edit': {
				const path = shortenPath(String(args?.path || args?.file_path || ''));
				return `[edit: ${path}]`;
			}
			case 'bash': {
				const rawCmd = String(args?.command || '');
				const cmd = rawCmd
					.replace(/[\n\t]/g, ' ')
					.trim()
					.slice(0, 50);
				return `[bash: ${cmd}${rawCmd.length > 50 ? '...' : ''}]`;
			}
			case 'grep': {
				const pattern = String(args?.pattern || '');
				const path = shortenPath(String(args?.path || '.'));
				return `[grep: /${pattern}/ in ${path}]`;
			}
			case 'find': {
				const pattern = String(args?.pattern || '');
				const path = shortenPath(String(args?.path || '.'));
				return `[find: ${pattern} in ${path}]`;
			}
			case 'ls': {
				const path = shortenPath(String(args?.path || '.'));
				return `[ls: ${path}]`;
			}
			default: {
				const argsStr = JSON.stringify(args ?? {});
				const truncated = argsStr.length > 40;
				return `[${name}: ${argsStr.slice(0, 40)}${truncated ? '...' : ''}]`;
			}
		}
	}

	/** 从 assistant 消息提取 toolCall block，按 id 映射（对齐原生 /tree toolCallMap） */
	function buildToolCallMap() {
		toolCallMap.clear();
		(function walk(nodes: TreeNode[]) {
			for (const n of nodes) {
				const msg = (n.raw as any)?.message;
				if (
					n.type === 'message' &&
					msg?.role === 'assistant' &&
					Array.isArray(msg.content)
				) {
					for (const block of msg.content) {
						if (
							block &&
							typeof block === 'object' &&
							block.type === 'toolCall' &&
							block.id
						) {
							toolCallMap.set(block.id, {
								name: block.name,
								arguments: block.arguments,
							});
						}
					}
				}
				walk(n.children);
			}
		})(getRoots());
	}

	function displayText(node: TreeNode): string {
		const raw = node.raw as any;
		const msg = raw?.message;
		const norm = (s: string) => s.replace(/[\n\t]/g, ' ').trim();

		if (node.type === 'message' && msg) {
			const role = msg.role as string;
			const text = norm(
				typeof msg.content === 'string'
					? msg.content
					: Array.isArray(msg.content)
						? msg.content
								.filter((x: any) => x.text)
								.map((x: any) => x.text)
								.join(' ')
						: '',
			);
			if (role === 'user') return accent('user: ') + text.slice(0, 80);
			if (role === 'assistant') {
				const prefix = theme.fg('success', 'assistant: ');
				if (text) return prefix + text.slice(0, 80);
				if (msg.stopReason === 'aborted') return prefix + muted('(aborted)');
				if (msg.errorMessage)
					return prefix + theme.fg('error', norm(msg.errorMessage).slice(0, 80));
				return prefix + muted('(no text)');
			}
			if (role === 'toolResult') {
				// 格式化 toolCall（如 [read: src/app.ts:1-40]）+ 结果正文
				const toolCall = msg.toolCallId ? toolCallMap.get(msg.toolCallId) : undefined;
				const callText = toolCall
					? formatToolCall(toolCall.name, toolCall.arguments)
					: `[${msg.toolName ?? 'tool'}]`;
				return muted(callText) + ' ' + text.slice(0, 60);
			}
			return dim(`[${role}] `) + text.slice(0, 60);
		}

		switch (node.type) {
			case 'compaction':
				return theme.fg(
					'borderAccent',
					`[Compaction: ${Math.round(((raw as any).tokensBefore ?? 0) / 1000)}k tokens]`,
				);
			case 'branch_summary':
				return (
					theme.fg('warning', '[Branch summary] ') +
					norm((raw as any).summary ?? '').slice(0, 60)
				);
			case 'model_change':
				return dim(`[Model: ${(raw as any).modelId}]`);
			case 'thinking_level_change':
				return dim(`[Thinking: ${(raw as any).thinkingLevel}]`);
			case 'custom':
				return dim(`[System: ${(raw as any).customType ?? ''}]`);
			case 'label':
				return dim(`[Label: ${(raw as any).label ?? '(cleared)'}]`);
			case 'session_info':
				return dim(`[Title: ${(raw as any).name ?? '(none)'}]`);
			default:
				return dim(`[${node.type}]`);
		}
	}

	/** 提取正文内容（对齐原生 /tree extractFullContent：只拼 text block，直接相连） */
	function extractFullContent(content: any): string {
		if (typeof content === 'string') return content;
		if (!Array.isArray(content)) return '';
		let result = '';
		for (const block of content) {
			if (block && typeof block === 'object' && 'type' in block && block.type === 'text') {
				result += block.text ?? '';
			}
		}
		return result;
	}

	/** 复制文本（对齐原生 /tree getEntryCopyText：纯正文，不含 ID） */
	function getEntryCopyText(node: TreeNode): string | undefined {
		const entry = node.raw as any;
		const msg = entry?.message;
		let text: string | undefined;
		switch (node.type) {
			case 'message': {
				if (msg?.role === 'bashExecution') {
					text = msg.command;
				} else if (msg && 'content' in msg) {
					text = extractFullContent(msg.content);
					if (!text && msg.role === 'assistant') {
						text = msg.errorMessage;
					}
				}
				break;
			}
			case 'custom_message':
				text = extractFullContent(entry?.content);
				break;
			case 'compaction':
			case 'branch_summary':
				text = entry?.summary;
				break;
		}
		return typeof text === 'string' && text.trim() ? text : undefined;
	}

	// ── Flat list builder ──────────────────────────────

	interface FlatItem {
		node: TreeNode;
		indent: number;
		showConnector: boolean;
		isLast: boolean;
		gutters: { position: number; show: boolean }[];
		isVirtualRootChild: boolean;
	}

	interface StackItem {
		node: TreeNode;
		indent: number;
		justBranched: boolean;
		showConnector: boolean;
		isLast: boolean;
		gutters: { position: number; show: boolean }[];
		isVirtualRootChild: boolean;
	}

	/** 构建活跃路径节点集（从根到当前 leaf，对齐原生 /tree buildActivePath） */
	function buildActivePath(): Set<string> {
		const result = new Set<string>();
		if (!currentLeafId) return result;
		const byId = new Map<string, TreeNode>();
		(function collect(nodes: TreeNode[]) {
			for (const n of nodes) {
				byId.set(n.id, n);
				collect(n.children);
			}
		})(getRoots());
		let id: string | null = currentLeafId;
		while (id) {
			result.add(id);
			id = byId.get(id)?.parentId ?? null;
		}
		return result;
	}

	/**
	 * 对齐原生 /tree flattenTree：
	 * ① 单子链平级、分叉才缩进（childIndent 规则）
	 * ② 活跃分支优先排序
	 * ③ 计算 gutter 竖线 + connector（└─/├─）结构
	 */
	function flattenTree(): FlatItem[] {
		const result: FlatItem[] = [];
		const roots = getRoots();
		if (roots.length === 0) return result;

		// 活跃路径 + toolCall 映射（渲染与搜索过滤共用）
		activePathIds = buildActivePath();
		buildToolCallMap();

		// containsActive：后序判断每个子树是否包含活跃叶子（排序用）
		const leafId = currentLeafId;
		const containsActive = new Map<TreeNode, boolean>();
		{
			const allNodes: TreeNode[] = [];
			const stack: TreeNode[] = [...roots];
			while (stack.length > 0) {
				const node = stack.pop()!;
				allNodes.push(node);
				for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
			}
			for (let i = allNodes.length - 1; i >= 0; i--) {
				const node = allNodes[i];
				let has = leafId !== null && node.id === leafId;
				for (const child of node.children) {
					if (containsActive.get(child)) has = true;
				}
				containsActive.set(node, has);
			}
		}

		// ① 过滤：完整树 DFS（活跃分支优先 + 折叠），得到可见节点列表。
		// 同时构建完整树 id → node 映射（② 步 findVisibleAncestor 用）。
		const idToNode = new Map<string, TreeNode>();
		(function collect(nodes: TreeNode[]) {
			for (const n of nodes) {
				idToNode.set(n.id, n);
				collect(n.children);
			}
		})(roots);
		const visibleNodes: TreeNode[] = [];
		{
			const orderedRoots = [...roots].sort(
				(a, b) =>
					Number(containsActive.get(b) ?? false) - Number(containsActive.get(a) ?? false),
			);
			const stack: TreeNode[] = [];
			for (let i = orderedRoots.length - 1; i >= 0; i--) stack.push(orderedRoots[i]);
			while (stack.length > 0) {
				const node = stack.pop()!;
				if (shouldShow(node)) visibleNodes.push(node);
				// 折叠节点的后代不遍历（折叠节点自身已 push，可再展开）
				if (collapsedBranches.has(node.id)) continue;
				const orderedChildren = [...node.children].sort(
					(a, b) =>
						Number(containsActive.get(b) ?? false) -
						Number(containsActive.get(a) ?? false),
				);
				for (let i = orderedChildren.length - 1; i >= 0; i--)
					stack.push(orderedChildren[i]);
			}
		}
		if (visibleNodes.length === 0) return result;

		// ② 重算视觉结构：基于「可见树」而非完整树（对齐原生 /tree recalculateVisualStructure）。
		// 被 filter 隐藏的中间节点不产生分叉缩进——后代挂到最近可见祖先，
		// 避免隐藏的 custom 等分叉把可见主链越推越深（「分叉没有尽头」）。
		const visibleIds = new Set(visibleNodes.map((n) => n.id));
		const findVisibleAncestor = (nodeId: string): string | null => {
			let currentId = idToNode.get(nodeId)?.parentId ?? null;
			while (currentId !== null) {
				if (visibleIds.has(currentId)) return currentId;
				currentId = idToNode.get(currentId)?.parentId ?? null;
			}
			return null;
		};
		const visibleChildren = new Map<string | null, string[]>();
		visibleChildren.set(null, []);
		for (const node of visibleNodes) {
			const ancestorId = findVisibleAncestor(node.id);
			if (!visibleChildren.has(ancestorId)) visibleChildren.set(ancestorId, []);
			visibleChildren.get(ancestorId)!.push(node.id);
		}
		const visibleRootIds = visibleChildren.get(null)!;
		multipleRoots = visibleRootIds.length > 1;

		const nodeById = new Map(visibleNodes.map((n) => [n.id, n]));
		const stack: StackItem[] = [];
		for (let i = visibleRootIds.length - 1; i >= 0; i--) {
			const isLast = i === visibleRootIds.length - 1;
			stack.push({
				node: nodeById.get(visibleRootIds[i])!,
				indent: multipleRoots ? 1 : 0,
				justBranched: multipleRoots,
				showConnector: multipleRoots,
				isLast,
				gutters: [],
				isVirtualRootChild: multipleRoots,
			});
		}

		while (stack.length > 0) {
			const {
				node,
				indent,
				justBranched,
				showConnector,
				isLast,
				gutters,
				isVirtualRootChild,
			} = stack.pop()!;
			result.push({ node, indent, showConnector, isLast, gutters, isVirtualRootChild });

			// 可见子节点数决定是否分叉（隐藏节点不计入）
			const children = visibleChildren.get(node.id) || [];
			const multipleChildren = children.length > 1;

			// childIndent：分叉 +1；分叉后第一代再 +1；单子链平级
			let childIndent: number;
			if (multipleChildren) childIndent = indent + 1;
			else if (justBranched && indent > 0) childIndent = indent + 1;
			else childIndent = indent;

			// gutter：有 connector 时，在该层级加竖线（非最后兄弟则 show）
			const connectorDisplayed = showConnector && !isVirtualRootChild;
			const currentDisplayIndent = multipleRoots ? Math.max(0, indent - 1) : indent;
			const connectorPosition = Math.max(0, currentDisplayIndent - 1);
			const childGutters = connectorDisplayed
				? [...gutters, { position: connectorPosition, show: !isLast }]
				: gutters;

			for (let i = children.length - 1; i >= 0; i--) {
				const childIsLast = i === children.length - 1;
				stack.push({
					node: nodeById.get(children[i])!,
					indent: childIndent,
					justBranched: multipleChildren,
					showConnector: multipleChildren,
					isLast: childIsLast,
					gutters: childGutters,
					isVirtualRootChild: false,
				});
			}
		}
		return result;
	}

	/**
	 * filter 切换后保留光标：原节点可见则保留，否则沿祖先链上溯到最近可见祖先，
	 * 兜底落到最后一个可见节点（对齐原生 /tree findNearestVisibleIndex）。
	 * 需在 filterMode 已更新后调用。
	 */
	function preserveCursorOnFilterChange(): void {
		const flat = flattenTree();
		if (flat.length === 0) {
			cursorLine = 0;
			return;
		}
		const idToIndex = new Map<string, number>();
		flat.forEach((item, i) => idToIndex.set(item.node.id, i));
		const idToNode = new Map<string, TreeNode>();
		(function collect(nodes: TreeNode[]) {
			for (const n of nodes) {
				idToNode.set(n.id, n);
				collect(n.children);
			}
		})(getRoots());
		let currentId = lastSelectedId;
		while (currentId) {
			const idx = idToIndex.get(currentId);
			if (idx !== undefined) {
				cursorLine = idx;
				return;
			}
			const node = idToNode.get(currentId);
			if (!node) break;
			currentId = node.parentId ?? null;
		}
		cursorLine = flat.length - 1;
	}

	// ── Tree rendering ─────────────────────────────────

	function renderTree() {
		currentFlat = flattenTree();
		const flat = currentFlat;
		if (flat.length === 0) {
			container.addChild(new Text(dim('  无匹配节点'), 0, 0));
			return;
		}
		// range 模式/单标记提示多 2 行，动态收缩页面防止溢出视口
		const effectivePageSize = Math.max(
			5,
			pageSize - (rangeActive || selectedNodes.length === 1 ? 2 : 0),
		);

		// When searching, paginate by matched entries（flat 已双重过滤）
		if (searchQuery) {
			const visible = flat;
			const maxScroll = Math.max(0, visible.length - effectivePageSize);
			scrollOffset = Math.max(0, Math.min(scrollOffset, maxScroll));
			// 当前选中节点在 visible 中的位置，用于滚动对齐
			const cursorPos = searchCursorId
				? visible.findIndex((item) => item.node.id === searchCursorId)
				: -1;
			if (cursorPos >= 0) {
				if (cursorPos < scrollOffset) scrollOffset = cursorPos;
				if (cursorPos >= scrollOffset + effectivePageSize)
					scrollOffset = cursorPos - effectivePageSize + 1;
			}

			const page = visible.slice(scrollOffset, scrollOffset + effectivePageSize);
			for (let i = 0; i < page.length; i++) {
				const item = page[i];
				renderNode(item, item.node.id === searchCursorId);
			}

			const pageInfo = `(${scrollOffset + 1}-${Math.min(scrollOffset + effectivePageSize, visible.length)}/${visible.length} 匹配)`;
			container.addChild(new Text(dim(`  ${pageInfo}`), 0, 0));
			return;
		}

		// Normal pagination
		cursorLine = Math.max(0, Math.min(cursorLine, flat.length - 1));

		// 选中行居中（参考原生 /tree 的 startIndex = selectedIndex - floor(maxVisibleLines/2)）
		const maxOffset = Math.max(0, flat.length - effectivePageSize);
		scrollOffset = Math.max(
			0,
			Math.min(cursorLine - Math.floor(effectivePageSize / 2), maxOffset),
		);

		const page = flat.slice(scrollOffset, scrollOffset + effectivePageSize);

		for (let i = 0; i < page.length; i++) {
			const item = page[i];
			renderNode(item, scrollOffset + i === cursorLine);
		}

		// Page indicator
		const pageInfo = `(${scrollOffset + 1}-${Math.min(scrollOffset + effectivePageSize, flat.length)}/${flat.length})`;
		container.addChild(new Text(dim(`  ${pageInfo}`), 0, 0));
	}

	function renderNode(item: FlatItem, isCursor: boolean) {
		const node = item.node;

		// ① 树形 prefix：竖线 gutter + connector（└─/├─，可折叠时 ─→-/+）
		const displayIndent = multipleRoots ? Math.max(0, item.indent - 1) : item.indent;
		const connector =
			item.showConnector && !item.isVirtualRootChild ? (item.isLast ? '└─ ' : '├─ ') : '';
		const connectorPosition = connector ? displayIndent - 1 : -1;
		const isFolded = collapsedBranches.has(node.id);
		const totalChars = displayIndent * 3;
		const prefixChars: string[] = [];
		for (let i = 0; i < totalChars; i++) {
			const level = Math.floor(i / 3);
			const posInLevel = i % 3;
			const gutter = item.gutters.find((g) => g.position === level);
			if (gutter) {
				prefixChars.push(posInLevel === 0 ? (gutter.show ? '│' : ' ') : ' ');
			} else if (connector && level === connectorPosition) {
				if (posInLevel === 0) prefixChars.push(item.isLast ? '└' : '├');
				else if (posInLevel === 1) {
					const foldable = node.children.length > 0;
					prefixChars.push(isFolded ? '+' : foldable ? '-' : '─');
				} else prefixChars.push(' ');
			} else {
				prefixChars.push(' ');
			}
		}
		const prefix = prefixChars.join('');

		// ② fold marker（无 connector 的折叠根节点，+ 前缀）
		const showsFoldInConnector = item.showConnector && !item.isVirtualRootChild;
		const foldMarker = isFolded && !showsFoldInConnector ? theme.fg('accent', '+ ') : '';

		// ③ active path 标记（活跃分支节点 •，没走到的分支没有）
		const pathMarker = activePathIds.has(node.id) ? theme.fg('accent', '• ') : '';

		// ④ 光标/范围 gutter（保留现有：端点 ● / 中间 │ / 光标 >）
		const isSelected = selectedNodes.includes(node.id);
		const inRangeMid = rangeActive && rangeFrom && rangeTo && isInRange(node) && !isSelected;

		let gutter: string;
		if (isSelected) {
			gutter = theme.fg('accent', '●') + (isCursor ? '>' : ' ');
		} else if (inRangeMid) {
			gutter = theme.fg('accent', '│') + (isCursor ? '>' : ' ');
		} else {
			gutter = isCursor ? '> ' : '  ';
		}

		// ⑤ Tags（前置，tag 后加空格与节点内容区分）
		const tags = getTags(node);
		const tagStr = tags.length > 0 ? tags.map((t) => tagColor(t)(t)).join(' ') + ' ' : '';

		const prefixPart = dim(prefix) + foldMarker + pathMarker;
		let line = gutter + prefixPart + tagStr + displayText(node);

		if (isCursor) line = bold(line);
		line = truncateToWidth(line, panelWidth);

		container.addChild(new Text(line, 0, 0));
	}

	function isInRange(node: TreeNode): boolean {
		if (!rangeFrom || !rangeTo) return false;
		// DFS 全序判定（与 analyze/rangeNodes 一致，顺序无关）
		return tree.rangeNodes(rangeFrom.id, rangeTo.id).some((n) => n.id === node.id);
	}

	/** 展开目标节点的所有折叠祖先（用于跳转到被折叠分支内的节点） */
	function revealNode(nodeId: string): void {
		const path: string[] = [];
		(function walk(nodes: TreeNode[]): boolean {
			for (const n of nodes) {
				if (n.id === nodeId) {
					for (const pid of path) collapsedBranches.delete(pid);
					return true;
				}
				path.push(n.id);
				if (walk(n.children)) return true;
				path.pop();
			}
			return false;
		})(getRoots());
	}

	// ── Jump bar ────────────────────────────────────────

	function renderJumpBar() {
		if (activeSearch) {
			const prompt = '  搜索: ';
			const input = searchQuery + '█';
			container.addChild(new Text(accent(prompt) + input, 0, 0));
			if (!searchQuery) {
				const searchHint =
					dim('输入子串关键词筛选，') +
					hint('up/down', '导航') +
					dim('，') +
					hint('escape', '取消');
				container.addChild(new Text('    ' + searchHint, 0, 0));
			}
			return;
		}
		if (!jumpActive) {
			const help = [
				hint('g', '跳转'),
				hint('m', '标记'),
				hint('shift+l', '标签'),
				hint('ctrl+d/t/u/l/a', '过滤'),
			].join('  ·  ');
			container.addChild(new Text('  ' + help, 0, 0));
			return;
		}
		const prompt = '  跳转: ';
		const input = jumpInput + (jumpActive ? '█' : '');
		container.addChild(new Text(accent(prompt) + input, 0, 0));
		container.addChild(
			new Text(
				truncateToWidth(
					dim(
						'    @=会话当前节点 @~N=基于当前向N节点 @^^type=祖先 +N/-N=光标向前/后 ..=范围 前缀=ID',
					),
					panelWidth,
				),
				0,
				0,
			),
		);
	}

	// ── Range footer ────────────────────────────────────

	function renderRangeFooter() {
		if (!rangeActive) {
			// 单标记状态：提示再按一次 m 完成范围选择
			if (selectedNodes.length === 1) {
				container.addChild(new Spacer(1));
				const singleHint =
					dim('(再按一次 ') + hint('m', '标记范围另一端') + dim(' → 自动开始分析)');
				container.addChild(new Text('  ' + singleHint, 0, 0));
			}
			return;
		}
		container.addChild(new Spacer(1));
		const report = tree.analyze(rangeFrom!.id, rangeTo!.id);

		// 工具按使用次数降序；明细最多展示前 4 个，其余折叠为 +N（超宽由 truncateToWidth 兜底）
		const toolEntries = Object.entries(report.toolCalls).sort((a, b) => b[1] - a[1]);
		const toolTotal = toolEntries.reduce((s, [, c]) => s + c, 0);
		let toolDetail = '';
		if (toolEntries.length > 0) {
			const MAX_TOOLS = 4;
			const shown = toolEntries
				.slice(0, MAX_TOOLS)
				.map(([name, count]) => `${name}:${count}`);
			if (toolEntries.length > MAX_TOOLS) shown.push(`+${toolEntries.length - MAX_TOOLS}`);
			toolDetail = `(${shown.join('|')})`;
		}

		const parts = [
			`范围: ${report.segmentCount} 条`,
			`用户: ${report.userQuestions.length} 条`,
			`AGENT: ${report.agentMessages} 条`,
			`工具: ${toolTotal} 次${toolDetail}`,
		];
		if (report.compactions.length > 0) parts.push(`压缩: ${report.compactions.length} 次`);
		if (report.branchPoints.length > 0) parts.push(`分支: ${report.branchPoints.length} 个`);

		container.addChild(
			new Text(
				truncateToWidth('  ' + accent('INFO: ') + parts.join(' · '), panelWidth),
				0,
				0,
			),
		);
	}

	// ── Header ──────────────────────────────────────────

	function renderHeader() {
		const title = accent(bold('  会话树'));
		const toasts: string[] = [];
		if (filterMode !== 'default') toasts.push(`${filterMode}`);
		if (copyToast) toasts.push(accent('已复制'));
		if (revealToast) toasts.push(accent('目标被筛选隐藏，已切全部视图'));

		const status = toasts.length > 0 ? '  ' + toasts.map((t) => dim('· ') + t).join(' ') : '';
		const headerText = title + '  ' + dim(sessionId.slice(0, 8)) + status;
		// 第 0 行是全文件唯一未走 truncateToWidth 的行，且本次新增更长的 revealToast，窄终端可能超宽 → 统一兜底
		container.addChild(new Text(truncateToWidth(headerText, panelWidth), 0, 0));
	}

	// ── Footer ──────────────────────────────────────────

	function renderFooter() {
		let items: string[];
		if (jumpActive) {
			items = [hint('enter', '跳转'), hint('escape', '取消')];
		} else if (activeSearch) {
			items = [hint('enter/escape', '退出'), hint('backspace', '删除')];
		} else if (rangeActive) {
			items = [
				hint('m', '重新标记'),
				hint('up/down', '移动'),
				hint('ctrl+x', '复制'),
				hint('escape', '关闭范围'),
			];
		} else {
			items = [
				hint('up/down', '移动'),
				hint('left/right', '翻页'),
				hint('alt+left/right', '折叠'),
				hint('/', '搜索'),
				hint('ctrl+x', '复制'),
				dim('Esc'),
			];
		}
		// 节点 ID 前置（当前所选节点，g 跳转前缀=ID 用；放开头避免被 truncate 截断）
		// 搜索模式下光标由 searchCursorId 定位，而非 cursorLine（后者仍是进入搜索前的旧索引）；
		// 非搜索模式复用 currentFlat（renderTree 已计算），避免二次 flatten。
		const nodeId =
			activeSearch && searchQuery
				? (searchCursorId ?? undefined)
				: currentFlat[cursorLine]?.node?.id;
		const nodeIdText = nodeId ? dim('ID ') + accent(nodeId) + ' · ' : '';
		// 筛选/搜索视图下，光标所见节点 ≠ @~ 所选节点（@~ 仍以叶子为基准），提示割裂
		let viewHint = '';
		if (activeSearch && searchQuery) {
			viewHint = dim('搜索视图(光标≠@~所选)') + ' · ';
		} else if (filterMode !== 'default') {
			viewHint = dim('筛选视图(光标≠@~所选)') + ' · ';
		}
		container.addChild(
			new Text(truncateToWidth(nodeIdText + viewHint + items.join(' · '), panelWidth), 0, 0),
		);
	}

	// ── Render ──────────────────────────────────────────

	function rebuild() {
		container.clear();
		renderHeader();
		container.addChild(new Spacer(1));
		if (tagMode) {
			renderTagPanel();
			renderTagFooter();
			return;
		}
		if (activeSearch) {
			renderJumpBar(); // Show search input bar
			container.addChild(new Spacer(1));
			renderTree();
			renderRangeFooter();
			container.addChild(new Spacer(1));
			renderFooter();
			return;
		}
		renderJumpBar();
		container.addChild(new Spacer(1));
		renderTree();
		renderRangeFooter();
		container.addChild(new Spacer(1));
		renderFooter();
	}

	// ── Tag panel ─────────────────────────────────────────

	function renderTagPanel() {
		const lines: string[] = [];

		// Type field
		const typeLabel = TYPE_OPTIONS[tagTypeIndex];
		const typeActive = tagFieldFocus === 0;
		lines.push(
			`  ${typeActive ? '>' : ' '}类型: [${typeLabel}]${typeActive ? ' ' + hint('left/right', '切换') : ''}`,
		);

		// Match field
		const matchActive = tagFieldFocus === 1;
		lines.push(
			`  ${matchActive ? '>' : ' '}匹配: [${tagMatchText}█]${matchActive ? '' : ' (可选)'}`,
		);

		// Label field
		const labelActive = tagFieldFocus === 2;
		lines.push(`  ${labelActive ? '>' : ' '}打标: [${tagLabelText}█]`);

		lines.push('  ' + hint('enter', '添加规则'));
		lines.push('');
		container.addChild(new Text(lines.join('\n'), 0, 0));

		// Preview (if match text or type filter is active)
		if (tagMatchText || tagTypeIndex !== 0) {
			const total = countFieldMatches(tagEntries, tagTypeIndex, tagMatchText);
			if (total > 0) {
				const previewEntries = previewFieldMatches(tagEntries, tagTypeIndex, tagMatchText);
				const previewLines: string[] = [];
				if (total > previewEntries.length) {
					previewLines.push(
						dim(`  共匹配 ${total} 条，显示 ${previewEntries.length} 条如下:`),
					);
				} else {
					previewLines.push(dim(`  共匹配 ${total} 条:`));
				}
				for (const e of previewEntries) {
					previewLines.push('    ' + dim(entryLabel(e).slice(0, 60)));
				}
				container.addChild(new Spacer(1));
				container.addChild(new Text(previewLines.join('\n'), 0, 0));
			}
		}

		// Active rules
		if (tagRules.length > 0) {
			const ruleLines: string[] = [];
			ruleLines.push(dim('  活跃规则:'));
			for (let i = 0; i < tagRules.length; i++) {
				const r = tagRules[i];
				const source = r.source === 'config' ? accent('[配置]') : dim('[会话]');
				const delKey = r.source === 'session' ? dim(` [${i + 1}]`) : '';
				ruleLines.push(`    ${formatFieldRule(r)} ${source}${delKey}`);
			}
			container.addChild(new Spacer(1));
			container.addChild(new Text(ruleLines.join('\n'), 0, 0));
		}

		// Tag summary
		if (tagRules.length > 0) {
			const labelMap = new Map<string, string[]>();
			for (const entry of tagEntries) {
				const labels: string[] = [];
				for (const rule of tagRules) {
					if (matchesRule(rule, entry)) labels.push(rule.label);
				}
				if (labels.length > 0) labelMap.set(entry.id, labels);
			}
			const counts = new Map<string, number>();
			for (const labels of labelMap.values()) {
				for (const l of labels) {
					counts.set(l, (counts.get(l) ?? 0) + 1);
				}
			}
			const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
			if (sorted.length > 0) {
				const summary = sorted.map(([l, c]) => dim(`${l}(${c})`)).join(' ');
				container.addChild(new Spacer(1));
				container.addChild(new Text(dim('  标签: ') + summary, 0, 0));
			}
		}
	}

	function renderTagFooter() {
		container.addChild(new Spacer(1));
		const help = [
			hint('up/down', '切换字段'),
			dim('[数字] 删规则'),
			hint('escape', '返回'),
		].join('  |  ');
		container.addChild(new Text('  ' + help, 0, 0));
	}

	function rescanLabels() {
		// Recompute labels for ALL entries, clearing labels on non-matching ones.
		// 与 tag summary 保持一致用 matchesRule：config 规则走 TagRule 语义，
		// 否则面板交互（增删 session 规则）会用子串语义重算而清掉 config 规则打的标签。
		for (const entry of tagEntries) {
			const labels: string[] = [];
			for (const rule of tagRules) {
				if (matchesRule(rule, entry)) {
					labels.push(rule.label);
				}
			}
			tree.setLabels(entry.id, labels);
		}
	}

	function entryLabel(e: MatchableEntry): string {
		if (e.type === 'compaction')
			return `[Compaction: ${Math.round((e.tokensBefore ?? 0) / 1000)}k]`;
		if (e.type === 'message') {
			const role = e.message?.role;
			const content =
				typeof e.message?.content === 'string' ? e.message.content.slice(0, 40) : '';
			if (role === 'user') return `user: ${content}`;
			if (role === 'assistant') return `assistant: ${content}`;
			if (role === 'toolResult') return `[${e.message?.toolName ?? 'tool'}] ${content}`;
		}
		return `${e.type}: ${(e as any).id?.slice(0, 8) ?? ''}`;
	}

	// ── Input handling ──────────────────────────────────

	function handleInput(data: string) {
		copyToast = false;
		revealToast = false;

		const key = parseKey(data) ?? data;

		// Esc — exit search/jump/range/tag mode or close panel.
		// 搜索模式下 Esc 交给搜索块处理（恢复进入搜索前的光标位置）。
		if ((key === 'escape' || data === '\x1b') && !activeSearch) {
			if (tagMode) {
				tagMode = false;
				rebuild();
				tui.requestRender();
				return;
			}
			if (jumpActive) {
				jumpActive = false;
				jumpInput = '';
				rebuild();
				tui.requestRender();
				return;
			}
			if (rangeActive) {
				rangeActive = false;
				rebuild();
				tui.requestRender();
				return;
			}
			done();
			return;
		}

		// Jump mode — collect input (use decoded key, not raw data: Kitty 协议下
		// 普通字符会以 CSI-u 多字节序列到达，data.length !== 1，必须用 parseKey 结果)
		if (jumpActive) {
			if (key === 'enter' || key === 'tab' || data === '\r' || data === '\t') {
				// Enter/Tab — execute jump
				const flat = flattenTree();
				const cursorNode = flat[cursorLine]?.node;
				const result = tree.resolve(jumpInput, { from: cursorNode?.id });
				if (result) {
					if ('from' in result) {
						// Range
						rangeActive = true;
						rangeFrom = result.from;
						rangeTo = result.to;
					} else {
						// Single node — find it in the flat list
						let flat = flattenTree();
						let idx = flat.findIndex((f) => f.node.id === result.id);
						if (idx < 0) {
							// 目标被折叠或过滤隐藏：先展开折叠祖先；仍不可见则切 all 过滤揭示
							revealNode(result.id);
							flat = flattenTree();
							idx = flat.findIndex((f) => f.node.id === result.id);
							if (idx < 0 && filterMode !== 'all') {
								filterMode = 'all';
								revealToast = true;
								flat = flattenTree();
								idx = flat.findIndex((f) => f.node.id === result.id);
							}
						}
						if (idx >= 0) cursorLine = idx;
						// Also start range if a mark is active
						if (rangeActive && rangeFrom && !rangeTo) {
							rangeTo = result;
						}
					}
				}
				jumpActive = false;
				jumpInput = '';
				rebuild();
				tui.requestRender();
				return;
			}
			if (key === 'backspace' || data === '\x7f' || data === '\b') {
				jumpInput = jumpInput.slice(0, -1);
			} else if (key.length === 1 && key >= ' ') {
				jumpInput += key;
			}
			rebuild();
			tui.requestRender();
			return;
		}

		// Tag mode — multi-field input
		if (tagMode) {
			if (key === 'enter' || data === '\r') {
				if (tagLabelText) {
					tagRules.push({
						typeIndex: tagTypeIndex,
						matchText: tagMatchText,
						label: tagLabelText,
						source: 'session',
					});
					tagLabelText = '';
					tagMatchText = '';
					tagTypeIndex = 0;
					rescanLabels();
				}
				rebuild();
				tui.requestRender();
				return;
			}
			if (key === 'backspace' || data === '\x7f' || data === '\b') {
				if (tagFieldFocus === 1) tagMatchText = tagMatchText.slice(0, -1);
				else if (tagFieldFocus === 2) tagLabelText = tagLabelText.slice(0, -1);
			} else if (key === 'up' || data === '\x1b[A') {
				tagFieldFocus = Math.max(0, tagFieldFocus - 1);
			} else if (key === 'down' || data === '\x1b[B') {
				tagFieldFocus = Math.min(2, tagFieldFocus + 1);
			} else if (tagFieldFocus === 0 && (key === 'left' || data === '\x1b[D')) {
				tagTypeIndex = (tagTypeIndex - 1 + TYPE_OPTIONS.length) % TYPE_OPTIONS.length;
			} else if (tagFieldFocus === 0 && (key === 'right' || data === '\x1b[C')) {
				tagTypeIndex = (tagTypeIndex + 1) % TYPE_OPTIONS.length;
			} else if (data >= '1' && data <= '9') {
				const n = parseInt(data, 10) - 1;
				const sessionRules: { idx: number }[] = [];
				for (let i = 0; i < tagRules.length; i++) {
					if (tagRules[i].source === 'session') sessionRules.push({ idx: i });
				}
				if (n < sessionRules.length) {
					tagRules.splice(sessionRules[n].idx, 1);
					rescanLabels();
				}
			} else if ((tagFieldFocus === 1 || tagFieldFocus === 2) && data.length >= 1) {
				// Text input for match OR label field: accept all non-control chars
				const ch = key.length === 1 ? key : data;
				if (tagFieldFocus === 1) tagMatchText += ch;
				else tagLabelText += ch;
			}
			rebuild();
			tui.requestRender();
			return;
		}

		// Search mode — collect search query (before normal mode to intercept c/u/a/t)
		if (activeSearch) {
			if (key === 'escape' || data === '\x1b') {
				// Esc — 退出搜索并退回进入搜索前所指节点
				activeSearch = false;
				searchQuery = '';
				cursorLine = searchEntryCursor;
			} else if (key === 'enter' || data === '\r') {
				// Enter — 确认当前选中节点，退出搜索（光标停留该节点）
				activeSearch = false;
				searchQuery = '';
				if (searchCursorId) {
					const flat2 = flattenTree();
					const idx = flat2.findIndex((f) => f.node.id === searchCursorId);
					if (idx >= 0) cursorLine = idx;
				}
			} else if (key === 'up' || data === '\x1b[A' || data === 'ArrowUp') {
				const visible = flattenTree();
				if (visible.length > 0) {
					const pos = searchCursorId
						? visible.findIndex((item) => item.node.id === searchCursorId)
						: -1;
					const base = pos >= 0 ? pos : 0;
					searchCursorId = visible[(base - 1 + visible.length) % visible.length].node.id;
				}
			} else if (key === 'down' || data === '\x1b[B' || data === 'ArrowDown') {
				const visible = flattenTree();
				if (visible.length > 0) {
					const pos = searchCursorId
						? visible.findIndex((item) => item.node.id === searchCursorId)
						: -1;
					const base = pos >= 0 ? pos : -1;
					searchCursorId = visible[(base + 1) % visible.length].node.id;
				}
			} else if (key === 'backspace' || data === '\x7f' || data === '\b') {
				searchQuery = searchQuery.slice(0, -1);
				searchCursorId = null;
			} else if (key.length === 1 || (data.length >= 1 && !data.startsWith('\x1b'))) {
				// Accept single-char (key) or multi-byte (e.g. CJK), but NOT escape sequences
				const text = key.length === 1 ? key : data;
				searchQuery += text;
				// 定位到第一个匹配项
				const visible = flattenTree();
				searchCursorId = visible.length > 0 ? visible[0].node.id : null;
			}
			rebuild();
			tui.requestRender();
			return;
		}

		// Normal mode
		const flat = flattenTree();

		if (
			key === 'down' ||
			data === '\x1b[B' ||
			data === 'ArrowDown' ||
			kb.matches(data, 'tui.editor.cursorDown')
		) {
			if (flat.length > 0) cursorLine = (cursorLine + 1) % flat.length;
		} else if (
			key === 'up' ||
			data === '\x1b[A' ||
			data === 'ArrowUp' ||
			kb.matches(data, 'tui.editor.cursorUp')
		) {
			if (flat.length > 0) cursorLine = (cursorLine - 1 + flat.length) % flat.length;
		} else if (
			key === 'right' ||
			data === '\x1b[C' ||
			data === 'ArrowRight' ||
			kb.matches(data, 'tui.editor.cursorRight')
		) {
			if (flat.length > 0) {
				scrollOffset = Math.min(
					scrollOffset + pageSize,
					Math.max(0, flat.length - pageSize),
				);
				cursorLine = Math.min(cursorLine + pageSize, flat.length - 1);
			}
		} else if (
			key === 'left' ||
			data === '\x1b[D' ||
			data === 'ArrowLeft' ||
			kb.matches(data, 'tui.editor.cursorLeft')
		) {
			if (flat.length > 0) {
				scrollOffset = Math.max(scrollOffset - pageSize, 0);
				cursorLine = Math.max(cursorLine - pageSize, 0);
			}
		} else if (
			key === 'alt+left' ||
			key === 'alt+right' ||
			data === '\x1b\x1b[D' ||
			data === '\x1b\x1b[C' ||
			kb.matches(data, 'app.tree.foldOrUp' as any)
		) {
			const node = flat[cursorLine]?.node;
			if (node && node.children.length > 0) {
				if (collapsedBranches.has(node.id)) collapsedBranches.delete(node.id);
				else collapsedBranches.add(node.id);
			}
		} else if (
			key === 'ctrl+d' ||
			data === '\x04' ||
			kb.matches(data, 'app.tree.filter.default' as any)
		) {
			// Direct filter: default（对齐原生 /tree）
			lastSelectedId = flat[cursorLine]?.node?.id ?? null;
			filterMode = 'default';
			preserveCursorOnFilterChange();
		} else if (
			key === 'ctrl+t' ||
			data === '\x14' ||
			key === 'c' ||
			data === 'c' ||
			data === 'C' ||
			kb.matches(data, 'app.tree.filter.noTools' as any)
		) {
			// no-tools ↔ default（ctrl+t 对齐原生，c 单键兼容）
			lastSelectedId = flat[cursorLine]?.node?.id ?? null;
			filterMode = filterMode === 'no-tools' ? 'default' : 'no-tools';
			preserveCursorOnFilterChange();
		} else if (
			key === 'ctrl+u' ||
			data === '\x15' ||
			key === 'u' ||
			data === 'u' ||
			data === 'U' ||
			kb.matches(data, 'app.tree.filter.userOnly' as any)
		) {
			// user-only ↔ default（ctrl+u 对齐原生，u 单键兼容）
			lastSelectedId = flat[cursorLine]?.node?.id ?? null;
			filterMode = filterMode === 'user-only' ? 'default' : 'user-only';
			preserveCursorOnFilterChange();
		} else if (
			key === 'ctrl+l' ||
			data === '\x0c' ||
			kb.matches(data, 'app.tree.filter.labeledOnly' as any)
		) {
			// labeled-only ↔ default（对齐原生 /tree）
			lastSelectedId = flat[cursorLine]?.node?.id ?? null;
			filterMode = filterMode === 'labeled-only' ? 'default' : 'labeled-only';
			preserveCursorOnFilterChange();
		} else if (
			key === 'ctrl+a' ||
			data === '\x01' ||
			key === 'a' ||
			data === 'a' ||
			data === 'A' ||
			kb.matches(data, 'app.tree.filter.all' as any)
		) {
			// all ↔ default（ctrl+a 对齐原生，a 单键兼容）
			lastSelectedId = flat[cursorLine]?.node?.id ?? null;
			filterMode = filterMode === 'all' ? 'default' : 'all';
			preserveCursorOnFilterChange();
		} else if (
			key === 'ctrl+o' ||
			data === '\x0f' ||
			key === 't' ||
			data === 't' ||
			data === 'T' ||
			kb.matches(data, 'app.tree.filter.cycleForward' as any)
		) {
			// cycle forward（ctrl+o 对齐原生，t 单键兼容）
			const idx = FILTER_MODES.indexOf(filterMode);
			lastSelectedId = flat[cursorLine]?.node?.id ?? null;
			filterMode = FILTER_MODES[(idx + 1) % FILTER_MODES.length];
			preserveCursorOnFilterChange();
		} else if (key === '/') {
			activeSearch = true;
			searchQuery = '';
			searchEntryCursor = cursorLine;
			searchCursorId = null;
		} else if (key === 'g') {
			jumpActive = true;
			jumpInput = '';
		} else if (key === 'shift+l' || data === 'L') {
			// 标签打标面板（ctrl+l 已让位给 labeled-only 过滤，对齐原生 shift+l=label 语义）
			tagMode = !tagMode;
			tagFieldFocus = 0;
			tagTypeIndex = 0;
			tagMatchText = '';
			tagLabelText = '';
			if (tagMode) {
				const rawEntries = tree.getAllEntries();
				tagEntries = rawEntries;
				// Reload config rules, keep session rules
				const configRules = tree.getTagRules().map((r) => ({
					typeIndex: TYPE_OPTIONS.indexOf(r.on as any),
					matchText: r.match
						? Object.entries(r.match)
								.map(([k, v]) => `${k}=${v}`)
								.join(' ')
						: '',
					label: r.label,
					source: 'config' as const,
					tagRule: r,
				}));
				const sessionRules = tagRules.filter((r) => r.source === 'session');
				tagRules = [...configRules, ...sessionRules];
			}
		} else if (key === 'm') {
			const node = flat[cursorLine]?.node;
			if (node) {
				if (rangeActive) {
					// 范围分析中按 m：退出范围，重新开始标记
					rangeActive = false;
					rangeFrom = null;
					rangeTo = null;
					selectedNodes = [node.id];
				} else if (selectedNodes.length === 0) {
					selectedNodes = [node.id];
				} else if (selectedNodes.length === 1) {
					// 第二下 m：自动进入范围分析（无需再按 ~）
					selectedNodes.push(node.id);
					const n0 = flat.find((f) => f.node.id === selectedNodes[0])?.node;
					const n1 = flat.find((f) => f.node.id === selectedNodes[1])?.node;
					if (n0 && n1) {
						rangeActive = true;
						rangeFrom = n0;
						rangeTo = n1;
					}
				}
			}
		} else if (key === 'ctrl+x' || data === '\x18') {
			// ctrl+x 复制正文（对齐原生 /tree getEntryCopyText：纯正文，不含 ID）
			const node = flat[cursorLine]?.node;
			if (node) {
				const text = getEntryCopyText(node);
				if (text) copyToClipboard(text);
			}
			copyToast = true;
		}

		rebuild();
		tui.requestRender();
	}

	// Input handled via Pi's handleInput mechanism
	const c = container as any;
	c.handleInput = handleInput;
	// 初始光标定位到叶子（对齐原生 /tree：initialSelectedId ?? current leaf）
	const initialFlat = flattenTree();
	const leafIdx = currentLeafId ? initialFlat.findIndex((f) => f.node.id === currentLeafId) : -1;
	cursorLine = leafIdx >= 0 ? leafIdx : 0;
	rebuild();
	return c;
}

export function openPanel(ctx: ExtensionCommandContext, tree: SessionTreeAPI, sessionId: string) {
	return ctx.ui.custom<void>((tui, theme, kb, done) =>
		createPanel(tui, theme, kb, done, tree, sessionId),
	);
}
