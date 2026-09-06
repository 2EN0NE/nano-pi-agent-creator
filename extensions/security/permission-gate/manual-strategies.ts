/**
 * permission-gate — 手动策略存储（ADR-0030）
 *
 * 手动策略是用户在阻断确认框显式拍板创建的放行规则，独立于 graduated 计数。
 * 与 graduated（approval-store 的 counts）两套机制并存，判定时手动策略优先。
 *
 * 基于 pi-state 的三层持久化（session/project/user），独立文件 manual-strategies.json
 * 避免与 graduated 的 state.json 混淆。会话级条目随会话结束清除。
 *
 * ⚠ 会话层文件（<sessionId>.json）与同插件 approval-store 共享：
 *   写入必须保留未属字段（readLayer → writeLayer 的 {...layer, ...} 写法），
 *   严禁整体覆盖写。共存行为有测试锁定（approval-store.test）。
 */

import { createStateStore, readJsonFile, writeJsonAtomic } from '@zenone/pi-state';
import type { CleanupExpiredResult, StateStore } from '@zenone/pi-state';
import { createLogger } from '@zenone/pi-logger';

const log = createLogger('permission-gate:manual-strategies');

type StrategyScope = 'session' | 'project' | 'user';

interface ManualStrategyRecord {
	/** 命令原文（展示用） */
	command: string;
	/** 创建时间 ISO */
	createdAt: string;
}

interface ManualStrategiesState {
	strategies: Record<string, ManualStrategyRecord>;
}

/** 一条手动策略（合并/分层读取时标注 key 与 scope） */
export interface ManualStrategyEntry {
	key: string;
	command: string;
	scope: StrategyScope;
	createdAt: string;
}

const SCOPE_FILE = {
	session: 'sessionFile',
	project: 'projectFile',
	user: 'userFile',
} as const;

const SCOPE_ORDER: StrategyScope[] = ['user', 'project', 'session'];

let store: StateStore<ManualStrategiesState> | null = null;

function getStore(): StateStore<ManualStrategiesState> {
	if (!store) {
		store = createStateStore<ManualStrategiesState>({
			pluginName: 'permission-gate',
			defaults: { strategies: {} },
			fileName: 'manual-strategies.json',
		});
	}
	return store;
}

/** 测试专用：用注入的 homeDir/cwd 重建 store，隔离真实用户目录 */
export function resetManualStrategiesStore(opts?: { homeDir?: string; cwd?: string }): void {
	store = createStateStore<ManualStrategiesState>({
		pluginName: 'permission-gate',
		defaults: { strategies: {} },
		fileName: 'manual-strategies.json',
		homeDir: opts?.homeDir,
		cwd: opts?.cwd,
	});
}

/** 设置会话 ID（session_start 时调用，启用会话层） */
export function setManualStrategiesSessionId(sessionId: string | null): void {
	getStore().setSessionId(sessionId);
}

/** 会话结束清理会话级手动策略 */
export function clearSessionManualStrategies(): boolean {
	return getStore().clearSession();
}

/**
 * 清理过期的会话级手动策略文件（默认保留 30 天，mtime 超期删除）。
 * 本 store 的 fileName 为 manual-strategies.json（自动保留）；同插件目录下还有
 * approval-store 的 state.json，必须显式保留，
 * 否则会被误当作过期会话文件删除（用户级/项目级放行计数是永久状态）。
 */
export function cleanupManualStrategiesStore(maxAgeDays = 30): CleanupExpiredResult {
	return getStore().cleanupExpired(maxAgeDays, ['state.json']);
}

/** 分层读取：各层独立的策略集（同名 key 可同时出现在多层） */
export function getManualStrategiesByLayer(): Record<
	StrategyScope,
	Record<string, ManualStrategyEntry>
