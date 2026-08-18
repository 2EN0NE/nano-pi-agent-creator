/**
 * 定义差异比较纯函数（无副作用）
 *
 * 判定「同 owner 同 name 重注册」时实验定义是否演进（采集口径变化）。
 * 比较范围与设计一致——只比较影响 select/record/stats/query 结果的「口径」字段：
 *
 *   - arms：id 集合增删 + 每个 arm 的 weight（label 仅展示，不参与）
 *   - metrics：id 集合增删 + 每个 metric 的 type/direction/isGuardrail/derived（description 仅展示，不参与）
 *   - contextKey 为 string ✅；为 function ⏭️ 跳过（每次注册新建闭包，无法可靠比较）
 *   - assignKey 为 string ✅；为 function ⏭️ 跳过（同上）
 *   - strategy 已收窄为单值 stable-hash，无比较意义（未来加新值再恢复此比较）
 *
 * 输出人话描述列表，供演进告警的「副作用说明」使用。
 */

import type { ArmDef, DefinitionDiff, ExperimentDef, MetricDef } from '../types.js';

/** arm 口径签名：参与分桶/选臂的字段（label 是展示字段，排除） */
function armSignature(a: ArmDef): string {
	return JSON.stringify({ id: a.id, weight: a.weight ?? 1 });
}

/** metric 口径签名：参与统计/分析的字段（description 是展示字段，排除） */
function metricSignature(m: MetricDef): string {
	return JSON.stringify({
		type: m.type,
		direction: m.direction,
		isGuardrail: m.isGuardrail ?? false,
		derived: m.derived ?? null,
	});
}

function diffArms(oldArms: ArmDef[], newArms: ArmDef[]): string[] {
	const changes: string[] = [];
	const oldById = new Map(oldArms.map((a) => [a.id, a]));
	const newById = new Map(newArms.map((a) => [a.id, a]));

	const added = newArms.filter((a) => !oldById.has(a.id)).map((a) => a.id);
	const removed = oldArms.filter((a) => !newById.has(a.id)).map((a) => a.id);
	if (added.length > 0) changes.push(`arms 新增 ${added.join(', ')}`);
	if (removed.length > 0) changes.push(`arms 移除 ${removed.join(', ')}`);

	for (const [id, n] of newById) {
		const o = oldById.get(id);
		if (o && armSignature(o) !== armSignature(n)) {
			changes.push(`arm ${id} 权重变化`);
		}
	}
	return changes;
}

function diffMetrics(oldMetrics: MetricDef[], newMetrics: MetricDef[]): string[] {
	const changes: string[] = [];
	const oldById = new Map(oldMetrics.map((m) => [m.id, m]));
	const newById = new Map(newMetrics.map((m) => [m.id, m]));

	const added = newMetrics.filter((m) => !oldById.has(m.id)).map((m) => m.id);
	const removed = oldMetrics.filter((m) => !newById.has(m.id)).map((m) => m.id);
	if (added.length > 0) changes.push(`metrics 新增 ${added.join(', ')}`);
	if (removed.length > 0) changes.push(`metrics 移除 ${removed.join(', ')}`);

	for (const [id, n] of newById) {
		const o = oldById.get(id);
		if (o && metricSignature(o) !== metricSignature(n)) {
			changes.push(`metric ${id} 口径变化`);
		}
	}
	return changes;
}

export function definitionDiff(oldDef: ExperimentDef, newDef: ExperimentDef): DefinitionDiff {
	const changes: string[] = [];

	changes.push(...diffArms(oldDef.arms, newDef.arms));
	changes.push(...diffMetrics(oldDef.metrics, newDef.metrics));

	// contextKey / assignKey 仅 string 型比较；function 型跳过（闭包每次新建，无法可靠比较）
	if (typeof oldDef.contextKey === 'string' && typeof newDef.contextKey === 'string') {
		if (oldDef.contextKey !== newDef.contextKey) {
			changes.push(`contextKey ${oldDef.contextKey} → ${newDef.contextKey}`);
		}
	}
	if (typeof oldDef.assignKey === 'string' && typeof newDef.assignKey === 'string') {
		if (oldDef.assignKey !== newDef.assignKey) {
			changes.push(`assignKey ${oldDef.assignKey} → ${newDef.assignKey}`);
		}
	}

	return { changed: changes.length > 0, changes };
}
