/**
 * Git Merge and Resolve — 配置引擎
 *
 * 配置层级（优先级递增）：
 *   1. 默认配置（embedded defaults）
 *   2. 用户级配置（~/.pi/agent/extensions-data/git-merge-and-resolve/config.json）
 *   3. 项目级配置（<cwd>/.pi/extensions-data/git-merge-and-resolve/config.json）
 *
 * 优先级：项目级 > 用户级 > 默认值（逐层 deepMerge）
 *
 * 使用 @zenone/pi-config 实现统一路径解析与文件 IO。
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { deepMerge, resolveConfigPaths, readJsonFile, writeJsonAtomic } from '@zenone/pi-config';

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
// 统一路径解析
// ============================================================================

const PLUGIN_NAME = 'git-merge-and-resolve';

/**
 * 解析项目级或用户级配置文件的完整路径。
 * 委托给 @zenone/pi-config 的 resolveConfigPaths。
 */
export function resolveConfigPath(cwd: string, scope: 'project' | 'user'): string {
	const paths = resolveConfigPaths(PLUGIN_NAME, { cwd });
	return scope === 'project' ? paths.projectFile : paths.userFile;
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

/** 导出统一 deepMerge */
export { deepMerge };

// ============================================================================
// 加载配置（项目级优先，用户级兜底）
// ============================================================================

export function loadConfig(cwd: string): GitMergeConfig {
	const paths = resolveConfigPaths(PLUGIN_NAME, { cwd });
	let merged: GitMergeConfig = { ...DEFAULT_CONFIG };

	// 1. 用户级
	const userRaw = readJsonFile(paths.userFile);
	if (userRaw !== null) {
		merged = deepMerge(merged, userRaw as Partial<GitMergeConfig>);
	}

	// 2. 项目级（最高优先级）
	const projectRaw = readJsonFile(paths.projectFile);
	if (projectRaw !== null) {
		merged = deepMerge(merged, projectRaw as Partial<GitMergeConfig>);
	}

	return merged;
}

// ============================================================================
// 保存配置（使用 pi-config 原子写入）
// ============================================================================

export function saveConfig(cwd: string, config: GitMergeConfig, scope: 'project' | 'user'): void {
	const filePath = resolveConfigPath(cwd, scope);
	ensureConfigDir(filePath);

	const output: Partial<GitMergeConfig> = {
		enabled: config.enabled,
		notifications: config.notifications,
		showWidget: config.showWidget,
	};

	writeJsonAtomic(filePath, output);
}

// ============================================================================
// 导出默认配置
// ============================================================================

export function getDefaultConfig(): GitMergeConfig {
	return { ...DEFAULT_CONFIG };
}
