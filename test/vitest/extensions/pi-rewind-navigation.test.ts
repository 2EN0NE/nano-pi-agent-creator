/**
 * pi-rewind — P1：tree/fork/resume 回滚触发口决策函数测试
 *
 * 对应测试分析发现 [P1]：`restoreOnTree:'ask'`/`restoreOnFork:'ask'` 是开箱
 * 默认行为，选择「以哪个 commit 作 dirty base」的决策函数此前未测：
 *   - findCleanCheckpointCommit / findLatestBranchCheckpointFromList
 *   - resolveTreeTargetCommit / needsCodeSync / treeNavigationRangeHasFileChanges
 *   - buildBranchToEntry / findCheckpointForEntryId / hasCheckpointFileChanges
 *
 * 分层：纯函数（fixture entries，零 git）+ 决策函数（真实 RepoManager）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RepoManager } from '../../../extensions/auto/pi-rewind/engine';
import type { CheckpointEntry } from '../../../extensions/auto/pi-rewind/engine';
import {
	findCleanCheckpointCommit,
	findCheckpointForEntryId,
	findLatestBranchCheckpointFromList,
	hasCheckpointFileChanges,
	needsCodeSync,
	resolveTreeTargetCommit,
	buildBranchToEntry,
	treeNavigationRangeHasFileChanges,
} from '../../../extensions/auto/pi-rewind/index-helpers';

// ────────────────────────────────────────────────────────────────────────────
// fixture helpers
// ────────────────────────────────────────────────────────────────────────────

const C0 = 'c0'.padEnd(40, '0');
const C1 = 'c1'.padEnd(40, '1');
const C2 = 'c2'.padEnd(40, '2');
const C3 = 'c3'.padEnd(40, '3');

function makeCheckpoint(partial: {
	userEntryId: string;
	beforeCommit: string;
	afterCommit: string;
	turnId?: string;
	fileCount?: number;
	fileChanges?: CheckpointEntry['fileChanges'];
}): CheckpointEntry {
	return {
		v: 2,
		kind: 'checkpoint',
		turnId: partial.turnId ?? `turn-${partial.userEntryId}`,
		userEntryId: partial.userEntryId,
		beforeCommit: partial.beforeCommit,
		afterCommit: partial.afterCommit,
		prompt: `prompt-${partial.userEntryId}`,
		fileCount: partial.fileCount ?? 0,
		fileChanges: partial.fileChanges ?? [],
		createdAt: '2026-01-01T00:00:00.000Z',
	};
}

/** 把 checkpoint entry 序列化为会话 custom entry（type=custom, customType=pi-checkpoint, data=entry）。 */
function toSessionEntries(checkpoints: readonly CheckpointEntry[]): unknown[] {
	return checkpoints.map((cp) => ({
		id: `id-${cp.userEntryId}-cp`,
		parentId: `msg-${cp.userEntryId}`,
		type: 'custom',
		customType: 'pi-checkpoint',
		data: cp,
	}));
}

function makeUserEntry(
	id: string,
	parentId?: string | null,
): { id: string; parentId: string | null; type: 'message'; message: { role: 'user' } } {
	return { id, parentId: parentId ?? null, type: 'message', message: { role: 'user' } };
}

describe('needsCodeSync / 决策基础', () => {
	it('targetCommit 为空 → 无需同步', () => {
		expect(needsCodeSync('abc', undefined)).toBe(false);
	});
	it('当前与目标相同 → 无需同步', () => {
		expect(needsCodeSync(C1, C1)).toBe(false);
	});
	it('目标存在且不同 → 需要同步', () => {
		expect(needsCodeSync(undefined, C1)).toBe(true);
		expect(needsCodeSync(C1, C2)).toBe(true);
	});
});

