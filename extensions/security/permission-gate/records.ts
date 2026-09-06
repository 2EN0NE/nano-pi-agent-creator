/**
 * Permission Gate — 审批记录与策略纯函数
 *
 * ADR-0027 落地后：
 * - 完整命令审计 → audit-log.ts（JSONL 按天分片，append-only）
 * - 放行规则计数   → approval-store.ts（pi-state 三层）
 * - 本文件仅保留：项目 key 生成、策略维度汇总/widget 文本等纯函数，
 *   以及旧 approvals.json → audit + pi-state 的一次性迁移。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { createLogger } from '@zenone/pi-logger';
import { readJsonFile, writeJsonAtomic } from '@zenone/pi-state';
import type { DangerTier } from './config.js';
import { makeCommandKey, makeFolderKey, makeToolKey } from './config.js';
import { appendAudit, type AuditDecision } from './audit-log.js';
import { recordApproval, importRuleCounts } from './approval-store.js';

const log = createLogger('permission-gate:records');

// ============================================================================
// 类型
// ============================================================================

export interface ApprovalEntry {
	/** ISO 时间戳 */
	ts: string;
	/** 完整命令（子命令） */
	cmd: string;
	/** 工具名（如 rm, sudo） */
	tool: string;
	/** 目标目录绝对路径 */
	dir: string;
	/** 触发维度（旧格式：string | string[] | null） */
	dim: string[] | string | null;
	/** 放行方式 */
	action: 'auto' | 'confirmed' | 'blocked';
	/** 危险分级（ADR-0025）：决定放行规则的持久化层级 */
	tier?: DangerTier;
	/** 原始复合命令（如 "rm -rf /tmp && echo done"） */
	originalCommand?: string;
	/** 拆分后的子命令列表 */
	subCommands?: string[];
}

/** 策略维度汇总 */
export interface StrategySummary {
	cmd: { total: number; active: number };
	tool: { total: number; active: number };
	dir: { total: number; active: number };
}

/**
 * 标准化 dim 字段：兼容新版（string[]）和旧版（单字符串）格式。
 */
export function normalizeDim(dim: string[] | string | null | undefined): string[] | null {
	if (!dim) return null;
	if (Array.isArray(dim)) return dim.length > 0 ? [...new Set(dim)] : null;
	// 旧版单字符串格式
	return [dim];
}

export interface ProjectRecords {
	path: string;
	git?: string;
	entries: ApprovalEntry[];
}

interface ApprovalsFile {
	projects: Record<string, ProjectRecords>;
}

// ============================================================================
// 路径 & key 生成
// ============================================================================

let recordsHomeDir: string = homedir();

function recordsDir(): string {
	return join(recordsHomeDir, '.pi', 'agent', 'extensions-data', 'permission-gate');
}

function recordsFile(): string {
	return join(recordsDir(), 'approvals.json');
}

/** 测试专用：注入 homeDir 隔离真实用户目录（approvals.json 落盘路径） */
export function resetRecordsStore(homeDir: string): void {
	recordsHomeDir = homeDir;
}

function ensureDir(): void {
	const dir = recordsDir();
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}

function sha256(input: string): string {
	return createHash('sha256').update(input).digest('hex');
}

function getGitRemote(cwd: string): string | null {
	try {
		const out = execSync('git remote get-url origin 2>/dev/null', {
			cwd,
			encoding: 'utf8',
			timeout: 5000,
		});
		return out.trim().replace(/\.git$/, '') || null;
	} catch {
		return null;
	}
}

/**
 * 项目 key 缓存（per-cwd）——避免在每次 bash 工具调用的热路径上
 * spawn 一个阻塞的 git 子进程（超时 5s）。git remote 在会话内不会变化。
 */
const projectKeyCache = new Map<string, string>();

/**
 * 生成项目唯一 key：
 * 优先用 git remote origin 的 SHA256 前缀，
 * 回退到项目路径的 SHA256 前缀。
 */
export function getProjectKey(cwd: string): string {
	const absPath = resolve(cwd);
	const cached = projectKeyCache.get(absPath);
	if (cached !== undefined) return cached;

	const gitRemote = getGitRemote(absPath);
	const key = gitRemote
		? `git:${sha256(gitRemote).slice(0, 12)}`
		: `path:${sha256(absPath).slice(0, 12)}`;
	projectKeyCache.set(absPath, key);
	return key;
}

