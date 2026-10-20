/**
 * org 干预面（中断 / 抢占 / 重试）与任务命令的**授权 + 落盘**（ADR-0053 `D2`/`D3`/`D5`、ADR-0055 `D6`）。
 *
 * 缺口背景（审查 P1/P2）：
 *  ① `/org abort`、`org_abort`、`/org urgent`、`org_urgent`、`/org retry` 五条新面此前**零测试**。
 *     权限面 = **工具面**（`org_abort`/`org_urgent`，仅该 org 负责人，ADR-0048 `D5`）
 *     + **命令面**（`/org abort`、`/org urgent`，人类操作台，**不校验负责人**，ADR-0041 `D3`/
 *     ADR-0053 `D2`/ADR-0055 `D6`）。工具面的负责人校验一旦回退（删一行 `chiefName` 比较），
 *     任意成员即可中断/抢占任意成员（权限放大），而 CI 不会有任何信号；
 *  ② 命令路径的**聚合状态落盘**（`refreshTaskStatus`）无用例：`claim` / `accept` / `report` 后
 *     账本 `task.status` 若停在 `todo`，看板与在岗简报会长期显示陈旧状态（正是本次修复的缺陷）。
 *
 * 口径：用 stub pi 驱动扩展工厂，**只桩外部边界**——`interruptMember`（真 socket）、
 * `deliverMessage`（真 socket / 落盘投递 + 唤醒）、`isSelfOnDuty`（真 socket 探测）、
 * `ensureAwakeForDispatch`（真 tmux）。账本、runtime、权限判定、命令路由全走真实代码。
 * 工具面的**在岗可见性**（注册/收放）另由 e2e 覆盖（`smoke.test.sh` 用例 8，用例 17 走真实 `org_urgent`）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── 桩：仅替换四个外部边界，其余导出保持真实（供 `preempt`/`dispatch` 间接使用）──
const { interruptMemberMock, deliverMessageMock, ensureAwakeMock, isSelfOnDutyMock, logger } =
	vi.hoisted(() => ({
		interruptMemberMock: vi.fn(),
		deliverMessageMock: vi.fn(),
		ensureAwakeMock: vi.fn(),
		isSelfOnDutyMock: vi.fn(),
		logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	}));

// 日志桩：降噪（不落盘），并用于断言「中断失败必须留痕」
vi.mock('@zenone/pi-logger', () => ({ createLogger: () => logger }));
vi.mock('../../../extensions/auto/org/activity.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../extensions/auto/org/activity.js')>()),
	interruptMember: interruptMemberMock,
}));
vi.mock('../../../extensions/auto/org/dispatch.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../extensions/auto/org/dispatch.js')>()),
	deliverMessage: deliverMessageMock,
}));
vi.mock('../../../extensions/auto/org/lifecycle.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../extensions/auto/org/lifecycle.js')>()),
	ensureAwakeForDispatch: ensureAwakeMock,
}));
vi.mock('../../../extensions/auto/org/onduty.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../extensions/auto/org/onduty.js')>()),
	isSelfOnDuty: isSelfOnDutyMock,
}));

import ext from '../../../extensions/auto/org/index.js';
import { peekInbox } from '../../../extensions/auto/org/inbox.js';
import {
	createOrg,
	joinOrg,
	runtimeDir,
	runtimeFile,
} from '../../../extensions/auto/org/orgstore.js';
import { createTaskWithId, readTask, saveTask } from '../../../extensions/auto/org/task.js';
import { writeJsonAtomic } from '../../../extensions/auto/org/util.js';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const ORG = 'dev-team';
const ORG_B = 'other-co';

let tmpRoot = '';
let origCwd = '';
let chiefDir = '';
let memberDir = '';
let bossDir = '';

/** 命令面输出捕获：`respond`（sendMessage）与 `notifyHuman`（ui.notify）合并为一份可断言文本 */
let sent: string[] = [];
let notices: string[] = [];
let cmdHandler: (args: string, ctx: unknown) => Promise<void>;
const tools = new Map<string, { execute: (id: string, p: unknown) => Promise<unknown> }>();
const handlers = new Map<string, (...a: unknown[]) => unknown>();

const ctx = {
	hasUI: true,
	cwd: process.cwd(),
	ui: {
		notify: (m: string) => notices.push(m),
		setStatus: () => undefined,
		theme: { fg: (_c: string, t: string) => t },
	},
	sessionManager: { getSessionId: () => 'sess-test' },
} as never;

