/**
 * permission-gate — 提升候选现场检测 Vitest 测试（Ticket 05 / ADR-0058 补充）
 *
 * 覆盖：阈值边界、"自动放行过则不产候选"、维度优先级、同模式不重复、
 * 忽略后不再提示、证据统计（含"无界面拦截与迁移条目不算用户拒绝"）。
 */
import { describe, it, expect } from 'vitest';
import {
	PromotionTracker,
	type DetectInput,
} from '../../../extensions/security/permission-gate/promotion';
import {
	makeCommandKey,
	makeFolderKey,
	makeToolKey,
} from '../../../extensions/security/permission-gate/config';
import type { AuditEntry } from '../../../extensions/security/permission-gate/audit-log';

const THRESHOLDS = { sameCommand: 2, sameTool: 3, sameFolder: 4 };

function input(over: Partial<DetectInput> = {}): DetectInput {
	return {
		tool: 'rm',
		command: 'rm -rf /tmp/probe',
		dir: '/tmp',
		tier: 'warning',
		thresholds: THRESHOLDS,
		...over,
	};
}

/** 一次"人工放行"：按三个维度键记一次 */
function approveManually(t: PromotionTracker, i: DetectInput): void {
	t.noteDecision('manual', [
		makeCommandKey(i.command),
		makeToolKey(i.tool),
		makeFolderKey(i.dir),
	]);
}

function audit(over: Partial<AuditEntry>): AuditEntry {
	return {
		id: 'id-' + Math.random(),
		ts: '2026-09-12T10:00:00.000Z',
		tool: 'bash',
		command: 'cmd',
		tier: 'warning',
		decision: 'allow',
		reasons: [],
		...over,
	};
}

describe('阈值边界（目录级：4 次）', () => {
	it('不到阈值不产候选，达到阈值产出（维度 = sameFolder）', () => {
		const t = new PromotionTracker();
		// 隔离目录维度：命令每次不同（`rm -rf /tmp/probe-N` 这类真实形态），
		// 并把命令/工具阈值抬高，以免先命中更细的维度
		const only = { sameCommand: 99, sameTool: 99, sameFolder: 4 };
		const at = (n: number): DetectInput =>
			input({ command: `rm -rf /tmp/probe-${n}`, thresholds: only });

		for (let n = 1; n <= 3; n++) {
			approveManually(t, at(n));
			expect(t.detect(at(n))).toBeNull();
		}
		approveManually(t, at(4));
		const c = t.detect(at(4));
		expect(c?.dimension).toBe('sameFolder');
		expect(c?.key).toBe(makeFolderKey('/tmp'));
		expect(c?.evidence.sessionManual).toBe(4);
		expect(c?.evidence.sessionAuto).toBe(0);
	});
});

describe('自动放行过的模式不产候选', () => {
	it('同键出现过自动放行 → 该维度不产候选', () => {
		const t = new PromotionTracker();
		t.noteDecision('auto', [makeFolderKey('/tmp')]);
		for (let i = 0; i < 6; i++) approveManually(t, input());
		const c = t.detect(input());
		// 目录级被跳过，退到工具级（工具级未自动放行，人工 6 ≥ 3）
		expect(c?.dimension).toBe('sameTool');
	});

	it('三个维度都自动放行过 → 不产候选', () => {
		const t = new PromotionTracker();
		const i = input();
		t.noteDecision('auto', [
			makeCommandKey(i.command),
			makeToolKey(i.tool),
			makeFolderKey(i.dir),
		]);
		for (let n = 0; n < 6; n++) approveManually(t, i);
		expect(t.detect(i)).toBeNull();
	});
});

describe('维度顺序与阈值 0', () => {
	it('目录级先于工具级（越宽越先推荐）', () => {
		const t = new PromotionTracker();
		for (let i = 0; i < 4; i++) approveManually(t, input());
		expect(t.detect(input())?.dimension).toBe('sameFolder');
	});

	it('阈值为 0 的维度跳过（配置里明确关掉了该维度）', () => {
		const t = new PromotionTracker();
		const i = input({ thresholds: { sameCommand: 0, sameTool: 0, sameFolder: 0 } });
		for (let n = 0; n < 8; n++) approveManually(t, i);
		expect(t.detect(i)).toBeNull();
	});

	it('命令级：2 次即够（其余维度阈值更高时）', () => {
		const t = new PromotionTracker();
		const i = input();
		approveManually(t, i);
		approveManually(t, i);
		const c = t.detect(i);
		expect(c?.dimension).toBe('sameCommand');
		expect(c?.evidence.sessionManual).toBe(2);
	});
});

