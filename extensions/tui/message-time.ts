/**
 * message-time — 在 pi 内置对话流（transcript）里给每条 user / assistant 消息
 * 顶部注记一行时间。
 *
 * 形态（三段式：尽量短、且不产生歧义）
 *   今日        [14:23:05]
 *   同年非今日  [09-08 14:23:05]
 *   跨年        [2026-09-08 14:23:05]
 *
 * 显示语义
 *   - user      消息 → 自身提交时刻（UserMessage.timestamp）
 *   - assistant 消息 → 「首 token 返回」时刻
 *       · 实时：首个 message_update 到达时刻（最接近首 token）
 *       · 回放：会话文件没有首 token 字段，退化为 message.timestamp
 *         （provider 发请求前赋的 LLM 调用发起时刻，比首 token 略早）
 *
 * 实现边界（纯扩展：不 patch 本体、不动会话 schema，全部走 markdown transformer）
 *   - assistant 块 = thinking 折叠块 + 正文；markdown transformer 只能改写文本块，
 *     注记落在「正文顶部」，无法压过 thinking 出现在整条消息最外层。
 *   - 归属靠「文本指纹表」（message_start/update/end 增量注册；session_start 从会话树预载）。
 *     同一文本重复出现时取最近一次，属已知退化。
 *   - 不走 transformer、因此没有时间行的消息类型：compactionSummary、branchSummary、toolResult。
 *   - 纯文本形态（不加星号/斜体）：markdown 层无 dim/muted 通道，行内强调实测无效；
 *     真暗色需改组件层（assistant-message.js + theme.muted），本扩展不做。
 *
 * 配置：无（零配置常开）。
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createLogger } from '@zenone/pi-logger';

const log = createLogger('message-time');

// ── 类型与状态 ─────────────────────────────────────────────────────────────

/** 归属记录：一条文本段要显示的时间（毫秒） */
interface Owner {
	ms: number;
}

/** 正在流式的 assistant 回复（transform 未命中指纹时的兜底归属） */
interface ActiveReply {
	/** 首 token 时刻（首个 message_update 到达）；未到则退化为 msg.timestamp */
	firstTokenMs: number;
}

/** 注记行幂等标记：**仅**匹配本扩展注入的三段式时间行（须在行首，后接换行） */
const TIME_LINE_RE = /^\[(?:\d{4}-\d{2}-\d{2} |\d{2}-\d{2} )?\d{2}:\d{2}:\d{2}\]\n/;

// module 级闭包状态（/reload 后随模块重建，无跨会话持久化需求）
let lastUserStartMs = 0; // 最近一次 user 提问提交时刻
let firstTokenSeen = false; // 一轮回复内首 token 是否已采集
let activeReply: ActiveReply | null = null; // 当前实时流式 assistant 回复
const fingerprint = new Map<string, Owner>(); // 文本段 → 归属时间
const MAX_FINGERPRINT = 5000;

// ── 纯函数 ─────────────────────────────────────────────────────────────────

/**
 * 时间注记文本（三段式）。
 * @param ms  要显示的毫秒时间戳
 * @param now 参考「现在」（默认当前时刻，注入以便单测）
 */
export function fmtTime(ms: number, now: Date = new Date()): string {
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, '0');
	const hms = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
	const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	if (d.getFullYear() !== now.getFullYear()) return `${d.getFullYear()}-${md} ${hms}`;
	if (d.getMonth() !== now.getMonth() || d.getDate() !== now.getDate()) return `${md} ${hms}`;
	return hms;
}

/** 消息时间合理性兜底：回复起点不可能早于所属提问（mock 预构造消息的 timestamp 可能是加载时刻） */
function plausibleAssistantMs(candidate: number): number {
	return Math.max(candidate, lastUserStartMs);
}

// ── 工具 ───────────────────────────────────────────────────────────────────

function msgTimestamp(msg: { timestamp?: number }): number | undefined {
	return typeof msg.timestamp === 'number' ? msg.timestamp : undefined;
}

/** 取消息的全部文本段（兼容 content 为 string 或 [{type:'text'}] 两种形态） */
function extractTexts(content: unknown): string[] {
	const out: string[] = [];
	if (typeof content === 'string') {
		if (content.trim()) out.push(content.trim());
	} else if (Array.isArray(content)) {
		for (const b of content) {
			if (!b || typeof b !== 'object') continue;
			const type = (b as { type?: string }).type;
			if (type === 'text') {
				const t = ((b as { text?: string }).text ?? '').trim();
				if (t) out.push(t);
			}
		}
	}
	return out;
}