function stubPi(): ExtensionAPI {
	const pi = {
		on: (name: string, h: (...a: unknown[]) => unknown) => {
			handlers.set(name, h);
		},
		events: { on: () => undefined, emit: () => undefined },
		sendMessage: (msg: { content: string }) => {
			sent.push(msg.content);
		},
		registerCommand: (_name: string, def: { handler: typeof cmdHandler }) => {
			cmdHandler = def.handler;
		},
		registerTool: (def: { name: string }) => {
			tools.set(def.name, def as never);
		},
		getActiveTools: () => [] as string[],
		setActiveTools: () => undefined,
		registerProvider: () => undefined,
	} as unknown as ExtensionAPI;
	ext(pi);
	return pi;
}

/** 在 `dir` 写 agent manifest（身份 = 目录自述） */
function writeManifest(dir: string, name: string, role: 'chief' | 'member'): void {
	writeFileSync(join(dir, 'pi.agent.json'), JSON.stringify({ name, role }));
}

/** 切到 `dir` 执行一次命令，返回本次的全部输出（命令回复 + 面向人的提示） */
async function runCmd(dir: string, args: string): Promise<string> {
	process.chdir(dir);
	sent = [];
	notices = [];
	await cmdHandler(args, ctx);
	return [...sent, ...notices].join('\n');
}

/** 调一次已注册工具，取其文本结果 */
async function runTool(name: string, params: unknown): Promise<string> {
	const tool = tools.get(name);
	if (!tool) throw new Error(`工具 ${name} 未注册（在岗前不可见）`);
	const res = (await tool.execute('call-1', params)) as {
		content: { type: string; text: string }[];
	};
	return res.content.map((c) => c.text).join('\n');
}

/** 让 `dir` 进入在岗（走真实 `session_start` → `goOnDuty`；仅 socket 探测被桩） */
async function goOnDutyAs(dir: string): Promise<void> {
	process.chdir(dir);
	isSelfOnDutyMock.mockResolvedValue(true);
	await handlers.get('session_start')!({}, ctx);
}

/** 造一条任务（assignee 的 dir 指向对应目录） */
async function seedTask(over: {
	dispatcherRole?: 'chief' | 'member';
	assignees?: { agent: string; status: string; dir?: string }[];
	status?: 'todo' | 'in_progress' | 'waiting_accept' | 'closed';
}) {
	const subAssignees = (over.assignees ?? [{ agent: 'worker-a', status: 'invited' }]).map(
		(a) => ({
			agent: a.agent,
			dir: a.dir ?? memberDir,
			status: a.status,
			round: 0,
			stopped: false,
			deliveries: [],
		}),
	);
	const t = await createTaskWithId(ORG, {
		org: ORG,
		title: '写一份周报并给出证据',
		background: '背景说明',
		items: ['产出 docs/weekly.md'],
		dispatcher: over.dispatcherRole === 'chief' ? 'chief-1' : 'worker-a',
		dispatcherRole: over.dispatcherRole ?? 'chief',
		createdAt: new Date().toISOString(),
		status: over.status ?? 'todo',
		subTasks: [{ id: 'S1', description: '写周报', dueAt: null, assignees: subAssignees }],
		history: [],
	} as never);
	await saveTask(t);
	return t;
}

/** 让某成员「在岗」：写 runtime（含 control socket 路径） */
async function putOnDutyRuntime(dir: string, agent: string): Promise<void> {
	mkdirSync(runtimeDir(ORG), { recursive: true });
	await writeJsonAtomic(runtimeFile(ORG, agent), {
		schemaVersion: 1,
		name: agent,
		dir,
		pid: process.pid,
		socketPath: '/tmp/does-not-matter.sock',
		sessionId: 'sess-test',
		busy: false,
		startedAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	});
}

