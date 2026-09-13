// org — 在岗简报（ADR-0042）
//
// 在岗成员"使用 org 所需的知识"，分两块注入（仅**在岗**进程可见）：
//   · **静态块**（定位 / 组织背景 / 技能指路）→ 由 `before_agent_start` 恒定追加进**系统提示**。
//     会话内不变 ⇒ 系统提示逐轮一致 ⇒ prompt cache 稳定。
//   · **动态块**（在岗成员 / 一行计数）→ 由 `input` transform 追在**用户轮次尾部**。
//     随用户消息持久化进会话 ⇒ 下一轮前缀与上一轮逐字节一致 ⇒ 同样不破坏缓存。
//
// 技能只**指路**（ADR-0042 D4）：正文留在技能文件里按需 `read`，此处不复制第二份真相。

import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { formatInboxContent, peekInbox } from './inbox.js';
import {
	effectiveDueAt,
	findMemberOpenWork,
	isOverdueMarked,
	listTasks,
	queueLengthFor,
} from './task.js';
import { readSlot } from './slot.js';
import { orgConfigStore, resolveMemberQueueCap } from './config.js';
import { readOrg } from './orgstore.js';
import { inspectMembers, PRESENCE_WORDS } from './presence.js';
import type { AgentRole, Task } from './types.js';

/** 技能指路（按角色，只给名字与适用时机） */
const SKILL_HINT: Record<AgentRole, string> = {
	chief: 'org-chief —— 本 org 负责人协作准则（先感知在岗与名下任务，再派活 / 验收）；需要时用 read 读全文',
	member: 'org-member —— 子领域 agent 协作准则（领活 → 执行 → 交付 → 回报）；需要时用 read 读全文',
};

function orUnfilled(text: string | undefined): string {
	const t = (text ?? '').trim();
	return t || '（未填写）';
}

/** 静态块单个字段的显示列上限：防止超长组织背景把**每轮**系统提示撑爆 */
const STATIC_FIELD_MAX_COLS = 1200;

/** 超限则截断并标注（截断标记本身也计入上限） */
function capField(text: string, max = STATIC_FIELD_MAX_COLS): string {
	if (visibleWidth(text) <= max) return text;
	const marker = '…（已截断）';
	const room = Math.max(8, max - visibleWidth(marker));
	return truncateToWidth(text, room, '') + marker;
}

export interface StaticBriefingInput {
	org: string;
	memberName: string;
	role: AgentRole;
	/** 成员简介（**实时**读自成员目录的 pi.agent.json，只读不写回） */
	description?: string;
	/** 组织背景（org.json 的 background） */
	background?: string;
}

/** 静态块（ADR-0042 D2）：我是谁 + 组织背景 + 技能指路。会话内恒定。 */
export function buildStaticBriefing(input: StaticBriefingInput): string {
	const roleWord = input.role === 'chief' ? '负责人' : '成员';
	return [
		'[org 在岗简报]',
		`我是：${input.org} / ${roleWord}（${input.memberName}）`,
		`职责：${capField(orUnfilled(input.description))}`,
		`组织背景：${capField(orUnfilled(input.background))}`,
		`可用技能：${SKILL_HINT[input.role]}`,
		SENDER_CONVENTION,
	].join('\n');
}

/**
 * 成员消息的来源约定（ADR-0044 D4）。
 *
 * 成员消息在模型层与人类输入同形（`custom → role:user`），只能靠正文里的
 * `<sender_info>` 头区分。放进**静态块**：会话内恒定 → 不破坏 prompt cache。
 */
const SENDER_CONVENTION =
	'来源约定：正文以 <sender_info> 开头的消息来自 org 成员 agent（不是人类操作者）；' +
	'不带该头的才是人类在你终端里的输入。要回复成员请派活或用 org 消息。';

export interface BriefingCounts {
	/** 我派发且未关闭 */
	dispatched: number;
	/** 我名下待办（invited/claimed/returned）且未关闭 */
	received: number;
	/** 派给我、我已交付、等我验收的 */
	awaitingMe: number;
}

/** 一行计数的前三个数字（纯函数，便于单测） */
export function countWork(tasks: Task[], member: string): BriefingCounts {
	const open = tasks.filter((t) => t.status !== 'closed');
	return {
		dispatched: open.filter((t) => t.dispatcher === member).length,
		received: open.filter((t) => findMemberOpenWork(t, member)).length,
		awaitingMe: open.filter(
			(t) =>
				t.dispatcher === member &&
				t.subTasks.some((s) =>
					s.assignees.some((a) => a.status === 'delivered' && !a.stopped),
				),
		).length,
	};
}

