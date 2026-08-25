/**
 * pi-lab AA 自检 — Vitest tests
 *
 * Covers:
 *   - checkSRM：样本比例失配检查（等权 / 偏离 / 边界）
 *   - aaCalibration：AA 场景的后验校准提示
 */
import { describe, it, expect } from 'vitest';
import { aaCalibration, checkSRM } from '../../../extensions/meta/pi-lab/core/aa-check.js';

describe('checkSRM', () => {
	it('empty sample → ok', () => {
		expect(checkSRM([]).ok).toBe(true);
		expect(checkSRM([0, 0]).ok).toBe(true);
	});

	it('single arm → no SRM meaning', () => {
		expect(checkSRM([5]).ok).toBe(true);
		expect(checkSRM([5]).detail).toContain('单臂');
	});

	it('equal samples → ok', () => {
		const r = checkSRM([10, 10]);
		expect(r.ok).toBe(true);
		expect(r.detail).toContain('SRM 正常');
	});

	it('slight imbalance below chi2 threshold → ok', () => {
		// [10, 20]: Yate's 校正后 χ² = (4.5²+4.5²)/15 = 2.7 < 3.84
		expect(checkSRM([10, 20]).ok).toBe(true);
	});

	it('severe imbalance → not ok', () => {
		// [100, 0]: χ² ≈ 98 > 3.84
		const r = checkSRM([100, 0]);
		expect(r.ok).toBe(false);
		expect(r.detail).toContain('SRM 偏离');
	});

	it('small sample below expected frequency → not judged (avoid false positive)', () => {
		// [5, 0]：无护栏时 χ²=5.0>3.84 会误报，但精确二项 p≈0.0625 不显著；
		// 期望频数 2.5<5 → 判 ok 不误报
		const r = checkSRM([5, 0]);
		expect(r.ok).toBe(true);
		expect(r.detail).toContain('样本过少');
	});

	it('three-arm equal → ok', () => {
		expect(checkSRM([10, 10, 10]).ok).toBe(true);
	});
});

describe('aaCalibration', () => {
	it('returns null for non-AA experiment', () => {
		expect(aaCalibration([0.97, 0.03], [100, 100], false)).toBeNull();
	});

	it('returns null for healthy AA (win ~50/50)', () => {
		expect(aaCalibration([0.52, 0.48], [100, 100], true)).toBeNull();
	});

	it('returns hint when AA arm wins overwhelmingly with sufficient samples', () => {
		const hint = aaCalibration([0.97, 0.03], [100, 100], true);
		expect(hint).not.toBeNull();
		expect(hint).toContain('AA 自检');
	});

	it('returns null when any arm lacks minimum samples (tiny-sample guard)', () => {
		// [5, 0]：一臂 0 样本，胜出概率由先验主导，不应触发假阳性告警
		expect(aaCalibration([0.97, 0.03], [5, 0], true)).toBeNull();
		// [100, 0]：同样一侧 0 样本（SRM 已覆盖失衡，校准需双侧有数据）
		expect(aaCalibration([1.0, 0.0], [100, 0], true)).toBeNull();
	});

	it('returns null for single arm', () => {
		expect(aaCalibration([1.0], [100], true)).toBeNull();
	});
});
