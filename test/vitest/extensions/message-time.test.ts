/**
 * message-time — Vitest 组件测试
 *
 * 覆盖（不需要真实 Pi runtime）：
 *   - fmtTime 三段式（今日 / 同年非今日 / 跨年）
 *   - user 提交时刻注记
 *   - assistant 实时注记（首 token = 首个 message_update）
 *   - mock 预构造消息的 timestamp 钳制（回复不早于提问）
 *   - 回放路径（session_start 预载历史条目）
 *   - 幂等、非目标 messageType、未命中指纹不改写
 */
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@zenone/pi-logger', () => ({
	createLogger: () => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

// ── 测试脚手架 ─────────────────────────────────────────────────────────────

type Handler = (event: unknown, ctx?: unknown) => unknown;
type Transformer = (markdown: string, ctx: { messageType: string; isStreaming: boolean }) => string;

interface Harness {
	emit(event: string, payload: unknown, ctx?: unknown): Promise<void>;
	transform(markdown: string, messageType?: string, isStreaming?: boolean): string;
}

/** 每次动态 import 拿到全新模块实例，避免 module 级指纹表跨用例污染 */
async function loadHarness(): Promise<{ h: Harness; fmtTime: (ms: number, now?: Date) => string }> {
	vi.resetModules();
	const mod = await import('../../../extensions/tui/message-time');
	const handlers = new Map<string, Handler[]>();
	let transformer!: Transformer;
	const pi = {
		on: vi.fn((event: string, handler: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		}),
		registerMarkdownTransformer: vi.fn((t: Transformer) => {
			transformer = t;
		}),
	} as unknown as ExtensionAPI;
	mod.default(pi);
	return {
		fmtTime: mod.fmtTime,
		h: {
			async emit(event, payload, ctx) {
				for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
			},
			transform(markdown, messageType = 'assistant', isStreaming = false) {
				return transformer(markdown, { messageType, isStreaming });
			},
		},
	};
}

