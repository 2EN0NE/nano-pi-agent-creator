// re-check marker 2026-09-09 (org board 视觉重构后)
/**
 * org 扩展 — 逻辑层 Vitest 测试
 * 覆盖：01 org 实体化（create/join/leave/回归三选一/多 org/删除归档）、
 *       03 任务模型与状态机（终态铁律/期望继承/聚合/返工轮次）、
 *       04 派发（chief 单方/取消/改派/consent）、05 多人情形 B 叫停。
 * 通过 ORG_ROOT 环境变量把 org 数据隔离到临时目录。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	createOrg,
	findOrgsForDir,
	joinOrg,
	leaveOrg,
	listOrgNames,
	orgExists,
	readOrg,
	removeOrg,
	renameOrg,
	transferChief,
} from '../../../extensions/auto/org/orgstore.js';
import {
	adoptAssignee,
	approveWithAdoption,
	attestTask,
	cancelTask,
	humanReassign,
	computeTaskStatus,
	createTaskWithId,
	effectiveDueAt,
	findMemberOpenWork,
	generateTaskId,
	listTasks,
	readTask,
	saveTask,
	transitionAssignee,
} from '../../../extensions/auto/org/task.js';
import {
	cancelTaskByDispatcher,
	consentCancel,
	deliverMessage,
	dispatchTask,
	reassignSubTask,
} from '../../../extensions/auto/org/dispatch.js';
import { ackInbox, peekInbox } from '../../../extensions/auto/org/inbox.js';
import type { AgentManifest, Task } from '../../../extensions/auto/org/types.js';

// inbox 读取/消费的测试探针：生产路径走 peekInbox/planInboxFlush/commitInboxFlush，
// 这里保留"取消息"与"取并清空"两个薄封装，供断言 inbox 内容用。
const drainInbox = async (org: string, agent: string): Promise<string[]> =>
	(await peekInbox(org, agent)).map((r) => r.message);
const takeInbox = async (org: string, agent: string): Promise<string[]> => {
	const records = await peekInbox(org, agent);
	await ackInbox(
		org,
		agent,
		records.map((r) => r.id),
	);
	return records.map((r) => r.message);
};

let tmpRoot: string;
let chiefDir: string;
let workerDir: string;
let workerB: string;

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), 'org-test-'));
	process.env.ORG_ROOT = tmpRoot;
	chiefDir = join(tmpRoot, 'chief');
	workerDir = join(tmpRoot, 'worker-a');
	workerB = join(tmpRoot, 'worker-b');
	for (const d of [chiefDir, workerDir, workerB]) mkdirSync(d, { recursive: true });
});

afterEach(() => {
	delete process.env.ORG_ROOT;
	rmSync(tmpRoot, { recursive: true, force: true });
});

const workerManifest: AgentManifest = { name: 'worker-a', role: 'member' };
const workerBManifest: AgentManifest = { name: 'worker-b', role: 'member' };

async function setupOrg(org = 'dev-team') {
	await createOrg(org, { name: 'chief', dir: chiefDir });
	await joinOrg(org, { manifest: workerManifest, dir: workerDir });
	await joinOrg(org, { manifest: workerBManifest, dir: workerB });
	return org;
}

async function newTask(org: string, over: Partial<Parameters<typeof createTaskWithId>[1]> = {}) {
	return createTaskWithId(org, {
		org,
		title: 'T',
		background: 'bg',
		items: ['i1'],
		dispatcher: 'chief',
		dispatcherRole: 'chief',
		createdAt: new Date().toISOString(),
		status: 'todo',
		subTasks: [
			{
				id: 'S1',
				description: 'd',
				dueAt: null,
				assignees: [{ agent: 'worker-a', status: 'invited', round: 0, deliveries: [] }],
			},
		],
		history: [],
		...over,
	});
}

// ── 01 org 实体化 ────────────────────────────────────────────────────────────

describe('org 实体化（01）', () => {
	it('createOrg 登记本目录为负责人；重复创建被拒；非法名被拒', async () => {
		const org = await createOrg('dev-team', { name: 'chief', dir: chiefDir });
		expect(org.chiefName).toBe('chief');
		expect(org.members).toHaveLength(1);
		await expect(createOrg('dev-team', { name: 'chief', dir: chiefDir })).rejects.toThrow(
			'已存在',
		);
		await expect(createOrg('../evil', { name: 'x', dir: chiefDir })).rejects.toThrow();
	});

	it('joinOrg：成员加入；org 不存在报错；幂等 already', async () => {
		await setupOrg();
		const res = await joinOrg('dev-team', { manifest: workerManifest, dir: workerDir });
		expect(res.already).toBe(true); // 幂等
		await expect(
			joinOrg('ghost', { manifest: workerManifest, dir: workerDir }),
		).rejects.toThrow('不存在');
	});

	it('chief 唯一：第二个 chief 加入被拒；leave 后可再成为负责人', async () => {
		await setupOrg();
		await expect(
			joinOrg('dev-team', { manifest: { name: 'worker-b', role: 'chief' }, dir: workerB }),
		).rejects.toThrow('负责人');
		// chief 离开 → worker-b 以 chief 身份加入成为新负责人
		await leaveOrg('dev-team', chiefDir);
		const org2 = await joinOrg('dev-team', {
			manifest: { name: 'worker-b', role: 'chief' },
			dir: workerB,
		});
		expect(org2.org.chiefName).toBe('worker-b');
	});

	it('回归三选一：leave 后同名 join → dispositionRequired；inherit/fresh/exit', async () => {
		await setupOrg();
		await leaveOrg('dev-team', workerDir);
		// 无 disposition → 需三选一
		const pending = await joinOrg('dev-team', { manifest: workerManifest, dir: workerDir });
		expect(pending.dispositionRequired).toBe(true);
		expect(pending.history?.name).toBe('worker-a');
		// exit → 不加入
		await expect(
			joinOrg('dev-team', { manifest: workerManifest, dir: workerDir, disposition: 'exit' }),
		).rejects.toThrow('修改 agent 名');
		// fresh → 清空历史重来
		const fresh = await joinOrg('dev-team', {
			manifest: workerManifest,
			dir: workerDir,
			disposition: 'fresh',
		});
		expect(fresh.dispositionRequired).toBe(false);
		expect(fresh.member.role).toBe('member');
		// inherit：再走一轮 leave+join(inherit)，历史 events 延续
		await leaveOrg('dev-team', workerDir);
		const inherit = await joinOrg('dev-team', {
			manifest: workerManifest,
			dir: workerDir,
			disposition: 'inherit',
		});
		expect(inherit.dispositionRequired).toBe(false);
	});

	it('findOrgsForDir：一目录可属多 org；leave 一个 org 不影响其它', async () => {
		await setupOrg('alpha');
		await setupOrg('beta');
		// worker-a 加入两个 org
		await joinOrg('beta', { manifest: workerManifest, dir: workerDir });
		const orgs = await findOrgsForDir(workerDir);
		expect(orgs.map((o) => o.name).sort()).toEqual(['alpha', 'beta']);
		// leave alpha，beta 仍在
		await leaveOrg('alpha', workerDir);
		const after = await findOrgsForDir(workerDir);
		expect(after.map((o) => o.name)).toEqual(['beta']);
	});

	it('removeOrg 归档到 .trash（不物理抹掉）', async () => {
		const org = await setupOrg();
		expect(await orgExists(org)).toBe(true);
		const res = await removeOrg(org);
		expect(res.removed).toBe(true);
		expect(res.archivedTo).toContain('.trash');
		expect(await orgExists(org)).toBe(false);
		expect(await listOrgNames()).not.toContain(org);
	});
});

// ── 03 任务模型与状态机 ──────────────────────────────────────────────────────

describe('任务模型与状态机（03）', () => {
	it('编号：M- 前缀 + 8 位字母数字，唯一', () => {
		const ids = new Set(Array.from({ length: 200 }, () => generateTaskId()));
		expect(ids.size).toBe(200);
		for (const id of ids) expect(id).toMatch(/^M-[a-z0-9]{8}$/);
	});

	it('状态机合法路径：invited→claimed→delivered→waiting_accept→closed', async () => {
		const org = await setupOrg();
		const task = await newTask(org);
		expect(task.status).toBe('todo');
		const a = task.subTasks[0].assignees[0];
		transitionAssignee(a, 'claimed', 'worker-a');
		expect(computeTaskStatus(task)).toBe('in_progress');
		transitionAssignee(a, 'delivered', 'worker-a');
		expect(computeTaskStatus(task)).toBe('waiting_accept');
		// 验收：非派发人拒绝（同步抛错）
		expect(() => attestTask(task, 'worker-b', 'accepted')).toThrow('派发人');
		const ok = attestTask(task, 'chief', 'accepted', '好');
		expect(ok.accepted).toBe(true);
		expect(task.status).toBe('closed');
	});

	it('铁终态：closed 后任何迁移/验收/取消都被拒', async () => {
		const org = await setupOrg();
		const task = await newTask(org);
		const a = task.subTasks[0].assignees[0];
		transitionAssignee(a, 'claimed', 'worker-a');
		transitionAssignee(a, 'delivered', 'worker-a');
		attestTask(task, 'chief', 'accepted');
		expect(() => transitionAssignee(a, 'claimed', 'worker-a')).toThrow(); // delivered→claimed 非法
		expect(() => attestTask(task, 'chief', 'rejected')).toThrow('已关闭');
		expect(() => cancelTask(task, 'chief')).toThrow('已关闭');
	});

	it('非法转移被拒；reject 带原因必需', async () => {
		const org = await setupOrg();
		const task = await newTask(org);
		const a = task.subTasks[0].assignees[0];
		expect(() => transitionAssignee(a, 'delivered', 'worker-a')).toThrow('非法');
		expect(() => transitionAssignee(a, 'rejected', 'worker-a')).toThrow('拒绝必须带原因');
		transitionAssignee(a, 'rejected', 'worker-a', { note: '忙不过来' });
		expect(a.status).toBe('rejected');
	});

	it('打回（reject）→ returned + 返工轮次 +1；再交付后聚合回等待验收', async () => {
		const org = await setupOrg();
		const task = await newTask(org);
		const a = task.subTasks[0].assignees[0];
		transitionAssignee(a, 'claimed', 'worker-a');
		transitionAssignee(a, 'delivered', 'worker-a');
		const r = attestTask(task, 'chief', 'rejected', '重做第 1 点');
		expect(r.accepted).toBe(false);
		expect(a.status).toBe('returned');
		expect(a.round).toBe(1);
		expect(task.acceptance?.round).toBe(1);
		transitionAssignee(a, 'claimed', 'worker-a');
		expect(computeTaskStatus(task)).toBe('in_progress');
	});

	it('期望完成时间继承：子任务未设继承任务级', () => {
		const due = '2026-09-09T00:00:00Z';
		const t = { dueAt: due } as unknown as Task;
		expect(effectiveDueAt(t, { dueAt: null } as never)).toBe(due);
		expect(effectiveDueAt(t, { dueAt: '2026-09-10T00:00:00Z' } as never)).toBe(
			'2026-09-10T00:00:00Z',
		);
		expect(effectiveDueAt({ dueAt: null } as never, { dueAt: null } as never)).toBeNull();
	});

	it('多人情形 B：来一份审一份——a 先交付、b 仍在做，派发人部分采纳 a 即叫停 b', async () => {
		const org = await setupOrg();
		const task = await newTask(org, {
			subTasks: [
				{
					id: 'S1',
					description: '同一份调研',
					dueAt: null,
					assignees: [
						{ agent: 'worker-a', status: 'invited', round: 0, deliveries: [] },
						{ agent: 'worker-b', status: 'invited', round: 0, deliveries: [] },
					],
				},
			],
		});
		const [a, b] = task.subTasks[0].assignees;
		transitionAssignee(a, 'claimed', 'worker-a');
		transitionAssignee(b, 'claimed', 'worker-b');
		transitionAssignee(a, 'delivered', 'worker-a');
		// b 仍在做 → 聚合 in_progress（不能整体验收）
		expect(computeTaskStatus(task)).toBe('in_progress');
		// 派发人部分采纳 a → b 被叫停（stopped），a 保留
		adoptAssignee(task, 'chief', 'worker-a', '采纳 worker-a 的');
		const a2 = task.subTasks[0].assignees.find((x) => x.agent === 'worker-a')!;
		const b2 = task.subTasks[0].assignees.find((x) => x.agent === 'worker-b')!;
		expect(a2.stopped ?? false).toBe(false);
		expect(b2.stopped ?? false).toBe(true);
		// 叫停后无未决 → waiting_accept → 整体验收关闭
		expect(computeTaskStatus(task)).toBe('waiting_accept');
		attestTask(task, 'chief', 'accepted', '整体验收');
		expect(task.status).toBe('closed');
	});

	it('approveWithAdoption：a 已交付、b 在做 → 整体验收采纳并叫停 b（命令面路径）', async () => {
		const org = await setupOrg();
		const task = await newTask(org, {
			subTasks: [
				{
					id: 'S1',
					description: '同一份调研',
					dueAt: null,
					assignees: [
						{ agent: 'worker-a', status: 'invited', round: 0, deliveries: [] },
						{ agent: 'worker-b', status: 'invited', round: 0, deliveries: [] },
					],
				},
			],
		});
		const [a, b] = task.subTasks[0].assignees;
		transitionAssignee(a, 'claimed', 'worker-a');
		transitionAssignee(b, 'claimed', 'worker-b');
		transitionAssignee(a, 'delivered', 'worker-a');
		expect(computeTaskStatus(task)).toBe('in_progress'); // attest 单独调用会被拒
		expect(() => attestTask(task, 'chief', 'accepted', 'x')).toThrow('尚未全部交付齐');

		const res = approveWithAdoption(task, 'chief', '采纳 worker-a 的交付');
		expect(res.stopped).toEqual(['worker-b']);
		expect(task.status).toBe('closed');
		const a2 = task.subTasks[0].assignees.find((x) => x.agent === 'worker-a')!;
		const b2 = task.subTasks[0].assignees.find((x) => x.agent === 'worker-b')!;
		expect(a2.stopped ?? false).toBe(false);
		expect(b2.stopped ?? false).toBe(true);
		expect(task.acceptance?.result).toBe('accepted');
	});

	it('approveWithAdoption：全部已交付 → 无叫停直接关闭（与旧 approve 等价）', async () => {
		const org = await setupOrg();
		const task = await newTask(org, {
			subTasks: [
				{
					id: 'S1',
					description: 'x',
					dueAt: null,
					assignees: [{ agent: 'worker-a', status: 'invited', round: 0, deliveries: [] }],
				},
			],
		});
		transitionAssignee(task.subTasks[0].assignees[0], 'claimed', 'worker-a');
		transitionAssignee(task.subTasks[0].assignees[0], 'delivered', 'worker-a');
		const res = approveWithAdoption(task, 'chief', '验收');
		expect(res.stopped).toEqual([]);
		expect(task.status).toBe('closed');
	});

	it('approveWithAdoption：无任何交付不能验收（保持拒绝语义）', async () => {
		const org = await setupOrg();
		const task = await newTask(org);
		expect(() => approveWithAdoption(task, 'chief', 'x')).toThrow('尚无任何交付');
		expect(() => approveWithAdoption(task, 'worker-a', 'x')).toThrow('只有派发人');
	});

	it('findMemberOpenWork 盘点未结子任务（leave 用）', async () => {
		const org = await setupOrg();
		const t1 = await newTask(org); // worker-a invited
		expect(findMemberOpenWork(t1, 'worker-a')).toBe(true);
		expect(findMemberOpenWork(t1, 'worker-b')).toBe(false);
		const t2 = await newTask(org, {
			subTasks: [
				{
					id: 'S1',
					description: 'x',
					assignees: [
						{ agent: 'worker-a', status: 'delivered', round: 0, deliveries: [] },
					],
					dueAt: null,
				},
			],
		});
		expect(findMemberOpenWork(t2, 'worker-a')).toBe(false);
	});
});

// ── 04 派发 / 取消 / 改派 / inbox ───────────────────────────────────────────

describe('派发（04）与 inbox 兜底', () => {
	it('dispatchTask：chief 单方创建任务并落账本；离线成员投 inbox', async () => {
		const org = await setupOrg();
		const res = await dispatchTask({
			org,
			dispatcher: 'chief',
			dispatcherRole: 'chief',
			title: '调研',
			background: '背景',
			items: ['第 1 点'],
			targets: [{ agent: 'worker-a', description: '做调研', dueAt: null }],
		});
		expect(res.task.id).toMatch(/^M-/);
		const saved = await readTask(org, res.task.id);
		expect(saved?.dispatcher).toBe('chief');
		expect(res.deliveries[0].agent).toBe('worker-a');
		expect(res.deliveries[0].mode).toBe('inbox'); // 无 runtime → inbox
		// inbox 消息可取
		const queued = await drainInbox(org, 'worker-a');
		expect(queued.length).toBeGreaterThan(0);
		expect(queued[0]).toContain('调研');
		expect(queued[0]).toContain('做调研'); // 消息含该处理人负责的子任务内容
		const taken = await takeInbox(org, 'worker-a');
		expect(taken.length).toBeGreaterThan(0);
		expect(await drainInbox(org, 'worker-a')).toEqual([]);
	});

	it('非负责人派发需握手：目标不存在报错；非成员报错', async () => {
		const org = await setupOrg();
		await expect(
			dispatchTask({
				org,
				dispatcher: 'ghost',
				dispatcherRole: 'member',
				title: 'x',
				background: '',
				items: [],
				targets: [{ agent: 'worker-a', description: 'x' }],
			}),
		).rejects.toThrow('没有登记身份');
		await expect(
			dispatchTask({
				org,
				dispatcher: 'worker-a',
				dispatcherRole: 'member',
				title: 'x',
				background: '',
				items: [],
				targets: [{ agent: 'ghost', description: 'x' }],
			}),
		).rejects.toThrow('不是 org');
	});

	it('取消：无人领取直接撤；有人在做 → needConsent（处理人同意后关闭）', async () => {
		const org = await setupOrg();
		const t = await dispatchTask({
			org,
			dispatcher: 'chief',
			dispatcherRole: 'chief',
			title: 'a',
			background: '',
			items: [],
			targets: [{ agent: 'worker-a', description: 'x' }],
		});
		const r1 = await cancelTaskByDispatcher(org, t.task.id, 'chief');
		expect(r1.ok).toBe(true); // 未领取 → 直接取消
		expect((await readTask(org, t.task.id))?.status).toBe('closed');

		// 已领取场景：派发人取消 → needConsent；处理人 consent → closed
		const t2 = await dispatchTask({
			org,
			dispatcher: 'chief',
			dispatcherRole: 'chief',
			title: 'b',
			background: '',
			items: [],
			targets: [{ agent: 'worker-a', description: 'y' }],
		});
		const saved = (await readTask(org, t2.task.id))!;
		transitionAssignee(saved.subTasks[0].assignees[0], 'claimed', 'worker-a');
		await saveTask(saved);
		const r2 = await cancelTaskByDispatcher(org, t2.task.id, 'chief');
		expect(r2.needConsent).toBe(true);
		const r3 = await consentCancel(org, t2.task.id, 'worker-a');
		expect(r3.ok).toBe(true);
		expect((await readTask(org, t2.task.id))?.status).toBe('closed');
	});

	it('改派：未领取 replace 移除旧参与者；已领取不许静默替换', async () => {
		const org = await setupOrg();
		const t = await dispatchTask({
			org,
			dispatcher: 'chief',
			dispatcherRole: 'chief',
			title: 'c',
			background: '',
			items: [],
			targets: [{ agent: 'worker-a', description: 'x' }],
		});
		const subId = t.task.subTasks[0].id;
		// replace：worker-a（invited）→ worker-b
		const r1 = await reassignSubTask(org, t.task.id, subId, 'chief', 'worker-b', {
			replace: true,
		});
		expect(r1.ok).toBe(true);
		const after = await readTask(org, t.task.id);
		const sub = after!.subTasks[0];
		expect(sub.assignees.some((a) => a.agent === 'worker-a' && a.status === 'cancelled')).toBe(
			true,
		);
		expect(sub.assignees.some((a) => a.agent === 'worker-b' && a.status === 'invited')).toBe(
			true,
		);
	});

	it('deliverMessage：有 runtime socket 在岗 → 尝试在线；否则落 inbox', async () => {
		const org = await setupOrg();
		const mode = await deliverMessage(org, 'worker-a', 'hello');
		expect(mode).toBe('inbox'); // 无 socket → inbox
	});

	it('deliverMessage：同一内容重复投递不重复落 inbox（在线送达但回报超时的防双投）', async () => {
		const org = await setupOrg();
		const msg = '[org:task] 任务 M-test：请你处理 X。';
		await deliverMessage(org, 'worker-a', msg);
		await deliverMessage(org, 'worker-a', msg); // 模拟 socket 已送达但回报超时后的重投
		expect(await drainInbox(org, 'worker-a')).toHaveLength(1);
		// 不同内容不受影响（各自独立落盘）
		await deliverMessage(org, 'worker-a', '[org:task] 任务 M-test2：请你处理 Y。');
		expect(await drainInbox(org, 'worker-a')).toHaveLength(2);
	});
});

// ── orgstore 数据完整性 ──────────────────────────────────────────────────────

describe('org 数据完整性', () => {
	it('readOrg 同步反映成员变化；listOrgNames 正确', async () => {
		await setupOrg('alpha');
		const org = await readOrg('alpha');
		expect(org.members.map((m) => m.name).sort()).toEqual(['chief', 'worker-a', 'worker-b']);
		expect(await listOrgNames()).toEqual(['alpha']);
	});
});

// ── 07 待办投影与对账 ───────────────────────────────────────────────────────

describe('待办投影与对账（07）', () => {
	it('projectTask：任务投影成员工工作台待办（todos 同源格式）+ org 侧映射', async () => {
		const org = await setupOrg();
		const res = await dispatchTask({
			org,
			dispatcher: 'chief',
			dispatcherRole: 'chief',
			title: '写报告',
			background: 'bg',
			items: ['产出 docs/report.md'],
			targets: [{ agent: 'worker-a', description: '写报告', dueAt: null }],
		});
		const { projectTask } = await import('../../../extensions/auto/org/todoproj.js');
		const r = await projectTask(org, res.task.id);
		expect(r.created.length).toBe(1); // 员工 in todo
		// todos 同源格式文件：文件名 = 裸 <hex8>.md（无 TODO- 前缀，对齐 todos 插件落盘约定）
		const { readdir } = await import('node:fs/promises');
		const files = await readdir(join(workerDir, '.pi', 'todos'));
		const todoFile = files.find((f) => /^[a-f0-9]{8}\.md$/.test(f));
		expect(todoFile).toBeTruthy();
		expect(files.some((f) => f.startsWith('TODO-'))).toBe(false);
		const content = await (
			await import('node:fs/promises')
		).readFile(join(workerDir, '.pi', 'todos', todoFile!), 'utf8');
		expect(content).toContain(res.task.id);
		expect(content).toContain('## 交付');
		// org 侧映射
		const { readTodoMap } = await import('../../../extensions/auto/org/todoproj.js');
		const map = await readTodoMap(org);
		expect(map.some((m) => m.taskId === res.task.id && m.agent === 'worker-a')).toBe(true);
	});

	it('对账：待办标 done 但无交付 → 提醒补交付（不静默改账本）；交付后消失', async () => {
		const org = await setupOrg();
		const res = await dispatchTask({
			org,
			dispatcher: 'chief',
			dispatcherRole: 'chief',
			title: 'T',
			background: '',
			items: [],
			targets: [{ agent: 'worker-a', description: 'x' }],
		});
		const { projectTask, reconcileOrg, readTodoMap } =
			await import('../../../extensions/auto/org/todoproj.js');
		await projectTask(org, res.task.id);
		const map = await readTodoMap(org);
		const entry = map.find((m) => m.taskId === res.task.id && m.direction === 'in')!;
		// 模拟员工把待办标 done（todos 插件同款动作：改 front matter status）
		const { writeFile } = await import('node:fs/promises');
		const fp = join(workerDir, '.pi', 'todos', `${entry.todoId}.md`);
		const raw = await (await import('node:fs/promises')).readFile(fp, 'utf8');
		await writeFile(fp, raw.replace(/"status": "open"/, '"status": "done"'), 'utf8');
		// 对账：提醒补交付
		const rep = await reconcileOrg(org);
		expect(rep.issues.some((i) => i.kind === 'done_without_delivery')).toBe(true);
		// 员工补 report → 再对账：提醒消失
		const { readTask, saveTask } = await import('../../../extensions/auto/org/task.js');
		const t = (await readTask(org, res.task.id))!;
		const a = t.subTasks[0].assignees.find((x) => x.agent === 'worker-a')!;
		a.status = 'delivered';
		a.deliveries.push({
			at: new Date().toISOString(),
			by: 'worker-a',
			summary: '完成',
			files: [],
		});
		await saveTask(t);
		const rep2 = await reconcileOrg(org);
		expect(rep2.issues.some((i) => i.kind === 'done_without_delivery')).toBe(false);
	});

	it('官方关闭 → 权威回写待办 done（终态同步）', async () => {
		const org = await setupOrg();
		const res = await dispatchTask({
			org,
			dispatcher: 'chief',
			dispatcherRole: 'chief',
			title: 'T',
			background: '',
			items: [],
			targets: [{ agent: 'worker-a', description: 'x' }],
		});
		const { projectTask, readTodoMap } =
			await import('../../../extensions/auto/org/todoproj.js');
		const { readTask, saveTask, attestTask } =
			await import('../../../extensions/auto/org/task.js');
		await projectTask(org, res.task.id);
		// 直接交付 + 关闭
		const t = (await readTask(org, res.task.id))!;
		const a = t.subTasks[0].assignees[0];
		a.status = 'delivered';
		a.deliveries.push({
			at: new Date().toISOString(),
			by: 'worker-a',
			summary: 's',
			files: [],
		});
		attestTask(t, 'chief', 'accepted', 'ok');
		await saveTask(t);
		await projectTask(org, res.task.id);
		// 员工待办被回写 done
		const map = await readTodoMap(org);
		const entry = map.find((m) => m.taskId === res.task.id && m.direction === 'in')!;
		const content = await (
			await import('node:fs/promises')
		).readFile(join(workerDir, '.pi', 'todos', `${entry.todoId}.md`), 'utf8');
		expect(content).toContain('"status": "done"');
	});

	it('互操作：todos 插件认领过的同源样本（<hex8>.md + assigned_to_session）在 org 权威回写后保留认领', async () => {
		const org = await setupOrg();
		const res = await dispatchTask({
			org,
			dispatcher: 'chief',
			dispatcherRole: 'chief',
			title: 'T',
			background: '',
			items: [],
			targets: [{ agent: 'worker-a', description: 'x' }],
		});
		const { projectTask, readTodoMap } =
			await import('../../../extensions/auto/org/todoproj.js');
		const { readTask, saveTask, attestTask } =
			await import('../../../extensions/auto/org/task.js');
		await projectTask(org, res.task.id);
		const map = await readTodoMap(org);
		const entry = map.find((m) => m.taskId === res.task.id && m.direction === 'in')!;
		const fp = join(workerDir, '.pi', 'todos', `${entry.todoId}.md`);
		// 模拟 todos 插件动作：按插件 schema（id/title/tags/status/created_at/assigned_to_session/project_id）
		// 认领该待办（assigned_to_session 落到 front matter），文件名保持裸 <hex8>.md
		const { readFile, writeFile } = await import('node:fs/promises');
		const raw = await readFile(fp, 'utf8');
		const body = raw.slice(raw.indexOf('\n\n') + 2);
		const pluginFront = JSON.stringify(
			{
				id: entry.todoId,
				title: `[${res.task.id}] T`,
				tags: ['org', org],
				status: 'open',
				created_at: new Date().toISOString(),
				assigned_to_session: 'sess-worker-a',
				project_id: 'project',
			},
			null,
			2,
		);
		await writeFile(fp, `${pluginFront}\n\n${body.trim()}\n`, 'utf8');
		// 官方验收关闭 → 权威回写 done（org 重写 front matter）
		const t = (await readTask(org, res.task.id))!;
		const a = t.subTasks[0].assignees[0];
		a.status = 'delivered';
		a.deliveries.push({
			at: new Date().toISOString(),
			by: 'worker-a',
			summary: 's',
			files: [],
		});
		attestTask(t, 'chief', 'accepted', 'ok');
		await saveTask(t);
		await projectTask(org, res.task.id);
		const after = await readFile(fp, 'utf8');
		expect(after).toContain('"status": "done"');
		// 员工已认领状态不被 org 重写清掉（parseTodoFile/serializeTodo 保留同源字段）
		expect(after).toContain('"assigned_to_session": "sess-worker-a"');
	});
});

// ── 人类强制通道（01 · ADR-0039）────────────────────────────────────────────

describe('人类强制（human@）', () => {
	it('非派发人经 humanBy 可验收 → closed + by=human@ + human_forced_approve；agent 路径仍限派发人', async () => {
		const org = await setupOrg();
		const t = await newTask(org, {
			title: '等验收',
			status: 'waiting_accept' as const,
			subTasks: [
				{
					id: 'S1',
					description: 'd',
					dueAt: null,
					assignees: [
						{
							agent: 'worker-a',
							dir: workerDir,
							status: 'delivered',
							round: 0,
							deliveries: [],
						},
					],
				},
			],
		});
		// agent 路径：非派发人（worker-b 非 dispatcher）尝试验收 → 抛
		expect(() => attestTask(t, 'worker-a', 'accepted', 'x')).toThrow('只有派发人');
		// 人类路径：任意身份 + humanBy → 成功
		const r = approveWithAdoption(t, 'worker-a', '人类验收', { humanBy: 'human@jojo' });
		expect(r.stopped).toEqual([]);
		expect(t.status).toBe('closed');
		expect(t.acceptance?.by).toBe('human@jojo');
		expect(t.history.some((h) => h.event === 'human_forced_approve')).toBe(true);
	});

	it('验收未全部交付：人类 approve → 未交付参与者 stopped 后关闭', async () => {
		const org = await setupOrg();
		const t = await newTask(org, {
			title: '部分交付',
			status: 'in_progress' as const,
			subTasks: [
				{
					id: 'S1',
					description: 'd',
					dueAt: null,
					assignees: [
						{
							agent: 'worker-a',
							dir: workerDir,
							status: 'delivered',
							round: 0,
							deliveries: [
								{ at: '2026-01-01', by: 'worker-a', summary: 'done', files: [] },
							],
						},
						{
							agent: 'worker-b',
							dir: workerB,
							status: 'claimed',
							round: 0,
							deliveries: [],
						},
					],
				},
			],
		});
		const r = approveWithAdoption(t, 'nobody', '收尾', { humanBy: 'human@jojo' });
		expect(r.stopped).toContain('worker-b');
		expect(t.status).toBe('closed');
		const b = t.subTasks[0].assignees.find((a) => a.agent === 'worker-b')!;
		expect(b.stopped).toBe(true);
	});

	it('人类打回：已交付者 returned + 轮次 +1 + human_forced_return；无人可打回抛错', async () => {
		const org = await setupOrg();
		const t = await newTask(org, {
			title: '打回',
			status: 'waiting_accept' as const,
			subTasks: [
				{
					id: 'S1',
					description: 'd',
					dueAt: null,
					assignees: [
						{
							agent: 'worker-a',
							dir: workerDir,
							status: 'delivered',
							round: 0,
							deliveries: [
								{ at: '2026-01-01', by: 'worker-a', summary: 'v1', files: [] },
							],
						},
					],
				},
			],
		});
		attestTask(t, 'x', 'rejected', '人类要求返工', undefined, { humanBy: 'human@jojo' });
		expect(t.status).toBe('in_progress');
		const a = t.subTasks[0].assignees[0];
		expect(a.status).toBe('returned');
		expect(a.round).toBe(1);
		expect(t.history.some((h) => h.event === 'human_forced_return')).toBe(true);
		// 无交付任务的打回 → 抛错不落账
		const t2 = await newTask(org, { title: '无人交付', status: 'todo' as const });
		expect(() =>
			attestTask(t2, 'x', 'rejected', 'no', undefined, { humanBy: 'human@jojo' }),
		).toThrow('没有已交付的参与者可打回');
	});

	it('人类取消：closed 无 acceptance + human_forced_cancel', async () => {
		const org = await setupOrg();
		const t = await newTask(org, { title: '撤掉' });
		cancelTask(t, 'anyone', '人类取消', { humanBy: 'human@jojo' });
		expect(t.status).toBe('closed');
		expect(t.acceptance).toBeUndefined();
		expect(t.history.some((h) => h.event === 'human_forced_cancel')).toBe(true);
	});

	it('铁终态对人也生效：closed 后再人类操作 → 抛', async () => {
		const org = await setupOrg();
		const t = await newTask(org, { title: '终态' });
		cancelTask(t, 'x', '取消', { humanBy: 'human@jojo' });
		expect(() => cancelTask(t, 'x', 'again', { humanBy: 'human@jojo' })).toThrow('铁终态');
		expect(() =>
			attestTask(t, 'x', 'accepted', 'again', undefined, { humanBy: 'human@jojo' }),
		).toThrow('铁终态');
	});

	it('人类改派：移除僵死处理人（claimed）→ cancelled + 新成员 invited + human_forced_reassign；delivered 不可移除', async () => {
		const org = await setupOrg();
		const t = await newTask(org, {
			title: '改派',
			status: 'in_progress' as const,
			subTasks: [
				{
					id: 'S1',
					description: 'd',
					dueAt: null,
					assignees: [
						{
							agent: 'worker-a',
							dir: workerDir,
							status: 'claimed',
							round: 0,
							deliveries: [],
						},
					],
				},
			],
		});
		humanReassign(t, 'human@jojo', 'S1', 'worker-a', 'worker-b');
		const sub = t.subTasks[0];
		expect(sub.assignees.find((a) => a.agent === 'worker-a')?.status).toBe('cancelled');
		expect(sub.assignees.find((a) => a.agent === 'worker-b')?.status).toBe('invited');
		expect(t.history.some((h) => h.event === 'human_forced_reassign')).toBe(true);
		// delivered 焦点不可移除
		const t2 = await newTask(org, {
			title: '改派2',
			status: 'waiting_accept' as const,
			subTasks: [
				{
					id: 'S1',
					description: 'd',
					dueAt: null,
					assignees: [
						{
							agent: 'worker-a',
							dir: workerDir,
							status: 'delivered',
							round: 0,
							deliveries: [
								{ at: '2026-01-01', by: 'worker-a', summary: 'done', files: [] },
							],
						},
					],
				},
			],
		});
		expect(() => humanReassign(t2, 'human@jojo', 'S1', 'worker-a', 'worker-b')).toThrow(
			'已交付',
		);
	});
});

// ── 在线投递失败分类（02 · ADR-0039）───────────────────────────────────────

describe('投递失败分类（connect vs timeout）', () => {
	it('classifyRpcError：只把「已连上并发出后超时」判 timeout；未知错误保守判 connect（落 inbox 不丢）', async () => {
		const { classifyRpcError, rpcCall } = await import('../../../extensions/auto/org/util.js');
		// timeout 的唯一情形用**真实 rpcCall** 制造：接受连接但永不回应 → 等待回报超时。
		// 断言的是「打码 ↔ 分类」的契约，测试里不必再抄一份错误码字面量（防两处漂移）。
		const net = await import('node:net');
		// 服务端持有的连接必须显式销毁：否则 server.close() 的回调永不触发（测试挂死）
		const conns: { destroy: () => void }[] = [];
		const silent = net.createServer((s) => conns.push(s));
		const sockPath = join(tmpRoot, 'silent.sock');
		await new Promise<void>((resolve) => silent.listen(sockPath, () => resolve()));
		let timeoutError: unknown;
		try {
			await rpcCall(sockPath, { type: 'ping', id: 'probe' }, { timeoutMs: 150 });
		} catch (e) {
			timeoutError = e;
		}
		for (const c of conns) c.destroy();
		await new Promise<void>((resolve) => silent.close(() => resolve()));
		expect(timeoutError).toBeDefined();
		expect(classifyRpcError(timeoutError)).toBe('timeout');
		// 未连上 / 其它错误码 / 无码错误 → 一律保守落 inbox 兜底（宁重复，不静默丢消息）
		expect(classifyRpcError({ code: 'ECONNREFUSED' })).toBe('connect');
		expect(classifyRpcError({ code: 'ENOENT' })).toBe('connect');
		expect(classifyRpcError({ code: 'ETIMEDOUT' })).toBe('connect');
		expect(classifyRpcError(new Error('socket hang up after send'))).toBe('connect');
		expect(classifyRpcError(null)).toBe('connect');
	});

	it('deliverMessage：成员 runtime 指向不可达 socket（connect 类）→ 落 inbox 兜底不丢', async () => {
		const org = await setupOrg();
		// 给 worker-a 写一个假 runtime：socket 不存在 → isSocketAlive false → connect 兜底 inbox
		const { runtimeFile, inboxDir } = await import('../../../extensions/auto/org/orgstore.js');
		const { writeJsonAtomic } = await import('../../../extensions/auto/org/util.js');
		const { promises: fs } = await import('node:fs');
		await writeJsonAtomic(runtimeFile(org, 'worker-a'), {
			pid: 999999,
			socketPath: join(workerDir, 'no-such.sock'),
			sessionId: 's1',
			startedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		});
		const mode = await deliverMessage(org, 'worker-a', '[org:task] 离线任务指令');
		// 有 runtime 登记但不可达 → unreachable；从未登记 → inbox；两者都落 inbox 兜底
		expect(['inbox', 'unreachable']).toContain(mode);
		const inboxFiles = await fs.readdir(inboxDir(org, 'worker-a'));
		expect(inboxFiles.length).toBe(1);
		const { readJson } = await import('../../../extensions/auto/org/util.js');
		const rec = await readJson<{ message: string }>(
			join(inboxDir(org, 'worker-a'), inboxFiles[0]),
		);
		expect(rec?.message).toContain('离线任务指令');
	});
});

// ── 任务账本乐观写保护（03 · ADR-0039）──────────────────────────────────────

describe('saveTask 乐观写保护', () => {
	it('磁盘 updatedAt 更新（他方先写）→ 保存抛冲突且不覆写；快照同步后可存', async () => {
		const org = await setupOrg();
		const t = await newTask(org, { title: '并发任务' });
		// 模拟他方并发：直接改盘（title 变化 + updatedAt 后移）
		const { writeJsonAtomic, readJson } = await import('../../../extensions/auto/org/util.js');
		const { taskFile } = await import('../../../extensions/auto/org/orgstore.js');
		const later = new Date(Date.now() + 5000).toISOString();
		const diskNow = (await readJson<Task>(taskFile(org, t.id)))!;
		diskNow.title = '他方改的标题';
		diskNow.updatedAt = later;
		await writeJsonAtomic(taskFile(org, t.id), diskNow);
		// 本快照（旧 updatedAt）保存 → 冲突
		await expect(saveTask(t)).rejects.toThrow(/他方更新.*请重试/);
		// 磁盘未被旧快照覆写
		const after = (await readJson<Task>(taskFile(org, t.id)))!;
		expect(after.title).toBe('他方改的标题');
		expect(after.updatedAt).toBe(later);
		// 重新读取（快照同步）后可正常保存
		const fresh = (await readTask(org, t.id))!;
		fresh.title = '我改的标题';
		await saveTask(fresh);
		expect((await readTask(org, t.id))!.title).toBe('我改的标题');
	});

	it('串行读写（磁盘未变）→ 正常保存（回归）', async () => {
		const org = await setupOrg();
		const t = await newTask(org, { title: '串行任务' });
		t.background = '更新背景';
		await saveTask(t);
		expect((await readTask(org, t.id))!.background).toBe('更新背景');
	});

	it('同一毫秒内的他方写（updatedAt 相等、revision 前进）→ 仍判冲突（时间戳盲区）', async () => {
		const org = await setupOrg();
		const t = await newTask(org, { title: '同刻并发' });
		const { writeJsonAtomic, readJson } = await import('../../../extensions/auto/org/util.js');
		const { taskFile } = await import('../../../extensions/auto/org/orgstore.js');
		// 他方先写：updatedAt 与本快照**完全相同**（模拟同一毫秒），仅 revision 前进
		const diskNow = (await readJson<Task>(taskFile(org, t.id)))!;
		diskNow.title = '他方同刻改的';
		diskNow.revision = (diskNow.revision ?? 0) + 1;
		await writeJsonAtomic(taskFile(org, t.id), diskNow);
		await expect(saveTask(t)).rejects.toThrow(/他方更新.*请重试/);
		expect((await readJson<Task>(taskFile(org, t.id)))!.title).toBe('他方同刻改的');
	});
});

// ── 会话启动骨架（07 · ADR-0039）────────────────────────────────────────────

describe('会话启动对账与握手催办（07）', () => {
	it('collectStartupNotes：非负责人派发的 invited 握手 → 给处理人的 note 含任务编号与 accept 指引', async () => {
		const org = await setupOrg();
		const res = await dispatchTask({
			org,
			dispatcher: 'worker-a', // member 派发 → 握手
			dispatcherRole: 'member',
			title: '握手任务',
			background: 'bg',
			items: ['x'],
			targets: [{ agent: 'worker-b', description: '帮做' }],
		});
		const { collectStartupNotes } = await import('../../../extensions/auto/org/startup.js');
		const notes = await collectStartupNotes(org, 'worker-b');
		expect(notes.some((n) => n.includes('待确认握手请求') && n.includes(res.task.id))).toBe(
			true,
		);
		expect(notes.some((n) => n.includes('/org accept'))).toBe(true);
	});

	it('pendingHandshakeNote：有未决握手返回文案、无则 null（惰性催办复用点）', async () => {
		const org = await setupOrg();
		const { pendingHandshakeNote } = await import('../../../extensions/auto/org/startup.js');
		expect(await pendingHandshakeNote(org, 'worker-b')).toBeNull();
		const res = await dispatchTask({
			org,
			dispatcher: 'worker-a', // member 派发 → 握手
			dispatcherRole: 'member',
			title: '握手任务',
			background: 'bg',
			items: ['x'],
			targets: [{ agent: 'worker-b', description: '帮做' }],
		});
		const note = await pendingHandshakeNote(org, 'worker-b');
		expect(note).toContain('待确认握手请求');
		expect(note).toContain(res.task.id);
		// 派发人自己无未决握手 → null
		expect(await pendingHandshakeNote(org, 'worker-a')).toBeNull();
	});

	it('负责人单方派发（chief）不需握手确认 → 无握手催办；他人无关 issue 不过滤进来', async () => {
		const org = await setupOrg();
		await dispatchTask({
			org,
			dispatcher: 'chief',
			dispatcherRole: 'chief',
			title: '单方任务',
			background: '',
			items: [],
			targets: [{ agent: 'worker-a', description: 'x' }],
		});
		const { collectStartupNotes } = await import('../../../extensions/auto/org/startup.js');
		const notesA = await collectStartupNotes(org, 'worker-a');
		expect(notesA.some((n) => n.includes('待确认握手请求'))).toBe(false);
		// worker-b 无任何相关 → 空
		const notesB = await collectStartupNotes(org, 'worker-b');
		expect(notesB).toEqual([]);
	});

	it('对账 done 未交付 issue 只发给涉事成员（过滤他人）', async () => {
		const org = await setupOrg();
		const res = await dispatchTask({
			org,
			dispatcher: 'chief',
			dispatcherRole: 'chief',
			title: 'T',
			background: '',
			items: [],
			targets: [{ agent: 'worker-a', description: 'x' }],
		});
		const { projectTask, readTodoMap } =
			await import('../../../extensions/auto/org/todoproj.js');
		await projectTask(org, res.task.id);
		const map = await readTodoMap(org);
		const entry = map.find((m) => m.taskId === res.task.id && m.direction === 'in')!;
		const { writeFile, readFile } = await import('node:fs/promises');
		const fp = join(workerDir, '.pi', 'todos', `${entry.todoId}.md`);
		const raw = await readFile(fp, 'utf8');
		await writeFile(fp, raw.replace('"status": "open"', '"status": "done"'), 'utf8');
		const { collectStartupNotes } = await import('../../../extensions/auto/org/startup.js');
		const notesA = await collectStartupNotes(org, 'worker-a');
		expect(notesA.some((n) => n.includes('补交付'))).toBe(true);
		const notesB = await collectStartupNotes(org, 'worker-b');
		expect(notesB.some((n) => n.includes('补交付'))).toBe(false);
	});
});

// ── 公司改名迁移 / 负责人转移（人类管控）────────────────────────────────────

describe('公司改名与负责人转移（CRUD-U）', () => {
	it('renameOrg：目录 + org.json.name + 任务 .org + todo-map entry.org 全量迁移', async () => {
		const org = await setupOrg();
		await newTask(org, { title: '迁移任务' });
		const { projectTask, readTodoMap } =
			await import('../../../extensions/auto/org/todoproj.js');
		await projectTask(org, (await listTasks(org))[0].id);

		await renameOrg('dev-team', 'renamed-co');

		// 旧目录不存在、新目录就绪
		expect(await orgExists('dev-team')).toBe(false);
		expect(await orgExists('renamed-co')).toBe(true);
		expect((await readOrg('renamed-co')).name).toBe('renamed-co');
		// 任务 .org 字段迁移（listTasks 走新目录读取）
		const tasks = await listTasks('renamed-co');
		expect(tasks.length).toBe(1);
		expect(tasks[0].org).toBe('renamed-co');
		// todo-map entry.org 迁移
		const map = await readTodoMap('renamed-co');
		expect(map.length).toBeGreaterThan(0);
		expect(map.every((e) => e.org === 'renamed-co')).toBe(true);
	});

	it('renameOrg 校验：重名/不存在/同名拒绝', async () => {
		await setupOrg();
		await createOrg('other-co', { name: 'boss', dir: workerB });
		await expect(renameOrg('dev-team', 'other-co')).rejects.toThrow('已存在');
		await expect(renameOrg('nope', 'x')).rejects.toThrow('不存在');
		await expect(renameOrg('dev-team', 'dev-team')).rejects.toThrow('相同');
	});

	it('renameOrg：无 tasks 目录时正常完成（只吞 ENOENT）', async () => {
		await setupOrg(); // 未调 newTask → 无 tasks 目录
		await expect(renameOrg('dev-team', 'no-tasks-co')).resolves.toMatchObject({
			renamed: true,
		});
		expect((await readOrg('no-tasks-co')).name).toBe('no-tasks-co');
	});

	it('renameOrg：tasks 路径非目录（ENOTDIR）时必须冒泡，不得静默中止迁移', async () => {
		// 把 tasks/ 换成一个同名文件 → readdir 抛 ENOTDIR（非 ENOENT）
		const { taskDir } = await import('../../../extensions/auto/org/orgstore.js');
		await setupOrg();
		const { rm, writeFile } = await import('node:fs/promises');
		await rm(taskDir('dev-team'), { recursive: true, force: true });
		await writeFile(taskDir('dev-team'), 'not-a-directory');
		await expect(renameOrg('dev-team', 'renamed-co')).rejects.toThrow();
	});

	it('transferChief：新 chief 上任、原 chief 降普通成员、chiefName/Dir 同步', async () => {
		await setupOrg();
		await transferChief('dev-team', 'worker-a');
		const org = await readOrg('dev-team');
		expect(org.chiefName).toBe('worker-a');
		const { realpath } = await import('node:fs/promises');
		expect(org.chiefDir).toBe(await realpath(workerDir));
		expect(org.members.find((m) => m.name === 'worker-a')?.role).toBe('chief');
		expect(org.members.find((m) => m.name === 'chief')?.role).toBe('member');
		// 已是负责人 / 不存在成员 → 拒绝
		await expect(transferChief('dev-team', 'worker-a')).rejects.toThrow('已经是负责人');
		await expect(transferChief('dev-team', 'ghost')).rejects.toThrow('不在公司');
	});
});
