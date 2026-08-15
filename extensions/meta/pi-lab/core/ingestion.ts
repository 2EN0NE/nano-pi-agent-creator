/**
 * 信号适配器 — 把各信号入口的原始格式解析成统一事件。
 * 纯函数，无 Pi 依赖，可单元测试。
 *
 * armId 归因：异步信号（TAG/日志）无法由 pi-lab 推断 arm，
 * 故信号里须显式携带 armId。两种内建 adapter 的格式约定：
 *
 *   TAG  label：`<armId>:<metricId>:<value>`
 *   日志 行：   `[pi-lab-signal] arm=<armId> metric=<metricId> value=<value> [ctx=<ctxKey>]`
 */

import type { SignalExtractor } from '../types.js';

/** 解析 TAG label 约定 `<armId>:<metricId>:<value>`，失败返回 null */
export function parseSignalLabel(label: string): {
	armId: string;
	metricId: string;
	value: number;
} | null {
	const parts = label.split(':');
	if (parts.length !== 3) return null;
	const [armId, metricId, valueStr] = parts;
	if (!armId || !metricId || valueStr === '') return null;
	const value = Number(valueStr);
	if (Number.isNaN(value)) return null;
	return { armId, metricId, value };
}

/** 从会话树读取的带 label 的节点 */
export interface TaggedNode {
	label?: string;
	ctxKey: string;
	/** 会话树节点 id，作为 TAG 信号的幂等键（去重） */
	targetId?: string;
}

/** 信号事件（extractor 产出，不含 ts，ingest 时补充） */
export type IngestedEvent = {
	armId: string;
	ctxKey: string;
	metrics: Record<string, number>;
	metadata?: Record<string, unknown>;
	/** 幂等键（可选）：异步信号去重（如 TAG 节点的 targetId） */
	dedupKey?: string;
};

/** TAG adapter：从会话树标注节点提取事件 */
export const tagExtractor: SignalExtractor = (rawData: unknown): IngestedEvent[] => {
	const nodes = rawData as TaggedNode[];
	const events: IngestedEvent[] = [];
	for (const node of nodes) {
		if (!node.label) continue;
		// 节点 label 可能逗号分隔多标签（如 "a:x:1,b:y:0"），逐个解析，避免整条被静默丢弃
		for (const label of node.label.split(',')) {
			const trimmed = label.trim();
			if (!trimmed) continue;
			const parsed = parseSignalLabel(trimmed);
			if (!parsed) continue;
			events.push({
				armId: parsed.armId,
				ctxKey: node.ctxKey,
				metrics: { [parsed.metricId]: parsed.value },
				// 幂等键含 targetId + 标签内容：同一节点同一标签跨 turn_end 只摄入一次，
				// 改标（标签变化）后新标签仍可摄入，避免实验数据无法修正
				...(node.targetId
					? {
							dedupKey: `tag:${node.targetId}:${parsed.armId}:${parsed.metricId}:${parsed.value}`,
						}
					: {}),
			});
		}
	}
	return events;
};

/** pi-log 信号行正则：`[pi-lab-signal] arm=<armId> metric=<metricId> value=<value> [ctx=<ctxKey>]` */
const LOG_SIGNAL_RE =
	/\[pi-lab-signal\]\s+arm=(\S+)\s+metric=(\S+)\s+value=(-?\d+(?:\.\d+)?)(?:\s+ctx=(\S+))?/;

/** 日志 adapter：从 pi-log 日志行提取事件 */
export const logExtractor: SignalExtractor = (rawData: unknown): IngestedEvent[] => {
	const lines = rawData as string[];
	const events: IngestedEvent[] = [];
	for (const line of lines) {
		const m = LOG_SIGNAL_RE.exec(line);
		if (!m) continue;
		const [, armId, metricId, valueStr, ctxKey] = m;
		const value = Number(valueStr);
		if (Number.isNaN(value)) continue;
		events.push({
			armId,
			ctxKey: ctxKey ?? 'global',
			metrics: { [metricId]: value },
		});
	}
	return events;
};
