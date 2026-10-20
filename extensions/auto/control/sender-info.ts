// control — 发送者头（`<sender_info>`）的解析与呈现（ADR-0044）
//
// 成员 agent 之间互发的消息经 control 注入会话（`customType: 'session-message'`）。
// pi 的 `convertToLlm` 把 `custom` 压成 `{role:'user', content:原文}`，**customType 不进上下文**，
// 所以"谁在说话"只能由正文里**机器可解析**的头来承载。
//
// 本模块把该头的解析 / 剥离 / 呈现收敛到一处，并在原有 session 维度之外支持
// **org 成员名**（`member` 字段）：渲染层由此能把成员消息显示成 `[成员名]:`，
// 与人类操作者的输入区分开（ADR-0044 D2/D3）。

/** 匹配整个 `<sender_info>…</sender_info>` 段 */
export const SENDER_INFO_PATTERN = /<sender_info>[\s\S]*?<\/sender_info>/g;

export interface SenderInfo {
	sessionId?: string;
	sessionName?: string;
	/** 发送者的 org 成员名（ADR-0044 D2：成员消息用成员名，而非 session 名） */
	member?: string;
}

function trimmed(v: unknown): string {
	return typeof v === 'string' ? v.trim() : '';
}

/**
 * 解析正文里的发送者头。支持：
 * ① JSON（`{"member":"boss"}` / `{"sessionId":"…","sessionName":"…"}`）；
 * ② 历史兼容格式（`session <id>`）。
 */
export function parseSenderInfo(text: string): SenderInfo | null {
	const match = text.match(/<sender_info>([\s\S]*?)<\/sender_info>/);
	if (!match) return null;
	const raw = match[1].trim();
	if (!raw) return null;

	if (raw.startsWith('{')) {
		try {
			const parsed = JSON.parse(raw) as {
				sessionId?: unknown;
				sessionName?: unknown;
				member?: unknown;
			};
			const sessionId = trimmed(parsed.sessionId);
			const sessionName = trimmed(parsed.sessionName);
			const member = trimmed(parsed.member);
			if (sessionId || sessionName || member) {
				return {
					sessionId: sessionId || undefined,
					sessionName: sessionName || undefined,
					member: member || undefined,
				};
			}
		} catch {
			// JSON 解析失败 → 回落到历史格式
		}
	}

	const legacyIdMatch = raw.match(/session\s+([a-f0-9-]{6,})/i);
	if (legacyIdMatch) return { sessionId: legacyIdMatch[1] };

	return null;
}

/** 剥掉发送者头（正文与头两处可能不一致，**以头为准**，正文里不再重复展示机器格式） */
export function stripSenderInfo(text: string): string {
	return text.replace(SENDER_INFO_PATTERN, '').trim();
}

/** session 维度的兼容串（无成员名时的兜底呈现） */
export function formatSenderInfo(info: SenderInfo | null): string | null {
	if (!info) return null;
	const { sessionName, sessionId } = info;
	if (sessionName && sessionId) return `${sessionName} (${sessionId})`;
	if (sessionName) return sessionName;
	if (sessionId) return sessionId;
	return null;
}

/**
 * 卡片标签（渲染层直接用）：
 * - 有成员名 → `[成员名]:`（ADR-0044 D3）；
 * - 否则回落到 `from <session 兼容串>`；
 * - 都没有 → null（不加标签）。
 */
export function senderLabel(info: SenderInfo | null): string | null {
	if (info?.member) return `[${info.member}]:`;
	const compat = formatSenderInfo(info);
	return compat ? `from ${compat}` : null;
}