beforeEach(async () => {
	tmpRoot = mkdtempSync(join(tmpdir(), 'org-intervene-'));
	origCwd = process.cwd();
	process.env.ORG_ROOT = join(tmpRoot, 'orgdata');
	chiefDir = join(tmpRoot, 'chief');
	memberDir = join(tmpRoot, 'worker-a');
	bossDir = join(tmpRoot, 'boss');
	for (const d of [chiefDir, memberDir, bossDir]) mkdirSync(d, { recursive: true });
	writeManifest(chiefDir, 'chief-1', 'chief');
	writeManifest(memberDir, 'worker-a', 'member');
	writeManifest(bossDir, 'boss', 'chief');
	await createOrg(ORG, { name: 'chief-1', dir: chiefDir });
	await joinOrg(ORG, { manifest: { name: 'worker-a', role: 'member' }, dir: memberDir });
	// 第二个 org（负责人 boss），用于「你不在组织」分支
	await createOrg(ORG_B, { name: 'boss', dir: bossDir });

	interruptMemberMock.mockReset();
	interruptMemberMock.mockResolvedValue({ ok: true, entries: [] });
	deliverMessageMock.mockReset();
	deliverMessageMock.mockResolvedValue('online');
	ensureAwakeMock.mockReset();
	ensureAwakeMock.mockResolvedValue(false);
	isSelfOnDutyMock.mockReset();
	isSelfOnDutyMock.mockResolvedValue(false);
	logger.warn.mockClear();
	sent = [];
	notices = [];
	tools.clear();
	handlers.clear();
	stubPi();
});

