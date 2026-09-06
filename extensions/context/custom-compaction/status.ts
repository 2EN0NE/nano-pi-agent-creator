/**
 * Status bar rendering for custom-compaction.
 *
 * Pure presentation logic — extracted from index.ts for testability.
 * Depends only on config (getEnabledProfiles) and trigger (shouldTrigger /
 * isApproaching), both injectable for tests via __setStoreForTest.
 */

import { getEnabledProfiles, loadConfig } from './config.js';
import { toModelSpec, type CompactionProfile } from './types.js';
import { shouldTrigger, isApproaching, selectProfileFromTriggered } from './trigger.js';

/** Token 数量格式化（1.5M / 200K / 999） */
export function fmtTokens(n: number): string {
	const abs = Math.abs(n);
	if (abs >= 1_000_000) {
		const scaled = n / 1_000_000;
		return `${Number.isInteger(scaled) ? scaled.toFixed(0) : scaled.toFixed(1)}M`;
	}
	if (abs >= 1_000) {
		const scaled = n / 1_000;
		return `${Number.isInteger(scaled) ? scaled.toFixed(0) : scaled.toFixed(1)}K`;
	}
	return String(n);
}

/** 状态栏所需的 ctx 结构（结构化类型，兼容 ExtensionContext） */
export type StatusCtx = {
	hasUI: boolean;
	ui: {
		setStatus: (key: string, value: string | undefined) => void;
		theme: { fg: (...args: any[]) => string };
	};
	getContextUsage?: () => { tokens: number | null; percent: number | null } | null | undefined;
	model?: { provider: string; id: string; contextWindow?: number };
};

/** 状态栏更新：展示当前上下文使用比例 / 阈值 + 触发/接近/压缩中状态 */
export function updateStatus(ctx: StatusCtx, compactingInProgress: boolean): void {
	if (!ctx.hasUI) return;

	const theme = ctx.ui.theme;
	const contextUsage = ctx.getContextUsage?.() ?? null;

	// 启用集择一（ADR-0036）：与真实压缩决策对齐——复用 selectProfileFromTriggered
	// （模型路由规则 → matchModel 隐式 → tiebreak）。唯一退化：不调复杂度分析
	// （widget 高频刷新，analyzeComplexity 开销大），因此 complexity 维度路由规则
	// 在此不命中、退 tiebreak。
	const enabled = getEnabledProfiles();
	let profile: CompactionProfile | undefined = enabled[0];
	if (contextUsage && contextUsage.tokens !== null) {
		const usage = contextUsage as { tokens: number; percent: number | null };
		const triggered = enabled.filter((p) =>
			shouldTrigger(p.trigger, usage, ctx.model?.contextWindow),
		);
		const picked = selectProfileFromTriggered(triggered, {
			modelSpec: toModelSpec(ctx.model),
			routingRules: loadConfig().routingRules,
		});
		if (picked) profile = picked;
	}
	if (!profile) {
		ctx.ui.setStatus('custom-compact', undefined);
		return;
	}
	const tokens = contextUsage?.tokens ?? null;
	const percent = contextUsage?.percent ?? null;
	// 启用集基数：单个 profile 显示其名称，多个则显示数量（如 "2 active"）。
	const activeCount = enabled.length;
	const pid = activeCount === 1 ? profile.id : `${activeCount} active`;
	let extra: string;
	switch (profile.trigger.type) {
		case 'context_percent': {
			if (percent !== null) {
				extra = `${percent.toFixed(0)}%/${profile.trigger.threshold}%`;
			} else {
				extra = `${profile.trigger.threshold}%`;
			}
			break;
		}
		case 'fixed': {
			if (tokens !== null) {
				extra = `${fmtTokens(tokens)}/${fmtTokens(profile.trigger.threshold)}`;
			} else {
				extra = `${fmtTokens(profile.trigger.threshold)}`;
			}
			break;
		}
		case 'reserve': {
			let windowTokens: number | null = null;
			let cw: number | undefined;
			if (tokens !== null) {
				cw = ctx.model?.contextWindow;
				windowTokens =
					cw !== undefined && cw > 0
						? cw
						: percent !== null && percent > 0
							? Math.round(tokens / (percent / 100))
							: null;
			}
			if (tokens !== null && windowTokens !== null) {
				extra = `${fmtTokens(windowTokens - tokens)}/${fmtTokens(profile.trigger.threshold)}`;
			} else {
				extra = `${fmtTokens(profile.trigger.threshold)}`;
			}
			break;
		}
		default:
			extra = `${fmtTokens(profile.trigger.threshold)}`;
	}
	// 阈值是否已触发（需要用户关注）
	const triggered =
		contextUsage &&
		contextUsage.tokens !== null &&
		shouldTrigger(
			profile.trigger,
			contextUsage as { tokens: number; percent: number | null },
			ctx.model?.contextWindow,
		);
	// 是否接近阈值（>=80% 但未触发）
	const approaching =
		!compactingInProgress &&
		contextUsage &&
		contextUsage.tokens !== null &&
		!triggered &&
		isApproaching(
			profile.trigger,
			contextUsage as { tokens: number; percent: number | null },
			ctx.model?.contextWindow,
		);

	let statusText: string;
	if (compactingInProgress) {
		statusText = theme.fg('accent', `|compact:${pid}-${extra}`);
	} else if (triggered) {
		statusText = theme.fg('error', `|compact:${pid}-${extra}`);
	} else if (approaching) {
		statusText = theme.fg('warning', `|compact:${pid}-${extra}`);
	} else {
		statusText = theme.fg('text', `|compact:${pid}-${extra}`);
	}
	ctx.ui.setStatus('custom-compact', statusText);
}
