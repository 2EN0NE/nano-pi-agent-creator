// org — 成员可感知状态（presence）
//
// 四态**派生自既有信号，零新指标**（ADR-0040 D5）：
//   睡眠 sleeping    runtime 记录缺失，或其 socketPath 不可连
//   工作中 working   在岗（socket 可连）且 busy === true
//   待验收 delivered 在岗、busy === false，且名下有未采纳的 delivered 参与者项
//   空闲 idle        其余（在岗、busy === false，且无待验收交付）
//
// 优先级：睡眠 > 工作中 > 待验收 > 空闲。理由：busy 是"此刻正在跑"的实时信号，
// 若被"待验收"盖住，人会把"它在忙"误读成"它在等你验收"；反之长期在忙的成员
// 将永远显示不出"工作中"。
//
// 边界（有意为之）：
// - 判定以 **socket 存活** 为准，不用 pid 判活（pid 会复用）；
// - 巡检只读 + 清理 stale runtime 文件，**不唤醒、不杀停**（感知与动作分离，D4）；
// - 本模块不读任务文件：调用方传入当前快照，避免巡检把任务列表刷到用户光标底下。
import { promises as fs } from 'node:fs';
import { isSocketAlive, readJson } from './util.js';
import { readOrg, runtimeFile } from './orgstore.js';
import type { Task } from './types.js';

/** 成员可感知状态（四态） */
export type PresenceState = 'sleeping' | 'working' | 'delivered' | 'idle';

/**
 * 四态中文词 —— **唯一映射**（CONTEXT.md「可感知状态」）。
 *
 * 词表口径（务必遵守）：睡眠 / 空闲 / 工作中 / 待验收。
 * _避免_：在线、离线、上线、下线（易与 socket 语义混淆，ADR-0040 D5）。
 * TUI 看板、在岗简报、文本视图一律取此处，避免"同一概念三套词"。
 */
export const PRESENCE_WORDS: Record<PresenceState, string> = {
	sleeping: '睡眠',
	idle: '空闲',
	working: '工作中',
	delivered: '待验收',
};

/**
 * 「成员注册目录已不存在」的展示词（**不是**第五种 `PresenceState`）。
 *
 * 必须与「睡眠」可区分：睡眠是可唤醒的正常态；而注册目录不存在时**任何唤醒都会失败**
 * （典型来源：历史 vitest 残留目录、目录被人工删除）。仅标注事实，状态仍按 presence 判为睡眠。
 * 渲染层（`org_fleet` 文本视图 / 看板成员列表）统一取此处，避免"同一事实两套说法"。
 */
export const DIR_MISSING_WORD = '注册目录不存在';

/** runtime 记录（`<公司>/runtime/<成员>.json`，由成员进程自己写入） */
export interface RuntimeRecord {
	schemaVersion?: number;
	name: string;
	dir: string;
	pid: number;
	socketPath: string;
	sessionId: string;
	busy: boolean;
	startedAt: string;
	updatedAt: string;
}

/** 看板巡检间隔 */
export const PRESENCE_POLL_MS = 4000;
/** socket 探测超时（与 dispatch 投递判定同口径） */
export const SOCKET_PROBE_TIMEOUT_MS = 1200;
/**
 * stale 清理宽限：runtime 更新距今小于此值视为"启动中/探测抖动"，不清理。
 * 挡住两类误清——① 刚 registerRuntime、socket 尚未起；② 机器繁忙时探测瞬时失败。
 * ⏳ 该值需真实数据校准（ADR-0040 D7）。
 */
export const STALE_GRACE_MS = 30_000;

/** 读 runtime 记录；缺失/损坏返回 null */
export async function readRuntime(org: string, name: string): Promise<RuntimeRecord | null> {
	return readJson<RuntimeRecord>(runtimeFile(org, name));
}

/**
 * 名下有"待验收交付"（任务未关闭、参与者态为 delivered 且未被叫停）。
 *
 * 必须排除 closed 任务：验收通过后任务转 closed，但参与者态**仍留在 delivered**
 * （`task.ts` 的 attestTask 只改任务态），否则已验收的成员会永久显示"待验收"。
 */
export function hasPendingDelivery(tasks: Task[], name: string): boolean {
	return tasks.some(
		(t) =>
			t.status !== 'closed' &&
			t.subTasks.some((s) =>
				s.assignees.some((a) => a.agent === name && a.status === 'delivered' && !a.stopped),
			),
	);
}

export interface PresenceFacts {
	runtime: RuntimeRecord | null;
	/** runtime.socketPath 是否可连（runtime 缺失时应为 false） */
	socketAlive: boolean;
	pendingDelivery: boolean;
}

/** 纯函数判定（无 IO，便于穷举测试） */
export function judgePresence(facts: PresenceFacts): PresenceState {
	if (!facts.runtime || !facts.socketAlive) return 'sleeping';
	if (facts.runtime.busy) return 'working';
	return facts.pendingDelivery ? 'delivered' : 'idle';
}

export interface MemberPresence {
	/** 可感知状态（四态，见 judgePresence） */
	state: PresenceState;
	runtime: RuntimeRecord | null;
	socketAlive: boolean;
	/**
	 * runtime.pid 是否存活。与 socketAlive 分开看：
	 * 成员可能**进程在但未开 `--session-control`**（socket 不可连）——
	 * 此时不可判为"可清理/可拉起"，否则会误删其 runtime、甚至拉起重复进程
	 * （破坏"一目录 = 一员工"）。
	 */
	pidAlive: boolean;
}

/**
 * 进程是否存活（信号 0 探测）。
 * 守卫 `pid > 1`：`process.kill(0, …)` / 负 pid 会作用于**当前进程组**（可能误杀
 * 看板自己所在的 pi），而 runtime 文件是用户可写的外部输入，读到的 pid 不可信。
 */
