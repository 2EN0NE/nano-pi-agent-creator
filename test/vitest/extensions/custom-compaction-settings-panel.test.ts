/**
 * custom-compaction settings-panel — 字段定义逻辑 + 路由规则管理测试
 *
 * Covers:
 *   - FIELD_TO_PROFILE_KEY 顶层字段映射（含 injectContinueText）
 *   - injectContinueText 字段 readValue 三态 + edit 写回
 *   - autoContinueMessage 字段 readValue（依赖 autoContinue && injectContinueText）
 *   - describeRoutingRule 路由规则中文描述（纯函数）
 *   - manageRoutingRules 增删循环（mock selectPanel + ctx.ui.input）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import {
	PROFILE_FIELDS,
	FIELD_TO_PROFILE_KEY,
	type ProfileField,
	describeRoutingRule,
	manageRoutingRules,
	openSettingsPanel,
} from '../../../extensions/context/custom-compaction/settings-panel.js';
import {
	createCompactionStore,
	__setStoreForTest,
	loadConfig,
	addRoutingRule,
} from '../../../extensions/context/custom-compaction/config.js';
import {
	createDefaultProfile,
	type CompactionProfile,
} from '../../../extensions/context/custom-compaction/types.js';
import { selectPanel } from '../../../src/tui/select-panel.js';
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';

vi.mock('../../../src/tui/select-panel.js', () => ({
	selectPanel: vi.fn(),
}));

function makeProfile(overrides: Partial<CompactionProfile> = {}): CompactionProfile {
	return {
		id: 'default',
		name: 'Default',
		model: 'current',
		trigger: { type: 'context_percent', threshold: 20 },
		mechanism: { type: 'summarize' },
		prompt: '',
		autoContinue: true,
		injectContinueText: false,
		autoContinueMessage: 'continue',
		...overrides,
	};
}

function field(key: string): ProfileField {
	const f = PROFILE_FIELDS.find((x) => x.key === key);
	if (!f) throw new Error(`field "${key}" not found in PROFILE_FIELDS`);
	return f;
}

function makeCtx(confirmResult: boolean | undefined): ExtensionCommandContext {
	return { ui: { confirm: async () => confirmResult } } as unknown as ExtensionCommandContext;
}

/** autoContinueMessage 字段的 edit 走 ctx.ui.input（无 confirm） */
function makeInputCtx(inputResult?: string): ExtensionCommandContext {
	return { ui: { input: async () => inputResult } } as unknown as ExtensionCommandContext;
}

// ── FIELD_TO_PROFILE_KEY ────────────────────────────────────────

describe('FIELD_TO_PROFILE_KEY', () => {
	it('maps every PROFILE_FIELDS key to a top-level profile field', () => {
		for (const f of PROFILE_FIELDS) {
			expect(FIELD_TO_PROFILE_KEY[f.key], `field "${f.key}" must be mapped`).toBeDefined();
		}
	});

	it('maps injectContinueText to the top-level field', () => {
		expect(FIELD_TO_PROFILE_KEY['injectContinueText']).toBe('injectContinueText');
	});
});

// ── injectContinueText field ────────────────────────────────────

describe('injectContinueText field', () => {
	const f = field('injectContinueText');

	it('readValue shows (未启用) when autoContinue is false', () => {
		expect(f.readValue(makeProfile({ autoContinue: false, injectContinueText: true }))).toBe(
			'(未启用)',
		);
	});

	it('readValue shows 否（隐形继续） when autoContinue on and inject off', () => {
		expect(f.readValue(makeProfile({ autoContinue: true, injectContinueText: false }))).toBe(
			'否（隐形继续）',
		);
	});

	it('readValue shows 是 when inject on', () => {
		expect(f.readValue(makeProfile({ autoContinue: true, injectContinueText: true }))).toBe(
			'是',
		);
	});

	it('edit sets injectContinueText=true on confirm true', async () => {
		const p = makeProfile({ injectContinueText: false });
		const changed = await f.edit(makeCtx(true), p);
		expect(changed).toBe(true);
		expect(p.injectContinueText).toBe(true);
	});

	it('edit is a no-op when confirm returns undefined (cancelled)', async () => {
		const p = makeProfile({ injectContinueText: false });
		const changed = await f.edit(makeCtx(undefined), p);
		expect(changed).toBe(false);
		expect(p.injectContinueText).toBe(false);
	});

	it('edit is a no-op when autoContinue is false', async () => {
		const p = makeProfile({ autoContinue: false, injectContinueText: false });
		const changed = await f.edit(makeCtx(true), p);
		expect(changed).toBe(false);
		expect(p.injectContinueText).toBe(false);
	});
});

