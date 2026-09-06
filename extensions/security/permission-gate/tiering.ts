/**
 * permission-gate — 危险分级判定（T3+T5，ADR-0025）
 *
 * 按三个正交语义轴对命令判级：副作用（读 vs 写）、权限相关、路径空间。
 * 产出 critical / warning / info 三级，决定放行规则可沉淀的持久化层级。
 *
 * 判定优先级（取最高）：
 *   1. 权限相关命令（sudo/chmod/...）→ critical
 *   2. 危险命令（dd/mkfs/iptables/...）→ critical
 *   3. 路径空间：敏感凭证 → critical；系统目录写 → critical；系统目录读 → warning
 *   4. 用户 patterns（带 tier）→ 取最高 tier
 *   5. 未命中任何规则 → null（放行）
 *
 * 命中详情：一条命令可能同时命中多个维度（如 `sudo rm -rf /etc` = 权限相关 + 系统目录写 +
 * 拦截模式），TierAssessment.hits 收集全部命中（逐条带来源与解释文案），
 * reasons 保留去重后的扁平分类 key（审计/外部通道/统计消费，向后兼容）。
 *
 * T5：优先用 tree-sitter（bash-parser）提取「命令 × 路径 × 读写方向」，
 * 解析器未预热时 fallback 到手写 tokenizer。
 */

import { homedir } from 'node:os';
import { parseBashCommand } from './bash-parser.js';
import type { DangerTier, PermissionGateConfig } from './config.js';
import { FALLBACK_EXPLAIN, type ReasonKey } from './notes.js';

/** 单条命中明细（展示层逐条渲染） */
export interface TierHit {
	tier: DangerTier;
	/** 分类 key：destructive / permission-related / credential / system-dir-write / system-dir-read / pattern */
	reason: string;
	/** 来源层：builtin 清单命中 vs 拦截模式（pattern） */
	source: 'builtin' | 'pattern';
	/** 解释文案（条目 note 优先，否则分类兜底） */
	explain: string;
}

export interface TierAssessment {
	/** 最高危险等级 */
	tier: DangerTier;
	/** 去重后的扁平分类 key（兼容审计/统计/外部通道） */
	reasons: string[];
	/** 全部命中明细（弹窗详情逐条展示） */
	hits: TierHit[];
}

// ============================================================================
// 手写提取（fallback，tree-sitter 未预热时用）
// ============================================================================

/** 提取命令名：第一个非 flag、非赋值、非环境变量 token */
export function extractCommandName(command: string): string {
	const firstLine = command.split('\n')[0].trim();
	if (!firstLine) return '';

	const tokens = firstLine.split(/\s+/);
	for (const t of tokens) {
		if (!t) continue;
		if (t.startsWith('-')) continue;
		if (t.includes('=') && !t.includes('/')) continue; // KEY=VALUE 环境变量
		const base = t.split('/').pop() ?? t;
		return base;
	}
	return '';
}

/** 提取命令里的路径 token（含 / 或 ~，或 --key=/path 的 value） */
export function extractPaths(command: string): string[] {
	const paths: string[] = [];
	const seen = new Set<string>();

	let token = '';
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			continue;
		}
		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			continue;
		}
		if (/\s/.test(ch) && !inSingle && !inDouble) {
			if (token) {
				const p = pathFromToken(token);
				if (p && !seen.has(p)) {
					seen.add(p);
					paths.push(p);
				}
				token = '';
			}
			continue;
		}
		token += ch;
	}
	if (token) {
		const p = pathFromToken(token);
		if (p && !seen.has(p)) paths.push(p);
	}

	return paths;
}

