/**
 * Adaptive Rate Limit Learner
 *
 * Uses a Gamma-Poisson Bayesian model to learn the true gateway rate limit.
 * Epsilon-greedy exploration probes slightly above the estimated limit.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ============================================================================
// Types
// ============================================================================

export interface BeliefState {
	shape: number; // Gamma shape (alpha)
	rate: number; // Gamma rate (beta)
	epsilon: number; // Current exploration probability
	lastUpdate: number; // Timestamp of last update

	// Upper bound exploration (UCB-style ceiling discovery)
	// These track the highest safe limit found by systematic upward probing.
	tokCeilingDiscovered?: number; // Highest TPM confirmed safe
	tokCeilingStep?: number; // Current step size in TPM (AIMD)
	tokCeilingExplorations?: number; // Total upper-bound exploration attempts
	tokCeilingSuccesses?: number; // Successful exploration count
	tokCeilingFails?: number; // Consecutive failed explorations
}

export interface AdaptiveBeliefs {
	version: number;
	models: Record<string, BeliefState>;
}

export type OutcomeType = 'safe' | 'near' | 'rejected' | 'probe';

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

// Upper bound exploration (UCB-style AIMD ceiling discovery)
const UCB_STEP_RATIO = 0.05; // Initial step = 5% of configured limit
const UCB_SUCCESS_MULTIPLIER = 1.5; // Accelerate on success (AI)
const UCB_FAIL_MULTIPLIER = 0.5; // Decelerate on failure (MD)
const UCB_FAIL_RETREAT_RATIO = 0.85; // Retreat to 85% of failure point
const UCB_MIN_STEP_RATIO = 0.005; // Minimum step = 0.5% of configured limit
const UCB_PENALTY_WEIGHT = 10; // 432 penalty weight in UCB bonus formula

function getBeliefsPath(): string {
	return join(homedir(), '.pi', 'agent', 'rate-limiter', 'adaptive-beliefs.json');
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
			case 'safe':
				this.updateOnSuccess(modelId, currentRate);
				break;
			case 'near':
				this.updateOnNearBoundary(modelId, currentRate);
				break;
			case 'rejected':
				this.updateOnRejection(modelId, currentRate);
				break;
			case 'probe':
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

	getEffectiveLimit(modelId: string, configuredLimit: number, currentWindowUsage = 0, maxTok = 0): number {
		const belief = this.getOrCreateBelief(modelId, configuredLimit);
		// Posterior mean = shape / rate
		const posteriorMean = belief.shape / Math.max(1e-9, belief.rate);
		// Hard upper bound
		const upperBound = configuredLimit * HARD_UPPER_BOUND_MULTIPLIER;
		const effective = Math.min(posteriorMean, upperBound);

		// Headroom scaling: when token window is already heavily used,
		// reduce the effective RPM to avoid over-consuming
		if (currentWindowUsage > 0 && maxTok > 0) {
			const headroom = Math.max(0, maxTok - currentWindowUsage);
			const headroomRatio = Math.max(0.1, headroom / Math.max(1, maxTok));
			// Only scale down when over 50% of window is used
			if (currentWindowUsage > maxTok * 0.3) {
				return Math.max(1, Math.ceil(effective * headroomRatio));
			}
		}
		return Math.max(1, Math.ceil(effective));
	}

	getExplorationLimit(modelId: string, configuredLimit: number): number {
		const baseLimit = this.getEffectiveLimit(modelId, configuredLimit);
		const upperBound = configuredLimit * HARD_UPPER_BOUND_MULTIPLIER;
		return Math.min(baseLimit * EXPLORATION_MULTIPLIER, upperBound);
	}

	// -------------------------------------------------------------------------
	// Upper bound exploration (UCB-style ceiling discovery)
	//
	// Uses a simple reinforcement learning approach (AIMD + UCB) to
	// systematically discover the true API rate limit ceiling.
	//
	// Key ideas:
	//   1. Track exploredCeiling (highest TPM confirmed safe)
	//   2. UCB formula: bonus = step × sqrt(log(trials) / successes)
	//      → more exploration when uncertain, less when confident
	//   3. AIMD adjustment:
	//      - Success → raise ceiling, increase step (accelerate climb)
	//      - Failure → retreat below failure, decrease step (safe retreat)
	//
	// Reward structure:
	//   Success: +1 (raising ceiling gives long-term value)
	//   432:     -10 (strong penalty, rare but costly)
	//
	// This naturally converges: once the true ceiling is found, 432s appear,
	// step size decays to near zero, and exploration stops.
	// -------------------------------------------------------------------------

	/**
	 * Initialize UCB exploration data for a belief state.
	 * Called automatically on first exploration, safe to call multiple times.
	 */
	private ensureUpperBoundData(belief: BeliefState, configuredLimit: number): void {
		if (belief.tokCeilingDiscovered !== undefined) return;
		belief.tokCeilingDiscovered = configuredLimit;
		belief.tokCeilingStep = Math.max(1, Math.ceil(configuredLimit * UCB_STEP_RATIO));
		belief.tokCeilingExplorations = 0;
		belief.tokCeilingSuccesses = 0;
		belief.tokCeilingFails = 0;
	}

	/**
	 * Returns the TPM limit to try for upper bound exploration.
	 *
	 * UCB formula:
	 *   target = ceilingDiscovered + step × sqrt(log(trials+2) / (successes+1))
	 *
	 * When ceiling is unknown (no exploration yet), starts from configured limit + step.
	 * When exploration is mature and ceiling is stable, returns only small increments.
	 *
	 * headroom-aware: when currentWindowUsage is provided, the step is scaled by
	 * available headroom. If the context already occupies most of the window,
	 * exploration is more conservative because each request has less room.
	 */
	getUpperBoundExplorationLimit(
		modelId: string,
		configuredLimit: number,
		currentWindowUsage = 0,
	): number {
		const belief = this.getOrCreateBelief(modelId, configuredLimit);
		this.ensureUpperBoundData(belief, configuredLimit);

		const ceiling = belief.tokCeilingDiscovered!;
		const step = belief.tokCeilingStep!;
		const trials = belief.tokCeilingExplorations!;
		const successes = belief.tokCeilingSuccesses!;
		const fails = belief.tokCeilingFails ?? 0;

		// UCB bonus: larger when uncertain (few successes), smaller when confident
		const bonus = step * Math.sqrt(Math.log(trials + 2) / Math.max(1, successes + 1));

		// Headroom scaling: when current window already has high usage
		// (e.g., large context from /r), scale down the bonus proportionally.
		// This prevents aggressive exploration when there's little room left.
		let headroomRatio = 1;
		if (currentWindowUsage > 0) {
			const effectiveCeiling = Math.max(ceiling, configuredLimit);
			const headroom = Math.max(0, effectiveCeiling - currentWindowUsage);
			headroomRatio = Math.max(0.05, headroom / Math.max(1, effectiveCeiling));
		}

		// Add penalty for failures: if we've had failures, be more cautious
		const failDiscount = Math.max(0.5, 1 - fails * 0.1);
		const target = Math.ceil(ceiling + bonus * failDiscount * headroomRatio);

		// Never explore below the configured limit
		return Math.max(configuredLimit, target);
	}

	/**
	 * Record the outcome of an upper bound exploration.
	 *
	 * Reward structure drives RL convergence:
	 *   Success (+1) → raise ceiling, increase step (Additive Increase)
	 *   Failure (-10) → retreat, decrease step (Multiplicative Decrease)
	 *
	 * This is AIMD (Additive Increase Multiplicative Decrease), the same
	 * congestion control algorithm used by TCP — proven to converge.
	 */
	recordUpperBoundOutcome(
		modelId: string,
		limitAttempted: number,
		succeeded: boolean,
		configuredLimit: number,
	): void {
		const belief = this.beliefs.models[modelId];
		if (!belief) return;

		this.ensureUpperBoundData(belief, configuredLimit);
		belief.tokCeilingExplorations = (belief.tokCeilingExplorations ?? 0) + 1;

		if (succeeded) {
			// Reward: +1 — raised ceiling successfully
			belief.tokCeilingDiscovered = Math.max(
				belief.tokCeilingDiscovered ?? 0,
				limitAttempted,
			);
			belief.tokCeilingSuccesses = (belief.tokCeilingSuccesses ?? 0) + 1;
			belief.tokCeilingFails = 0;
			// Additive Increase: step grows to accelerate climb
			belief.tokCeilingStep = Math.ceil(
				(belief.tokCeilingStep ?? 0) * UCB_SUCCESS_MULTIPLIER,
			);
		} else {
			// Penalty: -10 — 432 error, retreat
			belief.tokCeilingFails = (belief.tokCeilingFails ?? 0) + 1;
			// Retreat: ceiling drops below failure point
			belief.tokCeilingDiscovered = Math.max(
				configuredLimit, // Never retreat below the user's configured baseline
				Math.ceil(limitAttempted * UCB_FAIL_RETREAT_RATIO),
			);
			// Multiplicative Decrease: step shrinks to avoid further 432s
			const minStep = Math.max(1, Math.ceil(configuredLimit * UCB_MIN_STEP_RATIO));
			belief.tokCeilingStep = Math.max(
				minStep,
				Math.ceil((belief.tokCeilingStep ?? 0) * UCB_FAIL_MULTIPLIER),
			);
		}

		this.debouncedSave();
	}

	loadBeliefs(): AdaptiveBeliefs {
		try {
			if (!existsSync(this.beliefsPath)) {
				return emptyBeliefs();
			}
			const raw = readFileSync(this.beliefsPath, 'utf8');
			const parsed = JSON.parse(raw) as AdaptiveBeliefs;
			if (parsed.version !== 1 || typeof parsed.models !== 'object') {
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
			const dir = join(homedir(), '.pi', 'agent', 'rate-limiter');
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}
			// Atomic write: tmp + rename to prevent partial file on crash
			const tmpPath = this.beliefsPath + '.tmp.' + process.pid;
			writeFileSync(tmpPath, JSON.stringify(this.beliefs, null, 2), 'utf8');
			renameSync(tmpPath, this.beliefsPath);
		} catch {
			// Ignore save failures
		}
	}
}
