/**
 * Adaptive Rate Limit Learner
 *
 * Uses a Gamma-Poisson Bayesian model to learn the true gateway rate limit.
 * Epsilon-greedy exploration probes slightly above the estimated limit.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ============================================================================
// Types
// ============================================================================

export interface BeliefState {
	shape: number; // Gamma shape (alpha)
	rate: number; // Gamma rate (beta)
	epsilon: number; // Current exploration probability
	lastUpdate: number; // Timestamp of last update
}

export interface AdaptiveBeliefs {
	version: number;
	models: Record<string, BeliefState>;
}

export type OutcomeType = "safe" | "near" | "rejected" | "probe";

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_PRIOR_SHAPE = 2;
const DEFAULT_PRIOR_RATE = 0.01;
const DEFAULT_EPSILON = 0.05;
const MIN_EPSILON = 0.01;
const EPSILON_DECAY = 0.9;
const EXPLORATION_MULTIPLIER = 1.1;
const HARD_UPPER_BOUND_MULTIPLIER = 2.0;
const DEBOUNCE_MS = 2000;

function getBeliefsPath(): string {
	return join(homedir(), ".pi", "agent", "rate-limiter", "adaptive-beliefs.json");
}

function emptyBeliefs(): AdaptiveBeliefs {
	return { version: 1, models: {} };
}

// ============================================================================
// Adaptive Learner
// ============================================================================

export class AdaptiveLearner {
	private beliefs: AdaptiveBeliefs;
	private beliefsPath: string;
	private saveTimer: ReturnType<typeof setTimeout> | undefined;
	private pendingSave = false;

	constructor(beliefsPath?: string) {
		this.beliefsPath = beliefsPath ?? getBeliefsPath();
		this.beliefs = this.loadBeliefs();
	}

	// -------------------------------------------------------------------------
	// Belief initialization
	// -------------------------------------------------------------------------

	initializeBelief(modelId: string, configuredLimit: number): BeliefState {
		// Weakly informative prior centered near the configured limit
		// Prior mean = shape / rate ≈ configuredLimit
		// We use shape=2, rate=0.01 as default, but scale rate to center near limit
		const shape = DEFAULT_PRIOR_SHAPE;
		const rate = shape / Math.max(1, configuredLimit);
		const belief: BeliefState = {
			shape,
			rate,
			epsilon: DEFAULT_EPSILON,
			lastUpdate: Date.now(),
		};
		this.beliefs.models[modelId] = belief;
		this.debouncedSave();
		return belief;
	}

	getOrCreateBelief(modelId: string, configuredLimit: number): BeliefState {
		if (!this.beliefs.models[modelId]) {
			return this.initializeBelief(modelId, configuredLimit);
		}
		return this.beliefs.models[modelId];
	}

	// -------------------------------------------------------------------------
	// Updates
	// -------------------------------------------------------------------------

	updateOnSuccess(modelId: string, _currentRate: number): void {
		const belief = this.beliefs.models[modelId];
		if (!belief) return;
		belief.shape += 1;
		belief.lastUpdate = Date.now();
		this.debouncedSave();
	}

	updateOnRejection(modelId: string, currentRate: number): void {
		const belief = this.beliefs.models[modelId];
		if (!belief) return;
		// Tighten estimate: increase rate parameter
		belief.rate += currentRate / Math.max(1, belief.shape);
		// Decay epsilon toward minimum
		belief.epsilon = Math.max(MIN_EPSILON, belief.epsilon * EPSILON_DECAY);
		belief.lastUpdate = Date.now();
		this.debouncedSave();
	}

	updateOnNearBoundary(modelId: string, _currentRate: number): void {
		const belief = this.beliefs.models[modelId];
		if (!belief) return;
		belief.shape += 0.5;
		belief.lastUpdate = Date.now();
		this.debouncedSave();
	}

	recordOutcome(modelId: string, outcome: OutcomeType, currentRate: number): void {
		switch (outcome) {
			case "safe":
				this.updateOnSuccess(modelId, currentRate);
				break;
			case "near":
				this.updateOnNearBoundary(modelId, currentRate);
				break;
			case "rejected":
				this.updateOnRejection(modelId, currentRate);
				break;
			case "probe":
				// Probe outcome: if it succeeded, treat as success
				this.updateOnSuccess(modelId, currentRate);
				break;
		}
	}

	// -------------------------------------------------------------------------
	// Exploration & effective limit
	// -------------------------------------------------------------------------

	shouldExplore(modelId: string): boolean {
		const belief = this.beliefs.models[modelId];
		if (!belief) return false;
		return Math.random() < belief.epsilon;
	}

	getEffectiveLimit(modelId: string, configuredLimit: number): number {
		const belief = this.getOrCreateBelief(modelId, configuredLimit);
		// Posterior mean = shape / rate
		const posteriorMean = belief.shape / Math.max(1e-9, belief.rate);
		// Hard upper bound
		const upperBound = configuredLimit * HARD_UPPER_BOUND_MULTIPLIER;
		return Math.min(posteriorMean, upperBound);
	}

	getExplorationLimit(modelId: string, configuredLimit: number): number {
		const baseLimit = this.getEffectiveLimit(modelId, configuredLimit);
		const upperBound = configuredLimit * HARD_UPPER_BOUND_MULTIPLIER;
		return Math.min(baseLimit * EXPLORATION_MULTIPLIER, upperBound);
	}

	// -------------------------------------------------------------------------
	// Persistence
	// -------------------------------------------------------------------------

	loadBeliefs(): AdaptiveBeliefs {
		try {
			if (!existsSync(this.beliefsPath)) {
				return emptyBeliefs();
			}
			const raw = readFileSync(this.beliefsPath, "utf8");
			const parsed = JSON.parse(raw) as AdaptiveBeliefs;
			if (parsed.version !== 1 || typeof parsed.models !== "object") {
				return emptyBeliefs();
			}
			return parsed;
		} catch {
			return emptyBeliefs();
		}
	}

	private debouncedSave(): void {
		if (this.pendingSave) return;
		this.pendingSave = true;
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
		}
		this.saveTimer = setTimeout(() => {
			this.pendingSave = false;
			this.saveBeliefs();
		}, DEBOUNCE_MS);
	}

	saveBeliefs(): void {
		try {
			const dir = join(homedir(), ".pi", "agent", "rate-limiter");
			if (!existsSync(dir)) {
				// Parent dirs should exist from global state init
				import("node:fs").then((fs) => fs.mkdirSync(dir, { recursive: true }));
			}
			writeFileSync(this.beliefsPath, JSON.stringify(this.beliefs, null, 2), "utf8");
		} catch {
			// Ignore save failures
		}
	}
}
