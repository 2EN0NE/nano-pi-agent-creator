// org — 执行槽（ADR-0055 `D2`）：成员「此刻在跑哪个任务」的可判定事实
//
// 为什么需要（现状缺口）：`runtime/<member>.json` 只表达**进程在不在岗**（外加一个 turn 级 busy 标志），
// 无法回答「这个成员手上是否正压着一个任务」——于是排队上限（`D4`）与逾期判定（`D3`）都没有立足点。
//
// 语义抄参考实现 `pi-subagents-1/src/runs/background/active-async-capacity.ts`（槽位 + 租约 + 保守回收）：
//   · **租约**：占用带 `token`（随机）与 `generation`（单调 +1）。释放必须**带上 token**——
//     旧进程/旧会话不得误释放新占用（等价于其 owner.token + generation 的比对语义）；
//   · **保守回收**：只在**证明已死**（进程存活校验证伪）时释放；进程状态未知时，
//     必须超过 `abandonedAfterMs`（默认 20 分钟，钳位 5 分钟–24 小时，可禁用）才回收；
//   · 回收只在**有实证**的情况下发生——宁可让一个幽灵占位被人工清掉，也不误判活着的成员。
import * as path from 'node:path';
import { createLogger } from '@zenone/pi-logger';
import { ensureDir, genId, nowIso, readJson, writeJsonAtomic } from './util.js';
import { slotFile } from './orgstore.js';
import { isPidAlive } from './presence.js';

const log = createLogger('org');

/** 槽记录：占用者身份 + 租约 + 在跑的任务 */
export interface SlotRecord {
	/** 租约标识（每次占用新生成；释放需匹配） */
	token: string;
	/** 单调递增代人（诊断用；与 token 一起防"旧占用者误释放"） */
	generation: number;
	/** 正在执行的任务 */
	taskId: string;
	subTaskId?: string;
	agent: string;
	/** 占用者进程 pid（存活校验用） */
	pid: number;
	claimedAt: string;
	updatedAt: string;
}

export const DEFAULT_ABANDONED_SLOT_RELEASE_AFTER_MS = 20 * 60 * 1000;
export const MIN_ABANDONED_SLOT_RELEASE_AFTER_MS = 5 * 60 * 1000;
export const MAX_ABANDONED_SLOT_RELEASE_AFTER_MS = 24 * 60 * 60 * 1000;

/** 解析"僵尸槽回收阈值"配置：非法值回默认；`false` = 禁用回收；数值钳位到 5min–24h */
export function resolveAbandonedReleaseAfterMs(value: unknown): number | false {
	if (value === false) return false;
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
		return DEFAULT_ABANDONED_SLOT_RELEASE_AFTER_MS;
	}
	return Math.min(
		MAX_ABANDONED_SLOT_RELEASE_AFTER_MS,
		Math.max(MIN_ABANDONED_SLOT_RELEASE_AFTER_MS, Math.floor(value)),
	);
}

export async function readSlot(org: string, member: string): Promise<SlotRecord | null> {
	const raw = await readJson<SlotRecord>(slotFile(org, member));
	if (!raw || typeof raw.token !== 'string' || typeof raw.taskId !== 'string') return null;
	return raw;
}

async function writeSlot(org: string, member: string, rec: SlotRecord): Promise<void> {
	await ensureDir(path.dirname(slotFile(org, member)));
	await writeJsonAtomic(slotFile(org, member), rec);
}

async function clearSlot(org: string, member: string): Promise<void> {
	const { unlink } = await import('node:fs/promises');
	await unlink(slotFile(org, member)).catch(() => {});
}

export type ClaimResult = { ok: true; record: SlotRecord } | { ok: false; holder: SlotRecord };

/**
 * 占用执行槽。
 * - 空槽 → 占用成功；
 * - 同一任务**同一进程**重复占用 → 幂等成功（只刷新 `updatedAt`）；
 * - 他人（或同成员的另一进程）已占 → `ok:false` 并回报占用者（调用方据此"排队"而不是并发执行）。
 */
export async function claimSlot(
	org: string,
	member: string,
	input: { taskId: string; subTaskId?: string; pid?: number },
): Promise<ClaimResult> {
	const pid = input.pid ?? process.pid;
	const now = nowIso();
	const current = await readSlot(org, member);
	if (current) {
		if (current.taskId === input.taskId && current.pid === pid) {
			const refreshed = { ...current, updatedAt: now };
			await writeSlot(org, member, refreshed);
			return { ok: true, record: refreshed };
		}
		return { ok: false, holder: current };
	}
	const record: SlotRecord = {
		token: genId('slot'),
		generation: 1,
		taskId: input.taskId,
		subTaskId: input.subTaskId,
		agent: member,
		pid,
		claimedAt: now,
		updatedAt: now,
	};
	await writeSlot(org, member, record);
	log.info('执行槽占用', {
		org,
		member,
		task: input.taskId,
		sub: input.subTaskId,
		pid,
	});
	return { ok: true, record };
}

