/**
 * org 可感知状态（presence）— 四态判定 + 真实 socket 探测（ADR-0040 D5/D7）
 *
 * 覆盖：
 * - 四态判定与优先级（睡眠 > 工作中 > 待验收 > 空闲）
 * - 「待验收」排除**已关闭任务**（验收后参与者态仍留在 delivered）与已叫停参与者
 * - 真实 unix socket 探测：可连 = 在岗；无 runtime / 不可连 = 睡眠
 * - stale runtime 清理的宽限期语义（挡启动竞态与探测抖动）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parkOrgRoot } from '../setup/org-root.js';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	countOnlineByPid,
	hasPendingDelivery,
	inspectMember,
	inspectMembers,
	judgePresence,
	mergePresenceStates,
	onlineFor,
	readRuntime,
	sweepStaleRuntime,
	type MemberPresence,
	type RuntimeRecord,
} from '../../../extensions/auto/org/presence.js';
import { createOrg, runtimeFile } from '../../../extensions/auto/org/orgstore.js';
import {
	closeServers,
	killIfAlive,
	listenFakeControl,
	spawnFakeMember,
	writeRuntimeFile,
} from './org-lifecycle-helpers.js';
import { createTaskWithId, attestTask } from '../../../extensions/auto/org/task.js';
import type { AssigneeStatus, Task, TaskStatus } from '../../../extensions/auto/org/types.js';

const ORG = 'dev-team';
let root = '';
const servers: net.Server[] = [];
const pids: number[] = [];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'org-presence-'));
	process.env.ORG_ROOT = join(root, 'orgdata');
	mkdirSync(process.env.ORG_ROOT, { recursive: true });
});

afterEach(async () => {
	await closeServers(servers);
	for (const p of pids.splice(0)) killIfAlive(p);
	rmSync(root, { recursive: true, force: true });
	parkOrgRoot();
});

/** 构造仅含判定所需字段的任务（presence 只读 status 与 subTasks[].assignees[]） */
function taskWith(over: {
	status: TaskStatus;
	assignees: { agent: string; status: AssigneeStatus; stopped?: boolean }[];
}): Task {
	const assignees = over.assignees.map((a) => ({
		agent: a.agent,
		status: a.status,
		round: 0,
		deliveries: [],
		stopped: a.stopped,
	}));
	// SAFETY: presence 判定只读 status 与 subTasks[].assignees[]，其余字段与本用例无关
	return {
		status: over.status,
		subTasks: [{ id: 'S-1', description: 'd', assignees }],
	} as unknown as Task;
}

describe('judgePresence —— 四态与优先级', () => {
	const rt = { busy: false } as RuntimeRecord;

	it('无 runtime → 睡眠（即便 socketAlive 为脏输入 true）', () => {
		expect(judgePresence({ runtime: null, socketAlive: true, pendingDelivery: false })).toBe(
			'sleeping',
		);
	});

	it('socket 不可连 → 睡眠（优先于工作/待验收）', () => {
		expect(
			judgePresence({
				runtime: { ...rt, busy: true } as RuntimeRecord,
				socketAlive: false,
				pendingDelivery: true,
			}),
		).toBe('sleeping');
	});

	it('在岗 + busy → 工作中（优先于待验收）', () => {
		expect(
			judgePresence({
				runtime: { ...rt, busy: true } as RuntimeRecord,
				socketAlive: true,
				pendingDelivery: true,
			}),
		).toBe('working');
	});

	it('在岗、空闲、名下有交付待验收 → 待验收', () => {
		expect(judgePresence({ runtime: rt, socketAlive: true, pendingDelivery: true })).toBe(
			'delivered',
		);
	});

	it('在岗、空闲、无待验收 → 空闲', () => {
		expect(judgePresence({ runtime: rt, socketAlive: true, pendingDelivery: false })).toBe(
			'idle',
		);
	});
});

