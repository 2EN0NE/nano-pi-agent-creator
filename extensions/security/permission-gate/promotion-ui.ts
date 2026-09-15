/**
 * permission-gate — 提升建议的非阻塞提示与采纳入口
 *
 * - **Ticket 06（非阻塞提示）**：候选产生时用状态栏 + 一条通知告知，不抢焦点、不阻塞 agent。
 *   文本以 `|` 开头（AGENTS.md 状态栏约定）。
 * - **Ticket 07（确认卡片）已实现**：见 `promotion-card.ts`——台阶选择 + 出处条件勾选 + 证据
 *   通过 `ctx.ui.custom` 呈现，本文件负责把它接到面板「设置 → 提升建议」的端到端入口
 *   （以及状态栏/通知的提示）。
 *
 * 不使用定时器（AGENTS.md 坑 #13）：提示只在事件到达时刷新。
 */

import { showSelect } from '@zenone/pi-selector';
import { createLogger } from '@zenone/pi-logger';
import type { ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { makeThemeColors } from '../../../src/tui/helpers.js';
import { getPromotionTracker, type PromotionCandidate } from './promotion.js';
import {
	adoptPromotion,
	listPromoted,
	promotionLevels,
	revokePromotion,
} from './promotion-adopt.js';
import { PromotionCard, type PromotionCardResult } from './promotion-card.js';

const log = createLogger('permission-gate:promotion-ui');

const STATUS_KEY = 'permission-gate:promotion';

/** 刷新状态栏（无待处理项时清空） */
export function refreshPromotionStatus(ctx: ExtensionContext): void {
	const n = getPromotionTracker().peekPending().length;
	ctx.ui.setStatus(STATUS_KEY, n > 0 ? `| 提升建议 ${n} 条 · 面板设置（p）` : undefined);
}

/** 候选产生时的非阻塞提示：状态栏 + 一条通知（不抢焦点、不阻塞 agent） */
export function notifyCandidate(ctx: ExtensionContext, candidate: PromotionCandidate): void {
	refreshPromotionStatus(ctx);
	const e = candidate.evidence;
	ctx.ui.notify(
		`提升建议：${candidate.tool} 已被人工放行 ${e.sessionManual} 次却从未自动放行（自动 ${e.sessionAuto} 次）——打开 /permission-gate 面板的「设置」（快捷键 p）`,
		'info',
	);
}

interface PromotionItem {
	value: string;
	label: string;
	detail?: string;
}

/**
 * 面板「设置」里「提升建议」行的摘要：待处理候选数 / 已提升条目数。
 */
export function promotionSummary(cwd: string): { pending: number; promoted: number } {
	return {
		pending: getPromotionTracker().peekPending().length,
		promoted: listPromoted(cwd).length,
	};
}

/** 面板「设置 → 提升建议」：列出待处理建议与已提升条目，逐条采纳 / 撤销 */
export async function handlePromotionCommand(
	ctx: ExtensionCommandContext,
	cwd: string,
): Promise<void> {
	const tracker = getPromotionTracker();
	const pending = [...tracker.peekPending()];
	const promoted = listPromoted(cwd);

	if (!ctx.hasUI) {
		log.info(
			'提升建议：待处理 %d 条，已提升 %d 条（无界面，仅日志）',
			pending.length,
			promoted.length,
		);
		return;
	}

	const items: PromotionItem[] = [
		...pending.map((c) => ({
			value: `adopt:${c.key}`,
			label: `[建议] ${c.tool} · ${c.dir}`,
			detail: `本会话人工 ${c.evidence.sessionManual} / 自动 ${c.evidence.sessionAuto}；历史 ${c.evidence.historyDirectories} 目录 / ${c.evidence.historySessions} 会话 / ${c.evidence.userDenials} 次用户拒绝`,
		})),
		...promoted.map((p) =>
			p.synthetic
				? {
						// 只读兜底条目：来自用户层自然沉淀，不可在此撤销（删除会抹掉本该保留的规则）
						value: `inert:${p.key}`,
						label: `[用户层·自然沉淀] ${p.key}`,
						detail: `${p.evidence} · 非提升产生，不可撤销`,
					}
				: {
						value: `revoke:${p.key}`,
						label: `[已提升] ${p.key}${p.root ? ` → ${p.root}` : ''}`,
						detail: `${p.evidence}${p.createdAt ? ` · ${p.createdAt.slice(0, 16).replace('T', ' ')}` : ''}`,
					},
		),
	];

	if (items.length === 0) {
		ctx.ui.notify('没有待处理的提升建议，也没有已提升条目', 'info');
		return;
	}

	const picked = await showSelect<string>(ctx, '提升建议 / 已提升条目', items);
	if (!picked) return;

	const [action, ...rest] = picked.value.split(':');
	const key = rest.join(':');

	if (action === 'inert') {
		ctx.ui.notify(
			`${key} 来自用户层自然沉淀（非提升产生），不在此撤销；如确需删除请直接编辑用户级 config.json`,
			'info',
		);
		return;
	}

	if (action === 'revoke') {
		const r = revokePromotion(cwd, key);
		ctx.ui.notify(
			r.ok
				? `已撤销 ${key}${r.removedRoot ? `（并移除范围根 ${r.removedRoot}）` : ''}`
				: `撤销失败：${r.error ?? '未知原因'}`,
			r.ok ? 'info' : 'error',
		);
		refreshPromotionStatus(ctx);
		return;
	}

	const candidate = pending.find((c) => c.key === key);
	if (!candidate) {
		ctx.ui.notify('该建议已过期，请重新打开', 'warning');
		refreshPromotionStatus(ctx);
		return;
	}

	// Ticket 07：确认卡片（台阶选择 + 出处条件勾选 + 证据）
	// 认不出目标根时 `promotionLevels` 只给两级，卡片自然也只会展示两级（不猜）。
	const levels = promotionLevels(candidate.dir, cwd);
	const cardResult = await ctx.ui.custom<PromotionCardResult>(
		(_tui, theme, _kb, done) =>
			new PromotionCard(candidate, levels, makeThemeColors(theme), done),
	);

	if (cardResult.action === 'cancel') return;
	if (cardResult.action === 'ignore') {
		tracker.markIgnored(key);
		tracker.resolvePending(key);
		refreshPromotionStatus(ctx);
		ctx.ui.notify(`已忽略本次建议：${key}（本会话不再提示）`, 'info');
		return;
	}

	const r = adoptPromotion({
		cwd,
		candidate,
		level: cardResult.level,
		requireProvenance: cardResult.requireProvenance,
	});
	if (!r.ok) {
		ctx.ui.notify(`采纳失败：${r.error ?? '未知原因'}`, 'error');
		return;
	}
	tracker.resolvePending(key);
	refreshPromotionStatus(ctx);
	ctx.ui.notify(
		[
			`已采纳：${key}`,
			r.moved.length > 0 ? '计数已迁到用户层（跨目录生效）' : '',
			r.scopeRoot
				? `范围 += ${r.scopeRoot}${cardResult.requireProvenance ? '（仅限本会话创建的路径）' : '（未挂条件）'}`
				: '',
			r.shadowedByProject ? '注意：该范围被项目级收紧遮蔽，可能不生效' : '',
		]
			.filter(Boolean)
			.join('；'),
		r.shadowedByProject ? 'warning' : 'info',
	);
}
