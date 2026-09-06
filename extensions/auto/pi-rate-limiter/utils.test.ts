import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
	detectModelFromPayload,
	matchModelProfile,
	getEffectiveLimits,
	DEFAULT_CONFIG,
	type ModelProfile,
} from './utils.js';

describe('detectModelFromPayload', () => {
	it('should extract model from OpenAI-style payload', () => {
		const payload = { model: 'gpt-4o', messages: [] };
		assert.strictEqual(detectModelFromPayload(payload), 'gpt-4o');
	});

	it('should extract model from Anthropic-style payload', () => {
		const payload = { model: 'claude-sonnet-4-6', messages: [] };
		assert.strictEqual(detectModelFromPayload(payload), 'claude-sonnet-4-6');
	});

	it('should return undefined when model field is missing', () => {
		const payload = { messages: [] };
		assert.strictEqual(detectModelFromPayload(payload), undefined);
	});

	it('should return undefined for non-object payload', () => {
		assert.strictEqual(detectModelFromPayload(null), undefined);
		assert.strictEqual(detectModelFromPayload('string'), undefined);
	});
});

describe('matchModelProfile', () => {
	const profiles: ModelProfile[] = [
		{ modelPattern: 'gpt-4o', maxRequestsPerMinute: 50, maxTokensPerMinute: 10000 },
		{ modelPattern: 'claude-sonnet-*', maxRequestsPerMinute: 30, maxTokensPerMinute: 8000 },
		{ modelPattern: '/^claude-opus.*/', maxRequestsPerMinute: 10, maxTokensPerMinute: 5000 },
	];

	it('should match exact pattern', () => {
		const p = matchModelProfile('gpt-4o', profiles);
		assert.ok(p);
		assert.strictEqual(p!.maxRequestsPerMinute, 50);
	});

	it('should match glob pattern', () => {
		const p = matchModelProfile('claude-sonnet-4-6', profiles);
		assert.ok(p);
		assert.strictEqual(p!.maxRequestsPerMinute, 30);
	});

	it('should match regex pattern', () => {
		const p = matchModelProfile('claude-opus-4-7', profiles);
		assert.ok(p);
		assert.strictEqual(p!.maxRequestsPerMinute, 10);
	});

	it('should return undefined for no match', () => {
		const p = matchModelProfile('unknown-model', profiles);
		assert.strictEqual(p, undefined);
	});

	it('should fallback to literal match for invalid regex', () => {
		const invalidProfiles: ModelProfile[] = [
			{ modelPattern: '/[invalid(/', maxRequestsPerMinute: 5, maxTokensPerMinute: 1000 },
		];
		// Should not throw and should fallback to no match
		const p = matchModelProfile('anything', invalidProfiles);
		assert.strictEqual(p, undefined);
	});
});

describe('getEffectiveLimits', () => {
	const config = {
		...DEFAULT_CONFIG,
		modelProfiles: [
			{
				modelPattern: 'gpt-4o',
				maxRequestsPerMinute: 50,
				maxTokensPerMinute: 10000,
				throttleThresholdPercent: 90,
			},
		],
	};

	it('should return profile limits when model matches', () => {
		const limits = getEffectiveLimits(config, 'gpt-4o');
		assert.strictEqual(limits.maxReq, 50);
		assert.strictEqual(limits.maxTok, 10000);
		assert.strictEqual(limits.thresholdPercent, 90);
	});

	it('should return default limits when model does not match', () => {
		const limits = getEffectiveLimits(config, 'unknown');
		assert.strictEqual(limits.maxReq, DEFAULT_CONFIG.maxRequestsPerMinute);
		assert.strictEqual(limits.maxTok, DEFAULT_CONFIG.maxTokensPerMinute);
		assert.strictEqual(limits.thresholdPercent, DEFAULT_CONFIG.throttleThresholdPercent);
	});

	it('should return default limits when modelId is undefined', () => {
		const limits = getEffectiveLimits(config, undefined);
		assert.strictEqual(limits.maxReq, DEFAULT_CONFIG.maxRequestsPerMinute);
		assert.strictEqual(limits.maxTok, DEFAULT_CONFIG.maxTokensPerMinute);
	});
});