// ============================================================================
// 旧 approvals.json 读写（仅迁移用）
// ============================================================================

function readApprovalsFile(): ApprovalsFile {
	ensureDir();
	try {
		const file = recordsFile();
		if (!existsSync(file)) return { projects: {} };
		const raw = readFileSync(file, 'utf-8');
		return JSON.parse(raw) as ApprovalsFile;
	} catch (err) {
		log.error('Failed to read approvals file', err);
		return { projects: {} };
	}
}

function writeApprovalsFile(data: ApprovalsFile): void {
	ensureDir();
	try {
		writeFileSync(recordsFile(), JSON.stringify(data, null, 2) + '\n', 'utf-8');
	} catch (err) {
		log.error('Failed to write approvals file', err);
	}
}

// ============================================================================
// 纯函数（策略汇总 / widget / 命令拆分）
// ============================================================================

/**
 * 计算非 blocked 记录总数（供迁移统计与测试使用）。
 */
export function countNonBlockedEntries(entries: ApprovalEntry[]): number {
	return entries.filter((e) => e.action !== 'blocked').length;
}

/**
 * 计算策略维度汇总：每个维度的总数和仍然 active（未达阈值）的数量。
 */
export function getStrategySummary(
	counts: Record<string, number>,
	thresholds: { sameCommand: number; sameTool: number; sameFolder: number },
): StrategySummary {
	let cmdTotal = 0;
	let cmdActive = 0;
	let toolTotal = 0;
	let toolActive = 0;
	let dirTotal = 0;
	let dirActive = 0;

	for (const key of Object.keys(counts)) {
		const count = counts[key] ?? 0;
		if (key.startsWith('cmd:')) {
			cmdTotal++;
			if (count < thresholds.sameCommand) cmdActive++;
		} else if (key.startsWith('tool:')) {
			toolTotal++;
			if (count < thresholds.sameTool) toolActive++;
		} else if (key.startsWith('dir:')) {
			dirTotal++;
			if (count < thresholds.sameFolder) dirActive++;
		}
	}

	return {
		cmd: { total: cmdTotal, active: cmdActive },
		tool: { total: toolTotal, active: toolActive },
		dir: { total: dirTotal, active: dirActive },
	};
}

/**
 * 计算 widget 纯文本（无 ANSI 颜色），供 updateWidgetStatus 和单元测试使用。
 */
export function calcWidgetContentText(
	enabled: boolean,
	dynamicEnabled: boolean,
	counts: Record<string, number>,
	thresholds: { sameCommand: number; sameTool: number; sameFolder: number },
	totalRecords: number,
): string {
	if (!enabled) return '|gate:off';

	const summary = getStrategySummary(counts, thresholds);
	const cmdTotal = summary.cmd.total;
	const toolTotal = summary.tool.total;
	const dirTotal = summary.dir.total;

	if (!dynamicEnabled) {
		// Dynamic OFF: 显示记录总数 + 策略数
		const parts: string[] = [];
		if (cmdTotal > 0) parts.push(`cmd(${cmdTotal})`);
		if (toolTotal > 0) parts.push(`tool(${toolTotal})`);
		if (dirTotal > 0) parts.push(`folder(${dirTotal})`);

		const suffix = parts.length > 0 ? `(${totalRecords}):on[${parts.join(',')}]` : ':on';
		return `|gate${suffix}`;
	}

	// Dynamic ON: 已沉淀数（阈值<=0 时强制为 0）
	const cmdAuto = thresholds.sameCommand > 0 ? cmdTotal - summary.cmd.active : 0;
	const toolAuto = thresholds.sameTool > 0 ? toolTotal - summary.tool.active : 0;
	const dirAuto = thresholds.sameFolder > 0 ? dirTotal - summary.dir.active : 0;
	const totalAuto = cmdAuto + toolAuto + dirAuto;

	// 找最优进度（仅限未达阈值的活跃策略，确保沉淀后切换到下一个最近目标）
	let bestCmd = 0,
		bestTool = 0,
		bestFolder = 0;
	for (const key of Object.keys(counts)) {
		const c = counts[key] ?? 0;
		if (key.startsWith('cmd:') && c < thresholds.sameCommand && c > bestCmd) bestCmd = c;
		else if (key.startsWith('tool:') && c < thresholds.sameTool && c > bestTool) bestTool = c;
		else if (key.startsWith('dir:') && c < thresholds.sameFolder && c > bestFolder)
			bestFolder = c;
	}

	const parts: string[] = [];
	if (cmdTotal > 0) {
		parts.push(`cmd(${cmdTotal}[${cmdAuto}]):${bestCmd}/${thresholds.sameCommand}`);
	}
	if (toolTotal > 0) {
		parts.push(`tool(${toolTotal}[${toolAuto}]):${bestTool}/${thresholds.sameTool}`);
	}
	if (dirTotal > 0) {
		parts.push(`folder(${dirTotal}[${dirAuto}]):${bestFolder}/${thresholds.sameFolder}`);
	}

	const suffix =
		parts.length > 0 ? `(${totalRecords}[${totalAuto}]):on[${parts.join(',')}]` : ':on';
	return `|dynamic-gate${suffix}`;
}

