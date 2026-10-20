/**
 * 成员动态：**拉取与降级**（ADR-0052 `D1`/`D2`/`D5`/`D8`）。
 *
 * 语义（务必守住）：
 * - **只读**：读成员进程的最近事件流，不唤醒、不投递、不改任何组织数据；
 * - **失败即降级**：超时 / 通道不可连 / 成员跑旧版 control → 返回"无动态"，**绝不弹错**、
 *   绝不影响「可感知状态」四态与派活；每个成员**只留痕一次**（避免巡检每 4s 刷日志）；
 * - **边界**：拿到的是**已完成轮次**的事件（正在流式输出的那一轮尚未落地），
 *   工具调用只在**已产生消息**时可见——所以它回答"最近在干什么"，不是逐 token 直播。
 *
 * 本模块不做 IO 之外的决策：返回结果由调用方（看板）决定怎么展示。
 */
import type { RpcCommand } from './types.js';
import { classifyRpcError, rpcCall } from './util.js';

export type ActivityRole = 'user' | 'assistant' | 'tool';
export type ActivityKind = 'text' | 'toolCall' | 'toolResult' | 'error';

export interface ActivityEntry {
	role: ActivityRole;
	kind: ActivityKind;
	text: string;
	toolName?: string;
	/** 文件类工具调用涉及的文件路径 */
	path?: string;
	/** `edit` 的原生 diff（看板只用它判断"在改什么文件"） */
	diff?: string;
	isError?: boolean;
	timestamp?: number;
}

/** 列表页要"最近一句话"，只拉 1 条就够（ADR-0052 `D5` 的 payload 下限） */
export const ACTIVITY_LIST_LIMIT = 1;
/** 详情页给"最近一串事件"（跟读感） */
export const ACTIVITY_DETAIL_LIMIT = 10;
/** 观测探测超时：比巡检周期（4s）短得多，不拖慢巡检 */
export const ACTIVITY_TIMEOUT_MS = 1200;

export type ActivityFailReason = 'timeout' | 'unsupported' | 'unreachable';

export type ActivityOutcome =
	{ ok: true; entries: ActivityEntry[] } | { ok: false; reason: ActivityFailReason };

/** 失败原因的中文短句（看板/工具回执共用，避免两处文案漂移） */
export const ACTIVITY_FAIL_TEXT: Record<ActivityFailReason, string> = {
	timeout: '成员无响应（可能版本旧或正忙）',
	unsupported: '成员进程不支持该命令（版本旧）',
	unreachable: '成员进程不可达（可能已退出）',
};

/** 拉取在岗成员的最近动态（只读） */
export async function fetchActivity(
	socketPath: string,
	limit: number,
	timeoutMs: number = ACTIVITY_TIMEOUT_MS,
): Promise<ActivityOutcome> {
	const command: RpcCommand = { type: 'get_history', limit };
	try {
		const { response } = await rpcCall(socketPath, command, { timeoutMs });
		if (!response.success) return { ok: false, reason: 'unsupported' };
		return { ok: true, entries: parseEntries(response.data) };
	} catch (e) {
		return {
			ok: false,
			reason: classifyRpcError(e) === 'timeout' ? 'timeout' : 'unreachable',
		};
	}
}

/** 中断该成员的**当前轮次**（幂等；进程/会话/记忆都保留；ADR-0053 `D1`） */
export async function interruptMember(
	socketPath: string,
	timeoutMs: number = ACTIVITY_TIMEOUT_MS,
): Promise<ActivityOutcome> {
	const command: RpcCommand = { type: 'abort' };
	try {
		const { response } = await rpcCall(socketPath, command, { timeoutMs });
		if (!response.success) {
			return { ok: false, reason: 'unsupported' };
		}
		return { ok: true, entries: [] };
	} catch (e) {
		return {
			ok: false,
			reason: classifyRpcError(e) === 'timeout' ? 'timeout' : 'unreachable',
		};
	}
}

