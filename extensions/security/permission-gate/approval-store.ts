/**
 * permission-gate — 放行规则三级持久化（T4，ADR-0025）
 *
 * 放行规则（graduated 确认计数）按危险等级沉淀到不同持久化层级：
 *   - critical → 会话级（跟随 sessionId 落盘，/reload 后仍生效；超期文件由 cleanupRulesStore 清理）
 *   - warning  → 项目级
 *   - info     → 用户级
 *
 * 基于 pi-state 的 createStateStore（分层路径 + 原子 IO），
 * 累加采用"读单层 → 增量 → 写回该层"，避免跨层 key 污染。
 *
 * ⚠ 会话层文件（<sessionId>.json）与同插件 manual-strategies store 共享：
 *   写入必须保留未属字段（见 upsert/deleteRuleKey 的 {...layer, ...} 写法），
 *   严禁整体覆盖写。共存行为有测试锁定（approval-store.test）。
 */

import { createStateStore, readJsonFile, writeJsonAtomic } from '@zenone/pi-state';
import type { CleanupExpiredResult, StateStore } from '@zenone/pi-state';
import { createLogger } from '@zenone/pi-logger';
import type { DangerTier } from './config.js';

const log = createLogger('permission-gate:approval-store');

interface ApprovalRulesState {
	counts: Record<string, number>;
}

const TIER_SCOPE: Record<DangerTier, 'session' | 'project' | 'user'> = {
	critical: 'session',
	warning: 'project',
	info: 'user',
};

const SCOPE_FILE = {
	session: 'sessionFile',
	project: 'projectFile',
	user: 'userFile',
} as const;

let store: StateStore<ApprovalRulesState> | null = null;

function getStore(): StateStore<ApprovalRulesState> {
	if (!store) {
		store = createStateStore<ApprovalRulesState>({
			pluginName: 'permission-gate',
			defaults: { counts: {} },
			// 放行规则与 gate 配置是 ADR-0027 建模的两个独立存储：
			// 用独立文件避免 saveConfig 整体覆盖 config.json 时清空放行计数。
			fileName: 'state.json',
		});
	}
	return store;
}

/** 测试专用：用注入的 homeDir/cwd 重建 store，隔离真实用户目录 */
export function resetRulesStore(opts?: { homeDir?: string; cwd?: string }): void {
	store = createStateStore<ApprovalRulesState>({
		pluginName: 'permission-gate',
		defaults: { counts: {} },
		fileName: 'state.json',
		homeDir: opts?.homeDir,
		cwd: opts?.cwd,
	});
}

/** 设置会话 ID（session_start 时调用，启用会话层） */
export function setRulesSessionId(sessionId: string | null): void {
	getStore().setSessionId(sessionId);
}

/** 会话结束清理 critical 的会话级放行规则 */
export function clearSessionRules(): boolean {
	return getStore().clearSession();
}

/**
 * 清理过期的会话级放行规则文件（默认保留 30 天，mtime 超期删除）。
 * 本 store 的 fileName 为 state.json（自动保留）；同插件目录下还有
 * manual-strategies store 的 manual-strategies.json，必须显式保留，
 * 否则会被误当作过期会话文件删除（用户级/项目级手动策略是永久状态）。
 */
export function cleanupRulesStore(maxAgeDays = 30): CleanupExpiredResult {
	return getStore().cleanupExpired(maxAgeDays, ['manual-strategies.json']);
}

/** 合并读取三层 counts（session 覆盖 project 覆盖 user，key 不跨层重叠） */
export function getRuleCounts(): Record<string, number> {
	return getStore().get().counts;
}

/** 单个放行规则计数及其所在持久化层级 */
export interface ScopedCount {
	count: number;
	scope: 'session' | 'project' | 'user';
}

/**
 * 按 key 返回计数与其所在持久化层级（session/project/user），供 UI 展示放行规则的
 * 生效范围（ADR-0025：危险等级越高，信任越不持久）。
 *
 * 按 user → project → session 顺序叠加，与 pi-state `get()` 的层级合并优先级一致
 * （session 优先级最高，覆盖同 key 的低层）。
 */
export function getRuleCountsWithScope(): Record<string, ScopedCount> {
	const paths = getStore().getPaths();
	const result: Record<string, ScopedCount> = {};
	const layers: Array<{ file: string | undefined; scope: ScopedCount['scope'] }> = [
		{ file: paths.userFile, scope: 'user' },
		{ file: paths.projectFile, scope: 'project' },
		{ file: paths.sessionFile, scope: 'session' },
	];
	for (const { file, scope } of layers) {
		if (!file) continue;
		const layer = readJsonFile(file);
		const counts = (layer?.counts as Record<string, number> | undefined) ?? {};
		for (const [k, v] of Object.entries(counts)) {
			result[k] = { count: v, scope };
		}
	}
	return result;
}

/** 三层放行规则计数的完整分层视图（各层独立，同名 key 可同时出现在多层） */
export interface RuleCountsByLayer {
	session: Record<string, number>;
	project: Record<string, number>;
	user: Record<string, number>;
}

/**
 * 按层返回三层各自的完整计数，不做跨层遮蔽合并（ADR-0029）。
 * 供 UI 分层展示使用；判定层仍用 getRuleCounts() 的保守合并。
 */