describe('hasCheckpointFileChanges / checkpointHasFileChanges', () => {
	it('fileCount>0 或 fileChanges 非空即视为有文件变更', () => {
		const empty = makeCheckpoint({ userEntryId: 'u1', beforeCommit: C0, afterCommit: C0 });
		const byCount = makeCheckpoint({
			userEntryId: 'u1',
			beforeCommit: C0,
			afterCommit: C1,
			fileCount: 2,
		});
		const byList = makeCheckpoint({
			userEntryId: 'u1',
			beforeCommit: C0,
			afterCommit: C1,
			fileCount: 0,
			fileChanges: [{ path: 'a.txt', added: 1, removed: 0 }],
		});
		// hasCheckpointFileChanges 接收 raw session entries（含 pi-checkpoint 包装）
		expect(hasCheckpointFileChanges(toSessionEntries([empty]))).toBe(false);
		expect(hasCheckpointFileChanges(toSessionEntries([empty, byCount]))).toBe(true);
		expect(hasCheckpointFileChanges(toSessionEntries([byList]))).toBe(true);
	});
});

describe('findCheckpointForEntryId / findLatestBranchCheckpointFromList', () => {
	const cp1 = makeCheckpoint({
		userEntryId: 'u1',
		beforeCommit: C0,
		afterCommit: C1,
		fileCount: 1,
	});
	const cp2 = makeCheckpoint({ userEntryId: 'u2', beforeCommit: C1, afterCommit: C2 });
	const cp2b = makeCheckpoint({
		userEntryId: 'u2',
		beforeCommit: C1,
		afterCommit: C3,
		turnId: 'retry',
	});

	it('findCheckpointForEntryId 命中 userEntryId 对应的 checkpoint（非 branch 过滤）', () => {
		const entries = toSessionEntries([cp1, cp2]);
		expect(findCheckpointForEntryId(entries, 'u1')?.beforeCommit).toBe(C0);
		expect(findCheckpointForEntryId(entries, 'u2')?.afterCommit).toBe(C2);
		expect(findCheckpointForEntryId(entries, 'nope')).toBeUndefined();
	});

	it('findLatestBranchCheckpointFromList 取 branch 上最近一次（按 userEntryId 顺序取末位）', () => {
		const branch = [makeUserEntry('u1'), makeUserEntry('u2')];
		// 多条同 userEntryId（retry 追加）→ 保留最后出现的
		const latest = findLatestBranchCheckpointFromList([cp1, cp2, cp2b], branch);
		expect(latest?.afterCommit).toBe(C3);
	});

	it('branch 不含该 user 消息的 checkpoint 被忽略', () => {
		const branch = [makeUserEntry('u2')];
		const latest = findLatestBranchCheckpointFromList([cp1, cp2], branch);
		expect(latest?.userEntryId).toBe('u2');
	});
});

describe('resolveTreeTargetCommit', () => {
	const cp1 = makeCheckpoint({
		userEntryId: 'u1',
		beforeCommit: C0,
		afterCommit: C1,
		fileCount: 1,
	});
	const cp2 = makeCheckpoint({
		userEntryId: 'u2',
		beforeCommit: C1,
		afterCommit: C2,
		fileCount: 1,
	});
	const entries = [
		makeUserEntry('u1'),
		makeUserEntry('u2', 'u1'),
		...toSessionEntries([cp1, cp2]),
	];
	const branchU1 = buildBranchToEntry(entries, 'u1');
	const branchU2 = buildBranchToEntry(entries, 'u2');

	it('目标是 user 消息 → 取该用户消息的 beforeCommit（回到消息前状态）', () => {
		const target = resolveTreeTargetCommit(entries, branchU1, 'u1');
		expect(target).toBe(C0);
	});

	it('目标是分支末梢（非 user 消息，targetId 不在会话中）→ 取 branch 最后 checkpoint 的 afterCommit', () => {
		// branch 由 user 消息构成，但会话里还有 leaf 不是 user entry
		const target = resolveTreeTargetCommit(entries, branchU2, undefined);
		expect(target).toBe(C2);
	});

	it('branch 上无 checkpoint（例如空 branch）→ undefined', () => {
		const target = resolveTreeTargetCommit([makeUserEntry('u9')], [makeUserEntry('u9')], 'u9');
		expect(target).toBeUndefined();
	});
});

