/**
 * Permission Gate — 审批记录持久化
 *
 * 将审批历史独立于配置文件存储，按项目（git remote / 路径）隔离。
 * 每笔记录包含完整命令、触发维度、放行方式，可溯源。
 *
 * 存储位置：~/.pi/agent/extensions-data/permission-gate/approvals.json
 *
 * 结构：
 * {
 *   "projects": {
 *     "<project_key>": {
 *       "path": "/Users/jojo/Projects/...",
 *       "git": "github.com/user/repo",
 *       "entries": [
 *         { "ts": "2026-...", "cmd": "rm -rf ./t", "tool": "rm",
 *           "dir": "/abs/path", "dim": "sameCommand", "action": "auto" }
 *       ]
 *     }
 *   }
 * }
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { createLogger } from '@zenone/pi-logger';

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
	/** 触发维度。
	 *  新版（after-v2-migration）：string[] | null，记录所有经由并行检查通过的维度。
	 *  旧版（before migration）：单维度字符串 'sameCommand' | 'sameTool' | 'sameFolder' | null。
	 *  读取时统一标准化。 */
	dim: string[] | string | null;
	/** 放行方式 */
	action: 'auto' | 'confirmed' | 'blocked';
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

const RECORDS_DIR = join(homedir(), '.pi', 'agent', 'extensions-data', 'permission-gate');
const RECORDS_FILE = join(RECORDS_DIR, 'approvals.json');

