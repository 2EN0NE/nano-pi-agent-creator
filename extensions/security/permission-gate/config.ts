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
import { DANGER_COMMAND_NOTES, DEFAULT_PATTERN_NOTES, PERMISSION_COMMAND_NOTES } from './notes.js';

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

/** 危险分级（ADR-0025）：决定放行规则可沉淀的最高持久化层级 */
export type DangerTier = 'critical' | 'warning' | 'info';

/** 带级别的拦截模式（patterns 从 string[] 升级为 PatternEntry[]） */
export interface PatternEntry {
	/** 正则字符串 */
	pattern: string;
	/** 命中该 pattern 的级别 */
	tier: DangerTier;
	/** 命中原因说明（可选，未写时展示层落分类兜底文案） */
	note?: string;
}

/** 带解释的命令清单条目（dangerCommands / permissionCommands 从 string[] 对象化） */
export interface CommandEntry {
	/** 命令名（如 dd、chmod） */
	command: string;
	/** 命中原因说明（可选，内置命令由 notes.ts 注入官方文案） */
	note?: string;
}

/** 路径空间（ADR-0025）：两层判定 */
export interface PathSurfacesConfig {
	/** 系统目录层：写 = critical、读 = warning */
	systemDirs: string[];
	/** 敏感凭证层：读 = 写 = critical */
	credentialFiles: string[];
}

export interface PermissionGateConfig {
	/** 是否启用权限门控 */
	enabled: boolean;
	/** 动态策略是否启用（独立开关），默认开启（ADR-0030） */
	dynamicPolicyEnabled: boolean;
	/** 手动创建策略时的默认沉淀层级，默认会话级（ADR-0030） */
	defaultPersistenceScope: 'session' | 'project' | 'user';
	/** 拦截的命令模式列表（带级别） */
	patterns: PatternEntry[];
	/** 危险命令清单（dd/mkfs/iptables 等，命令字面匹配一律 critical） */
	dangerCommands: CommandEntry[];
	/** 权限相关命令清单（chmod/sudo 等，一律 critical） */
	permissionCommands: CommandEntry[];
	/** 路径空间（系统目录层 + 敏感凭证层） */
	pathSurfaces: PathSurfacesConfig;
	/** 动态策略配置 */
	dynamicPolicy: DynamicPolicyConfig;
	/** Widget 显示选项 */
	widget: WidgetOptions;
}

// ============================================================================
// 默认配置
// ============================================================================

/**
 * 块设备写拦截模式（收窄版，ADR-0025 补充）。
 *
 * 仅匹配真实块设备/raw 设备前缀，避免误伤 `2>/dev/null`、`>/dev/null` 等无害重定向。
 * `disk`/`mapper` 覆盖 `/dev/disk/by-*`、`/dev/mapper/*` 等 udev 别名路径。
 * 与 tiering.ts 的路径空间层（matchSystemDir）覆盖范围保持一致，作为 tree-sitter
 * 解析失败时的纵深防御兜底。
 */
const BLOCK_DEVICE_WRITE_PATTERN =
	'>\\s*/dev/(sd[a-z]|nvme|vd[a-z]|hd[a-z]|xvd[a-z]|dm-\\d+|mmcblk|loop|md|sr|ram|zram|disk|mapper)';

/**
 * 旧版宽泛 /dev 拦截模式（本次收窄之前）。
 * 已通过设置面板持久化过配置的用户，其 config.json 中可能仍固化此值，
 * 由 migratePatternContent() 在加载时迁移为收窄后的 BLOCK_DEVICE_WRITE_PATTERN。
 */
const LEGACY_DEV_WRITE_PATTERN = '>\\s*/dev/';

