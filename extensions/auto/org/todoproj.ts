// org — 员工工作台待办投影与对账（ticket 07）
// 员工工作台 = 员工目录 `.pi/todos/`（todos 插件同源文件格式：<hex8>.md + JSON front matter + body；
// 文件名 = 裸 hex8（TODO- 只是展示前缀，todos 的 normalizeTodoId 会剥掉后拼 <hex>.md 寻址）
// 关联信息（任务↔待办）存 org 侧 todo-map.json（不写进待办文件——todos 插件重写会丢弃未知字段）
// 对账只提醒、不静默改任一边：
//   - 待办标 done 但官方任务无交付 → 提醒补交付（report）
//   - 官方已关闭但待办仍 open/done 未归档 → 提示归档
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createLogger } from '@zenone/pi-logger';
import type { Task, TodoMapEntry } from './types.js';
import { ensureDir, nowIso, readJson, realDir, writeJsonAtomic } from './util.js';
import { readOrg, taskFile, todoMapFile } from './orgstore.js';
import { effectiveDueAt, listTasks, readTask } from './task.js';

const log = createLogger('org');

export interface TodoFrontMatter {
	id: string;
	title: string;
	tags: string[];
	status: string;
	created_at: string;
	assigned_to_session?: string;
	project_id?: string;
}

/** 解析 todos 文件内容（JSON front matter + markdown body） */
export function parseTodoFile(
	content: string,
	idFallback: string,
): {
	fm: TodoFrontMatter;
	body: string;
} {
	const fm: TodoFrontMatter = {
		id: idFallback,
		title: '',
		tags: [],
		status: 'open',
		created_at: '',
	};
	if (!content.startsWith('{')) return { fm, body: content };
	// 找第一个顶层 '}' 收尾（JSON front matter 为单行或缩进 JSON，结束于第一个 `\n\n` 前？稳妥：逐行找闭合）
	const lines = content.split('\n');
	let end = -1;
	let depth = 0;
	for (let i = 0; i < lines.length; i++) {
		for (const ch of lines[i]) {
			if (ch === '{') depth++;
			else if (ch === '}') {
				depth--;
				if (depth === 0) {
					end = i;
					break;
				}
			}
		}
		if (end >= 0) break;
	}
	if (end < 0) return { fm, body: content };
	const json = lines.slice(0, end + 1).join('\n');
	try {
		const parsed = JSON.parse(json) as Partial<TodoFrontMatter>;
		if (typeof parsed.id === 'string') fm.id = parsed.id;
		if (typeof parsed.title === 'string') fm.title = parsed.title;
		if (typeof parsed.status === 'string') fm.status = parsed.status;
		if (typeof parsed.created_at === 'string') fm.created_at = parsed.created_at;
		if (Array.isArray(parsed.tags)) fm.tags = parsed.tags.filter((t) => typeof t === 'string');
		// 回写必须保留员工认领/归属字段（todos 插件同源字段，丢了会清掉员工已认领状态）
		if (typeof parsed.assigned_to_session === 'string' && parsed.assigned_to_session.trim()) {
			fm.assigned_to_session = parsed.assigned_to_session;
		}
		if (typeof parsed.project_id === 'string' && parsed.project_id) {
			fm.project_id = parsed.project_id;
		}
	} catch {
		// front matter 解析失败 → body 全量
		return { fm, body: content };
	}
	return {
		fm,
		body: lines
			.slice(end + 1)
			.join('\n')
			.replace(/^\n+/, ''),
	};
}

export function serializeTodo(fm: TodoFrontMatter, body: string): string {
	const front = JSON.stringify(
		{
			id: fm.id,
			title: fm.title,
			tags: fm.tags ?? [],
			status: fm.status,
			created_at: fm.created_at,
			assigned_to_session: fm.assigned_to_session || undefined,
			project_id: fm.project_id || 'project',
		},
		null,
		2,
	);
	return `${front}\n\n${body.trim()}\n`;
}

/** 工作台目录（agent 目录 .pi/todos/） */
export function todosDirOf(agentDir: string): string {
	return path.join(realDir(agentDir), '.pi', 'todos');
}

export function todoFilePath(agentDir: string, todoId: string): string {
	// 文件名 = 裸 <hex8>.md（对齐 todos 插件 getTodoPath：`${id}.md`，TODO- 仅展示前缀）
	return path.join(todosDirOf(agentDir), `${todoId}.md`);
}

function genTodoId(): string {
	return crypto.randomBytes(4).toString('hex');
}

// ── 投影：把任务在员工/派发人工作台的存在性对齐 ────────────────────────────

/**
 * 确保一个任务在相关 agent（处理人 in + 派发人 out）的工作台有待办条目。
 * 幂等：已投影（map 命中）则按需更新 title/状态；新任务创建条目 + 记 map。
 */
