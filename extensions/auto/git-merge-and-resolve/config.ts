/**
 * Git Merge and Resolve — 配置引擎
 *
 * 配置层级（优先级递增）：
 *   1. 默认配置（embedded defaults）
 *   2. 用户级配置（~/.pi/agent/extensions-data/git-merge-and-resolve/config.json）
 *   3. 项目级配置（<cwd>/.pi/extensions-data/git-merge-and-resolve/config.json）
 *
 * 优先级：项目级 > 用户级 > 默认值（逐层 deepMerge）
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createLogger } from '@zenone/pi-logger';

const log = createLogger('git-merge-and-resolve:config');

// ============================================================================
// 类型定义
// ============================================================================

export interface GitMergeConfig {
	/** 是否启用自动 fetch+merge */
	enabled: boolean;
	/** 是否在对话中推送合并/冲突通知 */
	notifications: boolean;
	/** 是否在底部 widget 展示当前状态 */
	showWidget: boolean;
}

// ============================================================================
// 默认配置
// ============================================================================

const DEFAULT_CONFIG: GitMergeConfig = {
	enabled: false,
	notifications: true,
	showWidget: true,
};

// ============================================================================
// 路径常量
// ============================================================================

const PLUGIN_NAME = 'git-merge-and-resolve';

/** 用户级配置目录 */
const USER_CONFIG_DIR = join(homedir(), '.pi', 'agent', 'extensions-data', PLUGIN_NAME);
/** 用户级配置文件名 */
const USER_CONFIG_FILE = join(USER_CONFIG_DIR, 'config.json');

/** 项目级配置目录（相对于 cwd） */
function getProjectConfigDir(cwd: string): string {
	return join(cwd, '.pi', 'extensions-data', PLUGIN_NAME);
}

/** 项目级配置文件名 */
function getProjectConfigFile(cwd: string): string {
	return join(getProjectConfigDir(cwd), 'config.json');
}

// ============================================================================
// 公共函数
// ============================================================================

/**
 * 解析项目级或用户级配置文件的完整路径。
 */
export function resolveConfigPath(cwd: string, scope: 'project' | 'user'): string {
	return scope === 'project' ? getProjectConfigFile(cwd) : USER_CONFIG_FILE;
}

/**
 * 确保配置目录存在（含父目录递归创建）。
 */
export function ensureConfigDir(path: string): void {
	const dir = dirname(path);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}

// ============================================================================
// 配置文件加载
// ============================================================================

function loadConfigFile(path: string): Partial<GitMergeConfig> | null {
	try {
		if (!existsSync(path)) return null;
		const raw = readFileSync(path, 'utf-8');
		return JSON.parse(raw) as Partial<GitMergeConfig>;
	} catch (err) {
		log.error('Failed to parse config file: %s', path, err);
		return null;
	}
}

// ============================================================================
// deepMerge — 深度合并
// ============================================================================

export function deepMerge(
	base: GitMergeConfig,
	overrides: Partial<GitMergeConfig>,
): GitMergeConfig {
	return {
		enabled: overrides.enabled ?? base.enabled,
		notifications: overrides.notifications ?? base.notifications,
		showWidget: overrides.showWidget ?? base.showWidget,
	};
}

// ============================================================================
// 加载配置（项目级优先，用户级兜底）
// ============================================================================

export function loadConfig(cwd: string): GitMergeConfig {
	let merged: GitMergeConfig = { ...DEFAULT_CONFIG };

	// 1. 加载用户级配置
	const userConfig = loadConfigFile(USER_CONFIG_FILE);
	if (userConfig) {
		merged = deepMerge(merged, userConfig);
	}

	// 2. 加载项目级配置（优先级最高）
	const projectConfig = loadConfigFile(getProjectConfigFile(cwd));
	if (projectConfig) {
		merged = deepMerge(merged, projectConfig);
	}

	return merged;
}

// ============================================================================
// 保存配置
// ============================================================================

export function saveConfig(cwd: string, config: GitMergeConfig, scope: 'project' | 'user'): void {
	const filePath = resolveConfigPath(cwd, scope);
	ensureConfigDir(filePath);

	const output: Partial<GitMergeConfig> = {
		enabled: config.enabled,
		notifications: config.notifications,
		showWidget: config.showWidget,
	};

	writeFileSync(filePath, JSON.stringify(output, null, 2) + '\n', 'utf-8');
}

// ============================================================================
// 导出默认配置
// ============================================================================

export function getDefaultConfig(): GitMergeConfig {
	return { ...DEFAULT_CONFIG };
}
