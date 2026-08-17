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
	setActiveProfile,
	deleteProfile,
	updateProfileFields,
	loadConfig,
} from '../../../extensions/context/custom-compaction/config.js';
import {
	createDefaultProfile,
	type CompactionProfile,
} from '../../../extensions/context/custom-compaction/types.js';

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

// ── setActiveProfile: 只改目标层的 activeProfileId ─────────────

describe('setActiveProfile (layer-scoped)', () => {
	it('only rewrites activeProfileId in the target layer', () => {
		writeLayerFile(userFile, {
			activeProfileId: 'default',
			profiles: {
				default: profileWithThreshold(30),
				other: { ...profileWithThreshold(40), id: 'other', name: 'Other' },
			},
		});

		expect(setActiveProfile('other')).toBe(true);

		const userRaw = readLayerFile(userFile)!;
		expect(userRaw.activeProfileId).toBe('other');
		// profiles 结构未被破坏
		expect(Object.keys(userRaw.profiles as Record<string, unknown>)).toEqual([
			'default',
			'other',
		]);
	});

	it('rejects unknown profile ids', () => {
		writeLayerFile(userFile, {
			activeProfileId: 'default',
			profiles: { default: profileWithThreshold(30) },
		});
		expect(setActiveProfile('nope')).toBe(false);
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

	it('sets activeProfileId in the target layer when missing', () => {
		writeLayerFile(projectFile, { profiles: {} });
		expect(updateProfileFields('default', { name: 'X' }, 'project')).toBe(true);
		const projectRaw = readLayerFile(projectFile)!;
		expect(projectRaw.activeProfileId).toBe('default');
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
