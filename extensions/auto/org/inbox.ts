// org — 收件箱（inbox）的**消化**语义（ADR-0054 `D5`/`D7`/`D10`/`D11`）
//
// 职责边界：
//   · 本模块只做「读 / 注入 / 删除 / 簿记」四件事，**不碰任何 pi API**——注入通过回调交给调用方，
//     这样"先注入成功、再删除"的顺序（`D11`）与幂等（`D7`）都能用单测钉死；
//   · 投递（往 inbox 写）仍在 `dispatch.ts`：投递方只负责"放到权威落点"，侧重点不同。
//
// 三条硬约束（都有回归测试）：
//   1. **先注入成功、再删除**：注入失败时消息必须仍在（旧实现是 takeInbox 先删再注入 → 注入失败即永久丢失）；
//   2. **同一 id 不重复注入**：已注入过的 id 只做 ack（清文件）并留痕，不再喂给模型；
//   3. **内容可见**：简报/补投都带内容清单（含 `[msg:<id>]`），不是只有一个计数。
import * as path from 'node:path';
import { createLogger } from '@zenone/pi-logger';
import { ensureDir, nowIso, readJson, writeJsonAtomic } from './util.js';
import { inboxDir, inboxStateFile } from './orgstore.js';

const log = createLogger('org');

/** 单条收件箱记录（`id` = 文件名主干，稳定且可写进消息体供对账） */
export interface InboxRecord {
	id: string;
	at: string;
	message: string;
}

/** 注入簿记：`injected` 记 id → 时间；`events` 记完成类事件 id → 时间（`D10` 去重） */
export interface InboxState {
	injected: Record<string, string>;
	events: Record<string, string>;
}

/** 簿记上限（超过后按时间淘汰最旧；防止文件无限增长） */
export const INBOX_STATE_KEEP = 200;

/** 简报/补投的内容上限：条数 + 单条字符（`D5`：可见，但绝不无限长） */
export const INBOX_CONTENT_MAX_ITEMS = 5;
export const INBOX_CONTENT_MAX_ITEM_CHARS = 400;

/** 读取注入簿记（缺失/损坏一律视为空——簿记只是优化，丢了最多重复注入一次） */
export async function readInboxState(org: string, agent: string): Promise<InboxState> {
	const raw = await readJson<Partial<InboxState>>(inboxStateFile(org, agent));
	return {
		injected: raw?.injected ?? {},
		events: raw?.events ?? {},
	};
}

function prune(map: Record<string, string>): Record<string, string> {
	const entries = Object.entries(map).sort((a, b) => a[1].localeCompare(b[1]));
	if (entries.length <= INBOX_STATE_KEEP) return map;
	return Object.fromEntries(entries.slice(entries.length - INBOX_STATE_KEEP));
}

/** 写入注入簿记（原子写） */
export async function writeInboxState(
	org: string,
	agent: string,
	state: InboxState,
): Promise<void> {
	await ensureDir(path.dirname(inboxStateFile(org, agent)));
	await writeJsonAtomic(inboxStateFile(org, agent), {
		injected: prune(state.injected),
		events: prune(state.events),
	});
}

/** 从消息体里取完成类事件 id（`[evt:<...>]`）——用于 `D10` 的"同一份交付不重复注入" */
export function extractEventIds(message: string): string[] {
	const out: string[] = [];
	for (const m of message.matchAll(/\[evt:([^\]\s]+)\]/g)) out.push(m[1]);
	return out;
}

/** 读取收件箱全部记录（**只看不删**；按 id 排序 = 按投递时间） */
export async function peekInbox(org: string, agent: string): Promise<InboxRecord[]> {
	const { readdir } = await import('node:fs/promises');
	const dir = inboxDir(org, agent);
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return [];
	}
	const out: InboxRecord[] = [];
	for (const n of names.sort((a, b) => a.localeCompare(b))) {
		if (!n.endsWith('.json')) continue;
		const rec = await readJson<{ at?: string; message?: string }>(path.join(dir, n));
		if (!rec?.message) continue;
		out.push({ id: n.replace(/\.json$/, ''), at: rec.at ?? '', message: rec.message });
	}
	return out;
}

/** 删除指定记录（ack）。返回实际删除条数；失败的单个删除不影响其余 */
export async function ackInbox(org: string, agent: string, ids: string[]): Promise<number> {
	if (ids.length === 0) return 0;
	const { unlink } = await import('node:fs/promises');
	const dir = inboxDir(org, agent);
	let n = 0;
	for (const id of ids) {
		try {
			await unlink(path.join(dir, `${id}.json`));
			n += 1;
		} catch {
			/* 已被别人删掉 = 目标状态已达成 */
		}
	}
	return n;
}

