// org — 状态栏（ADR-0043 D3）：`|org: x/y/z成员`
//
//   x = 在岗且忙（busy=true）—— 主题亮色
//   y = 在岗数量 —— 正常色
//   z = 本 org 注册成员数 —— 暗色（dim）
//
// 状态栏文本必须以半角 `|` 开头（docs/tui-design-principles.md §2.1）。
// 本模块是**纯函数**：不读盘、不探 socket；在岗数量由调用方从 presence 快照算出，
// 以满足「感知不写副作用」（ADR-0040 D4）。

import type { PresenceState } from './presence.js';

/** 状态栏三个计数 */
export interface OrgStatusCounts {
	/** 在岗且忙 */
	working: number;
	/** 在岗（含忙） */
	online: number;
	/** 本 org 注册成员数 */
	total: number;
}

/** 三段各自的语义色调（由调用方映射到主题色） */
export type OrgStatusTone = 'busy' | 'onDuty' | 'dim';

/** 着色器：真实调用传 `theme.fg`，测试传记录器 */
export type OrgStatusColorize = (tone: OrgStatusTone, text: string) => string;

const IDENTITY: OrgStatusColorize = (_tone, text) => text;

/** 由成员四态统计状态栏计数（睡眠不计入在岗） */
export function countOrgStatus(states: readonly PresenceState[]): OrgStatusCounts {
	let working = 0;
	let online = 0;
	for (const s of states) {
		if (s === 'sleeping') continue;
		online += 1;
		if (s === 'working') working += 1;
	}
	return { working, online, total: states.length };
}

/** 格式化状态栏文本：`|org: x/y/z成员` */
export function formatOrgStatus(
	counts: OrgStatusCounts,
	colorize: OrgStatusColorize = IDENTITY,
): string {
	const x = colorize('busy', String(counts.working));
	const y = colorize('onDuty', String(counts.online));
	const z = colorize('dim', String(counts.total));
	return `|org: ${x}/${y}/${z}成员`;
}
