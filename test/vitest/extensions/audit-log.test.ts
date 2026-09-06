import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	appendAudit,
	newRequestId,
	listAuditFiles,
	readAuditFile,
	cleanupAudit,
	resetAuditStore,
	getAuditHealth,
	resetAuditHealth,
	type AuditEntry,
} from '../../../extensions/security/permission-gate/audit-log';

let homeDir: string;

beforeEach(() => {
	homeDir = mkdtempSync(join(tmpdir(), 'pg-audit-'));
	resetAuditStore(homeDir);
	resetAuditHealth();
});

afterEach(() => {
	rmSync(homeDir, { recursive: true, force: true });
});

function auditDir(): string {
	return join(homeDir, '.pi', 'agent', 'extensions-data', 'permission-gate', 'audit');
}

describe('audit-log 全量审计（T6）', () => {
	it('newRequestId 生成唯一 ID', () => {
		const a = newRequestId();
		const b = newRequestId();
		expect(a).toBeTruthy();
		expect(a).not.toBe(b);
	});

	it('appendAudit 追加到当天分片（JSONL）', () => {
		const id = newRequestId();
		appendAudit({
			id,
			ts: '2026-01-15T10:00:00.000Z',
			tool: 'bash',
			command: 'rm -rf /tmp/x',
			tier: 'critical',
			decision: 'ask',
			reasons: ['destructive'],
		});

		const files = listAuditFiles();
		expect(files).toEqual(['2026-01-15.jsonl']);

		const entries = readAuditFile('2026-01-15.jsonl');
		expect(entries).toHaveLength(1);
		expect(entries[0].id).toBe(id);
		expect(entries[0].tier).toBe('critical');
		expect(entries[0].decision).toBe('ask');
		expect(entries[0].reasons).toEqual(['destructive']);
	});

	it('appendAudit 跨天分片', () => {
		appendAudit({
			id: newRequestId(),
			ts: '2026-01-15T10:00:00.000Z',
			tool: 'bash',
			command: 'a',
			tier: null,
			decision: 'allow',
			reasons: [],
		});
		appendAudit({
			id: newRequestId(),
			ts: '2026-01-16T10:00:00.000Z',
			tool: 'bash',
			command: 'b',
			tier: 'warning',
			decision: 'auto',
			reasons: ['system-dir-read'],
		});

		expect(listAuditFiles()).toEqual(['2026-01-15.jsonl', '2026-01-16.jsonl']);
	});

	it('cleanupAudit 删除过期分片（半年滚动）', () => {
		// 直接造分片文件（含半年多前的）
		mkdirSync(auditDir(), { recursive: true });
		const now = new Date();
		const mk = (daysAgo: number) => {
			const d = new Date(now);
			d.setDate(d.getDate() - daysAgo);
			const file = join(auditDir(), `${d.toISOString().slice(0, 10)}.jsonl`);
			writeFileSync(file, '{}\n', 'utf-8');
			return d.toISOString().slice(0, 10);
		};
		const recent = mk(10);
		const old = mk(365);
		const mid = mk(200); // 超过 180 天 → 过期

		const removed = cleanupAudit(180);
		expect(removed).toBeGreaterThanOrEqual(2);

		const files = listAuditFiles();
		expect(files).toContain(`${recent}.jsonl`);
		expect(files).not.toContain(`${old}.jsonl`);
		expect(files).not.toContain(`${mid}.jsonl`);
	});

	it('readAuditFile 跳过损坏行', () => {
		mkdirSync(auditDir(), { recursive: true });
		const file = join(auditDir(), '2026-01-15.jsonl');
		writeFileSync(
			file,
			JSON.stringify({
				id: 'x',
				ts: '2026-01-15T00:00:00Z',
				tool: 'bash',
				command: 'a',
				tier: null,
				decision: 'allow',
				reasons: [],
			}) +
				'\n' +
				'NOT JSON\n' +
				'\n',
			'utf-8',
		);
		const entries = readAuditFile('2026-01-15.jsonl');
		expect(entries).toHaveLength(1);
		expect(entries[0].id).toBe('x');
	});

	it('空目录下 listAuditFiles 返回空数组', () => {
		expect(listAuditFiles()).toEqual([]);
		expect(cleanupAudit()).toBe(0);
	});
});

describe('appendAudit 失败可见性（健康计数）', () => {
	it('写失败被健康计数暴露，连续 3 次升级，恢复后归零', () => {
		// 在审计目录路径上放一个文件 → mkdirSync/appendFileSync 失败
		const dir = auditDir();
		mkdirSync(join(homeDir, '.pi', 'agent', 'extensions-data', 'permission-gate'), {
			recursive: true,
		});
		writeFileSync(dir, 'not-a-dir\n', 'utf-8');

		const entry: AuditEntry = {
			id: 'x',
			ts: '2026-01-15T10:00:00.000Z',
			tool: 'bash',
			command: 'rm -rf /tmp/x',
			tier: null,
			decision: 'allow',
			reasons: [],
		};

		appendAudit(entry);
		appendAudit(entry);
		let h = getAuditHealth();
		expect(h.ok).toBe(false);
		expect(h.consecutiveFailures).toBe(2);
		expect(h.totalFailures).toBe(2);
		expect(h.lastError).toBeTruthy();
		expect(h.escalated).toBe(false);

		// 第 3 次连续失败 → 升级（error 级告警，不再静默）
		appendAudit(entry);
		h = getAuditHealth();
		expect(h.consecutiveFailures).toBe(3);
		expect(h.escalated).toBe(true);

		// 目录恢复 → 写入成功 → 计数归零
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true });
		appendAudit(entry);
		h = getAuditHealth();
		expect(h.ok).toBe(true);
		expect(h.consecutiveFailures).toBe(0);
		expect(h.escalated).toBe(false);
		expect(h.totalFailures).toBe(3); // 累计失败保留，供审计完整性回检
	});
});