export function isPidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 1) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** 探测单个成员（只读，不产生副作用） */
export async function inspectMember(
	org: string,
	name: string,
	tasks: Task[],
): Promise<MemberPresence> {
	const runtime = await readRuntime(org, name);
	const socketAlive = runtime?.socketPath
		? await isSocketAlive(runtime.socketPath, SOCKET_PROBE_TIMEOUT_MS).catch(() => false)
		: false;
	return {
		state: judgePresence({
			runtime,
			socketAlive,
			pendingDelivery: hasPendingDelivery(tasks, name),
		}),
		runtime,
		socketAlive,
		pidAlive: runtime ? isPidAlive(runtime.pid) : false,
	};
}

/** 并发探测全部成员（并发探测，避免 N 个 1.2s 超时串行叠加） */
export async function inspectMembers(
	org: string,
	names: string[],
	tasks: Task[],
): Promise<Map<string, MemberPresence>> {
	const pairs = await Promise.all(
		names.map(async (name): Promise<[string, MemberPresence]> => [
			name,
			await inspectMember(org, name, tasks),
		]),
	);
	const map = new Map<string, MemberPresence>();
	for (const [name, presence] of pairs) map.set(name, presence);
	return map;
}

/**
 * 其余 org 的**廉价**在岗计数（ADR-0070 D7）。
 *
 * 判据 = 「runtime 记录存在 ∧ `isPidAlive`」：只发 signal-0，零 IPC。理由：非当前 org
 * 只需要回答"有几个人在岗"这个**计数**，不需要四态精度；而权威判据（socket RPC 探活）
 * 是跨进程 JSON 往返，乘上 N 家 org 不划算。
 *
 * **接受的精度损失**：进程在但 socket 已断（未开 `--session-control`、或 control 服务
 * 异常）会算作在岗。切到该 org 时 `loadCurrentOrg` 立刻回归权威判据，误差自愈。
 */
export async function countOnlineByPid(org: string): Promise<number> {
	// 读不到 / JSON 损坏**一律抛出**（不在这里降级）：`0` 在 D8 里是「确定无人在岗」的语义，
	// 与「读不出来」不能混为一谈。降级由调用方决定并留日志（board 的 refreshOnlineCounts）。
	const file = await readOrg(org);
	const flags = await Promise.all(
		file.members.map(async (m) => {
			const rt = await readRuntime(org, m.name);
			return rt ? isPidAlive(rt.pid) : false;
		}),
	);
	let online = 0;
	for (const alive of flags) if (alive) online += 1;
	return online;
}

/** 四态的"活跃度"序（合并多所属时取最大者；数值只用于比较，无外部语义） */
const PRESENCE_RANK: Record<PresenceState, number> = {
	sleeping: 0,
	idle: 1,
	delivered: 2,
	working: 3,
};

/**
 * 多所属合并（ADR-0070，与 D1「所属是集合」配套）：本目录可同时属于多家 org，
 * 而同一个成员（名字相同 = 同一目录 agent）在每家各有一条四态记录 —— 计数只能算**一次**。
 *
 * 冲突时取**最活跃**的那个：某家残留的睡眠 runtime 不该把已上岗的统计拉低。
 * 名字不同即视为不同成员（同目录在不同 org 里名字相同，故同名即同人）。
 */
export function mergePresenceStates(
	entries: Iterable<{ name: string; state: PresenceState }>,
): PresenceState[] {
	const byName = new Map<string, PresenceState>();
	for (const { name, state } of entries) {
		const prev = byName.get(name);
		if (!prev || PRESENCE_RANK[state] > PRESENCE_RANK[prev]) byName.set(name, state);
	}
	return [...byName.values()];
}
/**
 * 清理残留 runtime（成员进程被 SIGKILL 时 `clearRuntime` 跑不到）。
 *
 * 只清「判为睡眠」且 `updatedAt` 已过宽限期的条目；返回被清理的成员名。
 * 由巡检循环显式调用——渲染路径不得调用（保持渲染无副作用）。
 */
export async function sweepStaleRuntime(
	org: string,
	presences: Map<string, MemberPresence>,
	opts?: { graceMs?: number; now?: number },
): Promise<string[]> {
	const graceMs = opts?.graceMs ?? STALE_GRACE_MS;
	const now = opts?.now ?? Date.now();
	const swept: string[] = [];
	for (const [name, p] of presences) {
		if (p.state !== 'sleeping' || !p.runtime) continue;
		// pid 仍存活（陈旧 runtime 或 pid 被复用）→ 绝不清理：清掉会让看板遗忘该成员，
		// 并可能诱发重复拉起。只清"进程确实不在"的残留（SIGKILL 场景）。
		if (p.pidAlive) continue;
		const updated = Date.parse(p.runtime.updatedAt);
		const aged = Number.isNaN(updated) || now - updated >= graceMs;
		if (!aged) continue;
		await fs.unlink(runtimeFile(org, name)).catch(() => {});
		swept.push(name);
	}
	return swept;
}

/** 在岗时长（人类可读短格式；睡眠态返回 null） */
export function onlineFor(presence: MemberPresence, now = Date.now()): string | null {
	const started = presence.runtime?.startedAt;
	if (presence.state === 'sleeping' || !started) return null;
	const t = Date.parse(started);
	if (Number.isNaN(t)) return null;
	const sec = Math.max(0, Math.floor((now - t) / 1000));
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m`;
	const hour = Math.floor(min / 60);
	if (hour < 24) return `${hour}h${min % 60}m`;
	return `${Math.floor(hour / 24)}d${hour % 24}h`;
}