describe('hasPendingDelivery —— 排除已关闭与已叫停', () => {
	it('未关闭任务中的 delivered 参与者 → true', () => {
		const t = taskWith({
			status: 'waiting_accept',
			assignees: [{ agent: 'worker-a', status: 'delivered' }],
		});
		expect(hasPendingDelivery([t], 'worker-a')).toBe(true);
	});

	it('已叫停（stopped）的 delivered 不计入', () => {
		const t = taskWith({
			status: 'in_progress',
			assignees: [{ agent: 'worker-a', status: 'delivered', stopped: true }],
		});
		expect(hasPendingDelivery([t], 'worker-a')).toBe(false);
	});

	it('他人的 delivered 不计入', () => {
		const t = taskWith({
			status: 'waiting_accept',
			assignees: [{ agent: 'worker-b', status: 'delivered' }],
		});
		expect(hasPendingDelivery([t], 'worker-a')).toBe(false);
	});

	it('尚未交付（claimed / returned）不计入', () => {
		const claimed = taskWith({
			status: 'in_progress',
			assignees: [{ agent: 'worker-a', status: 'claimed' }],
		});
		const returned = taskWith({
			status: 'in_progress',
			assignees: [{ agent: 'worker-a', status: 'returned' }],
		});
		expect(hasPendingDelivery([claimed], 'worker-a')).toBe(false);
		expect(hasPendingDelivery([returned], 'worker-a')).toBe(false);
	});

	it('验收关闭后不再计为待验收（真实链路：参与者态仍留在 delivered）', async () => {
		const t = await createTaskWithId(ORG, {
			org: ORG,
			title: '写周报',
			background: 'bg',
			items: ['产出 docs/weekly.md'],
			dispatcher: 'chief',
			dispatcherRole: 'chief',
			createdAt: new Date().toISOString(),
			status: 'waiting_accept',
			subTasks: [
				{
					id: 'S-1',
					description: '产出周报',
					assignees: [
						{ agent: 'worker-a', status: 'delivered', round: 0, deliveries: [] },
					],
				},
			],
			history: [],
		});
		expect(hasPendingDelivery([t], 'worker-a')).toBe(true);
		attestTask(t, 'chief', 'accepted', '质量达标');
		expect(t.status).toBe('closed');
		// 参与者态未被验收改动——这正是必须排除 closed 任务的原因
		expect(t.subTasks[0]?.assignees[0]?.status).toBe('delivered');
		expect(hasPendingDelivery([t], 'worker-a')).toBe(false);
	});
});

describe('inspectMember / inspectMembers —— 真实 socket 探测', () => {
	it('runtime + 可连 socket → 在岗（空闲）', async () => {
		const sock = join(root, 'a.sock');
		// pid 取本进程（必存活）：默认占位 pid 是刻意"不存在"的，会让 pidAlive 假阴性
		await writeRuntimeFile(ORG, 'worker-a', { socketPath: sock, pid: process.pid });
		await listenFakeControl(sock);
		const p = await inspectMember(ORG, 'worker-a', []);
		expect(p.state).toBe('idle');
		expect(p.socketAlive).toBe(true);
		expect(p.pidAlive).toBe(true);
		expect(p.runtime?.sessionId).toBe('sess-worker-a');
	});

	it('在岗且 busy → 工作中', async () => {
		const sock = join(root, 'b.sock');
		await writeRuntimeFile(ORG, 'worker-b', { socketPath: sock, busy: true });
		await listenFakeControl(sock);
		expect((await inspectMember(ORG, 'worker-b', [])).state).toBe('working');
	});

	it('runtime 在但 socket 文件不存在 → 睡眠', async () => {
		await writeRuntimeFile(ORG, 'worker-a', { socketPath: join(root, 'missing.sock') });
		expect((await inspectMember(ORG, 'worker-a', [])).state).toBe('sleeping');
	});

	it('无 runtime → 睡眠', async () => {
		expect((await inspectMember(ORG, 'nobody', [])).state).toBe('sleeping');
		expect(await readRuntime(ORG, 'nobody')).toBeNull();
	});

	it('inspectMembers 覆盖全部成员', async () => {
		const sock = join(root, 'c.sock');
		await writeRuntimeFile(ORG, 'worker-a', { socketPath: sock });
		await listenFakeControl(sock);
		const map = await inspectMembers(ORG, ['worker-a', 'worker-b'], []);
		expect(map.size).toBe(2);
		expect(map.get('worker-a')?.state).toBe('idle');
		expect(map.get('worker-b')?.state).toBe('sleeping');
	});
});

describe('sweepStaleRuntime —— 宽限期语义', () => {
	it('已睡眠且超宽限 → 清理 runtime 文件并回报成员名', async () => {
		await writeRuntimeFile(ORG, 'worker-a', {
			socketPath: join(root, 'gone.sock'),
			updatedAt: new Date(Date.now() - 120_000).toISOString(),
		});
		const map = await inspectMembers(ORG, ['worker-a'], []);
		const swept = await sweepStaleRuntime(ORG, map);
		expect(swept).toEqual(['worker-a']);
		expect(existsSync(runtimeFile(ORG, 'worker-a'))).toBe(false);
	});

	it('已睡眠但刚更新（宽限内）→ 不清理（挡启动竞态/探测抖动）', async () => {
		await writeRuntimeFile(ORG, 'worker-a', {
			socketPath: join(root, 'gone.sock'),
			updatedAt: new Date(Date.now() - 5_000).toISOString(),
		});
		const map = await inspectMembers(ORG, ['worker-a'], []);
		expect(await sweepStaleRuntime(ORG, map)).toEqual([]);
		expect(existsSync(runtimeFile(ORG, 'worker-a'))).toBe(true);
	});

	it('进程仍在但 socket 不可连（未开 --session-control）→ 绝不清理', async () => {
		// 真实进程（pid 存活）+ 指向不存在的 socket；即使 updatedAt 已远超宽限也不得清：
		// 清掉会让看板遗忘在岗成员，并可能诱发重复拉起（一目录 = 一员工）
		const pid = await spawnFakeMember({
			scriptPath: join(root, 'alive-sockless.mjs'),
			socketPath: join(root, 'real.sock'),
		});
		pids.push(pid);
		await writeRuntimeFile(ORG, 'worker-a', {
			socketPath: join(root, 'gone-socket.sock'),
			pid,
			updatedAt: new Date(Date.now() - 600_000).toISOString(),
		});
		const map = await inspectMembers(ORG, ['worker-a'], []);
		expect(map.get('worker-a')?.state).toBe('sleeping'); // socket 不可连 → 操作上不可达
		expect(map.get('worker-a')?.pidAlive).toBe(true); // 但进程确实在
		expect(await sweepStaleRuntime(ORG, map)).toEqual([]);
		expect(existsSync(runtimeFile(ORG, 'worker-a'))).toBe(true);
	});

	it('在岗成员不清理（即便 updatedAt 很旧）', async () => {
		const sock = join(root, 'alive.sock');
		await writeRuntimeFile(ORG, 'worker-a', {
			socketPath: sock,
			updatedAt: new Date(Date.now() - 600_000).toISOString(),
		});
		await listenFakeControl(sock);
		const map = await inspectMembers(ORG, ['worker-a'], []);
		expect(await sweepStaleRuntime(ORG, map)).toEqual([]);
		expect(existsSync(runtimeFile(ORG, 'worker-a'))).toBe(true);
	});
});

