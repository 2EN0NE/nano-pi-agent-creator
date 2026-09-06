/**
 * widget-wrangler — status「|」前缀规范化的中间人补全测试
 *
 * 覆盖：
 *   - ensureStatusPrefix 纯函数：带色 / 纯文本 / 空串 / OSC 序列等输入的补 | 决策
 *   - factory 级：setStatus 被劫持后，originalSetStatus 收到补 | 的文本，且缺 | 时 log.warn 触发
 *
 * mock 边界：仅 mock 渲染组件（Container/SettingsList/Text，openPanel 才用到）与
 * pi-logger / pi-config / pi-coding-agent 外围；stripTerminalSequences 走真实 pi-tui 实现。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const logger = vi.hoisted(() => ({
	info: vi.fn(),
	debug: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
}));

vi.mock('@earendil-works/pi-coding-agent', () => ({
	getSettingsListTheme: () => ({}),
}));

vi.mock('@earendil-works/pi-tui', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@earendil-works/pi-tui')>();
	return {
		...actual,
		// 渲染组件仅 openPanel 触发，本测试不覆盖，mock 掉以隔离渲染逻辑
		Container: class {},
		SettingsList: class {},
		Text: class {},
	};
});

vi.mock('@zenone/pi-logger', () => ({ createLogger: () => logger }));

vi.mock('@zenone/pi-config', () => ({
	resolveConfigPaths: () => ({ userFile: '/tmp/widget-wrangler-test/config.json' }),
	readJsonFile: () => null,
	writeJsonAtomic: () => {},
}));

import widgetWranglerExtension, {
	ensureStatusPrefix,
} from '../../../extensions/meta/_widget-wrangler/src/index.js';

// ──────────────────────────────────────────────────────────────────────────────
// 纯函数测试
// ──────────────────────────────────────────────────────────────────────────────

describe('ensureStatusPrefix', () => {
	it('纯文本缺 | 前缀时补上', () => {
		expect(ensureStatusPrefix('gate:off')).toBe('|gate:off');
	});

	it('纯文本已带 | 前缀时原样返回', () => {
		expect(ensureStatusPrefix('|gate:off')).toBe('|gate:off');
	});

	it('带 ANSI 颜色码且缺 | 时，| 补在颜色码之前', () => {
		const colored = '\x1b[36mgate:off\x1b[39m';
		expect(ensureStatusPrefix(colored)).toBe('|\x1b[36mgate:off\x1b[39m');
	});

	it('带 ANSI 颜色码且已带 | 时原样返回', () => {
		const colored = '\x1b[36m|gate:off\x1b[39m';
		expect(ensureStatusPrefix(colored)).toBe('\x1b[36m|gate:off\x1b[39m');
	});

	it('空串（清除/隐藏信号）原样返回', () => {
		expect(ensureStatusPrefix('')).toBe('');
	});

	it('仅竖线本身不重复补', () => {
		expect(ensureStatusPrefix('|')).toBe('|');
	});

	it('OSC 超链接序列开头且缺 | 时，| 补在最前', () => {
		const withLink = '\x1b]8;;http://example.com\x07foo';
		expect(ensureStatusPrefix(withLink)).toBe('|\x1b]8;;http://example.com\x07foo');
	});
});

// ──────────────────────────────────────────────────────────────────────────────
// factory 级：setStatus 劫持补 |
// ──────────────────────────────────────────────────────────────────────────────

type StatusCall = [key: string, text: string | undefined];

function makeFakePi() {
	const handlers = new Map<string, Array<(e: unknown, ctx: unknown) => unknown>>();
	const pi = {
		on: (event: string, handler: (e: unknown, ctx: unknown) => unknown) => {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event)!.push(handler);
		},
		registerCommand: vi.fn(),
		registerFlag: vi.fn(),
		registerShortcut: vi.fn(),
		getFlag: () => '',
	};
	return { pi, handlers };
}

function makeCtx(statusCalls: StatusCall[]) {
	const ui = {
		setWidget: vi.fn(),
		setStatus: (key: string, text: string | undefined) => {
			statusCalls.push([key, text]);
		},
		notify: vi.fn(),
	};
	return {
		hasUI: true,
		ui,
		sessionManager: { getBranch: () => [] },
		mode: 'tui',
	};
}

function bootAndPatch(statusCalls: StatusCall[]) {
	const { pi, handlers } = makeFakePi();
	widgetWranglerExtension(pi as never);
	const ctx = makeCtx(statusCalls);
	for (const handler of handlers.get('session_start') ?? []) {
		(handler as (e: unknown, ctx: unknown) => unknown)({}, ctx);
	}
	return { ctx, statusCalls };
}

describe('widget-wrangler setStatus 劫持', () => {
	beforeEach(() => {
		logger.warn.mockClear();
	});

	it('缺 | 前缀的 status 被自动补齐，且触发 warn', () => {
		const { ctx, statusCalls } = bootAndPatch([]);
		ctx.ui.setStatus('foo', 'bar');
		expect(statusCalls).toEqual([['foo', '|bar']]);
		expect(logger.warn).toHaveBeenCalledWith('status 缺少 "|" 前缀，已自动补齐', {
			key: 'foo',
		});
	});

	it('带 ANSI 颜色码且缺 | 的 status，| 补在颜色码之前', () => {
		const { ctx, statusCalls } = bootAndPatch([]);
		ctx.ui.setStatus('foo', '\x1b[36mbar\x1b[39m');
		expect(statusCalls).toEqual([['foo', '|\x1b[36mbar\x1b[39m']]);
		expect(logger.warn).toHaveBeenCalledTimes(1);
	});

	it('已带 | 前缀的 status 原样转发，不触发 warn', () => {
		const { ctx, statusCalls } = bootAndPatch([]);
		ctx.ui.setStatus('foo', '|bar');
		expect(statusCalls).toEqual([['foo', '|bar']]);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it('undefined 是清除信号，原样转发且不补 |', () => {
		const { ctx, statusCalls } = bootAndPatch([]);
		ctx.ui.setStatus('foo', undefined);
		expect(statusCalls).toEqual([['foo', undefined]]);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it('空串是隐藏信号，原样转发且不补 |', () => {
		const { ctx, statusCalls } = bootAndPatch([]);
		ctx.ui.setStatus('foo', '');
		expect(statusCalls).toEqual([['foo', '']]);
		expect(logger.warn).not.toHaveBeenCalled();
	});
});