describe('危险等级门禁（ADR-0058 硬约束）', () => {
	it('critical（提权/凭证/不可逆）即使达阈值也不产候选', () => {
		const t = new PromotionTracker();
		const i = input({ tier: 'critical' });
		for (let n = 0; n < 8; n++) approveManually(t, i);
		expect(t.detect(i)).toBeNull();
	});

	it('tier 为 null（不应出现在危险子命令上）→ 失败即拒绝，不产候选', () => {
		const t = new PromotionTracker();
		const i = input({ tier: null });
		for (let n = 0; n < 8; n++) approveManually(t, i);
		expect(t.detect(i)).toBeNull();
	});

	it('warning / info 可达阈值后产候选，并携带自身等级', () => {
		for (const tier of ['warning', 'info'] as const) {
			const t = new PromotionTracker();
			const i = input({ tier });
			for (let n = 0; n < 4; n++) approveManually(t, i);
			expect(t.detect(i)?.tier).toBe(tier);
		}
	});
});

describe('同一模式不重复 / 忽略后不再提示', () => {
	it('同一会话内同一键只产一次候选', () => {
		const t = new PromotionTracker();
		for (let i = 0; i < 5; i++) approveManually(t, input());
		expect(t.detect(input())).not.toBeNull();
		expect(t.detect(input())).toBeNull();
	});

	it('忽略后不再产出该键的候选', () => {
		const t = new PromotionTracker();
		for (let i = 0; i < 5; i++) approveManually(t, input());
		const key = makeFolderKey('/tmp');
		t.markIgnored(key);
		expect(t.detect(input())?.key).not.toBe(key);
		expect(t.isIgnored(key)).toBe(true);
	});

	it('待查看候选可被取走（Ticket 06 的提示入口）', () => {
		const t = new PromotionTracker();
		for (let i = 0; i < 4; i++) approveManually(t, input());
		t.detect(input());
		expect(t.peekPending()).toHaveLength(1);
		expect(t.takePending()).toHaveLength(1);
		expect(t.peekPending()).toHaveLength(0);
	});
});

describe('证据统计（seed 自审计日志）', () => {
	it('历史目录/会话/真拒绝，且无界面拦截与迁移条目不算用户拒绝', () => {
		const t = new PromotionTracker();
		const entries: AuditEntry[] = [
			audit({ decision: 'ask', projectPath: '/proj-a', sessionId: 's1' }),
			audit({ decision: 'auto', projectPath: '/proj-b', sessionId: 's2' }),
			audit({ decision: 'deny', denyCause: 'user', projectPath: '/proj-a', sessionId: 's3' }), // 真拒绝
			audit({ decision: 'blocked-no-ui', projectPath: '/proj-c', sessionId: 's4' }), // 不是用户意图
			audit({ decision: 'deny-legacy' }), // 迁移条目：成因不可判定
			audit({ decision: 'deny' }), // 无溯源的历史行：成因不可判定
		];
		t.seed(entries, undefined);

		for (let i = 0; i < 4; i++) approveManually(t, input());
		const c = t.detect(input());
		expect(c?.evidence.userDenials).toBe(1);
		// 历史目录只统计非拒绝记录：/proj-a（ask）、/proj-b（auto）
		expect(c?.evidence.historyDirectories).toBe(2);
		expect(c?.evidence.historySessions).toBe(2);
	});

	it('本会话的命令级计数可从审计回放恢复', () => {
		const t = new PromotionTracker();
		const cmd = 'rm -rf /tmp/replay';
		t.seed(
			[
				audit({
					decision: 'ask',
					sessionId: 's1',
					projectPath: '/proj',
					originalCommand: cmd,
				}),
			],
			's1',
		);
		const i = input({ command: cmd });
		// 命令级阈值 2：回放 1 次 + 实时 1 次 = 2
		approveManually(t, i);
		expect(t.detect(i)?.dimension).toBe('sameCommand');
	});
});