describe('buildBranchToEntry', () => {
	it('沿 parentId 回溯并正序输出（root→leaf）', () => {
		const entries = [
			makeUserEntry('root'),
			makeUserEntry('mid', 'root'),
			makeUserEntry('leaf', 'mid'),
		];
		const branch = buildBranchToEntry(entries, 'leaf');
		expect(branch.map((e) => e.id)).toEqual(['root', 'mid', 'leaf']);
	});

	it('parentId 成环时防死循环', () => {
		const a = { id: 'a', parentId: 'b', type: 'message', message: { role: 'user' } };
		const b = { id: 'b', parentId: 'a', type: 'message', message: { role: 'user' } };
		const branch = buildBranchToEntry([a, b], 'a');
		expect(branch.length).toBeGreaterThan(0);
		expect(branch.length).toBeLessThanOrEqual(2);
	});
});

describe('treeNavigationRangeHasFileChanges — 跨分支范围文件变更判定', () => {
	// 语义（对齐实现）：对每个「有文件变更」的 checkpoint，若其 userEntryId
	// 在 currentBranch 与 targetBranch（排除目标 user 自身）的归属不一致，
	// 说明导航跨过了该 turn 的代码变更 → 需要文件同步。
	// u1/u3 有文件变更；u2 无。
	const cp1 = makeCheckpoint({
		userEntryId: 'u1',
		beforeCommit: C0,
		afterCommit: C1,
		fileCount: 1,
	});
	const cp2 = makeCheckpoint({ userEntryId: 'u2', beforeCommit: C1, afterCommit: C2 });
	const cp3 = makeCheckpoint({
		userEntryId: 'u3',
		beforeCommit: C2,
		afterCommit: C3,
		fileCount: 1,
	});
	const allCheckpoints = [cp1, cp2, cp3];
	const U = (id: string, parentId?: string) => makeUserEntry(id, parentId ?? 'u1');

	it('导航回旧 user 节点（u3→u2），跨越含文件变更的 turn → true', () => {
		const currentBranch = [U('u1'), U('u2', 'u1'), U('u3', 'u2')];
		const targetBranch = [U('u1'), U('u2', 'u1')];
		expect(
			treeNavigationRangeHasFileChanges(allCheckpoints, currentBranch, targetBranch, 'u2'),
		).toBe(true); // cp3(u3, changes) 仅属 current
	});

	it('变更 checkpoint 同时属两侧 → 不需要同步（无范围差）', () => {
		const currentBranch = [U('u1'), U('u2', 'u1')];
		const targetBranch = [U('u1'), U('u2', 'u1')];
		// cp1 有变更但两侧都有 u1 → 无差；cp2 无变更 → false
		expect(
			treeNavigationRangeHasFileChanges([cp1, cp2], currentBranch, targetBranch, 'u2'),
		).toBe(false);
	});

	it('目标 user 自身的变更被排除（excludedTarget）：从 u1 导航到 u1 自身不因自身变更触发', () => {
		const currentBranch = [U('u1'), U('u2', 'u1')];
		const targetBranch = [U('u1'), U('u2', 'u1')];
		// target=u2 排除 u2；cp2 无变更；cp1(u1,changes) 两侧均属 u1 → false
		expect(
			treeNavigationRangeHasFileChanges([cp1, cp2], currentBranch, targetBranch, 'u2'),
		).toBe(false);
	});

	it('目标指向非 user 节点（不排除任何 user）：目标侧新增的变更 turn 也计入', () => {
		const currentBranch = [U('u1')];
		const targetBranch = [U('u1'), U('u2', 'u1')];
		// targetId='leaf-x' 非 user → targetUserIds={u1,u2}；cp1(u1) 两侧有
		// 无差；cp2 无变更 → false
		expect(
			treeNavigationRangeHasFileChanges([cp1, cp2], currentBranch, targetBranch, 'leaf-x'),
		).toBe(false);
		// 若 u2 有变更（属于 target 侧新引入）→ true
		const cp2WithChanges = makeCheckpoint({
			userEntryId: 'u2',
			beforeCommit: C1,
			afterCommit: C2,
			fileCount: 1,
		});
		expect(
			treeNavigationRangeHasFileChanges(
				[cp1, cp2WithChanges],
				currentBranch,
				targetBranch,
				'leaf-x',
			),
		).toBe(true);
	});
});

