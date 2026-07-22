/**
 * Permission Gate — 配置引擎
 *
 * 配置层级（优先级递增）：
 *   1. 默认配置（embedded defaults）
 *   2. 用户级配置（~/.pi/agent/extensions-data/permission-gate/config.json）
 *   3. 项目级配置（<cwd>/.pi/extensions-data/permission-gate/config.json）
 *
 * 优先级：项目级 > 用户级 > 默认值（逐层 deepMerge）
 *
 * 使用 @zenone/pi-config 实现统一路径解析与文件 IO。
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createLogger } from '@zenone/pi-logger';
import { deepMerge, resolveConfigPaths, readJsonFile, writeJsonAtomic } from '@zenone/pi-config';

const log = createLogger('permission-gate:config');

// ============================================================================
// 类型定义
// ============================================================================

export interface DynamicPolicyConfig {
	/** 范围：文件夹路径（绝对路径或相对 cwd 的相对路径），默认 "." */
	scope: string;
	/** 自动放行阈值 */
	thresholds: {
		/** 同一指令，默认 2 */
		sameCommand: number;
		/** 同一工具（如 rm），默认 3 */
		sameTool: number;
		/** 同一文件夹前缀，默认 4 */
		sameFolder: number;
	};
}

export interface WidgetOptions {
	/** 是否在状态栏显示 widget */
	show: boolean;
	/** 展示细节：'gate' 仅 gate 级别 | 'full' 含 cmd/tool/folder 详情 */
	detailLevel: 'gate' | 'full';
}

export interface PermissionGateConfig {
	/** 是否启用权限门控 */
	enabled: boolean;
	/** 动态策略是否启用（独立开关） */
	dynamicPolicyEnabled: boolean;
	/** 拦截的命令模式列表（正则字符串数组） */
	patterns: string[];
	/** 动态策略配置 */
	dynamicPolicy: DynamicPolicyConfig;
	/** Widget 显示选项 */
	widget: WidgetOptions;
}

// ============================================================================
// 默认配置
// ============================================================================

const DEFAULT_CONFIG: PermissionGateConfig = {
	enabled: true,
	dynamicPolicyEnabled: false,
	patterns: [
		'\\brm\\s+(-rf?|--recursive)',
		'\\bsudo\\b',
		'\\bchmod\\b',
		'\\b(chmod|chown)\\b.*777',
		'\\bgit\\s+push\\s+.*(--force|--force-with-lease)',
		'\\bgit\\s+reset\\s+--hard',
		'\\bdocker\\s+(rm|rmi|system\\s+prune)\\b',
		'>\\s*/dev/',
		'\\bdd\\s+if=',
		'\\bmkfs\\.',
		'\\bcurl.*\\|\\s*(ba)?sh',
		'\\bwget.*\\|\\s*(ba)?sh',
		'\\beval\\s+',
	],
	dynamicPolicy: {
		scope: '.',
		thresholds: {
			sameCommand: 2,
			sameTool: 3,
			sameFolder: 4,
		},
	},
	widget: {
		show: true,
		detailLevel: 'full',
	},
};

/**
 * 导出 deepMerge（保留签名，底层由 pi-config 实现）。
 * 深度合并两个配置，数组直接覆盖（不 concat），嵌套对象递归。
 */
export { deepMerge };

// ============================================================================
// 公共路径函数
// ============================================================================

/**
 * 解析项目级或用户级配置文件的完整路径。
 * 委托给 @zenone/pi-config 的 resolveConfigPaths。
 */
export function resolveConfigPath(cwd: string, scope: 'project' | 'user'): string {
	const paths = resolveConfigPaths('permission-gate', { cwd });
	return scope === 'project' ? paths.projectFile : paths.userFile;
}

/**
 * 确保配置目录存在（含父目录递归创建）。
 */
export function ensureConfigDir(path: string): void {
	const dir = path.substring(0, path.lastIndexOf('/'));
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}

// ============================================================================
// 加载配置（项目级优先，用户级兜底）
// ============================================================================

/**
 * 从项目级和用户级加载并合并配置。
 *
 * 优先级（高 → 低）：
 *   1. 项目级：<cwd>/.pi/extensions-data/permission-gate/config.json
 *   2. 用户级：~/.pi/agent/extensions-data/permission-gate/config.json
 *   3. 默认值
 *
 * 注意：项目级覆盖用户级，用户级覆盖默认值。
 */
export function loadConfig(cwd: string): PermissionGateConfig {
	const paths = resolveConfigPaths('permission-gate', { cwd });
	let merged: PermissionGateConfig = getDefaultConfig();

	// 1. 用户级
	const userRaw = readJsonFile(paths.userFile);
	if (userRaw !== null) {
		merged = deepMerge(merged, userRaw as Partial<PermissionGateConfig>);
	}

	// 2. 项目级（最高优先级）
	const projectRaw = readJsonFile(paths.projectFile);
	if (projectRaw !== null) {
		merged = deepMerge(merged, projectRaw as Partial<PermissionGateConfig>);
	}

	// 3. scope 相对路径解析为绝对路径
	if (merged.dynamicPolicy.scope && !merged.dynamicPolicy.scope.startsWith('/')) {
		merged.dynamicPolicy.scope = resolve(cwd, merged.dynamicPolicy.scope);
	}

	return merged;
}

// ============================================================================
// 保存配置
// ============================================================================

/**
 * 将配置保存到指定级别的配置文件中。
 * 使用 pi-config 的原子写入（tmp + rename）。
 *
 * @param cwd 当前工作目录
 * @param config 要保存的配置（完整对象）
 * @param scope 保存范围：'project' 或 'user'
 */
export function saveConfig(
	cwd: string,
	config: PermissionGateConfig,
	scope: 'project' | 'user',
): void {
	const filePath = resolveConfigPath(cwd, scope);
	ensureConfigDir(filePath);

	const output: Partial<PermissionGateConfig> = {
		enabled: config.enabled,
		dynamicPolicyEnabled: config.dynamicPolicyEnabled,
		patterns: config.patterns,
		dynamicPolicy: config.dynamicPolicy,
		widget: config.widget,
	};

	writeJsonAtomic(filePath, output);
}

// ============================================================================
// 计数 key 生成（domain 逻辑，原地保留）
// ============================================================================

/**
 * 生成同一指令的计数 key。
 * 对命令做标准化（去首尾空格、去换行）后取 SHA256 前缀。
 */
export function makeCommandKey(command: string): string {
	const normalized = command.trim().replace(/\s+/g, ' ');
	const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 16);
	return `cmd:${hash}`;
}

/**
 * 生成同一工具的计数 key。
 */
export function makeToolKey(toolName: string): string {
	return `tool:${toolName}`;
}

/**
 * 生成同一文件夹的计数 key。
 */
export function makeFolderKey(dirPath: string): string {
	// 标准化路径：去除尾部斜杠
	const normalized = dirPath.replace(/\/+$/, '');
	return `dir:${normalized}`;
}

// ============================================================================
// 导出默认配置（供其他模块使用）
// ============================================================================

export function getDefaultConfig(): PermissionGateConfig {
	return {
		...DEFAULT_CONFIG,
		dynamicPolicy: {
			...DEFAULT_CONFIG.dynamicPolicy,
			thresholds: { ...DEFAULT_CONFIG.dynamicPolicy.thresholds },
		},
	};
}
