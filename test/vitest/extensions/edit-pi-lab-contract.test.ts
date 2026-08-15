/**
 * edit → pi-lab 信号契约测试（日志体系）
 *
 * edit 通过 pi-logger 日志静默上报 [pi-lab-signal] 行，由 pi-lab 日志 adapter 采集。
 * 本测试锁定日志信号格式契约 + select 的 ctx 透传（contextKey 分桶用）：
 *
 *   [pi-lab-signal] arm=<armId> metric=<metricId> value=<value> ctx=<ctxKey>
 *
 * 通过 mock globalThis.__labApi 桥接 + mock createLogger 捕获日志 + 真实 edit execute 路径，
 * 验证 edit 上报的信号格式与 pi-lab 的 logExtractor 正则一致。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// mock pi-logger：捕获 log.info 调用（edit 通过 [pi-lab-signal] 日志上报信号）
const { infoSpy, createLoggerMock } = vi.hoisted(() => {
	const infoSpy = vi.fn();
	const noop = vi.fn();
	const createLoggerMock = vi.fn(() => ({
		info: infoSpy,
		debug: noop,
		warn: noop,
		error: noop,
		trace: noop,
	}));
	return { infoSpy, createLoggerMock };
});

vi.mock('@zenone/pi-logger', () => ({
	createLogger: createLoggerMock,
}));

import editExtension from '../../../extensions/accuracy/edit/index.js';
import { logExtractor } from '../../../extensions/meta/pi-lab/core/ingestion.js';

/** 从 log.info 调用中提取 [pi-lab-signal] 信号行 */
function extractSignals(): string[] {
	return infoSpy.mock.calls
		.map((c) => c[0])
		.filter((m) => typeof m === 'string' && m.includes('[pi-lab-signal]')) as string[];
}

