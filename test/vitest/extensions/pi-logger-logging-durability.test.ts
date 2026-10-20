/**
 * pi-logger — 日志「不丢」的三条路径（回归测试）
 *
 * 背景（三条路径都曾静默丢日志，见 PR/commit 说明）：
 *   1. **无事件总线**（vitest 单测、pi-logger 未加载、启动早期）：事件只进内存缓冲，
 *      若始终没有 bus 出现 → 日志永远不落盘，单测里完全看不到扩展日志。
 *   2. **启动期缓冲的投递时机**：调用方惯例是「先 initEventBus() 再 .on() 订阅」，
 *      同步 flush 会在订阅建立前把缓冲投进无人监听的总线 → 整段启动日志丢失。
 *   3. **进程退出**：handler 是 `void handleLogEvent(event)` 火忘式，异步 appendFile
 *      在 `process.exit()`（pi print 模式收尾 / harness 清理 / 异常退出）时被丢弃。
 *
 * 本文件对每条路径各给一个能变红的断言（改前全红、改后全绿）。
 * 日志目录经 cwd 解析到临时沙箱（`loadConfiguration(process.cwd())`），不污染真实日志。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, initEventBus } from '../../../extensions/meta/pi-logger/api.js';
import { writeFileLog } from '../../../extensions/meta/pi-logger/appenders/file-appender.js';
import { getRuntimeConfig, loadConfiguration } from '../../../extensions/meta/pi-logger/config.js';
import { LOG_EVENT_CHANNEL } from '../../../extensions/meta/pi-logger/types.js';

const origCwd = process.cwd();
let sandbox: string;

beforeAll(() => {
	sandbox = mkdtempSync(join(tmpdir(), 'pi-logger-durability-'));
	// ⚠️ 必须在任何日志调用之前 chdir：无 bus 兜底按 cwd 解析一次日志目录
	process.chdir(sandbox);
	// 显式按沙箱 cwd 解析配置，让断言与「写哪个目录」都确定（不依赖用例顺序）
	loadConfiguration(sandbox);
});

afterAll(() => {
	process.chdir(origCwd);
	rmSync(sandbox, { recursive: true, force: true });
});

/** 读取沙箱内指定 source 的日志内容（尚未出现则为空串） */
function readLog(source: string): string {
	const dir = join(sandbox, '.pi', 'logs');
	if (!existsSync(dir)) return '';
	return readdirSync(dir)
		.filter((f) => f.startsWith(source))
		.map((f) => readFileSync(join(dir, f), 'utf-8'))
		.join('');
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
	const t0 = Date.now();
	while (!pred() && Date.now() - t0 < timeoutMs) {
		await new Promise((r) => setTimeout(r, 10));
	}
}

describe('pi-logger 日志不丢', () => {
	it('无事件总线（单测场景）时日志仍然落盘', async () => {
		// 清掉可能残留的总线，强制走「无 bus」路径（与用例顺序解耦）
		delete (globalThis as Record<string, unknown>).__pi_logger_eventbus__;

		createLogger('probe-solo').info('solo-marker-line');

		await waitFor(() => readLog('probe-solo').includes('solo-marker-line'));
		const content = readLog('probe-solo');
		expect(content).toContain('solo-marker-line');
		expect(content).toContain('INFO');
		expect(content).toContain('probe-solo');
	});

	it('writeFileLog 返回时该行已在盘上（进程随后退出也不丢）', () => {
		// 直接断言「持久性」这一根因属性：调用返回时行已落盘 ⇒ `process.exit()`
		// 无法再丢掉它。改前 writeFileLog 内部 `await appendFile`，调用返回时文件里
		// 什么都没有（下一行断言必红）；改后同步写，断言立即通过。
		// 这比「起个子进程 log 后 exit」更强也更确定（不依赖跨进程模块解析）。
		const cfg = getRuntimeConfig();
		// 刻意不 await：复刻 index.ts 的 `void handleLogEvent(event)` 火忘式调用
		void writeFileLog(
			{
				level: 'info',
				source: 'probe-sync',
				message: 'sync-marker-line',
				timestamp: Date.now(),
			},
			cfg,
		);
		expect(readLog('probe-sync')).toContain('sync-marker-line');
	});

	it('initEventBus 之后建立的订阅仍收到启动期缓冲日志', async () => {
		// 构造 stale bus：emit 抛「stale after session replacement」，事件进缓冲
		//（这是修复后唯一仍会走缓冲的路径）
		const staleBus = {
			emit() {
				throw new Error('This extension ctx is stale after session replacement or reload');
			},
		};
		initEventBus(staleBus as never);
		createLogger('probe-buffer').info('buffered-marker-line');

		// 复刻 index.ts 的工厂顺序：先 initEventBus(新 bus)，再 .on 订阅
		const live = new EventEmitter();
		const seen: string[] = [];
		initEventBus(live as never);
		live.on(LOG_EVENT_CHANNEL, (e: { message: string }) => seen.push(e.message));

		await waitFor(() => seen.includes('buffered-marker-line'));
		expect(seen).toContain('buffered-marker-line');
	});
});