afterEach(async () => {
	// 收尾在岗副作用（状态栏定时器 / runtime 文件），避免跨用例残留
	await handlers.get('session_shutdown')?.({}, ctx);
	process.chdir(origCwd);
	// ⚠ 不要 `delete process.env.ORG_ROOT`：命令路径的 `projectTask` 是 **fire-and-forget**
	// （`extensions/auto/org/index.ts:1449`），它解析写盘路径发生在多个 `await` 之后——若此时
	// 环境变量已被删除，`orgRoot()` 会回落到**真实 `~/.pi/org`**，把用例数据写进用户环境
	// （实测污染了 `~/.pi/org/dev-team/todo-map.json`，并会让 e2e 的「环境哨兵」判隔离失效）。
	// 指向本用例自己的临时子目录即可：迟到的写入落在 /tmp，绝不越界。
	process.env.ORG_ROOT = join(tmpRoot, 'late');
	rmSync(tmpRoot, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════════════════════════
describe('/org abort（中断当前轮，ADR-0053 D2/D3/D7）', () => {
	it('负责人中断在岗成员 → 回执成功，且用 runtime 里的 socket 发起中断', async () => {
		await putOnDutyRuntime(memberDir, 'worker-a');
		const out = await runCmd(chiefDir, 'abort worker-a');
		expect(out).toContain('已中断 worker-a 的当前轮');
		expect(interruptMemberMock).toHaveBeenCalledWith('/tmp/does-not-matter.sock');
	});

	it('非负责人用命令面 → 放行（人类操作台永远可用，ADR-0053 D2 / CONTEXT「中断」）', async () => {
		await putOnDutyRuntime(chiefDir, 'chief-1');
		const out = await runCmd(memberDir, 'abort chief-1');
		expect(out).toContain('已中断 chief-1 的当前轮');
		expect(interruptMemberMock).toHaveBeenCalled();
	});

	it('目标不是该 org 成员 → 据实说明（不去动 socket）', async () => {
		const out = await runCmd(chiefDir, 'abort nobody');
		expect(out).toContain('成员 nobody 不在组织');
		expect(interruptMemberMock).not.toHaveBeenCalled();
	});

	it('你不在该 org → 拒绝', async () => {
		const out = await runCmd(memberDir, `abort ${ORG_B} worker-a`);
		expect(out).toContain('你不在组织');
		expect(interruptMemberMock).not.toHaveBeenCalled();
	});

	it('成员不在岗（无 runtime/socket）→ 说明「无需中断」，不假装成功', async () => {
		const out = await runCmd(chiefDir, 'abort worker-a');
		expect(out).toContain('不在岗（无需中断）');
		expect(interruptMemberMock).not.toHaveBeenCalled();
	});

	it.each([
		['unsupported', '成员进程不支持该命令（版本旧）'],
		['timeout', '成员无响应（可能版本旧或正忙）'],
		['unreachable', '成员进程不可达（可能已退出）'],
	] as const)('中断失败（%s）→ 据实回报 + 留痕 warn', async (reason, text) => {
		await putOnDutyRuntime(memberDir, 'worker-a');
		interruptMemberMock.mockResolvedValue({ ok: false, reason, entries: [] });
		const out = await runCmd(chiefDir, 'abort worker-a');
		expect(out).toContain('未中断 worker-a');
		expect(out).toContain(text);
		expect(logger.warn).toHaveBeenCalledWith(
			'成员中断失败',
			expect.objectContaining({ member: 'worker-a', reason }),
		);
	});

	it('缺目标 → 用法提示', async () => {
		const out = await runCmd(chiefDir, 'abort');
		expect(out).toContain('用法：/org abort <成员名>');
	});

	it('别名 interrupt 同款', async () => {
		await putOnDutyRuntime(memberDir, 'worker-a');
		expect(await runCmd(chiefDir, 'interrupt worker-a')).toContain('已中断 worker-a');
	});
});

// ══════════════════════════════════════════════════════════════════════════
describe('org_abort 工具（在岗注册后的工具面权限）', () => {
	it('在岗后工具可见；负责人调用成功', async () => {
		await goOnDutyAs(chiefDir);
		await putOnDutyRuntime(memberDir, 'worker-a');
		expect(await runTool('org_abort', { member: 'worker-a' })).toContain(
			'已中断 worker-a 的当前轮',
		);
	});

	it('非负责人调用 → 拒绝（工具面独立接线，与命令面同口径）', async () => {
		await getOnDutyAsMember();
		const out = await runTool('org_abort', { member: 'chief-1' });
		expect(out).toContain('未中断 chief-1');
		expect(out).toContain('中断权限限本 org 负责人');
		expect(interruptMemberMock).not.toHaveBeenCalled();
	});
});

/** 以 worker-a（普通成员）身份上岗 */
async function getOnDutyAsMember(): Promise<void> {
	await goOnDutyAs(memberDir);
}

// ══════════════════════════════════════════════════════════════════════════
describe('/org urgent（显式抢占，ADR-0055 D6）', () => {
	it('非负责人用命令面 → 放行（人类操作台，ADR-0055 D6「人类或该 org 负责人」）', async () => {
		await putOnDutyRuntime(chiefDir, 'chief-1');
		const out = await runCmd(memberDir, 'urgent chief-1 先看这个');
		expect(out).toContain('抢占 chief-1');
		expect(out).toContain('插话');
		expect(deliverMessageMock).toHaveBeenCalled();
	});

	it('缺内容 → 用法提示', async () => {
		expect(await runCmd(chiefDir, 'urgent worker-a')).toContain('请给出要插话的内容');
	});

	it('默认只插话：投递走 steer，不发起中断', async () => {
		await putOnDutyRuntime(memberDir, 'worker-a');
		const out = await runCmd(chiefDir, 'urgent worker-a 先看这个');
		expect(out).toContain('插话');
		expect(out).toContain('已在线送达');
		expect(interruptMemberMock).not.toHaveBeenCalled();
		expect(deliverMessageMock).toHaveBeenCalledWith(
			ORG,
			'worker-a',
			expect.stringContaining('先看这个'),
			expect.objectContaining({ mode: 'steer' }),
		);
	});

	it('--hard → 先中断再投递（hard 生效时回报「硬抢占」）', async () => {
		await putOnDutyRuntime(memberDir, 'worker-a');
		const out = await runCmd(chiefDir, 'urgent worker-a 停手改做这个 --hard');
		expect(out).toContain('硬抢占');
		expect(out).toContain('已中断其当前轮');
		expect(interruptMemberMock).toHaveBeenCalledTimes(1);
		expect(deliverMessageMock.mock.calls[0]?.[1]).toBe('worker-a');
	});

	it('正文是任务号 → 消息写成「优先处理任务 M-xxx」', async () => {
		await putOnDutyRuntime(memberDir, 'worker-a');
		await runCmd(chiefDir, 'urgent worker-a M-abc123');
		const msg = String(deliverMessageMock.mock.calls[0]?.[2] ?? '');
		expect(msg).toContain('优先处理任务 M-abc123');
		expect(msg).toContain('chief-1');
	});
});

describe('org_urgent 工具（在岗注册后的工具面权限）', () => {
	it('非负责人调用 → 拒绝并回报负责人', async () => {
		await getOnDutyAsMember();
		const out = await runTool('org_urgent', { member: 'chief-1', message: '插个话' });
		expect(out).toContain('抢占权限限本 org 负责人');
		expect(deliverMessageMock).not.toHaveBeenCalled();
	});
});

// ══════════════════════════════════════════════════════════════════════════
describe('/org retry（重投递，ADR-0053 D5）', () => {
	it('缺任务号 → 用法提示', async () => {
		expect(await runCmd(chiefDir, 'retry')).toContain('用法：/org retry <任务编号>');
	});

	it('任务不存在 → 据实说明', async () => {
		expect(await runCmd(chiefDir, 'retry M-nope')).toContain('任务 M-nope 不存在');
	});

	it('已交付 → 不给重试，指出「打回 / 改派」出路', async () => {
		const t = await seedTask({ assignees: [{ agent: 'worker-a', status: 'delivered' }] });
		const out = await runCmd(chiefDir, `retry ${t.id}`);
		expect(out).toContain('没有可重试的参与者');
		expect(out).toContain('打回');
		expect(deliverMessageMock).not.toHaveBeenCalled();
	});

	it('invited/claimed/returned → 逐个重投并落 retried 历史（投递走真实通道：不在岗落 inbox）', async () => {
		const t = await seedTask({
			assignees: [
				{ agent: 'worker-a', status: 'invited' },
				{ agent: 'boss', status: 'returned', dir: bossDir },
			],
		});
		const out = await runCmd(chiefDir, `retry ${t.id}`);
		expect(out).toContain(`重试 ${t.id}`);
		expect(out.match(/ok /g) ?? []).toHaveLength(2);
		const after = (await readTask(ORG, t.id))!;
		expect(after.history.filter((h) => h.event === 'retried')).toHaveLength(2);
		// 真投递（`retrySubTask` 内部调 `deliverMessage`，非跨模块调用，故以落盘的收件箱为观测点）
		expect((await peekInbox(ORG, 'worker-a')).some((r) => r.message.includes(t.id))).toBe(true);
		expect((await peekInbox(ORG, 'boss')).some((r) => r.message.includes(t.id))).toBe(true);
	});

	it('指定成员名 → 只重投该成员', async () => {
		const t = await seedTask({
			assignees: [
				{ agent: 'worker-a', status: 'invited' },
				{ agent: 'boss', status: 'invited', dir: bossDir },
			],
		});
		await runCmd(chiefDir, `retry ${t.id} boss`);
		expect(await peekInbox(ORG, 'worker-a')).toHaveLength(0);
		expect(await peekInbox(ORG, 'boss')).toHaveLength(1);
	});
});

// ══════════════════════════════════════════════════════════════════════════
describe('任务命令的聚合状态落盘（看板/简报的数据源）', () => {
	it('/org claim → 账本 status 落 in_progress（不得停在 todo）', async () => {
		const t = await seedTask({ status: 'todo' });
		await runCmd(memberDir, `claim ${t.id}`);
		expect((await readTask(ORG, t.id))!.status).toBe('in_progress');
	});

	it('/org accept（握手任务）→ 账本 status 落 in_progress + accepted 历史', async () => {
		const t = await seedTask({ dispatcherRole: 'member', status: 'todo' });
		await runCmd(memberDir, `accept ${t.id}`);
		const after = (await readTask(ORG, t.id))!;
		expect(after.status).toBe('in_progress');
		expect(after.history.some((h) => h.event === 'accepted')).toBe(true);
	});

	it('/org report（全部交付齐）→ 账本 status 落 waiting_accept', async () => {
		const t = await seedTask({
			status: 'in_progress',
			assignees: [{ agent: 'worker-a', status: 'claimed' }],
		});
		await runCmd(memberDir, `report ${t.id} 已完成，附证据`);
		const after = (await readTask(ORG, t.id))!;
		expect(after.status).toBe('waiting_accept');
		expect(after.subTasks[0].assignees[0].status).toBe('delivered');
	});

	it('/org report（还有人没交）→ 账本 status 保持 in_progress', async () => {
		const t = await seedTask({
			status: 'in_progress',
			assignees: [
				{ agent: 'worker-a', status: 'claimed' },
				{ agent: 'boss', status: 'claimed', dir: bossDir },
			],
		});
		await runCmd(memberDir, `report ${t.id} 我先交`);
		const after = (await readTask(ORG, t.id))!;
		expect(after.status).toBe('in_progress');
	});
});
