/**
 * 显式抢占（ADR-0055 `D6`）：两级语义与据实回报
 *
 * L1 插话（默认）：用 steer 投递、**不中断**；L2 硬抢占：先 abort 再投递，
 * 且失败时**不假装成功**（消息仍投递，避免"既没停、话也没送到"）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parkOrgRoot } from '../setup/org-root.js';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DeliveryOutcome = 'online' | 'uncertain' | 'inbox' | 'unreachable';
type InterruptOutcome = { ok: boolean; entries: unknown[]; reason?: string };
const { deliverMessage, interruptMember } = vi.hoisted(() => ({
	deliverMessage: vi.fn(async (): Promise<DeliveryOutcome> => 'online'),
	interruptMember: vi.fn(async (): Promise<InterruptOutcome> => ({ ok: true, entries: [] })),
}));
vi.mock('../../../extensions/auto/org/dispatch.js', async (orig) => ({
	...(await orig<typeof import('../../../extensions/auto/org/dispatch.js')>()),
	deliverMessage,
}));
vi.mock('../../../extensions/auto/org/activity.js', async (orig) => ({
	...(await orig<typeof import('../../../extensions/auto/org/activity.js')>()),
	interruptMember,
}));

import { preemptMember } from '../../../extensions/auto/org/preempt.js';
import { claimSlot } from '../../../extensions/auto/org/slot.js';
import {
	createOrg,
	joinOrg,
	runtimeDir,
	runtimeFile,
} from '../../../extensions/auto/org/orgstore.js';
import { readTask } from '../../../extensions/auto/org/task.js';
import { dispatchTask } from '../../../extensions/auto/org/dispatch.js';
import { writeJsonAtomic } from '../../../extensions/auto/org/util.js';
import type { AgentManifest } from '../../../extensions/auto/org/types.js';

const ORG = 'dev-team';
let root: string;

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), 'org-preempt-'));
	process.env.ORG_ROOT = root;
	for (const d of ['chief', 'worker-a']) mkdirSync(join(root, d), { recursive: true });
	deliverMessage.mockClear();
	interruptMember.mockClear();
});

afterEach(() => {
	parkOrgRoot();
	rmSync(root, { recursive: true, force: true });
});

const workerManifest: AgentManifest = { name: 'worker-a', role: 'member' };

async function online() {
	mkdirSync(runtimeDir(ORG), { recursive: true });
	await writeJsonAtomic(runtimeFile(ORG, 'worker-a'), {
		pid: 4242,
		socketPath: '/tmp/does-not-matter.sock',
	});
}

describe('L1 插话（默认）', () => {
	it('用 steer 投递，不调用中断', async () => {
		const res = await preemptMember(ORG, 'worker-a', '紧急：先看这个', { by: 'chief' });
		expect(res.level).toBe('steer');
		expect(res.message).toContain('插话');
		expect(interruptMember).not.toHaveBeenCalled();
		expect(deliverMessage).toHaveBeenCalledWith(
			ORG,
			'worker-a',
			'紧急：先看这个',
			expect.objectContaining({ mode: 'steer' }),
		);
	});
});

describe('L2 硬抢占', () => {
	it('先中断再投递，并在任务历史留 interrupted（可指认）', async () => {
		await online();
		await createOrg(ORG, { name: 'chief', dir: join(root, 'chief') });
		await joinOrg(ORG, { manifest: workerManifest, dir: join(root, 'worker-a') });
		const d = await dispatchTask({
			org: ORG,
			dispatcher: 'chief',
			dispatcherRole: 'chief',
			title: '旧任务',
			background: 'bg',
			items: ['a'],
			targets: [{ agent: 'worker-a', description: '做旧任务' }],
		});
		await claimSlot(ORG, 'worker-a', { taskId: d.task.id, subTaskId: d.task.subTasks[0].id });

		const res = await preemptMember(ORG, 'worker-a', '紧急：停手改做这个', {
			hard: true,
			by: 'chief',
		});
		expect(res.level).toBe('abort');
		expect(res.interrupted).toBe(true);
		expect(res.taskId).toBe(d.task.id);
		expect(interruptMember).toHaveBeenCalledTimes(1);

		const t = await readTask(ORG, d.task.id);
		expect(t?.history.some((h) => h.event === 'interrupted' && h.by === 'chief')).toBe(true);
	});

	it('中断失败（进程版本旧）→ 据实回报，但消息仍投递', async () => {
		await online();
		interruptMember.mockResolvedValueOnce({ ok: false, entries: [], reason: 'unsupported' });
		const res = await preemptMember(ORG, 'worker-a', '紧急', { hard: true, by: 'chief' });
		expect(res.interrupted).toBe(false);
		expect(res.message).toContain('中断未生效');
		expect(res.message).toContain('版本较旧');
		expect(deliverMessage).toHaveBeenCalledTimes(1); // 话必须带到
	});

	it('成员不在岗 → 明确回报"没停下来"，消息落收件箱', async () => {
		interruptMember.mockClear();
		deliverMessage.mockResolvedValueOnce('inbox');
		const res = await preemptMember(ORG, 'worker-a', '紧急', { hard: true, by: 'chief' });
		expect(res.interrupted).toBe(false);
		expect(res.message).toContain('不在岗');
		expect(interruptMember).not.toHaveBeenCalled();
		expect(deliverMessage).toHaveBeenCalledTimes(1);
	});
});
