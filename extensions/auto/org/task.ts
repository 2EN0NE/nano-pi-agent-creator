// org — 任务记录（task）与状态机（任务 → 子任务[] → 参与者[]）
// 任务四态：todo / in_progress / waiting_accept / closed（铁终态，不可重开）
// 参与者态：invited → claimed → delivered ⇄(打回) returned → claimed → … ；握手 reject/cancelled
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { Assignee, AssigneeStatus, Delivery, SubTask, Task, TaskStatus } from './types.js';
import { ensureDir, nowIso, readJson, writeJsonAtomic } from './util.js';
import { taskDir, taskFile } from './orgstore.js';

// ── 编号：随机字母数字（多位，org 内唯一、删除不复用）────────────────────────

const TASK_ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // 去易混 0/o/1/l
export function generateTaskId(): string {
	// 8 位随机字母数字；并发冲突由调用方检测文件已存在后重试
	const bytes = crypto.randomBytes(8);
	let out = '';
	for (let i = 0; i < 8; i++) {
		out += TASK_ID_ALPHABET[bytes[i] % TASK_ID_ALPHABET.length];
	}
	return `M-${out}`;
}

export function subTaskId(): string {
	const bytes = crypto.randomBytes(3);
	return Array.from(bytes, (b) => TASK_ID_ALPHABET[b % TASK_ID_ALPHABET.length]).join('');
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export async function readTask(org: string, id: string): Promise<Task | null> {
	return readJson<Task>(taskFile(org, id));
}

export async function saveTask(task: Task): Promise<void> {
	task.updatedAt = nowIso();
	await writeJsonAtomic(taskFile(task.org, task.id), task);
}

export async function listTasks(org: string): Promise<Task[]> {
	const dir = taskDir(org);
	let entries: string[] = [];
	try {
		entries = await fs.readdir(dir);
	} catch {
		return [];
	}
	const out: Task[] = [];
	for (const e of entries) {
		if (!e.endsWith('.json')) continue;
		const t = await readJson<Task>(path.join(dir, e));
		if (t) out.push(t);
	}
	return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function createTaskWithId(
	org: string,
	task: Omit<Task, 'id' | 'schemaVersion' | 'updatedAt'>,
): Promise<Task> {
	await ensureDir(taskDir(org));
	let id = generateTaskId();
	// 冲突重试（概率极低）
	while (await readTask(org, id)) id = generateTaskId();
	const full: Task = {
		schemaVersion: 1,
		...task,
		id,
		updatedAt: nowIso(),
	};
	await saveTask(full);
	return full;
}

function pushHistory(task: Task, event: string, by: string, note?: string): void {
	task.history.push({ at: nowIso(), event, by, note });
}

// ── 聚合与状态机 ─────────────────────────────────────────────────────────────

/** 期望完成时间继承：子任务未设 → 继承任务级 */
export function effectiveDueAt(
	task: Pick<Task, 'dueAt'>,
	sub: Pick<SubTask, 'dueAt'>,
): string | null {
	return sub.dueAt ?? task.dueAt ?? null;
}

/** 某子任务是否仍「有未决参与者」（需要处理人动作；被叫停 stopped 的除外） */
export function subTaskHasPending(sub: SubTask): boolean {
	return sub.assignees.some(
		(a) =>
			!a.stopped &&
			(a.status === 'invited' || a.status === 'claimed' || a.status === 'returned'),
	);
}

/** 按参与者状态聚合任务四态 */
export function computeTaskStatus(task: Pick<Task, 'status' | 'subTasks'>): TaskStatus {
	if (task.status === 'closed') return 'closed'; // 铁终态
	const hasPending = task.subTasks.some(subTaskHasPending);
	const anyStarted = task.subTasks.some((s) =>
		s.assignees.some(
			(a) => a.status === 'claimed' || a.status === 'delivered' || a.status === 'returned',
		),
	);
	if (!hasPending) {
		// 无未决：要么从来没人领（todo），要么全交付/全剔除（waiting_accept）
		return anyStarted ? 'waiting_accept' : 'todo';
	}
	return 'in_progress';
}

/** 变更后刷新聚合状态；closed 保护（铁终态不可再改） */
export function refreshStatus(task: Task): TaskStatus {
	if (task.status === 'closed') {
		throw new Error(`任务 ${task.id} 已关闭（铁终态），不可再变更。要处理请新开任务并引用它。`);
	}
	task.status = computeTaskStatus(task);
	return task.status;
}

const ASSIGNEE_TRANSITIONS: Record<AssigneeStatus, AssigneeStatus[]> = {
	invited: ['claimed', 'rejected', 'cancelled'],
	claimed: ['delivered', 'cancelled'],
	delivered: [], // 打回走 returned（由 rejectTask 处理）
	returned: ['claimed', 'cancelled'],
	rejected: [],
	cancelled: [],
};

/**
 * 参与者状态迁移（受保护）。to 非法 → 抛错。
 * delivered ⇄ returned 不在表内：delivered 打回应先置 returned（reject 专用路径），
 * returned 后处理人重新 claimed → delivered。
 */
export function transitionAssignee(
	assignee: Assignee,
	to: AssigneeStatus,
	_by: string,
	opts?: { note?: string },
): void {
	if (assignee.status === to) return;
	if (!ASSIGNEE_TRANSITIONS[assignee.status].includes(to)) {
		throw new Error(
			`非法的参与者状态迁移：${assignee.agent} ${assignee.status} → ${to}（任务状态机受保护）`,
		);
	}
	assignee.status = to;
	if (to === 'rejected') {
		if (!opts?.note)
			throw new Error(`拒绝必须带原因（数据格式）：/org reject <任务编号> <原因>`);
		assignee.rejectedReason = opts.note;
	}
}

// ── 交付与验收 ───────────────────────────────────────────────────────────────

/** 参与者交付：追加交付记录并置 delivered（幂等：已 delivered 再次交付 → 报错由调用方提示） */
export function addDelivery(assignee: Assignee, delivery: Delivery, by: string, task: Task): void {
	if (assignee.status === 'delivered' && assignee.deliveries.length > 0) {
		throw new Error(`该子任务 ${by} 已交付过（幂等保护，重复交付忽略）。`);
	}
	assignee.deliveries.push(delivery);
	assignee.status = 'delivered';
	pushHistory(task, 'delivered', by, delivery.summary);
}

/**
 * 验收：派发人整体验收。
 * - accept：任务在 waiting_accept（或 todo 空任务）→ closed（终态）
 * - reject：打回指定参与人（缺省 = 所有 delivered 的）→ returned + round+1 → 聚合回 in_progress
 */
export function attestTask(
	task: Task,
	by: string,
	result: 'accepted' | 'rejected',
	note?: string,
	whichAgents?: string[],
): { accepted: boolean } {
	if (task.dispatcher !== by) {
		throw new Error(`只有派发人 ${task.dispatcher} 能验收/打回任务 ${task.id}。`);
	}
	if (task.status === 'closed') {
		throw new Error(`任务 ${task.id} 已关闭（铁终态），不可再验收/打回。`);
	}
	const round = task.acceptance?.round ?? 0;
	if (result === 'accepted') {
		if (computeTaskStatus(task) !== 'waiting_accept') {
			throw new Error(`任务 ${task.id} 尚未全部交付齐，不能验收通过。`);
		}
		task.acceptance = { by, result: 'accepted', at: nowIso(), note, round: round + 1 };
		task.status = 'closed';
		pushHistory(task, 'accepted_closed', by, note);
		return { accepted: true };
	}
	// rejected：打回
	task.acceptance = { by, result: 'rejected', at: nowIso(), note, round: round + 1 };
	const targets: string[] = whichAgents ?? [];
	for (const sub of task.subTasks) {
		for (const a of sub.assignees) {
			if (a.status !== 'delivered') continue;
			if (targets.length > 0 && !targets.includes(a.agent)) continue;
			a.status = 'returned';
			a.round += 1;
		}
	}
	if (computeTaskStatus(task) !== 'in_progress') {
		// 没有可打回的（无人 delivered）也允许打回为「整体不合格」：无目标则任务回到 todo 前端？保守抛错
		if (
			targets.length === 0 &&
			!task.subTasks.some((s) => s.assignees.some((a) => a.status === 'delivered'))
		) {
			throw new Error('打回失败：没有已交付的参与者可打回。');
		}
	}
	task.status = 'in_progress';
	pushHistory(task, 'rejected_returned', by, note);
	return { accepted: false };
}

/**
 * 部分采纳（情形 B 快路径）：派发人采纳某位已交付参与者的这份交付，
 * 同子任务的其他参与者（含已交付未采纳者）标记 stopped（叫停，不点名），
 * 此后不再阻塞任务聚合。任务整体仍待派发人整体验收（approve）后关闭。
 */
export function adoptAssignee(task: Task, by: string, agentName: string, note?: string): void {
	if (task.dispatcher !== by) {
		throw new Error(`只有派发人 ${task.dispatcher} 能采纳交付。`);
	}
	if (task.status === 'closed') {
		throw new Error(`任务 ${task.id} 已关闭（铁终态）。`);
	}
	for (const sub of task.subTasks) {
		for (const a of sub.assignees) {
			if (a.agent !== agentName) {
				if (
					a.status === 'delivered' ||
					a.status === 'invited' ||
					a.status === 'claimed' ||
					a.status === 'returned'
				) {
					a.stopped = true;
				}
				continue;
			}
			if (a.status !== 'delivered') {
				throw new Error(`参与者 ${agentName} 尚未交付，不能采纳。`);
			}
			a.stopped = false; // 被采纳者
		}
	}
	task.history.push({ at: nowIso(), event: 'adopted', by, note: note ?? agentName });
}

/**
 * 验收通过 + 情形 B 采纳（命令面/TUI 的唯一入口）：存在至少一份已交付的前提下，
 * 先把未交付的未决参与者（invited/claimed/returned）叫停（stopped，不点名），
 * 再整体验收关闭（attestTask accepted 要求 waiting_accept，顺序必须先停后验，
 * 否则「a 已交付、b 在做」时 approve 永远被拒，叫停逻辑成为死代码）。
 * 返回被叫停的参与者列表（供通知，去重）。
 */
export function approveWithAdoption(task: Task, by: string, note?: string): { stopped: string[] } {
	if (task.dispatcher !== by) {
		throw new Error(`只有派发人 ${task.dispatcher} 能验收/打回任务 ${task.id}。`);
	}
	if (task.status === 'closed') {
		throw new Error(`任务 ${task.id} 已关闭（铁终态）。`);
	}
	const stopped = new Set<string>();
	let anyDelivered = false;
	for (const sub of task.subTasks) {
		for (const a of sub.assignees) {
			if (a.status === 'delivered') {
				anyDelivered = true;
				continue;
			}
			if (a.stopped || a.status === 'rejected' || a.status === 'cancelled') continue;
			a.stopped = true;
			stopped.add(a.agent);
		}
	}
	if (!anyDelivered) {
		throw new Error(`任务 ${task.id} 尚无任何交付，不能验收通过。`);
	}
	attestTask(task, by, 'accepted', note);
	return { stopped: [...stopped] };
}

/** 任务被取消（派发人撤 / 取消请求同意 / 人类强制关闭）：进 closed 终态但不算验收通过 */
export function cancelTask(task: Task, by: string, note?: string): void {
	if (task.status === 'closed') {
		throw new Error(`任务 ${task.id} 已关闭（铁终态）。`);
	}
	task.status = 'closed';
	// 不设 acceptance（非验收关闭）；history 记录取消
	for (const sub of task.subTasks) {
		for (const a of sub.assignees) {
			if (a.status === 'invited' || a.status === 'claimed' || a.status === 'returned') {
				a.status = 'cancelled';
			}
		}
	}
	pushHistory(task, 'cancelled_closed', by, note ?? '');
}

/** 派发人视角：该 agent 名下未结子任务（leave 盘点 / 视图用） */
export function findMemberOpenWork(task: Task, agent: string): boolean {
	for (const sub of task.subTasks) {
		for (const a of sub.assignees) {
			if (a.agent !== agent) continue;
			if (a.status === 'invited' || a.status === 'claimed' || a.status === 'returned')
				return true;
		}
	}
	return false;
}
