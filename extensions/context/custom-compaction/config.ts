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
	type TriggerGranularity,
	type RoutingRule,
	createDefaultConfig,
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
// validate: 校验 profiles + 新字段兜底

function validateConfig(raw: unknown): Partial<CompactionConfig> | null {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		return null;
	}
	const parsed = raw as Partial<CompactionConfig>;
	// profiles：字段级校验。缺失时置 undefined 继承低层（分层最小写入下，
	// 高层可只声明 enabledProfileIds / routingRules / triggerGranularity 而
	// 不重定义 profiles）。不再因「无 profiles」丢弃整层——否则 project/session
	// 层仅覆盖 enabledProfileIds（profile 定义在低层）会被整体跳过。
	if (
		parsed.profiles !== undefined &&
		(parsed.profiles === null ||
			typeof parsed.profiles !== 'object' ||
			Array.isArray(parsed.profiles))
	) {
		parsed.profiles = undefined;
	}
	// 新增字段校验：非法值置 undefined（deepMerge 跳过 → 继承 defaults 的默认值）。
	// 迁移靠 defaults 默认值 + merge 继承实现，validate 只读不写盘，天然幂等。
	if (parsed.enabledProfileIds !== undefined) {
		if (!Array.isArray(parsed.enabledProfileIds)) {
			parsed.enabledProfileIds = undefined;
		} else {
			// 仅做元素类型过滤（string），不做存在性过滤——跨层引用合法（高层可
			// 引用低层定义的 profile），幽灵 id 由 getEnabledProfiles 在合并后按
			// config.profiles 过滤，消费侧天然安全。
			parsed.enabledProfileIds = parsed.enabledProfileIds.filter(
				(id) => typeof id === 'string',
			);
			// 启用集非空不变量（ADR-0036 决策 2）：手编空数组（或全非法元素）
			// 过滤后为空 → 置 undefined 继承 defaults，避免自动压缩被静默禁用。
			if (parsed.enabledProfileIds.length === 0) parsed.enabledProfileIds = undefined;
		}
	}
	if (
		parsed.triggerGranularity !== undefined &&
		parsed.triggerGranularity !== 'user_turn' &&
		parsed.triggerGranularity !== 'agent_turn' &&
		parsed.triggerGranularity !== 'tool'
	) {
		parsed.triggerGranularity = undefined;
	}
	if (parsed.routingRules !== undefined) {
		if (!Array.isArray(parsed.routingRules)) {
			parsed.routingRules = undefined;
		} else {
			// 元素级形状校验：丢弃非对象元素、targetProfileId 缺失/非字符串、
			// model 非字符串、complexity 非法枚举值的规则，防止畸形规则在触发
			// 评估（selectProfileFromTriggered → modelMatchScore）时抛 TypeError。
			const rules = parsed.routingRules as unknown[];
			parsed.routingRules = rules.filter((rule): rule is RoutingRule => {
				if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) return false;
				const r = rule as Record<string, unknown>;
				if (typeof r.targetProfileId !== 'string' || r.targetProfileId === '') return false;
				if (r.model !== undefined && typeof r.model !== 'string') return false;
				if (
					r.complexity !== undefined &&
					r.complexity !== 'low' &&
					r.complexity !== 'medium' &&
					r.complexity !== 'high'
				)
					return false;
				return true;
			});
		}
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
	const enabled = getEnabledProfiles();
	const profileName = enabled[0]?.name ?? 'Default';

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
 * 业务代码应使用 upsertProfile / setProfileEnabled / deleteProfile
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
 * Get the profiles in the enabled set (启用集) — profiles the user has toggled
 * on via Space in the settings panel. These are the candidates evaluated by
 * the proactive trigger (第一道闸). Order follows config.profiles definition
 * order.
 */
export function getEnabledProfiles(): CompactionProfile[] {
	const config = store.get();
	return config.enabledProfileIds
		.map((id) => config.profiles[id])
		.filter((p): p is CompactionProfile => p !== undefined);
}

/**
 * Toggle a profile's membership in the enabled set (Space in settings panel).
 * Returns false when the profile doesn't exist, or when disabling the last
 * enabled profile (启用集不得为空 — caller should notify the user).
 */
export function setProfileEnabled(
	profileId: string,
	enabled: boolean,
	scope: SaveScope = getActiveScope(),
): boolean {
	const config = store.get();
	if (!config.profiles[profileId]) return false;

	const current = config.enabledProfileIds;
	let next: string[];
	if (enabled) {
		next = current.includes(profileId) ? current : [...current, profileId];
	} else {
		if (!current.includes(profileId)) return true; // 已停用，幂等
		if (current.length <= 1) return false; // 至少保留一个启用项
		next = current.filter((id) => id !== profileId);
	}

	const raw = readLayerRaw(scope) ?? {};
	raw.enabledProfileIds = next;
	return writeLayer(scope, raw);
}

/**
 * Read the trigger granularity (触发粒度，ADR-0036). Defaults to 'agent_turn'
 * via createDefaultConfig when not overridden.
 */
export function getTriggerGranularity(): TriggerGranularity {
	return store.get().triggerGranularity;
}

/**
 * Set the trigger granularity (settings 面板 g 键循环切换).
 */
export function setTriggerGranularity(
	granularity: TriggerGranularity,
	scope: SaveScope = getActiveScope(),
): boolean {
	const raw = readLayerRaw(scope) ?? {};
	raw.triggerGranularity = granularity;
	return writeLayer(scope, raw);
}

/** 整表写入路由规则（有序，首条命中生效） */
export function setRoutingRules(
	rules: RoutingRule[],
	scope: SaveScope = getActiveScope(),
): boolean {
	const raw = readLayerRaw(scope) ?? {};
	raw.routingRules = rules;
	return writeLayer(scope, raw);
}

/** 追加一条路由规则（尾部） */
export function addRoutingRule(rule: RoutingRule, scope: SaveScope = getActiveScope()): boolean {
	return setRoutingRules([...store.get().routingRules, rule], scope);
}

/** 按索引删除一条路由规则 */
export function deleteRoutingRule(index: number, scope: SaveScope = getActiveScope()): boolean {
	const rules = store.get().routingRules;
	if (index < 0 || index >= rules.length) return false;
	return setRoutingRules(
		rules.filter((_, i) => i !== index),
		scope,
	);
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
			// 消费侧（modelMatchScore/面板显示）均按 falsy 处理，语义等价于 undefined。
			merged[k] = v === undefined ? null : v;
		}
	}
	profiles[profileId] = merged;
	raw.profiles = profiles;
	return writeLayer(scope, raw);
}

export function deleteProfile(profileId: string): boolean {
	const config = store.get();
	const keys = Object.keys(config.profiles);
	if (keys.length <= 1) return false;
	if (!config.profiles[profileId]) return false;
	const remainingIds = keys.filter((id) => id !== profileId);

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
		if (Array.isArray(raw.enabledProfileIds)) {
			const filtered = raw.enabledProfileIds.filter((id) => id !== profileId);
			// 启用集非空不变量（ADR-0036 决策 2）：该层过滤后为空时回填剩余第一个
			// profile，避免删除唯一启用项后自动压缩被静默禁用。
			raw.enabledProfileIds =
				filtered.length === 0 && remainingIds.length > 0 ? [remainingIds[0]] : filtered;
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
