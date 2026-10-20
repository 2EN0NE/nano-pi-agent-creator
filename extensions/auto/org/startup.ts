// org — 会话启动骨架（07 · ADR-0039）
// 成员进程 session_start 时收集两件事并作为一条提醒消息呈现：
//   1) 该成员相关的对账 issues（done 未交付 / 超期 / 久置等）——兑现「对账三层触发」的启动层
//   2) 该成员名下待确认的握手请求（invited、非负责人派发）——惰性催办（替代不可行的自动退避重试）
// 纯收集函数（可单测）；由 index session_start 调用并发 sendMessage。
import { createLogger } from '@zenone/pi-logger';
import { listTasks } from './task.js';
import { reconcileOrg } from './todoproj.js';

const log = createLogger('org');

export async function collectStartupNotes(orgName: string, myName: string): Promise<string[]> {
	const notes: string[] = [];

	// ① 对账 issues 里只呈现与我相关的（避免把别人的提醒广播进我的会话）
	try {
		const res = await reconcileOrg(orgName);
		for (const issue of res.issues) {
			if (issue.agent !== myName) continue;
			notes.push(`[${orgName}] ${issue.message}`);
		}
	} catch (e) {
		log.warn('启动对账失败', { org: orgName, err: e instanceof Error ? e.message : String(e) });
	}

	// ② 未决握手催办（invited + 非负责人派发 = 需我 accept/reject）
	try {
		const note = await pendingHandshakeNote(orgName, myName);
		if (note) notes.push(note);
	} catch (e) {
		log.warn('握手催办收集失败', {
			org: orgName,
			err: e instanceof Error ? e.message : String(e),
		});
	}

	return notes;
}

/**
 * 未决握手催办文案（非负责人派发、`invited` 未决）；无则返回 null。
 *
 * 惰性催办（ADR-0039 D）复用点：① 会话启动（`collectStartupNotes`）；
 * ② 每次处理人侧 org 操作后（`index.ts` 命令面 / 工具面）。
 */
export async function pendingHandshakeNote(
	orgName: string,
	myName: string,
): Promise<string | null> {
	const tasks = await listTasks(orgName);
	const pending: string[] = [];
	for (const t of tasks) {
		if (t.status === 'closed' || t.dispatcherRole === 'chief') continue;
		for (const sub of t.subTasks) {
			for (const a of sub.assignees) {
				if (a.agent === myName && a.status === 'invited') {
					pending.push(`${t.id} 子任务 ${sub.id}`);
				}
			}
		}
	}
	if (pending.length === 0) return null;
	return (
		`[${orgName}] 你有 ${pending.length} 个待确认握手请求：${pending.join('、')}。` +
		`用 /org accept <任务号> <子任务号> 接手，或 /org reject <任务号> <子任务号> <原因> 拒绝。`
	);
}