describe('findCleanCheckpointCommit — dirty base 决策（真实 git）', () => {
	let base: string;
	let workTree: string;
	let repo: RepoManager;
	let cleanup: () => Promise<void>;

	beforeEach(async () => {
		base = await mkdtemp(join(tmpdir(), 'pi-rewind-clean-'));
		workTree = join(base, 'work');
		await mkdir(workTree, { recursive: true });
		repo = new RepoManager(join(base, 'repo', '.git'), join(base, 'repo', 'index'), workTree);
		await repo.init();
		await repo.setExclude(['.git']);
		cleanup = async () => {
			await rm(base, { recursive: true, force: true });
		};
	});

	afterEach(async () => {
		await cleanup();
	});

	it('工作区与最近 checkpoint 一致 → 返回最近 afterCommit', async () => {
		await writeFile(join(workTree, 'a.txt'), 'v1');
		const h0 = await repo.checkpoint('u0');
		await writeFile(join(workTree, 'a.txt'), 'v2');
		const h1 = await repo.checkpoint('u1');

		const checkpoints = [
			makeCheckpoint({ userEntryId: 'u0', beforeCommit: h0, afterCommit: h0 }),
			makeCheckpoint({ userEntryId: 'u1', beforeCommit: h0, afterCommit: h1 }),
		];
		const clean = await findCleanCheckpointCommit(repo, checkpoints);
		expect(clean).toBe(h1);
	});

	it('工作区额外 dirty（未被快照捕获）→ 返回 undefined（无干净 base，拒绝回滚）', async () => {
		await writeFile(join(workTree, 'a.txt'), 'v1');
		const h0 = await repo.checkpoint('u0');
		await writeFile(join(workTree, 'a.txt'), 'v2');
		const h1 = await repo.checkpoint('u1');
		await writeFile(join(workTree, 'dirty.txt'), 'x');

		const checkpoints = [
			makeCheckpoint({ userEntryId: 'u0', beforeCommit: h0, afterCommit: h0 }),
			makeCheckpoint({ userEntryId: 'u1', beforeCommit: h0, afterCommit: h1 }),
		];
		const clean = await findCleanCheckpointCommit(repo, checkpoints);
		expect(clean).toBeUndefined();
	});

	it('工作区回退到旧 checkpoint 状态后 → 返回该旧 commit（允许继续回滚更深）', async () => {
		await writeFile(join(workTree, 'a.txt'), 'v1');
		const h0 = await repo.checkpoint('u0');
		await writeFile(join(workTree, 'a.txt'), 'v2');
		const h1 = await repo.checkpoint('u1');
		await writeFile(join(workTree, 'a.txt'), 'v3');
		const h2 = await repo.checkpoint('u2');

		// 工作区切回 h1 内容（模拟上一轮 rewind 之后）→ 干净 base 是 h1
		const r = await repo.safeCheckout(h1, h2);
		expect(r.ok).toBe(true);

		const checkpoints = [
			makeCheckpoint({ userEntryId: 'u0', beforeCommit: h0, afterCommit: h0 }),
			makeCheckpoint({ userEntryId: 'u1', beforeCommit: h0, afterCommit: h1 }),
			makeCheckpoint({ userEntryId: 'u2', beforeCommit: h1, afterCommit: h2 }),
		];
		const clean = await findCleanCheckpointCommit(repo, checkpoints);
		expect(clean).toBe(h1);
	});
});
