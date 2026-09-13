/**
 * 看板上的「成员动态」与「中断」（ADR-0052 / ADR-0053）
 *
 * 用**假 control socket**（应答 ping / get_history / abort）驱动，验证：
 * - 列表页：每个成员一行"最近一句话"；不在岗成员显示"（无动态：不在岗）"
 * - 详情屏："最近动态："区块 + 诊断行给出**可复制执行**的 `tmux attach -t …`（据实：仅 tmux 托管）
 * - 中断：成功回执 / 旧版 control 据实失败 / 不在岗无需中断
 *
 * 注：只 mock LLM 无关的外部边界（成员的 control socket 是外部进程边界）；
 * 账本、runtime、四态判定全部走真实代码。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { tmuxManagedMembers } = vi.hoisted(() => ({
	tmuxManagedMembers: vi.fn(async () => new Set<string>()),
}));
// 只替换"谁由 tmux 托管"的判定（真实实现要调 tmux 二进制）；其余按原样
vi.mock('../../../extensions/auto/org/lifecycle.js', async (orig) => {
	const actual = await orig<typeof import('../../../extensions/auto/org/lifecycle.js')>();
	return { ...actual, tmuxManagedMembers };
});

import { OrgBoard } from '../../../extensions/auto/org/board.js';
import { createOrg, joinOrg } from '../../../extensions/auto/org/orgstore.js';
import { assertWithinWidth, makeMockTheme, stripAnsi } from '../../../src/tui-testing/index.js';
import { claimSlot } from '../../../extensions/auto/org/slot.js';
import {
	createTaskWithId,
	findOverdue,
	markOverdue,
	saveTask,
} from '../../../extensions/auto/org/task.js';
import { writeRuntimeFile } from './org-lifecycle-helpers.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ORG = 'dev-team';
let root = '';
const chiefDir = join(tmpdir(), 'org-actui-chief');
const workerA = join(tmpdir(), 'org-actui-worker-a');
const workerB = join(tmpdir(), 'org-actui-worker-b');
const servers: net.Server[] = [];

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), 'org-actui-'));
	process.env.ORG_ROOT = root;
	for (const d of [chiefDir, workerA, workerB]) mkdirSync(d, { recursive: true });
	tmuxManagedMembers.mockReset();
	tmuxManagedMembers.mockResolvedValue(new Set<string>());
});

afterEach(async () => {
	for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
	rmSync(root, { recursive: true, force: true });
	delete process.env.ORG_ROOT;
});

/** 假 control：应答 ping（在岗探测）、get_history（动态）、abort（中断） */
async function fakeControl(
	sock: string,
	opts: { entries?: unknown[]; abortOk?: boolean; onAbort?: () => void } = {},
): Promise<void> {
	const server = net.createServer((socket) => {
		socket.on('data', (chunk: Buffer) => {
			for (const line of chunk.toString('utf8').split('\n')) {
				if (!line.trim()) continue;
				const msg = JSON.parse(line) as { type: string };
				const reply = (success: boolean, data?: unknown) =>
					socket.write(
						`${JSON.stringify({ type: 'response', command: msg.type, success, ...(data !== undefined ? { data } : {}) })}\n`,
					);
				if (msg.type === 'ping') reply(true);
				else if (msg.type === 'get_history') reply(true, { entries: opts.entries ?? [] });
				else if (msg.type === 'abort') {
					opts.onAbort?.();
					reply(opts.abortOk !== false);
				} else reply(false);
			}
		});
	});
	servers.push(server);
	await new Promise<void>((r) => server.listen(sock, () => r()));
}

async function setupOrg(): Promise<void> {
	await createOrg(ORG, { name: 'chief', dir: chiefDir });
	await joinOrg(ORG, { manifest: { name: 'worker-a', role: 'member' }, dir: workerA });
	await joinOrg(ORG, { manifest: { name: 'worker-b', role: 'member' }, dir: workerB });
}

