/**
 * permission-gate — 审计分析聚合（T10，ADR-0027）
 *
 * 从全量审计日志聚合分级指标，供面板「分析（Analytics）」Tab 展示。
 * 纯函数：接收 AuditEntry[]，输出确定性指标（可单测）。
 *
 * 指标：
 *   - 按级别分组：confirmed（ask）/ auto / blocked（deny）计数
 *   - criticalGraduated：critical 被 graduated 自动放行的命令清单（异常：本该最严格）
 *   - topConfirmed：高频被确认命令 Top N
 *   - falseBlockRate：误拦（用户拒绝）比例 = blocked / (confirmed + auto + blocked)
 */

import type { AuditEntry } from './audit-log.js';
import type { DangerTier } from './config.js';

export interface TierCounts {
	confirmed: number;
	auto: number;
	blocked: number;
}

export interface AnalyticsMetrics {
	byTier: Record<DangerTier, TierCounts>;
	/** critical 被 graduated 自动放行的命令摘要（去重） */
	criticalGraduated: string[];
	/** 高频被确认命令 Top N（按 command 分组计数，降序） */
	topConfirmed: Array<{ command: string; count: number }>;
	/** 误拦比例 0..1（blocked / (confirmed + auto + blocked)），无拦截时 0 */
	falseBlockRate: number;
	/** 参与统计的拦截条目总数 */
	totalIntercepted: number;
}

const emptyCounts = (): TierCounts => ({ confirmed: 0, auto: 0, blocked: 0 });

/**
 * 聚合审计指标。
 * @param entries 审计条目（任意顺序）
 * @param days 时间窗口（天），省略则不限制
 * @param topN 高频被确认命令 Top N 数量
 */
export function computeAnalytics(entries: AuditEntry[], days?: number, topN = 5): AnalyticsMetrics {
	const cutoff = days ? Date.now() - days * 86400000 : 0;
	const filtered = entries.filter((e) => new Date(e.ts).getTime() >= cutoff);

	const byTier: Record<DangerTier, TierCounts> = {
		critical: emptyCounts(),
		warning: emptyCounts(),
		info: emptyCounts(),
	};
	const criticalGraduated = new Set<string>();
	const confirmedCounts = new Map<string, number>();
	let totalIntercepted = 0;

	for (const e of filtered) {
		if (e.decision === 'allow') continue; // 未命中规则，不参与分级指标
		totalIntercepted++;

		const tier: DangerTier = e.tier ?? 'info';
		const counts = byTier[tier];
		if (e.decision === 'ask') {
			counts.confirmed++;
			confirmedCounts.set(e.command, (confirmedCounts.get(e.command) ?? 0) + 1);
		} else if (e.decision === 'auto') {
			counts.auto++;
			if (tier === 'critical') criticalGraduated.add(e.command);
		} else if (e.decision === 'deny') {
			counts.blocked++;
		}
	}

	const topConfirmed = [...confirmedCounts.entries()]
		.map(([command, count]) => ({ command, count }))
		.sort((a, b) => b.count - a.count)
		.slice(0, topN);

	const totalDecided =
		byTier.critical.blocked +
		byTier.critical.confirmed +
		byTier.critical.auto +
		byTier.warning.blocked +
		byTier.warning.confirmed +
		byTier.warning.auto +
		byTier.info.blocked +
		byTier.info.confirmed +
		byTier.info.auto;

	const totalBlocked = byTier.critical.blocked + byTier.warning.blocked + byTier.info.blocked;

	const falseBlockRate = totalDecided > 0 ? totalBlocked / totalDecided : 0;

	return {
		byTier,
		criticalGraduated: [...criticalGraduated],
		topConfirmed,
		falseBlockRate,
		totalIntercepted,
	};
}
