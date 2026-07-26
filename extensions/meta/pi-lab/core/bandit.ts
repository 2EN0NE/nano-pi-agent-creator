/**
 * 多臂老虎机决策算法
 */

import type { ArmState, BanditStrategy } from '../types.js';

// ============================================================================
// 可注入的随机数生成器（默认使用 Math.random，测试可替换）
// ============================================================================

let _rng: () => number = () => Math.random();

/**
 * 设置随机数生成器（测试用，使 bandit 决策可重复）。
 * @param rng 返回 [0,1) 的随机数函数
 */
export function setRNG(rng: () => number): void {
	_rng = rng;
}

/** 获取当前 RNG（内部使用，外部测试通过 vi.spyOn 或 setRNG 控制） */
export function getRNG(): () => number {
	return _rng;
}

// ============================================================================
// Thompson Sampling
// ============================================================================

/**
 * 从 Beta(α, β) 分布采样。
 * 使用 Gamma 近似：Beta(α, β) ≈ Gamma(α,1) / (Gamma(α,1) + Gamma(β,1))
 */
function sampleBeta(alpha: number, beta: number): number {
	if (alpha <= 0 && beta <= 0) return _rng();

	function sampleGamma(shape: number): number {
		// shape 极小时 Math.pow(u, 1/shape) 溢出，直接兜底
		if (shape < 0.001) return 1;
		if (shape < 1) {
			const u = _rng();
			return sampleGamma(shape + 1) * Math.pow(u, 1 / shape);
		}
		const d = shape - 1 / 3;
		const c = 1 / Math.sqrt(9 * d);
		while (true) {
			const x = normalSample();
			const v = 1 + c * x;
			if (v <= 0) continue;
			const v3 = v * v * v;
			const u = _rng();
			if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v3;
			if (Math.log(u) < 0.5 * x * x + d * (1 - v3 + Math.log(v3))) return d * v3;
		}
	}

	return sampleGamma(alpha) / (sampleGamma(alpha) + sampleGamma(beta));
}

/** 标准正态分布采样（Box-Muller） */
function normalSample(): number {
	let u = 0;
	let v = 0;
	while (u === 0) u = _rng();
	while (v === 0) v = _rng();
	return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

/** 从 Beta 分布的每个臂采样，选最大的 */
function thompsonSample(armIds: string[], states: Map<string, ArmState>): string {
	let bestArm = armIds[0];
	let bestSample = -Infinity;
	for (const id of armIds) {
		const state = states.get(id);
		const alpha = state?.alpha ?? 1;
		const beta = state?.beta ?? 1;
		const sample = sampleBeta(alpha, beta);
		if (sample > bestSample) {
			bestSample = sample;
			bestArm = id;
		}
	}
	return bestArm;
}

// ============================================================================
// Epsilon-Greedy
// ============================================================================

const DEFAULT_EPSILON = 0.1;

function epsilonGreedyPick(
	armIds: string[],
	states: Map<string, ArmState>,
	epsilonConfig?: { epsilon?: number; decay?: boolean },
): string {
	const epsilon = epsilonConfig?.epsilon ?? DEFAULT_EPSILON;

	if (_rng() < epsilon) {
		return armIds[Math.floor(_rng() * armIds.length)];
	}

	let bestArm = armIds[0];
	let bestRate = 0;
	for (const id of armIds) {
		const state = states.get(id);
		const rate = state && state.totalCalls > 0 ? state.alpha / (state.alpha + state.beta) : 0;
		if (rate > bestRate) {
			bestRate = rate;
			bestArm = id;
		}
	}
	return bestArm;
}

// ============================================================================
// 策略选择
// ============================================================================

export interface EpsilonConfig {
	epsilon?: number;
	decay?: boolean;
}

/**
 * 根据策略和当前状态选择臂。
 */
export function selectArm(
	strategy: BanditStrategy,
	armIds: string[],
	states: Map<string, ArmState>,
	epsilonConfig?: EpsilonConfig,
): string {
	if (armIds.length === 0) throw new Error('No arms available');
	if (armIds.length === 1) return armIds[0];

	switch (strategy) {
		case 'thompson-sampling':
			return thompsonSample(armIds, states);
		case 'epsilon-greedy':
			return epsilonGreedyPick(armIds, states, epsilonConfig);
		default:
			throw new Error(`Unknown strategy: ${strategy}`);
	}
}

/**
 * 计算某臂在 Thompson Sampling 下胜出的概率（蒙特卡洛近似）。
 * 用于面板展示。
 */
export function winProbability(
	armStates: Map<string, ArmState>,
	trials = 10000,
): Map<string, number> {
	const result = new Map<string, number>();
	const ids = Array.from(armStates.keys());

	if (ids.length <= 1) {
		for (const id of ids) result.set(id, 1);
		return result;
	}

	const wins = new Map<string, number>();
	for (const id of ids) wins.set(id, 0);

	for (let t = 0; t < trials; t++) {
		let bestId = ids[0];
		let bestVal = -Infinity;
		for (const id of ids) {
			const s = armStates.get(id);
			const val = sampleBeta(s?.alpha ?? 1, s?.beta ?? 1);
			if (val > bestVal) {
				bestVal = val;
				bestId = id;
			}
		}
		wins.set(bestId, (wins.get(bestId) ?? 0) + 1);
	}

	for (const id of ids) {
		result.set(id, (wins.get(id) ?? 0) / trials);
	}
	return result;
}