function pathFromToken(token: string): string | null {
	// 无空格重定向符前缀（>/etc/foo、2>/etc/x、>>/etc、&>/etc）先剥除——
	// 否则 token 带 ">" 前缀整体当路径，systemDir/credential 前缀匹配全部失配（fail-open）。
	const t = token.replace(/^\d*&>>?/, '').replace(/^\d*>>?\|?/, '');
	if (t !== token) {
		if (!t) return null; // 纯重定向符（> 等），无目标
		token = t;
	}
	if (token.includes('/') && !token.startsWith('http://') && !token.startsWith('https://')) {
		return token;
	}
	if (token.startsWith('~')) return token;
	const eq = token.indexOf('=');
	if (eq > 0 && token.startsWith('--') && token.slice(eq + 1).includes('/')) {
		return token.slice(eq + 1);
	}
	return null;
}

// ============================================================================
// 副作用（读写）判定
// ============================================================================

/** 明确的写命令（有副作用） */
const WRITE_COMMANDS = new Set([
	'rm',
	'mv',
	'cp',
	'dd',
	'mkfs',
	'fdisk',
	'parted',
	'wipefs',
	'shred',
	'chmod',
	'chown',
	'chgrp',
	'touch',
	'tee',
	'install',
	'ln',
	'mkdir',
	'rmdir',
	'truncate',
	'fallocate',
	'mount',
	'umount',
	'setfacl',
	'chattr',
	'setcap',
]);

/** 写重定向（> / >>）检测 */
function hasWriteRedirect(command: string): boolean {
	return /(^|\s)(>>?|&>|&>>)\s*\S/.test(command);
}

function isWriteByCommandName(commandName: string): boolean {
	return WRITE_COMMANDS.has(commandName);
}

/**
 * 提权/前缀命令（sudo rm -rf /etc）：真实命令在其参数首位，
 * 前缀命令自身不表达读写语义，读写判定应落到其后的真实命令。
 */
const DELEGATE_PREFIXES = new Set(['sudo', 'su', 'nohup', 'env', 'nice', 'time', 'npx']);

/**
 * 前缀命令的「带值选项」：这些 flag 会消费下一个参数作为其值（如 sudo -u root、
 * nice -n 10、npx --package pkg），提取真实命令时须连同值一起跳过，否则值会被
 * 误判为命令。只收录确定带值的常见选项，宁缺毋滥（多收一个会误吞真实命令）。
 */
const DELEGATE_VALUE_OPTIONS: Record<string, ReadonlySet<string>> = {
	sudo: new Set([
		'-u',
		'--user',
		'-g',
		'--group',
		'-h',
		'--host',
		'-p',
		'--prompt',
		'-C',
		'--close-from',
		'-D',
		'--chdir',
		'-r',
		'--role',
		'-t',
		'--type',
		'-T',
		'--command-timeout',
	]),
	su: new Set(['-c', '--command', '-s', '--shell', '-g', '--group']),
	env: new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']),
	nice: new Set(['-n', '--adjustment']),
	time: new Set(['-o', '--output', '-f', '--format']),
	npx: new Set(['-p', '--package', '-c', '--call']),
	// nohup 无带值选项
};

function effectiveCommandName(commandName: string, args: string[]): string {
	if (!DELEGATE_PREFIXES.has(commandName)) return commandName;
	const valueOpts = DELEGATE_VALUE_OPTIONS[commandName];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a.startsWith('-')) {
			// 带值选项：连同其值一起跳过（值可能是任意字符串，如 -u root 中的 root）
			if (valueOpts?.has(a) && i + 1 < args.length) i++;
			continue;
		}
		// 环境变量赋值（KEY=VAL，非路径）不是命令，跳过（env FOO=bar cmd 中的 FOO=bar）
		if (a.includes('=') && !a.includes('/')) continue;
		return a;
	}
	return commandName;
}

// ============================================================================
// 路径空间匹配
// ============================================================================

function expandHome(p: string): string {
	if (p.startsWith('~')) return homedir() + p.slice(1);
	// 变量展开（引号命令里常见）：$HOME / ${HOME} 前缀 → homedir（与 ~ 等价）
	if (p === '$HOME') return homedir();
	if (p.startsWith('$HOME/')) return homedir() + p.slice('$HOME'.length);
	if (p.startsWith('${HOME}/')) return homedir() + p.slice('${HOME}'.length);
	return p;
}

