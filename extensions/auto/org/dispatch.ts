// org — 派发（dispatch）：任务投递 + 握手 + 取消 / 改派 + inbox 兜底
// 投递判定：目标在岗（runtime socket 可连）→ 在线送达；否则落 inbox（任务不丢）
import * as path from 'node:path';
import { createLogger } from '@zenone/pi-logger';
import type { AgentRole, SubTask, Task } from './types.js';
import { ensureDir, isSocketAlive, nowIso, readJson, writeJsonAtomic } from './util.js';
import { inboxDir, readOrg, runtimeFile } from './orgstore.js';
import { createTaskWithId, readTask, saveTask } from './task.js';
import { classifyRpcError, rpcCall } from './util.js';

const log = createLogger('org');

export interface DispatchTarget {
	agent: string;
	dir?: string;
	/** 子任务描述（该参与者看到的具体内容） */
	description: string;
	/** 子任务级期望完成时间（可空，继承任务级） */
	dueAt?: string | null;
}

export interface DispatchOptions {
	org: string;
	dispatcher: string;
	dispatcherRole: AgentRole;
	title: string;
	background: string;
	items: string[];
	dueAt?: string | null;
	targets: DispatchTarget[];
}

/** 该 agent 对应的子任务（缺省第一个） */
function pickSubTask(task: Task, agentName?: string) {
	if (!agentName) return task.subTasks[0];
	return (
		task.subTasks.find((s) => s.assignees.some((a) => a.agent === agentName)) ??
		task.subTasks[0]
	);
}

/** 构造发往处理人会话的 handoff 式任务消息（背景 + 逐点任务 + 交付要求 + 引用）；agentName 指定时只展示该参与者自己的子任务 */
export function buildTaskMessage(task: Task, agentName?: string): string {
	const sub = pickSubTask(task, agentName);
	const lines: string[] = [];
	lines.push(`[org:task] 你收到一个来自 ${task.org} 组织、由 ${task.dispatcher} 派发的任务。`);
	lines.push('');
	lines.push(`任务编号：${task.id}`);
	lines.push(`标题：${task.title}`);
	lines.push('');
	lines.push(`背景：${task.background || '（无）'}`);
	lines.push('');
	lines.push('任务清单：');
	task.items.forEach((it, i) => lines.push(`  ${i + 1}. ${it}`));
	if (sub) {
		lines.push('');
		lines.push(`你负责的子任务（编号 ${sub.id}）：`);
		lines.push(`  ${sub.description}`);
		const effDue = sub.dueAt ?? task.dueAt;
		if (effDue) lines.push(`期望完成时间：${effDue}`);
	}
	lines.push('');
	lines.push(
		'交付要求：完成后在你自己工作台把该项标为「已完成」并写交付（结果摘要 + 产出文件路径，可到具体行），' +
			`或回复：/org report ${task.id} <子任务编号> <结果摘要>` +
			`；若要拒接（仅非负责人派发可拒）：/org reject ${task.id} <原因>。`,
	);
	lines.push('');
	lines.push('（本消息来自 org 插件；多任务请用独立会话上下文专注执行，别串味。）');
	return lines.join('\n');
}

/** 握手请求消息（非负责人派发）；agentName 指定时只展示该参与者自己的子任务 */
export function buildHandshakeMessage(task: Task, agentName?: string): string {
	const sub = pickSubTask(task, agentName);
	const lines: string[] = [];
	lines.push(`[org:request] ${task.dispatcher}（非负责人）想请你处理一个任务，需要你确认。`);
	lines.push('');
	lines.push(`任务编号：${task.id}`);
	lines.push(`标题：${task.title}`);
	lines.push(`背景：${task.background || '（无）'}`);
	task.items.forEach((it, i) => lines.push(`  ${i + 1}. ${it}`));
	if (sub) {
		lines.push('');
		lines.push(`你负责的子任务（编号 ${sub.id}）：${sub.description}`);
		const effDue = sub.dueAt ?? task.dueAt;
		if (effDue) lines.push(`期望完成时间：${effDue}`);
	}
	lines.push('');
	lines.push(
		`同意请回复：/org accept ${task.id} <子任务编号>；拒绝请回复：/org reject ${task.id} <子任务编号> <原因>。`,
	);
	return lines.join('\n');
}

// ── 派发主流程 ───────────────────────────────────────────────────────────────

export interface DispatchResult {
	task: Task;
	/** 每个目标的投递情况 */
	deliveries: {
		agent: string;
		mode: 'online' | 'inbox' | 'unreachable';
		requesting: boolean;
	}[];
}

