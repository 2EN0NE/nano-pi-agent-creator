/**
 * 排队上限（ADR-0055 `D4`）：满了**拒绝派发**，且**账本零改动**
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { ensureAwakeForDispatch } = vi.hoisted(() => ({
	ensureAwakeForDispatch: vi.fn(async () => false),
}));
vi.mock('../../../extensions/auto/org/lifecycle.js', () => ({ ensureAwakeForDispatch }));

import { dispatchTask } from '../../../extensions/auto/org/dispatch.js';
import { createOrg, joinOrg, readOrg } from '../../../extensions/auto/org/orgstore.js';
import { listTasks, queueLengthFor } from '../../../extensions/auto/org/task.js';
import {
	resolveMemberQueueCap,
	DEFAULT_MEMBER_QUEUE_CAP,
} from '../../../extensions/auto/org/config.js';
import type { AgentManifest } from '../../../extensions/auto/org/types.js';

const ORG = 'dev-team';
let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'org-queue-'));
	process.env.ORG_ROOT = root;
	for (const d of ['chief', 'worker-a']) mkdirSync(join(root, d), { recursive: true });
});

afterEach(() => {
	delete process.env.ORG_ROOT;
	rmSync(root, { recursive: true, force: true });
});

const workerManifest: AgentManifest = { name: 'worker-a', role: 'member' };

async function setup() {
	await createOrg(ORG, { name: 'chief', dir: join(root, 'chief') });
	await joinOrg(ORG, { manifest: workerManifest, dir: join(root, 'worker-a') });
}

async function dispatch(n: number) {
	return dispatchTask({
		org: ORG,
		dispatcher: 'chief',
		dispatcherRole: 'chief',
		title: `任务 ${n}`,
		background: 'bg',
		items: ['a'],
		targets: [{ agent: 'worker-a', description: `子任务 ${n}` }],
	});
}

describe('队列口径', () => {
	it('只数未接手的（invited），已领取不计入', async () => {
		await setup();
		const r = await dispatch(1);
		const tasks = await listTasks(ORG);
		expect(queueLengthFor(tasks, 'worker-a')).toBe(1);
		// 领取后（claimed）不再占队列
		const { readTask, transitionAssignee, saveTask } =
			await import('../../../extensions/auto/org/task.js');
		const t = await readTask(ORG, r.task.id);
		expect(t).not.toBeNull();
		if (t) {
			transitionAssignee(t.subTasks[0].assignees[0], 'claimed', 'worker-a');
			await saveTask(t);
		}
		expect(queueLengthFor(await listTasks(ORG), 'worker-a')).toBe(0);
	});
});

describe('超限拒收（默认上限 3）', () => {
	it('达到上限后派发被拒，且账本未被改动', async () => {
		await setup();
		for (let i = 1; i <= DEFAULT_MEMBER_QUEUE_CAP; i++) await dispatch(i);
		const before = (await listTasks(ORG)).length;
		await expect(dispatch(99)).rejects.toThrow(/队列已达上限/);
		expect((await listTasks(ORG)).length).toBe(before); // 零改动
		// 错误信息含 used/limit（抄参考实现的 capacity exhausted 语义）
		await expect(dispatch(100)).rejects.toThrow(
			new RegExp(`${DEFAULT_MEMBER_QUEUE_CAP}/${DEFAULT_MEMBER_QUEUE_CAP}`),
		);
	});

	it('拒绝不影响 org 自身状态（未产生半截任务）', async () => {
		await setup();
		for (let i = 1; i <= DEFAULT_MEMBER_QUEUE_CAP; i++) await dispatch(i);
		await expect(dispatch(98)).rejects.toThrow();
		const org = await readOrg(ORG);
		expect(org.members.map((m) => m.name)).toContain('worker-a');
	});

	it('释放后可再入队（拒收不是永久封禁，ADR-0055 验证 1 后半句）', async () => {
		await setup();
		for (let i = 1; i <= DEFAULT_MEMBER_QUEUE_CAP; i++) await dispatch(i);
		await expect(dispatch(99)).rejects.toThrow(/队列已达上限/);

		// 处理人领掉手上一件（invited → claimed）→ 队列腾出位置
		const { readTask, transitionAssignee, saveTask } =
			await import('../../../extensions/auto/org/task.js');
		const one = (await listTasks(ORG))[0];
		const t = await readTask(ORG, one.id);
		expect(t).not.toBeNull();
		if (t) {
			transitionAssignee(t.subTasks[0].assignees[0], 'claimed', 'worker-a');
			await saveTask(t);
		}

		await expect(dispatch(100)).resolves.toBeTruthy();
		expect(queueLengthFor(await listTasks(ORG), 'worker-a')).toBe(DEFAULT_MEMBER_QUEUE_CAP);
	});
});

describe('配置解析', () => {
	it('0 / 非法 = 不限制（undefined）', () => {
		expect(resolveMemberQueueCap(0)).toBeUndefined();
		expect(resolveMemberQueueCap(-1)).toBeUndefined();
		expect(resolveMemberQueueCap('x')).toBeUndefined();
	});
	it('正整数生效', () => {
		expect(resolveMemberQueueCap(5)).toBe(5);
	});
});