/**
 * 拆分组合命令（按 &&、||、;、| 分隔），保留引号和子 shell 内的分隔符。
 * 返回各条子命令的 trimmed 字符串数组。
 */
export function splitCompoundCommand(command: string): string[] {
	const parts: string[] = [];
	let current = '';
	let inSingle = false;
	let inDouble = false;
	let inBacktick = false;
	let subShellDepth = 0;

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		const next = command[i + 1];

		if (ch === "'" && !inDouble && !inBacktick) {
			inSingle = !inSingle;
			current += ch;
			continue;
		}
		if (ch === '"' && !inSingle && !inBacktick) {
			inDouble = !inDouble;
			current += ch;
			continue;
		}
		// 反引号命令替换 `...`，内容不拆分
		if (ch === '`' && !inSingle && !inDouble) {
			inBacktick = !inBacktick;
			current += ch;
			continue;
		}

		if (!inSingle && !inDouble && !inBacktick) {
			if (ch === '$' && next === '(') {
				subShellDepth++;
				current += ch + next;
				i++;
				continue;
			}
			if (ch === ')' && subShellDepth > 0) {
				subShellDepth--;
				current += ch;
				continue;
			}
		}

		if (subShellDepth === 0 && !inSingle && !inDouble && !inBacktick) {
			if (ch === '&' && next === '&') {
				if (current.trim()) parts.push(current.trim());
				current = '';
				i++;
				continue;
			}
			if (ch === '|' && next === '|') {
				if (current.trim()) parts.push(current.trim());
				current = '';
				i++;
				continue;
			}
			if (ch === '|' && next !== '|') {
				// |& (合并 stderr 管道) — 跳过 &
				if (next === '&') i++;
				if (current.trim()) {
					parts.push(current.trim());
					current = '';
				}
				continue;
			}
			if (ch === ';' && next !== ';' && current.trim()) {
				parts.push(current.trim());
				current = '';
				continue;
			}
		}

		current += ch;
	}

	if (current.trim()) parts.push(current.trim());
	return parts.length > 0 ? parts : [command];
}

// ============================================================================
// 一次性迁移：旧 approvals.json / config.json approvalCounts → audit + pi-state
// ============================================================================

function mapActionToDecision(action: ApprovalEntry['action']): AuditDecision {
	switch (action) {
		case 'auto':
			return 'auto';
		case 'confirmed':
			return 'ask';
		case 'blocked':
			return 'deny';
	}
}

/** 命令摘要（截断到 120 字符，与 index.ts 的 summarizeCommand 一致） */
function summarizeForAudit(command: string): string {
	const firstLine = command.split('\n')[0].trim();
	return firstLine.length > 120 ? firstLine.slice(0, 117) + '...' : firstLine;
}

/**
 * 迁移旧 config.json 中的 approvalCounts（string→count）到 pi-state warning 层。
 * 旧 approvalCounts 的 key 本就是 cmd:/tool:/dir: 格式，直接导入。
 */
