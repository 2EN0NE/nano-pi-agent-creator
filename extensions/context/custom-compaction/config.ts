/**
 * Settings persistence for custom-compaction extension.
 *
 * Config file precedence (highest first):
 * 1. <config-dir>/<sessionId>.json — per-session overrides (temporary, resets on new session)
 * 2. <config-dir>/config.json       — user-level config (persists across sessions)
 * 3. <project>/.pi/extensions-data/  — project-level config (optional)
 *
 * All files live under:
 *   ~/.pi/agent/extensions-data/custom-compaction/
 *
 * Uses @zenone/pi-config for layered loading (default < user < project < session).
 * Save calls default to 'user' scope so profile edits persist across sessions.
 */

import { createLogger } from '@zenone/pi-logger';
import {
	createConfigStore,
	readJsonFile,
	writeJsonAtomic,
	type ConfigStore,
} from '@zenone/pi-config';
import {
	type CompactionConfig,
	type CompactionMechanism,
	type CompactionProfile,
	type TriggerCondition,
	createDefaultConfig,
	selectBestProfile,
} from './types.js';

const log = createLogger('custom-compaction:config');

// ── Save scope ──────────────────────────────────────────────────

/** 配置可写入的层。优先级：session > project > user */
export type SaveScope = 'user' | 'session' | 'project';

/**
 * updateProfileFields 的 partial 类型：顶层字段全部可选，复合字段
 * （trigger/mechanism）允许只携带变化的子字段（差异写入，不强制完整对象）。
 */
export type ProfileFieldPartial = Partial<Omit<CompactionProfile, 'trigger' | 'mechanism'>> & {
	trigger?: Partial<TriggerCondition>;
	mechanism?: Partial<CompactionMechanism>;
};

// ── ConfigStore ──────────────────────────────────────────────────
// sessionScoped: 启用 session 级覆盖（<sessionId>.json 优先于 config.json）
// validate: 校验 profiles 并兜底 activeProfileId

function validateConfig(raw: unknown): Partial<CompactionConfig> | null {
	const parsed = raw as CompactionConfig;
	if (!parsed.profiles || typeof parsed.profiles !== 'object') {
		log.warn('Invalid config: missing or invalid profiles field, skipping layer');
		return null;
	}
	if (!parsed.activeProfileId || !parsed.profiles[parsed.activeProfileId]) {
		parsed.activeProfileId = Object.keys(parsed.profiles)[0] ?? 'default';
	}
	return parsed;
}

/** 创建可注入 cwd/homeDir 的 store（测试用临时目录隔离） */
export function createCompactionStore(opts?: {
	cwd?: string;
	homeDir?: string;
}): ConfigStore<CompactionConfig> {
	return createConfigStore({
		pluginName: 'custom-compaction',
		defaults: createDefaultConfig(),
		sessionScoped: true,
		cwd: opts?.cwd,
		homeDir: opts?.homeDir,
		validate: validateConfig,
	});
}

let store: ConfigStore<CompactionConfig> = createCompactionStore();

/** 仅供 vitest 注入隔离 store；生产代码不要调用 */
export function __setStoreForTest(s: ConfigStore<CompactionConfig>): void {
	store = s;
}

// ── State query helpers ─────────────────────────────────────────

/**
 * Whether the currently loaded config is session-specific.
 */
export function isSessionConfig(): boolean {
	return store.getActiveSource() === 'session';
}

/**
 * Get the config label for display.
 */
export function getConfigLabel(): string {
	const source = store.getActiveSource();
	const profile = getActiveProfile();
	const profileName = profile?.name ?? 'Default';

	switch (source) {
		case 'session':
			return `${profileName} (session)`;
		case 'project':
			return `${profileName} (project)`;
		case 'user':
			return `${profileName} (user)`;
		default:
			return profileName;
	}
}

// ── Config load / save ──────────────────────────────────────────

/**
 * Set the current session ID and re-resolve the active config.
 * Delegates to store.setSessionId — reloads on next get().
 */
export function setSessionId(sessionId: string): void {
	store.setSessionId(sessionId);
	log.info('Session ID set:', sessionId);
}

/**
 * Load config from disk. Priority: session > user > defaults
 */
export function loadConfig(): CompactionConfig {
	return store.get();
}

/**
 * Save config to disk.
 *
 * ⚠️ 底层能力：写入的是「传入的完整对象」到指定层文件。
 * 业务代码应使用 upsertProfile / setActiveProfile / deleteProfile
 * （它们只更新目标层的差异，不会把合并后的全量快照污染到单层文件）。
 *
 * @param config  The config object to save.
 * @param scope   Where to save. Default is 'user' (persists across sessions).
 *                Use 'session' for per-session overrides (not persistent).
 *                Use 'project' for project-level config (.pi/extensions-data/).
 */
