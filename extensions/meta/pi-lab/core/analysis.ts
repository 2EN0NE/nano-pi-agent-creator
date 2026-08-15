/**
 * 贝叶斯后验分析 — query 的核心
 *
 * 对单个 metric，从事件流投影每 arm 的后验（均值/方差），
 * 蒙特卡洛估算胜出概率，并对 guardrail metric 给出告警。
 */

import type { ExperimentEvent, GuardrailAlert, MetricDef, QueryResult } from '../types.js';
import { getRNG, sampleBeta, sampleGamma } from './bandit.js';

interface Posterior {
	armId: string;
	n: number;
	mean: number;
	variance: number;
	/** 从该臂后验采样一个值（Monte-Carlo 胜出概率用） */
	sample: () => number;
}

/**
 * 从事件投影单个 metric 的值。
 * 普通 metric：直接读 event.metrics[id]。
 * 派生 metric：按声明从源 metric 投影计算（weighted-sum / any-fail）。
 */
export function projectMetricValue(
	metricDef: MetricDef,
	event: ExperimentEvent,
): number | undefined {
	if (!metricDef.derived) {
		return event.metrics[metricDef.id];
	}
	const d = metricDef.derived;
	if (d.kind === 'weighted-sum') {
		let any = false;
		let sum = 0;
		for (const c of d.components) {
			const v = event.metrics[c.metricId];
			if (v !== undefined) {
				any = true;
				sum += v * (c.weight ?? 1);
			}
		}
		return any ? sum : undefined;
	}
	// any-fail：任一源 metric ≥ 0.5 视为 fail（1）；全缺失 → undefined
	let anyPresent = false;
	for (const c of d.components) {
		const v = event.metrics[c.metricId];
		if (v !== undefined) {
			anyPresent = true;
			if (v >= 0.5) return 1;
		}
	}
	return anyPresent ? 0 : undefined;
}

/** 按 metric 类型拟合共轭后验，返回（均值, 方差, 采样函数） */
function fitPosterior(
	metricDef: MetricDef,
	values: number[],
): { n: number; mean: number; variance: number; sample: () => number } {
	const n = values.length;
	if (n === 0) return { n: 0, mean: 0, variance: 1, sample: () => Number.NaN };
	const sum = values.reduce((a, b) => a + b, 0);

	switch (metricDef.type) {
		case 'binary': {
			// Beta-Bernoulli: α=1+Σsuccess, β=1+Σfailure
			const alpha = 1 + sum;
			const beta = 1 + (n - sum);
			const mean = alpha / (alpha + beta);
			const variance = (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1));
			return { n, mean, variance, sample: () => sampleBeta(alpha, beta) };
		}
		case 'count': {
			// Poisson-Gamma: 后验 Gamma(α=1+Σx, β=1+n)，均值 (1+Σx)/(1+n)
			const alphaPost = 1 + sum;
			const betaPost = 1 + n;
			const mean = alphaPost / betaPost;
			const variance = alphaPost / betaPost ** 2;
			return { n, mean, variance, sample: () => sampleGamma(alphaPost) / betaPost };
		}
		case 'continuous': {
			// Normal-Gamma 共轭后验（对齐 ADR 0010），无信息均值先验（μ₀=0, λ₀=0）+
			// 弱信息方差先验（α₀=1, β₀=1）。后验边际为 Student-t，均值 μ_post=Σx/n，
			// 方差 β_post/(α_post·λ_post)。λ₀=0 使先验不把单样本均值拉向 0。
			const alpha0 = 1;
			const beta0 = 1;
			const mean = sum / n;
			const ss = values.reduce((a, v) => a + (v - mean) ** 2, 0);
			const lambdaPost = n;
			const alphaPost = alpha0 + n / 2;
			const betaPost = beta0 + 0.5 * ss;
			const variance = betaPost / (alphaPost - 1) / lambdaPost;
			// 采样用 Normal 近似 Student-t（大样本收敛，小样本方向性正确）
			return { n, mean, variance, sample: () => mean + Math.sqrt(variance) * normalSample() };
		}
		default:
			throw new Error(`未知指标类型: ${metricDef.type}`);
	}
}