/** 造一条派给某成员的任务（用于成员详情页的协作事实行：队列 / 在跑 / 逾期） */
async function seedTask(
	agent: string,
	over: {
		title?: string;
		dueAt?: string | null;
		status?: 'todo' | 'in_progress' | 'waiting_accept' | 'closed';
		assignee?: 'invited' | 'claimed' | 'delivered' | 'returned';
	} = {},
) {
	const t = await createTaskWithId(ORG, {
		org: ORG,
		title: over.title ?? '协作事实行用例',
		background: '',
		items: [],
		dispatcher: 'chief',
		dispatcherRole: 'chief',
		createdAt: new Date().toISOString(),
		status: over.status ?? 'todo',
		subTasks: [
			{
				id: 'S1',
				description: 'd',
				dueAt: over.dueAt ?? null,
				assignees: [
					{
						agent,
						dir: agent === 'worker-a' ? workerA : workerB,
						status: over.assignee ?? 'invited',
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

async function makeBoard(): Promise<OrgBoard> {
	const board = new OrgBoard(
		'chief',
		{ requestRender: () => {}, setFocus: () => {} } as never,
		makeMockTheme() as never,
		() => {},
		{},
	);
	for (let i = 0; i < 120; i++) {
		const lines = board.render(80);
		if (!lines.some((l) => l.includes('加载中'))) return board;
		await sleep(10);
	}
	return board;
}

/** 测试直接触发一次探测/动态刷新（否则要等 4s 巡检节拍） */
async function refresh(board: OrgBoard): Promise<void> {
	// SAFETY: 目标是 board 的私有实现细节（presence/activity 刷新），仅为测试提供确定性
	const b = board as unknown as {
		refreshPresence(): Promise<boolean>;
		refreshActivity(): Promise<void>;
	};
	await b.refreshPresence();
	await b.refreshActivity();
}

function view(board: OrgBoard, width = 100): string {
	return board.render(width).map(stripAnsi).join('\n');
}

async function waitFor(board: OrgBoard, needle: string): Promise<string> {
	let last = '';
	for (let i = 0; i < 150; i++) {
		last = view(board);
		if (last.includes(needle)) return last;
		await sleep(20);
	}
	return last;
}

const entry = (text: string) => ({ role: 'assistant', kind: 'text', text, timestamp: Date.now() });

describe('看板 · 成员动态', () => {
	it('列表页：在岗成员显示"最近一句话"，不在岗显示"（无动态：不在岗）"', async () => {
		await setupOrg();
		const sock = join(root, 'a.sock');
		await fakeControl(sock, { entries: [entry('正在改 applyTools 覆写')] });
		await writeRuntimeFile(ORG, 'worker-a', { socketPath: sock });

		const board = await makeBoard();
		await refresh(board);
		board.handleInput('\u001b[C'); // → 成员视角
		const out = view(board);

		expect(out).toContain('最近 正在改 applyTools 覆写');
		expect(out).toContain('（无动态：不在岗）');
	});

	it('详情屏：显示"最近动态："区块 + 可复制执行的 tmux attach 提示（据实）', async () => {
		await setupOrg();
		const sock = join(root, 'a.sock');
		await fakeControl(sock, {
			entries: [entry('已定位到覆写点'), entry('正在跑回归')],
		});
		await writeRuntimeFile(ORG, 'worker-a', { socketPath: sock });
		tmuxManagedMembers.mockResolvedValue(new Set(['worker-a']));

		const board = await makeBoard();
		await refresh(board);
		board.handleInput('\u001b[C'); // → 成员视角
		board.handleInput('\u001b[B'); // ↓ 选中 worker-a（第 0 行是 chief）
		board.handleInput('\r'); // 进入其详情
		await waitFor(board, '最近动态：');
		const out = view(board);

		expect(out).toContain('最近动态：');
		expect(out).toContain('正在跑回归');
		expect(out).toContain(`tmux attach -t `);
		expect(out).toContain('Ctrl-b d 返回');
	});

	it('详情屏：非 tmux 托管成员不给无效命令（据实说"手工启动"）', async () => {
		await setupOrg();
		const sock = join(root, 'a.sock');
		await fakeControl(sock, { entries: [entry('干活中')] });
		await writeRuntimeFile(ORG, 'worker-a', { socketPath: sock });
		tmuxManagedMembers.mockResolvedValue(new Set<string>());

		const board = await makeBoard();
		await refresh(board);
		board.handleInput('\u001b[C');
		board.handleInput('\u001b[B'); // ↓ 选中 worker-a
		board.handleInput('\r');
		await waitFor(board, '最近动态：');
		const out = view(board);

		expect(out).toContain('手工启动');
		expect(out).not.toContain('tmux attach -t');
	});
});

describe('看板 · 中断（x）', () => {
	it('成功：通知行给出"已中断…进程与会话保留"', async () => {
		await setupOrg();
		const sock = join(root, 'a.sock');
		let aborted = 0;
		await fakeControl(sock, { onAbort: () => (aborted += 1) });
		await writeRuntimeFile(ORG, 'worker-a', { socketPath: sock });

		const board = await makeBoard();
		await refresh(board);
		board.handleInput('\u001b[C'); // → 成员视角
		board.handleInput('\u001b[B'); // ↓ 选中 worker-a（第 0 行是 chief）
		board.handleInput('x'); // 中断
		const out = await waitFor(board, '已中断');

		expect(aborted).toBe(1);
		expect(out).toContain('已中断 worker-a 的当前轮');
		expect(out).toContain('进程与会话保留');
	});

	it('旧版 control（不认 abort）→ 据实失败，绝不假装成功', async () => {
		await setupOrg();
		const sock = join(root, 'a.sock');
		await fakeControl(sock, { abortOk: false });
		await writeRuntimeFile(ORG, 'worker-a', { socketPath: sock });

		const board = await makeBoard();
		await refresh(board);
		board.handleInput('\u001b[C');
		board.handleInput('\u001b[B'); // ↓ 选中 worker-a
		board.handleInput('x');
		const out = await waitFor(board, '中断失败');

		expect(out).toContain('中断失败');
		expect(out).toContain('版本旧');
		expect(out).not.toContain('已中断 worker-a');
	});

	it('不在岗成员：无需中断（据实说明，不发 RPC）', async () => {
		await setupOrg();
		const board = await makeBoard();
		await refresh(board);
		board.handleInput('\u001b[C');
		board.handleInput('\u001b[B'); // ↓ 选中 worker-b（无 runtime = 不在岗）
		board.handleInput('\u001b[B');
		board.handleInput('x');
		const out = await waitFor(board, '无需中断');

		expect(out).toContain('不在岗（无需中断）');
	});
});

describe('看板 · 多宽度不超宽（ADR-0023 / AGENTS.md TUI 测试强制要求）', () => {
	it('成员列表页与成员详情页在 80/100/120 列下均不超宽', async () => {
		await setupOrg();
		const sock = join(root, 'a.sock');
		// 超长中文动态 + 超长工具结果：专挑最容易被 `truncateToWidth` 兜住的极端内容
		await fakeControl(sock, {
			entries: [
				entry(
					'正在改 extensions/auto/preset/prompt-editor.ts 的 applyTools 覆写逻辑，这一行故意写得很长很长很长',
				),
				{
					role: 'tool',
					kind: 'toolResult',
					text: 'x'.repeat(300),
					toolName: 'edit',
					path: 'extensions/auto/org/board.ts',
					isError: false,
					timestamp: Date.now(),
				},
			],
		});
		await writeRuntimeFile(ORG, 'worker-a', { socketPath: sock });
		tmuxManagedMembers.mockResolvedValue(new Set(['worker-a']));

		const board = await makeBoard();
		await refresh(board);
		board.handleInput('\u001b[C'); // → 成员视角（列表页含"最近一句话"新行）
		for (const width of [80, 100, 120]) {
			assertWithinWidth(board.render(width), width);
		}

		board.handleInput('\u001b[B'); // ↓ 选中 worker-a（第 0 行是 chief）
		board.handleInput('\r'); // 进入成员详情（含"最近动态"区块）
		await waitFor(board, '最近动态：');
		for (const width of [80, 100, 120]) {
			assertWithinWidth(board.render(width), width);
		}
	});

	// 回归网（审查 P3）：成员详情页新增的**协作事实行**（在跑 / 队列 / 逾期）此前不在宽度
	// 断言覆盖范围内——旧用例只 seed 了动态 entries，这三类行根本没渲染过。这里用最容易被
	// `truncateToWidth` 兜住的极端内容（长编号槽 + 超上限队列 + 已逾期标记）逼一次。
	it('成员详情页的协作事实行（在跑/队列/逾期）在 80/100/120 列下均不超宽', async () => {
		await setupOrg();
		const sock = join(root, 'a2.sock');
		await fakeControl(sock, { entries: [entry('正在处理一条很长的动态，用于占位')] });
		await writeRuntimeFile(ORG, 'worker-a', { socketPath: sock });

		// ① 在跑：带长编号的执行槽 → 「手上：正在执行 M-xxxxxxxx/S-xxxxxxxx」
		const running = await seedTask('worker-a', { status: 'in_progress', assignee: 'claimed' });
		await claimSlot(ORG, 'worker-a', {
			taskId: running.id,
			subTaskId: running.subTasks[0].id,
		});
		// ② 队列：12 条待领取（远超默认上限 3）→ 「队列：12/3（待领取）」
		for (let i = 0; i < 12; i++) await seedTask('worker-a', { title: `排队任务 ${i}` });
		// ③ 逾期：过期且已标记 → 「S1 剩 -1h（已逾期·已标记）」
		const late = await seedTask('worker-a', {
			dueAt: new Date(Date.now() - 3600_000).toISOString(),
		});
		const marked = findOverdue([late], Date.now() + 1);
		expect(marked).toHaveLength(1);
		markOverdue(marked[0]);
		await saveTask(marked[0].task);

		const board = await makeBoard();
		await refresh(board);
		// SAFETY: 目标是 board 的私有实现细节（执行槽只读刷新），仅为测试提供确定性
		await (board as unknown as { refreshSlots(): Promise<void> }).refreshSlots();

		board.handleInput('\u001b[C'); // → 成员视角
		board.handleInput('\u001b[B'); // ↓ 选中 worker-a
		board.handleInput('\r'); // 进入成员详情
		const detail = await waitFor(board, '手上：');
		expect(detail).toContain('队列：13');
		expect(detail).toContain('已逾期·已标记');
		for (const width of [80, 100, 120]) {
			assertWithinWidth(board.render(width), width);
		}
	});
});