const DEFAULT_CONFIG: PermissionGateConfig = {
	enabled: true,
	dynamicPolicyEnabled: true,
	defaultPersistenceScope: 'session',
	patterns: [
		{ pattern: '\\brm\\s+(-rf?|--recursive)', tier: 'critical' },
		{
			pattern: BLOCK_DEVICE_WRITE_PATTERN,
			tier: 'critical',
		},
		{ pattern: '\\bgit\\s+push\\s+.*(--force|--force-with-lease)', tier: 'warning' },
		{ pattern: '\\bgit\\s+reset\\s+--hard', tier: 'warning' },
		{ pattern: '\\bdocker\\s+(rm|rmi|system\\s+prune)\\b', tier: 'warning' },
		{ pattern: '\\bcurl.*\\|\\s*(ba)?sh', tier: 'warning' },
		{ pattern: '\\bwget.*\\|\\s*(ba)?sh', tier: 'warning' },
		{ pattern: '\\beval\\s+', tier: 'warning' },
	],
	dangerCommands: [
		{ command: 'dd' },
		{ command: 'mkfs' },
		{ command: 'fdisk' },
		{ command: 'parted' },
		{ command: 'wipefs' },
		{ command: 'shred' },
		{ command: 'blkdiscard' },
		{ command: 'iptables' },
		{ command: 'nftables' },
		{ command: 'ip6tables' },
		{ command: 'arptables' },
		{ command: 'shutdown' },
		{ command: 'reboot' },
		{ command: 'halt' },
		{ command: 'poweroff' },
	],
	permissionCommands: [
		{ command: 'chmod' },
		{ command: 'chown' },
		{ command: 'chgrp' },
		{ command: 'sudo' },
		{ command: 'su' },
		{ command: 'setfacl' },
		{ command: 'getfacl' },
		{ command: 'chattr' },
		{ command: 'lsattr' },
		{ command: 'usermod' },
		{ command: 'useradd' },
		{ command: 'userdel' },
		{ command: 'groupmod' },
		{ command: 'groupadd' },
		{ command: 'groupdel' },
		{ command: 'mount' },
		{ command: 'umount' },
		{ command: 'passwd' },
		{ command: 'visudo' },
		{ command: 'setcap' },
		{ command: 'getcap' },
		{ command: 'chroot' },
	],
	pathSurfaces: {
		systemDirs: [
			'/etc',
			'/usr',
			'/boot',
			'/lib',
			'/lib64',
			'/sbin',
			'/bin',
			'/sys',
			'/proc',
			'/dev',
		],
		credentialFiles: [
			'~/.ssh',
			'~/.aws',
			'~/.kube',
			'~/.gnupg',
			'/etc/passwd',
			'/etc/shadow',
			'/etc/sudoers',
			'/etc/gshadow',
			'.env',
			'*.pem',
			'*.key',
			'id_rsa',
			'id_ed25519',
			'id_dsa',
			'.netrc',
		],
	},
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
	const dir = dirname(path);
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

/**
 * 迁移单个 pattern 的内容（一次性内容版本迁移）。
 *
 * 本次将默认 pattern 中宽泛的 /dev 写入拦截模式收窄为块设备前缀，避免 2>/dev/null
 * 等无害重定向被误报。已持久化过配置的用户，其 config.json 仍固化旧宽泛模式；
 * 这里在加载时把旧值替换为收窄后的模式，确保修复对所有用户生效，而非仅对使用默认配置的用户生效。
 */
function migratePatternContent(pattern: string): string {
	return pattern === LEGACY_DEV_WRITE_PATTERN ? BLOCK_DEVICE_WRITE_PATTERN : pattern;
}

/**
 * 迁移旧格式 patterns（string[]）→ 新格式（PatternEntry[]）。
 * 旧 string 默认归 warning（行为保守，不自动升级为 critical）。
 * 已是新格式则原样返回；格式无法识别返回 null（保持 deepMerge 覆盖语义）。
 * 每个 pattern 内容再经 migratePatternContent 做一次性内容版本迁移。
 */
function migratePatterns(patterns: unknown): PatternEntry[] | null {
	if (!Array.isArray(patterns)) return null;
	const migrated: PatternEntry[] = [];
	for (const p of patterns) {
		if (typeof p === 'string') {
			migrated.push({ pattern: migratePatternContent(p), tier: 'warning' });
		} else if (p && typeof p === 'object' && typeof (p as PatternEntry).pattern === 'string') {
			const tier = (p as PatternEntry).tier;
			const note = (p as PatternEntry).note;
			const entry: PatternEntry = {
				pattern: migratePatternContent((p as PatternEntry).pattern),
				tier: tier === 'critical' || tier === 'info' ? tier : 'warning',
			};
			if (typeof note === 'string' && note) entry.note = note;
			migrated.push(entry);
		}
	}
	return migrated;
}

/**
 * 迁移旧格式命令清单（string[]）→ 新格式（CommandEntry[]）。
 * string → { command }；已是对象则保留 note；格式无法识别返回 null。
 */
function migrateCommandList(commands: unknown): CommandEntry[] | null {
	if (!Array.isArray(commands)) return null;
	const migrated: CommandEntry[] = [];
	for (const c of commands) {
		if (typeof c === 'string') {
			migrated.push({ command: c });
		} else if (c && typeof c === 'object' && typeof (c as CommandEntry).command === 'string') {
			const entry = c as CommandEntry;
			const item: CommandEntry = { command: entry.command };
			if (typeof entry.note === 'string' && entry.note) item.note = entry.note;
			migrated.push(item);
		}
	}
	return migrated;
}

/**
 * 给「note 为空」的内置条目注入官方解释文案。
 *
 * 数组在 deepMerge 里是整体覆盖，用户手改清单（哪怕是加一条）会丢内置 note，
 * 因此加载末尾按 command/pattern 反查字典补齐——只补空 note，不覆盖用户写的。
 * 用户自增条目（不在字典中）保持无 note，展示层落分类兜底文案。
 */
/**
 * SAFETY: 非数组值保持 deepMerge 数组替换语义（运行时可为任意值），
 * 仅做类型层面对齐，运行时不触碰该值。
 */
function keepAsList<T>(value: unknown): T {
	// SAFETY: 非数组值保持 deepMerge 数组替换语义（运行时可为任意值），仅类型层面对齐
	return value as T;
}

export function injectBuiltinNotes(config: PermissionGateConfig): PermissionGateConfig {
	let injected = 0;

	const dangerCommands = Array.isArray(config.dangerCommands)
		? config.dangerCommands.map((e) => {
				if (e.note) return e;
				const note = DANGER_COMMAND_NOTES[e.command];
				if (!note) return e;
				injected++;
				return { ...e, note };
			})
		: keepAsList<PermissionGateConfig['dangerCommands']>(config.dangerCommands);

	const permissionCommands = Array.isArray(config.permissionCommands)
		? config.permissionCommands.map((e) => {
				if (e.note) return e;
				const note = PERMISSION_COMMAND_NOTES[e.command];
				if (!note) return e;
				injected++;
				return { ...e, note };
			})
		: keepAsList<PermissionGateConfig['permissionCommands']>(config.permissionCommands);

	const patterns = Array.isArray(config.patterns)
		? config.patterns.map((p) => {
				if (p.note) return p;
				const note = DEFAULT_PATTERN_NOTES[p.pattern];
				if (!note) return p;
				injected++;
				return { ...p, note };
			})
		: keepAsList<PermissionGateConfig['patterns']>(config.patterns);

	if (injected > 0) {
		log.debug('injected builtin notes: %d', injected);
	}

	return { ...config, dangerCommands, permissionCommands, patterns };
}

export function loadConfig(cwd: string, homeDir?: string): PermissionGateConfig {
	const paths = resolveConfigPaths('permission-gate', { cwd, homeDir });
	let merged: PermissionGateConfig = getDefaultConfig();

	// 1. 用户级
	const userRaw = readJsonFile(paths.userFile);
	if (userRaw !== null) {
		const migrated = migratePatterns(userRaw.patterns);
		if (migrated !== null) userRaw.patterns = migrated;
		const danger = migrateCommandList(userRaw.dangerCommands);
		if (danger !== null) userRaw.dangerCommands = danger;
		const permission = migrateCommandList(userRaw.permissionCommands);
		if (permission !== null) userRaw.permissionCommands = permission;
		merged = deepMerge(merged, userRaw as Partial<PermissionGateConfig>);
	}

	// 2. 项目级（最高优先级）
	const projectRaw = readJsonFile(paths.projectFile);
	if (projectRaw !== null) {
		const migrated = migratePatterns(projectRaw.patterns);
		if (migrated !== null) projectRaw.patterns = migrated;
		const danger = migrateCommandList(projectRaw.dangerCommands);
		if (danger !== null) projectRaw.dangerCommands = danger;
		const permission = migrateCommandList(projectRaw.permissionCommands);
		if (permission !== null) projectRaw.permissionCommands = permission;
		merged = deepMerge(merged, projectRaw as Partial<PermissionGateConfig>);
	}

	// 3. scope 相对路径解析为绝对路径
	if (merged.dynamicPolicy.scope && !merged.dynamicPolicy.scope.startsWith('/')) {
		merged.dynamicPolicy.scope = resolve(cwd, merged.dynamicPolicy.scope);
	}

	// 4. 补齐内置解释（用户覆盖丢 note 时恢复；用户自增条目保持无 note）
	return injectBuiltinNotes(merged);
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
		defaultPersistenceScope: config.defaultPersistenceScope,
		patterns: config.patterns,
		dangerCommands: config.dangerCommands,
		permissionCommands: config.permissionCommands,
		pathSurfaces: config.pathSurfaces,
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
	const base: PermissionGateConfig = {
		...DEFAULT_CONFIG,
		patterns: DEFAULT_CONFIG.patterns.map((p) => ({ ...p })),
		dangerCommands: DEFAULT_CONFIG.dangerCommands.map((c) => ({ ...c })),
		permissionCommands: DEFAULT_CONFIG.permissionCommands.map((c) => ({ ...c })),
		pathSurfaces: {
			systemDirs: [...DEFAULT_CONFIG.pathSurfaces.systemDirs],
			credentialFiles: [...DEFAULT_CONFIG.pathSurfaces.credentialFiles],
		},
		dynamicPolicy: {
			...DEFAULT_CONFIG.dynamicPolicy,
			thresholds: { ...DEFAULT_CONFIG.dynamicPolicy.thresholds },
		},
		widget: { ...DEFAULT_CONFIG.widget },
	};
	return injectBuiltinNotes(base);
}
