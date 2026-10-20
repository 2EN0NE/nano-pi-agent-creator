/**
 * 任务重试（ADR-0053 `D5`）
 *
 * 语义（与代码事实对齐）：参与者状态机受保护且**没有**"回到已派发"的迁移，中断只停当前轮，
 * 参与者与任务的归属都没变——所以**重试 = 把任务重新投递一遍**（附上次说明），
 * 不改任务编号、不动账本状态；走既有投递通道（不在岗则落 inbox，任务不丢）。
 *
 * 该拒绝的情形必须**据实拒绝并给出路**：任务已关闭（铁终态）→ 新开并引用；
 * 已交付 → 走「打回」；已叫停/取消 → 走「改派」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parkOrgRoot } from '../setup/org-root.js';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { ensureAwakeForDispatch } = vi.hoisted(() => ({
	ensureAwakeForDispatch: vi.fn(async () => false),
}));
vi.mock('../../../extensions/auto/org/lifecycle.js', () => ({ ensureAwakeForDispatch }));

import { dispatchTask, retrySubTask } from '../../../extensions/auto/org/dispatch.js';
import { ackInbox, peekInbox } from '../../../extensions/auto/org/inbox.js';
import { createOrg, joinOrg } from '../../../extensions/auto/org/orgstore.js';
import { readTask, saveTask, transitionAssignee } from '../../../extensions/auto/org/task.js';
import type { AgentManifest } from '../../../extensions/auto/org/types.js';

// 测试探针：取并清空 inbox（生产路径走 planInboxFlush/commitInboxFlush）
const takeInbox = async (org: string, agent: string): Promise<string[]> => {
	const records = await peekInbox(org, agent);
	await ackInbox(
		org,
		agent,
		records.map((r) => r.id),
	);
	return records.map((r) => r.message);
};

const ORG = 'dev-team';
let tmpRoot: string;

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), 'org-retry-'));
	process.env.ORG_ROOT = tmpRoot;
	for (const d of ['chief', 'worker-a']) mkdirSync(join(tmpRoot, d), { recursive: true });
});

afterEach(() => {
	parkOrgRoot();
	rmSync(tmpRoot, { recursive: true, force: true });
});

const workerManifest: AgentManifest = { name: 'worker-a', role: 'member' };

async function setup() {
	await createOrg(ORG, { name: 'chief', dir: join(tmpRoot, 'chief') });
	await joinOrg(ORG, { manifest: workerManifest, dir: join(tmpRoot, 'worker-a') });
	const res = await dispatchTask({
		org: ORG,
		dispatcher: 'chief',
		dispatcherRole: 'chief',
		title: 'T',
		background: 'bg',
		items: ['i1'],
		targets: [{ agent: 'worker-a', description: 'd' }],
	});
	const task = (await readTask(ORG, res.task.id))!;
	const sub = task.subTasks[0];
	return { taskId: task.id, subId: sub.id };
}

describe('retrySubTask', () => {
	it('非终态：重新投递（落 inbox 兜底）+ 账本记 retried，状态不变', async () => {
		const { taskId, subId } = await setup();
		const before = (await readTask(ORG, taskId))!;
		const statusBefore = before.subTasks[0].assignees[0].status;

		const res = await retrySubTask(ORG, taskId, subId, 'worker-a', {
			by: 'chief',
			note: '上次被中断',
		});
		expect(res.ok).toBe(true);
		expect(res.message).toContain('已重试');

		const after = (await readTask(ORG, taskId))!;
		// 状态机未被违反：参与者状态保持不变（重试不改账本状态）
		expect(after.subTasks[0].assignees[0].status).toBe(statusBefore);
		expect(after.history.some((h) => h.event === 'retried')).toBe(true);
		expect(after.history.find((h) => h.event === 'retried')?.note).toContain('上次被中断');

		// 投递内容含任务正文与"重试说明"，且走 inbox（成员不在岗）
		const inbox = await takeInbox(ORG, 'worker-a');
		expect(inbox.join('\n')).toContain(taskId);
		expect(inbox.join('\n')).toContain('重试说明：上次被中断');
	});

	it('任务已关闭（铁终态）→ 拒绝，并指向"新开任务并引用"', async () => {
		const { taskId, subId } = await setup();
		const task = (await readTask(ORG, taskId))!;
		// 直接置铁终态（真实路径由验收/取消产生；这里只需一个已关闭的任务）
		task.status = 'closed';
		await saveTask(task);

		const res = await retrySubTask(ORG, taskId, subId, 'worker-a', { by: 'chief' });
		expect(res.ok).toBe(false);
		expect(res.message).toContain('铁终态');
		expect(res.message).toContain('新开任务');
	});

	it('参与者已交付 → 拒绝，并指向「打回」', async () => {
		const { taskId, subId } = await setup();
		const task = (await readTask(ORG, taskId))!;
		const a = task.subTasks[0].assignees[0];
		transitionAssignee(a, 'claimed', 'worker-a');
		transitionAssignee(a, 'delivered', 'worker-a');
		await saveTask(task);

		const res = await retrySubTask(ORG, taskId, subId, 'worker-a', { by: 'chief' });
		expect(res.ok).toBe(false);
		expect(res.message).toContain('打回');
	});

	it('参与者已被叫停 → 拒绝，并指向「改派」', async () => {
		const { taskId, subId } = await setup();
		const task = (await readTask(ORG, taskId))!;
		task.subTasks[0].assignees[0].stopped = true;
		await saveTask(task);

		const res = await retrySubTask(ORG, taskId, subId, 'worker-a', { by: 'chief' });
		expect(res.ok).toBe(false);
		expect(res.message).toContain('改派');
	});

	it('任务 / 子任务 / 参与者不存在 → 各自据实拒绝', async () => {
		const { taskId, subId } = await setup();
		expect(
			(await retrySubTask(ORG, 'M-nope', subId, 'worker-a', { by: 'chief' })).message,
		).toContain('不存在');
		expect(
			(await retrySubTask(ORG, taskId, 'S-nope', 'worker-a', { by: 'chief' })).message,
		).toContain('不存在');
		expect(
			(await retrySubTask(ORG, taskId, subId, 'nobody', { by: 'chief' })).message,
		).toContain('没有参与者');
	});

	it('重试事实不新增账本字段（无 attempts 之类）', async () => {
		const { taskId, subId } = await setup();
		await retrySubTask(ORG, taskId, subId, 'worker-a', { by: 'chief' });
		const task = (await readTask(ORG, taskId))!;
		expect(Object.keys(task.subTasks[0].assignees[0])).not.toContain('attempts');
		expect(Object.keys(task.subTasks[0].assignees[0])).not.toContain('retries');
	});
});
