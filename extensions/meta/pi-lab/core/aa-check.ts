/**
 * AA 自检 — 验证实验基础设施本身无偏（ADR 0023）。
 *
 * 两个纯函数：
 *   - checkSRM：样本比例失配检查（Sample Ratio Mismatch），验证 stable-hash 分流是否等权
 *   - aaCalibration：AA 场景（两臂指向同一实现）的后验校准提示
 */

export interface SRMCheck {
	/** true = 样本比例在预期内 */
	ok: boolean;
	/** 人话描述（供 /lab 面板展示） */
	detail: string;
}

/** 卡方检验阈值表（自由度 1..5，α=0.05） */
const CHI2_THRESHOLDS = [3.84, 5.99, 7.81, 9.49, 11.07];

/**
 * 胜出/校准结论的最小样本量护栏（与面板胜出高亮口径统一）。
 * 极小样本（如 n=1 vs n=0）下贝叶斯后验由先验主导，胜出概率可轻易达到
 * 0.95~1.0，据此下「显著胜出」或「假阳性风险」结论会误导。
 */
export const MIN_WINNER_SAMPLES = 10;

/** 卡方检验最小期望频数：期望频数低于此值时检验不可靠（常见约定为 ≥5） */
const MIN_EXPECTED = 5;

/**
 * SRM 检查：各臂样本量是否偏离等权比例（1:1:...）。
 * 用卡方检验判断观测样本比例是否显著偏离均匀分布；
 * 两臂（df=1）加 Yate's 连续性校正，期望频数 <5 时不判定。
 */
export function checkSRM(sampleCounts: number[]): SRMCheck {
	const total = sampleCounts.reduce((a, b) => a + b, 0);
	if (total === 0) return { ok: true, detail: '暂无样本' };
	if (sampleCounts.length < 2) return { ok: true, detail: '单臂实验无 SRM 意义' };

	const expected = total / sampleCounts.length;
	// 小样本护栏：期望频数 <5 时卡方检验不可靠（精确二项/Fisher 更合适），
	// 直接判 ok 避免误报（如 [5,0] 卡方 > 阈值但精确二项 p≈0.0625 不显著）
	if (expected < MIN_EXPECTED) {
		return {
			ok: true,
			detail: `样本过少（期望频数 ${expected.toFixed(1)}<${MIN_EXPECTED}），SRM 暂不判定`,
		};
	}

	// df=1（两臂）加 Yate's 连续性校正，修正小样本下卡方偏大的问题
	const useYates = sampleCounts.length === 2;
	let chi2 = 0;
	for (const c of sampleCounts) {
		const diff = useYates ? Math.abs(c - expected) - 0.5 : c - expected;
		chi2 += diff ** 2 / expected;
	}
	const threshold =
		CHI2_THRESHOLDS[Math.min(sampleCounts.length - 2, CHI2_THRESHOLDS.length - 1)];
	const ok = chi2 < threshold;

	return {
		ok,
		detail: ok
			? `SRM 正常（χ²=${chi2.toFixed(2)}）`
			: `SRM 偏离：样本比例偏离等权（χ²=${chi2.toFixed(2)}），检查分流/测量`,
	};
}

/**
 * AA 校准提示：AA 场景（两臂指向同一实现）下，胜出概率应 ~50/50。
 * 若某臂胜出概率异常高（≥0.95），提示后验未收敛到无差异（假阳性风险）。
 *
 * @param winProbabilities 每臂的胜出概率（与 sampleCounts 同序）
 * @param sampleCounts     每臂的样本量（用于最小样本量护栏）
 * @param isAA             是否 AA 场景
 * @returns 提示文案，健康时返回 null
 */
export function aaCalibration(
	winProbabilities: number[],
	sampleCounts: number[],
	isAA: boolean,
): string | null {
	if (!isAA || winProbabilities.length < 2) return null;
	// 最小样本量护栏（与胜出高亮口径统一）：任一侧样本不足时胜出概率由先验主导，
	// 越过 0.95 阈值属统计噪声，不应触发「假阳性风险」告警
	if (sampleCounts.length < 2) return null;
	const minN = Math.min(...sampleCounts);
	if (minN < MIN_WINNER_SAMPLES) return null;
	const maxWin = Math.max(...winProbabilities);
	if (maxWin >= 0.95) {
		return 'AA 自检：后验未收敛到无差异（假阳性风险），检查分流/测量/先验';
	}
	return null;
}