export type ReleaseResult = 'released' | 'not-owner' | 'free';

/** 释放执行槽（**必须带 token**：旧占用者不得误释放新占用） */
export async function releaseSlot(
	org: string,
	member: string,
	token: string,
): Promise<ReleaseResult> {
	const current = await readSlot(org, member);
	if (!current) return 'free';
	if (current.token !== token) {
		log.warn('执行槽释放被拒（租约不匹配）', {
			org,
			member,
			holder: current.token,
			by: token,
		});
		return 'not-owner';
	}
	await clearSlot(org, member);
	log.info('执行槽释放', { org, member, task: current.taskId });
	return 'released';
}

/**
 * 释放在任务侧**已失效**的槽（ADR-0055 `D2`）：成员在槽指向的任务/子任务上已无在手工作
 * （取消 / 叫停 / 改派移出 / 任务关闭）时，占用必须释放——否则「一次只做一件」会把它永久挡住，
 * 而 `reconcileSlot` 因「本进程存活」永远判 held，救不回来。
 *
 * 只看**本进程**（`pid === process.pid`）的槽：他方进程的槽由 `reconcileSlot` 的进程存活/死亡判定负责，
 * 这里不越权释放。
 *
 * @param stillActive 判断"该占用此刻还算不算数"——由调用方查任务账本得出（slot 层不依赖 domain）。
 */
export async function releaseSlotIfStale(
	org: string,
	member: string,
	stillActive: (record: SlotRecord) => Promise<boolean>,
): Promise<boolean> {
	const record = await readSlot(org, member);
	if (!record) return false;
	// 持有者只可能是本进程，或**已死**的旧进程（进程存活校验证伪）：前者是常规场景，
	// 后者是"成员进程重启后残留的槽"——调用方 `stillActive` 已确认任务侧无在手工作，
	// 死进程不可能被误伤，放行可免去"必须等巡检下一拍才解锁"。他方**存活**进程的槽不越权释放。
	if (record.pid !== process.pid && isPidAlive(record.pid)) return false;
	if (await stillActive(record)) return false;
	const res = await releaseSlot(org, member, record.token);
	if (res === 'released') {
		log.info('释放失效执行槽（成员已不在该任务上）', {
			org,
			member,
			task: record.taskId,
			sub: record.subTaskId ?? null,
		});
	}
	return res === 'released';
}

export interface ReconcileOptions {
	/** 存活校验（可注入，便于测试） */
	liveness?: (pid: number) => boolean;
	/** 僵尸槽回收阈值；`false` 禁用（默认 20 分钟） */
	abandonedAfterMs?: number | false;
	now?: number;
}

export type ReconcileState = 'none' | 'held' | 'reclaimed';

export interface ReconcileResult {
	state: ReconcileState;
	record?: SlotRecord;
	reason?: string;
}

/**
 * 对账执行槽：只做一件事——判断"这个占用还算不算数"。
 *
 * 判定顺序（**保守优先**）：
 *   1. 无记录 → `none`；
 *   2. 进程存活校验为**假** → 有死亡实证 → 回收；
 *   3. 校验为**真** → 保留（活着的成员绝不被判死）；
 *   4. 校验**不确定**（无 pid / 探测异常）→ 仅当超过阈值才回收，否则保留并说明原因。
 */
export async function reconcileSlot(
	org: string,
	member: string,
	opts: ReconcileOptions = {},
): Promise<ReconcileResult> {
	const record = await readSlot(org, member);
	if (!record) return { state: 'none' };
	const live = opts.liveness ?? isPidAlive;
	const threshold = resolveAbandonedReleaseAfterMs(
		opts.abandonedAfterMs ?? DEFAULT_ABANDONED_SLOT_RELEASE_AFTER_MS,
	);
	const now = opts.now ?? Date.now();

	if (Number.isInteger(record.pid) && record.pid > 0) {
		let alive = true;
		try {
			alive = live(record.pid);
		} catch {
			alive = true; // 探测本身出错 → 视为存活（保守）
		}
		if (alive) return { state: 'held', record, reason: '进程存活' };
		await clearSlot(org, member);
		log.info('执行槽回收（进程已死）', {
			org,
			member,
			task: record.taskId,
			pid: record.pid,
		});
		return { state: 'reclaimed', record, reason: '进程已死（死亡实证）' };
	}

	if (threshold === false) {
		return { state: 'held', record, reason: '无 pid 且回收策略已禁用' };
	}
	const age = now - Date.parse(record.updatedAt || record.claimedAt);
	if (Number.isFinite(age) && age > threshold) {
		await clearSlot(org, member);
		log.info('执行槽回收（超时且无存活证据）', {
			org,
			member,
			task: record.taskId,
			ageMs: age,
		});
		return { state: 'reclaimed', record, reason: `无 pid 且超过阈值 ${threshold}ms` };
	}
	return { state: 'held', record, reason: '无 pid 但未超阈值' };
}
