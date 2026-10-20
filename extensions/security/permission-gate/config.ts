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
import { dirname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { createLogger } from '@zenone/pi-logger';
import { deepMerge, resolveConfigPaths, readJsonFile, writeJsonAtomic } from '@zenone/pi-config';
import { DANGER_COMMAND_NOTES, DEFAULT_PATTERN_NOTES, PERMISSION_COMMAND_NOTES } from './notes.js';

const log = createLogger('permission-gate:config');

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 信任范围内的一个目标根（ADR-0059）。
 * 判定时 cwd 与命令的每个目标路径都必须落在**同一个根**内，该根才有资格让计数生效。
 */
export interface TrustRoot {
	/** 绝对路径根 */
	root: string;
	/** 仅对本会话创建的路径生效（ADR-0025 第四轴）；未设 = 无条件 */
	requireSessionProvenance?: boolean;
}

/**
 * 一条已采纳的提升（Ticket 08/09）。
 *
 * 为什么需要登记表：采纳会同时动两处——计数迁到用户层、可能新增一条信任范围根。
 * 撤销要能**成对回滚**，就必须记住「这条提升当初加了哪个根」。
 */
export interface PromotedRule {
	/** 计数键（cmd:… / tool:… / dir:…） */
	key: string;
	/** 采纳时的台阶 */
	level: 'leaf' | 'parent' | 'root';
	/** 该条提升新增的信任范围根（仅当 level !== 'leaf'） */
	root?: string;
	requireSessionProvenance?: boolean;
	/** 采纳时间（ISO） */
	createdAt: string;
	/** 证据摘要（展示用，如「本会话人工 4 / 自动 0；历史 5 目录 9 会话 0 拒绝」） */
	evidence: string;
	/**
	 * 只读兑底条目：登记表缺失时，用户层现有计数键被列为「已提升」，
	 * 但它们可能只是 info 级的自然沉淀，并非经提升产生 —— 不可撤销（见 listPromoted）。
	 */
	synthetic?: boolean;
}

export interface DynamicPolicyConfig {
	/**
	 * 信任范围：一组目标根（ADR-0059）。
	 *
	 * 配置里可写：单个字符串（向后兼容，等价于单元素列表）、字符串数组、
	 * 或带条件的根对象数组。加载后一律规范化为 `TrustRoot[]`。
	 */
	scope: TrustRoot[];
	/** 已采纳的提升（登记表，Ticket 08/09；缺失 = 无） */
	promoted?: PromotedRule[];
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
		scope: [{ root: '.' }],
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
export function resolveConfigPath(
	cwd: string,
	scope: 'project' | 'user',
	homeDir?: string,
): string {
	const paths = resolveConfigPaths('permission-gate', homeDir ? { cwd, homeDir } : { cwd });
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

/**
 * 根路径规范化：`~` 展开到主目录，绝对路径归一化，其余相对 cwd 解析。
 */
function resolveRootPath(p: string, cwd: string): string {
	if (p === '~') return resolve(homedir());
	if (p.startsWith('~/')) return resolve(join(homedir(), p.slice(2)));
	return resolve(cwd, p);
}

/**
 * 规范化为信任范围根列表（ADR-0059）。
 *
 * 接受三种写法（向后兼容）：
 *   1. 单个字符串：`"scope": "/tmp"`
 *   2. 字符串数组：`"scope": ["/tmp", "."]`
 *   3. 根对象数组：`"scope": [{ "root": "/tmp", "requireSessionProvenance": true }]`
 *
 * 相对路径（含 `~`）解析为绝对路径。无法识别时返回 null——**不静默改写成默认值**，
 * 由调用方决定兜底（实现上兜底为最小范围，失败即拒绝方向）。
 */
export function normalizeScope(raw: unknown, cwd: string): TrustRoot[] | null {
	const toRoot = (v: unknown): TrustRoot | null => {
		if (typeof v === 'string') {
			const s = v.trim();
			return s ? { root: resolveRootPath(s, cwd) } : null;
		}
		if (v && typeof v === 'object' && !Array.isArray(v)) {
			const o = v as Partial<TrustRoot>;
			if (typeof o.root !== 'string' || !o.root.trim()) return null;
			const item: TrustRoot = { root: resolveRootPath(o.root.trim(), cwd) };
			if (o.requireSessionProvenance === true) item.requireSessionProvenance = true;
			return item;
		}
		return null;
	};

	if (typeof raw === 'string' || (raw && typeof raw === 'object' && !Array.isArray(raw))) {
		const one = toRoot(raw);
		return one ? [one] : null;
	}
	if (Array.isArray(raw)) {
		const roots: TrustRoot[] = [];
		for (const v of raw) {
			const one = toRoot(v);
			// 任一项不可识别 → 整体视为不可识别：不静默丢掉用户写的根（丢根 = 放宽或收紧都不可预期）
			if (!one) return null;
			roots.push(one);
		}
		return roots.length > 0 ? roots : null;
	}
	return null;
}

/** 带出处条件的根在展示文本里的标记（`formatScope` 输出、`parseScopeInput` 回读） */
export const SESSION_PROVENANCE_MARK = '[仅本会话创建]';

/**
 * 信任范围的人类可读摘要（多根逗号连接，带条件的根带标记）。
 * 供设置面板与日志共用，避免两处各写一份格式化。
 *
 * 该输出是**可回读**的：`parseScopeInput` 是其逆运算。
 */
export function formatScope(roots: TrustRoot[]): string {
	if (roots.length === 0) return '(空)';
	return roots
		.map((r) => (r.requireSessionProvenance ? `${r.root} ${SESSION_PROVENANCE_MARK}` : r.root))
		.join(', ');
}

/**
 * `formatScope` 的逆：把设置面板输入框的一行文本解析回根列表。
 *
 * 输入框预填的就是 `formatScope` 的输出，因此必须**剥离展示注解**
 * `[仅本会话创建]` 并据此恢复 `requireSessionProvenance`——直接交给
 * `normalizeScope` 会把注解当成路径的一部分（编辑一次即丢条件、写入无效根）。
 * 空输入返回 null，由调用方保留原值。
 */
export function parseScopeInput(raw: string, cwd: string): TrustRoot[] | null {
	const items = raw
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean)
		.map((s) =>
			s.endsWith(SESSION_PROVENANCE_MARK)
				? {
						root: s.slice(0, -SESSION_PROVENANCE_MARK.length).trim(),
						requireSessionProvenance: true,
					}
				: s,
		);
	return normalizeScope(items, cwd);
}

/**
 * 判断一个 scope 原始值是否等价于默认值（只有 cwd 这一个根、且无附加条件）。
 * 这类条目不是真实的收紧，而是设置面板把默认值落盘的产物。
 */
export function isNoopScopeValue(raw: unknown, cwd: string): boolean {
	const roots = normalizeScope(raw, cwd);
	if (!roots || roots.length !== 1) return false;
	const only = roots[0]!;
	return only.requireSessionProvenance !== true && only.root === resolve(cwd);
}

/** 两个根列表是否完全一致（含条件），顺序敏感 */
function scopeRootsEqual(a: TrustRoot[], b: TrustRoot[]): boolean {
	if (a.length !== b.length) return false;
	return a.every((r, i) => {
		const o = b[i]!;
		return (
			r.root === o.root &&
			(r.requireSessionProvenance === true) === (o.requireSessionProvenance === true)
		);
	});
}

/** target 是否落在 root 之内（或相等） */
function pathWithin(target: string, root: string): boolean {
	const t = resolve(target);
	const r = resolve(root);
	return t === r || t.startsWith(r.endsWith(sep) ? r : r + sep);
}

/**
 * 用户层（含缺省兜底）的生效范围：用户级 scope，缺省则默认 `[cwd]`。
 */
function userEffectiveScope(userFile: string, cwd: string): TrustRoot[] {
	const scope = rawLayerDynamicPolicy(readJsonFile(userFile))?.scope;
	return normalizeScope(scope, cwd) ?? [{ root: resolve(cwd) }];
}

/**
 * 从「项目级生效」改为「下层生效」时，是否会新增**无出处条件**的受信路径。
 *
 * 项目级 no-op scope 被清理时，其本身是单个无条件 `[cwd]`（见 isNoopScopeValue），
 * 因此只需检查下层中落在项目目录之外的根：
 * - 带 `requireSessionProvenance` → 受出处条件护栏，清理是安全的（提升的核心用途）；
 * - 无条件 → 清理会静默扩大无护栏的自动放行范围（fail-open），必须保留。
 */
function widensTrustUnguarded(projectRoots: TrustRoot[], lowerRoots: TrustRoot[]): boolean {
	return lowerRoots.some(
		(r) =>
			r.requireSessionProvenance !== true &&
			!projectRoots.some((p) => pathWithin(r.root, p.root)),
	);
}

/**
 * 会话级覆盖的字段白名单（ADR-0059 三级逐级覆盖：会话 > 项目 > 用户）。
 *
 * 会话文件 `<userDir>/<sessionId>.json` 与 pi-state 的放行计数 / 手动策略**共享**，
 * 因此只取配置字段，避免把 counts / strategies 等无关键混进配置对象。
 */
const SESSION_CONFIG_KEYS = [
	'enabled',
	'dynamicPolicyEnabled',
	'defaultPersistenceScope',
	'patterns',
	'dangerCommands',
	'permissionCommands',
	'pathSurfaces',
	'dynamicPolicy',
	'widget',
] as const;

function pickSessionConfig(raw: Record<string, unknown>): Partial<PermissionGateConfig> {
	const out: Record<string, unknown> = {};
	for (const k of SESSION_CONFIG_KEYS) if (k in raw) out[k] = raw[k];
	return out as Partial<PermissionGateConfig>;
}

/** 生效信任范围来自哪一层 */
export type ScopeSource = 'session' | 'project' | 'user' | 'default';

export interface ScopeProvenance {
	/** 生效 scope 来自哪一层（最高优先级的显式声明） */
	source: ScopeSource;
	/** 生效声明之下、被它整体覆盖（遮蔽）的层（ADR-0059：逐级覆盖） */
	shadowed: ScopeSource[];
}

const SCOPE_SOURCE_LABEL: Record<ScopeSource, string> = {
	session: '会话级',
	project: '项目级',
	user: '用户级',
	default: '默认',
};

/** 从一层原始配置里取 `dynamicPolicy` 对象（未写返回 undefined） */
function rawLayerDynamicPolicy(raw: unknown): Record<string, unknown> | undefined {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
	const dyn = (raw as { dynamicPolicy?: unknown }).dynamicPolicy;
	if (!dyn || typeof dyn !== 'object' || Array.isArray(dyn)) return undefined;
	return dyn as Record<string, unknown>;
}

/**
 * 生效信任范围来自哪一层、遮蔽了哪些层（ADR-0059：面板必须展示层次与遮蔽）。
 *
 * 逐层从高到低找第一个**显式且有意义的** scope 声明（会话 > 项目 > 用户）；
 * 项目级等价默认值（isNoopScopeValue）不算真实收紧，跳过；无法识别的值不视为生效声明
 * （loadConfig 会兜底为最小范围）。其下声明过 scope 的层即为被遮蔽层。
 */
export function scopeProvenance(
	cwd: string,
	sessionId?: string | null,
	homeDir?: string,
): ScopeProvenance {
	const paths = resolveConfigPaths('permission-gate', { cwd, homeDir });
	const sessionDyn = sessionId
		? rawLayerDynamicPolicy(readJsonFile(join(paths.userDir, `${sessionId}.json`)))
		: undefined;
	const projectDyn = rawLayerDynamicPolicy(readJsonFile(paths.projectFile));
	const userDyn = rawLayerDynamicPolicy(readJsonFile(paths.userFile));

	// 项目级 [cwd] 只有在**与下层生效范围一致**时才是「默认值落盘」（不是决策）；
	// 下层更宽时它是真实收紧，会遮蔽下层——必须算作项目级声明（ADR-0059）。
	const projectRoots =
		projectDyn?.scope === undefined ? null : normalizeScope(projectDyn.scope, cwd);
	const projectMeaningful =
		projectRoots !== null &&
		!(
			isNoopScopeValue(projectDyn?.scope, cwd) &&
			!widensTrustUnguarded(projectRoots, userEffectiveScope(paths.userFile, cwd))
		);

	const declared: ScopeSource[] = [];
	if (sessionId && normalizeScope(sessionDyn?.scope, cwd) !== null) declared.push('session');
	if (projectMeaningful) declared.push('project');
	if (userDyn?.scope !== undefined && normalizeScope(userDyn.scope, cwd) !== null)
		declared.push('user');

	const source: ScopeSource = declared[0] ?? 'default';
	return { source, shadowed: declared.filter((s) => s !== source) };
}

/** 人类可读的 scope 来源（面板/日志共用，如「项目级（遮蔽 用户级）」） */
export function formatScopeSource(p: ScopeProvenance): string {
	const label = SCOPE_SOURCE_LABEL[p.source];
	if (p.shadowed.length === 0) return label;
	return `${label}（遮蔽 ${p.shadowed.map((s) => SCOPE_SOURCE_LABEL[s]).join('/')}）`;
}

/**
 * 迁移清理（ADR-0059）：删除项目级配置里**真正等价于默认值**的 `scope`。
 *
 * **为什么必须清**：范围提升写的是**用户级**列表，而项目级 scope 会整体覆盖用户级。
 * 本项目当前多个 worktree 的项目级 scope 都写死了自己那个目录（≡ 默认值），
 * 留着会让提升静默失效。幂等：无可清理项时不写盘、返回 false。
 *
 * **安全边界（fail-safe）**：仅当该 scope 与下层（用户级，缺省则默认 `[cwd]`）
 * 的生效范围**完全一致**时才删除——此时删除是 no-op。下层范围更宽（如
 * 用户级 `[cwd, /tmp]`）时，项目级 `[cwd]` 是**真实收紧**，删除会把生效范围
 * 静默放宽（fail-open），因此保留、交由用户裁决。
 *
 * @returns 是否发生了清理写入
 */
export function pruneNoopProjectScope(cwd: string, homeDir?: string): boolean {
	const paths = resolveConfigPaths('permission-gate', { cwd, homeDir });
	const raw = readJsonFile(paths.projectFile);
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
	const container = raw as { dynamicPolicy?: unknown };
	const section = container.dynamicPolicy;
	if (!section || typeof section !== 'object' || Array.isArray(section)) return false;
	if (!('scope' in section)) return false;
	if (!isNoopScopeValue((section as { scope?: unknown }).scope, cwd)) return false;

	const projectRoots = normalizeScope((section as { scope?: unknown }).scope, cwd);
	if (!projectRoots) return false;
	// 下层含**无条件**的项目外根 → 删除会把生效范围静默放宽（fail-open），保留不清理。
	if (widensTrustUnguarded(projectRoots, userEffectiveScope(paths.userFile, cwd))) return false;

	delete (section as { scope?: unknown }).scope;
	if (Object.keys(section as object).length === 0) delete container.dynamicPolicy;
	try {
		writeJsonAtomic(paths.projectFile, raw);
		log.info(
			'迁移清理：项目级 scope 等价于默认值，已清除（否则会覆盖用户级范围）: %s',
			paths.projectFile,
		);
		return true;
	} catch (err) {
		log.warn('Failed to persist no-op scope cleanup: %s', String(err));
		return false;
	}
}

export function loadConfig(
	cwd: string,
	homeDir?: string,
	sessionId?: string | null,
): PermissionGateConfig {
	const paths = resolveConfigPaths('permission-gate', { cwd, homeDir });
	let merged: PermissionGateConfig = getDefaultConfig();

	// 0. 迁移清理：项目级 scope 等价默认值 → 视为未设置
	//    （否则它会整体覆盖用户级列表，把范围提升静默吞掉）
	pruneNoopProjectScope(cwd, homeDir);

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

	// 2.5 会话级（最高优先级，ADR-0059）：会话级可临时收紧（在敏感项目里只信本目录）。
	//     会话文件与 pi-state 状态共享，只取配置字段（见 SESSION_CONFIG_KEYS）。
	if (sessionId) {
		const sessionRaw = readJsonFile(join(paths.userDir, `${sessionId}.json`));
		if (sessionRaw && typeof sessionRaw === 'object' && !Array.isArray(sessionRaw)) {
			const sessionCfg = pickSessionConfig(sessionRaw as Record<string, unknown>);
			const migrated = migratePatterns(sessionCfg.patterns);
			if (migrated !== null) sessionCfg.patterns = migrated;
			const danger = migrateCommandList(sessionCfg.dangerCommands);
			if (danger !== null) sessionCfg.dangerCommands = danger;
			const permission = migrateCommandList(sessionCfg.permissionCommands);
			if (permission !== null) sessionCfg.permissionCommands = permission;
			merged = deepMerge(merged, sessionCfg);
		}
	}

	// 3. scope 规范化为根列表（相对路径 / ~ 解析为绝对路径）。
	//    不可识别 → 兜底为最小范围（仅 cwd），失败即拒绝方向。
	merged.dynamicPolicy.scope = normalizeScope(merged.dynamicPolicy.scope, cwd) ?? [
		{ root: resolve(cwd) },
	];

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

	let dynamicPolicy: DynamicPolicyConfig = config.dynamicPolicy;
	if (scope === 'project') {
		// 项目级只落盘**属于该层**的动态策略：
		// ① `promoted` 是用户级注册表（采纳/撤销都只读写用户级），抄进项目级会让
		//    撤销只看到项目级副本（ADR-0059 备注）；
		// ② `scope` 若与下层（用户级/默认）生效范围完全一致，只是从下层抄来的副本，
		//    落盘会在提升撤销后留下遮蔽用户级的项目级根。
		const { promoted: _promoted, ...withoutPromoted } = dynamicPolicy;
		const roots = normalizeScope(withoutPromoted.scope, cwd);
		if (
			roots &&
			scopeRootsEqual(roots, userEffectiveScope(resolveConfigPath(cwd, 'user'), cwd))
		) {
			const { scope: _scope, ...withoutScope } = withoutPromoted;
			dynamicPolicy = withoutScope as DynamicPolicyConfig;
		} else {
			dynamicPolicy = withoutPromoted as DynamicPolicyConfig;
		}
	}

	const output: Partial<PermissionGateConfig> = {
		enabled: config.enabled,
		dynamicPolicyEnabled: config.dynamicPolicyEnabled,
		defaultPersistenceScope: config.defaultPersistenceScope,
		patterns: config.patterns,
		dangerCommands: config.dangerCommands,
		permissionCommands: config.permissionCommands,
		pathSurfaces: config.pathSurfaces,
		dynamicPolicy,
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
			scope: DEFAULT_CONFIG.dynamicPolicy.scope.map((r) => ({ ...r })),
			thresholds: { ...DEFAULT_CONFIG.dynamicPolicy.thresholds },
		},
		widget: { ...DEFAULT_CONFIG.widget },
	};
	return injectBuiltinNotes(base);
}
