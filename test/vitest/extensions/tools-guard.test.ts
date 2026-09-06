/**
 * toolsExtension — 锁定守卫实际拒绝路径（ADR-0035）
 *
 * 验证 /tools 的 SettingsList toggle 处理器在 globalThis.__presetGuard
 * 拒绝时：不调用 pi.setActiveTools（applyTools 被短路）、并向用户发 error 通知。
 *
 * 与 skills-guard.test.ts 互补：tools 与 skills 的守卫接线为同构模式，
 * 本文件额外覆盖 tools 的 applyTools 副作用在拒绝时不发生。
 *
 * 仅 mock pi 运行时 UI 组件；tools 的数据层 closure（enabledTools / applyTools）
 * 走真实路径，通过 pi.setActiveTools 调用记录断言副作用。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const hooks = vi.hoisted(() => ({
	onChange: null as null | ((id: string, newValue: string) => void),
}));

vi.mock('@earendil-works/pi-coding-agent', () => ({
	DynamicBorder: class {},
	getSettingsListTheme: () => ({}),
}));

vi.mock('@earendil-works/pi-tui', () => ({
	Container: class {
		addChild() {}
		render() {
			return [];
		}
		invalidate() {}
	},
	SettingsList: class {
		constructor(
			_items: unknown[],
			_maxVisible: number,
			_theme: unknown,
			onChange: (id: string, newValue: string) => void,
		) {
			hooks.onChange = onChange;
		}
		handleInput() {}
	},
	Text: class {},
	truncateToWidth: (s: string) => s,
}));

vi.mock('@zenone/pi-logger', () => ({
	createLogger: () => ({
		info: () => {},
		debug: () => {},
		warn: () => {},
		error: () => {},
	}),
}));

import toolsExtension from '../../../extensions/meta/preset/tools.js';

interface NotifyCall {
	message: string;
	type: string;
}

const ORIGINAL_HOME = process.env.HOME;
let tmpHome: string;
let tmpCwd: string;

function setupDirs(): void {
	tmpHome = resolve(tmpdir(), `tools-guard-${randomUUID()}`);
	tmpCwd = resolve(tmpHome, 'cwd');
	mkdirSync(resolve(tmpCwd, '.pi', 'extensions-data', 'tools'), { recursive: true });
	process.env.HOME = tmpHome;
}

function cleanupDirs(): void {
	process.env.HOME = ORIGINAL_HOME;
	try {
		rmSync(tmpHome, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
}

function mockTheme(): any {
	return {
		fg: (_c: string, text: string) => text,
		bg: (_c: string, text: string) => text,
		bold: (text: string) => text,
	};
}

/** 驱动 toolsExtension 并打开 /tools 面板，返回 toggle 触发入口 + 观察点。 */
async function openToolsPanel(guard: { allowed: boolean; reason?: string }) {
	(globalThis as Record<string, unknown>).__presetGuard = {
		canModify: () => guard,
	};

	const commands: Record<string, (args: string, ctx: unknown) => Promise<void>> = {};
	const notifyCalls: NotifyCall[] = [];
	const setActiveToolsCalls: string[][] = [];
	const pi = {
		on: () => {},
		registerCommand: (
			name: string,
			def: { handler: (args: string, ctx: unknown) => Promise<void> },
		) => {
			commands[name] = def.handler;
		},
		appendEntry: () => {},
		getAllTools: () => [{ name: 'read' }, { name: 'bash' }],
		getActiveTools: () => ['read', 'bash'],
		setActiveTools: (tools: string[]) => {
			setActiveToolsCalls.push(tools);
		},
	};
	toolsExtension(pi as never);

	const ctx = {
		mode: 'tui',
		cwd: tmpCwd,
		ui: {
			notify: (message: string, type: string) => notifyCalls.push({ message, type }),
			custom: (cb: (tui: unknown, theme: unknown, kb: unknown, done: unknown) => unknown) => {
				cb({ requestRender: () => {} }, mockTheme(), { matches: () => false }, () => {});
				return Promise.resolve(undefined);
			},
		},
		sessionManager: { getBranch: () => [] },
	};

	await commands['tools']('', ctx);
	return {
		notifyCalls,
		setActiveToolsCalls,
		toggle: (id: string) => hooks.onChange?.(id, ''),
	};
}

describe('toolsExtension 锁定守卫（ADR-0035）', () => {
	afterEach(() => {
		delete (globalThis as Record<string, unknown>).__presetGuard;
		delete (globalThis as Record<string, unknown>).__toolsApi;
		hooks.onChange = null;
		cleanupDirs();
	});

	it('守卫拒绝时 toggle 不触发 setActiveTools，并 notify error', async () => {
		setupDirs();
		const { notifyCalls, setActiveToolsCalls, toggle } = await openToolsPanel({
			allowed: false,
			reason: 'preset 已锁定，tools 修改不被允许',
		});

		// 打开面板时 auto-enable 无新工具，setActiveTools 尚未被调用
		expect(setActiveToolsCalls).toHaveLength(0);

		toggle('read');

		// 守卫拒绝：applyTools 被短路，无 setActiveTools 副作用，且 notify error
		expect(setActiveToolsCalls).toHaveLength(0);
		expect(notifyCalls.some((c) => c.type === 'error' && c.message.includes('锁定'))).toBe(
			true,
		);
	});

	it('守卫放行时 toggle 触发 setActiveTools（禁用 read）', async () => {
		setupDirs();
		const { notifyCalls, setActiveToolsCalls, toggle } = await openToolsPanel({
			allowed: true,
		});

		toggle('read');

		// 放行：read 被禁用，applyTools 推送到运行时
		expect(setActiveToolsCalls.length).toBeGreaterThanOrEqual(1);
		expect(setActiveToolsCalls.at(-1)).toEqual(['bash']);
		expect(notifyCalls.some((c) => c.type === 'error')).toBe(false);
	});
});
