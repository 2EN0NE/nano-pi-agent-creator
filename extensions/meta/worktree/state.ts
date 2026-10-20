/**
 * pi-worktree — 用户偏好配置（使用 @zenone/pi-config）
 *
 * 不再存储活跃 worktree 状态——活跃状态从 ctx.cwd 推导。
 * 只存偏好：上次 node_modules 策略。
 */
import { createLogger } from '@zenone/pi-logger';
import { createConfigStore } from '@zenone/pi-config';
import type { ConfigStore } from '@zenone/pi-config';
import type { NodeModulesStrategy } from './types.js';

const log = createLogger('pi-worktree');

interface WorktreePrefs {
	lastNodeModulesStrategy: NodeModulesStrategy;
	lastSymlinkTargetIds: string[];
}

const DEFAULT_PREFS: WorktreePrefs = {
	lastNodeModulesStrategy: 'symlink',
	lastSymlinkTargetIds: ['husky', 'pi', 'node_modules'],
};

let store: ConfigStore<WorktreePrefs> | null = null;
let cached: WorktreePrefs = { ...DEFAULT_PREFS };

function getStore(): ConfigStore<WorktreePrefs> {
	if (!store) {
		// config-scope: session-cwd —— 偏好（上次选择的策略）描述的是「当前目录」的使用习惯，
		// 不是仓库事实，且只写用户级（save(..., 'user')）。组声明（仓库级）走 groups.ts 的
		// 仓库根锚点。见 AGENTS.md「项目级配置的解析锚点：仓库级 vs 目录级【强制判断】」。
		store = createConfigStore<WorktreePrefs>({
			pluginName: 'pi-worktree',
			defaults: DEFAULT_PREFS,
		});
		initCache();
	}
	return store;
}

function initCache(): void {
	try {
		cached = { ...DEFAULT_PREFS, ...getStore().get() };
	} catch (err) {
		log.warn('failed to load prefs, using defaults', {
			error: String(err),
		});
	}
}

// ── 读取 ──

export function getLastNodeModulesStrategy(): NodeModulesStrategy {
	return cached.lastNodeModulesStrategy;
}

export function getLastSymlinkTargetIds(): string[] {
	return cached.lastSymlinkTargetIds;
}

// ── 写入 ──

export function setLastNodeModulesStrategy(strategy: NodeModulesStrategy): void {
	cached.lastNodeModulesStrategy = strategy;
	try {
		getStore().save(cached, 'user');
	} catch (err) {
		log.warn('failed to save lastNodeModulesStrategy pref', {
			error: String(err),
		});
	}
}

export function setLastSymlinkTargetIds(ids: string[]): void {
	cached.lastSymlinkTargetIds = ids;
	try {
		getStore().save(cached, 'user');
	} catch (err) {
		log.warn('failed to save lastSymlinkTargetIds pref', {
			error: String(err),
		});
	}
}

// ── 初始加载 ──

/** 在 session_start 调用，初始化偏好缓存 */
export function initPrefs(): void {
	getStore();
}