/** 一条记录的内容行（简报与补投共用同一渲染，保证"看到的就是待办"） */
export function formatRecordLine(
	rec: InboxRecord,
	maxChars = INBOX_CONTENT_MAX_ITEM_CHARS,
): string {
	const oneLine = rec.message.replace(/\s*\n+\s*/g, ' ⏎ ').trim();
	const body =
		oneLine.length > maxChars ? `${oneLine.slice(0, Math.max(0, maxChars - 1))}…` : oneLine;
	return `- [msg:${rec.id}] ${body}`;
}

/**
 * 内容清单（软上限：条数 + 单条字符）。
 * 超上限时**如实标注还有几条**，不静默丢弃（`D5`：可见性是排障前提）。
 */
export function formatInboxContent(
	records: InboxRecord[],
	opts: { maxItems?: number; maxChars?: number } = {},
): string {
	const maxItems = opts.maxItems ?? INBOX_CONTENT_MAX_ITEMS;
	const maxChars = opts.maxChars ?? INBOX_CONTENT_MAX_ITEM_CHARS;
	const shown = records.slice(0, maxItems);
	const lines = shown.map((r) => formatRecordLine(r, maxChars));
	if (records.length > shown.length) lines.push(`- …另 ${records.length - shown.length} 条`);
	return lines.join('\n');
}

/** 单个成员的计划：本批要注入的（fresh）、只补 ack 的（replay）、事件已见过的（deduped） */
export interface InboxPlanEntry {
	org: string;
	agent: string;
	/** 本批要注入的记录——**已按内容上限裁剪**：注入几条就 ack 几条（`D5`/`D11`） */
	fresh: InboxRecord[];
	/** 注入过但没删掉的残留（只补 ack） */
	replay: InboxRecord[];
	/** 事件 id 已见过的重复投递（不喂模型，只清） */
	deduped: InboxRecord[];
	/** 因内容上限本批不注入、**留在收件箱**待下一批的条数（不清、不丢） */
	deferred: number;
}

/** 多成员的投递计划——**先算后写**：内容先拼好、注入成功后才记账与删除（`D11`） */
export interface InboxPlan {
	entries: InboxPlanEntry[];
	/** 本批要注入的总条数（0 = 无事可做，调用方**不应**触发一轮） */
	total: number;
}

/** 计划：算出每个成员该注入/该清理什么（只读，不写盘） */
export async function planInboxFlush(
	targets: { org: string; agent: string }[],
	opts: { maxItems?: number } = {},
): Promise<InboxPlan> {
	const maxItems = opts.maxItems ?? INBOX_CONTENT_MAX_ITEMS;
	const entries: InboxPlanEntry[] = [];
	for (const { org, agent } of targets) {
		const records = await peekInbox(org, agent);
		if (records.length === 0) continue;
		const state = await readInboxState(org, agent);
		const entry: InboxPlanEntry = {
			org,
			agent,
			fresh: [],
			replay: [],
			deduped: [],
			deferred: 0,
		};
		for (const rec of records) {
			if (state.injected[rec.id]) {
				entry.replay.push(rec); // 注入过但没删掉 → 只补 ack
				continue;
			}
			const evtIds = extractEventIds(rec.message);
			if (evtIds.length > 0 && evtIds.every((e) => state.events[e])) {
				entry.deduped.push(rec); // 同一份完成事件的另一份投递 → 不重复喂模型（`D10`）
				continue;
			}
			entry.fresh.push(rec);
		}
		// ⚠ ack 集合必须与「进入模型上下文的内容」同源（`D5`）：本批只注入前 maxItems 条，
		// 其余**留在收件箱**下一批再报。旧口径「展示前 N 条、ack 全部」会让超限消息从未
		// 进入上下文就被删除（静默丢失）——与 ADR-0054 D5/D11 直接冲突。
		if (entry.fresh.length > maxItems) {
			entry.deferred = entry.fresh.length - maxItems;
			entry.fresh = entry.fresh.slice(0, maxItems);
		}
		entries.push(entry);
	}
	return { entries, total: entries.reduce((n, e) => n + e.fresh.length, 0) };
}