const pad = (n: number) => String(n).padStart(2, '0');
/** 与实现解耦地独立算出「本地 HH:MM:SS」 */
function localHms(ms: number): string {
	const d = new Date(ms);
	return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 当前年份下保证「同年且非今日」的一个日期（1/1 用 1/2 兜底） */
function sameYearNotToday(now: Date): string {
	const y = now.getFullYear();
	return now.getMonth() === 0 && now.getDate() === 1 ? `${y}-01-02` : `${y}-01-01`;
}

function userStart(ts: number, text: string) {
	return { message: { role: 'user', timestamp: ts, content: [{ type: 'text', text }] } };
}
function assistantStart(ts: number) {
	return { message: { role: 'assistant', timestamp: ts, content: [] } };
}
function assistantUpdate(ts: number, text: string) {
	return { message: { role: 'assistant', timestamp: ts, content: [{ type: 'text', text }] } };
}

// ── fmtTime 三段式 ─────────────────────────────────────────────────────────

describe('fmtTime 三段式', () => {
	it('今日 → HH:MM:SS', async () => {
		const { fmtTime } = await loadHarness();
		const now = new Date(2026, 8, 10, 20, 0, 0);
		expect(fmtTime(new Date(2026, 8, 10, 14, 23, 5).getTime(), now)).toBe('14:23:05');
	});

	it('同年非今日 → MM-DD HH:MM:SS', async () => {
		const { fmtTime } = await loadHarness();
		const now = new Date(2026, 8, 10, 20, 0, 0);
		expect(fmtTime(new Date(2026, 8, 8, 14, 23, 5).getTime(), now)).toBe('09-08 14:23:05');
	});

	it('跨年 → YYYY-MM-DD HH:MM:SS', async () => {
		const { fmtTime } = await loadHarness();
		const now = new Date(2026, 8, 10, 20, 0, 0);
		expect(fmtTime(new Date(2025, 11, 31, 23, 59, 5).getTime(), now)).toBe(
			'2025-12-31 23:59:05',
		);
	});

	it('个位数月/日/时分秒补零', async () => {
		const { fmtTime } = await loadHarness();
		const now = new Date(2026, 8, 10, 20, 0, 0);
		expect(fmtTime(new Date(2026, 0, 2, 3, 4, 5).getTime(), now)).toBe('01-02 03:04:05');
	});
});

// ── 实时路径 ───────────────────────────────────────────────────────────────

describe('实时注入', () => {
	it('user 消息显示提交时刻', async () => {
		const { h } = await loadHarness();
		const ts = Date.now();
		await h.emit('message_start', userStart(ts, '上午好'));
		expect(h.transform('上午好', 'user')).toBe(`[${localHms(ts)}]\n\n上午好`);
	});

	it('assistant 显示首个 message_update 时刻（非 message_start 的调用发起时刻）', async () => {
		const { h } = await loadHarness();
		const callStart = Date.now();
		const firstToken = callStart + 1200;
		await h.emit('message_start', userStart(callStart - 100, '问题'));
		await h.emit('message_start', assistantStart(callStart));
		await h.emit('message_update', assistantUpdate(firstToken, '答案'));
		expect(h.transform('答案', 'assistant', true)).toBe(`[${localHms(firstToken)}]\n\n答案`);
	});

	it('首 token 前的流式片段走活跃回复兜底（显示首 token 时刻，非片段时刻）', async () => {
		const { h } = await loadHarness();
		const callStart = Date.now();
		const firstToken = callStart + 800;
		await h.emit('message_start', userStart(callStart - 100, '问题'));
		await h.emit('message_start', assistantStart(callStart));
		await h.emit('message_update', assistantUpdate(firstToken, '答'));
		// 更晚的片段尚未注册进指纹表 → 走兜底，仍应显示首 token 时刻
		expect(h.transform('答', 'assistant', true)).toBe(`[${localHms(firstToken)}]\n\n答`);
	});

	it('钳制：assistant 的 timestamp 早于提问（mock 预构造假象）时不为早于提问的值', async () => {
		const { h } = await loadHarness();
		const userTs = Date.now();
		const stale = userTs - 60_000; // mock-llm 预构造消息的 timestamp（≈加载时刻）
		await h.emit('message_start', userStart(userTs, '问题2'));
		await h.emit('message_start', assistantStart(stale));
		await h.emit('message_update', assistantUpdate(stale, '答案2'));
		expect(h.transform('答案2', 'assistant', true)).toBe(`[${localHms(userTs)}]\n\n答案2`);
	});

	it('message_end 定稿后仍可命中（非流式重绘）', async () => {
		const { h } = await loadHarness();
		const ts = Date.now();
		await h.emit('message_start', userStart(ts - 500, '问题3'));
		await h.emit('message_start', assistantStart(ts));
		await h.emit('message_end', assistantUpdate(ts, '答案3'));
		expect(h.transform('答案3', 'assistant', false)).toBe(`[${localHms(ts)}]\n\n答案3`);
	});
});

// ── 回放路径 ───────────────────────────────────────────────────────────────

describe('回放（session_start 预载）', () => {
	it('历史条目 → 按各自 message.timestamp 注记', async () => {
		const { h } = await loadHarness();
		const userTs = new Date(2026, 8, 8, 14, 23, 5).getTime();
		const assistantTs = new Date(2026, 8, 8, 14, 23, 9).getTime();
		const ctx = {
			sessionManager: {
				getEntries: () => [
					{
						type: 'message',
						message: {
							role: 'user',
							timestamp: userTs,
							content: [{ type: 'text', text: '历史提问' }],
						},
					},
					{
						type: 'message',
						message: {
							role: 'assistant',
							timestamp: assistantTs,
							content: [{ type: 'text', text: '历史回答' }],
						},
					},
				],
			},
		} as unknown as ExtensionContext;
		await h.emit('session_start', { type: 'session_start' }, ctx);
		expect(h.transform('历史提问', 'user')).toBe('[09-08 14:23:05]\n\n历史提问');
		expect(h.transform('历史回答', 'assistant')).toBe('[09-08 14:23:09]\n\n历史回答');
	});

	it('跨年 / 非今日历史条目 → 带日期形态', async () => {
		const { h } = await loadHarness();
		const now = new Date();
		const crossYear = new Date(now.getFullYear() - 1, 11, 31, 23, 59, 5).getTime();
		const sameYear = new Date(now.getFullYear(), 0, 1, 8, 30, 0).getTime();
		const expectedCross = `${now.getFullYear() - 1}-12-31 23:59:05`;
		const expectedSame = `${sameYearNotToday(now).slice(5)} 08:30:00`;
		const ctx = {
			sessionManager: {
				getEntries: () => [
					{
						type: 'message',
						message: {
							role: 'user',
							timestamp: crossYear,
							content: [{ type: 'text', text: '去年提问' }],
						},
					},
					{
						type: 'message',
						message: {
							role: 'assistant',
							timestamp: sameYear,
							content: [{ type: 'text', text: '今年回答' }],
						},
					},
				],
			},
		} as unknown as ExtensionContext;
		await h.emit('session_start', { type: 'session_start' }, ctx);
		expect(h.transform('去年提问', 'user')).toBe(`[${expectedCross}]\n\n去年提问`);
		expect(h.transform('今年回答', 'assistant')).toBe(`[${expectedSame}]\n\n今年回答`);
	});

	it('预载失败时不抛错，仅不注记', async () => {
		const { h } = await loadHarness();
		const ctx = {
			sessionManager: {
				getEntries: () => {
					throw new Error('boom');
				},
			},
		} as unknown as ExtensionContext;
		await expect(
			h.emit('session_start', { type: 'session_start' }, ctx),
		).resolves.toBeUndefined();
		expect(h.transform('任意文本', 'user')).toBe('任意文本');
	});
});

// ── 边界 ───────────────────────────────────────────────────────────────────

describe('边界与幂等', () => {
	it('幂等：已注入的时间行不被二次注入（三种形态均识别）', async () => {
		const { h } = await loadHarness();
		const ts = Date.now();
		await h.emit('message_start', userStart(ts, '文本'));
		const once = h.transform('文本', 'user');
		expect(h.transform(once, 'user')).toBe(once);
		expect(h.transform('[09-08 14:23:05]\n\n历史提问', 'user')).toBe(
			'[09-08 14:23:05]\n\n历史提问',
		);
		expect(h.transform('[2025-12-31 23:59:05]\n\n去年提问', 'user')).toBe(
			'[2025-12-31 23:59:05]\n\n去年提问',
		);
	});

	it('非目标 messageType（assistant-thinking）不改写', async () => {
		const { h } = await loadHarness();
		const ts = Date.now();
		await h.emit('message_start', userStart(ts, '文本4'));
		expect(h.transform('文本4', 'assistant-thinking')).toBe('文本4');
	});

	it('未命中指纹的文本不改写（如 compaction summary 文本）', async () => {
		const { h } = await loadHarness();
		expect(h.transform('无关文本', 'user')).toBe('无关文本');
	});

	it('空文本不改写', async () => {
		const { h } = await loadHarness();
		const ts = Date.now();
		await h.emit('message_start', userStart(ts, '文本5'));
		expect(h.transform('   ', 'user')).toBe('   ');
	});

	it('旧一轮提问的文本在下一轮 assistant 前被新提问覆盖（指纹取最近）', async () => {
		const { h } = await loadHarness();
		const first = Date.now();
		await h.emit('message_start', userStart(first, '同一个问题'));
		const second = first + 5000;
		await h.emit('message_start', userStart(second, '同一个问题'));
		expect(h.transform('同一个问题', 'user')).toBe(`[${localHms(second)}]\n\n同一个问题`);
	});
});
