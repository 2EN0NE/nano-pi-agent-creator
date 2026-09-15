/**
 * permission-gate — 范围根的出处条件 Vitest 测试（Ticket 04 / ADR-0059 补充）
 *
 * 四种组合（挂/不挂条件 × 目标是否本会话创建）+ fail-closed 边界，
 * 以及用真实出处账本驱动的集成式验证。
 */
import { describe, it, expect } from 'vitest';
import { matchScope } from '../../../extensions/security/permission-gate/index';
import type { TrustRoot } from '../../../extensions/security/permission-gate/config';
import { ProvenanceLedger } from '../../../extensions/security/permission-gate/provenance';
import type { ProvenanceVerdict } from '../../../extensions/security/permission-gate/provenance';

const CWD = '/proj';
const plain: TrustRoot[] = [{ root: '/proj' }, { root: '/tmp' }];
const guarded: TrustRoot[] = [{ root: '/proj' }, { root: '/tmp', requireSessionProvenance: true }];

const judgeOf = (verdict: ProvenanceVerdict) => () => verdict;

describe('四种组合', () => {
	it('不挂条件 → 目标在根内即命中（不看出处）', () => {
		const m = matchScope('rm -rf /tmp/a', CWD, plain, judgeOf('no'));
		expect(m.inScope).toBe(true);
	});

	it('挂条件 + 目标由本会话创建 → 命中', () => {
		const m = matchScope('rm -rf /tmp/a', CWD, guarded, judgeOf('yes'));
		expect(m.inScope).toBe(true);
	});

	it('挂条件 + 目标不是本会话创建的 → 不命中，原因含出处条件', () => {
		const m = matchScope('rm -rf /tmp/a', CWD, guarded, judgeOf('no'));
		expect(m.inScope).toBe(false);
		expect(m.reason).toContain('出处条件');
	});

	it('挂条件 + 出处不可判定 → 不命中（失败即拒绝）', () => {
		const m = matchScope('rm -rf /tmp/a', CWD, guarded, judgeOf('unknown'));
		expect(m.inScope).toBe(false);
		expect(m.reason).toContain('unknown');
	});

	it('未提供出处判定器 → 带条件的根一律不满足', () => {
		expect(matchScope('rm -rf /tmp/a', CWD, guarded).inScope).toBe(false);
	});
});

describe('多根交互', () => {
	it('同一目标另有**无条件**根覆盖 → 命中，且不触发出处判定（惰性）', () => {
		let calls = 0;
		const counting = () => {
			calls++;
			return 'no' as ProvenanceVerdict;
		};
		const m = matchScope('rm -rf /tmp/a', CWD, plain, counting);
		expect(m.inScope).toBe(true);
		expect(calls).toBe(0);
	});

	it('项目内的目标不受 /tmp 条件影响', () => {
		const m = matchScope('rm -rf /proj/dist', CWD, guarded, judgeOf('no'));
		expect(m.inScope).toBe(true);
	});

	it('项目根与 /tmp 都挂条件时，项目内目标同样受条件约束', () => {
		const both: TrustRoot[] = [
			{ root: '/proj', requireSessionProvenance: true },
			{ root: '/tmp', requireSessionProvenance: true },
		];
		expect(matchScope('rm -rf /proj/dist', CWD, both, judgeOf('no')).inScope).toBe(false);
		expect(matchScope('rm -rf /proj/dist', CWD, both, judgeOf('yes')).inScope).toBe(true);
	});

	it('无目标路径 + cwd 只被带条件的根覆盖 → 不命中', () => {
		const m = matchScope('ls -la', '/tmp', [{ root: '/tmp', requireSessionProvenance: true }]);
		expect(m.inScope).toBe(false);
		expect(m.reason).toContain('无目标路径');
	});

	it('无目标路径 + 有无条件根覆盖 cwd → 命中', () => {
		const m = matchScope('ls -la', '/proj', guarded);
		expect(m.inScope).toBe(true);
	});

	it('出处判定按命令求值一次（多目标共享）', () => {
		let calls = 0;
		const counting = () => {
			calls++;
			return 'yes' as ProvenanceVerdict;
		};
		const m = matchScope('rm -rf /tmp/a /tmp/b /tmp/c', CWD, guarded, counting);
		expect(m.inScope).toBe(true);
		expect(calls).toBe(1);
	});
});

describe('与真实出处账本联调', () => {
	it('本会话 mktemp 出来的临时目录 → 命中；别人的 /tmp 目录 → 不命中', () => {
		const ledger = new ProvenanceLedger();
		ledger.observe('T=$(mktemp -d)', CWD);
		const roots: TrustRoot[] = [
			{ root: '/proj' },
			{ root: '/tmp', requireSessionProvenance: true },
		];
		const judge = (c: string, w: string) => ledger.judge(c, w);

		expect(matchScope('rm -rf "$T"', CWD, roots, judge).inScope).toBe(true);
		expect(matchScope('rm -rf /tmp/someone-else', CWD, roots, judge).inScope).toBe(false);
		// 未绑定变量 → 不可判定 → 不命中
		expect(matchScope('rm -rf "$UNBOUND/x"', CWD, roots, judge).inScope).toBe(false);
	});
});