export async function dispatchTask(opts: DispatchOptions): Promise<DispatchResult> {
	const org = await readOrg(opts.org);
	if (org.chiefName !== opts.dispatcher) {
		// 非负责人派发 → 派发人须是该 org 的 active 成员（握手流程在消息层，任务先建）
		const isMember = org.members.some((m) => m.name === opts.dispatcher && m.role === 'member');
		if (!isMember) {
			throw new Error(`你在 org「${opts.org}」中没有登记身份，不能派发任务。`);
		}
	}
	// 处理人必须是该 org 的 active 成员
	const memberNameSet = new Set(org.members.map((m) => m.name));
	for (const t of opts.targets) {
		if (!memberNameSet.has(t.agent)) {
			throw new Error(
				`处理人「${t.agent}」不是 org「${opts.org}」的成员（成员：${[...memberNameSet].join('、')}）。`,
			);
		}
	}

	const subTasks: SubTask[] = opts.targets.map((t) => ({
		id: `S-${Math.random().toString(36).slice(2, 6)}`,
		description: t.description,
		dueAt: t.dueAt,
		assignees: [
			{
				agent: t.agent,
				dir: t.dir,
				status: 'invited',
				round: 0,
				deliveries: [],
			},
		],
	}));

	const task = await createTaskWithId(opts.org, {
		org: opts.org,
		title: opts.title,
		background: opts.background,
		items: opts.items,
		dispatcher: opts.dispatcher,
		dispatcherRole: opts.dispatcherRole,
		dueAt: opts.dueAt ?? null,
		createdAt: nowIso(),
		status: 'todo',
		subTasks,
		history: [{ at: nowIso(), event: 'dispatched', by: opts.dispatcher, note: opts.title }],
	});

	// 负责人单方派发 → 直接投递任务消息；非负责人 → 握手请求（处理人 accept/reject 后才生效）
	const chiefMode = org.chiefName === opts.dispatcher;
	const deliveries: DispatchResult['deliveries'] = [];
	for (const t of opts.targets) {
		const message = chiefMode
			? buildTaskMessage(task, t.agent)
			: buildHandshakeMessage(task, t.agent);
		const outcome = await deliverMessage(opts.org, t.agent, message);
		deliveries.push({
			agent: t.agent,
			mode: outcome,
			requesting: !chiefMode,
		});
	}
	log.info('dispatch', {
		org: opts.org,
		task: task.id,
		dispatcher: opts.dispatcher,
		targets: opts.targets.map((t) => t.agent),
		chiefMode,
	});
	return { task, deliveries };
}

// ── 消息投递（在线 / inbox）──────────────────────────────────────────────────

/** inbox 已有同内容消息（防在线送达但回报超时 → 又落 inbox 造成重复投递） */
async function inboxHasMessage(dir: string, message: string): Promise<boolean> {
	const { readdir } = await import('node:fs/promises');
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return false;
	}
	for (const n of names) {
		if (!n.endsWith('.json')) continue;
		const rec = await readJson<{ message?: string }>(path.join(dir, n));
		if (rec?.message === message) return true;
	}
	return false;
}

export async function deliverMessage(
	org: string,
	agent: string,
	message: string,
): Promise<'online' | 'inbox' | 'unreachable'> {
	const rt = await readJson<{ pid: number; socketPath: string; dir: string }>(
		runtimeFile(org, agent),
	);
	let socketOk = false;
	if (rt?.socketPath) {
		socketOk = await isSocketAlive(rt.socketPath, 1200).catch(() => false);
	}
	if (socketOk && rt) {
		try {
			const { response } = await rpcCall(rt.socketPath, {
				type: 'send',
				message,
				mode: 'follow_up',
			});
			if (response.success) return 'online';
			log.warn('socket send 失败，转 inbox', { org, agent, error: response.error });
		} catch (error) {
			log.warn('socket send 异常，转 inbox', { org, agent, err: classifyRpcError(error) });
		}
	}
	// 落 inbox（离线兜底，任务不丢）。去重：与已落盘的相同消息不重复投递——
	// rpcCall 的 timeout 表示「连上并发出后等待回报超时」，消息可能已在线送达，
	// 若再落 inbox，目标下次 session_start 会重复收到同一任务的指令。
	const dir = inboxDir(org, agent);
	await ensureDir(dir);
	if (await inboxHasMessage(dir, message)) {
		log.debug('inbox 去重：同内容消息已存在，跳过重复落盘', { org, agent });
		return rt ? 'unreachable' : 'inbox';
	}
	const file = path.join(dir, `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`);
	await writeJsonAtomic(file, { at: nowIso(), message });
	return rt ? 'unreachable' : 'inbox';
}

/** 处理人离岗期间积累的 inbox 消息（session_start 提醒用） */
export async function drainInbox(org: string, agent: string): Promise<string[]> {
	const dir = inboxDir(org, agent);
	let entries: string[] = [];
	try {
		const { readdir } = await import('node:fs/promises');
		entries = await readdir(dir);
	} catch {
		return [];
	}
	const messages: string[] = [];
	for (const e of entries.sort((a, b) => a.localeCompare(b))) {
		if (!e.endsWith('.json')) continue;
		const rec = await readJson<{ at: string; message: string }>(path.join(dir, e));
		if (rec?.message) messages.push(rec.message);
	}
	return messages;
}