function ensureDir(): void {
	if (!existsSync(RECORDS_DIR)) {
		mkdirSync(RECORDS_DIR, { recursive: true });
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
 * 生成项目唯一 key：
 * 优先用 git remote origin 的 SHA256 前缀，
 * 回退到项目路径的 SHA256 前缀。
 */
export function getProjectKey(cwd: string): string {
	const absPath = resolve(cwd);
	const gitRemote = getGitRemote(absPath);
	if (gitRemote) return `git:${sha256(gitRemote).slice(0, 12)}`;
	return `path:${sha256(absPath).slice(0, 12)}`;
}

// ============================================================================
// 文件读写
// ============================================================================

function readApprovalsFile(): ApprovalsFile {
	ensureDir();
	try {
		if (!existsSync(RECORDS_FILE)) return { projects: {} };
		const raw = readFileSync(RECORDS_FILE, 'utf-8');
		return JSON.parse(raw) as ApprovalsFile;
	} catch (err) {
		log.error('Failed to read approvals file', err);
		return { projects: {} };
	}
}

function writeApprovalsFile(data: ApprovalsFile): void {
	ensureDir();
	try {
		writeFileSync(RECORDS_FILE, JSON.stringify(data, null, 2) + '\n', 'utf-8');
	} catch (err) {
		log.error('Failed to write approvals file', err);
	}
}

// ============================================================================
// 公共 API
// ============================================================================

/**
 * 计算当前项目非 blocked 记录总数（用于 widget gate() 显示）。
 */
export function countNonBlockedEntries(entries: ApprovalEntry[]): number {
	return entries.filter((e) => e.action !== 'blocked').length;
}

/**
 * 从记录中重建 counts（用于阈值检查）。
 * counts 使用与原来一致的 key 格式：
 *   cmd:<hash> → 同命令计数
 *   tool:<name> → 同工具计数
 *   dir:<path> → 同目录计数
 */
function deriveCounts(entries: ApprovalEntry[]): Record<string, number> {
	const counts: Record<string, number> = {};

	for (const entry of entries) {
		// blocked 记录不计入阈值计数（避免 block 行为消耗 auto-approve 配额）
		if (entry.action === 'blocked') continue;

		// cmd key（与原 makeCommandKey 逻辑一致）
		const normalized = entry.cmd.trim().replace(/\s+/g, ' ');
		const cmdHash = createHash('sha256').update(normalized).digest('hex').slice(0, 16);
		const cmdKey = `cmd:${cmdHash}`;
		counts[cmdKey] = (counts[cmdKey] ?? 0) + 1;

		// tool key
		const toolKey = `tool:${entry.tool}`;
		counts[toolKey] = (counts[toolKey] ?? 0) + 1;

		// dir key
		const dirKey = `dir:${entry.dir}`;
		counts[dirKey] = (counts[dirKey] ?? 0) + 1;
	}

	return counts;
}

/**
 * 从旧版 config.json 中读取 approvalCounts。
 * 用于迁移：直接读原始 JSON 提取 legacy 计数。
 */
function readLegacyCounts(cwd: string): Record<string, number> | null {
	const paths = [
		// 项目级
		join(cwd, '.pi', 'extensions-data', 'permission-gate', 'config.json'),
		// 用户级
		join(homedir(), '.pi', 'agent', 'extensions-data', 'permission-gate', 'config.json'),
	];
	for (const p of paths) {
		try {
			if (!existsSync(p)) continue;
			const raw = JSON.parse(readFileSync(p, 'utf-8'));
			if (raw.approvalCounts && typeof raw.approvalCounts === 'object') {
				return raw.approvalCounts as Record<string, number>;
			}
		} catch {}
	}
	return null;
}

/**
 * 加载项目记录及派生计数。
 * 如存在旧版 config.json 中的 approvalCounts，自动迁移。
 *
 * 旧版 counts（cmd:hash / tool:name / dir:path）本就是合法的 _counts 格式，
 * 迁移时直接保留原始计数，无需重新哈希。仅创建一条审计摘要记录。
 */
export function loadRecords(cwd: string): {
	entries: ApprovalEntry[];
	counts: Record<string, number>;
} {
	const file = readApprovalsFile();
	const key = getProjectKey(cwd);
	const project = file.projects[key];

	if (!project) {
		// 尝试迁移旧版数据
		const legacy = readLegacyCounts(cwd);
		if (legacy && Object.keys(legacy).length > 0) {
			return migrateFromLegacy(cwd, legacy);
		}
		return { entries: [], counts: {} };
	}

	return { entries: project.entries, counts: deriveCounts(project.entries) };
}

/**
 * 追加一条审批记录并持久化。
 * 同时更新内存中的 counts。
 */
export function appendRecord(
	cwd: string,
	entry: ApprovalEntry,
	counts: Record<string, number>,
): void {
	const file = readApprovalsFile();
	const key = getProjectKey(cwd);
	const absPath = resolve(cwd);

	if (!file.projects[key]) {
		file.projects[key] = {
			path: absPath,
			git: getGitRemote(absPath) ?? undefined,
			entries: [],
		};
	}

	// 追加记录
	file.projects[key].entries.push(entry);
	writeApprovalsFile(file);

	// 更新内存 counts
	const normalized = entry.cmd.trim().replace(/\s+/g, ' ');
	const cmdHash = createHash('sha256').update(normalized).digest('hex').slice(0, 16);
	const cmdKey = `cmd:${cmdHash}`;
	counts[cmdKey] = (counts[cmdKey] ?? 0) + 1;
	const toolKey = `tool:${entry.tool}`;
	counts[toolKey] = (counts[toolKey] ?? 0) + 1;
	const dirKey = `dir:${entry.dir}`;
	counts[dirKey] = (counts[dirKey] ?? 0) + 1;
}

/**
 * 重置当前项目的审批记录。
 */
export function resetRecords(cwd: string): void {
	const file = readApprovalsFile();
	const key = getProjectKey(cwd);
	delete file.projects[key];
	writeApprovalsFile(file);
	log.info('Approval records reset for project %s (key=%s)', resolve(cwd), key);
}

/**
 * 追加一条 blocked 记录（被拦截/拒绝的命令）。
 * blocked 记录不计入 _counts，仅供历史审计。
 */
export function appendBlockedRecord(cwd: string, entry: ApprovalEntry): void {
	const file = readApprovalsFile();
	const key = getProjectKey(cwd);
	const absPath = resolve(cwd);

	if (!file.projects[key]) {
		file.projects[key] = {
			path: absPath,
			git: getGitRemote(absPath) ?? undefined,
			entries: [],
		};
	}

	file.projects[key].entries.push(entry);
	writeApprovalsFile(file);
	log.debug('Blocked record appended for project %s', key);
}

/**
 * 删除指定维度下某个 key 的所有审批记录。
 * 返回删除后重建的 counts。
 *
 * @param cwd 项目工作目录
 * @param dimension 维度：'cmd' | 'tool' | 'dir'
 * @param key 完整的计数 key（如 "cmd:abc123", "tool:rm", "dir:/path"）
 */
export function deleteStrategy(
	cwd: string,
	dimension: 'cmd' | 'tool' | 'dir',
	key: string,
): { entries: ApprovalEntry[]; counts: Record<string, number> } {
	const file = readApprovalsFile();
	const projectKey = getProjectKey(cwd);
	const project = file.projects[projectKey];

	if (!project) {
		return { entries: [], counts: {} };
	}

	// 根据维度筛选要删除的条目
	project.entries = project.entries.filter((entry) => {
		if (entry.action === 'blocked') {
			// blocked 条目不受策略删除影响
			return true;
		}
		switch (dimension) {
			case 'cmd': {
				const normalized = entry.cmd.trim().replace(/\s+/g, ' ');
				const cmdHash = createHash('sha256').update(normalized).digest('hex').slice(0, 16);
				return `cmd:${cmdHash}` !== key;
			}
			case 'tool':
				return `tool:${entry.tool}` !== key;
			case 'dir':
				return `dir:${entry.dir}` !== key;
			default:
				return true;
		}
	});

	writeApprovalsFile(file);

	const newCounts = deriveCounts(project.entries);
	log.info(
		'Deleted strategy %s:%s for project %s, remaining entries: %d',
		dimension,
		key,
		projectKey,
		project.entries.length,
	);

	return { entries: [...project.entries], counts: newCounts };
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
 *
 * Gate OFF:              "[-] gate:off"
 * Gate ON + Dynamic OFF: "gate(100):on[cmd(42),tool(1),folder(1)]"
 *                         (100 = 总记录数; 括号内为各维度历史策略数)
 * Gate ON + Dynamic ON:  "dynamic-gate(100[8]):on[cmd(40[0]):1/2,tool(1[0]):0/3,folder(1[0]):0/4]"
 *                         (100 = 总记录数, [8] = 已沉淀策略总数)
 *
 * 注意：当某维度阈值 <= 0 时，该维度的已沉淀数强制为 0（阈值 0 表示不自动放行）。
 */
export function calcWidgetContentText(
	enabled: boolean,
	dynamicEnabled: boolean,
	counts: Record<string, number>,
	thresholds: { sameCommand: number; sameTool: number; sameFolder: number },
	totalRecords: number,
): string {
	if (!enabled) return '[-] gate:off';

	const summary = getStrategySummary(counts, thresholds);
	const cmdTotal = summary.cmd.total;
	const toolTotal = summary.tool.total;
	const dirTotal = summary.dir.total;
	const totalStrategies = cmdTotal + toolTotal + dirTotal;

	if (!dynamicEnabled) {
		// Dynamic OFF: 显示记录总数 + 策略数
		const parts: string[] = [];
		if (cmdTotal > 0) parts.push(`cmd(${cmdTotal})`);
		if (toolTotal > 0) parts.push(`tool(${toolTotal})`);
		if (dirTotal > 0) parts.push(`folder(${dirTotal})`);

		const suffix = parts.length > 0 ? `(${totalRecords}):on[${parts.join(',')}]` : ':on';
		return `gate${suffix}`;
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
	return `dynamic-gate${suffix}`;
}

// ============================================================================
// 迁移：旧版 approvalCounts → 新版记录格式
// ============================================================================

/**
 * 将旧版 `Record<string, number>` 迁移到新版审批记录。
 *
 * 旧数据的 key 格式（cmd:hash / tool:name / dir:path）本就是合法的 _counts 格式，
 * 因此直接保留原始计数作为 _counts。同时创建一条审计摘要记录到 approvals.json。
 */
function migrateFromLegacy(
	cwd: string,
	legacyCounts: Record<string, number>,
): { entries: ApprovalEntry[]; counts: Record<string, number> } {
	const absPath = resolve(cwd);
	const ts = new Date().toISOString();
	const cmdKeys = Object.keys(legacyCounts).filter((k) => k.startsWith('cmd:'));
	const toolKeys = Object.keys(legacyCounts).filter((k) => k.startsWith('tool:'));
	const dirKeys = Object.keys(legacyCounts).filter((k) => k.startsWith('dir:'));

	// 审计摘要记录
	const entry: ApprovalEntry = {
		ts,
		cmd: `(migrated: ${cmdKeys.length} cmd keys, ${toolKeys.length} tool keys, ${dirKeys.length} dir keys)`,
		tool: '(migrated)',
		dir: absPath,
		dim: ['sameCommand'],
		action: 'confirmed',
	};

	// 写入新文件
	const file = readApprovalsFile();
	const key = getProjectKey(cwd);
	file.projects[key] = {
		path: absPath,
		git: getGitRemote(absPath) ?? undefined,
		entries: [entry],
	};
	writeApprovalsFile(file);

	log.info(
		'Migrated %d legacy count entries (%d cmd, %d tool, %d dir) for %s — counts preserved as-is',
		Object.keys(legacyCounts).length,
		cmdKeys.length,
		toolKeys.length,
		dirKeys.length,
		absPath,
	);

	// ⚠ 直接返回原始计数，不再重新哈希
	// 旧数据的 cmd:hash 已经是合法 key，makeCommandKey 与 deriveCounts 的 SHA256 算法一致
	return { entries: [entry], counts: { ...legacyCounts } };
}

// ============================================================================
// 命令拆分
// ============================================================================

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
