/**
 * 成员动态的拉取与降级（ADR-0052 `D1`/`D2`/`D5`/`D8`）
 *
 * 这里锁住两件事：
 * 1. **纯函数口径**：载荷解析（认不得的形状跳过）、列表"最近一句话"的取舍、详情行纯文本形态；
 * 2. **降级**：成功 / 成员不支持（旧版） / 超时 / 通道不可达 四条路径都返回"可展示的结果"，
 *    绝不抛错——观测失败不得升级为状态或动作。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	ACTIVITY_FAIL_TEXT,
	WarnOnce,
	clockOf,
	fetchActivity,
	formatActivityLine,
	interruptMember,
	oneLine,
	parseEntries,
	summariseForList,
	type ActivityEntry,
} from '../../../extensions/auto/org/activity.js';

const dirs: string[] = [];
const servers: net.Server[] = [];

afterEach(async () => {
	for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tmpDir(): Promise<string> {
	const d = await mkdtemp(join(tmpdir(), 'org-activity-'));
	dirs.push(d);
	return d;
}

/** 假 control：按 mode 回应（ok / fail / silent）——silent 用于制造超时 */
async function fakeControl(
	sockPath: string,
	opts: { mode: 'ok' | 'fail' | 'silent'; entries?: unknown[] },
): Promise<void> {
	const server = net.createServer((socket) => {
		socket.on('data', (chunk: Buffer) => {
			if (opts.mode === 'silent') return;
			for (const line of chunk.toString('utf8').split('\n')) {
				if (!line.trim()) continue;
				const msg = JSON.parse(line) as { type: string };
				socket.write(
					`${JSON.stringify({
						type: 'response',
						command: msg.type,
						success: opts.mode === 'ok',
						...(opts.mode === 'ok'
							? { data: { entries: opts.entries ?? [] } }
							: { error: 'Unknown command' }),
					})}\n`,
				);
			}
		});
	});
	servers.push(server);
	await new Promise<void>((r) => server.listen(sockPath, () => r()));
}

const entry = (over: Partial<ActivityEntry>): ActivityEntry => ({
	role: 'assistant',
	kind: 'text',
	text: 'x',
	...over,
});

describe('parseEntries', () => {
	it('认得的形状原样保留', () => {
		const out = parseEntries({
			entries: [
				{ role: 'assistant', kind: 'text', text: 'hi', timestamp: 5 },
				{ role: 'assistant', kind: 'toolCall', text: '{}', toolName: 'edit', path: 'a.ts' },
				{ role: 'tool', kind: 'toolResult', text: 'ok', toolName: 'edit', diff: '@@' },
			],
		});
		expect(out.map((e) => e.kind)).toEqual(['text', 'toolCall', 'toolResult']);
		expect(out[2].diff).toBe('@@');
	});

	it('认不得的形状跳过（不抛错）', () => {
		expect(parseEntries(undefined)).toEqual([]);
		expect(parseEntries({})).toEqual([]);
		expect(parseEntries({ entries: 'nope' })).toEqual([]);
		expect(
			parseEntries({
				entries: [
					null,
					42,
					{ role: 'assistant', kind: 'text' }, // 缺 text
					{ role: 'nobody', kind: 'text', text: 'x' },
					{ role: 'assistant', kind: 'thinking', text: 'x' },
				],
			}),
		).toEqual([]);
	});
});

describe('summariseForList', () => {
	it('优先最近一条 assistant 文本（成员自己的话最能说明在干啥）', () => {
		const out = summariseForList([
			entry({ text: '旧的' }),
			entry({ kind: 'toolCall', toolName: 'bash', text: '{}' }),
			entry({ text: '正在改 applyTools' }),
		]);
		expect(out?.text).toBe('正在改 applyTools');
	});

	it('没有 assistant 文本时退回最近一条事件', () => {
		const out = summariseForList([
			entry({ kind: 'toolCall', toolName: 'edit', path: 'src/a.ts', text: '{}' }),
		]);
		expect(out?.text).toContain('[tool] edit src/a.ts');
	});

	it('空 → null（看板显示"（无动态）"）', () => {
		expect(summariseForList([])).toBeNull();
	});
});