export async function projectTask(
	orgName: string,
	taskId: string,
): Promise<{ created: string[]; updated: string[] }> {
	const org = await readOrg(orgName);
	const task = await readTask(orgName, taskId);
	if (!task) return { created: [], updated: [] };
	const map = await readTodoMap(orgName);
	const created: string[] = [];
	const updated: string[] = [];

	const statusOverride = task.status === 'closed' ? 'done' : null;
	const ensureOne = async (
		agentName: string,
		agentDir: string | undefined,
		subTaskId: string,
		direction: 'in' | 'out',
		title: string,
		body: string,
		tags: string[],
	): Promise<void> => {
		const member = org.members.find((m) => m.name === agentName);
		const dir = member?.dir ?? agentDir;
		if (!dir) return; // 不在 org / 无目录信息
		const existing = map.find(
			(m) =>
				m.taskId === taskId &&
				m.agent === agentName &&
				m.subTaskId === subTaskId &&
				m.direction === direction,
		);
		const tagsNow = Array.from(new Set(['org', `org:${orgName}`, ...tags]));
		if (existing) {
			const fp = todoFilePath(dir, existing.todoId);
			const raw = await fs.readFile(fp, 'utf8').catch(() => '');
			if (raw) {
				const { fm } = parseTodoFile(raw, existing.todoId);
				const next: TodoFrontMatter = { ...fm, title, tags: tagsNow };
				// 权威回写：官方已关闭 → 置 done（只加不改员工手动状态）
				if (statusOverride && fm.status !== statusOverride && fm.status !== 'close') {
					next.status = statusOverride;
				}
				if (
					fm.title !== title ||
					JSON.stringify(fm.tags ?? []) !== JSON.stringify(tagsNow) ||
					next.status !== fm.status
				) {
					await fs.writeFile(fp, serializeTodo(next, bodyOf(raw)), 'utf8');
					updated.push(existing.todoId);
				}
			} else {
				// 文件被删 → 重建
				await writeTodo(dir, existing.todoId, title, tagsNow, body);
				updated.push(existing.todoId);
			}
			return;
		}
		const todoId = genTodoId();
		await writeTodo(dir, todoId, title, tagsNow, body);
		map.push({ taskId, org: orgName, subTaskId, agent: agentName, todoId, direction });
		created.push(todoId);
	};

	for (const sub of task.subTasks) {
		for (const a of sub.assignees) {
			if (a.status === 'rejected' || a.status === 'cancelled') continue;
			const due = effectiveDueAt(task, sub);
			await ensureOne(
				a.agent,
				a.dir,
				sub.id,
				'in',
				`[${task.id}] ${task.title}`,
				taskTodoBody(task, sub, due, a.agent),
				a.status === 'delivered' ? ['done'] : [],
			);
		}
	}
	// 派发人自己的待办（out 跟踪）
	const dispatcher = org.members.find((m) => m.name === task.dispatcher);
	if (dispatcher && task.status !== 'todo') {
		await ensureOne(
			task.dispatcher,
			dispatcher.dir,
			'ALL',
			'out',
			`[派发] ${task.id} ${task.title}`,
			`任务 ${task.id} 已派发：处理人 ${task.subTasks.flatMap((s) => s.assignees.map((a) => a.agent)).join('、')}。验收通过后此项自动归档。`,
			task.status === 'closed' ? ['done'] : [],
		);
	}
	await saveTodoMap(orgName, map);
	return { created, updated };
}

function bodyOf(content: string): string {
	const { body } = parseTodoFile(content, 'x');
	return body;
}

function taskTodoBody(
	task: Task,
	sub: { id: string; description: string },
	due: string | null,
	_agent: string,
): string {
	const items = task.items.map((it, i) => `${i + 1}. ${it}`).join('\n');
	const lines = [
		`org：${task.org}`,
		`任务编号：${task.id}`,
		`标题：${task.title}`,
		`背景：${task.background || '（无）'}`,
		`任务清单：\n${items || '（无）'}`,
		`你负责的子任务（${sub.id}）：${sub.description}`,
		due ? `期望完成时间：${due}` : '',
		'',
		'完成后在此写交付（结果摘要 + 产出文件路径，可到具体行）：',
		'',
		'## 交付',
		'',
		'（写完后把本条状态标为已完成——即交付声明；系统会自动回传派发人）',
	];
	return lines.filter((l) => l !== '').join('\n') + '\n';
}

async function writeTodo(
	dir: string,
	todoId: string,
	title: string,
	tags: string[],
	body: string,
): Promise<void> {
	await ensureDir(todosDirOf(dir));
	const fm: TodoFrontMatter = {
		id: todoId,
		title,
		tags,
		status: 'open',
		created_at: nowIso(),
	};
	// tmp+rename 原子写（todos 插件自身非原子，org 侧自己保证）；文件名 = 裸 <hex8>.md（同源）
	const dir2 = todosDirOf(dir);
	const file = path.join(dir2, `${todoId}.md`);
	const tmp = `${file}.tmp-${process.pid}`;
	await fs.writeFile(tmp, serializeTodo(fm, body), 'utf8');
	await fs.rename(tmp, file);
}

// ── todo-map 持久化 ─────────────────────────────────────────────────────────

export async function readTodoMap(orgName: string): Promise<TodoMapEntry[]> {
	const raw = await readJson<{ entries: TodoMapEntry[] }>(todoMapFile(orgName));
	if (!raw || !Array.isArray(raw.entries)) return [];
	return raw.entries;
}

