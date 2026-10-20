/**
 * pi-rewind — ADR-0039 抑制协调层行为测试
 *
 * 对应测试分析发现 [P2]（用例缺口）：`__piRewind` 桥此前只有方法名/调用形态
 * 的 source-scan 契约测试（pi-rewind-bridge.test.ts），而 `TreeRestoreCoordinator`
 * / `RewindSessionRuntimeState` 的**行为语义**零覆盖——
 *
 * ADR-0039 承诺（documents/adr/0039）：review 导航期间 suppress，
 * 该次导航（ask 提示 + always 自动恢复）都被跳过、抑制只消费一次不跨导航
 * 泄漏、review finally clear 防泄漏。语义若错：
 *   - 抑制泄漏 → 用户后续 tree 导航被静默跳过文件回滚（丢回滚能力）
 *   - 消费失败 → review 开审查分支仍弹「同步文件?」/ 改写工作区
 *
 * 覆盖（纯状态类，无 pi / 无真实 git）：
 *   1. suppress → 一次性消费（含清 pending / 不跨 sessionId）
 *   2. 抑制时 startTreeNavigation 短路（不产生 conversation pending）
 *   3. planTreeCodeRestore：always 自动计划 code pending / ask 确认或拒绝 /
 *      never 清 pending / 无文件变更时不动
 *   4. resetSession（resume/startup=true vs fork=false）的 synced commit 语义
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
	RewindSessionRuntimeState,
	TreeRestoreCoordinator,
} from '../../../extensions/auto/pi-rewind/session-runtime-state';
import type { CheckpointEntry } from '../../../extensions/auto/pi-rewind/engine';
import {
	DEFAULT_REWIND_CONFIG,
	type TreeRestoreMode,
} from '../../../extensions/auto/pi-rewind/config';
import type { TreeEntryRecord } from '../../../extensions/auto/pi-rewind/utils/tree-entry';

// ────────────────────────────────────────────────────────────────────────────
// fixture helpers（与 pi-rewind-navigation.test.ts 同款：wrapped custom entry）
// ────────────────────────────────────────────────────────────────────────────

const C0 = 'c0'.padEnd(40, '0');
const C1 = 'c1'.padEnd(40, '1');
const C2 = 'c2'.padEnd(40, '2');

function makeUserEntry(
	id: string,
	parentId: string | null = null,
): { id: string; parentId: string | null; type: 'message'; message: { role: 'user' } } {
	return { id, parentId, type: 'message', message: { role: 'user' } };
}

function makeCheckpoint(partial: {
	userEntryId: string;
	beforeCommit: string;
	afterCommit: string;
	turnId?: string;
	fileCount?: number;
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
		fileChanges: [],
		createdAt: '2026-01-01T00:00:00.000Z',
	};
}

function wrapCheckpoint(cp: CheckpointEntry): unknown {
	return {
		id: `id-${cp.userEntryId}-cp`,
		parentId: `msg-${cp.userEntryId}`,
		type: 'custom',
		customType: 'pi-checkpoint',
		data: cp,
	};
}

// 两条 user 消息：u1 的 turn 有文件变更（cp1），u2 的 turn 无变更（cp2）。
const u1 = makeUserEntry('u1');
const u2 = makeUserEntry('u2', 'u1');
const cp1 = makeCheckpoint({
	userEntryId: 'u1',
	beforeCommit: C0,
	afterCommit: C1,
	fileCount: 1,
});
const cp2 = makeCheckpoint({ userEntryId: 'u2', beforeCommit: C1, afterCommit: C2 });
const ENTRIES = [u1, u2, wrapCheckpoint(cp1), wrapCheckpoint(cp2)];
const BRANCH_U1_U2: readonly TreeEntryRecord[] = [u1, u2];

const SID = 'session-1';

function fakeUi(selectImpl?: () => Promise<string>): ExtensionContext['ui'] {
	return {
		select: vi.fn(selectImpl ?? (async () => '是')),
	} as unknown as ExtensionContext['ui'];
}

function setTreeMode(runtime: RewindSessionRuntimeState, mode: TreeRestoreMode): void {
	runtime.sessionConfigs.set(SID, { ...DEFAULT_REWIND_CONFIG, restoreOnTree: mode });
}

// ────────────────────────────────────────────────────────────────────────────
// TreeRestoreCoordinator：suppress / clear / consume 原语
// ────────────────────────────────────────────────────────────────────────────

describe('TreeRestoreCoordinator — 抑制一次性消费语义', () => {
	let coordinator: TreeRestoreCoordinator;

	beforeEach(() => {
		coordinator = new TreeRestoreCoordinator();
	});

	it('suppress → 首次 consumeSuppressedTree 为 true 且清 pending；再次消费为 false（不泄漏）', () => {
		coordinator.setConversationPending(SID, 'u1');
		coordinator.suppress(SID);
		expect(coordinator.isSuppressed(SID)).toBe(true);

		// 抑制消费会连 pending 一起丢弃（被抑制的导航不做 conversation restore 之外的处理）
		expect(coordinator.consumeSuppressedTree(SID)).toBe(true);
		expect(coordinator.consumePending(SID)).toBeUndefined();
		expect(coordinator.isSuppressed(SID)).toBe(false);
		expect(coordinator.consumeSuppressedTree(SID)).toBe(false);
	});

	it('clearSuppression 提前解除 → 后续导航不被跳过', () => {
		coordinator.suppress(SID);
		coordinator.clearSuppression(SID);
		expect(coordinator.consumeSuppressedTree(SID)).toBe(false);
	});

	it('按 sessionId 隔离：一个会话的抑制不影响另一个', () => {
		coordinator.suppress('session-a');
		expect(coordinator.isSuppressed('session-b')).toBe(false);
		expect(coordinator.consumeSuppressedTree('session-b')).toBe(false);
		expect(coordinator.consumeSuppressedTree('session-a')).toBe(true);
	});

	it('code pending 携带 notifier，可被消费一次', () => {
		const ui = fakeUi();
		coordinator.setCodePending(
			SID,
			{ targetId: 'u1', mode: 'Restore code and conversation', targetCommit: C0 },
			ui,
		);
		expect(coordinator.consumePending(SID)).toEqual({
			targetId: 'u1',
			mode: 'Restore code and conversation',
			targetCommit: C0,
		});
		// notifier 独立于 intent 消费；第二次回退到调用方传入的 currentUi/sessionUi
		expect(coordinator.consumeNotifier(SID, undefined, undefined)).toBe(ui);
		expect(coordinator.consumeNotifier(SID, 'current-ui' as never, undefined)).toBe(
			'current-ui',
		);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// RewindSessionRuntimeState：导航计划与抑制短路
// ────────────────────────────────────────────────────────────────────────────

describe('RewindSessionRuntimeState — startTreeNavigation / planTreeCodeRestore', () => {
	let runtime: RewindSessionRuntimeState;

	beforeEach(() => {
		runtime = new RewindSessionRuntimeState();
	});

	it('未抑制：startTreeNavigation 置 conversation pending；抑制：短路且不产生 pending', () => {
		expect(runtime.startTreeNavigation(SID, 'u1')).toBe(true);
		expect(runtime.treeRestores.consumePending(SID)).toEqual({
			targetId: 'u1',
			mode: 'Restore conversation',
		});

		runtime.treeRestores.suppress(SID);
		expect(runtime.startTreeNavigation(SID, 'u1')).toBe(false);
		expect(runtime.treeRestores.consumePending(SID)).toBeUndefined();
	});

	it('always 模式：跨含文件变更 turn 且需要同步 → 自动计划 code+conversation restore', async () => {
		setTreeMode(runtime, 'always');
		await runtime.planTreeCodeRestore({
			sessionId: SID,
			targetId: 'u1',
			entries: ENTRIES,
			currentBranch: BRANCH_U1_U2,
			hasUI: true,
			ui: fakeUi(),
		});
		const intent = runtime.treeRestores.consumePending(SID);
		expect(intent).toEqual({
			targetId: 'u1',
			mode: 'Restore code and conversation',
			targetCommit: C0,
		});
	});

	it('always 模式但本会话无文件变更 → 不计划 code restore（不打扰）', async () => {
		setTreeMode(runtime, 'always');
		const noChangeEntries = [
			makeUserEntry('u1'),
			wrapCheckpoint(
				makeCheckpoint({ userEntryId: 'u1', beforeCommit: C0, afterCommit: C1 }),
			),
		];
		await runtime.planTreeCodeRestore({
			sessionId: SID,
			targetId: 'u1',
			entries: noChangeEntries,
			currentBranch: [makeUserEntry('u1')],
			hasUI: true,
			ui: fakeUi(),
		});
		expect(runtime.treeRestores.consumePending(SID)).toBeUndefined();
	});

	it('ask 模式：用户确认「是」→ code pending；拒绝 → 保留 conversation pending', async () => {
		setTreeMode(runtime, 'ask');
		const declineUi = fakeUi(async () => '否');
		await runtime.planTreeCodeRestore({
			sessionId: SID,
			targetId: 'u1',
			entries: ENTRIES,
			currentBranch: BRANCH_U1_U2,
			hasUI: true,
			ui: declineUi,
		});
		expect(declineUi.select).toHaveBeenCalledWith('同步文件？', ['是', '否']);
		// 拒绝 → 无 code intent（会话树仍按 conversation-only 导航）
		expect(runtime.treeRestores.consumePending(SID)).toBeUndefined();

		setTreeMode(runtime, 'ask');
		runtime.startTreeNavigation(SID, 'u1');
		const acceptUi = fakeUi(async () => '是');
		await runtime.planTreeCodeRestore({
			sessionId: SID,
			targetId: 'u1',
			entries: ENTRIES,
			currentBranch: BRANCH_U1_U2,
			hasUI: true,
			ui: acceptUi,
		});
		expect(runtime.treeRestores.consumePending(SID)?.mode).toBe(
			'Restore code and conversation',
		);
	});

	it('ask 模式无 UI（print/headless）→ 不弹选择不计划', async () => {
		setTreeMode(runtime, 'ask');
		await runtime.planTreeCodeRestore({
			sessionId: SID,
			targetId: 'u1',
			entries: ENTRIES,
			currentBranch: BRANCH_U1_U2,
			hasUI: false,
			ui: undefined,
		});
		expect(runtime.treeRestores.consumePending(SID)).toBeUndefined();
	});

	it('never 模式 → 清掉 pending，不做任何计划', async () => {
		setTreeMode(runtime, 'never');
		runtime.startTreeNavigation(SID, 'u1'); // 先留下 conversation pending
		await runtime.planTreeCodeRestore({
			sessionId: SID,
			targetId: 'u1',
			entries: ENTRIES,
			currentBranch: BRANCH_U1_U2,
			hasUI: true,
			ui: fakeUi(),
		});
		expect(runtime.treeRestores.consumePending(SID)).toBeUndefined();
	});
});

describe('RewindSessionRuntimeState — resetSession', () => {
	let runtime: RewindSessionRuntimeState;

	beforeEach(() => {
		runtime = new RewindSessionRuntimeState();
	});

	it('resume/startup（initialize=true）→ 记录分支 synced commit；同时清抑制与旧状态', () => {
		runtime.treeRestores.suppress(SID);
		runtime.treeRestores.setConversationPending(SID, 'u1');
		runtime.sessionSyncedCodeCommits.set(SID, 'stale-commit');

		runtime.resetSession(SID, ENTRIES, BRANCH_U1_U2, true);

		expect(runtime.treeRestores.isSuppressed(SID)).toBe(false);
		expect(runtime.treeRestores.consumePending(SID)).toBeUndefined();
		expect(runtime.sessionHasCheckpointFileChanges.getOrUndefined(SID)).toBe(true);
		expect(runtime.sessionCheckpointEntries.getOrUndefined(SID)?.length).toBe(2);
		// 分支末 checkpoint 的 afterCommit 作为「当前代码已同步到」的基线
		expect(runtime.sessionSyncedCodeCommits.getOrUndefined(SID)).toBe(C2);
	});

	it('fork（initialize=false）→ 不预置 synced commit（待 fork 恢复后再写）', () => {
		runtime.resetSession(SID, ENTRIES, BRANCH_U1_U2, false);
		expect(runtime.sessionSyncedCodeCommits.getOrUndefined(SID)).toBeUndefined();
	});

	it('无 checkpoint 的会话：initialize=true 也不设置 synced commit', () => {
		runtime.resetSession(SID, [makeUserEntry('u1')], [makeUserEntry('u1')], true);
		expect(runtime.sessionSyncedCodeCommits.getOrUndefined(SID)).toBeUndefined();
		expect(runtime.sessionHasCheckpointFileChanges.getOrUndefined(SID)).toBe(false);
	});
});