/** 处理后从 inbox 清掉（读取并删除文件） */
export async function takeInbox(org: string, agent: string): Promise<string[]> {
	const dir = inboxDir(org, agent);
	const messages = await drainInbox(org, agent);
	if (messages.length === 0) return messages;
	const { readdir, unlink } = await import('node:fs/promises');
	const entries = await readdir(dir).catch(() => [] as string[]);
	for (const e of entries) {
		if (e.endsWith('.json')) await unlink(path.join(dir, e)).catch(() => {});
	}
	return messages;
}

// ── 取消 / 改派 / 添加参与人 ─────────────────────────────────────────────────

export interface TaskOpResult {
	ok: boolean;
	message: string;
}

/**
 * 派发人撤销任务：
 * - 任务无「已领取/已交付」工作（未领/全 invited）→ 直接取消（close 终态 + cancelled 事件）
 * - 有人在做 → 返回 need_consent（命令层转「取消请求 + 处理人同意」）
 */
export async function cancelTaskByDispatcher(
	org: string,
	taskId: string,
	dispatcher: string,
	note?: string,
): Promise<TaskOpResult & { needConsent?: boolean }> {
	const task = await readTask(org, taskId);
	if (!task) return { ok: false, message: `任务 ${taskId} 不存在。` };
	if (task.dispatcher !== dispatcher) {
		return { ok: false, message: `只有派发人 ${task.dispatcher} 能取消任务。` };
	}
	const hasWork = task.subTasks.some((s) =>
		s.assignees.some(
			(a) => a.status === 'claimed' || a.status === 'delivered' || a.status === 'returned',
		),
	);
	if (hasWork) {
		return {
			ok: false,
			needConsent: true,
			message: `任务 ${taskId} 已有人在做，需处理人同意取消（先向处理人确认）。`,
		};
	}
	// 未领：直接取消
	await cancelTaskCore(task, dispatcher, note ?? '派发人撤销（无人领取）');
	await saveTask(task);
	return { ok: true, message: `任务 ${taskId} 已取消（未领取，直接撤销）。` };
}

/** 处理人同意取消（取消请求 + 处理人同意路径） */
export async function consentCancel(
	org: string,
	taskId: string,
	by: string,
	note?: string,
): Promise<TaskOpResult> {
	const task = await readTask(org, taskId);
	if (!task) return { ok: false, message: `任务 ${taskId} 不存在。` };
	const isAssignee = task.subTasks.some((s) => s.assignees.some((a) => a.agent === by));
	if (!isAssignee) return { ok: false, message: '只有该任务的处理人能同意取消。' };
	await cancelTaskCore(task, by, note ?? '处理人同意取消');
	await saveTask(task);
	return { ok: true, message: `任务 ${taskId} 已由 ${by} 同意取消并关闭。` };
}

async function cancelTaskCore(task: Task, by: string, note: string): Promise<void> {
	if (task.status === 'closed') throw new Error(`任务 ${task.id} 已关闭。`);
	task.status = 'closed';
	for (const s of task.subTasks) {
		for (const a of s.assignees) {
			if (a.status === 'invited' || a.status === 'claimed' || a.status === 'returned')
				a.status = 'cancelled';
		}
	}
	task.history.push({ at: nowIso(), event: 'cancelled_closed', by, note });
}

/**
 * 改派 / 添加参与人：
 * - replace=false：向该子任务追加一个新参与者（情形 B 并行）
 * - replace=true：未领取的旧参与者移除（标 cancelled + 通知旧处理人「被收回」）
 */
export async function reassignSubTask(
	org: string,
	taskId: string,
	subTaskId: string,
	dispatcher: string,
	newAgent: string,
	opts: { replace?: boolean } = {},
): Promise<TaskOpResult> {
	const task = await readTask(org, taskId);
	if (!task) return { ok: false, message: `任务 ${taskId} 不存在。` };
	if (task.dispatcher !== dispatcher) return { ok: false, message: '只有派发人能改派。' };
	const sub = task.subTasks.find((s) => s.id === subTaskId);
	if (!sub) return { ok: false, message: `子任务 ${subTaskId} 不存在。` };

	if (opts.replace) {
		// 移除未领取的旧参与者
		const old = sub.assignees.find((a) => a.status === 'invited' && a.agent !== newAgent);
		if (!old) {
			return {
				ok: false,
				message: '没有可移除的未领取参与者（已领取/已交付的需协商，不做静默替换）。',
			};
		}
		old.status = 'cancelled';
		task.history.push({
			at: nowIso(),
			event: 'reassigned',
			by: dispatcher,
			note: `${old.agent} → ${newAgent}`,
		});
	}
	sub.assignees.push({
		agent: newAgent,
		status: 'invited',
		round: 0,
		deliveries: [],
	});
	await saveTask(task);
	return { ok: true, message: `已为子任务 ${subTaskId} 添加参与者 ${newAgent}。` };
}
