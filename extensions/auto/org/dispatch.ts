// org — 派发（dispatch）：任务投递 + 握手 + 取消 / 改派 + inbox 兜底
// 投递判定：目标在岗（runtime socket 可连）→ 在岗送达；否则落 inbox（任务不丢）
import * as path from 'node:path';
import { createLogger } from '@zenone/pi-logger';
import type { AgentRole, SubTask, Task } from './types.js';
import { ensureDir, isSocketAlive, nowIso, readJson, writeJsonAtomic } from './util.js';
import { autoWakeEnabled, inboxDir, readOrg, runtimeFile, withOrgLock } from './orgstore.js';
import { ensureAwakeForDispatch } from './lifecycle.js';
import {
	createTaskWithId,
	listTasks,
	queueLengthFor,
	readTask,
	refreshStatus,
	saveTask,
} from './task.js';
import { orgConfigStore, resolveMemberQueueCap } from './config.js';
import { classifyRpcError, rpcCall } from './util.js';
import { withSenderHeader } from './sender.js';

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
		mode: 'online' | 'uncertain' | 'inbox' | 'unreachable';
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

	const queueCap = resolveMemberQueueCap(orgConfigStore.get().memberQueueCap);

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

	// ⚠ 上限判定与建任务必须在**同一次 org 写锁**内：若两个进程各自在锁外
	// 「读账本 → 判上限 → 建任务」，会双双通过检查、写出超过 `memberQueueCap` 的队列
	// （TOCTOU，与 ADR-0055 `D4`「满则明确拒绝，不静默堆积」相悖）。`withOrgLock` 经
	// AsyncLocalStorage 可重入，`createTaskWithId` 内部再取锁不会死锁。
	const task = await withOrgLock(opts.org, async () => {
		// 排队上限（ADR-0055 `D4`）：**建任务之前**判定——拒绝时账本零改动（验收要求）。
		// 口径 = 只数“还没接手”（invited）的待办；0 / 非法配置 = 不限制。
		if (queueCap !== undefined) {
			const tasks = await listTasks(opts.org);
			const full = opts.targets
				.map((t) => ({ agent: t.agent, used: queueLengthFor(tasks, t.agent) }))
				.filter((x) => x.used >= queueCap);
			if (full.length > 0) {
				const detail = full.map((f) => `${f.agent}（${f.used}/${queueCap}）`).join('、');
				throw new Error(
					`派发被拒：${detail} 的待办队列已达上限。可改派他人、等其消化后再派，或调高 memberQueueCap 配置。`,
				);
			}
		}
		return createTaskWithId(opts.org, {
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
	});

	// 负责人单方派发 → 直接投递任务消息；非负责人 → 握手请求（处理人 accept/reject 后才生效）
	const chiefMode = org.chiefName === opts.dispatcher;
	const deliveries: DispatchResult['deliveries'] = [];
	for (const t of opts.targets) {
		// 负责人派活 + 本组织开启自动唤醒（ADR-0040 D3/D8）：先拉起睡眠目标再投递。
		// 唤醒是尽力而为的**边界**：失败/超时绝不阻塞投递（仍走 inbox 兜底，任务不丢）。
		if (chiefMode && autoWakeEnabled(org)) {
			await ensureAwakeForDispatch(opts.org, t.agent, { selfDir: process.cwd() }).catch(
				(e: unknown) =>
					log.warn('派活自动唤醒异常，改用 inbox 兜底', {
						org: opts.org,
						agent: t.agent,
						err: e instanceof Error ? e.message : String(e),
					}),
			);
			log.info('派活已自动唤醒目标', { org: opts.org, agent: t.agent });
		} else {
			// ADR-0048 D7：不唤醒也要留痕——否则排障只能靠"日志缺失"反推（UAT 教训）
			log.info('派活未自动唤醒（目标落 inbox 兜底）', {
				org: opts.org,
				agent: t.agent,
				reason: chiefMode
					? '本组织 autoWake 关（自主唤醒门禁）'
					: '派活人非负责人（唤醒权限限负责人）',
			});
		}
		const message = chiefMode
			? buildTaskMessage(task, t.agent)
			: buildHandshakeMessage(task, t.agent);
		const outcome = await deliverMessage(opts.org, t.agent, message, {
			sender: opts.dispatcher,
		});
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

/** inbox 已有同内容消息（防在岗送达但回报超时 → 又落 inbox 造成重复投递） */
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
	/**
	 * `sender` = 发送者（org 成员名）；人类操作者发起时省略 → 不注入发送者头（ADR-0044 D2）
	 * `mode` = 投递模式（ADR-0055 `D6`）：默认 `follow_up`（等它把当前轮跑完），
	 * 仅**显式抢占（L1 插话）** 才用 `steer`（插到下一次 LLM 调用前）。不改变既有默认行为。
	 */
	opts?: { sender?: string; mode?: 'steer' | 'follow_up' },
): Promise<'online' | 'uncertain' | 'inbox' | 'unreachable'> {
	// ADR-0044 D2：在此层**统一**注入发送者头 —— 在岗送达与 inbox 兜底内容一致，
	// 且"谁在说话"对模型可见（control 侧再渲染成 `[成员名]:`）。
	const payload = withSenderHeader(message, opts?.sender);
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
				message: payload,
				mode: opts?.mode ?? 'follow_up',
			});
			if (response.success) return 'online';
			log.warn('socket send 失败，转 inbox', { org, agent, error: response.error });
		} catch (error) {
			// 分类决策（F/ADR-0039）：connect（从未连上）→ 落 inbox 兜底；
			// timeout（连上并已发出，但超时未收到 control 回报）→ 无法确认送达：
			// 不落 inbox（避免与"其实已入队送达"重复投递），但也**不谎报 online**——
			// 返回 uncertain，由上层如实展示，人工可据此决定是否重派。
			const kind = classifyRpcError(error);
			if (kind === 'timeout') {
				log.warn('socket send 回报超时，送达不确定（不落 inbox）', { org, agent });
				return 'uncertain';
			}
			log.warn('socket send 连接失败，转 inbox', { org, agent, err: String(error) });
		}
	}
	// 落 inbox（未在岗兜底，任务不丢）。去重：与已落盘的相同消息不重复投递——
	// rpcCall 的 timeout 表示「连上并发出后等待回报超时」，消息可能已在岗送达，
	// 若再落 inbox，目标下次 session_start 会重复收到同一任务的指令。
	const dir = inboxDir(org, agent);
	await ensureDir(dir);
	if (await inboxHasMessage(dir, payload)) {
		log.debug('inbox 去重：同内容消息已存在，跳过重复落盘', { org, agent });
		return rt ? 'unreachable' : 'inbox';
	}
	const file = path.join(dir, `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`);
	await writeJsonAtomic(file, { at: nowIso(), message: payload });
	return rt ? 'unreachable' : 'inbox';
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
	// 改派会改变参与集合 → 聚合状态必须重算（replace 罢免旧人 / 新增未决者都可能变状态）
	refreshStatus(task);
	await saveTask(task);
	return { ok: true, message: `已为子任务 ${subTaskId} 添加参与者 ${newAgent}。` };
}

