/**
 * @zenone/pi-session-tree — deep tree regression tests
 *
 * 长会话会产生数千层深的会话树（实测最大 depth 达 4400+）。
 * wrapNode/collectNodes/findPath 若用递归遍历会触发
 * "Maximum call stack size exceeded"（见 wrapNode 栈溢出报错）。
 *
 * 本测试用 20000 层深树验证遍历已改为迭代实现，不再栈溢出。
 */
import { describe, it, expect } from 'vitest';
import { createSessionTree } from '../../../extensions/meta/pi-session-tree/index.js';

/** 迭代构建 N 层线性 SessionTreeNode 链（不能用递归 helper，否则 helper 自身先溢出） */
function buildDeepTree(entryCount: number): any[] {
	const nodes: any[] = [];
	for (let i = 0; i < entryCount; i++) {
		nodes.push({
			entry: {
				id: `n${i}`,
				parentId: i === 0 ? null : `n${i - 1}`,
				type: 'message',
				timestamp: `t${i}`,
				message: { role: i % 2 === 0 ? 'user' : 'assistant', content: 'x' },
			},
			children: [],
			label: undefined,
		});
	}
	for (let i = 1; i < entryCount; i++) {
		nodes[i - 1].children.push(nodes[i]);
	}
	return [nodes[0]];
}

function deepSessionManager(entryCount: number) {
	const roots = buildDeepTree(entryCount);
	return {
		getTree: () => roots,
		getLeafId: () => `n${entryCount - 1}`,
		getCwd: () => '/fake/cwd',
		getSessionId: () => 'deep-tree-session',
		getSessionDir: () => '/fake/sessions',
		getSessionFile: () => '/fake/sessions/deep.jsonl',
		getEntry: (id: string) => undefined,
		getLabel: () => undefined,
		getBranch: () => [],
		buildContextEntries: () => [],
		getHeader: () => null,
		getEntries: () => [],
		getLeafEntry: () => undefined,
		getSessionName: () => undefined,
	};
}

const DEPTH = 20000;

describe('deep session tree (no stack overflow)', () => {
	it('wrapNode + findPath 遍历 20000 层不溢出，pathToLeaf 返回完整路径', () => {
		const tree = createSessionTree(deepSessionManager(DEPTH) as any);
		const path = tree.pathToLeaf();
		expect(path).toHaveLength(DEPTH);
		expect(path[0].id).toBe('n0');
		expect(path[0].depth).toBe(0);
		expect(path[DEPTH - 1].id).toBe(`n${DEPTH - 1}`);
		expect(path[DEPTH - 1].depth).toBe(DEPTH - 1);
	});

	it('collectNodes 遍历 20000 层不溢出（branchCount/maxDepth/findByType）', () => {
		const tree = createSessionTree(deepSessionManager(DEPTH) as any);
		expect(tree.branchCount()).toBe(0);
		expect(tree.maxDepth()).toBe(DEPTH - 1);
		expect(tree.findByType('message')).toHaveLength(DEPTH);
	});

	it('detectDiverge / findAncestor 在深树上不溢出且结果正确', () => {
		const tree = createSessionTree(deepSessionManager(DEPTH) as any);
		// leaf 仍在根节点祖先链上 → 不回退
		expect(tree.detectDiverge('n0')).toBe(false);
		expect(tree.detectDiverge(`n${DEPTH - 1}`)).toBe(false);
		// 祖先查找（从 leaf 走到根，路径长度 20000）
		const ancestor = tree.findAncestor(`n${DEPTH - 1}`, 'message');
		expect(ancestor).toBeDefined();
		expect(ancestor!.id).toBe(`n${DEPTH - 2}`);
	});
});
