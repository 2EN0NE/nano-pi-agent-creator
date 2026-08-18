/**
 * 随机采样原语 — 贝叶斯后验 Monte-Carlo 采样用
 *
 * 从 bandit.ts 迁出（bandit 已拆除）：sampleBeta/sampleGamma 是 Beta-Bernoulli /
 * Poisson-Gamma 共轭后验采样的基础，analysis.ts 的胜出概率估算依赖它们。
 * getRNG/setRNG 提供可注入 RNG（测试可复现）。
 */

// ============================================================================
// 可注入的随机数生成器（默认使用 Math.random，测试可替换）
// ============================================================================

let _rng: () => number = () => Math.random();

/** 设置随机数生成器（测试用，使蒙特卡洛采样可重复） */
export function setRNG(rng: () => number): void {
	_rng = rng;
}

/** 获取当前 RNG（内部使用） */
export function getRNG(): () => number {
	return _rng;
}

// ============================================================================
// 分布采样
// ============================================================================

/**
 * 从 Gamma(shape, scale=1) 采样（Marsaglia-Tsang 拒绝采样 + shape<1 的乘法扩张）。
 */
export function sampleGamma(shape: number): number {
	// shape 极小时 Math.pow(u, 1/shape) 溢出，直接兜底
	if (shape < 0.001) return 1;
	if (shape < 1) {
		const u = _rng();
		return sampleGamma(shape + 1) * u ** (1 / shape);
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

/**
 * 从 Beta(α, β) 分布采样。
 * 使用 Gamma 近似：Beta(α, β) ≈ Gamma(α,1) / (Gamma(α,1) + Gamma(β,1))
 */
export function sampleBeta(alpha: number, beta: number): number {
	if (alpha <= 0 && beta <= 0) return _rng();
	// 分子与分母必须复用同一次 Gamma(α) 采样；独立采样两次会破坏 Beta 定义
	// （均值偏移为 α/(α+β-1)，且结果可 >1）。
	const x = sampleGamma(alpha);
	const y = sampleGamma(beta);
	return x / (x + y);
}

/** 标准正态分布采样（Box-Muller） */
function normalSample(): number {
	let u = 0;
	let v = 0;
	while (u === 0) u = _rng();
	while (v === 0) v = _rng();
	return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}
