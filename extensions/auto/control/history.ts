/**
 * 会话历史的**压缩**（供 control 的 `get_history` 命令使用；ADR-0052 `D5`）。
 *
 * 目的：让外部（org 看板）能"只读地问出"某成员最近在干什么，同时**绝不把完整会话倒出去**。
 * 口径照抄参考实现（pi-dynamic-workflows 的 `compactAgentHistory`）的三重上限：
 * **条数 / 单条字符 / 总量字符**——三者同时生效，避免"限制了条数但单条 1MB"。
 *
 * 纯函数、无 IO、不依赖 pi 运行时：便于穷举测试。
 */

export type HistoryRole = 'user' | 'assistant' | 'tool';
export type HistoryKind = 'text' | 'toolCall' | 'toolResult' | 'error';

export interface HistoryEntry {
	role: HistoryRole;
	kind: HistoryKind;
	text: string;
	toolName?: string;
	/** 文件类工具调用涉及的文件路径（看板一行摘要要用）。 */
	path?: string;
	/** `edit` 工具的原生 diff（看板不渲染全文，只用于"在改什么文件"的判读）。 */
	diff?: string;
	isError?: boolean;
	timestamp?: number;
}

export interface CompactOptions {
	maxEntries?: number;
	maxTextChars?: number;
	maxTotalChars?: number;
}

export const DEFAULT_MAX_ENTRIES = 20;
export const DEFAULT_MAX_TEXT_CHARS = 2000;
export const DEFAULT_MAX_TOTAL_CHARS = 20000;

/** 外部可指定条数，但**不允许无上限**（下限 1、上限 50）。 */
export const MIN_HISTORY_LIMIT = 1;
export const MAX_HISTORY_LIMIT = 50;

/** 把外部传入的 `limit` 夹到合法区间；非法值退回默认条数。 */
export function clampHistoryLimit(raw: unknown): number {
	const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : Number.NaN;
	if (!Number.isFinite(n)) return DEFAULT_MAX_ENTRIES;
	return Math.min(MAX_HISTORY_LIMIT, Math.max(MIN_HISTORY_LIMIT, n));
}

/**
 * 压缩消息序列为**事件行**（保持原始顺序，只保留最近 `maxEntries` 条并夹到总量预算内）。
 *
 * 认得的消息形状（pi 的会话分支）：
 * - `{ role: 'user', content }` → 一条文本行；
 * - `{ role: 'assistant', content: [{type:'text'|'toolCall'|...}] }` → 文本行 / 工具调用行 / 错误行；
 * - `{ role: 'toolResult', content, toolName, details, isError }` → 工具结果行（edit 带 diff）。
 *
 * 认不得的形状**跳过**（不猜、不抛错）——外部观测不该因为消息形状变化而失败。
 */
export function compactHistory(messages: unknown[], opts: CompactOptions = {}): HistoryEntry[] {
	const maxEntries = positiveInt(opts.maxEntries, DEFAULT_MAX_ENTRIES);
	const maxTextChars = positiveInt(opts.maxTextChars, DEFAULT_MAX_TEXT_CHARS);
	const maxTotalChars = positiveInt(opts.maxTotalChars, DEFAULT_MAX_TOTAL_CHARS);
	const entries: HistoryEntry[] = [];

	for (const raw of messages) {
		const message = asRecord(raw);
		if (!message) continue;
		const role = message.role;
		const timestamp = typeof message.timestamp === 'number' ? message.timestamp : undefined;

		if (role === 'user') {
			const text = textFromContent(message.content);
			if (text.trim()) entries.push({ role: 'user', kind: 'text', text, timestamp });
			continue;
		}

		if (role === 'assistant') {
			for (const part of Array.isArray(message.content) ? message.content : []) {
				const block = asRecord(part);
				if (!block || typeof block.type !== 'string') continue;
				if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
					entries.push({ role: 'assistant', kind: 'text', text: block.text, timestamp });
				} else if (block.type === 'toolCall' && typeof block.name === 'string') {
					const args = asRecord(block.arguments);
					const filePath =
						(block.name === 'write' || block.name === 'edit') &&
						typeof args?.path === 'string'
							? args.path
							: undefined;
					// write 的 JSON 信封既吵又容易被截成非法 JSON：直接用源码本体，路径单独带上。
					const writeContent =
						block.name === 'write' && filePath && typeof args?.content === 'string'
							? args.content
							: undefined;
					entries.push({
						role: 'assistant',
						kind: 'toolCall',
						toolName: block.name,
						text: writeContent ?? stringifyCompact(block.arguments ?? {}),
						path: filePath,
						timestamp,
					});
				}
			}
			if (typeof message.errorMessage === 'string' && message.errorMessage.trim()) {
				entries.push({
					role: 'assistant',
					kind: 'error',
					text: message.errorMessage,
					isError: true,
					timestamp,
				});
			}
			continue;
		}

		if (role === 'toolResult') {
			const toolName = typeof message.toolName === 'string' ? message.toolName : undefined;
			const details = asRecord(message.details);
			entries.push({
				role: 'tool',
				kind: message.isError ? 'error' : 'toolResult',
				toolName,
				text: textFromContent(message.content) || '(no text output)',
				diff:
					toolName === 'edit' && typeof details?.diff === 'string'
						? details.diff
						: undefined,
				isError: Boolean(message.isError),
				timestamp,
			});
		}
	}

	return fitEntries(entries, maxEntries, maxTextChars, maxTotalChars);
}

/** 取最近 `maxEntries` 条，并从新到旧夹进总量预算（保持原顺序返回）。 */
function fitEntries(
	entries: HistoryEntry[],
	maxEntries: number,
	maxTextChars: number,
	maxTotalChars: number,
): HistoryEntry[] {
	const fitted: HistoryEntry[] = [];
	let total = 0;

	for (const entry of entries.slice(-maxEntries).reverse()) {
		const remaining = maxTotalChars - total;
		if (remaining <= 0) break;
		// diff 是该条的主载荷：与文本共用同一份条数/总量预算，防止大改动绕过压缩。
		let budget = Math.min(maxTextChars, remaining);
		const diff = entry.diff ? truncateText(entry.diff, budget) : undefined;
		budget -= diff?.length ?? 0;
		const text = truncateText(entry.text, budget);
		fitted.unshift({ ...entry, text, diff });
		total += text.length + (diff?.length ?? 0);
	}

	return fitted;
}

function textFromContent(content: unknown): string {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	return content
		.map((part) => {
			const block = asRecord(part);
			return block?.type === 'text' && typeof block.text === 'string' ? block.text : '';
		})
		.filter(Boolean)
		.join('');
}

function stringifyCompact(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function truncateText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	if (maxChars <= 20) return text.slice(0, maxChars);
	return `${text.slice(0, maxChars - 20)}... [truncated]`;
}

function positiveInt(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0
		? Math.floor(value)
		: fallback;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}
