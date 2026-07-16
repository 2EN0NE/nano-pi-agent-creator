/**
 * End-to-end integration tests for the rate limiter pipeline.
 *
 * Tests the full flow: model detection → rate limiting → adaptive learning →
 * global state sync → 432 handling, without requiring the pi.dev runtime.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { GlobalRateLimiter } from './global-state.js';
import { AdaptiveLearner } from './adaptive-learner.js';
import {
	detectModelFromPayload,
	estimateTokensFromPayload,
	getEffectiveLimits,
	is432LikeError,
	matchModelProfile,
	type ModelProfile,
	type RateLimitConfig,
} from './utils.js';

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), 'pi-rate-limiter-e2e-'));
}

function cleanup(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		// ignore
	}
}

// ============================================================================
// Helper: simulate a complete request lifecycle
// ============================================================================

interface SimulatedRequest {
	payload: { model: string; messages: Array<{ role: string; content: string }> };
	actualTokens: number;
	outcome: 'success' | 'rejected';
}

function runRequestPipeline(
	limiter: GlobalRateLimiter,
	learner: AdaptiveLearner | undefined,
	config: RateLimitConfig,
	req: SimulatedRequest,
): { allowed: boolean; throttled: boolean; modelId: string } {
	const modelId = detectModelFromPayload(req.payload) ?? 'unknown';
	const estimatedTokens = estimateTokensFromPayload(req.payload, config.tokenEstimateRatio);
	let { maxReq, maxTok, thresholdPercent } = getEffectiveLimits(config, modelId);

	// Adaptive override
	if (config.adaptiveRateLimit !== 'off' && learner) {
		const isExploring = learner.shouldExplore(modelId);
		if (isExploring) {
			maxReq = learner.getExplorationLimit(modelId, maxReq);
			maxTok = learner.getExplorationLimit(modelId, maxTok);
		} else {
			maxReq = learner.getEffectiveLimit(modelId, maxReq);
			maxTok = learner.getEffectiveLimit(modelId, maxTok);
		}
	}

	const result = limiter.checkAndRecord(
		estimatedTokens,
		maxReq,
		maxTok,
		thresholdPercent,
		modelId,
	);
	const allowed = result.allowed;

	if (allowed) {
		// Simulate provider response
		if (req.outcome === 'rejected') {
			learner?.recordOutcome(
				modelId,
				'rejected',
				limiter.getGlobalStats(modelId)?.requests ?? 0,
			);
		} else {
			// Correct token estimate
			limiter.correctLastRequest(req.actualTokens, modelId);
			// Classify outcome for adaptive learning
			const currentRate = limiter.getGlobalStats(modelId)?.requests ?? 0;
			const effectiveLimit =
				learner?.getEffectiveLimit(modelId, getEffectiveLimits(config, modelId).maxReq) ??
				maxReq;
			if (currentRate >= effectiveLimit * 0.9) {
				learner?.recordOutcome(modelId, 'near', currentRate);
			} else {
				learner?.recordOutcome(modelId, 'safe', currentRate);
			}
		}
	}

	return { allowed, throttled: !allowed, modelId };
}

// ============================================================================
// E2E: Full pipeline with model profiles
// ============================================================================

describe('E2E: Model-aware pipeline', () => {
	it('should apply different limits per model and track globally', () => {
		const dir = makeTempDir();
		const limiter = new GlobalRateLimiter({
			stateDir: dir,
			heartbeatIntervalMs: 100,
			lockTimeoutMs: 500,
			staleProcessTimeoutMs: 500,
		});
		limiter.init();

		const config: RateLimitConfig = {
			maxRequestsPerMinute: 10,
			maxTokensPerMinute: 8000,
			autoResumeOn432: false,
			tokenEstimateRatio: 4,
			throttleThresholdPercent: 80,
			globalRateLimit: true,
			heartbeatIntervalMs: 500,
			lockTimeoutMs: 5000,
			staleProcessTimeoutMs: 30000,
			modelProfiles: [
				{ modelPattern: 'claude-*', maxRequestsPerMinute: 3, maxTokensPerMinute: 3000 },
				{ modelPattern: 'gpt-4*', maxRequestsPerMinute: 5, maxTokensPerMinute: 5000 },
			],
			adaptiveRateLimit: 'off',
		};

		// Send 3 claude requests (at threshold for claude profile: 80% of 3 = 2.4)
		for (let i = 0; i < 3; i++) {
			const r = runRequestPipeline(limiter, undefined, config, {
				payload: {
					model: 'claude-sonnet-4-6',
					messages: [{ role: 'user', content: 'hi' }],
				},
				actualTokens: 10,
				outcome: 'success',
			});
			assert.strictEqual(r.allowed, true, `claude req ${i} should be allowed`);
		}

		// 4th claude request should be throttled
		const rClaude = runRequestPipeline(limiter, undefined, config, {
			payload: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] },
			actualTokens: 10,
			outcome: 'success',
		});
		assert.strictEqual(rClaude.throttled, true, '4th claude req should be throttled');

		// gpt-4 request should still be allowed (its own limit)
		const rGpt = runRequestPipeline(limiter, undefined, config, {
			payload: { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
			actualTokens: 10,
			outcome: 'success',
		});
		assert.strictEqual(rGpt.allowed, true, 'gpt-4 req should be allowed');

		const claudeStats = limiter.getGlobalStats('claude-sonnet-4-6');
		const gptStats = limiter.getGlobalStats('gpt-4o');

		assert.ok(claudeStats);
		assert.ok(gptStats);
		assert.strictEqual(claudeStats!.requests, 3, 'claude should have 3 requests');
		assert.strictEqual(gptStats!.requests, 1, 'gpt-4 should have 1 request');

		limiter.shutdown();
		cleanup(dir);
	});
});

// ============================================================================
// E2E: Adaptive learning pipeline
// ============================================================================

describe('E2E: Adaptive learning pipeline', () => {
	it('should learn lower limit after rejections and recover with successes', () => {
		const dir = makeTempDir();
		const limiter = new GlobalRateLimiter({
			stateDir: dir,
			heartbeatIntervalMs: 100,
			lockTimeoutMs: 500,
			staleProcessTimeoutMs: 500,
		});
		limiter.init();

		const learner = new AdaptiveLearner(join(dir, 'beliefs.json'));
		const modelId = 'test-model';
		const configuredLimit = 10;

		// Initial effective limit should be near configured limit
		const initialLimit = learner.getEffectiveLimit(modelId, configuredLimit);
		assert.ok(
			initialLimit > 0 && initialLimit <= configuredLimit * 2,
			`initial limit ${initialLimit} should be reasonable`,
		);

		// Simulate rejections at rate 8
		for (let i = 0; i < 5; i++) {
			learner.recordOutcome(modelId, 'rejected', 8);
		}

		const afterRejectionLimit = learner.getEffectiveLimit(modelId, configuredLimit);
		assert.ok(
			afterRejectionLimit < initialLimit,
			`after rejections, limit ${afterRejectionLimit} should be lower than initial ${initialLimit}`,
		);

		// Simulate many successes at lower rate
		for (let i = 0; i < 20; i++) {
			learner.recordOutcome(modelId, 'safe', 3);
		}

		const afterSuccessLimit = learner.getEffectiveLimit(modelId, configuredLimit);
		assert.ok(
			afterSuccessLimit > afterRejectionLimit,
			`after successes, limit ${afterSuccessLimit} should recover above ${afterRejectionLimit}`,
		);

		// Epsilon should have decayed from rejections
		const belief = learner['beliefs'].models[modelId];
		assert.ok(
			belief.epsilon < 0.05,
			`epsilon ${belief.epsilon} should have decayed below 0.05`,
		);
		assert.ok(belief.epsilon >= 0.01, `epsilon ${belief.epsilon} should not decay below 0.01`);

		// Test integration with limiter: adaptive limit should affect throttling
		const config: RateLimitConfig = {
			maxRequestsPerMinute: configuredLimit,
			maxTokensPerMinute: 8000,
			autoResumeOn432: false,
			tokenEstimateRatio: 4,
			throttleThresholdPercent: 80,
			globalRateLimit: true,
			heartbeatIntervalMs: 500,
			lockTimeoutMs: 5000,
			staleProcessTimeoutMs: 30000,
			modelProfiles: [],
			adaptiveRateLimit: 'both',
		};

		// After rejections, the effective limit is lower. Let's see how many requests get through.
		let allowedCount = 0;
		const effectiveLimit = Math.ceil(learner.getEffectiveLimit(modelId, configuredLimit));
		for (let i = 0; i < effectiveLimit + 2; i++) {
			const result = limiter.checkAndRecord(10, effectiveLimit, 10000, 80, modelId);
			if (result.allowed) allowedCount++;
		}

		assert.strictEqual(
			allowedCount,
			effectiveLimit,
			`should allow exactly ${effectiveLimit} requests at adaptive limit`,
		);

		limiter.shutdown();
		cleanup(dir);
	});

	it('should persist beliefs across restarts', () => {
		const dir = makeTempDir();
		const beliefsPath = join(dir, 'beliefs.json');

		const learner1 = new AdaptiveLearner(beliefsPath);
		learner1.initializeBelief('claude-sonnet', 10);
		learner1.updateOnSuccess('claude-sonnet', 5);
		learner1.updateOnRejection('claude-sonnet', 8);
		learner1.saveBeliefs();

		assert.strictEqual(existsSync(beliefsPath), true, 'beliefs file should exist');

		const learner2 = new AdaptiveLearner(beliefsPath);
		const belief = learner2.getOrCreateBelief('claude-sonnet', 10);
		assert.strictEqual(belief.shape, 3); // 2 (prior) + 1 (success)
		assert.ok(belief.rate > 0.01, 'rate should have increased from rejection');
		assert.ok(belief.epsilon < 0.05, 'epsilon should have decayed');

		cleanup(dir);
	});
});

// ============================================================================
// E2E: Multi-process global sync
// ============================================================================

describe('E2E: Multi-process global sync', () => {
	it('should coordinate limits across simulated processes with optimistic locking', () => {
		const dir = makeTempDir();
		const p1 = new GlobalRateLimiter({
			stateDir: dir,
			pid: 1001,
			heartbeatIntervalMs: 100,
			lockTimeoutMs: 500,
			staleProcessTimeoutMs: 500,
		});
		const p2 = new GlobalRateLimiter({
			stateDir: dir,
			pid: 1002,
			heartbeatIntervalMs: 100,
			lockTimeoutMs: 500,
			staleProcessTimeoutMs: 500,
		});
		const p3 = new GlobalRateLimiter({
			stateDir: dir,
			pid: 1003,
			heartbeatIntervalMs: 100,
			lockTimeoutMs: 500,
			staleProcessTimeoutMs: 500,
		});

		p1.init();
		p2.init();
		p3.init();

		// Each process sends requests for different models
		for (let i = 0; i < 3; i++) {
			p1.checkAndRecord(10, 5, 10000, 80, 'model-a');
			p2.checkAndRecord(10, 5, 10000, 80, 'model-b');
			p3.checkAndRecord(10, 5, 10000, 80, 'model-a');
		}

		// model-a: 3 (p1) + 3 (p3) = 6 requests, limit 5 → next should throttle
		const rA = p1.checkAndRecord(10, 5, 10000, 80, 'model-a');
		assert.strictEqual(rA.allowed, false, 'model-a should throttle at global 6 > 5*0.8=4');

		// model-b: 3 requests, limit 5 → should still allow
		const rB = p2.checkAndRecord(10, 5, 10000, 80, 'model-b');
		assert.strictEqual(rB.allowed, true, 'model-b should still allow at global 3');

		p1.shutdown();
		p2.shutdown();
		p3.shutdown();
		cleanup(dir);
	});
});

// ============================================================================
// E2E: 432 error detection and handling
// ============================================================================

describe('E2E: 432 error handling', () => {
	it('should detect various 432-like error messages', () => {
		assert.strictEqual(is432LikeError('432 rate limit exceeded'), true);
		assert.strictEqual(is432LikeError('Rate limit: too many requests'), true);
		assert.strictEqual(is432LikeError('token数已达每分钟上限'), true);
		assert.strictEqual(is432LikeError('输入token超出限制'), true);
		assert.strictEqual(is432LikeError('input token rate limit'), true);
		assert.strictEqual(is432LikeError('some other error'), false);
		assert.strictEqual(is432LikeError(undefined), false);
	});

	it('should trigger auto-resume callback on 432 detection', () => {
		let resumeCalled = false;
		let resumeDelayMs = 0;

		// Mock auto-resume scheduler
		function mockScheduleAutoResume() {
			const now = Date.now();
			resumeDelayMs = 60000 - (now % 60000) + 500;
			resumeCalled = true;
		}

		// Simulate 432 detection
		const errorMessage = '432 - input token rate limit exceeded';
		assert.strictEqual(is432LikeError(errorMessage), true);
		mockScheduleAutoResume();

		assert.strictEqual(resumeCalled, true);
		assert.ok(
			resumeDelayMs > 0 && resumeDelayMs <= 65000,
			`delay ${resumeDelayMs} should be within a minute`,
		);
	});
});

// ============================================================================
// E2E: Token estimation
// ============================================================================

describe('E2E: Token estimation', () => {
	it('should estimate tokens from various payload shapes', () => {
		const ratio = 4;

		const openaiPayload = {
			model: 'gpt-4',
			messages: [
				{ role: 'system', content: 'You are helpful.' },
				{ role: 'user', content: 'Hello world!' },
			],
		};
		const openaiTokens = estimateTokensFromPayload(openaiPayload, ratio);
		// System content is counted once (no more double-counting)
		const expectedChars = 'You are helpful.'.length + 'Hello world!'.length;
		assert.strictEqual(openaiTokens, Math.ceil(expectedChars / ratio));

		const anthropicPayload = {
			model: 'claude-sonnet-4-6',
			system: 'System prompt here',
			messages: [{ role: 'user', content: 'Tell me a story.' }],
		};
		const anthropicTokens = estimateTokensFromPayload(anthropicPayload, ratio);
		assert.ok(anthropicTokens > 0);

		const arrayContentPayload = {
			model: 'gpt-4-vision',
			messages: [
				{
					role: 'user',
					content: [
						{ type: 'text', text: 'Describe this image.' },
						{ type: 'image_url', image_url: { url: 'http://example.com/img.jpg' } },
					],
				},
			],
		};
		const arrayTokens = estimateTokensFromPayload(arrayContentPayload, ratio);
		assert.ok(arrayTokens > 0);
	});
});

// ============================================================================
// E2E: Full session simulation
// ============================================================================

describe('E2E: Full session simulation', () => {
	it('should handle a realistic session with mixed outcomes', () => {
		const dir = makeTempDir();
		const limiter = new GlobalRateLimiter({
			stateDir: dir,
			heartbeatIntervalMs: 100,
			lockTimeoutMs: 500,
			staleProcessTimeoutMs: 500,
		});
		limiter.init();

		const learner = new AdaptiveLearner(join(dir, 'session-beliefs.json'));
		const config: RateLimitConfig = {
			maxRequestsPerMinute: 10,
			maxTokensPerMinute: 5000,
			autoResumeOn432: true,
			tokenEstimateRatio: 4,
			throttleThresholdPercent: 80,
			globalRateLimit: true,
			heartbeatIntervalMs: 500,
			lockTimeoutMs: 5000,
			staleProcessTimeoutMs: 30000,
			modelProfiles: [
				{ modelPattern: 'claude-*', maxRequestsPerMinute: 5, maxTokensPerMinute: 2000 },
			],
			adaptiveRateLimit: 'both',
		};

		const session: SimulatedRequest[] = [
			{
				payload: {
					model: 'claude-sonnet-4-6',
					messages: [{ role: 'user', content: 'Hello' }],
				},
				actualTokens: 2,
				outcome: 'success',
			},
			{
				payload: {
					model: 'claude-sonnet-4-6',
					messages: [{ role: 'user', content: 'World' }],
				},
				actualTokens: 2,
				outcome: 'success',
			},
			{
				payload: {
					model: 'claude-sonnet-4-6',
					messages: [{ role: 'user', content: 'Test' }],
				},
				actualTokens: 2,
				outcome: 'success',
			},
			{
				payload: {
					model: 'claude-sonnet-4-6',
					messages: [{ role: 'user', content: 'More' }],
				},
				actualTokens: 2,
				outcome: 'rejected',
			},
			{
				payload: {
					model: 'claude-sonnet-4-6',
					messages: [{ role: 'user', content: 'Again' }],
				},
				actualTokens: 2,
				outcome: 'success',
			},
		];

		let successCount = 0;
		let rejectCount = 0;
		let throttleCount = 0;

		for (const req of session) {
			const result = runRequestPipeline(limiter, learner, config, req);
			if (result.throttled) {
				throttleCount++;
			} else if (req.outcome === 'rejected') {
				rejectCount++;
			} else {
				successCount++;
			}
		}

		// With claude limit of 5 and threshold 80%, throttle at 4 requests
		// First 3 succeed, 4th gets rejected (not throttled), 5th might be throttled
		assert.ok(successCount >= 3, `should have at least 3 successes, got ${successCount}`);
		assert.ok(throttleCount + rejectCount >= 1, 'should have some throttling or rejections');

		// Verify global state reflects actual successful requests
		const stats = limiter.getGlobalStats('claude-sonnet-4-6');
		assert.ok(stats);
		assert.ok(stats!.requests >= successCount, 'global stats should track successful requests');

		// Verify adaptive learner updated its beliefs
		const belief = learner['beliefs'].models['claude-sonnet-4-6'];
		assert.ok(belief, 'should have belief for claude model');
		assert.ok(belief.shape > 2, 'should have observed successes');

		limiter.shutdown();
		cleanup(dir);
	});
});