function registerTexts(content: unknown, owner: Owner): void {
	for (const t of extractTexts(content)) {
		if (fingerprint.size >= MAX_FINGERPRINT) fingerprint.clear();
		fingerprint.set(t, owner);
	}
}

/** 从历史会话条目预载指纹表（回放 / 重启后历史重绘命中） */
function preloadHistory(ctx: ExtensionContext): void {
	try {
		const entries = ctx.sessionManager.getEntries();
		let loaded = 0;
		for (const entry of entries) {
			if (entry.type !== 'message') continue;
			const m = entry.message as { role?: string; timestamp?: number; content?: unknown };
			const ms = msgTimestamp(m) ?? Date.now();
			if (m.role === 'user') {
				// 与实时路径一致：维护「最近一次提问时刻」，供 assistant 时间钳制
				lastUserStartMs = ms;
				registerTexts(m.content, { ms });
				loaded++;
			} else if (m.role === 'assistant') {
				// 回放取不到首 token，退化用 message.timestamp（LLM 调用发起时刻）
				registerTexts(m.content, { ms: plausibleAssistantMs(ms) });
				loaded++;
			}
		}
		log.debug('preloaded history fingerprints', { loaded, total: fingerprint.size });
	} catch (err) {
		log.warn('preload history failed', { err });
	}
}

// ── 扩展入口 ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
	// user 提问：注册文本（提交时刻）供渲染命中
	pi.on('message_start', (event) => {
		const msg = event.message as { role?: string; timestamp?: number; content?: unknown };
		if (msg.role !== 'user') return;
		lastUserStartMs = msgTimestamp(msg) ?? Date.now();
		registerTexts(msg.content, { ms: lastUserStartMs });
		activeReply = null;
	});

	// assistant 开始：记录候选起点（msg.timestamp = LLM 调用发起，首 token 兜底值）
	pi.on('message_start', (event) => {
		const msg = event.message as { role?: string; timestamp?: number };
		if (msg.role !== 'assistant') return;
		activeReply = { firstTokenMs: msgTimestamp(msg) ?? Date.now() };
	});

	// assistant 流式：首个 update ≈ 首 token 到达；注册累积文本段
	pi.on('message_update', (event) => {
		const msg = event.message as { role?: string; timestamp?: number; content?: unknown };
		if (msg.role !== 'assistant') return;
		// 首个 update 时刻即“首 token”；其后保持首次值（activeReply 在 message_end 前一直存活）
		const ms = msgTimestamp(msg) ?? Date.now();
		if (activeReply && !firstTokenSeen) {
			activeReply.firstTokenMs = ms;
			firstTokenSeen = true;
		}
		registerTexts(msg.content, {
			ms: plausibleAssistantMs(activeReply ? activeReply.firstTokenMs : ms),
		});
	});

	// assistant 定稿：注册最终全文；清活跃态
	pi.on('message_end', (event) => {
		const msg = event.message as { role?: string; timestamp?: number; content?: unknown };
		if (msg.role !== 'assistant') return;
		const ms = msgTimestamp(msg) ?? Date.now();
		registerTexts(msg.content, {
			ms: plausibleAssistantMs(activeReply ? activeReply.firstTokenMs : ms),
		});
		activeReply = null;
		firstTokenSeen = false;
	});

	// 回放 / 重启：从会话树预载（assistant 只能取发起时刻近似）
	pi.on('session_start', async (_event, ctx) => {
		preloadHistory(ctx);
	});

	// 展示：user / assistant 文本块渲染前，顶部注入一行时间注记
	pi.registerMarkdownTransformer((markdown, ctx) => {
		if (ctx.messageType !== 'user' && ctx.messageType !== 'assistant') return markdown;
		const text = markdown.trim();
		if (!text) return markdown;
		if (TIME_LINE_RE.test(markdown)) return markdown; // 幂等（已注入过）

		// 归属：精确指纹优先；流式 assistant 未命中时用活跃回复兜底
		let owner = fingerprint.get(text);
		if (!owner && ctx.isStreaming && ctx.messageType === 'assistant' && activeReply) {
			owner = { ms: plausibleAssistantMs(activeReply.firstTokenMs) };
		}
		if (!owner) return markdown;

		return `[${fmtTime(owner.ms)}]\n\n${markdown}`;
	});

	log.info('message-time loaded');
}