// ── autoContinueMessage field ───────────────────────────────────

describe('autoContinueMessage field', () => {
	const f = field('autoContinueMessage');

	it('readValue shows the message only when autoContinue and injectContinueText are both on', () => {
		expect(
			f.readValue(
				makeProfile({
					autoContinue: true,
					injectContinueText: true,
					autoContinueMessage: 'hello',
				}),
			),
		).toBe('"hello"');
	});

	it('readValue shows (未启用) when injectContinueText is false', () => {
		expect(
			f.readValue(
				makeProfile({
					autoContinue: true,
					injectContinueText: false,
					autoContinueMessage: 'hello',
				}),
			),
		).toBe('(未启用)');
	});

	it('edit is a no-op when injectContinueText is false (avoid dead config)', async () => {
		const p = makeProfile({
			autoContinue: true,
			injectContinueText: false,
			autoContinueMessage: 'hi',
		});
		const changed = await f.edit(makeInputCtx('changed'), p);
		expect(changed).toBe(false);
		expect(p.autoContinueMessage).toBe('hi'); // 值未被改写
	});

	it('edit is a no-op when autoContinue is false', async () => {
		const p = makeProfile({ autoContinue: false, injectContinueText: true });
		const changed = await f.edit(makeInputCtx('changed'), p);
		expect(changed).toBe(false);
	});

	it('edit writes back trimmed value when inject visible mode is on', async () => {
		const p = makeProfile({
			autoContinue: true,
			injectContinueText: true,
			autoContinueMessage: 'old',
		});
		const changed = await f.edit(makeInputCtx('  new message  '), p);
		expect(changed).toBe(true);
		expect(p.autoContinueMessage).toBe('new message');
	});
});

// ── describeRoutingRule 路由规则中文描述（纯函数）────────────────

describe('describeRoutingRule', () => {
	const profiles = { default: { ...createDefaultProfile(), name: 'Default' } };

	it('描述模型路由规则', () => {
		expect(
			describeRoutingRule({ model: 'openai/', targetProfileId: 'default' }, profiles),
		).toBe('模型 openai/ → Default');
	});

	it('描述复杂度路由规则', () => {
		expect(
			describeRoutingRule({ complexity: 'high', targetProfileId: 'default' }, profiles),
		).toBe('复杂度 high → Default');
	});

	it('模型 + 复杂度双维度拼接', () => {
		expect(
			describeRoutingRule(
				{ model: 'openai/', complexity: 'low', targetProfileId: 'default' },
				profiles,
			),
		).toBe('模型 openai/ + 复杂度 low → Default');
	});

	it('target 不存在时回退到 id', () => {
		expect(describeRoutingRule({ model: 'openai/', targetProfileId: 'ghost' }, {})).toBe(
			'模型 openai/ → ghost',
		);
	});
});

// ── manageRoutingRules 增删循环（mock selectPanel + ctx.ui.input）──

describe('manageRoutingRules 增删循环', () => {
	let tmpRoot: string;
	let userFile: string;

	beforeEach(() => {
		tmpRoot = join(tmpdir(), `cc-panel-test-${randomBytes(4).toString('hex')}`);
		const userDir = join(
			tmpRoot,
			'home',
			'.pi',
			'agent',
			'extensions-data',
			'custom-compaction',
		);
		mkdirSync(userDir, { recursive: true });
		userFile = join(userDir, 'config.json');
		writeFileSync(
			userFile,
			JSON.stringify({ profiles: { default: createDefaultProfile() } }, null, 2) + '\n',
			'utf-8',
		);
		__setStoreForTest(
			createCompactionStore({ cwd: join(tmpRoot, 'cwd'), homeDir: join(tmpRoot, 'home') }),
		);
		vi.mocked(selectPanel).mockReset();
	});

	afterEach(() => {
		rmSync(tmpRoot, { recursive: true, force: true });
	});

	function makeCtx(inputResult?: string): ExtensionCommandContext {
		return {
			ui: {
				input: vi.fn().mockResolvedValue(inputResult),
				notify: vi.fn(),
			},
		} as unknown as ExtensionCommandContext;
	}

	it('删除规则：选择删除选项 → 规则清空 → 完成退出', async () => {
		addRoutingRule({ model: 'openai/', targetProfileId: 'default' }, 'user');
		vi.mocked(selectPanel)
			.mockResolvedValueOnce('删除: 模型 openai/ → Default')
			.mockResolvedValueOnce('完成');

		await manageRoutingRules(makeCtx(), 'user');
		expect(loadConfig().routingRules).toEqual([]);
	});

	it('新增模型规则：input 模式 + pickProfile + 完成', async () => {
		vi.mocked(selectPanel)
			.mockResolvedValueOnce('+ 新增规则：模型匹配') // 主循环第一次
			.mockResolvedValueOnce('  Default (default)') // pickProfile
			.mockResolvedValueOnce('完成'); // 主循环第二次

		await manageRoutingRules(makeCtx('openai/'), 'user');
		expect(loadConfig().routingRules).toEqual([
			{ model: 'openai/', targetProfileId: 'default' },
		]);
	});

	it('新增复杂度规则：selectPanel 选 level + pickProfile + 完成', async () => {
		vi.mocked(selectPanel)
			.mockResolvedValueOnce('+ 新增规则：复杂度匹配') // 主循环第一次
			.mockResolvedValueOnce('high') // addComplexityRule 选 level
			.mockResolvedValueOnce('  Default (default)') // pickProfile
			.mockResolvedValueOnce('完成'); // 主循环第二次

		await manageRoutingRules(makeCtx(), 'user');
		expect(loadConfig().routingRules).toEqual([
			{ complexity: 'high', targetProfileId: 'default' },
		]);
	});

	it('input 返回 undefined 或空 → 不新增规则', async () => {
		vi.mocked(selectPanel)
			.mockResolvedValueOnce('+ 新增规则：模型匹配') // 主循环第一次
			.mockResolvedValueOnce('完成'); // 主循环第二次（input 空直接 return）

		await manageRoutingRules(makeCtx('  '), 'user'); // 空白 input → return
		expect(loadConfig().routingRules).toEqual([]);
	});
});

