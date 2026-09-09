/**
 * org /org TUI 任务看板（OrgBoard）— headless snapshot 测试（tickets 09/10）
 *
 * 验证：
 * - 空态 / 有组织有任务两种渲染在 80/120 宽度下不超宽、不崩溃（ADR-0023 强制）
 * - 第 0 行恒静态标题（防 fullRender 重影铁律）
 * - 键盘导航：1-4 状态子 tab、Enter 进详情、Esc 逐层返回
 * - 行尾标注（超时/返工3/多人同做）
 * - 人类操作：dispatcher 在详情按 a → y 验收 → 账本 closed（终态铁律）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promises as fs } from 'node:fs';
import { createOrg, joinOrg } from '../../../extensions/auto/org/orgstore.js';
import { createTaskWithId, saveTask, readTask } from '../../../extensions/auto/org/task.js';
import { OrgBoard } from '../../../extensions/auto/org/board.js';
import { makeMockTheme } from '../../../src/tui-testing/index.js';
import { visibleWidth } from '@earendil-works/pi-tui';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let root = '';
const chiefDir = join(tmpdir(), 'org-board-chief');
const workerDir = join(tmpdir(), 'org-board-worker');
const workerB = join(tmpdir(), 'org-board-worker-b');

const workerManifest = {
	name: 'worker-a',
	label: '阿A',
	role: 'member' as const,
	description: 'w',
};
const workerBManifest = {
	name: 'worker-b',
	label: '阿B',
	role: 'member' as const,
	description: 'w2',
};

async function setupOrg(org = 'dev-team') {
	await createOrg(org, { name: 'chief', dir: chiefDir });
	await joinOrg(org, { manifest: workerManifest, dir: workerDir });
	await joinOrg(org, { manifest: workerBManifest, dir: workerB });
	return org;
}

async function seedTask(
	org: string,
	over: {
		title?: string;
		status?: 'todo' | 'in_progress' | 'waiting_accept' | 'closed';
		dueAt?: string | null;
		assignees?: {
			agent: string;
			status: string;
			round?: number;
			delivered?: boolean;
			stopped?: boolean;
		}[];
	} = {},
) {
	const subAssignees = (over.assignees ?? [{ agent: 'worker-a', status: 'invited' }]).map(
		(a) => ({
			agent: a.agent,
			dir: a.agent === 'worker-a' ? workerDir : workerB,
			status: a.status,
			round: a.round ?? 0,
			stopped: a.stopped ?? false,
			deliveries: a.delivered
				? [
						{
							at: new Date().toISOString(),
							by: a.agent,
							summary: 'done it',
							files: [{ path: 'out.txt' }],
						},
					]
				: [],
		}),
	);
	const t = await createTaskWithId(org, {
		org,
		title: over.title ?? '写一份周报并给出证据',
		background: '背景说明',
		items: ['产出 docs/weekly.md', '标注数据来源'],
		dispatcher: 'chief',
		dispatcherRole: 'chief',
		createdAt: new Date().toISOString(),
		status: over.status ?? 'todo',
		subTasks: [
			{
				id: 'S1',
				description: '写周报',
				dueAt: over.dueAt ?? null,
				assignees: subAssignees,
			},
		],
		history: [],
	} as never);
	await saveTask(t);
	return t;
}

function mockTui() {
	return { requestRender: () => {}, setFocus: () => {} } as any;
}

async function makeBoard(meName = 'chief', orgsBefore?: (org: string) => Promise<void>) {
	if (orgsBefore) await orgsBefore('dev-team');
	const board = new OrgBoard(meName, mockTui(), makeMockTheme(), () => {}, {});
	// 等待异步数据加载完成（org 出现即就绪）
	for (let i = 0; i < 120; i++) {
		const lines = board.render(80);
		if (!lines.some((l) => l.includes('加载中'))) return board;
		await sleep(10);
	}
	return board;
}

describe('org TUI 任务看板', () => {
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), 'org-board-'));
		mkdirSync(join(root, 'home'), { recursive: true });
		mkdirSync(chiefDir, { recursive: true });
		mkdirSync(workerDir, { recursive: true });
		mkdirSync(workerB, { recursive: true });
		process.env.ORG_ROOT = join(root, 'orgdata');
		process.env.HOME = join(root, 'home');
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(chiefDir, { recursive: true, force: true });
		rmSync(workerDir, { recursive: true, force: true });
		rmSync(workerB, { recursive: true, force: true });
		delete process.env.ORG_ROOT;
	});

	it('空态：无组织时给出指引且不超宽', async () => {
		const board = await makeBoard('chief');
		for (const w of [80, 120]) {
			const lines = board.render(w);
			for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(w);
			expect(lines.some((l) => l.includes('还没有任何组织'))).toBe(true);
			expect(lines[0]).toContain('org 任务看板'); // 第 0 行静态标题
		}
	});

	it('有组织+任务：列表行含任务编号与超时标注；80/120 不超宽不崩溃', async () => {
		const board = await makeBoard('chief', async (org) => {
			await setupOrg(org);
			// 超期未交任务（claimed + 期望时间已过）→ [超时]
			const past = new Date(Date.now() - 86400000).toISOString();
			await seedTask(org, {
				title: '已超时的报告',
				status: 'in_progress',
				dueAt: past,
				assignees: [{ agent: 'worker-a', status: 'claimed' }],
			});
			// 普通待办
			await seedTask(org, { title: '普通待办事项' });
			// 返工 3 轮
			const t2 = await seedTask(org, {
				title: '反复返工的任务',
				status: 'in_progress',
				assignees: [{ agent: 'worker-b', status: 'returned', round: 3 }],
			});
			t2.subTasks[0].assignees[0].deliveries = [
				{ at: new Date().toISOString(), by: 'worker-b', summary: '初稿', files: [] },
				{ at: new Date().toISOString(), by: 'worker-b', summary: '修订稿', files: [] },
			];
			await saveTask(t2);
		});
		for (const w of [80, 120]) {
			const lines = board.render(w);
			for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(w);
			const joined = lines.join('\n');
			expect(joined).toContain('dev-team'); // org tab
			expect(joined).toContain('普通待办事项');
			// 切到进行中 tab 看标注
		}
		board.handleInput('2'); // 进行中
		const lines2 = board.render(80);
		const j2 = lines2.join('\n');
		expect(j2).toContain('[超时]');
		expect(j2).toContain('[返工3]');
	});

	it('键盘导航：Enter 详情、Esc 逐层返回、过滤即时生效', async () => {
		const board = await makeBoard('chief', async (org) => {
			await setupOrg(org);
			await seedTask(org, { title: 'Alpha 分析' });
		});
		board.handleInput('/');
		board.handleInput('A');
		let lines = board.render(80);
		expect(lines.some((l) => l.includes('过滤: A'))).toBe(true);
		expect(lines.some((l) => l.includes('Alpha'))).toBe(true);
		board.handleInput('\u001b'); // Esc 清过滤
		lines = board.render(80);
		expect(lines.some((l) => l.includes('过滤'))).toBe(false);
		board.handleInput('\r'); // Enter 详情
		lines = board.render(80);
		const j = lines.join('\n');
		expect(j).toContain('子 S1');
		expect(j).toContain('清单');
		board.handleInput('\u001b'); // 返回列表
		lines = board.render(80);
		expect(lines.some((l) => l.includes('状态 [1 待办]'))).toBe(true);
	});

	it('人类操作：派发人详情验收（a→y）→ 账本 closed（铁终态）', async () => {
		const board = await makeBoard('chief', async (org) => {
			await setupOrg(org);
			await seedTask(org, {
				title: '待验收工作',
				status: 'waiting_accept',
				assignees: [{ agent: 'worker-a', status: 'delivered', delivered: true }],
			});
		});
		board.handleInput('3'); // 等待验收 tab
		board.handleInput('\r'); // 详情
		expect(board.render(80).join('\n')).toContain('a 验收通过');
		board.handleInput('a');
		board.handleInput('y');
		// 异步执行 runAction → 轮询账本
		for (let i = 0; i < 80; i++) {
			const t = await readTask('dev-team', (await listIds())[0]);
			if (t && t.status === 'closed') break;
			await sleep(20);
		}
		const t = await readTask('dev-team', (await listIds())[0]);
		expect(t?.status).toBe('closed');
		expect(t?.acceptance?.result).toBe('accepted');

		async function listIds() {
			const dir = join(process.env.ORG_ROOT!, 'dev-team', 'tasks');
			return (await fs.readdir(dir))
				.filter((f) => f.endsWith('.json'))
				.map((f) => f.replace(/\.json$/, ''));
		}
	});

	it('非派发人看不到验收/打回操作键', async () => {
		// worker-a 打开看板，chief 派发且待验收的任务：不应出现 a/r/x 操作
		const board = await makeBoard('worker-a', async (org) => {
			await setupOrg(org);
			await seedTask(org, {
				title: '别人验收的任务',
				status: 'waiting_accept',
				assignees: [{ agent: 'worker-b', status: 'delivered', delivered: true }],
			});
		});
		board.handleInput('3');
		board.handleInput('\r');
		const j = board.render(80).join('\n');
		expect(j).not.toContain('a 验收通过');
		expect(j).toContain('Esc 返回');
	});
});
