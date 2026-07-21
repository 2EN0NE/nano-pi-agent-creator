/**
 * Permission Gate — 配置引擎
 *
 * 配置层级（优先级递增）：
 *   1. 默认配置（embedded defaults）
 *   2. 用户级配置（~/.pi/agent/extensions-data/permission-gate/config.json）
 *   3. 项目级配置（<cwd>/.pi/extensions-data/permission-gate/config.json）
 *
 * 优先级：项目级 > 用户级 > 默认值（逐层 deepMerge）
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createLogger } from '@zenone/pi-logger';

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

// ============================================================================
// 路径解析
// ============================================================================

/** 用户级配置目录 */
const USER_CONFIG_DIR = join(homedir(), '.pi', 'agent', 'extensions-data', 'permission-gate');
/** 用户级配置文件名 */
const USER_CONFIG_FILE = join(USER_CONFIG_DIR, 'config.json');

/** 项目级配置目录（相对于 cwd） */
function getProjectConfigDir(cwd: string): string {
	return join(cwd, '.pi', 'extensions-data', 'permission-gate');
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

function loadConfigFile(path: string): Partial<PermissionGateConfig> | null {
	try {
		if (!existsSync(path)) return null;
		const raw = readFileSync(path, 'utf-8');
		return JSON.parse(raw) as Partial<PermissionGateConfig>;
	} catch (err) {
		log.error('Failed to parse config file: %s', path, err);
		return null;
	}
}

// ============================================================================
// deepMerge — 深度合并
// ============================================================================

/**
 * 深度合并两个配置对象。
 * - 基本类型的属性直接覆盖
 * - patterns 数组直接覆盖（而非 concat）
 * - dynamicPolicy 嵌套对象逐层合并
 * - approvalCounts 对象合并
 */
export function deepMerge(
	base: PermissionGateConfig,
	overrides: Partial<PermissionGateConfig>,
): PermissionGateConfig {
	const result: PermissionGateConfig = {
		enabled: overrides.enabled ?? base.enabled,
		dynamicPolicyEnabled: overrides.dynamicPolicyEnabled ?? base.dynamicPolicyEnabled,
		patterns: overrides.patterns ?? base.patterns,
		dynamicPolicy: {
			scope: overrides.dynamicPolicy?.scope ?? base.dynamicPolicy.scope,
			thresholds: {
				sameCommand:
					overrides.dynamicPolicy?.thresholds?.sameCommand ??
					base.dynamicPolicy.thresholds.sameCommand,
				sameTool:
					overrides.dynamicPolicy?.thresholds?.sameTool ??
					base.dynamicPolicy.thresholds.sameTool,
				sameFolder:
					overrides.dynamicPolicy?.thresholds?.sameFolder ??
					base.dynamicPolicy.thresholds.sameFolder,
			},
		},
		widget: overrides.widget ?? base.widget,
	};

	return result;
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
	// 从默认值开始
	let merged: PermissionGateConfig = { ...DEFAULT_CONFIG };

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

	// 3. 如果 scope 是相对路径，解析为绝对路径
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

	writeFileSync(filePath, JSON.stringify(output, null, 2) + '\n', 'utf-8');
}

// ============================================================================
// 计数 key 生成
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