function migrateLegacyCounts(cwd: string): number {
	const paths = [
		// 项目级
		join(cwd, '.pi', 'extensions-data', 'permission-gate', 'config.json'),
		// 用户级
		join(recordsHomeDir, '.pi', 'agent', 'extensions-data', 'permission-gate', 'config.json'),
	];
	let total = 0;
	for (const p of paths) {
		const raw = readJsonFile(p);
		if (!raw) continue;
		const counts = raw.approvalCounts;
		if (!counts || typeof counts !== 'object' || Array.isArray(counts)) continue;
		const entries = Object.entries(counts as Record<string, number>);
		if (entries.length === 0) continue;

		importRuleCounts(counts as Record<string, number>, 'warning');
		// 删除源字段并写回，作为"已迁移"标记，保证幂等——
		// 否则每次 session_start 都会重入，warning 层计数持续膨胀。
		delete raw.approvalCounts;
		writeJsonAtomic(p, raw);
		total += entries.length;
		log.info(
			'Migrated legacy approvalCounts (%d keys) to pi-state warning layer',
			entries.length,
		);
	}
	return total;
}

/**
 * 一次性迁移：旧 approvals.json 的当前项目 entries → audit JSONL + pi-state 计数。
 *
 * - 每条 entry 转成 audit 记录（补 projectKey/originalCommand/subCommands）
 * - 非 blocked 且带 tier 的 entry 累加到 pi-state 对应层（旧记录无 tier 保守归 warning）
 * - 迁移后从 approvals.json 移除当前项目；文件为空则重命名 `.migrated-<ts>` 备份
 *
 * @returns 迁移的 entry 数 + 是否已备份整个旧文件
 */
export function migrateApprovalsToAudit(cwd: string): { migrated: number; backedUp: boolean } {
	const file = readApprovalsFile();
	const key = getProjectKey(cwd);
	const project = file.projects[key];

	if (!project || project.entries.length === 0) {
		// 无当前项目 entry → 尝试迁移 config.json 的旧 approvalCounts
		const legacy = migrateLegacyCounts(cwd);
		return legacy > 0
			? { migrated: legacy, backedUp: false }
			: { migrated: 0, backedUp: false };
	}

	// ── 先落"消费标记"（write-ahead），再追加审计/计数 ──
	// 旧顺序（先 appendAudit/recordApproval、后删源）在两者之间崩溃会让同一批条目
	// 在下一次 session_start 重放：审计重复 + 信任计数翻倍（提前触发阈值自动放行）。
	// 新顺序：先把本项目从源文件移除（写回或改名备份），从内存数据追加——
	// 中途崩溃只会丢失剩余未追加的旧条目（备份仍在，可手工恢复），不会重复累加信任。
	const entries = project.entries;
	delete file.projects[key];

	if (Object.keys(file.projects).length === 0) {
		try {
			renameSync(recordsFile(), `${recordsFile()}.migrated-${Date.now()}`);
		} catch (err) {
			// 改名失败 → 源文件原样保留，本次不迁移（下次启动重试，不会重放）
			log.error('Failed to rename approvals.json before migration: %s', String(err));
			return { migrated: 0, backedUp: false };
		}
	} else {
		try {
			writeApprovalsFile(file);
		} catch (err) {
			log.error('Failed to persist migration marker, aborting: %s', String(err));
			return { migrated: 0, backedUp: false };
		}
	}

	for (const e of entries) {
		appendAudit({
			id: randomUUID(),
			ts: e.ts,
			tool: e.tool,
			command: summarizeForAudit(e.cmd),
			tier: e.tier ?? null,
			decision: mapActionToDecision(e.action),
			reasons: [],
			projectKey: key,
			originalCommand: e.originalCommand ?? e.cmd,
			subCommands: e.subCommands,
		});
		// 累加 pi-state 计数：blocked 不计数；旧记录无 tier 保守归 warning（项目级）
		if (e.action !== 'blocked') {
			const tier = e.tier ?? 'warning';
			recordApproval(tier, [
				makeCommandKey(e.cmd),
				makeToolKey(e.tool),
				makeFolderKey(e.dir),
			]);
		}
	}

	// 单项目（改名备份）路径：备份文件保留，与既有契约一致（可审计恢复）
	return { migrated: entries.length, backedUp: true };
}