describe('edit → pi-lab 日志信号契约', () => {
	let registeredTool: any;
	let sessionStartHandler: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
	let selectSpy: ReturnType<typeof vi.fn>;
	let tmpDir: string;

	beforeEach(() => {
		selectSpy = vi.fn(async () => 'classic');
		infoSpy.mockClear();

		// mock pi-lab 桥接（方案 A 弱依赖）
		(globalThis as any).__labApi = {
			getExperimentManager: () => ({
				registerWeakExperiment: () => ({
					select: selectSpy,
					record: vi.fn(async () => {}),
				}),
			}),
		};

		// mock pi：捕获 session_start 回调和注册的工具
		const pi = {
			on: (event: string, handler: unknown) => {
				if (event === 'session_start') sessionStartHandler = handler as never;
			},
			registerTool: (tool: unknown) => {
				registeredTool = tool;
			},
			registerCommand: () => {},
		} as never;
		editExtension(pi);

		tmpDir = mkdtempSync(join(tmpdir(), 'edit-contract-'));
	});

	afterEach(() => {
		delete (globalThis as any).__labApi;
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it('execute 成功时通过日志上报 match_success=1 与 latency_ms', async () => {
		await sessionStartHandler!({}, {});
		infoSpy.mockClear();

		const file = join(tmpDir, 'a.txt');
		writeFileSync(file, 'hello world', 'utf8');

		await registeredTool.execute(
			'tool-call-1',
			{ path: file, oldText: 'hello world', newText: 'hi' },
			undefined,
			undefined,
			{ cwd: tmpDir },
		);

		// select 被调用（选臂）
		expect(selectSpy).toHaveBeenCalledTimes(1);

		// 日志信号：match_success + latency_ms 两条
		const signals = extractSignals();
		expect(signals).toHaveLength(2);
		const matchSignal = signals.find((s) => s.includes('metric=match_success'))!;
		expect(matchSignal).toContain('arm=classic');
		expect(matchSignal).toContain('value=1');
		expect(signals.some((s) => s.includes('metric=latency_ms'))).toBe(true);
	});

	it('execute 失败时日志上报 match_success=0', async () => {
		await sessionStartHandler!({}, {});
		infoSpy.mockClear();

		// oldText 不匹配 → 抛错 → catch 分支上报失败信号
		await expect(
			registeredTool.execute(
				'tool-call-2',
				{ path: join(tmpDir, 'missing.txt'), oldText: 'nope', newText: 'x' },
				undefined,
				undefined,
				{ cwd: tmpDir },
			),
		).rejects.toThrow();

		const matchSignal = extractSignals().find((s) => s.includes('metric=match_success'))!;
		expect(matchSignal).toContain('value=0');
	});

	it('select 收到完整 ctx（contextKey 分桶用）', async () => {
		await sessionStartHandler!({}, {});

		const ctx = {
			cwd: tmpDir,
			model: { provider: 'anthropic', id: 'claude-sonnet' },
		};
		const file = join(tmpDir, 'c.txt');
		writeFileSync(file, 'x', 'utf8');
		await registeredTool.execute(
			'tool-call-3',
			{ path: file, oldText: 'x', newText: 'y' },
			undefined,
			undefined,
			ctx,
		);

		expect(selectSpy).toHaveBeenCalledTimes(1);
		// select 收到完整 ctx（而非 undefined），contextKey fn 才能提取 model 分桶
		expect(selectSpy.mock.calls[0][0]).toBe(ctx);
	});

	it('pi-lab 不可用时降级（不 select，但日志仍上报）', async () => {
		delete (globalThis as any).__labApi;
		// session_start 里 mgr 为空 → 不注册、labSelect 未赋值
		await sessionStartHandler!({}, {});
		infoSpy.mockClear();

		const file = join(tmpDir, 'd.txt');
		writeFileSync(file, 'hello', 'utf8');
		await registeredTool.execute(
			'tool-call-4',
			{ path: file, oldText: 'hello', newText: 'bye' },
			undefined,
			undefined,
			{ cwd: tmpDir },
		);

		// 不 select（无 pi-lab）
		expect(selectSpy).not.toHaveBeenCalled();
		// 日志仍上报（信号无人采集，但 edit 不因此失败）
		expect(extractSignals().length).toBeGreaterThanOrEqual(1);
	});

	it('注册被阻断（registerWeakExperiment 返回 undefined）时降级到无实验模式', async () => {
		// 覆盖 mock：异 owner 撞名 → 注册被阻断，返回 undefined
		(globalThis as any).__labApi = {
			getExperimentManager: () => ({
				registerWeakExperiment: () => undefined,
			}),
		};
		await sessionStartHandler!({}, {});
		infoSpy.mockClear();

		const file = join(tmpDir, 'e.txt');
		writeFileSync(file, 'hello', 'utf8');
		await registeredTool.execute(
			'tool-call-blocked',
			{ path: file, oldText: 'hello', newText: 'bye' },
			undefined,
			undefined,
			{ cwd: tmpDir },
		);

		// 不 select（注册被阻断，labSelect 未赋值）
		expect(selectSpy).not.toHaveBeenCalled();
		// 日志仍上报（信号无人采集，但 edit 不因此失败）
		expect(extractSignals().length).toBeGreaterThanOrEqual(1);
	});

	it('上报信号可被 pi-lab logExtractor 完整解析（契约 round-trip）', async () => {
		await sessionStartHandler!({}, {});
		infoSpy.mockClear();

		const ctx = {
			cwd: tmpDir,
			model: { provider: 'anthropic', id: 'claude-sonnet' },
		};
		const file = join(tmpDir, 'roundtrip.txt');
		writeFileSync(file, 'hello', 'utf8');
		await registeredTool.execute(
			'tool-call-rt',
			{ path: file, oldText: 'hello', newText: 'hi' },
			undefined,
			undefined,
			ctx,
		);

		// edit 上报的 [pi-lab-signal] 日志行必须能被 pi-lab 的 logExtractor 正则完整解析
		// （若 reportSignal 格式与 logExtractor 正则漂移，此 round-trip 会直接失败）
		const events = logExtractor(extractSignals());

		const matchEvt = events.find((e) => 'match_success' in e.metrics)!;
		expect(matchEvt.armId).toBe('classic');
		expect(matchEvt.ctxKey).toBe('anthropic:claude-sonnet');
		expect(matchEvt.metrics.match_success).toBe(1);

		const latencyEvt = events.find((e) => 'latency_ms' in e.metrics)!;
		expect(latencyEvt.armId).toBe('classic');
		expect(latencyEvt.ctxKey).toBe('anthropic:claude-sonnet');
		expect(typeof latencyEvt.metrics.latency_ms).toBe('number');
	});
});
