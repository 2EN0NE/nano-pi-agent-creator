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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parkOrgRoot } from '../setup/org-root.js';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promises as fs } from 'node:fs';
import {
	createOrg,
	joinOrg,
	readOrg,
	setMemberLaunchArgs,
} from '../../../extensions/auto/org/orgstore.js';
import {
	createTaskWithId,
	refreshStatus,
	saveTask,
	readTask,
	transitionAssignee,
} from '../../../extensions/auto/org/task.js';
import { OrgBoard, remapSelectionById } from '../../../extensions/auto/org/board.js';
import { makeMockTheme, stripAnsi } from '../../../src/tui-testing/index.js';
import { visibleWidth } from '@earendil-works/pi-tui';
import { PRESENCE_POLL_MS } from '../../../extensions/auto/org/presence.js';
import type { Server } from 'node:net';
import {
	closeServers,
	killIfAlive,
	listenFakeControl,
	spawnFakeMember,
	writeRuntimeFile,
} from './org-lifecycle-helpers.js';
import { readLastSession } from '../../../extensions/auto/org/lifecycle.js';

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

/** 造一条"dispatcher 派给 assignee"的任务（员工视角的派发/接收数据源） */
async function seedDispatch(org: string, dispatcher: string, assignee: string, title: string) {
	const t = await createTaskWithId(org, {
		org,
		title,
		background: '',
		items: [],
		dispatcher,
		dispatcherRole: dispatcher === 'chief' ? 'chief' : 'member',
		createdAt: new Date().toISOString(),
		status: 'todo',
		subTasks: [
			{
				id: 'S1',
				description: 'd',
				dueAt: null,
				assignees: [
					{
						agent: assignee,
						dir: assignee === 'worker-a' ? workerDir : workerB,
						status: 'invited',
						round: 0,
						stopped: false,
						deliveries: [],
					},
				],
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

/** 进入设置视角并把光标移到指定行——按标签定位，避免索引写死后插行即错位 */
async function gotoSettingsRow(board: OrgBoard, label: string): Promise<void> {
	board.handleInput('\u001b[C'); // → 成员
	board.handleInput('\u001b[C'); // → 设置
	const selLine = () =>
		board
			.render(100)
			.map(stripAnsi)
			.find((l) => l.startsWith('>')) ?? '';
	for (let i = 0; i < 12; i++) {
		if (selLine().includes(label)) return;
		board.handleInput('\u001b[B');
	}
	throw new Error(`设置页未找到行「${label}」`);
}

async function makeBoard(
	meName = 'chief',
	orgsBefore?: (org: string) => Promise<void>,
	theme?: unknown, // 可选：注入探针主题（断言配色）
) {
	if (orgsBefore) await orgsBefore('dev-team');
	const board = new OrgBoard(
		meName,
		mockTui(),
		(theme ?? makeMockTheme()) as never,
		() => {},
		{},
	);
	// 等待异步数据加载完成（org 出现即就绪）
	for (let i = 0; i < 120; i++) {
		const lines = board.render(80);
		if (!lines.some((l) => l.includes('加载中'))) return board;
		await sleep(10);
	}
	return board;
}

/** 同 makeBoard，但给 mock tui 一个真实 terminal.rows（测自适应公式边界） */
async function makeBoardRows(rows: number, orgsBefore?: (org: string) => Promise<void>) {
	if (orgsBefore) await orgsBefore('dev-team');
	const tui = { requestRender: () => {}, setFocus: () => {}, terminal: { rows } } as any;
	const board = new OrgBoard('chief', tui, makeMockTheme(), () => {}, {});
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
		parkOrgRoot();
	});

	it('空态：无组织时给出指引且不超宽', async () => {
		const board = await makeBoard('chief');
		for (const w of [80, 120]) {
			const lines = board.render(w);
			for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(w);
			expect(lines.some((l) => l.includes('还没有任何组织'))).toBe(true);
			expect(lines[0]).toContain('── org'); // 第 0 行标题（无公司时不带公司名）
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
			expect(joined).not.toContain('[ dev-team ]'); // 单 org 无假 tab 栏
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
		expect(lines.some((l) => l.includes('状态 [1 TODO]'))).toBe(true);
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
		expect(board.render(80).join('\n')).toContain('a 验收');
		expect(board.render(80).join('\n')).not.toContain('(人类强制)');
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

	it('非派发人打开面板 = 人类强制通道：显示强制验收键并可执行（human@ 落账）', async () => {
		// worker-a 目录打开看板，chief 派发且待验收的任务：人操作台应显示人类强制键并可验收
		const board = await makeBoard('worker-a', async (org) => {
			await setupOrg(org);
			await seedTask(org, {
				title: '别人派发的任务',
				status: 'waiting_accept',
				assignees: [{ agent: 'worker-b', status: 'delivered', delivered: true }],
			});
		});
		board.handleInput('3');
		board.handleInput('\r');
		const j = board.render(80).join('\n');
		expect(j).toContain('a 验收(人类强制)');
		// 执行验收（a → y 确认）
		board.handleInput('a');
		board.handleInput('y');
		for (let i = 0; i < 80; i++) {
			const t = await readTask('dev-team', (await listIds())[0]);
			if (t && t.status === 'closed') break;
			await sleep(20);
		}
		const t = await readTask('dev-team', (await listIds())[0]);
		expect(t?.status).toBe('closed');
		expect(t?.acceptance?.by).toMatch(/^human@/); // human@ 落账（H1）
		expect(t?.history.some((h) => h.event === 'human_forced_approve')).toBe(true);
		async function listIds() {
			const dir = join(process.env.ORG_ROOT!, 'dev-team', 'tasks');
			return (await fs.readdir(dir))
				.filter((f) => f.endsWith('.json'))
				.map((f) => f.replace(/\.json$/, ''));
		}
	});

	// ── 04 详情页参与者焦点 ─────────────────────────────────────────────────────

	describe('详情页参与者焦点（04）', () => {
		it('进详情焦点在首个 active 参与者；↑↓ 移动；首尾越界不崩不跳', async () => {
			const board = await makeBoard('chief', async (org) => {
				await setupOrg(org);
				await seedTask(org, {
					title: '双人任务',
					status: 'in_progress',
					assignees: [
						{ agent: 'worker-a', status: 'claimed' },
						{ agent: 'worker-b', status: 'claimed' },
					],
				});
			});
			board.handleInput('2'); // 进行中
			board.handleInput('\r'); // 进详情
			let j = board.render(80).join('\n');
			// 焦点（> 前缀 + selectedBg 透传）应在 worker-a 行
			expect(j).toMatch(/>\s*worker-a:/);
			expect(j).not.toMatch(/>\s*worker-b:/);
			// ↓ 移到 worker-b
			board.handleInput('\u001b[B');
			j = board.render(80).join('\n');
			expect(j).toMatch(/>\s*worker-b:/);
			expect(j).not.toMatch(/>\s*worker-a:/);
			// ↑ 回 worker-a；再 ↑ 越界不崩
			board.handleInput('\u001b[A');
			board.handleInput('\u001b[A');
			j = board.render(80).join('\n');
			expect(j).toMatch(/>\s*worker-a:/);
			// ↓ 越界不崩（尾部多按几次仍选中最后一个）
			for (let i = 0; i < 6; i++) board.handleInput('\u001b[B');
			j = board.render(80).join('\n');
			expect(j).toMatch(/>\s*worker-b:/);
			// Esc 返回列表
			board.handleInput('\u001b');
			expect(board.render(80).some((l) => l.includes('状态 [1 TODO]'))).toBe(true);
		});

		it('终态参与者（rejected）不进入焦点序列', async () => {
			const board = await makeBoard('chief', async (org) => {
				await setupOrg(org);
				await seedTask(org, {
					title: '拒接后仅剩一人',
					status: 'in_progress',
					assignees: [
						{ agent: 'worker-a', status: 'rejected' },
						{ agent: 'worker-b', status: 'claimed' },
					],
				});
			});
			board.handleInput('2');
			board.handleInput('\r');
			const j = board.render(80).join('\n');
			expect(j).toMatch(/>\s*worker-b:/); // 焦点跳过 rejected 落在 worker-b
			expect(j).toContain('终态');
		});
	});

	it('人类验收未全部交付任务：a 已交、b 在做 → 验收后 b 被叫停（stopped）并关闭（人类强制）', async () => {
		const board = await makeBoard('chief', async (org) => {
			await setupOrg(org);
			await seedTask(org, {
				title: '部分交付任务',
				status: 'in_progress',
				assignees: [
					{ agent: 'worker-a', status: 'delivered', delivered: true },
					{ agent: 'worker-b', status: 'claimed' },
				],
			});
		});
		board.handleInput('2'); // 进行中
		board.handleInput('\r');
		expect(board.render(80).join('\n')).toContain('a 验收');
		board.handleInput('a');
		board.handleInput('y');
		for (let i = 0; i < 80; i++) {
			const t = await readTask('dev-team', (await listIds())[0]);
			if (t && t.status === 'closed') break;
			await sleep(20);
		}
		const t = await readTask('dev-team', (await listIds())[0]);
		expect(t?.status).toBe('closed');
		const b = t?.subTasks[0].assignees.find((x) => x.agent === 'worker-b');
		expect(b?.stopped).toBe(true);
		expect(t?.history.some((h) => h.event === 'human_forced_approve')).toBe(true);
		async function listIds() {
			const dir = join(process.env.ORG_ROOT!, 'dev-team', 'tasks');
			return (await fs.readdir(dir))
				.filter((f) => f.endsWith('.json'))
				.map((f) => f.replace(/\.json$/, ''));
		}
	});

	it('人类改派（G2）：焦点 claimed 参与者 → g → 候选成员（选中目标）→ Enter → 原 cancelled + 新 invited + 留痕', async () => {
		const board = await makeBoard('chief', async (org) => {
			await setupOrg(org);
			await seedTask(org, {
				title: '卡死任务',
				status: 'in_progress',
				assignees: [{ agent: 'worker-a', status: 'claimed' }],
			});
		});
		board.handleInput('2');
		board.handleInput('\r'); // 详情，焦点 worker-a（claimed）
		board.handleInput('g'); // 改派候选
		expect(board.render(80).join('\n')).toContain('改派：');
		// 候选序 = org 成员序（worker-a 已被排除）：chief 在前 → ↓ 一次选中 worker-b
		board.handleInput('\u001b[B');
		board.handleInput('\r');
		for (let i = 0; i < 80; i++) {
			const t = await readTask('dev-team', (await listIds())[0]);
			const b = t?.subTasks[0].assignees.find((x) => x.agent === 'worker-b');
			if (b && b.status === 'invited') break;
			await sleep(20);
		}
		const t = await readTask('dev-team', (await listIds())[0]);
		const sub = t!.subTasks[0];
		expect(sub.assignees.find((x) => x.agent === 'worker-a')?.status).toBe('cancelled');
		expect(sub.assignees.find((x) => x.agent === 'worker-b')?.status).toBe('invited');
		expect(t!.history.some((h) => h.event === 'human_forced_reassign')).toBe(true);
		// 改派须通知新处理人（与命令面 /org reassign 一致）——否则对方不会开工
		const inboxDir = join(process.env.ORG_ROOT!, 'dev-team', 'inbox', 'worker-b');
		let notified = '';
		for (let i = 0; i < 80 && !notified; i++) {
			try {
				const files = (await fs.readdir(inboxDir)).filter((f) => f.endsWith('.json'));
				if (files.length > 0) notified = readFileSync(join(inboxDir, files[0]), 'utf8');
			} catch {
				// inbox 尚未创建
			}
			if (!notified) await sleep(20);
		}
		expect(notified).toContain('[org:task]');
		expect(notified).toContain('改派给你');
		async function listIds() {
			const dir = join(process.env.ORG_ROOT!, 'dev-team', 'tasks');
			return (await fs.readdir(dir))
				.filter((f) => f.endsWith('.json'))
				.map((f) => f.replace(/\.json$/, ''));
		}
	});

	it('delivered 焦点：g 不进入改派（应走验收/打回）', async () => {
		const board = await makeBoard('chief', async (org) => {
			await setupOrg(org);
			await seedTask(org, {
				title: '已交付任务',
				status: 'waiting_accept',
				assignees: [{ agent: 'worker-a', status: 'delivered', delivered: true }],
			});
		});
		board.handleInput('3');
		board.handleInput('\r'); // 详情，焦点 worker-a（delivered）
		board.handleInput('g'); // 不进入（delivered 不可改派）
		expect(board.render(80).join('\n')).not.toContain('改派：');
	});

	it('改派候选 Esc 取消不落账', async () => {
		const board = await makeBoard('chief', async (org) => {
			await setupOrg(org);
			await seedTask(org, {
				title: '取消改派任务',
				status: 'in_progress',
				assignees: [{ agent: 'worker-a', status: 'claimed' }],
			});
		});
		board.handleInput('2');
		board.handleInput('\r');
		board.handleInput('g');
		expect(board.render(80).join('\n')).toContain('改派：');
		board.handleInput('\u001b'); // Esc 取消
		expect(board.render(80).join('\n')).not.toContain('改派：');
		const t = await readTask('dev-team', (await listIds())[0]);
		expect(t?.subTasks[0].assignees[0].status).toBe('claimed'); // 未变
		async function listIds() {
			const dir = join(process.env.ORG_ROOT!, 'dev-team', 'tasks');
			return (await fs.readdir(dir))
				.filter((f) => f.endsWith('.json'))
				.map((f) => f.replace(/\.json$/, ''));
		}
	});
	it('改派候选 Esc 取消后模式复位：再次进详情不出现候选屏（防「Enter 误改派」回归）', async () => {
		const board = await makeBoard('chief', async (org) => {
			await setupOrg(org);
			await seedTask(org, {
				title: 'Esc 复位检查',
				status: 'in_progress',
				assignees: [{ agent: 'worker-a', status: 'claimed' }],
			});
		});
		board.handleInput('2');
		board.handleInput('\r');
		expect(board.render(100).map(stripAnsi).join('\n')).toContain('子 S1');
		board.handleInput('g');
		expect(board.render(100).map(stripAnsi).join('\n')).toContain('改派：');
		board.handleInput('\u001b'); // Esc：取消改派（该键同时关闭详情）
		// 关键：重新打开详情必须回到正常详情屏；若 reassignMode 泄漏，这里会渲染候选屏
		board.handleInput('\r');
		const onceMore = board.render(100).map(stripAnsi).join('\n');
		expect(onceMore).not.toContain('改派：');
		expect(onceMore).toContain('子 S1');
	});
	it('多 org：公司 chip 行仅多 org 渲染；Tab 循环切换公司、Shift+Tab 反向；单 org 无公司行', async () => {
		const board = await makeBoard('chief', async () => {
			await setupOrg('dev-team');
			await seedTask('dev-team', { title: '写一份周报并给出证据' });
			await createOrg('demo-org', { name: 'chief', dir: chiefDir });
		});
		// 多 org：顶部公司 chip 行两个 tab 均渲染
		let j = board.render(80).join('\n');
		expect(j).toContain('[ demo-org ]');
		expect(j).toContain('[ dev-team ]');
		// 默认打开字典序首 org（demo-org，无任务）；Tab → dev-team（出现任务）
		expect(j).not.toContain('写一份周报');
		board.handleInput('\t');
		for (let i = 0; i < 120; i++) {
			j = board.render(80).join('\n');
			if (j.includes('写一份周报')) break;
			await sleep(10);
		}
		expect(j).toContain('写一份周报');
		// Shift+Tab 反向回 demo-org（headless 用 CSI-u 序列 \x1b[Z 表示）
		board.handleInput('\u001b[Z');
		for (let i = 0; i < 120; i++) {
			j = board.render(80).join('\n');
			if (!j.includes('写一份周报')) break;
			await sleep(10);
		}
		expect(j).not.toContain('写一份周报');
	});

	it('单 org：不渲染公司 chip 行（无假 tab 栏），视角行仍在', async () => {
		const board = await makeBoard('chief', async () => {
			await setupOrg('dev-team');
		});
		const j = board.render(80).join('\n');
		expect(j).not.toContain('[ dev-team ]');
		expect(j).toContain('[ 任务 ]'); // 视角 chip 行
	});
	it('四线布局：标题嵌横线 + tab 下分隔 + footer 上界 + 底横线', async () => {
		const board = await makeBoard('chief', async (org) => {
			await setupOrg(org);
			await seedTask(org, { title: '有任务' });
		});
		const lines = board.render(80).map(stripAnsi);
		// 外框（顶/底）为 accent 满宽横线；内部两条分隔线左空 2 格 + dim
		const outer = lines.filter((l) => /^─+$/.test(l));
		const inner = lines.filter((l) => /^  ─+$/.test(l));
		expect(outer.length).toBeGreaterThanOrEqual(1); // 底横线
		expect(inner.length).toBeGreaterThanOrEqual(2); // tab 分隔 + footer 上界
		// 首行标题嵌入横线且含公司名
		expect(lines[0]).toMatch(/^── org:dev-team ─+$/);
		// 末行为底横线（外框）
		expect(lines[lines.length - 1]).toMatch(/^─+$/);
		// 总行数不超宽且不超 MAX 上限（22）
		for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(80);
		expect(lines.length).toBeLessThanOrEqual(22);
	});

	it('成员视角：chief 名字后 [负责人]（无员工/label/任务计数），行尾显示工作目录', async () => {
		const board = await makeBoard('chief', async (org) => {
			await setupOrg(org); // chief + worker-a(阿A) + worker-b(阿B)
			await seedTask(org, { title: 'T' });
		});
		board.handleInput('\u001b[C'); // → 到成员
		const j = board.render(100).join('\n');
		expect(j).toContain('[负责人]');
		expect(j).not.toContain('员工');
		expect(j).not.toContain('阿A');
		expect(j).not.toContain('任务0');
		expect(j).toContain('org-board-chief'); // 目录路径（tmp 绝对路径含固定段）
		expect(j).toContain('org-board-worker');
	});

	it('成员注册目录已失效 → 列表标注「注册目录不存在」（与「睡眠可唤醒」区分）', async () => {
		const board = await makeBoard('chief', async (org) => {
			await setupOrg(org);
			// 模拟历史残留 / 目录被人工删除：worker-a 的注册目录不复存在
			rmSync(workerDir, { recursive: true, force: true });
		});
		board.handleInput('\u001b[C'); // → 到成员
		const j = board.render(120).map(stripAnsi).join('\n');
		// 断言**用户可见文案**本身（不引用常量）：文案是给人看的产品契约，改了就该红
		const WORD = '注册目录不存在';
		expect(j).toContain(`[${WORD}]`);
		// 只标失效的那个，目录仍存在的成员不得被误标
		const marked = j.split('\n').filter((l) => l.includes(`[${WORD}]`)).length;
		expect(marked).toBe(1);
	});

	it('TUI 新建公司：设置视角 → 新建公司 → 输入公司名 → Enter → 落盘 + 列表刷新并切换', async () => {
		const board = await makeBoard('chief', async (org) => {
			await setupOrg(org);
			await seedTask(org, { title: 'dev 任务' });
		});
		await gotoSettingsRow(board, '新建公司');
		let j = board.render(80).join('\n');
		expect(j).toContain('新建公司');
		board.handleInput('\r'); // Enter → 输入屏
		j = board.render(80).join('\n');
		expect(j).toContain('公司名: _');
		for (const ch of 'acme-corp') board.handleInput(ch);
		j = board.render(80).join('\n');
		expect(j).toContain('acme-corp_');
		board.handleInput('\r'); // 创建
		for (let i = 0; i < 120; i++) {
			j = board.render(80).join('\n');
			if (j.includes('[ acme-corp ]') && !j.includes('公司名:')) break;
			await sleep(15);
		}
		expect(j).toContain('[ acme-corp ]'); // 公司 tab 行出现（现在 2 org）
		expect(j).toContain('[ dev-team ]');
		expect(j).not.toContain('dev 任务'); // 已切到 acme-corp（空）
		// 落盘校验
		const orgFile = join(process.env.ORG_ROOT!, 'acme-corp', 'org.json');
		const raw = await fs.readFile(orgFile, 'utf8');
		expect(raw).toContain('acme-corp');
		// Tab 切回 dev-team 任务可见
		board.handleInput('\t');
		for (let i = 0; i < 120; i++) {
			j = board.render(80).join('\n');
			if (j.includes('dev 任务')) break;
			await sleep(15);
		}
		expect(j).toContain('dev 任务');
	});
	it('确认屏：破坏性操作前显示「确认：…」+ 后果说明（y/Esc）', async () => {
		const board = await makeBoard('chief', async (org) => {
			await setupOrg(org);
			await seedTask(org, {
				title: '待验收',
				status: 'waiting_accept',
				assignees: [{ agent: 'worker-a', status: 'delivered', delivered: true }],
			});
		});
		board.handleInput('3');
		board.handleInput('\r'); // 详情
		board.handleInput('a'); // 触发确认
		const j = board.render(80).join('\n');
		expect(j).toContain('确认：验收任务');
		expect(j).toContain('y / Enter 确认');
		board.handleInput('\u001b'); // Esc 取消
		expect(board.render(80).join('\n')).not.toContain('确认：');
	});

	it('标题含公司名：`── org:dev-team ──`，Tab 切换公司后标题同步', async () => {
		const board = await makeBoard('chief', async (org) => {
			await setupOrg(org);
			await createOrg('demo-org', { name: 'chief', dir: chiefDir });
		});
		let j = board.render(80).map(stripAnsi).join('\n');
		expect(j).toContain('── org:demo-org'); // 字典序首 org
		board.handleInput('\t'); // 切到 dev-team
		for (let i = 0; i < 120; i++) {
			j = board.render(80).map(stripAnsi).join('\n');
			if (j.includes('── org:dev-team')) break;
			await sleep(10);
		}
		expect(j).toContain('── org:dev-team');
	});

	it('踢退（人类强制 leaveOrg）：成员视角 d → 确认 → y → 成员移除 + 历史档案保留', async () => {
		const board = await makeBoard('chief', async (org) => {
			await setupOrg(org);
		});
		board.handleInput('\u001b[C'); // → 成员
		board.handleInput('\u001b[B'); // 选中 worker-a
		board.handleInput('d');
		let j = board.render(80).join('\n');
		expect(j).toContain('确认：踢退成员 worker-a');
		board.handleInput('y');
		for (let i = 0; i < 120; i++) {
			j = board.render(80).join('\n');
			if (!j.includes('worker-a')) break;
			await sleep(15);
		}
		expect(j).not.toContain('worker-a');
		// 回归档案保留
		const hist = join(process.env.ORG_ROOT!, 'dev-team', 'history', 'worker-a.json');
		expect(await fs.readFile(hist, 'utf8')).toContain('left');
	});

	it('踢退保护：负责人不可踢退（提示先转移）', async () => {
		const board = await makeBoard('chief', async (org) => {
			await setupOrg(org);
		});
		board.handleInput('\u001b[C'); // 成员，选中第一行（chief）
		board.handleInput('d');
		const j = board.render(80).join('\n');
		expect(j).toContain('负责人不可踢退');
		expect(j).not.toContain('确认：踢退成员 chief');
	});

	it('负责人转移：成员视角 m → 确认 → y → 新 chief 上任、原 chief 降普通成员', async () => {
		const board = await makeBoard('chief', async (org) => {
			await setupOrg(org);
		});
		board.handleInput('\u001b[C'); // 成员
		board.handleInput('\u001b[B'); // 选中 worker-a
		board.handleInput('m');
		let j = board.render(80).join('\n');
		expect(j).toContain('将 worker-a 设为负责人');
		expect(j).toContain('原负责人 chief 自动降为普通成员');
		board.handleInput('y');
		for (let i = 0; i < 120; i++) {
			const raw = await fs.readFile(
				join(process.env.ORG_ROOT!, 'dev-team', 'org.json'),
				'utf8',
			);
			if (raw.includes('"chiefName": "worker-a"')) break;
			await sleep(15);
		}
		const org = JSON.parse(
			await fs.readFile(join(process.env.ORG_ROOT!, 'dev-team', 'org.json'), 'utf8'),
		);
		expect(org.chiefName).toBe('worker-a');
		expect(org.members.find((m: any) => m.name === 'chief').role).toBe('member');
		expect(org.members.find((m: any) => m.name === 'worker-a').role).toBe('chief');
	});

	it('删除公司：设置视角 → 删除公司 → y → 整棵数据归档到 .trash', async () => {
		const board = await makeBoard('chief', async (org) => {
			await setupOrg(org);
		});
		await gotoSettingsRow(board, '删除公司');
		board.handleInput('\r');
		let j = board.render(80).join('\n');
		expect(j).toContain('确认：删除公司 dev-team');
		board.handleInput('y');
		for (let i = 0; i < 120; i++) {
			j = board.render(80).join('\n');
			if (j.includes('还没有任何组织')) break;
			await sleep(15);
		}
		expect(j).toContain('还没有任何组织');
		const trash = join(process.env.ORG_ROOT!, '.trash');
		const items = await fs.readdir(trash);
		expect(items.some((n) => n.startsWith('dev-team-'))).toBe(true);
	});

	it('公司改名：设置视角 → 重命名 → 目录/org.json/任务 .org 全量迁移', async () => {
		const board = await makeBoard('chief', async (org) => {
			await setupOrg(org);
			await seedTask(org, { title: '迁移用任务' });
		});
		await gotoSettingsRow(board, '重命名公司');
		board.handleInput('\r');
		let j = board.render(80).join('\n');
		expect(j).toContain('重命名公司');
		// P1（编辑心智）：输入框预填当前名，而不是空的
		expect(j).toContain('公司名: dev-team_');
		// 清掉预填值，再输入新名
		for (let k = 0; k < 'dev-team'.length; k++) board.handleInput('\x7f');
		expect(board.render(80).join('\n')).toContain('公司名: _');
		for (const ch of 'renamed-co') board.handleInput(ch);
		expect(board.render(80).join('\n')).toContain('公司名: renamed-co_');
		board.handleInput('\r');
		for (let i = 0; i < 120; i++) {
			if (
				await fs
					.readdir(join(process.env.ORG_ROOT!, 'renamed-co'))
					.then(() => true)
					.catch(() => false)
			)
				break;
			await sleep(15);
		}
		// 旧目录消失、新目录存在
		await expect(fs.readdir(join(process.env.ORG_ROOT!, 'dev-team'))).rejects.toThrow();
		const org = JSON.parse(
			await fs.readFile(join(process.env.ORG_ROOT!, 'renamed-co', 'org.json'), 'utf8'),
		);
		expect(org.name).toBe('renamed-co');
		// 任务 .org 字段迁移
		const tf = (await fs.readdir(join(process.env.ORG_ROOT!, 'renamed-co', 'tasks')))[0];
		const task = JSON.parse(
			await fs.readFile(join(process.env.ORG_ROOT!, 'renamed-co', 'tasks', tf), 'utf8'),
		);
		expect(task.org).toBe('renamed-co');
		expect(board.render(80).map(stripAnsi).join('\n')).toContain('── org:renamed-co');
	});

	it('加入公司：设置视角 → 加入公司 → 选候选 → 当前目录成为成员', async () => {
		const board = await makeBoard('chief', async (org) => {
			await setupOrg(org);
			await createOrg('other-co', { name: 'boss', dir: join(tmpdir(), 'org-board-other') });
		});
		await gotoSettingsRow(board, '加入公司');
		board.handleInput('\r');
		// beginJoinOrg 异步读取各公司成员，轮询等待候选屏出现
		let j = '';
		for (let i = 0; i < 120; i++) {
			j = board.render(80).join('\n');
			if (j.includes('加入公司：用当前目录')) break;
			await sleep(15);
		}
		expect(j).toContain('加入公司：用当前目录');
		expect(j).toContain('other-co'); // 候选（当前目录未加入）
		// 候选按字典序，↓ 直到选中 other-co 再回车
		for (let i = 0; i < 8; i++) {
			if (j.includes('> other-co')) break;
			board.handleInput('\u001b[B');
			j = board.render(80).join('\n');
		}
		expect(j).toContain('> other-co');
		board.handleInput('\r');
		const real = await fs.realpath(process.cwd());
		for (let i = 0; i < 120; i++) {
			const raw = await fs
				.readFile(join(process.env.ORG_ROOT!, 'other-co', 'org.json'), 'utf8')
				.catch(() => '');
			if (raw.includes(real)) break;
			await sleep(15);
		}
		const org = JSON.parse(
			await fs.readFile(join(process.env.ORG_ROOT!, 'other-co', 'org.json'), 'utf8'),
		);
		expect(org.members.some((m: any) => m.dir === real)).toBe(true);
	});
	/** 从成员详情渲染结果里按区块抽出可见任务 id（用于窗口/滚动断言） */
	function memberSections(board: OrgBoard, width = 100) {
		const rows = board.render(width).map(stripAnsi);
		const di = rows.findIndex((l) => l.includes('派发（'));
		const ri = rows.findIndex((l) => l.includes('接收（'));
		const ids = (a: number, b: number) =>
			(rows
				.slice(a + 1, b)
				.join('\n')
				.match(/M-[0-9a-z]+/g) ?? []) as string[];
		return { rows, text: rows.join('\n'), disp: ids(di, ri), recv: ids(ri, rows.length) };
	}

	async function openWorkerDetail(board: OrgBoard) {
		board.handleInput('\u001b[C'); // 任务 → 成员
		board.handleInput('\u001b[B'); // 选中 worker-a
		board.handleInput('\r'); // 进入成员详情
	}

	it('成员详情：派发/接收两区块 + 计数（两区块数据独立）', async () => {
		const board = await makeBoard('chief', async (org) => {
			await setupOrg(org);
			await seedDispatch(org, 'worker-a', 'worker-b', '派给B的');
			await seedDispatch(org, 'chief', 'worker-a', '分给A的');
		});
		await openWorkerDetail(board);
		const { text, disp, recv } = memberSections(board);
		// ADR-0040 D12②：标题行内嵌可感知状态（无 runtime → 睡眠）
		expect(text).toMatch(/成员 worker-a\s+○ 睡眠/);
		expect(text).toContain('派发 1 · 接收 1');
		expect(text).toContain('派发（1）');
		expect(text).toContain('接收（1）');
		expect(disp.length).toBe(1);
		expect(recv.length).toBe(1);
		expect(disp[0]).not.toBe(recv[0]); // 两区块确实是不同任务
	});

	it('成员详情：空区块显示「无」，全空显示专用提示', async () => {
		const board = await makeBoard('chief', async (org) => {
			await setupOrg(org);
			await seedDispatch(org, 'worker-a', 'worker-b', '只有派发');
		});
		await openWorkerDetail(board);
		// worker-a：派发 1、接收 0 → 接收区块渲染「无」
		expect(memberSections(board).text).toContain('派发（1）');
		expect(memberSections(board).text).toContain('接收（0）');
		expect(memberSections(board).text).toContain('无');

		// chief：setupOrg 后无任何派发/接收 → 专用提示
		board.handleInput('\u001b'); // Esc 返回成员列表（P5：光标恢复到进入前的位置 = worker-a）
		board.handleInput('\u001b[A'); // 上移到 chief
		board.handleInput('\r');
		expect(memberSections(board).text).toContain('该成员暂无派发/接收任务');
	});

	it('成员详情：两区块各自独立窗口（A）——光标所在区块滚动、另一区块停窗口首部', async () => {
		const board = await makeBoard('chief', async (org) => {
			await setupOrg(org);
			for (let i = 0; i < 8; i++) await seedDispatch(org, 'worker-a', 'worker-b', `派${i}`);
			for (let i = 0; i < 8; i++) await seedDispatch(org, 'chief', 'worker-a', `收${i}`);
		});
		await openWorkerDetail(board);

		// page = clamp(floor((24-12)/2),3,7) = 6（mock 无 terminal → 24 行）
		let s = memberSections(board);
		expect(s.disp.length).toBe(6);
		expect(s.recv.length).toBe(6);
		const dispHead = s.disp[0];
		const recvHead = s.recv[0];
		expect(s.text).toContain('…余 2 条');

		// 光标在派发区下移 6 → 派发窗口滚动；接收不动（独立）
		for (let i = 0; i < 6; i++) board.handleInput('\u001b[B');
		s = memberSections(board);
		expect(s.disp[0]).not.toBe(dispHead);
		expect(s.recv[0]).toBe(recvHead);

		// 跨入接收区（再下移 2）→ 派发回窗口首部、接收仍在首部
		board.handleInput('\u001b[B');
		board.handleInput('\u001b[B');
		s = memberSections(board);
		expect(s.disp[0]).toBe(dispHead);
		expect(s.recv[0]).toBe(recvHead);

		// 接收区继续下移 6 → 接收滚动、派发不受影响
		for (let i = 0; i < 6; i++) board.handleInput('\u001b[B');
		s = memberSections(board);
		expect(s.recv[0]).not.toBe(recvHead);
		expect(s.disp[0]).toBe(dispHead);
	});

	it('成员详情：Enter 打开所选任务详情，Esc 逐层返回成员详情（Q4 修复的回归保护）', async () => {
		const board = await makeBoard('chief', async (org) => {
			await setupOrg(org);
			const t = await seedDispatch(org, 'worker-a', 'worker-b', '派发任务C');
			expect(t.id).toMatch(/^M-/);
		});
		await openWorkerDetail(board);
		board.handleInput('\r'); // 打开所选（派发区首行）任务详情
		let text = memberSections(board).text;
		expect(text).toContain('派发任务C');
		expect(text).toContain('子 S1'); // 任务详情页特征
		expect(text).not.toContain('派发（1）'); // 已切换到任务详情，不再是成员详情

		board.handleInput('\u001b'); // Esc → 回到成员详情（而非任务列表）
		text = memberSections(board).text;
		expect(text).toContain('派发（1）');
		expect(text).toContain('成员 worker-a');
	});
	it('§H 偏好持久化：设置里切「任务排序」→ 写用户级 config.json，重开看板沿用', async () => {
		const board = await makeBoard('chief', async (org) => {
			await setupOrg(org);
			await seedTask(org, { title: 'T' });
		});
		board.handleInput('\u001b[C'); // 成员
		board.handleInput('\u001b[C'); // 设置
		let j = board.render(100).map(stripAnsi).join('\n');
		expect(j).toContain('任务排序：新→旧'); // 默认

		board.handleInput('\r'); // 切排序
		for (let i = 0; i < 80; i++) {
			j = board.render(100).map(stripAnsi).join('\n');
			if (j.includes('任务排序：旧→新')) break;
			await sleep(10);
		}
		expect(j).toContain('任务排序：旧→新');

		// 落盘：用户级 @zenone/pi-config（$HOME/.pi/agent/extensions-data/org/config.json）
		// —— 界面偏好不用项目级/会话级覆盖（见 extensions/auto/org/config.ts 头注释）
		const prefs = JSON.parse(
			await fs.readFile(
				join(root, 'home', '.pi', 'agent', 'extensions-data', 'org', 'config.json'),
				'utf8',
			),
		);
		expect(prefs.sortNewFirst).toBe(false);
		expect(prefs.annotate).toBe(true); // 另一项未被误改

		// 重开看板 → 偏好被读回（并体现在任务视角的 tab 行）
		const board2 = await makeBoard('chief');
		expect(board2.render(100).map(stripAnsi).join('\n')).toContain('排序:旧→新');
		board2.handleInput('\u001b[C');
		board2.handleInput('\u001b[C');
		expect(board2.render(100).map(stripAnsi).join('\n')).toContain('任务排序：旧→新');
	});

	it('§I footer 逐屏据实：只列该屏真能按的键（不跨屏误导）', async () => {
		const board = await makeBoard('chief', async (org) => {
			await setupOrg(org);
			await seedDispatch(org, 'worker-a', 'worker-b', '派给B的');
			await seedDispatch(org, 'chief', 'worker-a', '分给A的');
		});
		const foot = () => {
			const lines = board.render(120).map(stripAnsi);
			return lines[lines.length - 2] ?? ''; // 底横线之上
		};
		// 任务列表：Enter 详情；不宣传踢退
		expect(foot()).toContain('Enter 详情');
		expect(foot()).not.toContain('踢退');

		// 成员列表：Enter 看名下任务 + d 踢退
		board.handleInput('\u001b[C');
		expect(foot()).toContain('Enter 看名下任务');
		expect(foot()).toContain('d 踢退');

		// 成员详情：Enter 任务详情；该屏 d 无效 → 不得再宣传
		board.handleInput('\u001b[B');
		board.handleInput('\r');
		expect(foot()).toContain('Enter 任务详情');
		expect(foot()).not.toContain('d 踢退');
		expect(foot()).toContain('Esc 返回成员列表');

		// 设置：执行是 Enter；「→」只切视角、不兼任执行
		board.handleInput('\u001b'); // 回成员列表
		board.handleInput('\u001b[C'); // → 设置
		expect(foot()).toContain('Enter 执行');
		expect(foot()).not.toContain('→ 执行');
		expect(foot()).toContain('←→ 视角');
	});

	it('§I 自适应公式边界：rows≤19→3 行/区块、rows≥26→7 行/区块，总高 ≤ maxTotal（铁律 1）', async () => {
		await makeBoard('chief', async (org) => {
			await setupOrg(org);
			for (let i = 0; i < 10; i++) await seedDispatch(org, 'worker-a', 'worker-b', `派${i}`);
		});

		const narrow = await makeBoardRows(18);
		await openWorkerDetail(narrow);
		expect(memberSections(narrow).disp.length).toBe(3); // clamp(floor((18-12)/2)=3, 3, 7)
		expect(narrow.render(100).length).toBeLessThanOrEqual(17); // maxTotal = rows-1

		const mid = await makeBoardRows(26);
		await openWorkerDetail(mid);
		expect(memberSections(mid).disp.length).toBe(7); // floor(14/2)=7

		const tall = await makeBoardRows(40);
		await openWorkerDetail(tall);
		expect(memberSections(tall).disp.length).toBe(7); // floor(28/2)=14 → 夹到 7
		expect(tall.render(100).length).toBeLessThanOrEqual(39);
	});

	it('§I 标题同公司内恒定：移光标 / 切状态 tab / 换视角都不改第 0 行（铁律 2）', async () => {
		const board = await makeBoard('chief', async (org) => {
			await setupOrg(org);
			await seedTask(org, { title: 'A' });
			await seedTask(org, { title: 'B' });
		});
		const title = () => board.render(100).map(stripAnsi)[0] ?? '';
		const t0 = title();
		expect(t0).toMatch(/^── org:dev-team ─+$/);

		board.handleInput('\u001b[B'); // 列表下移
		board.handleInput('\u001b[B');
		expect(title()).toBe(t0);

		board.handleInput('2'); // 切状态子 tab
		expect(title()).toBe(t0);

		board.handleInput('\u001b[C'); // 换视角 → 成员
		expect(title()).toBe(t0);
		board.handleInput('\u001b[C'); // → 设置
		expect(title()).toBe(t0);
	});
	it('P1 编辑心智：重命名「未改动 / 清空」直接回车 = 保留原名退出，不报错', async () => {
		const board = await makeBoard('chief', async (org) => {
			await setupOrg(org);
		});
		// 进设置 → 光标落到「重命名公司」
		await gotoSettingsRow(board, '重命名公司');

		// ① 未改动直接回车 → 保留原名退出，无错误
		board.handleInput('\r');
		expect(board.render(80).join('\n')).toContain('公司名: dev-team_');
		board.handleInput('\r');
		let j = board.render(80).join('\n');
		expect(j).toContain('重命名公司'); // 回到设置列表
		expect(j).not.toContain('公司名不能为空');
		expect(j).not.toContain('公司名:'); // 已退出输入态
		await expect(fs.readdir(join(process.env.ORG_ROOT!, 'dev-team'))).resolves.toBeTruthy();

		// ② 仍在设置页、光标仍在「重命名公司」→ 再进输入；清空后回车也保留原名
		board.handleInput('\r');
		expect(board.render(80).join('\n')).toContain('公司名: dev-team_');
		for (let k = 0; k < 'dev-team'.length; k++) board.handleInput('\x7f');
		expect(board.render(80).join('\n')).toContain('公司名: _');
		board.handleInput('\r');
		j = board.render(80).join('\n');
		expect(j).not.toContain('公司名不能为空');
		await expect(fs.readdir(join(process.env.ORG_ROOT!, 'dev-team'))).resolves.toBeTruthy();
	});

	it('P4 过滤：再次 / 保留既有条件，Esc 还原（不凭空清空）', async () => {
		const board = await makeBoard('chief', async (org) => {
			await setupOrg(org);
			await seedTask(org, { title: '周报任务' });
			await seedTask(org, { title: '无关任务' });
		});
		// 输入过滤并锁定
		board.handleInput('/');
		for (const ch of '周报') board.handleInput(ch);
		board.handleInput('\r'); // 锁定
		let j = board.render(100).join('\n');
		expect(j).toContain('周报任务');
		expect(j).not.toContain('无关任务');

		// 再次 / → 既有条件保留（可继续微调）
		board.handleInput('/');
		j = board.render(100).join('\n');
		expect(j).toContain('过滤: 周报_');

		// Esc → 还原到编辑前的值（仍是「周报」）
		board.handleInput('\u001b');
		j = board.render(100).join('\n');
		expect(j).toContain('周报任务');
		expect(j).not.toContain('无关任务');
	});

	it('P6 列表行数自适应：终端越高列表越长（18 行→10 条，40 行→全部）', async () => {
		await makeBoard('chief', async (org) => {
			await setupOrg(org);
			for (let i = 0; i < 15; i++) await seedTask(org, { title: `任务${i}` });
		});
		const countRows = (b: OrgBoard) =>
			b
				.render(100)
				.map(stripAnsi)
				.filter((l) => /^\s*[> ] M-[0-9a-z]+/.test(l)).length;

		const narrow = await makeBoardRows(18); // maxTotal 17 → listRows 10
		expect(countRows(narrow)).toBe(10);
		expect(narrow.render(100).map(stripAnsi).join('\n')).toContain('…共 15 条');

		const tall = await makeBoardRows(40); // maxTotal 39 → listRows 30（≥15 条全显示）
		expect(countRows(tall)).toBe(15);
		expect(tall.render(100).map(stripAnsi).join('\n')).not.toContain('…共 15 条');
	});

	it('P2 成员列表溢出提示：成员数超过窗口时给出「…共 N 名成员」', async () => {
		const extra: string[] = [];
		const board = await makeBoardRows(18, async (org) => {
			await setupOrg(org); // dev-team：chief / worker-a / worker-b
			const manyChief = join(tmpdir(), 'org-board-many-chief');
			mkdirSync(manyChief, { recursive: true });
			extra.push(manyChief);
			await createOrg('many', { name: 'chief', dir: manyChief });
			for (let i = 0; i < 12; i++) {
				const d = join(tmpdir(), `org-board-extra-${i}`);
				mkdirSync(d, { recursive: true });
				extra.push(d);
				await joinOrg('many', {
					manifest: { name: `m${i}`, label: `M${i}`, role: 'member', description: 'x' },
					dir: d,
				});
			}
		});
		// 默认打开字典序首 org（dev-team）→ Tab 切到 many → 成员视角
		board.handleInput('\t');
		board.handleInput('\u001b[C');
		// 注意：Tab 切公司时标题立即变、成员数据是异步加载的，必须等到数据到齐再断言
		let j = '';
		for (let i = 0; i < 80; i++) {
			j = board.render(100).map(stripAnsi).join('\n');
			if (j.includes('…共 13 名成员')) break;
			await sleep(10);
		}
		expect(j).toContain('── org:many');
		expect(j).toContain('…共 13 名成员'); // listRows=10 → 溢出提示（同时证明 13 名成员全部加载）
		for (const d of extra) rmSync(d, { recursive: true, force: true });
	});

	it('P3 确认屏：标题用 error 色强调破坏性后果', async () => {
		const calls: { color: string; text: string }[] = [];
		const spy = {
			fg: (color: string, text: string) => {
				calls.push({ color, text });
				return text;
			},
			bold: (t: string) => t,
			bg: (_c: string, t: string) => t,
		};
		const board = await makeBoard(
			'chief',
			async (org) => {
				await setupOrg(org);
			},
			spy,
		);
		// 按标签定位（不写死行号：设置页会插行）
		await gotoSettingsRow(board, '删除公司');
		board.handleInput('\r');
		board.render(100);
		expect(calls.some((c) => c.color === 'error' && c.text.includes('确认：'))).toBe(true);
	});

	it('P5 焦点归位：详情返回后光标停在原处（不跳回第一条）', async () => {
		const board = await makeBoard('chief', async (org) => {
			await setupOrg(org);
			for (let i = 0; i < 12; i++) await seedTask(org, { title: `任务${i}` });
		});
		const selLine = () =>
			board
				.render(100)
				.map(stripAnsi)
				.find((l) => l.startsWith('>')) ?? '';

		// 任务列表：移到第 6 条 → 进详情 → Esc → 光标应仍在同一条
		for (let i = 0; i < 5; i++) board.handleInput('\u001b[B');
		const before = selLine();
		expect(before).toMatch(/^> M-/);
		board.handleInput('\r'); // 进详情
		board.handleInput('\u001b'); // Esc 返回
		expect(selLine()).toBe(before);

		// 成员列表：选中 worker-a（index 1）→ 成员详情 → Esc → 光标应仍在 worker-a
		board.handleInput('\u001b[C'); // → 成员
		board.handleInput('\u001b[B');
		expect(selLine()).toContain('worker-a');
		board.handleInput('\r'); // 进成员详情
		board.handleInput('\u001b'); // Esc 返回成员列表
		expect(selLine()).toContain('worker-a');
	});
	it('T1 成员行四态圆点：睡眠 dim○ / 空闲 ○ / 工作中 accent● / 待验收 ●', async () => {
		const calls: { color: string; text: string }[] = [];
		const spy = {
			fg: (color: string, text: string) => {
				calls.push({ color, text });
				return text;
			},
			bold: (t: string) => t,
			bg: (_c: string, t: string) => t,
		};
		const servers: Server[] = [];
		try {
			const board = await makeBoard(
				'chief',
				async (org) => {
					await setupOrg(org); // chief / worker-a / worker-b
					// worker-a：在岗空闲（真 socket 可连）
					const sockA = join(root, 'wa.sock');
					servers.push(await listenFakeControl(sockA));
					await writeRuntimeFile(org, 'worker-a', { socketPath: sockA });
					// worker-b：在岗工作中
					const sockB = join(root, 'wb.sock');
					servers.push(await listenFakeControl(sockB));
					await writeRuntimeFile(org, 'worker-b', { socketPath: sockB, busy: true });
					// chief：无 runtime → 睡眠
				},
				spy,
			);
			board.handleInput('\u001b[C'); // → 成员视角
			// presence 在 loadCurrentOrg 内异步探测，等到圆点出现再断言
			let lines: string[] = [];
			for (let i = 0; i < 80; i++) {
				lines = board.render(100).map(stripAnsi);
				if (lines.some((l) => l.includes('worker-b'))) break;
				await sleep(10);
			}
			const lineOf = (n: string) => lines.find((l) => l.includes(n)) ?? '';
			expect(lineOf('chief')).toMatch(/○ chief/); // 睡眠：空心
			expect(lineOf('worker-a')).toMatch(/○ worker-a/); // 空闲：空心
			expect(lineOf('worker-b')).toMatch(/● worker-b/); // 工作中：实心
			// 颜色走主题 token：睡眠 dim、工作中 accent
			expect(calls.some((c) => c.color === 'dim' && c.text === '○')).toBe(true);
			expect(calls.some((c) => c.color === 'accent' && c.text === '●')).toBe(true);

			// 第四态：给 chief 补 runtime + 待验收交付 → r 刷新后应变实心（默认色）
			const sockC = join(root, 'chief.sock');
			servers.push(await listenFakeControl(sockC));
			await writeRuntimeFile('dev-team', 'chief', { socketPath: sockC });
			await seedTask('dev-team', {
				status: 'waiting_accept',
				assignees: [{ agent: 'chief', status: 'delivered', delivered: true }],
			});
			calls.length = 0;
			board.handleInput('r'); // 全量重载（含 presence）
			for (let i = 0; i < 80; i++) {
				lines = board.render(100).map(stripAnsi);
				if (/● chief/.test(lines.find((l) => l.includes('chief')) ?? '')) break;
				await sleep(10);
			}
			expect(lineOf('chief')).toMatch(/● chief/); // 待验收：实心
			// 计数断言：睡眠的 dim○ 消失；accent● 仅剩 worker-b（工作中）一处
			const count = (color: string, text: string) =>
				calls.filter((c) => c.color === color && c.text === text).length;
			expect(count('dim', '○')).toBe(0);
			expect(count('accent', '●')).toBe(1);
			expect(lines.find((l) => l.includes('worker-b')) ?? '').toMatch(/● worker-b/);
		} finally {
			await closeServers(servers);
		}
	});

	it('T1 成员详情标题行显示状态词', async () => {
		const servers: Server[] = [];
		try {
			const board = await makeBoard('chief', async (org) => {
				await setupOrg(org);
				const sock = join(root, 'wa.sock');
				servers.push(await listenFakeControl(sock));
				await writeRuntimeFile(org, 'worker-a', { socketPath: sock, busy: true });
			});
			board.handleInput('\u001b[C'); // → 成员视角
			board.handleInput('\u001b[B'); // 选中 worker-a
			let lines: string[] = [];
			for (let i = 0; i < 80; i++) {
				lines = board.render(100).map(stripAnsi);
				if (lines.some((l) => l.includes('● worker-a'))) break;
				await sleep(10);
			}
			board.handleInput('\r'); // 进成员详情
			const det = board.render(100).map(stripAnsi);
			const title = det.find((l) => l.includes('成员 worker-a')) ?? '';
			expect(title).toContain('●');
			expect(title).toContain('工作中');
			expect(title).toContain('派发');
		} finally {
			await closeServers(servers);
		}
	});

	it('T1 巡检：打开看板启动定时器（PRESENCE_POLL_MS），Esc 关闭后停止', async () => {
		const setSpy = vi.spyOn(globalThis, 'setInterval');
		const clearSpy = vi.spyOn(globalThis, 'clearInterval');
		try {
			const board = await makeBoard('chief', async (org) => {
				await setupOrg(org);
			});
			expect(setSpy.mock.calls.some((c) => c[1] === PRESENCE_POLL_MS)).toBe(true);
			clearSpy.mockClear();
			board.handleInput('\u001b'); // Esc 关闭看板
			expect(clearSpy).toHaveBeenCalled();
		} finally {
			setSpy.mockRestore();
			clearSpy.mockRestore();
		}
	});
	it('T2 睡眠：二次确认（工作中警示）→ y → 进程被停 + 提示行 + last-session 落盘 + 圆点转暗', async () => {
		const pids: number[] = [];
		try {
			const board = await makeBoard('chief', async (org) => {
				await setupOrg(org);
				const sock = join(root, 'wa.sock');
				const pid = await spawnFakeMember({
					scriptPath: join(root, 'fake-wa.mjs'),
					socketPath: sock,
				});
				pids.push(pid);
				// runtime.dir 必须与名册目录一致（stopMember 据此拒绝陈旧记录的 pid，见 T2/T4 修复）
				await writeRuntimeFile(org, 'worker-a', {
					socketPath: sock,
					pid,
					dir: workerDir,
					busy: true,
				});
			});
			board.handleInput('\u001b[C'); // 成员视角
			board.handleInput('\u001b[B'); // 选中 worker-a
			const lines = () => board.render(100).map(stripAnsi);
			for (let i = 0; i < 80; i++) {
				if (lines().some((l) => /● worker-a/.test(l))) break;
				await sleep(10);
			}
			// footer 按态只显示可用键（在岗 → s 睡眠）
			expect(lines().join('\n')).toContain('s 睡眠');

			board.handleInput('s'); // 触发确认屏
			const confirm = lines().join('\n');
			expect(confirm).toContain('让 worker-a 睡眠？');
			expect(confirm).toContain('正在处理任务'); // busy 额外警示

			board.handleInput('y'); // 确认
			let after = '';
			for (let i = 0; i < 150; i++) {
				after = lines().join('\n');
				if (after.includes('已睡眠')) break;
				await sleep(20);
			}
			expect(after).toContain('已睡眠');
			expect(after).toContain('下次唤醒续接上次会话');
			expect((await readLastSession('dev-team', 'worker-a'))?.sessionId).toBe(
				'sess-worker-a',
			);
			// 圆点转暗 + footer 切换为 w 唤醒（用圆点正则定位成员行，避开提示行）
			expect(lines().some((l) => /○ worker-a/.test(l))).toBe(true);
			expect(lines().join('\n')).toContain('w 唤醒');
			// 提示为瞬态：下一次按键即清除
			board.handleInput('\u001b[B');
			expect(lines().join('\n')).not.toContain('已睡眠');
		} finally {
			for (const p of pids) killIfAlive(p);
		}
	});

	it('T3 唤醒自我豁免：目标目录是本进程目录时拒绝（看板自身就在成员目录里）', async () => {
		const board = await makeBoard('chief', async (org) => {
			await setupOrg(org);
			await joinOrg(org, {
				manifest: { name: 'self', label: '我', role: 'member', description: 'x' },
				dir: process.cwd(),
			});
		});
		board.handleInput('\u001b[C');
		for (let i = 0; i < 6; i++) {
			const l =
				board
					.render(100)
					.map(stripAnsi)
					.find((x) => x.startsWith('>')) ?? '';
			if (l.includes('self')) break;
			board.handleInput('\u001b[B');
		}
		board.handleInput('w');
		let j = '';
		for (let i = 0; i < 80; i++) {
			j = board.render(100).map(stripAnsi).join('\n');
			if (j.includes('自己所在的目录')) break;
			await sleep(20);
		}
		expect(j).toContain('不能唤醒自己所在的目录');
	});

	it('T3 唤醒幂等：成员已在岗 → 提示「已在岗（无需唤醒）」', async () => {
		const servers: Server[] = [];
		try {
			const board = await makeBoard('chief', async (org) => {
				await setupOrg(org);
				const sock = join(root, 'wa.sock');
				servers.push(await listenFakeControl(sock));
				await writeRuntimeFile(org, 'worker-a', { socketPath: sock });
			});
			board.handleInput('\u001b[C');
			board.handleInput('\u001b[B');
			board.handleInput('w');
			let j = '';
			// 唤醒路径内含 socket 探测（timeout 1.5s）等异步步骤；整机负载下 2s 预算会偶发不足
			// （vitest testTimeout 为 60s，这里给足 5s，仍靠条件提前 break）。
			for (let i = 0; i < 250; i++) {
				j = board.render(100).map(stripAnsi).join('\n');
				if (j.includes('无需唤醒')) break;
				await sleep(20);
			}
			expect(j).toContain('已在岗（无需唤醒）');
		} finally {
			await closeServers(servers);
		}
	});

	it('T4 成员详情诊断行：在岗（手工启动）与睡眠（上次会话）两态据实', async () => {
		const pids: number[] = [];
		try {
			const board = await makeBoard('chief', async (org) => {
				await setupOrg(org);
				const sock = join(root, 'wa.sock');
				const pid = await spawnFakeMember({
					scriptPath: join(root, 'fake-wa.mjs'),
					socketPath: sock,
				});
				pids.push(pid);
				// 无 tmux 会话 → 应显示"手工启动"（人类手工启动成员的真实形态）
				await writeRuntimeFile(org, 'worker-a', {
					socketPath: sock,
					pid,
					dir: workerDir,
					sessionId: 'abc123xyz',
				});
			});
			board.handleInput('\u001b[C');
			board.handleInput('\u001b[B');
			for (let i = 0; i < 80; i++) {
				if (
					board
						.render(100)
						.map(stripAnsi)
						.some((l) => /○ worker-a/.test(l))
				)
					break;
				await sleep(10);
			}
			board.handleInput('\r'); // 进详情
			let det = board.render(100).map(stripAnsi);
			const online = det.find((l) => l.includes('pid ')) ?? '';
			expect(online).toContain(`pid ${pids[0]}`);
			expect(online).toContain('在岗');
			expect(online).toContain('手工启动');
			expect(online).toContain('会话 abc123…');

			// 停掉后：再进详情应据实切成"已睡眠 · 上次会话"
			board.handleInput('\u001b'); // 回列表
			board.handleInput('s');
			board.handleInput('y');
			for (let i = 0; i < 150; i++) {
				det = board.render(100).map(stripAnsi);
				if (det.some((l) => l.includes('已睡眠'))) break;
				await sleep(20);
			}
			board.handleInput('\r'); // 再进详情
			const slept =
				board
					.render(100)
					.map(stripAnsi)
					.find((l) => l.includes('已睡眠')) ?? '';
			expect(slept).toContain('已睡眠 · 上次会话 abc123…');
		} finally {
			for (const p of pids) killIfAlive(p);
		}
	});
	it('T5 设置页：自动唤醒开关可切换、持久化到本组织 org.json、重启后保持', async () => {
		const board = await makeBoard('chief', async (org) => {
			await setupOrg(org);
		});
		await gotoSettingsRow(board, '自动唤醒');
		const lines = () => board.render(100).map(stripAnsi).join('\n');
		expect(lines()).toContain('自动唤醒（本组织）：关'); // 缺省关（维持现状）

		board.handleInput('\r'); // 切换
		for (let i = 0; i < 80; i++) {
			if (lines().includes('自动唤醒（本组织）：开')) break;
			await sleep(10);
		}
		expect(lines()).toContain('自动唤醒（本组织）：开');
		expect(lines()).toContain('已开启「自动唤醒」（本组织：负责人派活会拉起睡眠成员）');
		// 落盘到**本组织** org.json（而非单机 .board.json）
		const raw = JSON.parse(
			readFileSync(join(root, 'orgdata', 'dev-team', 'org.json'), 'utf8'),
		) as { settings?: { autoWake?: boolean } };
		expect(raw.settings?.autoWake).toBe(true);

		// 新开看板读同一组织 → 开关保持（持久化生效）
		const board2 = await makeBoard('chief');
		await gotoSettingsRow(board2, '自动唤醒');
		expect(board2.render(100).map(stripAnsi).join('\n')).toContain('自动唤醒（本组织）：开');
	});
	/**
	 * 看板上岗入口（ADR-0046 D3：设置行 + `o` 键）
	 *
	 * 验的是「人不用记命令也能切上岗」以及「不可上岗时据实给出路、不静默」。
	 * 上岗能力由 org 侧注入（BoardHooks.duty）；未注入时看板不得显示任何上岗入口。
	 */
	describe('org 看板上岗入口', () => {
		type DutyStateName = 'unavailable' | 'eligible' | 'on';

		async function makeBoardWithDuty(
			state: DutyStateName,
			toggle: (on: boolean) => Promise<{ ok: boolean; message: string }>,
		): Promise<OrgBoard> {
			await setupOrg();
			const board = new OrgBoard('chief', mockTui(), makeMockTheme(), () => {}, {
				duty: { state: () => state, toggle },
			} as never);
			for (let i = 0; i < 120; i++) {
				const lines = board.render(80);
				if (!lines.some((l) => l.includes('加载中'))) return board;
				await sleep(10);
			}
			return board;
		}

		it('可上岗：设置页出现「上岗状态」行，Enter 触发上岗', async () => {
			const toggle = vi.fn(async () => ({ ok: true, message: '已在岗' }));
			const board = await makeBoardWithDuty('eligible', toggle);
			await gotoSettingsRow(board, '上岗状态');
			expect(stripAnsi(board.render(100).join('\n'))).toContain('可上岗');
			board.handleInput('\r');
			await sleep(20);
			expect(toggle).toHaveBeenCalledWith(true);
		});

		it('在岗：Enter 触发离岗', async () => {
			const toggle = vi.fn(async () => ({ ok: true, message: '已离岗' }));
			const board = await makeBoardWithDuty('on', toggle);
			await gotoSettingsRow(board, '上岗状态');
			board.handleInput('\r');
			await sleep(20);
			expect(toggle).toHaveBeenCalledWith(false);
		});

		it('`o` 键可上岗（0 步直达）', async () => {
			const toggle = vi.fn(async () => ({ ok: true, message: '已在岗' }));
			const board = await makeBoardWithDuty('eligible', toggle);
			board.handleInput('o');
			await sleep(20);
			expect(toggle).toHaveBeenCalledWith(true);
		});

		it('底部图例按方向显示 o 键（可上岗 → o 上岗）', async () => {
			const board = await makeBoardWithDuty(
				'eligible',
				vi.fn(async () => ({ ok: true, message: '' })),
			);
			expect(stripAnsi(board.render(100).join('\n'))).toContain('o 上岗');
		});

		it('不可上岗：交给 org 侧单一裁定，拒绝原因原样回报给人（不静默）', async () => {
			// R4：看板不再自带第二套判定——它只管调 toggle，把 setDuty 的决定/show 回来。
			const toggle = vi.fn(async () => ({
				ok: false,
				message:
					'不可上岗：本会话没有可用的控制 socket。先开会话控制 /control on，再执行 /org on',
			}));
			const board = await makeBoardWithDuty('unavailable', toggle);
			board.handleInput('o');
			await sleep(20);
			expect(toggle).toHaveBeenCalledTimes(1);
			const out = stripAnsi(board.render(100).join('\n'));
			expect(out).toContain('/control on');
		});

		it('未注入 duty 能力 → 不显示任何上岗入口（回归保护）', async () => {
			const board = await makeBoard('chief', async (org) => {
				await setupOrg(org);
			});
			const out = stripAnsi(board.render(100).join('\n'));
			expect(out).not.toContain('o 上岗');
			expect(out).not.toContain('o 离岗');
			// 设置页首个可定位行仍是既有项（没有多出「上岗状态」行）
			await gotoSettingsRow(board, '任务排序');
		});
	});
	describe('成员启动参数（看板：D4 仅人类可改 / D7 现值可查）', () => {
		/** 成员列表里把光标移到指定成员（顺序不稳，按名字定位） */
		function selectMember(board: OrgBoard, name: string) {
			for (let i = 0; i < 12; i++) {
				const l =
					board
						.render(100)
						.map(stripAnsi)
						.find((x) => x.startsWith('>')) ?? '';
				if (l.includes(name)) return;
				board.handleInput('\u001b[B');
			}
		}

		/** 进入成员视角（只在尚未处于该视角时调用一次） */
		function gotoPeople(board: OrgBoard) {
			board.handleInput('\u001b[C');
		}

		/** 选中某成员并进成员详情（不切视角） */
		function enterDetail(board: OrgBoard, name: string) {
			selectMember(board, name);
			board.handleInput('\r');
		}

		async function memberOf(org: string, name: string) {
			const o = await readOrg(org);
			return o.members.find((m) => m.name === name);
		}

		it('成员详情展示当前启动参数（有值显示值、无字段据实显示（无））', async () => {
			const board = await makeBoard('', async (org) => {
				await setupOrg(org);
				await setMemberLaunchArgs(org, 'worker-a', '--no-permission-gate');
			});
			gotoPeople(board);
			enterDetail(board, 'worker-a');
			expect(
				board
					.render(100)
					.map(stripAnsi)
					.some((l) => l.includes('启动参数：--no-permission-gate')),
			).toBe(true);

			board.handleInput('\u001b'); // 回成员列表（不切视角）
			enterDetail(board, 'worker-b');
			expect(
				board
					.render(100)
					.map(stripAnsi)
					.some((l) => l.includes('启动参数：（无）')),
			).toBe(true);
		});

		it('人类操作台：编辑先展示现值 → 保存落盘 + 留痕 + 提示', async () => {
			const board = await makeBoard('', async (org) => {
				await setupOrg(org);
				await setMemberLaunchArgs(org, 'worker-a', '--no-permission-gate');
			});
			gotoPeople(board);
			enterDetail(board, 'worker-a');
			board.handleInput('p');
			const screen = board.render(100).map(stripAnsi).join('\n');
			expect(screen).toContain('当前值：--no-permission-gate'); // 编辑时展示现值
			expect(screen).toContain('新值：');

			for (let k = 0; k < '--no-permission-gate'.length; k++) board.handleInput('\x7f');
			for (const ch of '--model x') board.handleInput(ch);
			board.handleInput('\r');
			for (let i = 0; i < 60; i++) {
				if ((await memberOf('dev-team', 'worker-a'))?.launchArgs === '--model x') break;
				await sleep(20);
			}
			const m = await memberOf('dev-team', 'worker-a');
			expect(m?.launchArgs).toBe('--model x');
			expect(m?.launchArgsUpdatedAt).toBeTruthy();
			expect(board.render(100).map(stripAnsi).join('\n')).toContain('启动参数已更新');
		});

		it('人类操作台：引号不成对 → 拒绝保存、保留原值、留在编辑态', async () => {
			const board = await makeBoard('', async (org) => {
				await setupOrg(org);
				await setMemberLaunchArgs(org, 'worker-a', '--no-permission-gate');
			});
			gotoPeople(board);
			enterDetail(board, 'worker-a');
			board.handleInput('p');
			for (let k = 0; k < '--no-permission-gate'.length; k++) board.handleInput('\x7f');
			for (const ch of '-e "/a b') board.handleInput(ch);
			board.handleInput('\r');
			await sleep(30);
			const screen = board.render(100).map(stripAnsi).join('\n');
			expect(screen).toContain('引号不成对');
			expect(screen).toContain('新值：'); // 仍在编辑态
			expect((await memberOf('dev-team', 'worker-a'))?.launchArgs).toBe(
				'--no-permission-gate',
			);
		});

		it('人类操作台：清空保存 ⇒ 删除该参数（唤醒时不带额外参数）', async () => {
			const board = await makeBoard('', async (org) => {
				await setupOrg(org);
				await setMemberLaunchArgs(org, 'worker-a', '--no-permission-gate');
			});
			gotoPeople(board);
			enterDetail(board, 'worker-a');
			board.handleInput('p');
			for (let k = 0; k < '--no-permission-gate'.length; k++) board.handleInput('\x7f');
			board.handleInput('\r');
			for (let i = 0; i < 60; i++) {
				if ((await memberOf('dev-team', 'worker-a'))?.launchArgs === undefined) break;
				await sleep(20);
			}
			const m = await memberOf('dev-team', 'worker-a');
			expect(m?.launchArgs).toBeUndefined();
			expect(m?.launchArgsUpdatedAt).toBeTruthy();
		});

		it('成员视角：不提示该操作，按下则拒绝并说明（判据＝cwd 在本组织名册）', async () => {
			const board = await makeBoard('worker-a', async (org) => {
				await setupOrg(org);
			});
			gotoPeople(board);
			enterDetail(board, 'chief');
			// 判据看的是「本 cwd 是否在本组织名册」，所以必须真的站在成员目录里
			// （只看构造入参的旧判据会让「cwd 已不在名册」的人类也失去编辑权）
			const prevCwd = process.cwd();
			process.chdir(workerDir);
			try {
				expect(board.render(100).map(stripAnsi).join('\n')).not.toContain('p 启动参数');
				board.handleInput('p');
				expect(board.render(100).map(stripAnsi).join('\n')).toContain('仅人类操作台');
			} finally {
				process.chdir(prevCwd);
			}
		});

		it('cwd 属于**别的组织**成员目录 → 在本组织看板仍属人类操作台（判据按本组织名册）', async () => {
			const otherDir = join(tmpdir(), 'org-board-other-chief');
			mkdirSync(otherDir, { recursive: true });
			const board = await makeBoard('', async (org) => {
				await setupOrg(org);
				await createOrg('other-co', { name: 'other-chief', dir: otherDir });
			});
			gotoPeople(board);
			enterDetail(board, 'worker-a');
			const prevCwd = process.cwd();
			process.chdir(otherDir); // 我是 other-co 的负责人，但打开的是 dev-team 的看板
			try {
				expect(board.render(100).map(stripAnsi).join('\n')).toContain('p 启动参数');
				board.handleInput('p');
				expect(board.render(100).map(stripAnsi).join('\n')).toContain('新值：');
			} finally {
				process.chdir(prevCwd);
			}
		});

		it('启动参数编辑屏在 2 种宽度下都不超宽（TUI 强制要求）', async () => {
			const board = await makeBoard('', async (org) => {
				await setupOrg(org);
				await setMemberLaunchArgs(
					org,
					'worker-a',
					'--no-permission-gate --model deepseek-v4-pro',
				);
			});
			gotoPeople(board);
			enterDetail(board, 'worker-a');
			board.handleInput('p'); // 进入编辑态（等价于用户按 p）
			for (const width of [80, 120]) {
				for (const line of board.render(width)) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				}
			}
		});
	});

	// ── 账本自动重载（看板必须跟上别的进程写的状态）──────────────────────────────
	// 回归背景：看板原先只在按键/切 org/自己执行动作后重读账本 → 成员在另一进程里认领/交付后，
	// 屏上"成员动态"是新的（RPC），任务与参与者状态却停在打开看板那一刻（"状态没更新"）。
	describe('账本自动重载 + 按 id 保光标', () => {
		const rowsOf = (board: OrgBoard) => board.render(100).map(stripAnsi);
		const selectedLine = (board: OrgBoard) =>
			rowsOf(board).find((l) => l.startsWith('>')) ?? '';
		const lineIndexOf = (board: OrgBoard, text: string) =>
			rowsOf(board).findIndex((l) => l.includes(text));

		it('remapSelectionById：跟住原任务；任务已不在列表才夹紧', () => {
			const a = { id: 'A' };
			const b = { id: 'B' };
			const c = { id: 'C' };
			expect(remapSelectionById([a, b, c], 0, 'A')).toBe(0);
			// 重排（A 被挤到中间）→ 仍指向 A
			expect(remapSelectionById([c, a, b], 0, 'A')).toBe(1);
			// 任务已移出本列表（换了 tab / 被删）→ 夹紧到边界，不越界
			expect(remapSelectionById([b, c], 5, 'A')).toBe(1);
			expect(remapSelectionById([], 3, 'A')).toBe(0);
		});

		it('外部改动让列表重排 → 重载后光标跟住原任务；内容没变则不重载', async () => {
			const board = await makeBoard('chief', async (org) => {
				await setupOrg(org);
				for (const title of ['任务甲', '任务乙', '任务丙']) await seedTask(org, { title });
			});
			const selId = () => selectedLine(board).match(/M-[a-z0-9]+/)?.[0] ?? '';
			const rowIds = () =>
				rowsOf(board)
					.map((l) => l.match(/M-[a-z0-9]+/)?.[0])
					.filter((v): v is string => !!v);

			// 选**中间**那一行：这样"列表重排"必然改变它的行号（与排序方向无关）
			board.handleInput('\u001b[B');
			const keepId = selId();
			expect(keepId).not.toBe('');
			const idxs = [lineIndexOf(board, keepId)];
			const others = rowIds().filter((id) => id !== keepId);
			expect(others.length).toBe(2);

			// 逐个改动另外两条（`saveTask` 总会刷新 updatedAt → 它排到某一端 → 列表顺序必变）
			for (const id of others) {
				const ext = (await readTask('dev-team', id))!;
				ext.history.push({ at: new Date().toISOString(), event: 'retried', by: 'chief' });
				await saveTask(ext);
				expect(
					await (board as never as { reloadLedger(): Promise<boolean> }).reloadLedger(),
				).toBe(true);
				// 关键：光标仍在**同一条任务**上（按 id 跟随，而不是沿用旧行号）
				expect(selId()).toBe(keepId);
				idxs.push(lineIndexOf(board, keepId));
			}
			// 列表确实重排过——否则本用例证明不了"按 id 跟随"
			expect(new Set(idxs).size).toBeGreaterThan(1);

			// 内容没变 → 不重载（避免每拍无意义重排屏幕）
			expect(
				await (board as never as { reloadLedger(): Promise<boolean> }).reloadLedger(),
			).toBe(false);
			(board as never as { close(): void }).close();
		});

		it('外部认领（成员进程）→ 重载后任务离开「待处理」标签页（聚合状态不再陈旧）', async () => {
			let seeded!: { id: string };
			const board = await makeBoard('chief', async (org) => {
				await setupOrg(org);
				seeded = (await seedTask(org, { title: '被外部认领的任务' })) as never;
			});
			expect(rowsOf(board).join('\n')).toContain('被外部认领的任务');

			// 成员进程语义：invited → claimed + 刷新聚合状态（in_progress）
			const fresh = (await readTask('dev-team', seeded.id))!;
			transitionAssignee(fresh.subTasks[0].assignees[0], 'claimed', 'worker-a');
			refreshStatus(fresh);
			await saveTask(fresh);

			expect(
				await (board as never as { reloadLedger(): Promise<boolean> }).reloadLedger(),
			).toBe(true);
			// 「待处理」页不再显示它……
			expect(rowsOf(board).join('\n')).not.toContain('被外部认领的任务');
			// ……切到「进行中」能看到
			board.handleInput('2');
			expect(rowsOf(board).join('\n')).toContain('被外部认领的任务');
			(board as never as { close(): void }).close();
		});

		it('成员视角下账本自动重载**不得**改写光标（selIdx 是全视角共用游标）', async () => {
			let seeded!: { id: string };
			const board = await makeBoard('chief', async (org) => {
				await setupOrg(org);
				seeded = (await seedTask(org, { title: '任务甲' })) as never;
			});
			// 进成员视角，选中第二个成员（成员表顺序：chief、worker-a、worker-b）
			board.handleInput('\u001b[C');
			board.handleInput('\u001b[B');
			const before = selectedLine(board);
			expect(before).toContain('worker-a');

			// 别的进程改任务 → 指纹变化 → 巡检拍触发的重载
			const t = (await readTask('dev-team', seeded.id))!;
			t.history.push({ at: new Date().toISOString(), event: 'retried', by: 'chief' });
			await saveTask(t);
			expect(
				await (board as never as { reloadLedger(): Promise<boolean> }).reloadLedger(),
			).toBe(true);

			// 关键：光标仍在**同一个成员**上。旧实现无条件按任务列表重排 selIdx，
			// 会把成员视角的光标挪到 worker-a 之外（成员视角 w/x 无二次确认 → 可致按错对象）。
			expect(selectedLine(board)).toBe(before);
			(board as never as { close(): void }).close();
		});
	});
});
