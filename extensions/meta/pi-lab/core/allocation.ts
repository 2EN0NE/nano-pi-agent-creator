/**
 * 稳定哈希分桶 — 默认分配策略
 *
 * 把上下文键哈希到 [0,1)，按 arm 权重切分区间。
 * 同一上下文键永远落同一区间 → 同一 arm，保证实验内无漂移。
 */

import type { ArmDef } from '../types.js';

/**
 * 稳定哈希分桶：按 arm 权重把哈希空间 [0,1) 切分，返回落点所在的 arm id。
 *
 * @param ctxKey 上下文键（如 "anthropic:claude-sonnet-4-5" 或 "global"）
 * @param arms 实验臂（含可选 weight，默认等权）
 */
export function stableHashAssign(ctxKey: string, arms: ArmDef[]): string {
	if (arms.length === 0) throw new Error('无可用实验臂');
	if (arms.length === 1) return arms[0].id;

	const totalWeight = arms.reduce((sum, a) => sum + (a.weight ?? 1), 0);
	if (totalWeight <= 0) throw new Error('实验臂权重总和必须为正');

	const h = hashToUnit(ctxKey);
	let acc = 0;
	for (const arm of arms) {
		acc += (arm.weight ?? 1) / totalWeight;
		if (h < acc) return arm.id;
	}
	return arms[arms.length - 1].id; // 浮点边界兜底
}

/**
 * FNV-1a 哈希，输出 [0,1) 的 32 位均匀分布。
 * 确定性：同一输入恒得同一输出。
 */
function hashToUnit(input: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0) / 0x100000000;
}