/** 无害设备文件/伪终端：写入即丢弃数据、读入为空输入，不构成危险的"系统目录写"。
 *  `2>/dev/null`、`cat /dev/zero` 等常规操作不应命中 system-dir-write 分级（ADR-0025 补充）。 */
const BENIGN_DEVICE_PATHS = [
	'/dev/null',
	'/dev/zero',
	'/dev/full',
	'/dev/random',
	'/dev/urandom',
	'/dev/stdin',
	'/dev/stdout',
	'/dev/stderr',
	'/dev/fd',
	'/dev/tty',
];

/** 判断路径是否为无害设备文件（含其子路径，如 /dev/fd/1）。 */
function isBenignDevice(path: string): boolean {
	const abs = expandHome(path);
	return BENIGN_DEVICE_PATHS.some((p) => abs === p || abs.startsWith(p + '/'));
}

function matchSystemDir(path: string, dirs: string[]): boolean {
	if (isBenignDevice(path)) return false;
	const abs = expandHome(path);
	for (const d of dirs) {
		if (abs === d || abs.startsWith(d + '/')) return true;
	}
	return false;
}

function matchCredential(path: string, fragments: string[]): boolean {
	const abs = expandHome(path);
	for (const f of fragments) {
		const expanded = expandHome(f);
		if (f.includes('/')) {
			if (abs === expanded || abs.startsWith(expanded + '/')) return true;
		} else if (f.startsWith('*.')) {
			// glob 后缀：*.pem / *.key → 任意文件名以该后缀结尾（ADR-0025）
			if (abs.endsWith(f.slice(1))) return true;
		} else if (f.startsWith('.') || f.startsWith('id_')) {
			if (abs.endsWith('/' + f) || abs === f) return true;
		} else if (abs.includes(f)) return true;
	}
	return false;
}

// ============================================================================
// 分级判定（多命中收集）
// ============================================================================

const TIER_ORDER: Record<DangerTier, number> = { critical: 3, warning: 2, info: 1 };

interface CommandInfo {
	commandName: string;
	/** 前缀命令（sudo/env/nohup 等）后的真实命令名，用于读写判定与清单匹配 */
	effectiveName: string;
	paths: string[];
	write: boolean;
}

/** 解释文案：条目 note 优先，否则分类兜底，最后退回 reason key 本身 */
function explainFor(reason: string, note?: string): string {
	if (note) return note;
	return FALLBACK_EXPLAIN[reason as ReasonKey] ?? reason;
}

/** 命令名匹配（危险命令支持 mkfs.ext4 变体前缀匹配） */
function matchesCommandName(name: string, entry: string): boolean {
	return name === entry || name.startsWith(entry + '.');
}

/** 收集单条命令的命中（不再 early-return，多维度叠加） */
function assessSingleCommand(info: CommandInfo, config: PermissionGateConfig): TierHit[] {
	const hits: TierHit[] = [];

	// 1. 权限相关命令（一律 critical，sudo 也在内）——原始命令名与 effective 都查，
	//    避免前缀命令（sudo/env/nohup 等）把真实命令藏进参数后逃逸清单匹配。
	const permEntry =
		config.permissionCommands.find((c) => c.command === info.commandName) ??
		config.permissionCommands.find((c) => c.command === info.effectiveName);
	if (permEntry) {
		hits.push({
			tier: 'critical',
			reason: 'permission-related',
			source: 'builtin',
			explain: explainFor('permission-related', permEntry.note),
		});
	}

	// 2. 危险命令（一律 critical，支持 mkfs.ext4 变体前缀匹配）——原始命令名与 effective 都查
	const dangerEntry =
		config.dangerCommands.find((c) => matchesCommandName(info.commandName, c.command)) ??
		config.dangerCommands.find((c) => matchesCommandName(info.effectiveName, c.command));
	if (dangerEntry) {
		hits.push({
			tier: 'critical',
			reason: 'destructive',
			source: 'builtin',
			explain: explainFor('destructive', dangerEntry.note),
		});
	}

	// 3. 路径空间（敏感凭证 / 系统目录，可同时命中同一条路径）
	for (const p of info.paths) {
		if (matchCredential(p, config.pathSurfaces.credentialFiles)) {
			hits.push({
				tier: 'critical',
				reason: 'credential',
				source: 'builtin',
				explain: `触及敏感凭证 ${p}`,
			});
		}
		if (matchSystemDir(p, config.pathSurfaces.systemDirs)) {
			hits.push(
				info.write
					? {
							tier: 'critical',
							reason: 'system-dir-write',
							source: 'builtin',
							explain: `写入系统目录 ${p}`,
						}
					: {
							tier: 'warning',
							reason: 'system-dir-read',
							source: 'builtin',
							explain: `读取系统目录 ${p}`,
						},
			);
		}
	}

	return hits;
}

