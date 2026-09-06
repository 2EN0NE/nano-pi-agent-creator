/**
 * skills 扩展 — /skill:xxx 禁用拦截（input 事件 AOP 切面）集成测试
 *
 * 通过捕获型 fake pi 驱动真实 skillsExtension，验证：
 *   - 禁用技能的 /skill:xxx 手动调用被拦截（返回 { action: 'handled' } + notify）
 *   - 启用/未知/非 skill 命令放行
 *   - 带参数的 /skill:xxx args 同样被拦
 *   - 未初始化（首次输入早于 before_agent_start）时放行
 *
 * 仅 mock pi 运行时 UI 组件（TUI 组件在本测试不触发），pi-config 走真实路径。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

vi.mock('@earendil-works/pi-coding-agent', () => ({
	formatSkillsForPrompt: (skills: Array<{ name: string; description: string }>) =>
		skills.map((s) => s.name).join(','),
	DynamicBorder: class {},
	getSettingsListTheme: () => ({}),
}));

vi.mock('@earendil-works/pi-tui', () => ({
	Container: class {},
	SettingsList: class {},
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

type HandlerMap = Record<string, Array<(e: unknown, ctx: unknown) => unknown>>;

function makeFakePi() {
	const handlers: HandlerMap = {};
	const pi = {
		on: (event: string, handler: (e: unknown, ctx: unknown) => unknown) => {
			(handlers[event] ??= []).push(handler);
		},
		registerCommand: () => {},
		appendEntry: () => {},
		sendMessage: () => {},
	};
	return { pi, handlers };
}

function makeCtx(notifyCalls: Array<{ message: string; type: string }>, cwd: string) {
	return {
		cwd,
		ui: {
			notify: (message: string, type: string) => {
				notifyCalls.push({ message, type });
			},
		},
		sessionManager: { getBranch: () => [] },
	};
}

/** 触发事件，返回最后一个 handler 的返回值（用于 input 的 handled 判定）。 */
async function fireEvent(
	handlers: HandlerMap,
	event: string,
	e: unknown,
	ctx: unknown,
): Promise<unknown> {
	let result: unknown;
	for (const handler of handlers[event] ?? []) {
		result = await handler(e, ctx);
	}
	return result;
}

// ──────────────────────────────────────────────────────────────────────────────
// 目录隔离
// ──────────────────────────────────────────────────────────────────────────────

const ORIGINAL_HOME = process.env.HOME;
let tmpHome: string;
let tmpCwd: string;

/** 写项目级 skills config（enabledSkills 白名单）。 */
function setupDirs(enabledSkills: string[]): void {
	tmpHome = resolve(tmpdir(), `skills-integration-${randomUUID()}`);
	tmpCwd = resolve(tmpHome, 'cwd');
	mkdirSync(resolve(tmpCwd, '.pi', 'extensions-data', 'skills'), { recursive: true });
	writeFileSync(
		resolve(tmpCwd, '.pi', 'extensions-data', 'skills', 'config.json'),
		JSON.stringify({ enabledSkills }),
		'utf8',
	);
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

// ──────────────────────────────────────────────────────────────────────────────
// 测试
// ──────────────────────────────────────────────────────────────────────────────

const ALL_SKILLS = [
	{ name: 'skill-a', description: 'A' },
	{ name: 'skill-b', description: 'B' },
	{ name: 'skill-c', description: 'C' },
];

/** 驱动扩展并初始化（触发 before_agent_start 加载 allSkills + 恢复 enabledSkills）。 */
async function driveAndInit(notifyCalls: Array<{ message: string; type: string }>) {
	const { pi, handlers } = makeFakePi();
	skillsExtension(pi as never);
	const ctx = makeCtx(notifyCalls, tmpCwd);
	// systemPrompt 需包含 formatSkillsForPrompt 的 mock 输出，供过滤 replace 命中
	const skillsXml = ALL_SKILLS.map((s) => s.name).join(',');
	await fireEvent(
		handlers,
		'before_agent_start',
		{ systemPromptOptions: { skills: ALL_SKILLS }, systemPrompt: skillsXml },
		ctx,
	);
	return { handlers, ctx };
}

describe('skills /skill:xxx 禁用拦截（input AOP）', () => {
	beforeEach(() => {
		// config 只启用 skill-a / skill-c，skill-b 被禁用
		setupDirs(['skill-a', 'skill-c']);
	});

	afterEach(() => {
		cleanupDirs();
	});

	it('禁用技能 /skill:xxx → handled + 错误提示', async () => {
		const notifyCalls: Array<{ message: string; type: string }> = [];
		const { handlers, ctx } = await driveAndInit(notifyCalls);

		const result = await fireEvent(
			handlers,
			'input',
			{ text: '/skill:skill-b', source: 'interactive' },
			ctx,
		);

		expect(result).toEqual({ action: 'handled' });
		expect(notifyCalls.some((n) => n.message.includes('skill-b'))).toBe(true);
	});

	it('启用技能 /skill:xxx → 放行', async () => {
		const notifyCalls: Array<{ message: string; type: string }> = [];
		const { handlers, ctx } = await driveAndInit(notifyCalls);

		const result = await fireEvent(
			handlers,
			'input',
			{ text: '/skill:skill-a', source: 'interactive' },
			ctx,
		);

		expect(result).toBeUndefined();
		expect(notifyCalls).toHaveLength(0);
	});

	it('未知技能 /skill:unknown → 放行', async () => {
		const { handlers, ctx } = await driveAndInit([]);

		const result = await fireEvent(
			handlers,
			'input',
			{ text: '/skill:nonexistent', source: 'interactive' },
			ctx,
		);

		expect(result).toBeUndefined();
	});

	it('非 skill 命令 → 放行', async () => {
		const { handlers, ctx } = await driveAndInit([]);

		const result = await fireEvent(
			handlers,
			'input',
			{ text: '/model claude', source: 'interactive' },
			ctx,
		);

		expect(result).toBeUndefined();
	});

	it('带参数的禁用技能 /skill:xxx args → 仍拦截', async () => {
		const { handlers, ctx } = await driveAndInit([]);

		const result = await fireEvent(
			handlers,
			'input',
			{ text: '/skill:skill-b some extra args', source: 'interactive' },
			ctx,
		);

		expect(result).toEqual({ action: 'handled' });
	});

	it('未初始化（首次输入早于 before_agent_start）→ 放行', async () => {
		const { pi, handlers } = makeFakePi();
		skillsExtension(pi as never);
		const ctx = makeCtx([], tmpCwd);

		// 不触发 before_agent_start，直接触发 input（initialized=false）
		const result = await fireEvent(
			handlers,
			'input',
			{ text: '/skill:skill-b', source: 'interactive' },
			ctx,
		);

		expect(result).toBeUndefined();
	});
});
