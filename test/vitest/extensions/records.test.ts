/**
 * permission-gate — 审批记录纯函数与迁移 Vitest 测试（ADR-0027 补充）
 *
 * 覆盖：getProjectKey、countNonBlockedEntries、normalizeDim、migrateApprovalsToAudit
 * （旧 approvals.json → audit JSONL + pi-state counts，含 .bak 备份）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
	resetRecordsStore,
	getProjectKey,
	countNonBlockedEntries,
	normalizeDim,
	migrateApprovalsToAudit,
	type ApprovalEntry,
} from '../../../extensions/security/permission-gate/records';
import {
	resetAuditStore,
	listAuditFiles,
	readAuditFile,
} from '../../../extensions/security/permission-gate/audit-log';
import {
	resetRulesStore,
	getRuleCounts,
} from '../../../extensions/security/permission-gate/approval-store';

let tmpDir: string;
let tmpHome: string;
let tmpCwd: string;

const mkEntry = (over?: Partial<ApprovalEntry>): ApprovalEntry => ({
	ts: '2026-01-15T10:00:00.000Z',
	cmd: 'rm -rf /tmp/test',
	tool: 'rm',
	dir: '/tmp',
	dim: null,
	action: 'auto',
	tier: 'warning',
	...over,
});

const approvalsFile = () =>
	join(tmpHome, '.pi', 'agent', 'extensions-data', 'permission-gate', 'approvals.json');

beforeEach(() => {
	tmpDir = join(tmpdir(), `pg-records-test-${randomBytes(4).toString('hex')}`);
	tmpHome = join(tmpDir, 'home');
	tmpCwd = join(tmpDir, 'cwd');
	mkdirSync(tmpHome, { recursive: true });
	mkdirSync(tmpCwd, { recursive: true });
	resetRecordsStore(tmpHome);
	resetAuditStore(tmpHome);
	resetRulesStore({ homeDir: tmpHome, cwd: tmpCwd });
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

describe('getProjectKey', () => {
	it('无 git remote 时回退到路径 SHA256', () => {
		expect(getProjectKey(tmpCwd)).toMatch(/^path:[a-f0-9]{12}$/);
	});

	it('同一路径生成稳定 key', () => {
		expect(getProjectKey(tmpCwd)).toBe(getProjectKey(tmpCwd));
	});
});

describe('countNonBlockedEntries', () => {
	it('排除 blocked 条目', () => {
		const entries = [
			mkEntry({ action: 'auto' }),
			mkEntry({ action: 'confirmed' }),
			mkEntry({ action: 'blocked' }),
		];
		expect(countNonBlockedEntries(entries)).toBe(2);
	});
});

describe('normalizeDim', () => {
	it('兼容 string[] / string / null', () => {
		expect(normalizeDim(['a', 'b', 'a'])).toEqual(['a', 'b']);
		expect(normalizeDim('sameCommand')).toEqual(['sameCommand']);
		expect(normalizeDim(null)).toBeNull();
		expect(normalizeDim([])).toBeNull();
	});
});

describe('migrateApprovalsToAudit', () => {
	it('迁移 entries 到 audit + pi-state，并重命名旧文件为 .bak', () => {
		// 构造旧 approvals.json
		const key = getProjectKey(tmpCwd);
		mkdirSync(join(tmpHome, '.pi', 'agent', 'extensions-data', 'permission-gate'), {
			recursive: true,
		});
		writeFileSync(
			approvalsFile(),
			JSON.stringify({
				projects: {
					[key]: {
						path: tmpCwd,
						entries: [
							mkEntry({ action: 'auto', tier: 'warning' }),
							mkEntry({ action: 'blocked', tier: 'critical', cmd: 'sudo rm -rf /' }),
						],
					},
				},
			}),
		);

		const r = migrateApprovalsToAudit(tmpCwd);
		expect(r.migrated).toBe(2);
		expect(r.backedUp).toBe(true);

		// 旧文件被重命名 .bak
		expect(existsSync(approvalsFile())).toBe(false);
		const dir = join(tmpHome, '.pi', 'agent', 'extensions-data', 'permission-gate');
		const bak = readdirSync(dir).find((f) => f.startsWith('approvals.json.migrated-'));
		expect(bak).toBeTruthy();

		// audit JSONL 有 2 条记录（含 projectKey + decision 映射）
		const files = listAuditFiles();
		expect(files).toHaveLength(1);
		const entries = readAuditFile(files[0]);
		expect(entries).toHaveLength(2);
		expect(entries[0].projectKey).toBe(key);
		expect(entries.map((e) => e.decision).sort()).toEqual(['auto', 'deny']);

		// pi-state counts：blocked 不计数，auto 的 rm 累加 cmd/tool/dir
		const counts = getRuleCounts();
		expect(counts['tool:rm']).toBe(1);
		expect(counts['dir:/tmp']).toBe(1);
		expect(Object.keys(counts).some((k) => k.startsWith('cmd:'))).toBe(true);
	});

	it('无当前项目数据时返回 migrated=0', () => {
		const r = migrateApprovalsToAudit(tmpCwd);
		expect(r.migrated).toBe(0);
		expect(r.backedUp).toBe(false);
	});

	it('迁移采用 write-ahead：成功后重跑不重复追加审计/计数（防崩溃重放）', () => {
		const key = getProjectKey(tmpCwd);
		mkdirSync(join(tmpHome, '.pi', 'agent', 'extensions-data', 'permission-gate'), {
			recursive: true,
		});
		writeFileSync(
			approvalsFile(),
			JSON.stringify({
				projects: {
					[key]: {
						path: tmpCwd,
						entries: [mkEntry({ action: 'auto', tier: 'warning' })],
					},
				},
			}),
		);

		const first = migrateApprovalsToAudit(tmpCwd);
		expect(first.migrated).toBe(1);

		// 源已被消费（改名备份）→ 重跑不产生任何新条目
		const before = readAuditFile(listAuditFiles()[0]).length;
		const countsBefore = { ...getRuleCounts() };
		const second = migrateApprovalsToAudit(tmpCwd);
		expect(second.migrated).toBe(0);
		expect(readAuditFile(listAuditFiles()[0])).toHaveLength(before);
		expect(getRuleCounts()).toEqual(countsBefore);
	});

	it('迁移旧 config.json approvalCounts 到 warning 层，且幂等（删除源字段）', () => {
		const configFile = () =>
			join(tmpCwd, '.pi', 'extensions-data', 'permission-gate', 'config.json');
		mkdirSync(join(tmpCwd, '.pi', 'extensions-data', 'permission-gate'), {
			recursive: true,
		});
		writeFileSync(
			configFile(),
			JSON.stringify({ approvalCounts: { 'cmd:legacy': 3, 'tool:rm': 2 } }),
		);

		// 第一次迁移：计数进入 warning 层，源字段被删除
		const first = migrateApprovalsToAudit(tmpCwd);
		expect(first.migrated).toBe(2);
		expect(getRuleCounts()['cmd:legacy']).toBe(3);
		expect(getRuleCounts()['tool:rm']).toBe(2);
		const afterFirst = JSON.parse(readFileSync(configFile(), 'utf-8'));
		expect(afterFirst.approvalCounts).toBeUndefined();

		// 第二次迁移：源字段已删除，不重复累加（幂等）
		const second = migrateApprovalsToAudit(tmpCwd);
		expect(second.migrated).toBe(0);
		expect(getRuleCounts()['cmd:legacy']).toBe(3);
		expect(getRuleCounts()['tool:rm']).toBe(2);
	});
});