// ── openSettingsPanel 分派（toggle-enable / toggle-granularity）──

describe('openSettingsPanel 分派', () => {
	let tmpRoot: string;
	let userFile: string;

	beforeEach(() => {
		tmpRoot = join(tmpdir(), `cc-open-test-${randomBytes(4).toString('hex')}`);
		const userDir = join(
			tmpRoot,
			'home',
			'.pi',
			'agent',
			'extensions-data',
			'custom-compaction',
		);
		mkdirSync(userDir, { recursive: true });
		userFile = join(userDir, 'config.json');
		__setStoreForTest(
			createCompactionStore({ cwd: join(tmpRoot, 'cwd'), homeDir: join(tmpRoot, 'home') }),
		);
	});

	afterEach(() => {
		rmSync(tmpRoot, { recursive: true, force: true });
	});

	function writeTwoProfiles(): void {
		const alt = { ...createDefaultProfile(), id: 'alt', name: 'Alt' };
		writeFileSync(
			userFile,
			JSON.stringify(
				{
					profiles: { default: createDefaultProfile(), alt },
					enabledProfileIds: ['default'],
				},
				null,
				2,
			) + '\n',
			'utf-8',
		);
	}

	function makeOpenCtx(
		custom: ReturnType<typeof vi.fn>,
		notify = vi.fn(),
	): ExtensionCommandContext {
		return {
			model: { provider: 'openai', id: 'gpt-4o' },
			ui: { custom, notify, input: vi.fn() },
		} as unknown as ExtensionCommandContext;
	}

	it('toggle-enable 分派：启用 alt profile', async () => {
		writeTwoProfiles();
		const custom = vi
			.fn()
			.mockResolvedValueOnce({ type: 'toggle-enable', profileId: 'alt' })
			.mockResolvedValueOnce({ type: 'close' });

		await openSettingsPanel(makeOpenCtx(custom));
		expect(loadConfig().enabledProfileIds).toEqual(['default', 'alt']);
	});

	it('toggle-granularity 分派：默认 agent_turn → 循环切到 tool', async () => {
		writeTwoProfiles();
		const custom = vi
			.fn()
			.mockResolvedValueOnce({ type: 'toggle-granularity' })
			.mockResolvedValueOnce({ type: 'close' });

		await openSettingsPanel(makeOpenCtx(custom));
		// 循环顺序 user_turn → agent_turn → tool；默认 agent_turn → 下一个是 tool
		expect(loadConfig().triggerGranularity).toBe('tool');
	});

	it('toggle-enable 全关保护：停用唯一启用项 → notify warning 且启用集不变', async () => {
		writeTwoProfiles(); // enabledProfileIds = ['default']
		const notify = vi.fn();
		const custom = vi
			.fn()
			.mockResolvedValueOnce({ type: 'toggle-enable', profileId: 'default' })
			.mockResolvedValueOnce({ type: 'close' });

		await openSettingsPanel(makeOpenCtx(custom, notify));
		expect(loadConfig().enabledProfileIds).toEqual(['default']);
		expect(notify).toHaveBeenCalledWith('至少启用一个 profile，不能全部停用', 'warning');
	});
});