export async function saveTodoMap(orgName: string, entries: TodoMapEntry[]): Promise<void> {
	await ensureDir(path.dirname(todoMapFile(orgName)));
	await writeJsonAtomic(todoMapFile(orgName), { entries });
}

// ── 对账 ────────────────────────────────────────────────────────────────────

export interface ReconcileIssue {
	kind:
		| 'done_without_delivery'
		| 'closed_not_archived'
		| 'overdue_waiting_accept'
		| 'overdue_in_progress';
	agent: string;
	taskId: string;
	subTaskId?: string;
	message: string;
}

/**
 * 全量对账（org 范围）：
 * 1) 为所有未关闭任务补齐投影（补漏）
 * 2) 找出「员工把待办标了完成但官方任务无交付」→ 提醒补 report
 * 3) 官方已关闭但员工/派发人待办未标完成/关闭 → 提示归档（done 权威回写由关闭时投影处理）
 */
export async function reconcileOrg(
	orgName: string,
): Promise<{ projected: number; issues: ReconcileIssue[] }> {
	const org = await readOrg(orgName);
	const tasks = await listTasks(orgName);
	const map = await readTodoMap(orgName);
	let projected = 0;
	const issues: ReconcileIssue[] = [];

	for (const task of tasks) {
		if (task.status !== 'closed') {
			const r = await projectTask(orgName, task.id);
			projected += r.created.length;
		}
	}

	// 员工侧：map 中 in 方向、任务未关闭、员工把待办标 done 但任务无该员工 delivered
	for (const entry of map) {
		if (entry.direction !== 'in') continue;
		const task = await readTask(orgName, entry.taskId);
		if (!task) continue;
		const member = org.members.find((m) => m.name === entry.agent);
		const dir = member?.dir;
		if (!dir) continue;
		const raw = await fs.readFile(todoFilePath(dir, entry.todoId), 'utf8').catch(() => null);
		if (!raw) continue;
		const { fm } = parseTodoFile(raw, entry.todoId);
		if (fm.status !== 'done' && fm.status !== 'close') continue;
		if (task.status === 'closed') continue; // 已关闭不提醒
		// 该员工在该子任务是否已有 delivered/被采纳
		const sub = task.subTasks.find((s) => s.id === entry.subTaskId);
		const me = sub?.assignees.find((a) => a.agent === entry.agent);
		const hasDelivery = me != null && me.deliveries.length > 0;
		if (!hasDelivery && me?.status !== 'rejected' && me?.status !== 'cancelled') {
			issues.push({
				kind: 'done_without_delivery',
				agent: entry.agent,
				taskId: entry.taskId,
				subTaskId: entry.subTaskId,
				message: `你（${entry.agent}）把任务 ${entry.taskId} 子任务 ${entry.subTaskId} 标了完成，但官方账本还没有你的交付记录。请用 /org report ${entry.taskId} ${entry.subTaskId} <结果摘要> 补交付。`,
			});
		}
	}

	// 时间提醒（ticket 08）
	for (const task of tasks) {
		if (task.status === 'closed') continue;
		for (const sub of task.subTasks) {
			const due = effectiveDueAt(task, sub);
			if (!due) continue;
			const dueMs = Date.parse(due);
			if (Number.isNaN(dueMs) || Date.now() <= dueMs) continue;
			for (const a of sub.assignees) {
				if (a.status === 'delivered') continue;
				if (a.status === 'invited' || a.status === 'claimed' || a.status === 'returned') {
					// 已超时提醒过（history 里记过 overdue_notified 且之后无新交付）则不重复轰炸
					const alreadyNotified = task.history.some(
						(h) => h.event === 'overdue_notified' && h.by === `${a.agent}:${sub.id}`,
					);
					issues.push({
						kind: 'overdue_in_progress',
						agent: a.agent,
						taskId: task.id,
						subTaskId: sub.id,
						message: `你负责的任务 ${task.id} 子任务 ${sub.id} 已超过期望完成时间（${due}）${alreadyNotified ? '（提醒过，仍未交付）' : ''}。如遇阻塞请回报派发人，或先交付已完成部分。`,
					});
					if (!alreadyNotified) {
						task.history.push({
							at: nowIso(),
							event: 'overdue_notified',
							by: `${a.agent}:${sub.id}`,
							note: due,
						});
						await writeJsonAtomic(taskFile(task.org, task.id), task);
					}
				}
			}
		}
		if (task.status !== 'waiting_accept') continue;
		const due = task.dueAt ?? null;
		if (!due) continue;
		const dueMs = Date.parse(due);
		if (!Number.isNaN(dueMs) && Date.now() > dueMs) {
			issues.push({
				kind: 'overdue_waiting_accept',
				agent: task.dispatcher,
				taskId: task.id,
				message: `任务 ${task.id} 已全部交付并超过期望完成时间仍未验收，请派发人 ${task.dispatcher} 尽快验收（/org approve ${task.id}）或打回。`,
			});
		}
	}

	log.info('reconcile', { org: orgName, projected, issues: issues.length });
	return { projected, issues };
}
