// org — 在岗判定（ADR-0041 D1 → **修订：ADR-0043 D2**）
//
// 在岗 = 该 cwd 已注册为 org 成员 **且** 本会话**真的能被成员消息触达**。
// 判据取「可收发成员消息」的物理真相：control 建在本会话的控制 socket **可连**。
//
// 为什么不再查 argv：`--session-control` 只表示「启动时请求建 socket」，
// 而 `getFlag` 按扩展隔离（`loader.js`：`if (!extension.flags.has(name)) return undefined`），
// org 读 control 注册的 flag 恒为 undefined —— 旧实现实际靠 `process.argv` 字符串匹配，
// 与「socket 真的建成了」并不等价（control 建失败时会被误判为在岗）。
//
// 本模块只负责**进程侧**的那一半条件；"是否已注册 org" 由调用方（resolveSelf）判定。
//
// 路径约定与 control 的 `getSocketPath`（`<home>/.pi/session-control/<sessionId>.sock`）同源：
// org 这里自行复刻，避免加载期对 control 模块的硬依赖（见 CONTROL_SOCKET_EVENT 的说明）。

import * as os from 'node:os';
import * as path from 'node:path';
import { isSocketAlive } from './util.js';

/** control 扩展注册的 flag 名（只表示"启动时请求建 socket"，**不作判据**） */
export const ON_DUTY_FLAG = 'session-control';

/** control 的 socket 目录（与 control 扩展同源约定） */
export function sessionSocketDir(): string {
	return path.join(os.homedir(), '.pi', 'session-control');
}

/** 本会话在 control 侧的 socket 路径（与 control 的 `getSocketPath` 同源约定） */
export function selfSocketPath(sessionId: string): string {
	return path.join(sessionSocketDir(), `${sessionId}.sock`);
}

/**
 * 本进程是否在岗：以 socket 是否**真的可连**为准（ADR-0043 D2）。
 *
 * 用 `ping` 探测而非仅看文件存在——崩溃残留的 socket 文件不可连，不算在岗。
 */
export async function isSelfOnDuty(sessionId: string, timeoutMs = 1500): Promise<boolean> {
	if (!sessionId) return false;
	return isSocketAlive(selfSocketPath(sessionId), timeoutMs);
}

/** 供日志/提示使用：说明"为什么不是在岗"**以及怎么进入在岗**（可发现性，ADR-0043 D3 → ADR-0046 D2） */
export function offDutyReason(): string {
	return `本会话没有可用的控制 socket（不可上岗）。先开启会话控制：/control on（或启动时加 --${ON_DUTY_FLAG}），再执行 /org on 上岗（在岗由 org 自决，ADR-0046）。`;
}

/**
 * control 广播「socket 状态变化」的频道名（ADR-0043 D1 → D4 的运行时联动）。
 *
 * 与 `extensions/auto/control/switch.ts` 的 `CONTROL_SOCKET_CHANNEL` **必须一致**，
 * 由 `org.onduty.test.ts` 的契约测试防漂移。
 *
 * 这里用本地字面量而**不**跨扩展 import：control 可能因 profile 配置未被装载，
 * 那时 org 不应因为一个模块解析失败而整个加载不了（`<home>/.pi/session-control/<id>.sock`
 * 这一路径约定同样是本模块自行复刻 control 的）。
 */
export const CONTROL_SOCKET_EVENT = 'control:socket';

/** 该事件的载荷（与 control 的 `ControlSocketEvent` 同形） */
export interface ControlSocketPayload {
	enabled: boolean;
	socketPath: string | null;
	/**
	 * 本次启用的来源（ADR-0046 D4/B5）：`'startup'` = 跟随启动 flag 建的 socket（启动意图）；
	 * `'runtime'` = 运行中人工 `/control on` 干预。org **只对启动意图自动上岗**。
	 *
	 * 缺省容错：字段缺失按 `'runtime'` 处理（宁可不自动上岗——状态栏会显示「待上岗」告知出路，
	 * 也不会退回到「control 驱动 org」的旧耦合）。
	 */
	origin?: 'startup' | 'runtime';
}

// ── 在岗决策（ADR-0046）─────────────────────────────────────────────────────
// 以下为**纯函数**：把「必要条件（socket）× 上岗意愿」的判定从副作用里剥出来，
// 便于单测锁住三条铁律：运行中不自动上岗、启动意图自动上岗、必要条件丢失强制回落。

/** 在岗三态（ADR-0046 D2） */
export type DutyState = 'unavailable' | 'eligible' | 'on';

/** 由「在岗实况 + 必要条件」推出三态 */
export function dutyState(input: { onDuty: boolean; socketUp: boolean }): DutyState {
	if (input.onDuty) return 'on';
	return input.socketUp ? 'eligible' : 'unavailable';
}

/** 未上岗时的状态栏文案（在岗态由调用方渲染计数，见 ADR-0043 D3） */
export function offDutyStatusText(input: { orgCount: number; socketUp: boolean }): string {
	if (input.orgCount === 0) return '|org: 未加入（/org create）';
	return input.socketUp ? '|org: 待上岗（/org on）' : '|org: 未连接（/control on）';
}

/** control 广播 socket 状态后，org 应执行的在岗动作 */
export function decideDutyAction(
	e: { enabled: boolean; origin?: 'startup' | 'runtime' },
	onDuty: boolean,
): 'go-on-duty' | 'go-off-duty' | 'stay' {
	// 必要条件丢失 → 强制回落（在岗中 /control off 必须掉线）
	if (!e.enabled) return onDuty ? 'go-off-duty' : 'stay';
	// 只有「跟随启动 flag」建的 socket 才自动上岗（B5）；运行中人工切换一律只到「可上岗」
	const origin = e.origin ?? 'runtime';
	if (origin === 'startup' && !onDuty) return 'go-on-duty';
	return 'stay';
}

/** `/org on` 的受理判定：不可上岗时给出**原因 + 出路**，可上岗返回 null */
export function onDutyRefusal(input: { orgCount: number; socketUp: boolean }): string | null {
	if (input.orgCount === 0) return '本目录未加入任何 org（先 /org create 或 /org join）';
	if (!input.socketUp) {
		return `不可上岗：本会话没有可用的控制 socket。先开会话控制 /control on（或启动时加 --${ON_DUTY_FLAG}），再执行 /org on`;
	}
	return null;
}