/** 响应载荷 → 事件行；认不得的形状跳过（外部观测不该因载荷变化而抛错） */
export function parseEntries(data: unknown): ActivityEntry[] {
	const container = asRecord(data);
	const raw = Array.isArray(container?.entries) ? container.entries : [];
	const out: ActivityEntry[] = [];
	for (const item of raw) {
		const e = asRecord(item);
		if (!e) continue;
		const role = e.role;
		const kind = e.kind;
		const text = e.text;
		if (typeof text !== 'string') continue;
		if (role !== 'user' && role !== 'assistant' && role !== 'tool') continue;
		if (kind !== 'text' && kind !== 'toolCall' && kind !== 'toolResult' && kind !== 'error') {
			continue;
		}
		out.push({
			role,
			kind,
			text,
			toolName: typeof e.toolName === 'string' ? e.toolName : undefined,
			path: typeof e.path === 'string' ? e.path : undefined,
			diff: typeof e.diff === 'string' ? e.diff : undefined,
			isError: e.isError === true,
			timestamp: typeof e.timestamp === 'number' ? e.timestamp : undefined,
		});
	}
	return out;
}

/**
 * 列表页的"最近一句话"：**优先最近一条 assistant 文本**（成员自己的话最能说明在干什么），
 * 否则退回最近一条事件（如工具调用）。返回 null 表示"无动态"。
 */
export function summariseForList(entries: ActivityEntry[]): { text: string; at?: number } | null {
	if (entries.length === 0) return null;
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (e.role === 'assistant' && e.kind === 'text' && e.text.trim()) {
			return { text: oneLine(e.text), at: e.timestamp };
		}
	}
	const last = entries[entries.length - 1];
	return { text: oneLine(formatActivityLine(last)), at: last.timestamp };
}

/**
 * 详情屏一行的**纯文本**形态（不含颜色；看板自己上色）。
 *
 * 用纯文本标记而非图标（ADR-0023 字符白名单：禁双宽 emoji/符号）：
 * `[tool] edit src/a.ts` / `[res] bash ok …` / `[err] …` / `[in] …`（收到的人类/派活指令）
 */
export function formatActivityLine(entry: ActivityEntry): string {
	const clock = entry.timestamp ? `${clockOf(entry.timestamp)} ` : '';
	if (entry.kind === 'toolCall') {
		const target = entry.path ?? oneLine(entry.text);
		return `${clock}[tool] ${entry.toolName ?? '?'}${target ? ` ${target}` : ''}`;
	}
	if (entry.kind === 'toolResult' || (entry.kind === 'error' && entry.role === 'tool')) {
		const mark = entry.isError ? 'fail' : 'ok';
		return `${clock}[res] ${entry.toolName ?? '?'} ${mark} ${oneLine(entry.text)}`;
	}
	if (entry.kind === 'error') {
		return `${clock}[err] ${oneLine(entry.text)}`;
	}
	if (entry.role === 'user') {
		return `${clock}[in] ${oneLine(entry.text)}`;
	}
	return `${clock}${oneLine(entry.text)}`;
}

/** 事件行里"最值得看"的一行文本（工具的取路径/首个参数，文本的取首行） */
export function oneLine(text: string, maxChars = 200): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length > maxChars ? `${flat.slice(0, maxChars - 1)}…` : flat;
}

/** 时间戳 → `HH:MM`（本地时区；用于"最近动态"行首） */
export function clockOf(ts: number): string {
	const d = new Date(ts);
	const hh = String(d.getHours()).padStart(2, '0');
	const mm = String(d.getMinutes()).padStart(2, '0');
	return `${hh}:${mm}`;
}

/**
 * 同一 key 只放行一次的闸门（巡检每 4s 一轮，失败留痕不得刷屏；ADR-0052 `D8`）。
 * 成功时调用 `forget`，让下次失败可以重新留痕。
 */
export class WarnOnce {
	private seen = new Set<string>();

	shouldWarn(key: string): boolean {
		if (this.seen.has(key)) return false;
		this.seen.add(key);
		return true;
	}

	forget(key: string): void {
		this.seen.delete(key);
	}
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}
