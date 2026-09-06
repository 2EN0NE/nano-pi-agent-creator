/**
 * custom-compaction types — 触发阈值与描述纯函数测试
 *
 * Covers:
 *   - validateTriggerThreshold：context_percent/fixed/reserve 边界（1/99、1000、100）
 *   - resolveTriggerThresholdAfterTypeChange：切换触发类型时的阈值保留/重置
 *   - describeTrigger：三种触发类型的文案
 */
import { describe, it, expect } from 'vitest';
import {
	validateTriggerThreshold,
	resolveTriggerThresholdAfterTypeChange,
	describeTrigger,
	createDefaultProfile,
	DEFAULT_TRIGGER_THRESHOLDS,
	DEFAULT_AUTO_CONTINUE_MESSAGE,
} from '../../../extensions/context/custom-compaction/types.js';

// ── validateTriggerThreshold 边界 ───────────────────────────────

describe('validateTriggerThreshold', () => {
	it('context_percent: accepts 1..99', () => {
		expect(validateTriggerThreshold('context_percent', 1)).toBeNull();
		expect(validateTriggerThreshold('context_percent', 50)).toBeNull();
		expect(validateTriggerThreshold('context_percent', 99)).toBeNull();
	});

	it('context_percent: rejects 0, 100, NaN, Infinity', () => {
		expect(validateTriggerThreshold('context_percent', 0)).not.toBeNull();
		expect(validateTriggerThreshold('context_percent', 100)).not.toBeNull();
		expect(validateTriggerThreshold('context_percent', Number.NaN)).not.toBeNull();
		expect(
			validateTriggerThreshold('context_percent', Number.POSITIVE_INFINITY),
		).not.toBeNull();
	});

	it('fixed: accepts >= 1000, rejects below', () => {
		expect(validateTriggerThreshold('fixed', 1000)).toBeNull();
		expect(validateTriggerThreshold('fixed', 999)).not.toBeNull();
	});

	it('reserve: accepts >= 100, rejects below', () => {
		expect(validateTriggerThreshold('reserve', 100)).toBeNull();
		expect(validateTriggerThreshold('reserve', 99)).not.toBeNull();
	});
});

// ── resolveTriggerThresholdAfterTypeChange ──────────────────────

describe('resolveTriggerThresholdAfterTypeChange', () => {
	it('preserves a threshold that is legal in the new type', () => {
		expect(resolveTriggerThresholdAfterTypeChange('context_percent', 70)).toEqual({
			threshold: 70,
			reset: false,
		});
		expect(resolveTriggerThresholdAfterTypeChange('fixed', 200000)).toEqual({
			threshold: 200000,
			reset: false,
		});
		expect(resolveTriggerThresholdAfterTypeChange('reserve', 10000)).toEqual({
			threshold: 10000,
			reset: false,
		});
	});

	it('resets to the new type default when the old threshold is illegal', () => {
		// context_percent → fixed：20 低于 fixed 下限 1000 → 重置 200000
		expect(resolveTriggerThresholdAfterTypeChange('fixed', 20)).toEqual({
			threshold: DEFAULT_TRIGGER_THRESHOLDS.fixed,
			reset: true,
		});
		// fixed → context_percent：200000 超出 99 → 重置 20
		expect(resolveTriggerThresholdAfterTypeChange('context_percent', 200000)).toEqual({
			threshold: DEFAULT_TRIGGER_THRESHOLDS.context_percent,
			reset: true,
		});
		// reserve：10000 合法 → 保留
		expect(resolveTriggerThresholdAfterTypeChange('reserve', 10000)).toEqual({
			threshold: 10000,
			reset: false,
		});
	});

	it('defaults: context_percent=20, fixed=200000, reserve=10000', () => {
		expect(DEFAULT_TRIGGER_THRESHOLDS).toEqual({
			context_percent: 20,
			fixed: 200000,
			reserve: 10000,
		});
	});
});

// ── describeTrigger ─────────────────────────────────────────────

describe('describeTrigger', () => {
	it('describes context_percent with percentage', () => {
		expect(describeTrigger({ type: 'context_percent', threshold: 70 })).toContain('70%');
	});

	it('describes fixed with locale-formatted token count', () => {
		expect(describeTrigger({ type: 'fixed', threshold: 200000 })).toContain(
			(200000).toLocaleString(),
		);
	});

	it('describes reserve type', () => {
		expect(describeTrigger({ type: 'reserve', threshold: 10000 })).toContain(
			(10000).toLocaleString(),
		);
	});
});

// ── injectContinueText 默认值 ───────────────────────────────────

describe('createDefaultProfile — injectContinueText', () => {
	it('defaults injectContinueText to false (invisible continue)', () => {
		expect(createDefaultProfile().injectContinueText).toBe(false);
	});

	it('keeps autoContinueMessage default as "continue" (fallback text)', () => {
		expect(createDefaultProfile().autoContinueMessage).toBe(DEFAULT_AUTO_CONTINUE_MESSAGE);
		expect(DEFAULT_AUTO_CONTINUE_MESSAGE).toBe('continue');
	});
});
