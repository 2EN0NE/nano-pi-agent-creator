/**
 * Sigma (σ) utilities — mean, sample standard deviation, z-score.
 *
 * All functions operate on arrays of numeric session metrics.
 */

export interface SigmaResult {
	mean: number;
	std: number;
	/** z-score of the current value: (current - mean) / std. 0 when std is 0 or insufficient data. */
	zScore: number;
	/** Sigma level: 0 = |z| < 1, 1 = 1 ≤ |z| < 2, 2 = |z| ≥ 2 */
	level: 0 | 1 | 2;
}

/**
 * Compute mean of an array.
 */
export function mean(values: number[]): number {
	if (values.length === 0) return 0;
	let sum = 0;
	for (const v of values) sum += v;
	return sum / values.length;
}

/**
 * Compute sample standard deviation (ddof=1). Returns 0 for < 2 values.
 */
export function std(values: number[]): number {
	if (values.length < 2) return 0;
	const avg = mean(values);
	let sqDiff = 0;
	for (const v of values) {
		const d = v - avg;
		sqDiff += d * d;
	}
	return Math.sqrt(sqDiff / (values.length - 1));
}

/**
 * Given historical values and a current value, compute sigma statistics.
 * Returns level 0 when there are fewer than 2 historical data points.
 */
export function computeSigma(values: number[], current: number): SigmaResult {
	const m = values.length > 0 ? mean(values) : 0;
	const s = std(values);
	const z = s > 0 ? (current - m) / s : 0;
	const absZ = Math.abs(z);

	let level: 0 | 1 | 2 = 0;
	if (values.length >= 2) {
		if (absZ >= 2) level = 2;
		else if (absZ >= 1) level = 1;
		else level = 0;
	}

	return { mean: m, std: s, zScore: z, level };
}

/**
 * Combine multiple sigma results into a single "worst" dimension.
 * Returns the dimension key with the highest absolute z-score.
 * Ties are broken by priority order (dimensions earlier in the array win).
 */
export function pickWorstDimension(
	results: Record<string, SigmaResult>,
	priorityOrder: string[],
): { dimension: string; result: SigmaResult } | null {
	let best: { dimension: string; result: SigmaResult } | null = null;

	for (const dim of priorityOrder) {
		const r = results[dim];
		if (!r) continue;
		if (!best || Math.abs(r.zScore) > Math.abs(best.result.zScore)) {
			best = { dimension: dim, result: r };
		}
	}

	return best;
}