/** 标准正态采样（Box-Muller，用可注入 RNG） */
function normalSample(): number {
	const rng = getRNG();
	let u = 0;
	let v = 0;
	while (u === 0) u = rng();
	while (v === 0) v = rng();
	return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** 蒙特卡洛估算每 arm 的胜出概率（direction 决定最优方向） */
function computeWinProbability(
	posteriors: Posterior[],
	direction: 'maximize' | 'minimize',
): number[] {
	const trials = 10000;
	const wins = posteriors.map(() => 0);

	for (let t = 0; t < trials; t++) {
		const samples = posteriors.map((p) => (p.n === 0 ? Number.NaN : p.sample()));
		let bestIdx = -1;
		for (let i = 0; i < samples.length; i++) {
			if (Number.isNaN(samples[i])) continue;
			if (bestIdx === -1) {
				bestIdx = i;
				continue;
			}
			const better =
				direction === 'maximize'
					? samples[i] > samples[bestIdx]
					: samples[i] < samples[bestIdx];
			if (better) bestIdx = i;
		}
		if (bestIdx !== -1) wins[bestIdx]++;
	}
	return wins.map((w) => w / trials);
}

/** 估算每 arm 是 guardrail「最差」的概率（direction=maximize 时最差=最小） */
function computeWorstProbability(
	posteriors: Posterior[],
	direction: 'maximize' | 'minimize',
): number[] {
	const trials = 10000;
	const worst = posteriors.map(() => 0);
	const worstIsSmaller = direction === 'maximize';

	for (let t = 0; t < trials; t++) {
		const samples = posteriors.map((p) => (p.n === 0 ? Number.NaN : p.sample()));
		let worstIdx = -1;
		for (let i = 0; i < samples.length; i++) {
			if (Number.isNaN(samples[i])) continue;
			if (worstIdx === -1) {
				worstIdx = i;
				continue;
			}
			const worse = worstIsSmaller
				? samples[i] < samples[worstIdx]
				: samples[i] > samples[worstIdx];
			if (worse) worstIdx = i;
		}
		if (worstIdx !== -1) worst[worstIdx]++;
	}
	return worst.map((w) => w / trials);
}

export function analyzeMetric(
	metricId: string,
	metricDef: MetricDef,
	events: ExperimentEvent[],
	armIds: string[],
): QueryResult {
	const posteriors: Posterior[] = armIds.map((armId) => {
		const values = events
			.filter((e) => e.armId === armId)
			.map((e) => projectMetricValue(metricDef, e))
			.filter((v): v is number => v !== undefined);
		return { armId, ...fitPosterior(metricDef, values) };
	});

	const winProbs = computeWinProbability(posteriors, metricDef.direction);

	const arms = posteriors.map((p, i) => ({
		armId: p.armId,
		n: p.n,
		mean: p.mean,
		credibleInterval:
			p.n === 0
				? { low: Number.NaN, high: Number.NaN }
				: metricDef.type === 'binary'
					? {
							// binary 用 Beta 后验，正态近似小样本会越出 [0,1]，截断避免非法区间
							low: Math.max(0, p.mean - 1.96 * Math.sqrt(p.variance)),
							high: Math.min(1, p.mean + 1.96 * Math.sqrt(p.variance)),
						}
					: {
							low: p.mean - 1.96 * Math.sqrt(p.variance),
							high: p.mean + 1.96 * Math.sqrt(p.variance),
						},
		winProbability: winProbs[i],
	}));

	const guardrailAlert: GuardrailAlert[] = [];
	if (metricDef.isGuardrail && posteriors.some((p) => p.n > 0)) {
		const worstProbs = computeWorstProbability(posteriors, metricDef.direction);
		posteriors.forEach((p, i) => {
			if (p.n > 0 && worstProbs[i] > 0.95) {
				guardrailAlert.push({ armId: p.armId, pWorse: worstProbs[i] });
			}
		});
	}

	return { metricId, arms, guardrailAlert };
}
