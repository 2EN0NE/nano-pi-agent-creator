/**
 * 在岗简报（ADR-0042）+ 成员简档刷新（ADR-0042 D6 / ticket 06）单元测试。
 *
 * 静态块：内容与角色指路、缺失字段兜底；
 * 动态块：只列在岗成员 + 状态 + 一行计数；
 * 简档刷新：路径①在岗注册回写、路径②看板 r 重读全体、路径③简报只读（不改 mtime）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:net';
import {
	createOrg,
	joinOrg,
	readOrg,
	refreshAllMemberManifests,
	refreshMemberManifest,
} from '../../../extensions/auto/org/orgstore.js';
import {
	buildDynamicBriefing,
	buildStaticBriefing,
	countWork,
	remainingText,
} from '../../../extensions/auto/org/briefing.js';
import { dispatchTask } from '../../../extensions/auto/org/dispatch.js';
import { peekInbox } from '../../../extensions/auto/org/inbox.js';
import { claimSlot } from '../../../extensions/auto/org/slot.js';
import { orgConfigStore, resolveMemberQueueCap } from '../../../extensions/auto/org/config.js';
import { visibleWidth } from '@earendil-works/pi-tui';
import { closeServers, listenFakeControl, writeRuntimeFile } from './org-lifecycle-helpers.js';
import { inboxDir, orgFile } from '../../../extensions/auto/org/orgstore.js';
import type { Task } from '../../../extensions/auto/org/types.js';

const ORG = 'dev-team';
let root = '';
let chiefDir = '';
let workerDir = '';
let workerBDir = '';
let servers: Server[] = [];

function writeManifest(dir: string, obj: Record<string, unknown>): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, 'pi.agent.json'), JSON.stringify(obj), 'utf8');
}

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), 'org-brief-'));
	process.env.ORG_ROOT = root;
	chiefDir = join(root, 'chief');
	workerDir = join(root, 'worker');
	workerBDir = join(root, 'worker-b');
	writeManifest(chiefDir, { name: 'chief', role: 'chief', description: '定方向' });
	writeManifest(workerDir, { name: 'worker-a', role: 'member', description: '写解析器' });
	writeManifest(workerBDir, { name: 'worker-b', role: 'member' });
	await createOrg(ORG, { name: 'chief', dir: chiefDir, description: '定方向' });
	await joinOrg(ORG, { manifest: { name: 'worker-a', role: 'member' }, dir: workerDir });
	await joinOrg(ORG, { manifest: { name: 'worker-b', role: 'member' }, dir: workerBDir });
	servers = [];
});

afterEach(async () => {
	await closeServers(servers);
	rmSync(root, { recursive: true, force: true });
});

async function goOnline(name: string, busy = false): Promise<void> {
	const socketPath = join(root, `${name}.sock`);
	servers.push(await listenFakeControl(socketPath));
	await writeRuntimeFile(ORG, name, { socketPath, pid: process.pid, busy });
}

describe('buildStaticBriefing（静态块，ADR-0042 D2）', () => {
	it('负责人：含组织/角色/简介/背景/技能指路 org-chief', () => {
		const text = buildStaticBriefing({
			org: ORG,
			memberName: 'chief',
			role: 'chief',
			description: '定方向',
			background: '做目录绑定多 agent',
		});
		expect(text).toContain('[org 在岗简报]');
		expect(text).toContain(`${ORG} / 负责人（chief）`);
		expect(text).toContain('职责：定方向');
		expect(text).toContain('组织背景：做目录绑定多 agent');
		expect(text).toContain('org-chief');
		expect(text).not.toContain('org-member');
	});

	it('成员：技能指路指向 org-member', () => {
		const text = buildStaticBriefing({
			org: ORG,
			memberName: 'worker-a',
			role: 'member',
			description: '写解析器',
		});
		expect(text).toContain('org-member');
		expect(text).not.toContain('org-chief');
	});

	it('简介/背景缺失时显式标注（未填写），不留空标题', () => {
		const text = buildStaticBriefing({ org: ORG, memberName: 'w', role: 'member' });
		expect(text).toContain('职责：（未填写）');
		expect(text).toContain('组织背景：（未填写）');
	});

	it('含成员消息的来源约定（ADR-0044 D4）：说明带 <sender_info> 的是成员而非人类', () => {
		const text = buildStaticBriefing({
			org: ORG,
			memberName: 'chief',
			role: 'chief',
			background: 'bg',
		});
		expect(text).toContain('来源约定');
		expect(text).toContain('<sender_info>');
		expect(text).toContain('不是人类操作者');
	});

	it('超长组织背景被截断并标注（防止撑爆每轮系统提示）', () => {
		const text = buildStaticBriefing({
			org: ORG,
			memberName: 'chief',
			role: 'chief',
			background: '背景'.repeat(1000),
		});
		expect(text).toContain('（已截断）');
		const bgLine = text.split('\n').find((l) => l.startsWith('组织背景：')) ?? '';
		expect(visibleWidth(bgLine)).toBeLessThanOrEqual(1220);
	});

	it('纯函数：同输入两次结果逐字节相同（系统提示恒定 → 缓存稳定）', () => {
		const input = { org: ORG, memberName: 'chief', role: 'chief' as const, background: 'b' };
		expect(buildStaticBriefing(input)).toBe(buildStaticBriefing(input));
	});
});

describe('countWork（动态块的一行计数）', () => {
	function task(over: Partial<Task>): Task {
		return {
			id: 'T1',
			org: ORG,
			title: 't',
			background: 'b',
			items: [],
			dispatcher: 'chief',
			dispatcherRole: 'chief',
			createdAt: '',
			updatedAt: '',
			status: 'in_progress',
			subTasks: [],
			...over,
		} as Task;
	}
	const assignee = (agent: string, status: string, stopped = false) =>
		({ agent, status, round: 0, deliveries: [], stopped }) as never;

	it('只统计未关闭任务', () => {
		const tasks = [
			task({ id: 'T1', status: 'in_progress' }),
			task({ id: 'T2', status: 'closed' }),
		];
		expect(countWork(tasks, 'chief').dispatched).toBe(1);
	});

	it('我接 = 名下有 invited/claimed/returned 的子任务', () => {
		const tasks = [
			task({
				id: 'T1',
				subTasks: [
					{ id: 'S1', description: 'd', assignees: [assignee('worker-a', 'claimed')] },
				] as never,
			}),
		];
		expect(countWork(tasks, 'worker-a').received).toBe(1);
		expect(countWork(tasks, 'worker-b').received).toBe(0);
	});

	it('待我验收 = 我派发且有人已交付（stopped 的不算）', () => {
		const tasks = [
			task({
				id: 'T1',
				subTasks: [
					{ id: 'S1', description: 'd', assignees: [assignee('worker-a', 'delivered')] },
				] as never,
			}),
			task({
				id: 'T2',
				subTasks: [
					{
						id: 'S2',
						description: 'd',
						assignees: [assignee('worker-a', 'delivered', true)],
					},
				] as never,
			}),
		];
		expect(countWork(tasks, 'chief').awaitingMe).toBe(1);
	});
});

describe('buildDynamicBriefing（动态块，ADR-0042 D3）', () => {
	it('只列在岗成员并标状态；睡眠成员不出现；自己带（我）', async () => {
		await goOnline('chief');
		await goOnline('worker-a', true);
		// worker-b 无 runtime → 睡眠
		const text = await buildDynamicBriefing(ORG, 'chief');
		expect(text).toContain('在岗（2/3）');
		expect(text).toContain('chief 空闲（我）');
		expect(text).toContain('worker-a 工作中');
		expect(text).not.toContain('worker-b');
		expect(text).toContain('未结：我派 0 · 我接 0 · 待我验收 0 · inbox 0');
	});

	it('计数随任务变化：派发后「我派」+1；投递给离线成员入 inbox 可数', async () => {
		await goOnline('chief');
		await dispatchTask({
			org: ORG,
			dispatcher: 'chief',
			dispatcherRole: 'chief',
			title: '任务一',
			background: 'b',
			items: ['x'],
			targets: [{ agent: 'worker-a', description: '写出报告', dueAt: null }],
		});
		const text = await buildDynamicBriefing(ORG, 'chief');
		expect(text).toContain('我派 1');
	});

	it('无人在岗时块仍成立', async () => {
		const text = await buildDynamicBriefing(ORG, 'chief');
		expect(text).toContain('在岗（0/3）：（暂时无人在岗）');
	});

	it('只读：不修改 org.json（mtime 不变）— ADR-0042 D6③', async () => {
		await goOnline('chief');
		const before = statSync(orgFile(ORG)).mtimeMs;
		await new Promise((r) => setTimeout(r, 20));
		await buildDynamicBriefing(ORG, 'chief');
		expect(statSync(orgFile(ORG)).mtimeMs).toBe(before);
	});
});

describe('buildDynamicBriefing（ADR-0054 D5 / ADR-0055 D2/D3/D4/D5）', () => {
	/** 往某成员收件箱写一条记录（等价于投递侧落盘，避免依赖 socket） */
	function putInbox(member: string, id: string, message: string): void {
		const dir = inboxDir(ORG, member);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, `${id}.json`),
			JSON.stringify({ at: '2026-09-14T00:00:00.000Z', message }),
		);
	}

	it('收件箱内容清单化（D5）：列出 [msg:id] 与正文，而非只有计数', async () => {
		await goOnline('chief');
		putInbox('chief', 'msg-1', '请先看 A');
		putInbox('chief', 'msg-2', '再做 B');

		const text = await buildDynamicBriefing(ORG, 'chief');
		expect(text).toContain('inbox 2');
		expect(text).toContain('收件箱内容（未处理）：');
		expect(text).toContain('[msg:msg-1]');
		expect(text).toContain('请先看 A');
	});

	it('简报是只读的（D5：peek 不删）——消化只由 flushInbox 负责', async () => {
		await goOnline('chief');
		putInbox('chief', 'msg-1', '别丢了我');
		await buildDynamicBriefing(ORG, 'chief');
		// 回归防守：若简报改回删除式读取，内容会在消化前被清掉 → 任务静默丢失
		expect((await peekInbox(ORG, 'chief')).map((r) => r.id)).toEqual(['msg-1']);
	});

	it('队列 / 在执行 / 期限（D2/D3/D4/D5）：有信息才出现', async () => {
		const dueAt = new Date(Date.now() + 3_600_000).toISOString();
		await dispatchTask({
			org: ORG,
			dispatcher: 'chief',
			dispatcherRole: 'chief',
			title: '带期限的任务',
			background: 'bg',
			items: ['a'],
			targets: [{ agent: 'worker-a', description: '做 A', dueAt }],
		});
		await claimSlot(ORG, 'worker-a', { taskId: 'M-exec', subTaskId: 'S-1' });

		const text = await buildDynamicBriefing(ORG, 'worker-a');
		const cap = resolveMemberQueueCap(orgConfigStore.get().memberQueueCap);
		expect(text).toContain('我手上：正在执行 M-exec/S-1');
		expect(text).toContain(
			`待办队列：1${cap === undefined ? '（未设上限）' : `/${cap}（上限）`}`,
		);
		expect(text).toContain('期限：');
		expect(text).toMatch(/剩 \d/);
	});

	it('无任何信息时不出现空占位行（不做推测性展示）', async () => {
		await goOnline('chief');
		const text = await buildDynamicBriefing(ORG, 'chief');
		expect(text).not.toContain('我手上：');
		expect(text).not.toContain('收件箱内容');
	});
});