/** 投递结果的面向人措辞（重试回执用） */
const DELIVERY_WORD: Record<'online' | 'uncertain' | 'inbox' | 'unreachable', string> = {
	online: '已在岗送达',
	uncertain: '送达不确定（失败不落 inbox，避免重复投递）',
	inbox: '已落 inbox（成员不在岗，其下次在岗时取）',
	unreachable: '通道不可达（已落 inbox 兜底）',
};

/**
 * 重试：把任务**重新投递**给同一个参与者（ADR-0053 `D5`）。
 *
 * 为什么**不动参与者状态**：参与者状态机受保护（`invited/claimed/delivered/returned/rejected/cancelled`），
 * 且**没有**"退回已派发"这一迁移（用词曾是误解）。中断只停当前轮——参与者与任务的归属都没变，
 * 所以重试就是"再把指令说一遍"：附一行说明，走**既有投递通道**（在岗直达 / 失败落 inbox，任务不丢）。
 *
 * 不该用它、改走别的路的情形（据实拒绝并给出路）：
 * - 任务已 `closed`（铁终态）→ 新开任务并引用；
 * - 参与者已 `delivered` → 那是"返工"，请走**打回**（轮次 +1）；
 * - 参与者已 `stopped` / `rejected` / `cancelled` → 改派或新开任务。
 */
export async function retrySubTask(
	org: string,
	taskId: string,
	subTaskId: string,
	agent: string,
	opts: { by: string; note?: string },
): Promise<TaskOpResult> {
	const task = await readTask(org, taskId);
	if (!task) return { ok: false, message: `任务 ${taskId} 不存在。` };
	if (task.status === 'closed') {
		return {
			ok: false,
			message: `任务 ${taskId} 已关闭（铁终态），不可重试——请新开任务并引用它。`,
		};
	}
	const sub = task.subTasks.find((s) => s.id === subTaskId);
	if (!sub) return { ok: false, message: `子任务 ${subTaskId} 不存在。` };
	const assignee = sub.assignees.find((a) => a.agent === agent);
	if (!assignee) return { ok: false, message: `子任务 ${subTaskId} 上没有参与者 ${agent}。` };
	if (assignee.stopped) {
		return { ok: false, message: `${agent} 在该子任务上已被叫停，请改派或新开任务。` };
	}
	if (assignee.status === 'delivered') {
		return {
			ok: false,
			message: `${agent} 已交付该项：要返工请走「打回」（轮次 +1），要收尾请走「验收」。`,
		};
	}
	if (assignee.status === 'rejected' || assignee.status === 'cancelled') {
		return {
			ok: false,
			message: `${agent} 在该子任务上已 ${assignee.status}，请改派或新开任务。`,
		};
	}
	task.history.push({
		at: nowIso(),
		event: 'retried',
		by: opts.by,
		note: `${subTaskId} → ${agent}${opts.note ? `：${opts.note}` : ''}`,
	});
	await saveTask(task);
	const extra = opts.note
		? `\n\n（重试说明：${opts.note}）`
		: '\n\n（重试：请按上面的任务清单继续/重新处理。）';
	const delivered = await deliverMessage(org, agent, buildTaskMessage(task, agent) + extra, {
		sender: opts.by,
	});
	// ADR-0053 `D4`：重试必须落日志（谁 / 对谁 / 动作 / 结果）——命令面与看板共用这一处留痕
	log.info('任务重试', {
		org,
		task: taskId,
		sub: subTaskId,
		by: opts.by,
		agent,
		delivery: delivered,
		result: 'ok',
	});
	return {
		ok: true,
		message: `已重试：${subTaskId} → ${agent}（${DELIVERY_WORD[delivered] ?? delivered}）。`,
	};
}