/** 收集用户 patterns 的全部命中（不再只取最高） */
function assessPatterns(command: string, config: PermissionGateConfig): TierHit[] {
	const hits: TierHit[] = [];
	for (const entry of config.patterns) {
		let matched = false;
		try {
			matched = new RegExp(entry.pattern, 'i').test(command);
		} catch {
			continue;
		}
		if (!matched) continue;
		hits.push({
			tier: entry.tier,
			reason: 'pattern',
			source: 'pattern',
			explain: explainFor('pattern', entry.note),
		});
	}
	return hits;
}

/**
 * 对一条命令做危险分级（多命中收集）。
 *
 * T5：优先用 tree-sitter 解析（复合命令拆分 + 精确提取），
 * 未预热时 fallback 到手写提取。
 *
 * @returns 命中规则时的 { tier, reasons, hits }；未命中任何规则返回 null（放行）。
 */
export function assessTier(command: string, config: PermissionGateConfig): TierAssessment | null {
	const parsed = parseBashCommand(command);
	const hits: TierHit[] = [];

	if (parsed.ok && parsed.commands.length > 0) {
		// tree-sitter 优先
		for (const c of parsed.commands) {
			// sudo rm -rf /etc：tree-sitter 将 sudo 解析为主命令、rm 落进 arguments，
			// 读写判定须落到 effective（rm），否则 /etc 被误判为「读」。
			const effective = effectiveCommandName(c.commandName, c.arguments);
			const write =
				isWriteByCommandName(effective) || c.redirects.some((r) => r.direction === 'write');
			// 重定向目标同样是命令触及的路径（如 `echo x > /etc/cron.d/foo`、
			// `cat f > ~/.ssh/authorized_keys`），必须与参数路径一并参与路径空间匹配，
			// 否则预热 tree-sitter 后这些敏感路径会逃逸分级（fail-open）。
			const paths = [...c.pathArguments, ...c.redirects.map((r) => r.target)];
			hits.push(
				...assessSingleCommand(
					{ commandName: c.commandName, effectiveName: effective, paths, write },
					config,
				),
			);
		}
	} else {
		// fallback 手写提取
		const commandName = extractCommandName(command);
		const paths = extractPaths(command);
		const rawTokens = command.trim().split(/\s+/).filter(Boolean);
		const effective = effectiveCommandName(commandName, rawTokens.slice(1));
		const write = isWriteByCommandName(effective) || hasWriteRedirect(command);
		hits.push(
			...assessSingleCommand({ commandName, effectiveName: effective, paths, write }, config),
		);
	}

	// patterns 对整条命令匹配，始终参与（tree-sitter 与 fallback 分支一致）
	hits.push(...assessPatterns(command, config));

	if (hits.length === 0) return null;

	// tier 降序（critical > warning > info），同 tier 保持判定顺序
	hits.sort((a, b) => TIER_ORDER[b.tier] - TIER_ORDER[a.tier]);
	const tier = hits[0].tier;
	const reasons = [...new Set(hits.map((h) => h.reason))];

	return { tier, reasons, hits };
}
