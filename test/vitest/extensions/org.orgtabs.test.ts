/**
 * org tab 行的纯逻辑（ADR-0070 D2/D4/D5/D8）
 *
 * 三个函数全部无 IO，覆盖：
 * - `orderOrgTabs`：所属段在前（最近派活倒序、同刻名字母序），非所属段在后（字母序）
 * - `brailleCount`：0..8 单格点阵、>8 封顶 `⣿+`、`U+2800` 占位保证等宽
 * - `remapOrgIdxByName`：重排后按名跟住当前 tab（绝不沿用旧下标）
 */
import { describe, it, expect } from 'vitest';
import { visibleWidth } from '@earendil-works/pi-tui';
import {
	brailleCount,
	orderOrgTabs,
	remapOrgIdxByName,
	type OrgTabEntry,
} from '../../../extensions/auto/org/orgtabs.js';

const e = (name: string, own: boolean, lastDispatchAt: string | null = null): OrgTabEntry => ({
	name,
	own,
	lastDispatchAt,
});

const names = (list: OrgTabEntry[]) => list.map((x) => x.name);

describe('orderOrgTabs — 所属段在前、段内按最近派活倒序', () => {
	it('无所属：纯字母序（与旧行为一致，不引入回归）', () => {
		const out = orderOrgTabs([e('zeta', false), e('alpha', false), e('mid', false)]);
		expect(names(out)).toEqual(['alpha', 'mid', 'zeta']);
	});

	it('全部所属：仍按最近派活倒序排', () => {
		const out = orderOrgTabs([
			e('a', true, '2026-10-01T00:00:00Z'),
			e('b', true, '2026-10-03T00:00:00Z'),
			e('c', true, '2026-10-02T00:00:00Z'),
		]);
		expect(names(out)).toEqual(['b', 'c', 'a']);
	});

	it('所属在前、非所属在后——两段各自独立排序（所属不按字母、非所属按字母）', () => {
		const out = orderOrgTabs([
			e('aaa-not-mine', false),
			e('zzz-mine-new', true, '2026-10-05T00:00:00Z'),
			e('mmm-mine-old', true, '2026-10-01T00:00:00Z'),
			e('bbb-not-mine', false),
		]);
		expect(names(out)).toEqual([
			'zzz-mine-new',
			'mmm-mine-old',
			'aaa-not-mine',
			'bbb-not-mine',
		]);
	});

	it('无派活记录（null）排在有记录的之后，且 null 之间按名字母序', () => {
		const out = orderOrgTabs([
			e('never-b', true, null),
			e('dated', true, '2026-10-01T00:00:00Z'),
			e('never-a', true, null),
		]);
		expect(names(out)).toEqual(['dated', 'never-a', 'never-b']);
	});

	it('同刻并列按名字母序兜底（判定可复现，不受输入顺序影响）', () => {
		const t = '2026-10-01T00:00:00Z';
		expect(names(orderOrgTabs([e('b', true, t), e('a', true, t)]))).toEqual(['a', 'b']);
		expect(names(orderOrgTabs([e('a', true, t), e('b', true, t)]))).toEqual(['a', 'b']);
	});

	it('空输入返回空数组', () => {
		expect(orderOrgTabs([])).toEqual([]);
	});
});

describe('brailleCount — 单格点阵，>8 封顶', () => {
	it('0..8 全部是**单格**盲文（含 0 的空白盲符），宽度恒为 1', () => {
		const expected = ['⠀', '⠁', '⠃', '⠇', '⡇', '⡏', '⡟', '⡿', '⣿'];
		for (let n = 0; n <= 8; n++) {
			const glyph = brailleCount(n);
			expect(glyph).toBe(expected[n]);
			expect(visibleWidth(glyph)).toBe(1);
		}
	});

	it('0 必须是 U+2800 空白盲符（不是空串）——否则 chip 宽度与点位对齐都会坏', () => {
		expect(brailleCount(0)).toBe('\u2800');
		expect(brailleCount(0)).not.toBe('');
	});

	it('>8 封顶为 `⣿+`（两格），不会再变长', () => {
		for (const n of [9, 12, 40, 999]) expect(brailleCount(n)).toBe('⣿+');
	});

	it('负数与非法值退化为 0（外部输入不可信）', () => {
		expect(brailleCount(-3)).toBe('\u2800');
		expect(brailleCount(Number.NaN)).toBe('\u2800');
	});
});

describe('remapOrgIdxByName — 重排后按名跟住当前 tab', () => {
	it('名字还在：返回它的新下标（不是旧下标）', () => {
		// 原顺序 [a,b,c]，当前看 c（idx 2）；重排后 c 跑到 0
		expect(remapOrgIdxByName(['c', 'a', 'b'], 2, 'c')).toBe(0);
	});

	it('名字消失（org 被删）：夹紧到合法范围', () => {
		expect(remapOrgIdxByName(['a', 'b'], 5, 'gone')).toBe(1);
		expect(remapOrgIdxByName(['a', 'b'], -1, 'gone')).toBe(0);
	});

	it('空名单返回 0（不产生负下标）', () => {
		expect(remapOrgIdxByName([], 3, 'x')).toBe(0);
	});

	it('没有 keepName 时也夹紧旧下标', () => {
		expect(remapOrgIdxByName(['a', 'b'], 9, undefined)).toBe(1);
	});
});
