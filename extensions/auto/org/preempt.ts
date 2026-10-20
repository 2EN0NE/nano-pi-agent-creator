// org — 显式抢占（ADR-0055 `D6`）：一条命令把「插话 / 停当前轮」与投递做完
//
// 两级（人类裁定 2026-09-14 保留两级，默认 L1）：
//   · L1 `steer`（默认）：把消息插到成员**当前工具调用结束后、下一次 LLM 调用前**——
//     不中断当前轮、不丢它的进度；成员自己决定何时切换。语义是"插话"，不是并发。
//   · L2 `abort`（需显式）：先停当前轮再投递。仅用于"方向已错、继续跑就是浪费"。
//     中断失败**必须据实回报**（ADR-0053/0047：不静默、不假装成功），但消息仍会投递——
//     宁可"没停下来但话已带到"，也不冒"既没停、话也没送到"的风险。
//
// 被硬抢占时在任务历史留 `interrupted` 事件（谁、何时、打断时它在做什么）——ADR-0055 `D7`。
import { createLogger } from '@zenone/pi-logger';
import { deliverMessage } from './dispatch.js';
import { interruptMember } from './activity.js';
import { readSlot } from './slot.js';
import { markInterrupted, readTask, saveTask } from './task.js';
import { readJson } from './util.js';
import { runtimeFile } from './orgstore.js';

const log = createLogger('org');

export type PreemptLevel = 'steer' | 'abort';

export interface PreemptResult {
	ok: boolean;
	/** 实际使用的级别 */
	level: PreemptLevel;
	/** 面向人的结果说明（命令/工具回复直接用） */
	message: string;
	/** 投递结果（作为抢占的一部分，仍走既有投递通道） */
	delivery?: 'online' | 'uncertain' | 'inbox' | 'unreachable';
	/** 被中断的任务（用于回报与历史） */
	taskId?: string;
	subTaskId?: string;
	/** 硬抢占是否真的生效 */
	interrupted?: boolean;
}

/**
 * 对某成员发起显式抢占：停（可选）+ 投递。
 *
 * 不在岗时**不假装成功**：L1 降级为普通投递（落收件箱，唤醒后处理）；L2 明确回报"没停下来"。
 */
export async function preemptMember(
	org: string,
	member: string,
	message: string,
	opts: { hard?: boolean; by: string },
): Promise<PreemptResult> {
	const hard = opts.hard === true;
	const level: PreemptLevel = hard ? 'abort' : 'steer';
	const rt = await readJson<{ pid?: number; socketPath?: string }>(runtimeFile(org, member));
	const slot = await readSlot(org, member);

	let interrupted: boolean | undefined;
	let interruptNote = '';
	if (hard) {
		if (rt?.socketPath) {
			const outcome = await interruptMember(rt.socketPath);
			interrupted = outcome.ok;
			if (!outcome.ok) {
				interruptNote =
					outcome.reason === 'unsupported'
						? '成员进程版本较旧、不支持中断'
						: outcome.reason === 'timeout'
							? '中断请求超时（未能确认是否停下）'
							: '成员进程不可达（未能停下来）';
			}
		} else {
			interrupted = false;
			interruptNote = '成员不在岗（无可中断的轮次）';
		}
	}

	// 投递（两种级别都投）：L1 用 steer 插话；L2 停完再投（此时它若真停了，steer 等价于起一轮）
	const delivery = await deliverMessage(org, member, message, {
		sender: opts.by,
		mode: 'steer',
	});

	// 硬抢占生效且成员手上确实压着一个任务 → 落可指认的打断事件
	if (hard && interrupted && slot) {
		try {
			const task = await readTask(org, slot.taskId);
			if (task) {
				markInterrupted(task, opts.by, {
					subTaskId: slot.subTaskId,
					context: `被抢占时正在执行 ${slot.taskId}${slot.subTaskId ? `/${slot.subTaskId}` : ''}`,
				});
				await saveTask(task);
			}
		} catch (e) {
			log.warn('抢占历史写入失败（不影响抢占本身）', {
				org,
				member,
				err: e instanceof Error ? e.message : String(e),
			});
		}
	}

	const parts: string[] = [];
	if (hard) {
		parts.push(interrupted ? '已中断其当前轮' : `中断未生效（${interruptNote}）`);
	} else {
		parts.push('已插话（不中断其当前轮）');
	}
	parts.push(
		delivery === 'online'
			? '并已在线送达'
			: delivery === 'inbox'
				? '消息已落收件箱（唤醒后处理）'
				: delivery === 'uncertain'
					? '送达存疑（未收到成员回报）'
					: '消息已落收件箱（进程不可达）',
	);
	log.info('显式抢占', { org, member, by: opts.by, level, interrupted, delivery });

	return {
		ok: delivery === 'online' || delivery === 'inbox' || delivery === 'unreachable',
		level,
		message: parts.join('，'),
		delivery,
		taskId: slot?.taskId,
		subTaskId: slot?.subTaskId,
		interrupted,
	};
}