describe('remainingText（剩余/逾期时长的人话）', () => {
	it('未到期 → 剩 h/m；已过期 → 已逾期', () => {
		const now = Date.parse('2026-09-14T12:00:00.000Z');
		expect(remainingText('2026-09-14T13:30:00.000Z', now)).toBe('剩 1h30m');
		expect(remainingText('2026-09-14T12:00:30.000Z', now)).toBe('剩 1m');
		expect(remainingText('2026-09-14T11:30:00.000Z', now)).toBe('已逾期 30m');
	});

	it('非法时间 → 空串（不抛错）', () => {
		expect(remainingText('not-a-date', 0)).toBe('');
	});
});

describe('成员简档刷新（ADR-0042 D6）', () => {
	it('① 在岗注册回写：与目录 pi.agent.json 对齐，幂等', async () => {
		const changed = await refreshMemberManifest(ORG, chiefDir, {
			description: '新职责',
		});
		expect(changed).toBe(true);
		const member = (await readOrg(ORG)).members.find((m) => m.name === 'chief');
		expect(member?.manifest.description).toBe('新职责');
		expect(await refreshMemberManifest(ORG, chiefDir, { description: '新职责' })).toBe(false);
	});

	it('① 目录不是成员时不写盘', async () => {
		const before = statSync(orgFile(ORG)).mtimeMs;
		expect(await refreshMemberManifest(ORG, join(root, 'stranger'), { description: 'x' })).toBe(
			false,
		);
		expect(statSync(orgFile(ORG)).mtimeMs).toBe(before);
	});

	it('② 看板 r：重读全体成员目录并对齐（含改简介与新增缺失）', async () => {
		writeManifest(workerDir, { name: 'worker-a', role: 'member', description: '改了简介' });
		writeFileSync(join(workerBDir, 'pi.agent.json'), '{ 坏 JSON', 'utf8');
		const changed = await refreshAllMemberManifests(ORG);
		expect(changed).toBe(1);
		const org = await readOrg(ORG);
		expect(org.members.find((m) => m.name === 'worker-a')?.manifest.description).toBe(
			'改了简介',
		);
		// worker-b 的 JSON 非法 → 保留原快照（不破坏）
		expect(org.members.find((m) => m.name === 'worker-b')?.manifest).toEqual({});
	});

	it('② 收紧后无变化时返回 0 且不写盘（收敛幂等）', async () => {
		// 首次对齐（join 用的是行内 manifest，与目录里的 pi.agent.json 可能不同）
		await refreshAllMemberManifests(ORG);
		const before = statSync(orgFile(ORG)).mtimeMs;
		expect(await refreshAllMemberManifests(ORG)).toBe(0);
		expect(statSync(orgFile(ORG)).mtimeMs).toBe(before);
	});
});
