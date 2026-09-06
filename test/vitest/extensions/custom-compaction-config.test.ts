/**
 * custom-compaction config — layered persistence Vitest tests
 *
 * Regression coverage for the P0 bug: writes (upsertProfile / setActiveProfile /
 * deleteProfile) used to save the MERGED full config snapshot into the user
 * layer, baking project/session values into the user file ("项目级阈值被改").
 *
 * These tests assert writes touch ONLY the target layer and never leak
 * higher-priority layer values into lower-layer files.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
	createCompactionStore,
	__setStoreForTest,
	getActiveScope,
	upsertProfile,
	deleteProfile,
	updateProfileFields,
	loadConfig,
	setProfileEnabled,
	getEnabledProfiles,
	getTriggerGranularity,
	setTriggerGranularity,
	addRoutingRule,
	deleteRoutingRule,
} from '../../../extensions/context/custom-compaction/config.js';
import {
	createDefaultProfile,
	type CompactionProfile,
} from '../../../extensions/context/custom-compaction/types.js';
import { resolveContinueDecision } from '../../../extensions/context/custom-compaction/continue.js';

// ── Test utilities ──────────────────────────────────────────────

let tmpRoot: string;
let userDir: string;
let projectDir: string;
let userFile: string;
let projectFile: string;

beforeEach(() => {
	tmpRoot = join(tmpdir(), `cc-config-test-${randomBytes(4).toString('hex')}`);
	userDir = join(tmpRoot, 'home', '.pi', 'agent', 'extensions-data', 'custom-compaction');
	projectDir = join(tmpRoot, 'cwd', '.pi', 'extensions-data', 'custom-compaction');
	userFile = join(userDir, 'config.json');
	projectFile = join(projectDir, 'config.json');
	mkdirSync(userDir, { recursive: true });
	mkdirSync(projectDir, { recursive: true });
	// 隔离 store：全部读写落在临时目录，绝不触碰真实用户配置
	__setStoreForTest(
		createCompactionStore({
			cwd: join(tmpRoot, 'cwd'),
			homeDir: join(tmpRoot, 'home'),
		}),
	);
});

afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
});

/** 写一个层文件 */
function writeLayerFile(path: string, data: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

function readLayerFile(path: string): Record<string, unknown> | null {
	if (!existsSync(path)) return null;
	return JSON.parse(readFileSync(path, 'utf-8'));
}

function profileWithThreshold(threshold: number): CompactionProfile {
	return { ...createDefaultProfile(), trigger: { type: 'context_percent', threshold } };
}

// ── getActiveScope ──────────────────────────────────────────────

describe('getActiveScope', () => {
	it('maps "default" (no config files) to user', () => {
		expect(getActiveScope()).toBe('user');
	});

	it('returns user when only user layer exists', () => {
		writeLayerFile(userFile, { activeProfileId: 'default', profiles: {} });
		expect(getActiveScope()).toBe('user');
	});

	it('returns project when project layer exists (higher priority)', () => {
		writeLayerFile(userFile, { activeProfileId: 'default', profiles: {} });
		writeLayerFile(projectFile, { activeProfileId: 'default', profiles: {} });
		expect(getActiveScope()).toBe('project');
	});
});

// ── upsertProfile: 只更新目标层 ─────────────────────────────────

describe('upsertProfile (layer-scoped minimal write)', () => {
	it('P0 regression: editing user layer does NOT bake project threshold into user file', () => {
		// 项目级：threshold 70（用户在这个项目设的高阈值）
		writeLayerFile(projectFile, {
			activeProfileId: 'default',
			profiles: { default: profileWithThreshold(70) },
		});
		// 用户级：threshold 30
		writeLayerFile(userFile, {
			activeProfileId: 'default',
			profiles: { default: profileWithThreshold(30) },
		});

		// 合并后生效的是项目级 70
		expect(loadConfig().profiles.default.trigger.threshold).toBe(70);

		// 用户编辑 user 层 profile 的 name（模拟 settings panel 修改一个字段）
		const edited = profileWithThreshold(30);
		edited.name = 'Renamed';
		expect(upsertProfile(edited, 'user')).toBe(true);

		// 用户层：name 更新，threshold 仍为 30 —— 没有被项目值 70 污染
		const userRaw = readLayerFile(userFile)!;
		const userProfiles = userRaw.profiles as Record<
			string,
			{ name: string; trigger: { threshold: number } }
		>;
		expect(userProfiles.default.name).toBe('Renamed');
		expect(userProfiles.default.trigger.threshold).toBe(30);

		// 项目层文件完全不受影响
		const projectRaw = readLayerFile(projectFile)!;
		const projectProfiles = projectRaw.profiles as Record<
			string,
			{ name: string; trigger: { threshold: number } }
		>;
		expect(projectProfiles.default.trigger.threshold).toBe(70);
		expect(projectProfiles.default.name).toBe('Default');

		// 合并结果仍由项目级主导
		expect(loadConfig().profiles.default.trigger.threshold).toBe(70);
	});

	it('creates the target layer file when it does not exist, without touching other layers', () => {
		// 只有用户级配置，项目层不存在
		writeLayerFile(userFile, {
			activeProfileId: 'default',
			profiles: { default: profileWithThreshold(30) },
		});

		const edited = profileWithThreshold(30);
		edited.name = 'FromPanel';
		// 编辑写入 user 层（getActiveScope → user）
		expect(upsertProfile(edited)).toBe(true);

		const userRaw = readLayerFile(userFile)!;
		const userProfiles = userRaw.profiles as Record<
			string,
			{ name: string; trigger: { threshold: number } }
		>;
		expect(userProfiles.default.name).toBe('FromPanel');
		expect(userProfiles.default.trigger.threshold).toBe(30);
		// 项目层文件没有被创建（无跨层污染）
		expect(existsSync(projectFile)).toBe(false);
	});

	it('saves to the project layer by default when project config is active (panel UX)', () => {
		// 只有项目级配置（用户在该项目设了 70）
		writeLayerFile(projectFile, {
			activeProfileId: 'default',
			profiles: { default: profileWithThreshold(70) },
		});

		const edited = profileWithThreshold(70);
		edited.name = 'ProjectEdit';
		// 面板打开时 activeSource=project → 默认保存到项目层（修复前会写 user 并固化 70）
		expect(upsertProfile(edited)).toBe(true);

		const projectRaw = readLayerFile(projectFile)!;
		const projectProfiles = projectRaw.profiles as Record<string, { name: string }>;
		expect(projectProfiles.default.name).toBe('ProjectEdit');
		// 用户级文件没有被创建 —— 项目设置不再泄漏为全局
		expect(existsSync(userFile)).toBe(false);
	});

	it('saves to session layer when explicitly requested', () => {
		const edited = profileWithThreshold(5);
		edited.name = 'SessionOnly';
		expect(upsertProfile(edited, 'session')).toBe(true);

		// 无 sessionId 时 session 写入退化为 user 层（store.getPaths 无 sessionFile）
		// 本测试 store 未 setSessionId → 落在 user 层，行为稳健
		const userRaw = readLayerFile(userFile)!;
		const userProfiles = userRaw.profiles as Record<string, { name: string }>;
		expect(userProfiles.default.name).toBe('SessionOnly');
	});
});

// ── deleteProfile: 从所有层删除 ─────────────────────────────────

describe('deleteProfile (cross-layer)', () => {
	it('deletes a profile defined in the project layer, even when user layer exists', () => {
		writeLayerFile(userFile, {
			activeProfileId: 'default',
			profiles: { default: profileWithThreshold(30) },
		});
		writeLayerFile(projectFile, {
			activeProfileId: 'default',
			profiles: {
				default: profileWithThreshold(70),
				'project-only': {
					...profileWithThreshold(80),
					id: 'project-only',
					name: 'Project Only',
				},
			},
		});

		// 合并后存在 project-only
		expect(loadConfig().profiles['project-only']).toBeDefined();

		expect(deleteProfile('project-only')).toBe(true);

		// 项目层删除成功，用户层不受影响
		const projectRaw = readLayerFile(projectFile)!;
		const projectProfiles = projectRaw.profiles as Record<string, unknown>;
		expect(projectProfiles['project-only']).toBeUndefined();
		expect(
			(readLayerFile(userFile)!.profiles as Record<string, unknown>)['project-only'],
		).toBeUndefined();

		// 合并后消失
		expect(loadConfig().profiles['project-only']).toBeUndefined();
	});

	it('refuses to delete the last remaining profile', () => {
		writeLayerFile(userFile, {
			activeProfileId: 'default',
			profiles: { default: profileWithThreshold(30) },
		});
		expect(deleteProfile('default')).toBe(false);
		expect(loadConfig().profiles.default).toBeDefined();
	});

	it('P3: rolls back already-written layers when a later layer write fails', () => {
		// 'multi' 定义在 user + project 两层；注入 reload 在第 2 次写层（session 层退化写 userFile）
		// 时抛错 → user 层已写的内容必须被回滚，避免部分删除。
		writeLayerFile(userFile, {
			activeProfileId: 'default',
			profiles: {
				default: profileWithThreshold(30),
				multi: { ...profileWithThreshold(40), id: 'multi' },
			},
		});
		writeLayerFile(projectFile, {
			activeProfileId: 'default',
			profiles: {
				multi: { ...profileWithThreshold(50), id: 'multi' },
			},
		});

		const base = createCompactionStore({
			cwd: join(tmpRoot, 'cwd'),
			homeDir: join(tmpRoot, 'home'),
		});
		let reloadCount = 0;
		const failingStore = new Proxy(base, {
			get(target, prop, receiver) {
				if (prop === 'reload') {
					return () => {
						reloadCount++;
						if (reloadCount === 2) throw new Error('simulated write failure');
						return Reflect.get(target, prop, receiver).call(target);
					};
				}
				return Reflect.get(target, prop, receiver);
			},
		});
		__setStoreForTest(failingStore as never);

		expect(deleteProfile('multi')).toBe(false);

		// user 层已删的 multi 被回滚恢复（原子性：失败不留部分删除）
		const userRaw = readLayerFile(userFile)!;
		expect((userRaw.profiles as Record<string, unknown>).multi).toBeDefined();
		// project 层保留
		const projectRaw = readLayerFile(projectFile)!;
		expect((projectRaw.profiles as Record<string, unknown>).multi).toBeDefined();
		// 合并视图仍有 multi
		expect(loadConfig().profiles.multi).toBeDefined();
	});
});

// ── updateProfileFields（字段级差异写入） ────────────────────────

describe('updateProfileFields (field-level minimal write)', () => {
	it('P2 regression: editing a user-layer profile while project is active does NOT fork the whole profile into project', () => {
		// profile 'a' 只定义在 user 层（threshold 30）；project 层存在但只定义别的字段
		writeLayerFile(userFile, {
			activeProfileId: 'default',
			profiles: { default: profileWithThreshold(30) },
		});
		writeLayerFile(projectFile, {
			activeProfileId: 'default',
			profiles: {},
		});

		// 活跃层是 project
		expect(getActiveScope()).toBe('project');

		// 编辑 user 层 profile 的 name（字段级更新到活跃层 project）
		expect(updateProfileFields('default', { name: 'Renamed' }, 'project')).toBe(true);

		// 项目层只落 name（+ id），不固化 threshold/trigger 等合并视图字段
		const projectRaw = readLayerFile(projectFile)!;
		const projectProfile = (projectRaw.profiles as Record<string, unknown>).default as {
			id?: string;
			name?: string;
			trigger?: unknown;
			prompt?: unknown;
		};
		expect(projectProfile.name).toBe('Renamed');
		expect(projectProfile.id).toBe('default');
		expect(projectProfile.trigger).toBeUndefined();
		expect(projectProfile.prompt).toBeUndefined();

		// 合并视图仍由 user 层主导 threshold（30），未被项目层固化
		expect(loadConfig().profiles.default.trigger.threshold).toBe(30);
	});

	it('merges partial fields into an existing target-layer profile without clobbering its other fields', () => {
		writeLayerFile(projectFile, {
			activeProfileId: 'default',
			profiles: {
				default: {
					...profileWithThreshold(70),
					name: 'Project',
					prompt: 'keep me',
				},
			},
		});

		expect(updateProfileFields('default', { autoContinue: false }, 'project')).toBe(true);

		const projectProfile = (
			readLayerFile(projectFile)!.profiles as Record<string, Record<string, unknown>>
		).default;
		expect(projectProfile.autoContinue).toBe(false);
		// 同层其它字段保留
		expect(projectProfile.name).toBe('Project');
		expect(projectProfile.prompt).toBe('keep me');
		expect((projectProfile.trigger as { threshold: number }).threshold).toBe(70);
	});

	it('deep-merges trigger sub-fields: only the changed sub-field is written, target-layer sub-fields kept', () => {
		writeLayerFile(projectFile, {
			activeProfileId: 'default',
			profiles: {
				default: {
					...profileWithThreshold(70),
					trigger: { type: 'context_percent', threshold: 70 },
				},
			},
		});

		// 编辑 triggerType：diff 只含变化的子字段 type（threshold 未变则不携带）
		expect(updateProfileFields('default', { trigger: { type: 'fixed' } }, 'project')).toBe(
			true,
		);

		const projectProfile = (
			readLayerFile(projectFile)!.profiles as Record<string, Record<string, unknown>>
		).default;
		// 目标层已有 threshold 保留，只改 type
		expect(projectProfile.trigger).toEqual({ type: 'fixed', threshold: 70 });
	});

	it('sub-field edit does NOT bake inherited low-layer fields into the target layer', () => {
		// 低层（user）定义完整 trigger；目标层（project）只有该 profile 的 name
		writeLayerFile(userFile, {
			activeProfileId: 'default',
			profiles: { default: profileWithThreshold(30) },
		});
		writeLayerFile(projectFile, {
			activeProfileId: 'default',
			profiles: { default: { id: 'default', name: 'Project' } },
		});

		// 编辑 triggerType：diff 只携带 type 子字段，不含低层继承的 threshold
		expect(updateProfileFields('default', { trigger: { type: 'fixed' } }, 'project')).toBe(
			true,
		);

		const projectProfile = (
			readLayerFile(projectFile)!.profiles as Record<string, Record<string, unknown>>
		).default;
		expect(projectProfile.trigger).toEqual({ type: 'fixed' }); // threshold 未固化到 project 层
		expect((projectProfile as { threshold?: unknown }).threshold).toBeUndefined();
	});

	it('creates a target-layer profile entry with only the given fields when absent', () => {
		writeLayerFile(userFile, {
			activeProfileId: 'default',
			profiles: { default: profileWithThreshold(30) },
		});
		// 目标层（project）尚无该 profile → 只写入给出的字段
		expect(updateProfileFields('default', { name: 'New' }, 'project')).toBe(true);

		const projectProfile = (
			readLayerFile(projectFile)!.profiles as Record<string, Record<string, unknown>>
		).default;
		expect(projectProfile.name).toBe('New');
		expect(projectProfile.id).toBe('default');
		expect(projectProfile.trigger).toBeUndefined();
	});

	it('P3: clearing an inherited field writes explicit null override (not silent no-op)', () => {
		// 低层（user）定义 matchModel；目标层（project）只有该 profile 的 name
		writeLayerFile(userFile, {
			activeProfileId: 'default',
			profiles: {
				default: { ...profileWithThreshold(30), matchModel: 'openai/gpt-4o' },
			},
		});
		writeLayerFile(projectFile, {
			activeProfileId: 'default',
			profiles: { default: { id: 'default', name: 'Project' } },
		});

		// 清除 matchModel（面板置 undefined）→ 目标层必须写入显式 null 覆盖，
		// 否则 JSON.stringify 丢弃 undefined、文件无变化、合并视图仍显示低层值。
		expect(updateProfileFields('default', { matchModel: undefined }, 'project')).toBe(true);

		const projectProfile = (
			readLayerFile(projectFile)!.profiles as Record<string, Record<string, unknown>>
		).default;
		expect(projectProfile.matchModel).toBeNull();

		// 合并视图不再显示低层继承的 matchModel（null 覆盖低层值）
		expect(loadConfig().profiles.default.matchModel).toBeNull();
	});

	it('P3: clearing a mechanism sub-field writes explicit null sub-override', () => {
		writeLayerFile(userFile, {
			activeProfileId: 'default',
			profiles: {
				default: {
					...profileWithThreshold(30),
					mechanism: { type: 'smart-compact', adapterId: 'pi-smart-compact' },
				},
			},
		});
		writeLayerFile(projectFile, {
			activeProfileId: 'default',
			profiles: { default: { id: 'default', name: 'Project' } },
		});

		// 清除 mechanism.adapterId → 目标层 mechanism.adapterId = null
		expect(
			updateProfileFields('default', { mechanism: { adapterId: undefined } }, 'project'),
		).toBe(true);

		const projectProfile = (
			readLayerFile(projectFile)!.profiles as Record<string, Record<string, unknown>>
		).default;
		expect((projectProfile.mechanism as Record<string, unknown>).adapterId).toBeNull();
		// 合并视图 mechanism.adapterId 为 null（不再继承低层 adapterId）
		expect(
			(loadConfig().profiles.default.mechanism as { adapterId?: unknown }).adapterId,
		).toBeNull();
	});
});

// ── injectContinueText 向后兼容（旧配置无该字段） ───────────────

describe('injectContinueText backward compatibility', () => {
	it('loads a v3 config without injectContinueText as invisible (false default)', () => {
		// 旧配置：autoContinue=true + autoContinueMessage，但无 injectContinueText 字段
		writeLayerFile(userFile, {
			activeProfileId: 'default',
			profiles: {
				default: {
					id: 'default',
					name: 'Default',
					model: 'current',
					trigger: { type: 'context_percent', threshold: 20 },
					mechanism: { type: 'summarize' },
					prompt: '',
					autoContinue: true,
					autoContinueMessage: '继续按目标完成任务，全部验证',
				},
			},
		});

		const profile = loadConfig().profiles.default;
		// deepMerge(defaults, user) 补默认 injectContinueText=false
		expect(profile.injectContinueText).toBe(false);
		// 因此 continue 决策为 invisible（不再注入可见文本）
		expect(resolveContinueDecision(profile)).toEqual({ kind: 'invisible' });
	});

	it('opts back into visible message when injectContinueText is explicitly true', () => {
		writeLayerFile(userFile, {
			activeProfileId: 'default',
			profiles: {
				default: {
					id: 'default',
					name: 'Default',
					model: 'current',
					trigger: { type: 'context_percent', threshold: 20 },
					mechanism: { type: 'summarize' },
					prompt: '',
					autoContinue: true,
					injectContinueText: true,
					autoContinueMessage: '继续按目标完成任务，全部验证',
				},
			},
		});

		const profile = loadConfig().profiles.default;
		expect(profile.injectContinueText).toBe(true);
		expect(resolveContinueDecision(profile)).toEqual({
			kind: 'message',
			text: '继续按目标完成任务，全部验证',
		});
	});
});

// ── Ticket 01: 范式升级 schema 迁移 ─────────────────────────────

describe('schema expansion migration (enabledProfileIds / triggerGranularity / routingRules)', () => {
	const altProfile = () => ({ ...createDefaultProfile(), id: 'alt', name: 'Alt' });

	it('旧配置（无新字段）读取后继承 defaults：enabledProfileIds=[default]、granularity=agent_turn、routingRules=[]', () => {
		writeLayerFile(userFile, {
			activeProfileId: 'default',
			profiles: { default: createDefaultProfile() },
		});
		const cfg = loadConfig();
		expect(cfg.enabledProfileIds).toEqual(['default']);
		expect(cfg.triggerGranularity).toBe('agent_turn');
		expect(cfg.routingRules).toEqual([]);
	});

	it('迁移幂等：多次读取不改变 enabledProfileIds，也不写盘', () => {
		writeLayerFile(userFile, {
			activeProfileId: 'default',
			profiles: { default: createDefaultProfile() },
		});
		loadConfig();
		loadConfig();
		expect(loadConfig().enabledProfileIds).toEqual(['default']);
		// 未写盘：user 层文件仍无新字段
		expect(readLayerFile(userFile)?.enabledProfileIds).toBeUndefined();
	});

	it('层间覆盖：project 层显式 enabledProfileIds 覆盖继承值', () => {
		writeLayerFile(userFile, {
			activeProfileId: 'default',
			profiles: { default: createDefaultProfile() },
		});
		writeLayerFile(projectFile, {
			activeProfileId: 'default',
			profiles: { default: createDefaultProfile(), alt: altProfile() },
			enabledProfileIds: ['default', 'alt'],
		});
		expect(loadConfig().enabledProfileIds).toEqual(['default', 'alt']);
	});

	it('非法值兜底：enabledProfileIds 非数组 → 继承 defaults', () => {
		writeLayerFile(userFile, {
			activeProfileId: 'default',
			profiles: { default: createDefaultProfile() },
			enabledProfileIds: 'not-an-array',
		});
		expect(loadConfig().enabledProfileIds).toEqual(['default']);
	});

	it('非法 triggerGranularity → 继承 defaults agent_turn', () => {
		writeLayerFile(userFile, {
			activeProfileId: 'default',
			profiles: { default: createDefaultProfile() },
			triggerGranularity: 'bogus',
		});
		expect(loadConfig().triggerGranularity).toBe('agent_turn');
	});

	it('enabledProfileIds 保留幽灵 id，由 getEnabledProfiles 消费侧过滤', () => {
		writeLayerFile(userFile, {
			activeProfileId: 'default',
			profiles: { default: createDefaultProfile() },
			enabledProfileIds: ['default', 'ghost'],
		});
		// validate 不再按层做存在性过滤（跨层引用合法），幽灵 id 保留在配置里
		expect(loadConfig().enabledProfileIds).toEqual(['default', 'ghost']);
		// 消费侧 getEnabledProfiles 过滤幽灵 id，不返回 undefined profile
		expect(getEnabledProfiles().map((p) => p.id)).toEqual(['default']);
	});

	it('enabledProfileIds 空数组 → 继承 defaults（启用集非空不变量）', () => {
		writeLayerFile(userFile, {
			activeProfileId: 'default',
			profiles: { default: createDefaultProfile() },
			enabledProfileIds: [],
		});
		expect(loadConfig().enabledProfileIds).toEqual(['default']);
	});

	it('enabledProfileIds 全非法元素（过滤后为空）→ 继承 defaults', () => {
		writeLayerFile(userFile, {
			activeProfileId: 'default',
			profiles: { default: createDefaultProfile() },
			enabledProfileIds: [123, null, {}],
		});
		expect(loadConfig().enabledProfileIds).toEqual(['default']);
	});

	it('routingRules 畸形元素被丢弃，合法元素保留', () => {
		writeLayerFile(userFile, {
			activeProfileId: 'default',
			profiles: { default: createDefaultProfile() },
			routingRules: [
				{ model: 'openai/', targetProfileId: 'default' },
				{ model: 123, targetProfileId: 'default' }, // model 非字符串
				{ complexity: 'bogus', targetProfileId: 'default' }, // complexity 非法枚举
				{ complexity: 'high' }, // 缺 targetProfileId
				{ targetProfileId: '' }, // targetProfileId 空
				null,
				'scrap',
				{ model: 'anthropic/', complexity: 'high', targetProfileId: 'alt' },
			],
		});
		expect(loadConfig().routingRules).toEqual([
			{ model: 'openai/', targetProfileId: 'default' },
			{ model: 'anthropic/', complexity: 'high', targetProfileId: 'alt' },
		]);
	});
});

// ── Ticket 02: 启用集读写 ──────────────────────────────────────

describe('setProfileEnabled / getEnabledProfiles (启用集 Space 勾选)', () => {
	const alt = () => ({ ...createDefaultProfile(), id: 'alt', name: 'Alt' });

	it('启用：加入启用集', () => {
		writeLayerFile(userFile, {
			activeProfileId: 'default',
			profiles: { default: createDefaultProfile(), alt: alt() },
		});
		expect(setProfileEnabled('alt', true, 'user')).toBe(true);
		expect(loadConfig().enabledProfileIds).toEqual(['default', 'alt']);
	});

	it('停用：移出启用集', () => {
		writeLayerFile(userFile, {
			activeProfileId: 'default',
			profiles: { default: createDefaultProfile(), alt: alt() },
			enabledProfileIds: ['default', 'alt'],
		});
		expect(setProfileEnabled('alt', false, 'user')).toBe(true);
		expect(loadConfig().enabledProfileIds).toEqual(['default']);
	});

	it('全关保护：拒绝停用最后一个启用项', () => {
		writeLayerFile(userFile, {
			activeProfileId: 'default',
			profiles: { default: createDefaultProfile(), alt: alt() },
			enabledProfileIds: ['default'],
		});
		expect(setProfileEnabled('default', false, 'user')).toBe(false);
		expect(loadConfig().enabledProfileIds).toEqual(['default']);
	});

	it('幂等：重复启用不产生重复 id', () => {
		writeLayerFile(userFile, {
			activeProfileId: 'default',
			profiles: { default: createDefaultProfile(), alt: alt() },
		});
		setProfileEnabled('alt', true, 'user');
		setProfileEnabled('alt', true, 'user');
		expect(loadConfig().enabledProfileIds).toEqual(['default', 'alt']);
	});

	it('已停用 profile 再次停用：幂等返回 true，不写盘', () => {
		writeLayerFile(userFile, {
			activeProfileId: 'default',
			profiles: { default: createDefaultProfile(), alt: alt() },
			enabledProfileIds: ['default'],
		});
		expect(setProfileEnabled('alt', false, 'user')).toBe(true);
		expect(loadConfig().enabledProfileIds).toEqual(['default']);
	});

	it('profile 不存在：返回 false', () => {
		writeLayerFile(userFile, {
			activeProfileId: 'default',
			profiles: { default: createDefaultProfile() },
		});
		expect(setProfileEnabled('ghost', true, 'user')).toBe(false);
	});

	it('getEnabledProfiles 返回启用集内 profile（按定义顺序）', () => {
		writeLayerFile(userFile, {
			activeProfileId: 'default',
			profiles: { default: createDefaultProfile(), alt: alt() },
			enabledProfileIds: ['alt'],
		});
		expect(getEnabledProfiles().map((p) => p.id)).toEqual(['alt']);
	});
});

// ── Ticket 03: 触发粒度读写 ────────────────────────────────────

describe('getTriggerGranularity / setTriggerGranularity', () => {
	it('默认 agent_turn（无配置时继承 defaults）', () => {
		writeLayerFile(userFile, {
			activeProfileId: 'default',
			profiles: { default: createDefaultProfile() },
		});
		expect(getTriggerGranularity()).toBe('agent_turn');
	});

	it('setTriggerGranularity 写目标层并生效', () => {
		writeLayerFile(userFile, {
			activeProfileId: 'default',
			profiles: { default: createDefaultProfile() },
		});
		expect(setTriggerGranularity('tool', 'user')).toBe(true);
		expect(getTriggerGranularity()).toBe('tool');
		expect(loadConfig().triggerGranularity).toBe('tool');
	});

	it('非法粒度在 validate 时被置 undefined → 继承 defaults', () => {
		writeLayerFile(userFile, {
			activeProfileId: 'default',
			profiles: { default: createDefaultProfile() },
			triggerGranularity: 'bogus',
		});
		expect(getTriggerGranularity()).toBe('agent_turn');
	});
});

// ── Ticket 04: 路由规则读写 ────────────────────────────────────

describe('addRoutingRule / deleteRoutingRule', () => {
	it('addRoutingRule 追加到尾部', () => {
		writeLayerFile(userFile, {
			activeProfileId: 'default',
			profiles: { default: createDefaultProfile() },
		});
		expect(addRoutingRule({ model: 'openai/', targetProfileId: 'default' }, 'user')).toBe(true);
		expect(loadConfig().routingRules).toEqual([
			{ model: 'openai/', targetProfileId: 'default' },
		]);
	});

	it('deleteRoutingRule 按索引删除', () => {
		writeLayerFile(userFile, {
			activeProfileId: 'default',
			profiles: { default: createDefaultProfile() },
			routingRules: [
				{ model: 'openai/', targetProfileId: 'default' },
				{ complexity: 'high', targetProfileId: 'default' },
			],
		});
		expect(deleteRoutingRule(0, 'user')).toBe(true);
		expect(loadConfig().routingRules).toEqual([
			{ complexity: 'high', targetProfileId: 'default' },
		]);
	});

	it('deleteRoutingRule 越界 → false', () => {
		writeLayerFile(userFile, {
			activeProfileId: 'default',
			profiles: { default: createDefaultProfile() },
		});
		expect(deleteRoutingRule(5, 'user')).toBe(false);
	});
});

// ── 修复验证：跨层启用集覆盖（分层最小写入 + 启用集组合）───────

describe('跨层 enabledProfileIds（分层最小写入，修复验证）', () => {
	const alt = () => ({ ...createDefaultProfile(), id: 'alt', name: 'Alt' });

	it('project 层仅声明 enabledProfileIds（profile 定义在 user 层）不被整层丢弃', () => {
		writeLayerFile(userFile, {
			profiles: { default: createDefaultProfile(), alt: alt() },
		});
		writeLayerFile(projectFile, {
			enabledProfileIds: ['alt'],
		});
		expect(loadConfig().enabledProfileIds).toEqual(['alt']);
	});

	it('project 层 enabledProfileIds 引用 user 层 profile 不被当幽灵 id 过滤', () => {
		writeLayerFile(userFile, {
			profiles: { default: createDefaultProfile(), alt: alt() },
		});
		writeLayerFile(projectFile, {
			profiles: { default: createDefaultProfile() },
			enabledProfileIds: ['default', 'alt'],
		});
		expect(loadConfig().enabledProfileIds).toEqual(['default', 'alt']);
	});

	it('getEnabledProfiles 在合并后过滤幽灵 id（消费侧兜底）', () => {
		writeLayerFile(userFile, {
			profiles: { default: createDefaultProfile() },
			enabledProfileIds: ['default', 'ghost'],
		});
		expect(getEnabledProfiles().map((p) => p.id)).toEqual(['default']);
	});
});

// ── 修复验证：deleteProfile 启用集非空不变量（ADR-0036 决策 2）──

describe('deleteProfile 启用集非空不变量', () => {
	const alt = () => ({ ...createDefaultProfile(), id: 'alt', name: 'Alt' });

	it('删除唯一启用项（总数 ≥2）→ 回填剩余第一个，不产生空启用集', () => {
		writeLayerFile(userFile, {
			profiles: { default: createDefaultProfile(), alt: alt() },
			enabledProfileIds: ['alt'],
		});
		expect(deleteProfile('alt')).toBe(true);
		const cfg = loadConfig();
		// alt 被删（default 由 defaults 内置始终存在，故删 alt 而非 default）
		expect(cfg.profiles.alt).toBeUndefined();
		// 唯一启用项被删后回填剩余第一个（default），启用集非空
		expect(cfg.enabledProfileIds).toEqual(['default']);
	});

	it('删除非唯一启用项 → 仅移除该 id，不误回填', () => {
		writeLayerFile(userFile, {
			profiles: { default: createDefaultProfile(), alt: alt() },
			enabledProfileIds: ['default', 'alt'],
		});
		expect(deleteProfile('alt')).toBe(true);
		expect(loadConfig().enabledProfileIds).toEqual(['default']);
	});
});