describe('onlineFor —— 在岗时长', () => {
	/** MemberPresence 字面量工厂：字段演进时只需改这一处（避免每个用例重复全字段） */
	const presenceOf = (
		over: Partial<MemberPresence> & Pick<MemberPresence, 'state'>,
	): MemberPresence => ({ socketAlive: false, pidAlive: false, runtime: null, ...over });
	const withStarted = (startedAt: string): MemberPresence =>
		presenceOf({
			state: 'idle',
			socketAlive: true,
			pidAlive: true,
			runtime: { startedAt } as RuntimeRecord,
		});

	it('睡眠 → null', () => {
		expect(onlineFor(presenceOf({ state: 'sleeping' }))).toBeNull();
	});

	it('在岗时长格式化', () => {
		const now = Date.now();
		expect(onlineFor(withStarted(new Date(now - 30_000).toISOString()), now)).toBe('30s');
		expect(onlineFor(withStarted(new Date(now - 90_000).toISOString()), now)).toBe('1m');
		expect(onlineFor(withStarted(new Date(now - 3 * 3600_000).toISOString()), now)).toBe(
			'3h0m',
		);
	});
});

describe('mergePresenceStates — 多所属合并（ADR-0070 D1）', () => {
	it('同一成员出现在多家 org：只计一次', () => {
		const merged = mergePresenceStates([
			{ name: 'w1', state: 'idle' },
			{ name: 'w1', state: 'idle' },
		]);
		expect(merged).toEqual(['idle']);
	});

	it('冲突取最活跃：某家残留的睡眠 runtime 不把已上岗的统计拉低', () => {
		const merged = mergePresenceStates([
			{ name: 'w1', state: 'sleeping' },
			{ name: 'w1', state: 'working' },
		]);
		expect(merged).toEqual(['working']);
	});

	it('活跃序 sleeping < idle < delivered < working', () => {
		const pairs: [
			'sleeping' | 'idle' | 'delivered' | 'working',
			'sleeping' | 'idle' | 'delivered' | 'working',
			string,
		][] = [
			['sleeping', 'idle', 'idle'],
			['idle', 'delivered', 'delivered'],
			['delivered', 'working', 'working'],
			['working', 'sleeping', 'working'],
		];
		for (const [a, b, want] of pairs) {
			expect(
				mergePresenceStates([
					{ name: 'x', state: a },
					{ name: 'x', state: b },
				]),
			).toEqual([want]);
		}
	});

	it('不同成员各计一条（空输入 → 空结果）', () => {
		expect(mergePresenceStates([])).toEqual([]);
		expect(
			mergePresenceStates([
				{ name: 'a', state: 'working' },
				{ name: 'b', state: 'sleeping' },
			]),
		).toEqual(['working', 'sleeping']);
	});
});

describe('countOnlineByPid — 非当前 org 的廉价在岗计数（ADR-0070 D7）', () => {
	it('org 读不到 → **抛出**（不静默降级成 0 人；0 在 D8 里是「确定无人在岗」的语义）', async () => {
		await expect(countOnlineByPid('no-such-org')).rejects.toThrow();
	});

	it('无 runtime → 0；runtime 的 pid 存活 → 1（不看 socket 能不能连）', async () => {
		const dir = join(root, 'worker-a-dir');
		mkdirSync(dir, { recursive: true });
		await createOrg(ORG, { name: 'worker-a', dir });
		expect(await countOnlineByPid(ORG)).toBe(0);

		// socket 故意指向不存在的路径：廉价判据只看 pid（这正是 D7 接受的精度损失）
		await writeRuntimeFile(ORG, 'worker-a', {
			pid: process.pid,
			socketPath: join(root, 'no-such.sock'),
		});
		expect(await countOnlineByPid(ORG)).toBe(1);
	});
});