/** 计划的内容清单（多成员时带归属前缀，便于成员分清哪条属于哪个 org） */
export function planContent(plan: InboxPlan, opts: { maxChars?: number } = {}): string {
	const blocks: string[] = [];
	const multi = plan.entries.filter((x) => x.fresh.length > 0).length > 1;
	for (const e of plan.entries) {
		if (e.fresh.length === 0) continue;
		const head = multi ? `[${e.org}/${e.agent}]\n` : '';
		// `fresh` 已按上限裁剪 → 这里必须**全量**渲染（渲染集 = ack 集，`D5`/`D11`）
		const body = formatInboxContent(e.fresh, {
			maxChars: opts.maxChars,
			maxItems: e.fresh.length,
		});
		const tail = e.deferred > 0 ? `\n- …另有 ${e.deferred} 条留在收件箱，下一批继续投递` : '';
		blocks.push(head + body + tail);
	}
	return blocks.join('\n');
}

/** 提交：记账（已注入 + 事件 id）→ ack 删除。**必须在注入成功之后调用**。 */
export async function commitInboxFlush(
	plan: InboxPlan,
): Promise<{ injected: number; acked: number; replayed: number; deduped: number }> {
	const at = nowIso();
	let injected = 0;
	let acked = 0;
	let replayed = 0;
	let deduped = 0;
	for (const e of plan.entries) {
		if (e.fresh.length > 0) {
			const state = await readInboxState(e.org, e.agent);
			for (const r of e.fresh) {
				state.injected[r.id] = at;
				for (const evt of extractEventIds(r.message)) state.events[evt] = at;
			}
			for (const r of e.deduped)
				for (const evt of extractEventIds(r.message)) state.events[evt] = at;
			await writeInboxState(e.org, e.agent, state);
			injected += e.fresh.length;
		}
		acked += await ackInbox(
			e.org,
			e.agent,
			[...e.fresh, ...e.replay, ...e.deduped].map((r) => r.id),
		);
		replayed += e.replay.length;
		deduped += e.deduped.length;
	}
	if (injected > 0 || acked > 0) {
		// D8：留痕字段含 org/member（每条计划项一个目标），便于按成员追「消化了什么」
		log.info('收件箱消化', {
			targets: plan.entries.map((e) => `${e.org}/${e.agent}`),
			injected,
			acked,
			replayed,
			deduped,
		});
	}
	return { injected, acked, replayed, deduped };
}

export interface InboxFlushOptions {
	/** 注入内容（返回 false 表示注入失败 → 不删除任何消息） */
	inject: (content: string) => boolean;
	/** 拼装注入消息（默认在内容前加一行说明） */
	render?: (body: string, count: number) => string;
	reason?: string;
}

export interface InboxFlushResult {
	/** 本次新注入的条数 */
	injected: number;
	/** 本次清掉的条数（含此前已注入的重复项） */
	acked: number;
	/** 因"已注入过"而只做 ack 的条数 */
	replayed: number;
	/** 因"事件 id 已见过"而跳过的条数（`D10`） */
	deduped: number;
	/** 注入失败时为 true（消息保持原样，留下次） */
	failed: boolean;
}

const NOOP_RESULT: InboxFlushResult = {
	injected: 0,
	acked: 0,
	replayed: 0,
	deduped: 0,
	failed: false,
};

/**
 * 单成员消化（`plan` → `inject` → `commit` 的语法糖）。
 *
 * 顺序即语义（`D11`）：任何一步失败都不会丢消息——最坏情况只是下次再注入一次，
 * 而"再注入一次"被 `D7` 的 id 与 `D10` 的事件 id 挡住。
 */
export async function flushInbox(
	org: string,
	agent: string,
	opts: InboxFlushOptions,
): Promise<InboxFlushResult> {
	const plan = await planInboxFlush([{ org, agent }]);
	const entry = plan.entries[0];
	if (!entry) return NOOP_RESULT;

	if (entry.fresh.length > 0) {
		const body = formatInboxContent(entry.fresh, { maxItems: entry.fresh.length });
		const deferredNote =
			entry.deferred > 0 ? `\n（另有 ${entry.deferred} 条留在收件箱，下一批继续投递）` : '';
		const content =
			opts.render?.(body, entry.fresh.length) ??
			`[org] 你有 ${entry.fresh.length} 条待处理消息：\n${body}${deferredNote}`;
		if (!opts.inject(content)) {
			log.warn('收件箱注入失败，消息保留待下次', {
				org,
				agent,
				count: entry.fresh.length,
				reason: opts.reason ?? 'unspecified',
			});
			return { ...NOOP_RESULT, failed: true };
		}
	}
	const committed = await commitInboxFlush(plan);
	return { ...committed, failed: false };
}

/** 收件箱是否有**未注入过**的内容（自愈巡检的判定入口：避免对已注入过的重复项反复触发） */
export async function hasFreshInbox(org: string, agent: string): Promise<boolean> {
	const plan = await planInboxFlush([{ org, agent }]);
	return plan.total > 0;
}