> {
	const paths = getStore().getPaths();
	const result: Record<StrategyScope, Record<string, ManualStrategyEntry>> = {
		session: {},
		project: {},
		user: {},
	};
	const layers: Array<{ file: string | undefined; scope: StrategyScope }> = [
		{ file: paths.sessionFile, scope: 'session' },
		{ file: paths.projectFile, scope: 'project' },
		{ file: paths.userFile, scope: 'user' },
	];
	for (const { file, scope } of layers) {
		if (!file) continue;
		const layer = readJsonFile(file);
		const strategies =
			(layer?.strategies as Record<string, ManualStrategyRecord> | undefined) ?? {};
		for (const [key, rec] of Object.entries(strategies)) {
			result[scope][key] = { key, command: rec.command, scope, createdAt: rec.createdAt };
		}
	}
	return result;
}

/** 合并读取三层（session 覆盖 project 覆盖 user） */
export function getManualStrategies(): Record<string, ManualStrategyEntry> {
	const result: Record<string, ManualStrategyEntry> = {};
	for (const scope of SCOPE_ORDER) {
		const layer = getManualStrategiesByLayer()[scope];
		for (const [key, entry] of Object.entries(layer)) {
			result[key] = entry;
		}
	}
	return result;
}

/** 判定辅助：三层合并后是否存在该 key 的手动策略 */
export function hasManualStrategy(key: string): boolean {
	return key in getManualStrategies();
}

/** 读取单层文件（含 strategies 字段，不存在返回 {}） */
function readLayer(file: string | undefined): { strategies: Record<string, ManualStrategyRecord> } {
	if (!file) return { strategies: {} };
	const layer = readJsonFile(file);
	return {
		strategies: (layer?.strategies as Record<string, ManualStrategyRecord> | undefined) ?? {},
	};
}

/** 写单层文件（保留其他字段，只更新 strategies） */
function writeLayer(
	file: string | undefined,
	strategies: Record<string, ManualStrategyRecord>,
): void {
	if (!file) {
		log.warn('writeLayer to %s requires session id', file);
		return;
	}
	const layer = readJsonFile(file) ?? {};
	writeJsonAtomic(file, { ...layer, strategies });
}

/**
 * 添加一条手动策略到指定层。
 * @param key 命令 key（makeCommandKey 语义，如 cmd:hash）
 * @param command 命令原文
 * @param scope 持久化层级
 */
export function addManualStrategy(key: string, command: string, scope: StrategyScope): void {
	const paths = getStore().getPaths();
	const file = paths[SCOPE_FILE[scope]];
	if (!file) {
		log.warn('addManualStrategy to %s scope requires session id', scope);
		return;
	}
	const layer = readLayer(file);
	layer.strategies[key] = { command, createdAt: new Date().toISOString() };
	writeLayer(file, layer.strategies);
	getStore().reload();
}

/** 跨三层删除一条手动策略 */
export function removeManualStrategy(key: string): boolean {
	const paths = getStore().getPaths();
	let removed = false;
	for (const file of [paths.sessionFile, paths.projectFile, paths.userFile]) {
		if (!file) continue;
		const layer = readLayer(file);
		if (!(key in layer.strategies)) continue;
		const { [key]: _removed, ...rest } = layer.strategies;
		writeLayer(file, rest);
		removed = true;
	}
	if (removed) getStore().reload();
	return removed;
}

/** 单层删除一条手动策略 */
export function removeManualStrategyScoped(key: string, scope: StrategyScope): boolean {
	const paths = getStore().getPaths();
	const file = paths[SCOPE_FILE[scope]];
	if (!file) return false;
	const layer = readLayer(file);
	if (!(key in layer.strategies)) return false;
	const { [key]: _removed, ...rest } = layer.strategies;
	writeLayer(file, rest);
	getStore().reload();
	return true;
}

/**
 * 把一条手动策略从源层迁移到目标层（计数迁移语义：源删、目标加，非复制）。
 * @returns 是否迁移成功（源层存在该 key 且目标层写成功）
 */
export function moveManualStrategy(
	key: string,
	fromScope: StrategyScope,
	toScope: StrategyScope,
): boolean {
	if (fromScope === toScope) return false;
	const byLayer = getManualStrategiesByLayer();
	const source = byLayer[fromScope][key];
	if (!source) return false;

	addManualStrategy(key, source.command, toScope);
	const removed = removeManualStrategyScoped(key, fromScope);
	return removed;
}

/** 重载（/reload 或 config 变更后） */
export function reloadManualStrategies(): void {
	getStore().reload();
}