export function getRuleCountsByLayer(): RuleCountsByLayer {
	const paths = getStore().getPaths();
	const result: RuleCountsByLayer = { session: {}, project: {}, user: {} };
	const layers: Array<{
		file: string | undefined;
		scope: keyof RuleCountsByLayer;
	}> = [
		{ file: paths.sessionFile, scope: 'session' },
		{ file: paths.projectFile, scope: 'project' },
		{ file: paths.userFile, scope: 'user' },
	];
	for (const { file, scope } of layers) {
		if (!file) continue;
		const layer = readJsonFile(file);
		const counts = (layer?.counts as Record<string, number> | undefined) ?? {};
		result[scope] = counts;
	}
	return result;
}

/**
 * 记录一次确认，累加三个维度的计数到对应 tier 的层级。
 * 读单层 → 增量 → 写回，避免把其他层的 key 复制进来。
 */
export function recordApproval(tier: DangerTier, keys: string[]): void {
	const scope = TIER_SCOPE[tier];
	const paths = getStore().getPaths();
	const file = paths[SCOPE_FILE[scope]];
	if (!file) {
		log.warn('recordApproval to %s scope requires session id', scope);
		return;
	}
	const layer = readJsonFile(file) ?? {};
	const layerCounts = (layer.counts as Record<string, number> | undefined) ?? {};
	const updated = { ...layerCounts };
	for (const k of keys) {
		updated[k] = (updated[k] ?? 0) + 1;
	}
	getStore().upsert({ counts: updated }, scope);
}

/** 重载（/reload 或 config 变更后） */
export function reloadRules(): void {
	getStore().reload();
}

/**
 * 批量导入计数（迁移旧 approvalCounts 用）——按 tier 累加到对应层。
 * 与 recordApproval 的区别：支持累加任意 N（而非每次 +1）。
 */
export function importRuleCounts(counts: Record<string, number>, tier: DangerTier): void {
	const scope = TIER_SCOPE[tier];
	const paths = getStore().getPaths();
	const file = paths[SCOPE_FILE[scope]];
	if (!file) {
		log.warn('importRuleCounts to %s scope requires session id', scope);
		return;
	}
	const layer = readJsonFile(file) ?? {};
	const layerCounts = (layer.counts as Record<string, number> | undefined) ?? {};
	const updated = { ...layerCounts };
	for (const [k, v] of Object.entries(counts)) {
		updated[k] = (updated[k] ?? 0) + v;
	}
	getStore().upsert({ counts: updated }, scope);
}

/**
 * 删除一个计数 key（跨三层：session/project/user）。
 * 用于策略 tab 的"删除策略"——只清信任计数，审计日志物理保留（ADR-0027 审计完整性）。
 *
 * @returns 是否删除了至少一个 key
 */
export function deleteRuleKey(key: string): boolean {
	const store = getStore();
	const paths = store.getPaths();
	let deleted = false;
	for (const file of [paths.sessionFile, paths.projectFile, paths.userFile]) {
		if (!file) continue;
		const layer = readJsonFile(file);
		if (!layer) continue;
		const counts = (layer.counts as Record<string, number> | undefined) ?? {};
		if (!(key in counts)) continue;
		const { [key]: _removed, ...rest } = counts;
		writeJsonAtomic(file, { ...layer, counts: rest });
		deleted = true;
	}
	if (deleted) store.reload();
	return deleted;
}

/**
 * 按层删除一个计数 key（ADR-0029）：只删除指定层（session/project/user）的该 key，
 * 其余层不受影响。用于策略面板分层视图下的「仅本层」删除。
 *
 * @returns 是否删除了目标层的该 key
 */
export function deleteRuleKeyScoped(key: string, scope: 'session' | 'project' | 'user'): boolean {
	const store = getStore();
	const paths = store.getPaths();
	const file = paths[SCOPE_FILE[scope]];
	if (!file) return false;
	const layer = readJsonFile(file);
	if (!layer) return false;
	const counts = (layer.counts as Record<string, number> | undefined) ?? {};
	if (!(key in counts)) return false;
	const { [key]: _removed, ...rest } = counts;
	writeJsonAtomic(file, { ...layer, counts: rest });
	store.reload();
	return true;
}

/**
 * 把一条放行计数从源层迁移到目标层（ADR-0030：策略面板 m 键调级）。
 * 迁移语义：源层删、目标层累加（非复制），保留审计。
 *
 * @returns 是否迁移成功（源层存在该 key 且目标层写成功）
 */
export function moveRuleKey(
	key: string,
	fromScope: 'session' | 'project' | 'user',
	toScope: 'session' | 'project' | 'user',
): boolean {
	if (fromScope === toScope) return false;
	const store = getStore();
	const paths = store.getPaths();
	const fromFile = paths[SCOPE_FILE[fromScope]];
	const toFile = paths[SCOPE_FILE[toScope]];
	if (!fromFile || !toFile) return false;

	const fromLayer = readJsonFile(fromFile);
	if (!fromLayer) return false;
	const fromCounts = (fromLayer.counts as Record<string, number> | undefined) ?? {};
	if (!(key in fromCounts)) return false;
	const count = fromCounts[key];

	// 源层删除该 key
	const { [key]: _removed, ...fromRest } = fromCounts;
	writeJsonAtomic(fromFile, { ...fromLayer, counts: fromRest });

	// 目标层累加该 key
	const toLayer = readJsonFile(toFile) ?? {};
	const toCounts = (toLayer.counts as Record<string, number> | undefined) ?? {};
	toCounts[key] = (toCounts[key] ?? 0) + count;
	writeJsonAtomic(toFile, { ...toLayer, counts: toCounts });

	store.reload();
	return true;
}
