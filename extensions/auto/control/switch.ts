// control — 运行时开关（ADR-0043 D1）
//
// 背景：pi 的扩展 API 只有 `getFlag`、**没有 `setFlag`**，所以一个已经开着的 pi
// 无法通过 flag 热切换「建 socket / 不建」。control 因此维护一个**进程内**的运行时
// override，由 `/control on|off` 命令改写，判定优先级高于启动 flag。
//
// 本模块只放**纯逻辑**（命令解析 + 启用判定），建/拆 socket 由 index.ts 的
// refreshServer 落地；org 侧据此收放能力（见 extensions/auto/org/capability.ts）。

/** control 状态栏键（沿用既有键，切换开关不顶掉既有显示） */
export const CONTROL_STATUS_KEY = 'session-control';

/**
 * socket 状态变化的广播频道（control → org 解耦通知）。
 * 同进程内的扩展共享 `pi.events`，故 org 能据此**运行时**收放能力（ADR-0043 D4）。
 */
export const CONTROL_SOCKET_CHANNEL = 'control:socket';

/**
 * 广播载荷。
 *
 * `origin` **如实陈述本次 socket 启用的来源**（ADR-0046 D4/B5）：`'startup'` = 跟随启动
 * flag（`runtimeOverride === null`），`'runtime'` = 运行中人工 `/control on|off`。
 * 消费方（org）据此区分「启动自动上岗」与「运行中须显式 `/org on`」——control 只陈述
 * 自身事实，不替消费方决定要不要上岗。
 */
export interface ControlSocketEvent {
	enabled: boolean;
	socketPath: string | null;
	origin: 'startup' | 'runtime';
}

/** 运行时 override：null = 未干预（跟随启动 flag）；'status' = 仅查询、不改变开关 */
export type ControlOverride = 'on' | 'off' | 'status' | null;

/**
 * 本次 socket 启用的来源（ADR-0046 D4/B5）。
 *
 * `override === null` = 未干预 → 本次是**跟随启动 flag**建的 socket = 启动意图；
 * 否则是运行中人工 `/control on|off` 干预。消费方（org）据此决定是否自动上岗。
 */
export function socketOrigin(override: ControlOverride): ControlSocketEvent['origin'] {
	return override === null ? 'startup' : 'runtime';
}

/** `/control` 命令的解析结果 */
export type ControlToggle =
	| { action: 'on' }
	| { action: 'off' }
	| { action: 'status' }
	| { action: 'error'; message: string };

/** 解析 `/control` 的参数（空 = 查状态；不改变开关） */
export function parseControlToggle(arg: string): ControlToggle {
	const a = arg.trim().toLowerCase();
	if (a === '' || a === 'status') return { action: 'status' };
	if (a === 'on') return { action: 'on' };
	if (a === 'off') return { action: 'off' };
	return {
		action: 'error',
		message: `未知参数「${arg.trim()}」。用法：/control [on|off]（省略参数查看状态）`,
	};
}

/**
 * 本进程是否应建 socket：运行时 override 优先于启动 flag。
 * `override: 'status'` 不参与判定（它只是查询动作）。
 */
export function resolveControlEnabled(input: {
	flagValue: unknown;
	override: ControlOverride;
}): boolean {
	const { flagValue, override } = input;
	if (override === 'on') return true;
	if (override === 'off') return false;
	return flagValue === true;
}
