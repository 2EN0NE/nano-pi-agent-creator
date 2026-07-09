import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert";
import { AdaptiveLearner } from "./adaptive-learner.js";

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), "adaptive-learner-test-"));
}

function cleanup(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		// ignore
	}
}

describe("AdaptiveLearner", () => {
	describe("initialization", () => {
		it("should initialize belief with weakly informative prior", () => {
			const learner = new AdaptiveLearner();
			const belief = learner.initializeBelief("test-model", 10);
			assert.ok(belief.shape > 0);
			assert.ok(belief.rate > 0);
			assert.strictEqual(belief.epsilon, 0.05);
		});

		it("should center prior near configured limit", () => {
			const learner = new AdaptiveLearner();
			const belief = learner.initializeBelief("test-model", 50);
			const mean = belief.shape / belief.rate;
			assert.ok(mean >= 40 && mean <= 60, `Prior mean ${mean} should be near 50`);
		});

		it("should return existing belief instead of creating duplicate", () => {
			const learner = new AdaptiveLearner();
			const b1 = learner.initializeBelief("test-model", 10);
			const b2 = learner.getOrCreateBelief("test-model", 10);
			assert.strictEqual(b1.shape, b2.shape);
			assert.strictEqual(b1.rate, b2.rate);
		});
	});

	describe("updates", () => {
		it("should increase shape on success", () => {
			const learner = new AdaptiveLearner();
			learner.initializeBelief("test-model", 10);
			const beforeShape = learner["beliefs"].models["test-model"].shape;
			learner.updateOnSuccess("test-model", 5);
			const afterShape = learner["beliefs"].models["test-model"].shape;
			assert.strictEqual(afterShape, beforeShape + 1);
		});

		it("should increase rate and decay epsilon on rejection", () => {
			const learner = new AdaptiveLearner();
			learner.initializeBelief("test-model", 10);
			const beforeRate = learner["beliefs"].models["test-model"].rate;
			const beforeEpsilon = learner["beliefs"].models["test-model"].epsilon;
			learner.updateOnRejection("test-model", 8);
			const afterRate = learner["beliefs"].models["test-model"].rate;
			const afterEpsilon = learner["beliefs"].models["test-model"].epsilon;
			assert.ok(afterRate > beforeRate, "Rate should increase after rejection");
			assert.ok(afterEpsilon < beforeEpsilon, "Epsilon should decay after rejection");
		});

		it("should partially increase shape on near-boundary success", () => {
			const learner = new AdaptiveLearner();
			learner.initializeBelief("test-model", 10);
			const beforeShape = learner["beliefs"].models["test-model"].shape;
			learner.updateOnNearBoundary("test-model", 8);
			const afterShape = learner["beliefs"].models["test-model"].shape;
			assert.strictEqual(afterShape, beforeShape + 0.5);
		});
	});

	describe("effective limit", () => {
		it("should return posterior mean as effective limit", () => {
			const learner = new AdaptiveLearner();
			learner.initializeBelief("test-model", 10);
			const limit = learner.getEffectiveLimit("test-model", 10);
			assert.ok(limit > 0);
		});

		it("should cap effective limit at hard upper bound", () => {
			const learner = new AdaptiveLearner();
			learner.initializeBelief("test-model", 10);
			// Simulate many successes to push mean high
			for (let i = 0; i < 100; i++) {
				learner.updateOnSuccess("test-model", 5);
			}
			const limit = learner.getEffectiveLimit("test-model", 10);
			assert.ok(limit <= 20, `Limit ${limit} should be capped at 20 (2x configured)`);
		});
	});

	describe("exploration", () => {
		it("should return true with probability epsilon", () => {
			const learner = new AdaptiveLearner();
			learner.initializeBelief("test-model", 10);
			// With epsilon=0.05, over many trials we should see some explorations
			let exploreCount = 0;
			for (let i = 0; i < 1000; i++) {
				if (learner.shouldExplore("test-model")) exploreCount++;
			}
			// Should be roughly 50 with std dev ~7, so 30-70 is safe
			assert.ok(exploreCount >= 20 && exploreCount <= 80, `Explore count ${exploreCount} should be near 50`);
		});

		it("should decay epsilon after rejections", () => {
			const learner = new AdaptiveLearner();
			learner.initializeBelief("test-model", 10);
			const beforeEpsilon = learner["beliefs"].models["test-model"].epsilon;
			learner.updateOnRejection("test-model", 8);
			const afterEpsilon = learner["beliefs"].models["test-model"].epsilon;
			assert.ok(afterEpsilon < beforeEpsilon);
		});

		it("should not decay epsilon below minimum", () => {
			const learner = new AdaptiveLearner();
			learner.initializeBelief("test-model", 10);
			// Many rejections
			for (let i = 0; i < 50; i++) {
				learner.updateOnRejection("test-model", 8);
			}
			const epsilon = learner["beliefs"].models["test-model"].epsilon;
			assert.ok(epsilon >= 0.01, `Epsilon ${epsilon} should not decay below 0.01`);
		});
	});

	describe("persistence", () => {
		it("should save and load beliefs", () => {
			const dir = makeTempDir();
			const path = join(dir, "beliefs.json");
			const learner1 = new AdaptiveLearner(path);
			learner1.initializeBelief("test-model", 10);
			learner1.updateOnSuccess("test-model", 5);
			learner1.saveBeliefs();

			const learner2 = new AdaptiveLearner(path);
			const belief = learner2.getOrCreateBelief("test-model", 10);
			assert.strictEqual(belief.shape, 3); // 2 (prior) + 1 (success)

			cleanup(dir);
		});

		it("should return empty beliefs for missing file", () => {
			const dir = makeTempDir();
			const path = join(dir, "nonexistent.json");
			const learner = new AdaptiveLearner(path);
			const belief = learner.getOrCreateBelief("new-model", 10);
			assert.strictEqual(belief.shape, 2); // default prior shape
			cleanup(dir);
		});
	});
});
