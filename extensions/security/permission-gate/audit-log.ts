/**
 * permission-gate — 全量命令审计日志（T6，ADR-0027）
 *
 * 每次命令执行（全部工具调用，不只被拦截的）生成唯一 ID 并记录。
 * JSONL 按天分片存储，默认保留半年滚动清理；放行规则与配置永久保留。
 *
 * 存储：~/.pi/agent/extensions-data/permission-gate/audit/YYYY-MM-DD.jsonl
 * 每行一条 JSON（append-only，O(1) 追加）。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLogger } from '@zenone/pi-logger';
import type { DangerTier } from './config.js';

const log = createLogger('permission-gate:audit');

/** 审计决策：allow（放行）/ ask（需确认）/ auto（自动放行）/ deny（拒绝） */
export type AuditDecision = 'allow' | 'ask' | 'auto' | 'deny';

export interface AuditEntry {
	/** 唯一 ID（request/control ID，供外部通道凭 ID 确认） */
	id: string;
	/** ISO 时间戳 */
	ts: string;
	/** 工具名（bash 等） */
	tool: string;
	/** 命令摘要 */
	command: string;
	/** 危险分级（null = 未命中规则直接放行） */
	tier: DangerTier | null;
	/** 决策结果 */
	decision: AuditDecision;
	/** 命中维度 */
	reasons: string[];
	/** 项目标识（getProjectKey 的 git:/path: sha 前缀），历史/策略 tab 按此过滤 */
	projectKey?: string;
	/** 产生该记录的项目绝对路径（cwd），历史按来源范围筛选 + 展示路径（UX3） */
	projectPath?: string;
	/** 产生该记录的会话 ID（sessionManager.getSessionId），历史-会话 tab 筛选 */
	sessionId?: string;
	/** 产生该记录时的会话名快照（getSessionName），历史详情展示；会话改名后详情另读最新名 */
	sessionName?: string;
	/** 完整原始命令（不截断），历史/策略 tab 展示用 */
	originalCommand?: string;
	/** 拆分后的子命令列表（完整原文，供策略 tab 反查子命令 hash） */
	subCommands?: string[];
}

/** 默认保留天数（半年） */
export const DEFAULT_RETENTION_DAYS = 180;

let auditHomeDir: string = homedir();

function auditDir(): string {
	return join(auditHomeDir, '.pi', 'agent', 'extensions-data', 'permission-gate', 'audit');
}

function todayFile(ts: string): string {
	const date = ts.slice(0, 10); // YYYY-MM-DD
	return join(auditDir(), `${date}.jsonl`);
}

/** 测试专用：注入 homeDir 隔离真实用户目录 */
export function resetAuditStore(homeDir: string): void {
	auditHomeDir = homeDir;
}

/** 生成唯一请求/控制 ID */
export function newRequestId(): string {
	return randomUUID();
}

// ── 审计健康（失败可见性，ADR-0027 审计完整性） ──
// 追加失败不能静默——审计是全量追溯与回检的数据源。
// 连续失败达到阈值后把单条 warn 升级为 error 并给出处置指引，
// 同时通过 getAuditHealth() 暴露给调用方（widget / 面板可展示）。
const AUDIT_WARN_ESCALATION = 3;

interface AuditHealth {
	/** 自上次成功以来的连续失败次数 */
	consecutiveFailures: number;
	/** 累计失败次数 */
	totalFailures: number;
	/** 最近一次失败原因（无失败为 undefined） */
	lastError: string | undefined;
	/** 是否已发出 error 级告警（连续失败 >= AUDIT_WARN_ESCALATION） */
	escalated: boolean;
	/** 最近一次写入是否成功 */
	ok: boolean;
}

const health: AuditHealth = {
	consecutiveFailures: 0,
	totalFailures: 0,
	lastError: undefined,
	escalated: false,
	ok: true,
};

/** 查询审计写入健康状态（供测试与 UI/日志展示） */
export function getAuditHealth(): AuditHealth {
	return { ...health };
}

/** 测试专用：重置健康计数 */
export function resetAuditHealth(): void {
	health.consecutiveFailures = 0;
	health.totalFailures = 0;
	health.lastError = undefined;
	health.escalated = false;
	health.ok = true;
}

/**
 * 追加一条审计记录（O(1) 追加到当天分片）。
 * 目录不存在时自动创建。
 */
export function appendAudit(entry: AuditEntry): void {
	const file = todayFile(entry.ts);
	try {
		mkdirSync(auditDir(), { recursive: true });
		appendFileSync(file, JSON.stringify(entry) + '\n', 'utf-8');
		health.consecutiveFailures = 0;
		health.escalated = false;
		health.ok = true;
		health.lastError = undefined;
	} catch (err) {
		const msg = String((err as Error).message ?? err);
		health.consecutiveFailures++;
		health.totalFailures++;
		health.lastError = msg;
		health.ok = false;
		// 审计写失败不影响命令执行（在每次 tool_call 热路径），但不得静默：
		// 连续失败升级为 error 级告警，提示磁盘/权限问题与审计缺失风险。
		if (health.consecutiveFailures >= AUDIT_WARN_ESCALATION && !health.escalated) {
			health.escalated = true;
			log.error(
				'AUDIT WRITE FAILING (%d consecutive): %s — audit log incomplete; check disk space/permissions for %s',
				health.consecutiveFailures,
				msg,
				file,
			);
		} else {
			log.warn('failed to append audit entry: %s', msg);
		}
	}
}

/** 列出所有审计分片文件名（YYYY-MM-DD.jsonl） */
export function listAuditFiles(): string[] {
	try {
		if (!existsSync(auditDir())) return [];
		return readdirSync(auditDir())
			.filter((f) => f.endsWith('.jsonl'))
			.sort();
	} catch {
		return [];
	}
}

/** 读取某个分片的全部条目 */
export function readAuditFile(file: string): AuditEntry[] {
	const path = join(auditDir(), file);
	if (!existsSync(path)) return [];
	const lines = readFileSync(path, 'utf-8').split('\n');
	const entries: AuditEntry[] = [];
	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			entries.push(JSON.parse(line) as AuditEntry);
		} catch {
			// 跳过损坏行
		}
	}
	return entries;
}

/**
 * 滚动清理：删除 retentionDays 天之前的分片。
 * @returns 删除的文件数
 */
export function cleanupAudit(retentionDays: number = DEFAULT_RETENTION_DAYS): number {
	const files = listAuditFiles();
	if (files.length === 0) return 0;

	// 保留最近 retentionDays 天的分片（按文件名 YYYY-MM-DD 排序，天然时间序）
	const cutoff = new Date();
	cutoff.setDate(cutoff.getDate() - retentionDays);
	const cutoffStr = cutoff.toISOString().slice(0, 10);

	let removed = 0;
	for (const f of files) {
		// 文件名 < cutoffStr → 过期（YYYY-MM-DD 字典序 == 时间序）
		if (f.replace('.jsonl', '') < cutoffStr) {
			try {
				rmSync(join(auditDir(), f), { force: true });
				removed++;
			} catch {
				// 忽略删除失败
			}
		}
	}
	return removed;
}
