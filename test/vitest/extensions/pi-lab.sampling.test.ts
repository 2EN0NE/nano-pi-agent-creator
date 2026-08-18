/**
 * pi-lab sampling 原语单元测试
 *
 * 覆盖 sampling.ts 的边界分支与统计性质：
 * - sampleBeta：Beta(α,β) 均值 ≈ α/(α+β)；双非正参数兜底分支
 * - sampleGamma：shape≥1（Marsaglia-Tsang 主循环）/ shape<1（乘法扩张）/ 极小 shape 兜底
 * - setRNG/getRNG：可注入 RNG 使蒙特卡洛采样可复现
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
	setRNG,
	getRNG,
	sampleBeta,
	sampleGamma,
} from '../../../extensions/meta/pi-lab/core/sampling.js';

/** LCG 可复现 RNG（与 pi-lab.core.test.ts 一致） */
function makeSeededRNG(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 0xffffffff;
	};
}

/** 采样 N 次求均值，用固定种子消除统计 flaky */
function meanOf(fn: () => number, n: number): number {
	let sum = 0;
	for (let i = 0; i < n; i++) sum += fn();
	return sum / n;
}

afterEach(() => {
	setRNG(() => Math.random()); // 恢复默认 RNG，避免影响其他 suite
});

describe('pi-lab: sampling 原语', () => {
	it('setRNG/getRNG 注入可复现 RNG', () => {
		const rng = makeSeededRNG(42);
		setRNG(rng);
		expect(getRNG()).toBe(rng);
	});

	it('sampleBeta 均值 ≈ α/(α+β)', () => {
		setRNG(makeSeededRNG(1));
		const alpha = 2;
		const beta = 3;
		const mean = meanOf(() => sampleBeta(alpha, beta), 20000);
		expect(mean).toBeCloseTo(alpha / (alpha + beta), 1); // 0.4
	});

	it('sampleBeta 输出始终落在 [0,1]（回归：独立采样两次会 >1）', () => {
		setRNG(makeSeededRNG(6));
		// 小样本（α=1,β=1）时 bug 版最容易越界，作为回归防线
		for (let i = 0; i < 5000; i++) {
			const v = sampleBeta(1, 1);
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThanOrEqual(1);
		}
	});

	it('sampleGamma(shape>=1) 均值 ≈ shape（Marsaglia-Tsang 主循环）', () => {
		setRNG(makeSeededRNG(2));
		const shape = 4;
		const mean = meanOf(() => sampleGamma(shape), 20000);
		expect(mean).toBeCloseTo(shape, 1);
	});

	it('sampleGamma(shape<1) 走乘法扩张路径且均值 ≈ shape', () => {
		setRNG(makeSeededRNG(3));
		const shape = 0.5;
		const mean = meanOf(() => sampleGamma(shape), 20000);
		expect(mean).toBeCloseTo(shape, 1);
	});

	it('sampleGamma 极小 shape（<0.001）兜底返回 1', () => {
		setRNG(makeSeededRNG(4));
		expect(sampleGamma(0.0001)).toBe(1);
	});

	it('sampleBeta 双非正参数兜底：直接返回 RNG 值且只消费一次', () => {
		let calls = 0;
		setRNG(() => {
			calls++;
			return 0.25;
		});
		expect(sampleBeta(0, 0)).toBe(0.25);
		expect(calls).toBe(1);
	});
});