/** 剩余/逾期时长的人话（简报与看板共用口径） */
export function remainingText(dueAt: string, now: number = Date.now()): string {
	const due = Date.parse(dueAt);
	if (!Number.isFinite(due)) return '';
	const diff = due - now;
	const abs = Math.abs(diff);
	const h = Math.floor(abs / 3_600_000);
	const m = Math.floor((abs % 3_600_000) / 60_000);
	const span = h >= 1 ? `${h}h${m > 0 ? `${m}m` : ''}` : `${Math.max(1, m)}m`;
	return diff >= 0 ? `剩 ${span}` : `已逾期 ${span}`;
}

/**
 * 动态块（ADR-0042 D3/D7，扩展于 ADR-0054 `D5` / ADR-0055 `D3`/`D4`/`D5`）。
 *
 * 在原「在岗 + 一行计数」基础上补齐**成员自己需要看见的事实**：
 *   · 手上正在执行的任务（执行槽，`D2`）；
 *   · 待办队列长度 / 上限（`D4`，满了派活会被拒）；
 *   · 期限：剩余或**已逾期**（`D3`，逾期需主动向派发人说明）；
 *   · 收件箱**内容清单**（`D5`：不再只有一个计数）。
 *
 * 只读，不产生任何写副作用（**peek 不删**——消化由 `flushInbox` 负责）。
 */
export async function buildDynamicBriefing(orgName: string, memberName: string): Promise<string> {
	const org = await readOrg(orgName);
	const tasks = await listTasks(orgName);
	const presences = await inspectMembers(
		orgName,
		org.members.map((m) => m.name),
		tasks,
	);
	const onDuty: string[] = [];
	for (const m of org.members) {
		const p = presences.get(m.name);
		if (!p || p.state === 'sleeping') continue;
		onDuty.push(`${m.name} ${PRESENCE_WORDS[p.state]}${m.name === memberName ? '（我）' : ''}`);
	}
	const me = org.members.find((m) => m.name === memberName);
	const roleWord = me?.role === 'chief' ? '负责人' : '成员';
	const counts = countWork(tasks, memberName);
	const queued = await peekInbox(orgName, memberName);

	const lines = [
		`[org] ${orgName} · 我：${roleWord} ${memberName}`,
		`在岗（${onDuty.length}/${org.members.length}）：${onDuty.join(' · ') || '（暂时无人在岗）'}`,
		`未结：我派 ${counts.dispatched} · 我接 ${counts.received} · 待我验收 ${counts.awaitingMe} · inbox ${queued.length}`,
	];

	// 手上在跑的任务（执行槽；ADR-0055 `D2`）
	const slot = await readSlot(orgName, memberName);
	if (slot && slot.taskId) {
		lines.push(`我手上：正在执行 ${slot.taskId}${slot.subTaskId ? `/${slot.subTaskId}` : ''}`);
	}

	// 待办队列 / 上限（ADR-0055 `D4`）
	const cap = resolveMemberQueueCap(orgConfigStore.get().memberQueueCap);
	const queue = queueLengthFor(tasks, memberName);
	if (queue > 0 || cap !== undefined) {
		lines.push(`待办队列：${queue}${cap === undefined ? '（未设上限）' : `/${cap}（上限）`}`);
	}

	// 期限（ADR-0055 `D3`）：名下未结参与者的剩余 / 逾期
	const now = Date.now();
	const deadlines: string[] = [];
	for (const task of tasks) {
		if (task.status === 'closed') continue;
		for (const sub of task.subTasks) {
			for (const a of sub.assignees) {
				if (a.agent !== memberName || a.stopped) continue;
				if (a.status !== 'invited' && a.status !== 'claimed' && a.status !== 'returned')
					continue;
				const dueAt = effectiveDueAt(task, sub);
				if (!dueAt) continue;
				const overdue = isOverdueMarked(task, sub, memberName) ? '（逾期）' : '';
				deadlines.push(`${sub.id} ${remainingText(dueAt, now)}${overdue}`);
			}
		}
	}
	if (deadlines.length > 0) lines.push(`期限：${deadlines.slice(0, 4).join(' · ')}`);

	// 收件箱内容（ADR-0054 `D5`）：看得见才可能被处理；条数与长度都有上限
	if (queued.length > 0) {
		lines.push('收件箱内容（未处理）：');
		lines.push(formatInboxContent(queued, { maxItems: 3, maxChars: 200 }));
	}

	return lines.join('\n');
}
