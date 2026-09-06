/**
 * skillsExtension — 锁定守卫实际拒绝路径（ADR-0035）
 *
 * 验证 /skills 的 SettingsList toggle 处理器在 globalThis.__presetGuard
 * 拒绝时：不修改 enabledSkills 状态、并向用户发 error 通知。
 *
 * 与 preset.integration.test.ts 的 __presetGuard.canModify 纯函数测试互补：
 * 本文件驱动真实 skillsExtension 的 /skills 命令，捕获 SettingsList 的
 * onChange 回调直接触发 toggle，覆盖「守卫接线正确性」
 * （键名 __presetGuard、拒绝时 return、notify 触发）。
 *
 * 仅 mock pi 运行时 UI 组件（SettingsList/Container/TitleBar 依赖的 theme），
 * skills 的数据层 closure（enabledSkills / __skillsApi）走真实路径。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

// SettingsList 的 onChange 回调捕获：mock 构造函数时记录，测试里直接调用模拟 toggle。
const hooks = vi.hoisted(() => ({
	onChange: null as null | ((id: string, newValue: string) => void),
}));

vi.mock('@earendil-works/pi-coding-agent', () => ({
	formatSkillsForPrompt: (skills: Array<{ name: string; description: string }>) =>
		skills.map((s) => s.name).join(','),
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

import skillsExtension from '../../../extensions/meta/preset/skills.js';

// ──────────────────────────────────────────────────────────────────────────────
// 捕获型 fake pi / ctx
// ──────────────────────────────────────────────────────────────────────────────

interface NotifyCall {
	message: string;
	type: string;
}

const ORIGINAL_HOME = process.env.HOME;
let tmpHome: string;
let tmpCwd: string;

function setupDirs(): void {
	tmpHome = resolve(tmpdir(), `skills-guard-${randomUUID()}`);
	tmpCwd = resolve(tmpHome, 'cwd');
	mkdirSync(resolve(tmpCwd, '.pi', 'extensions-data', 'skills'), { recursive: true });
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

/** 驱动 skillsExtension 并打开 /skills 面板，返回 onChange 触发入口 + 观察点。 */
async function openSkillsPanel() {
	const commands: Record<string, (args: string, ctx: unknown) => Promise<void>> = {};
	const notifyCalls: NotifyCall[] = [];
	const pi = {
		on: () => {},
		registerCommand: (
			name: string,
			def: { handler: (args: string, ctx: unknown) => Promise<void> },
		) => {
			commands[name] = def.handler;
		},
		appendEntry: () => {},
	};
	skillsExtension(pi as never);

	const ctx = {
		mode: 'tui',
		cwd: tmpCwd,
		getSystemPromptOptions: () => ({
			skills: [{ name: 'skill-a', description: 'skill a desc' }],
			toolSnippets: {},
		}),
		ui: {
			notify: (message: string, type: string) => notifyCalls.push({ message, type }),
			custom: (cb: (tui: unknown, theme: unknown, kb: unknown, done: unknown) => unknown) => {
				cb({ requestRender: () => {} }, mockTheme(), { matches: () => false }, () => {});
				return Promise.resolve(undefined);
			},
		},
		sessionManager: { getBranch: () => [] },
	};

	await commands['skills']('', ctx);
	return { notifyCalls, toggle: (id: string) => hooks.onChange?.(id, '') };
}

describe('skillsExtension 锁定守卫（ADR-0035）', () => {
	afterEach(() => {
		delete (globalThis as Record<string, unknown>).__presetGuard;
		delete (globalThis as Record<string, unknown>).__skillsApi;
		hooks.onChange = null;
		cleanupDirs();
	});

	it('守卫拒绝时 toggle 不修改 enabledSkills，并 notify error', async () => {
		setupDirs();
		(globalThis as Record<string, unknown>).__presetGuard = {
			canModify: () => ({ allowed: false, reason: 'preset 已锁定，skills 修改不被允许' }),
		};

		const { notifyCalls, toggle } = await openSkillsPanel();
		const api = (globalThis as Record<string, unknown>).__skillsApi as {
			getEnabledSkills: () => string[];
		};
		// 无文件 → 全部启用：skill-a 初始已启用
		expect(api.getEnabledSkills()).toContain('skill-a');

		toggle('skill-a');

		// 守卫拒绝：skill-a 仍启用（toggle 被短路），且 notify error
		expect(api.getEnabledSkills()).toContain('skill-a');
		expect(notifyCalls.some((c) => c.type === 'error' && c.message.includes('锁定'))).toBe(
			true,
		);
	});

	it('守卫放行时 toggle 正常禁用 skill', async () => {
		setupDirs();
		(globalThis as Record<string, unknown>).__presetGuard = {
			canModify: () => ({ allowed: true }),
		};

		const { notifyCalls, toggle } = await openSkillsPanel();
		const api = (globalThis as Record<string, unknown>).__skillsApi as {
			getEnabledSkills: () => string[];
		};
		expect(api.getEnabledSkills()).toContain('skill-a');

		toggle('skill-a');

		// 放行：skill-a 被禁用
		expect(api.getEnabledSkills()).not.toContain('skill-a');
		expect(notifyCalls.some((c) => c.type === 'error')).toBe(false);
	});
});
