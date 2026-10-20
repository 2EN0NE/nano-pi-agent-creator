import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
	appendAudit,
	classifyDeny,
	isDenyDecision,
	listAuditFiles,
	readAuditFile,
	resetAuditStore,
	type AuditDecision,
	type AuditEntry,
} from '../../../extensions/security/permission-gate/audit-log';
import {
	getProjectKey,
	migrateApprovalsToAudit,
	resetRecordsStore,
} from '../../../extensions/security/permission-gate/records';
import { computeAnalytics } from '../../../extensions/security/permission-gate/analytics';
import type { DangerTier } from '../../../extensions/security/permission-gate/config';

let homeDir: string;

beforeEach(() => {
	homeDir = mkdtempSync(join(tmpdir(), 'pg-deny-'));
	resetAuditStore(homeDir);
	resetRecordsStore(homeDir);
});

afterEach(() => {
	rmSync(homeDir, { recursive: true, force: true });
});

function entry(over: Partial<AuditEntry> = {}): AuditEntry {
	return {
		id: `id-${Math.random().toString(36).slice(2)}`,
		ts: new Date().toISOString(),
		tool: 'bash',
		command: 'rm -rf /tmp/x',
		tier: 'warning',
		decision: 'deny',
		reasons: [],
		projectKey: 'git:test',
		...over,
	};
}

describe('拒绝成因分类', () => {
	it('带 denyCause=user 标记的 deny = 用户拒绝', () => {
		expect(classifyDeny(entry({ decision: 'deny', denyCause: 'user' }))).toBe('user');
	});

	it('仅带溯源字段（拆分前写入的历史行，也带 sessionId/projectPath）= 不可判定', () => {
		expect(classifyDeny(entry({ decision: 'deny', sessionId: 's1' }))).toBe('unknown');
		expect(classifyDeny(entry({ decision: 'deny', projectPath: '/p' }))).toBe('unknown');
	});

	it('无标记的 deny = 成因不可判定', () => {
		expect(classifyDeny(entry({ decision: 'deny' }))).toBe('unknown');
	});

	it('无界面自动拦截 ≠ 用户拒绝', () => {
		expect(classifyDeny(entry({ decision: 'blocked-no-ui' }))).toBe('no-ui');
	});

	it('迁移条目 = 成因不可判定', () => {
		expect(classifyDeny(entry({ decision: 'deny-legacy' }))).toBe('unknown');
	});

	it('放行类决策不属于拒绝', () => {
		for (const d of ['allow', 'ask', 'auto'] as AuditDecision[]) {
			expect(classifyDeny(entry({ decision: d }))).toBeNull();
			expect(isDenyDecision(d)).toBe(false);
		}
	});

	it('isDenyDecision 覆盖三类拒绝', () => {
		for (const d of ['deny', 'blocked-no-ui', 'deny-legacy'] as AuditDecision[]) {
			expect(isDenyDecision(d)).toBe(true);
		}
	});
});

describe('审计写入往返', () => {
	it('无界面拦截写入后读回仍可识别为非用户拒绝', () => {
		appendAudit(entry({ decision: 'blocked-no-ui', sessionId: 's1' }));
		const rows = listAuditFiles().flatMap((f) => readAuditFile(f));
		expect(rows).toHaveLength(1);
		expect(rows[0]!.decision).toBe('blocked-no-ui');
		expect(classifyDeny(rows[0]!)).toBe('no-ui');
	});

	it('用户拒绝写入后读回识别为用户拒绝', () => {
		appendAudit(entry({ decision: 'deny', denyCause: 'user', sessionId: 's1' }));
		const rows = listAuditFiles().flatMap((f) => readAuditFile(f));
		expect(classifyDeny(rows[0]!)).toBe('user');
	});

	it('旧格式行（无新字段）读回不崩溃且归类为不可判定', () => {
		const legacy = {
			id: 'x',
			ts: new Date().toISOString(),
			tool: 'rm',
			command: 'rm -rf /tmp/test',
			tier: 'None',
			decision: 'deny',
			reasons: [],
			projectKey: 'git:ef10fc90dc8b',
			originalCommand: 'rm -rf /tmp/test',
		} as unknown as AuditEntry;
		appendAudit(legacy);
		const rows = listAuditFiles().flatMap((f) => readAuditFile(f));
		expect(classifyDeny(rows[0]!)).toBe('unknown');
	});
});

describe('旧数据迁移标记', () => {
	it('旧 action=blocked 迁移为 deny-legacy（不得计作用户拒绝）', () => {
		const cwd = join(homeDir, 'proj');
		mkdirSync(cwd, { recursive: true });
		const file = join(
			homeDir,
			'.pi',
			'agent',
			'extensions-data',
			'permission-gate',
			'approvals.json',
		);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(
			file,
			JSON.stringify({
				projects: {
					[getProjectKey(cwd)]: {
						entries: [
							{
								ts: new Date().toISOString(),
								cmd: 'rm -rf /tmp/legacy',
								tool: 'rm',
								dir: '/tmp',
								dim: null,
								action: 'blocked',
							},
						],
					},
				},
			}),
		);

		const result = migrateApprovalsToAudit(cwd);
		expect(result.migrated).toBe(1);

		const rows = listAuditFiles().flatMap((f) => readAuditFile(f));
		const migrated = rows.find((r) => r.command.includes('legacy'));
		expect(migrated?.decision).toBe('deny-legacy');
		expect(classifyDeny(migrated!)).toBe('unknown');
	});
});

describe('分析指标不被噪声污染', () => {
	it('误拦率只计用户拒绝，不计无界面拦截与迁移条目', () => {
		const mk = (
			decision: AuditDecision,
			tier: DangerTier = 'warning',
			sessionId?: string,
			denyCause?: 'user',
		): AuditEntry =>
			entry({
				decision,
				tier,
				...(sessionId ? { sessionId } : {}),
				...(denyCause ? { denyCause } : {}),
			});

		const rows: AuditEntry[] = [
			mk('ask'),
			mk('auto'),
			mk('blocked-no-ui', 'warning', 's1'),
			mk('blocked-no-ui', 'warning', 's1'),
			mk('blocked-no-ui', 'warning', 's1'),
			...Array.from({ length: 10 }, () => mk('deny-legacy')),
			...Array.from({ length: 5 }, () => mk('deny')),
			mk('deny', 'warning', 's1', 'user'),
			mk('deny', 'warning', 's2', 'user'),
		];

		const m = computeAnalytics(rows, 36500);
		// 全部拦截 20 条，但真拒绝只有 2 条
		expect(m.byTier.warning.blocked).toBe(20);
		expect(m.falseBlockRate).toBeCloseTo(2 / 22, 5);
		expect(m.falseBlockRate).toBeLessThan(0.5);
	});
});
