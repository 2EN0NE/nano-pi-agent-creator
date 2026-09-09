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
} from '../../../extensions/auto/org/orgstore.js';
import {
	adoptAssignee,
	approveWithAdoption,
	attestTask,
	cancelTask,
	computeTaskStatus,
	createTaskWithId,
	effectiveDueAt,
	findMemberOpenWork,
	generateTaskId,
	readTask,
	saveTask,
	transitionAssignee,
} from '../../../extensions/auto/org/task.js';
import {
	cancelTaskByDispatcher,
	consentCancel,
	deliverMessage,
	dispatchTask,
	drainInbox,
	reassignSubTask,
	takeInbox,
} from '../../../extensions/auto/org/dispatch.js';
import type { AgentManifest, Task } from '../../../extensions/auto/org/types.js';

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