describe('formatActivityLine（纯文本，ADR-0023 字符白名单）', () => {
	it('工具调用 → 工具名 + 路径', () => {
		const line = formatActivityLine(
			entry({
				kind: 'toolCall',
				toolName: 'edit',
				path: 'src/a.ts',
				text: '{"path":"src/a.ts"}',
			}),
		);
		expect(line).toBe('[tool] edit src/a.ts');
	});

	it('工具结果 → ok / fail 标记（不用图标）', () => {
		expect(
			formatActivityLine(
				entry({ role: 'tool', kind: 'toolResult', toolName: 'bash', text: 'done' }),
			),
		).toBe('[res] bash ok done');
		expect(
			formatActivityLine(
				entry({
					role: 'tool',
					kind: 'toolResult',
					toolName: 'bash',
					text: 'boom',
					isError: true,
				}),
			),
		).toBe('[res] bash fail boom');
	});

	it('错误 / 收到的指令 各自的标记', () => {
		expect(formatActivityLine(entry({ kind: 'error', text: 'rate limited' }))).toBe(
			'[err] rate limited',
		);
		expect(formatActivityLine(entry({ role: 'user', kind: 'text', text: '修这个 bug' }))).toBe(
			'[in] 修这个 bug',
		);
	});

	it('带时间戳时前缀 HH:MM', () => {
		const ts = new Date(2026, 8, 14, 14, 32).getTime();
		expect(formatActivityLine(entry({ text: '在跑测试', timestamp: ts }))).toBe(
			'14:32 在跑测试',
		);
	});

	it('多行文本压成一行', () => {
		expect(formatActivityLine(entry({ text: '第一行\n\n第二行' }))).toBe('第一行 第二行');
	});
});

describe('oneLine / clockOf', () => {
	it('折叠空白并截断（带省略号）', () => {
		expect(oneLine('  a\n b  ')).toBe('a b');
		expect(oneLine('x'.repeat(50), 10)).toHaveLength(10);
		expect(oneLine('x'.repeat(50), 10).endsWith('…')).toBe(true);
	});

	it('clockOf 补零', () => {
		expect(clockOf(new Date(2026, 0, 2, 3, 4).getTime())).toBe('03:04');
		expect(clockOf(new Date(2026, 0, 2, 13, 45).getTime())).toBe('13:45');
	});
});

describe('WarnOnce（每成员只留痕一次，成功后重置）', () => {
	it('同一 key 只放行一次；forget 后可再次放行', () => {
		const w = new WarnOnce();
		expect(w.shouldWarn('a')).toBe(true);
		expect(w.shouldWarn('a')).toBe(false);
		expect(w.shouldWarn('b')).toBe(true);
		w.forget('a');
		expect(w.shouldWarn('a')).toBe(true);
	});
});

describe('fetchActivity（四条路径都不抛错）', () => {
	it('成功：返回事件行', async () => {
		const d = await tmpDir();
		const sock = join(d, 'c.sock');
		await fakeControl(sock, {
			mode: 'ok',
			entries: [{ role: 'assistant', kind: 'text', text: 'hi' }],
		});
		const res = await fetchActivity(sock, 1);
		expect(res).toEqual({ ok: true, entries: [expect.objectContaining({ text: 'hi' })] });
	});

	it('成员不支持（旧版 control 回 success:false）→ unsupported', async () => {
		const d = await tmpDir();
		const sock = join(d, 'c.sock');
		await fakeControl(sock, { mode: 'fail' });
		const res = await fetchActivity(sock, 1);
		expect(res).toEqual({ ok: false, reason: 'unsupported' });
	});

	it('成员收下但不回（旧版无该分支 / 卡住）→ timeout', async () => {
		const d = await tmpDir();
		const sock = join(d, 'c.sock');
		await fakeControl(sock, { mode: 'silent' });
		const res = await fetchActivity(sock, 1, 80);
		expect(res).toEqual({ ok: false, reason: 'timeout' });
	});

	it('通道不可达 → unreachable', async () => {
		const d = await tmpDir();
		const res = await fetchActivity(join(d, 'missing.sock'), 1, 80);
		expect(res).toEqual({ ok: false, reason: 'unreachable' });
	});

	it('每种失败都有可展示的中文短句（看板与工具共用）', () => {
		expect(Object.keys(ACTIVITY_FAIL_TEXT).sort()).toEqual([
			'timeout',
			'unreachable',
			'unsupported',
		]);
		expect(ACTIVITY_FAIL_TEXT.timeout).toContain('无响应');
	});
});

describe('interruptMember（中断当前轮；ADR-0053）', () => {
	it('成功 → ok', async () => {
		const d = await tmpDir();
		const sock = join(d, 'c.sock');
		await fakeControl(sock, { mode: 'ok' });
		expect(await interruptMember(sock, 80)).toEqual({ ok: true, entries: [] });
	});

	it('旧版 control（不认 abort）→ unsupported', async () => {
		const d = await tmpDir();
		const sock = join(d, 'c.sock');
		await fakeControl(sock, { mode: 'fail' });
		expect(await interruptMember(sock, 80)).toEqual({ ok: false, reason: 'unsupported' });
	});

	it('不可达 → unreachable（绝不假装成功）', async () => {
		const d = await tmpDir();
		expect(await interruptMember(join(d, 'missing.sock'), 80)).toEqual({
			ok: false,
			reason: 'unreachable',
		});
	});
});
