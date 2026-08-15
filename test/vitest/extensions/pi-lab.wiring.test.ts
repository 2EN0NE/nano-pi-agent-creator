/**
 * pi-lab extension 运行时接线测试（index.ts 工厂）
 *
 * 覆盖（对应「日志信号主链路」与「turn_end TAG 采集」两条运行时接线）：
 *   1. session_start 订阅 pi.events 'log'，[pi-lab-signal] 日志行 → ingestLogSignal → ingest('pi-log')
 *   2. turn_end 经 createSessionTreeWithPi → extractLabels → ingest('session-tree-tag')，事件真正落盘
 *   3. session_shutdown 反注册 log 监听（/reload 防重复订阅）
 *
 * 与 pi-lab.core.test.ts 的区别：那里测纯函数/类，这里测 index.ts 工厂的事件接线本身。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

// ── mock 依赖（保留真实 manager + ingestion，只 mock 外围）──

const { createSessionTreeWithPi } = vi.hoisted(() => ({
	createSessionTreeWithPi: vi.fn(),
}));

vi.mock('@zenone/pi-session-tree', () => ({ createSessionTreeWithPi }));

vi.mock('@zenone/pi-logger', () => ({
	createLogger: () => ({
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		trace: vi.fn(),
	}),
}));

vi.mock('../../../extensions/meta/pi-lab/ui/panel.js', () => ({
	showPanel: vi.fn(),
}));

import piLabExtension from '../../../extensions/meta/pi-lab/index.js';
import { getExperimentManager } from '../../../extensions/meta/pi-lab/core/manager.js';

// ── HOME 隔离 ──

const ORIGINAL_HOME = process.env.HOME;
let tmpHome: string;

function setupTempHome(): void {
	tmpHome = resolve(tmpdir(), `pi-lab-wiring-${randomUUID()}`);
	mkdirSync(resolve(tmpHome, '.pi', 'agent', 'extensions-data', 'pi-lab'), {
		recursive: true,
	});
	process.env.HOME = tmpHome;
}

function cleanupTempHome(): void {
	process.env.HOME = ORIGINAL_HOME;
	try {
		rmSync(tmpHome, { recursive: true, force: true });
	} catch {
		// ignore
	}
}

// ── mock pi：捕获事件处理器与 events 'log' 订阅 ──

interface MockPi {
	handlers: Map<string, (event: unknown, ctx: unknown) => unknown>;
	logHandlers: Array<(data: unknown) => void>;
	unsubscribe: ReturnType<typeof vi.fn>;
}

function makeMockPi(): MockPi {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const logHandlers: Array<(data: unknown) => void> = [];
	const unsubscribe = vi.fn();
	const pi = {
		on: (event: string, handler: (e: unknown, ctx: unknown) => unknown) => {
			handlers.set(event, handler);
		},
		registerCommand: vi.fn(),
		events: {
			on: (channel: string, handler: (data: unknown) => void) => {
				expect(channel).toBe('log');
				logHandlers.push(handler);
				return unsubscribe;
			},
		},
	} as never;
	return { handlers, logHandlers, unsubscribe, pi: pi as never };
}

function makeSessionCtx(overrides: Record<string, unknown> = {}): unknown {
	return {
		ui: { setStatus: vi.fn() },
		hasUI: false,
		sessionManager: {},
		...overrides,
	};
}

describe('pi-lab 运行时接线', () => {
	beforeEach(() => {
		setupTempHome();
		createSessionTreeWithPi.mockReset();
	});

	afterEach(() => {
		delete (globalThis as any).__labApi;
		cleanupTempHome();
	});

	it('session_start 订阅 log 信号，[pi-lab-signal] 行被 ingest 到实验', async () => {
		const mock = makeMockPi();
		piLabExtension(mock.pi as never);

		// 触发 session_start 以建立 log 订阅
		await mock.handlers.get('session_start')!({}, makeSessionCtx());

		// 注册一个真实实验
		getExperimentManager().registerExperiment({
			owner: 'test',
			name: 'wiring-log',
			contextKey: () => 'global',
			arms: [{ id: 'classic', label: 'Classic' }],
			metrics: [{ id: 'match_success', type: 'binary', direction: 'maximize' }],
		});

		// 模拟 pi-logger 发出的 [pi-lab-signal] 日志事件
		mock.logHandlers.forEach((h) =>
			h({ message: '[pi-lab-signal] arm=classic metric=match_success value=1 ctx=global' }),
		);

		// ingestLogSignal 是 async（void），等待其完成
		await vi.waitFor(() => {
			const exp = getExperimentManager().getExperimentRaw('wiring-log')!;
			expect(exp.getEvents()).toHaveLength(1);
			expect(exp.getEvents()[0].metrics).toEqual({ match_success: 1 });
		});
	});

	it('非 [pi-lab-signal] 日志行被忽略', async () => {
		const mock = makeMockPi();
		piLabExtension(mock.pi as never);
		await mock.handlers.get('session_start')!({}, makeSessionCtx());

		getExperimentManager().registerExperiment({
			owner: 'test',
			name: 'wiring-log-ignore',
			contextKey: () => 'global',
			arms: [{ id: 'classic', label: 'Classic' }],
			metrics: [{ id: 'match_success', type: 'binary', direction: 'maximize' }],
		});

		mock.logHandlers.forEach((h) => h({ message: '普通日志，无信号' }));

		// 给异步一个稳定机会：直接断言无事件（无信号行不该触发 ingest）
		const exp = getExperimentManager().getExperimentRaw('wiring-log-ignore')!;
		expect(exp.getEvents()).toHaveLength(0);
	});

	it('turn_end 经 createSessionTreeWithPi → extractLabels → ingest TAG 事件', async () => {
		const mock = makeMockPi();
		piLabExtension(mock.pi as never);
		await mock.handlers.get('session_start')!({}, makeSessionCtx());

		getExperimentManager().registerExperiment({
			owner: 'test',
			name: 'wiring-tag',
			contextKey: () => 'global',
			arms: [{ id: 'a', label: 'A' }],
			metrics: [{ id: 'match_success', type: 'binary', direction: 'maximize' }],
		});

		// mock 会话树返回带 label 的节点
		createSessionTreeWithPi.mockReturnValue({
			extractLabels: () => [{ label: 'a:match_success:1', targetId: 'n1' }],
		});

		await mock.handlers.get('turn_end')!({}, makeSessionCtx());

		const exp = getExperimentManager().getExperimentRaw('wiring-tag')!;
		expect(exp.getEvents()).toHaveLength(1);
		expect(exp.getEvents()[0].armId).toBe('a');
		expect(exp.getEvents()[0].metrics).toEqual({ match_success: 1 });
	});

	it('同一 targetId 跨 turn_end 只摄入一次（TAG 幂等去重）', async () => {
		const mock = makeMockPi();
		piLabExtension(mock.pi as never);
		await mock.handlers.get('session_start')!({}, makeSessionCtx());

		getExperimentManager().registerExperiment({
			owner: 'test',
			name: 'wiring-tag-dedup',
			contextKey: () => 'global',
			arms: [{ id: 'a', label: 'A' }],
			metrics: [{ id: 'match_success', type: 'binary', direction: 'maximize' }],
		});

		// extractLabels 每次返回同一节点（模拟会话树历史 TAG 跨 turn 反复读取）
		createSessionTreeWithPi.mockReturnValue({
			extractLabels: () => [{ label: 'a:match_success:1', targetId: 'n1' }],
		});

		// 连续两次 turn_end：第二次同一 targetId 应被幂等去重，事件数保持 1
		await mock.handlers.get('turn_end')!({}, makeSessionCtx());
		await mock.handlers.get('turn_end')!({}, makeSessionCtx());

		const exp = getExperimentManager().getExperimentRaw('wiring-tag-dedup')!;
		expect(exp.getEvents()).toHaveLength(1);
		expect(exp.getEvents()[0].dedupKey).toBe('tag:n1:a:match_success:1');
	});

	it('turn_end 无 label 时不 ingest（labels 为空提前返回）', async () => {
		const mock = makeMockPi();
		piLabExtension(mock.pi as never);
		await mock.handlers.get('session_start')!({}, makeSessionCtx());

		getExperimentManager().registerExperiment({
			owner: 'test',
			name: 'wiring-tag-empty',
			contextKey: () => 'global',
			arms: [{ id: 'a', label: 'A' }],
			metrics: [{ id: 'match_success', type: 'binary', direction: 'maximize' }],
		});

		createSessionTreeWithPi.mockReturnValue({ extractLabels: () => [] });

		await mock.handlers.get('turn_end')!({}, makeSessionCtx());

		expect(
			getExperimentManager().getExperimentRaw('wiring-tag-empty')!.getEvents(),
		).toHaveLength(0);
	});

	it('session_shutdown 反注册 log 监听（/reload 防重复订阅）', async () => {
		const mock = makeMockPi();
		piLabExtension(mock.pi as never);
		await mock.handlers.get('session_start')!({}, makeSessionCtx());

		// session_start 时建立订阅并保存 unsubscribe
		expect(mock.logHandlers).toHaveLength(1);
		expect(mock.unsubscribe).not.toHaveBeenCalled();

		await mock.handlers.get('session_shutdown')!({}, makeSessionCtx());
		expect(mock.unsubscribe).toHaveBeenCalledTimes(1);
	});
});
