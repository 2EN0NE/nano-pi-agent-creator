import { describe, it, expect } from 'vitest';
import { computeAnalytics } from '../../../extensions/security/permission-gate/analytics';
import type { AuditEntry } from '../../../extensions/security/permission-gate/audit-log';

function entry(over: Partial<AuditEntry> & { ts: string }): AuditEntry {
	return {
		id: over.id ?? 'id-' + Math.random(),
		ts: over.ts,
		tool: over.tool ?? 'bash',
		command: over.command ?? 'cmd',
		tier: over.tier ?? null,
		decision: over.decision ?? 'allow',
		...(over.denyCause ? { denyCause: over.denyCause } : {}),
		reasons: over.reasons ?? [],
		...(over.sessionId ? { sessionId: over.sessionId } : {}),
		...(over.projectPath ? { projectPath: over.projectPath } : {}),
	};
}

describe('computeAnalytics 审计分析聚合（T10）', () => {
	it('按级别分组计数（confirmed/auto/blocked）', () => {
		const entries: AuditEntry[] = [
			entry({
				ts: '2026-01-15T10:00:00Z',
				command: 'sudo rm /x',
				tier: 'critical',
				decision: 'ask',
			}),
			entry({
				ts: '2026-01-15T10:01:00Z',
				command: 'cat /etc/hosts',
				tier: 'warning',
				decision: 'auto',
			}),
			entry({
				ts: '2026-01-15T10:02:00Z',
				command: 'dd if=/dev/zero of=/dev/sda',
				tier: 'critical',
				decision: 'deny',
			}),
			entry({ ts: '2026-01-15T10:03:00Z', command: 'ls', tier: null, decision: 'allow' }),
		];

		const m = computeAnalytics(entries);
		expect(m.byTier.critical).toEqual({ confirmed: 1, auto: 0, blocked: 1 });
		expect(m.byTier.warning).toEqual({ confirmed: 0, auto: 1, blocked: 0 });
		expect(m.byTier.info).toEqual({ confirmed: 0, auto: 0, blocked: 0 });
		expect(m.totalIntercepted).toBe(3); // allow 不参与
	});

	it('critical 被 graduated 放行进入异常清单（去重）', () => {
		const entries: AuditEntry[] = [
			entry({
				ts: '2026-01-15T10:00:00Z',
				command: 'sudo systemctl restart x',
				tier: 'critical',
				decision: 'auto',
			}),
			entry({
				ts: '2026-01-15T10:01:00Z',
				command: 'sudo systemctl restart x',
				tier: 'critical',
				decision: 'auto',
			}),
			entry({
				ts: '2026-01-15T10:02:00Z',
				command: 'rm /etc/x',
				tier: 'critical',
				decision: 'auto',
			}),
		];

		const m = computeAnalytics(entries);
		expect(m.criticalGraduated).toHaveLength(2);
		expect(m.criticalGraduated).toContain('sudo systemctl restart x');
		expect(m.criticalGraduated).toContain('rm /etc/x');
	});

	it('allowed-unattended 计入 auto 桶，但不进 criticalGraduated', () => {
		const entries: AuditEntry[] = [
			entry({
				ts: '2026-01-15T10:00:00Z',
				command: 'rm -rf .scratch/tmp',
				tier: 'critical',
				decision: 'allowed-unattended',
			}),
		];

		const m = computeAnalytics(entries);
		// 「拦截总数」与三桶之和必须对得上：豁免放行不是拦截，但也不是「未命中」
		expect(m.byTier.critical).toEqual({ confirmed: 0, auto: 1, blocked: 0 });
		expect(m.totalIntercepted).toBe(1);
		// 显式许可 ≠ 策略沉淀（critical 只存 session），不得进异常清单
		expect(m.criticalGraduated).toHaveLength(0);
	});

	it('高频被确认命令 Top N（降序）', () => {
		const entries: AuditEntry[] = [
			entry({
				ts: '2026-01-15T10:00:00Z',
				command: 'rm -rf /tmp/x',
				tier: 'warning',
				decision: 'ask',
			}),
			entry({
				ts: '2026-01-15T10:01:00Z',
				command: 'rm -rf /tmp/x',
				tier: 'warning',
				decision: 'ask',
			}),
			entry({
				ts: '2026-01-15T10:02:00Z',
				command: 'rm -rf /tmp/x',
				tier: 'warning',
				decision: 'ask',
			}),
			entry({
				ts: '2026-01-15T10:03:00Z',
				command: 'chmod 777 /etc/a',
				tier: 'critical',
				decision: 'ask',
			}),
			entry({
				ts: '2026-01-15T10:04:00Z',
				command: 'chmod 777 /etc/a',
				tier: 'critical',
				decision: 'ask',
			}),
		];

		const m = computeAnalytics(entries, undefined, 5);
		expect(m.topConfirmed[0]).toEqual({ command: 'rm -rf /tmp/x', count: 3 });
		expect(m.topConfirmed[1]).toEqual({ command: 'chmod 777 /etc/a', count: 2 });
	});

	it('误拦比例 = 用户拒绝 / 拦截总数', () => {
		const entries: AuditEntry[] = [
			entry({ ts: '2026-01-15T10:00:00Z', command: 'a', tier: 'info', decision: 'ask' }),
			entry({ ts: '2026-01-15T10:01:00Z', command: 'b', tier: 'info', decision: 'ask' }),
			entry({
				ts: '2026-01-15T10:02:00Z',
				command: 'c',
				tier: 'info',
				decision: 'deny',
				denyCause: 'user',
				sessionId: 's1',
			}),
			entry({ ts: '2026-01-15T10:03:00Z', command: 'd', tier: 'info', decision: 'auto' }),
		];

		const m = computeAnalytics(entries);
		expect(m.falseBlockRate).toBeCloseTo(0.25); // 1 用户拒绝 / 4 拦截
	});

	it('误拦比例不计无界面自动拦截与历史迁移条目（不是用户意图）', () => {
		const entries: AuditEntry[] = [
			entry({ ts: '2026-01-15T10:00:00Z', command: 'a', tier: 'info', decision: 'ask' }),
			entry({
				ts: '2026-01-15T10:01:00Z',
				command: 'c',
				tier: 'info',
				decision: 'deny',
				denyCause: 'user',
				sessionId: 's1',
			}),
			entry({
				ts: '2026-01-15T10:02:00Z',
				command: 'e',
				tier: 'info',
				decision: 'blocked-no-ui',
			}),
			entry({
				ts: '2026-01-15T10:03:00Z',
				command: 'f',
				tier: 'info',
				decision: 'deny-legacy',
			}),
		];

		const m = computeAnalytics(entries);
		// 4 条拦截里只有 1 条是真拒绝；无界面拦截 1 条 + 迁移 1 条不得计入分子
		expect(m.byTier.info.blocked).toBe(3);
		expect(m.falseBlockRate).toBeCloseTo(0.25);
	});

	it('时间窗口过滤（7 天）', () => {
		const now = Date.now();
		const daysAgo = (d: number) => new Date(now - d * 86400000).toISOString();
		const entries: AuditEntry[] = [
			entry({ ts: daysAgo(1), command: 'recent', tier: 'info', decision: 'ask' }),
			entry({ ts: daysAgo(30), command: 'old', tier: 'info', decision: 'ask' }),
		];

		const m = computeAnalytics(entries, 7);
		expect(m.totalIntercepted).toBe(1);
		expect(m.byTier.info.confirmed).toBe(1);
	});

	it('空输入返回全零指标', () => {
		const m = computeAnalytics([]);
		expect(m.totalIntercepted).toBe(0);
		expect(m.falseBlockRate).toBe(0);
		expect(m.criticalGraduated).toEqual([]);
		expect(m.topConfirmed).toEqual([]);
	});
});