export function saveConfig(config: CompactionConfig, scope: SaveScope = 'user'): boolean {
	return store.save(config, scope);
}

/**
 * Force-reload config from disk (discard in-memory cache).
 */
export function reloadConfig(): CompactionConfig {
	return store.reload();
}

// ── Layer-scoped minimal writes ─────────────────────────────────
// 写操作只更新「目标层原始文件」中的差异字段，绝不把合并结果全量
// 写回单层文件——否则项目级/会话级配置会被固化成用户级快照，
// 造成跨项目配置污染（「项目级阈值被改」的根因）。

/**
 * 当前生效的保存层。default（无任何配置文件）映射为 user。
 */
export function getActiveScope(): SaveScope {
	const s = store.getActiveSource();
	return s === 'default' ? 'user' : s;
}

/** 目标层配置文件路径 */
function layerFile(scope: SaveScope): string {
	const paths = store.getPaths();
	if (scope === 'session') {
		// 未设置 sessionId 时（getPaths 不返回 sessionFile），会话级写入退化为用户级
		return paths.sessionFile ?? paths.userFile;
	}
	return scope === 'project' ? paths.projectFile : paths.userFile;
}

/** 读目标层原始文件（不经过合并/validate），不存在返回 null */
function readLayerRaw(scope: SaveScope): Record<string, unknown> | null {
	return readJsonFile(layerFile(scope));
}

/** 写目标层并刷新缓存，返回是否成功 */
function writeLayer(scope: SaveScope, raw: Record<string, unknown>): boolean {
	try {
		writeJsonAtomic(layerFile(scope), raw);
		store.reload();
		return true;
	} catch (err) {
		log.error('failed to save config to %s: %s', layerFile(scope), String(err));
		return false;
	}
}

/**
 * Get the active config path for display.
 */
export function getActiveConfigPath(): string {
	const paths = store.getPaths();
	const source = store.getActiveSource();
	if (source === 'session') {
		// sessionFile is populated by getPaths() when sessionScoped is enabled
		// Fall back to userFile when no session file exists
		return (
			('sessionFile' in paths
				? (paths as { sessionFile?: string }).sessionFile
				: undefined) ?? paths.userFile
		);
	}
	return source === 'project' ? paths.projectFile : paths.userFile;
}

// ── Profile helpers ─────────────────────────────────────────────

/**
 * Get the stored "active" profile from config.activeProfileId.
 * Pure read — returns undefined if no profile is found.
 *
 * The ConfigStore defaults (createDefaultConfig) ensure at least
 * one 'default' profile always exists, so undefined is an edge case
 * when all profiles were explicitly deleted.
 */
export function getActiveProfile(): CompactionProfile | undefined {
	const config = store.get();
	const profile = config.profiles[config.activeProfileId];
	if (profile) return profile;

	const firstKey = Object.keys(config.profiles)[0];
	if (firstKey) return config.profiles[firstKey];

	return undefined;
}

/**
 * Get the effective profile for the given model spec.
 *
 * Uses model-aware matching: picks the profile whose matchModel best matches
 * the given model spec. Falls back to getActiveProfile() if no match.
 *
 * @param modelSpec  Provider/model string (e.g. "openai/gpt-4o")
 */
export function getEffectiveProfile(modelSpec?: string): CompactionProfile | undefined {
	const config = store.get();
	const best = selectBestProfile(config, modelSpec);
	return best ?? getActiveProfile();
}

export function setActiveProfile(profileId: string, scope: SaveScope = getActiveScope()): boolean {
	const config = store.get();
	if (!config.profiles[profileId]) return false;
	// 只更新目标层文件的 activeProfileId，保留该层其它内容
	const raw = readLayerRaw(scope) ?? {};
	raw.activeProfileId = profileId;
	return writeLayer(scope, raw);
}

export function upsertProfile(
	profile: CompactionProfile,
	scope: SaveScope = getActiveScope(),
): boolean {
	// 只更新目标层文件中的该 profile，保留该层其它内容（含其它层无关）
	const raw = readLayerRaw(scope) ?? {};
	const profiles = (
		raw.profiles && typeof raw.profiles === 'object' ? raw.profiles : {}
	) as Record<string, unknown>;
	profiles[profile.id] = profile;
	raw.profiles = profiles;
	if (typeof raw.activeProfileId !== 'string' || !(raw.activeProfileId in profiles)) {
		raw.activeProfileId = profile.id;
	}
	return writeLayer(scope, raw);
}

