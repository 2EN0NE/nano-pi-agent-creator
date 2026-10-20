// org — 能力收 / 放（ADR-0043 D4，细化 ADR-0041 D2）
//
// 在岗状态可以在会话中热切换（control 的 `/control on|off`），所以"未在岗就不注册工具"
// 只覆盖了启动那一刻。离岗时必须有**收回**路径，否则 LLM 会继续看到并调用 org 工具。
//
// 手段：`pi.setActiveTools()`。它内部（`setActiveToolsByName`）会同时更新
// `agent.state.tools` **并重建系统提示**，因此工具列表与提示里的一段说明一起收放。
//
// 与「放」的关系：pi 的 `registerTool` 内部会调 `runtime.refreshTools()`，
// **新注册的工具会自动进入活动集**，所以首次在岗注册完就已可见，无需再 setActiveTools。

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/** org 向 LLM 暴露的工具（在岗门控的对象；与 index.ts 注册的名字一一对应） */
export const ORG_TOOL_NAMES = [
	'dispatch_task',
	'org_fleet',
	'org_wake',
	'org_my_tasks',
	'org_accept',
	'org_reject',
	'org_claim',
	'org_report',
	'org_review',
	'org_abort',
	'org_urgent',
] as const;

const ORG_TOOL_SET: ReadonlySet<string> = new Set<string>(ORG_TOOL_NAMES);

/** 是否是 org 的工具 */
export function isOrgTool(name: string): boolean {
	return ORG_TOOL_SET.has(name);
}

/** 只依赖这两个方法，便于用 fake pi 测试 */
export type CapabilityApi = Pick<ExtensionAPI, 'getActiveTools' | 'setActiveTools'>;

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((n, i) => n === b[i]);
}

/**
 * 按在岗状态收 / 放 org 工具。
 *
 * - `onDuty=true`：把全部 org 工具并回活动集（保序：原有在前，缺失的在末尾）；
 * - `onDuty=false`：把它们移出活动集。
 *
 * 幂等：活动集已经正确时**不调用** `setActiveTools`——它会重建系统提示，
 * 无谓调用会白白打破 prompt cache。
 *
 * @returns 是否真的改动了活动集
 */
export function applyOrgCapability(pi: CapabilityApi, onDuty: boolean): boolean {
	const current = pi.getActiveTools();
	const withoutOrg = current.filter((n) => !isOrgTool(n));
	const next = onDuty
		? [...withoutOrg, ...ORG_TOOL_NAMES.filter((n) => !withoutOrg.includes(n))]
		: withoutOrg;
	if (sameOrder(current, next)) return false;
	pi.setActiveTools(next);
	return true;
}
