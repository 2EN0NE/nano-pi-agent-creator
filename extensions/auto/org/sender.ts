// org — 成员消息的发送者头（ADR-0044 D2）
//
// 成员之间互发的消息在**模型层与人类输入同形**：control 以 `customType:'session-message'`
// 注入，pi 的 `convertToLlm` 把 `custom` 压成 `{role:'user', content:原文}`，
// 于是"谁在说话"只能靠正文里**机器可解析**的头承载。
//
// 约定与 control 的 `sender-info.ts` 同格式（`<sender_info>{"member":"…"}</sender_info>`），
// 由 `org.sender.test.ts` 的契约测试防漂移。

/** 匹配整个 `<sender_info>…</sender_info>` 段 */
export const SENDER_INFO_PATTERN = /<sender_info>[\s\S]*?<\/sender_info>/g;

/** 构造发送者头（sender 取 **org 成员名**，不用 session 名 — ADR-0044 D2） */
export function senderHeader(member: string): string {
	return `<sender_info>${JSON.stringify({ member })}</sender_info>`;
}

/**
 * 给成员消息注入发送者头。
 *
 * - **先剥旧头再注入**：至多一个头，重复投递 / 改派不会叠加；
 * - `member` 为空或纯空白（如人类操作者发起）→ **不注入**：
 *   人类消息与成员消息据此可分（ADR-0044 的需求）。
 */
export function withSenderHeader(message: string, member?: string): string {
	const body = message.replace(SENDER_INFO_PATTERN, '').trim();
	const name = (member ?? '').trim();
	if (!name) return body;
	return `${senderHeader(name)}\n${body}`;
}