/**
 * 字段级更新目标层中的 profile：只把传入的字段合并进该 profile 在目标层的
 * 定义，保留该 profile 在目标层的其它字段（及合并视图中的低层字段）。
 *
 * 与 upsertProfile 的区别：upsertProfile 写入「完整 profile 对象」，会把
 * 合并视图（含低层字段值）整体固化到目标层；updateProfileFields 只落差异字段，
 * 供 settings panel 在编辑单个字段时使用，避免低层 profile 被固化/遮蔽。
 */
export function updateProfileFields(
	profileId: string,
	partial: ProfileFieldPartial,
	scope: SaveScope = getActiveScope(),
): boolean {
	const raw = readLayerRaw(scope) ?? {};
	const profiles = (
		raw.profiles && typeof raw.profiles === 'object' ? raw.profiles : {}
	) as Record<string, unknown>;
	const existing =
		profiles[profileId] && typeof profiles[profileId] === 'object'
			? (profiles[profileId] as Record<string, unknown>)
			: {};
	// id 始终保证存在（避免目标层出现无 id 的残缺 profile）
	// 复合字段（trigger/mechanism）做子字段级深合并：只更新 partial 中出现的子字段，
	// 保留目标层已有子字段——避免把合并视图中的低层字段值整体固化到目标层。
	const partialAny = partial as Record<string, unknown>;
	const merged: Record<string, unknown> = { ...existing, id: profileId };
	for (const [k, v] of Object.entries(partialAny)) {
		if ((k === 'trigger' || k === 'mechanism') && v && typeof v === 'object') {
			const existingSub =
				existing[k] && typeof existing[k] === 'object'
					? (existing[k] as Record<string, unknown>)
					: {};
			const mergedSub: Record<string, unknown> = { ...existingSub };
			for (const [sk, sv] of Object.entries(v as Record<string, unknown>)) {
				// 子字段清除（undefined）→ null（显式空覆盖）：JSON.stringify 会丢弃 undefined，
				// 若不转换，目标层文件无变化且合并视图仍显示低层继承值（静默 no-op）。
				mergedSub[sk] = sv === undefined ? null : sv;
			}
			merged[k] = mergedSub;
		} else {
			// 顶层字段清除（undefined）→ null：同上，null 在 deepMerge 中覆盖低层值，
			// 消费侧（modelMatchScore/selectBestProfile/面板显示）均按 falsy 处理，语义等价于 undefined。
			merged[k] = v === undefined ? null : v;
		}
	}
	profiles[profileId] = merged;
	raw.profiles = profiles;
	if (typeof raw.activeProfileId !== 'string' || !(raw.activeProfileId in profiles)) {
		raw.activeProfileId = profileId;
	}
	return writeLayer(scope, raw);
}

export function deleteProfile(profileId: string): boolean {
	const config = store.get();
	const keys = Object.keys(config.profiles);
	if (keys.length <= 1) return false;
	if (!config.profiles[profileId]) return false;

	// 从所有层删除该 profile 的定义（无论它定义在哪层都能删掉）。
	// 跨层删除是「多文件事务」：先收集全部待写层 + 原始内容备份，
	// 再逐个写入；任一层写失败 → 回滚已写层，避免部分删除（前层已删、后层保留）。
	const pending: Array<{
		scope: SaveScope;
		raw: Record<string, unknown>;
		backup: Record<string, unknown>;
	}> = [];
	for (const scope of ['user', 'session', 'project'] as const) {
		const raw = readLayerRaw(scope);
		if (!raw?.profiles || typeof raw.profiles !== 'object') continue;
		const profiles = raw.profiles as Record<string, unknown>;
		if (!(profileId in profiles)) continue;
		const backup = structuredClone(raw) as Record<string, unknown>;
		delete profiles[profileId];
		if (raw.activeProfileId === profileId) {
			raw.activeProfileId = Object.keys(profiles)[0] ?? 'default';
		}
		pending.push({ scope, raw, backup });
	}
	if (pending.length === 0) return false;

	for (let i = 0; i < pending.length; i++) {
		if (!writeLayer(pending[i].scope, pending[i].raw)) {
			// 回滚已写层（恢复原始内容）
			for (let j = 0; j < i; j++) {
				writeLayer(pending[j].scope, pending[j].backup);
			}
			return false;
		}
	}
	return true;
}
