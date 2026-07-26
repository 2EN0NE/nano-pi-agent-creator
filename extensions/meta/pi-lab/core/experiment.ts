/**
 * 单个实验实例：select → record → stats
 */

import type { ArmDef, ArmState, BanditStrategy, ContextKeyFn, Outcome } from '../types.js';
import { selectArm, type EpsilonConfig } from './bandit.js';
import { ExperimentStorage } from './storage.js';

export class Experiment {
	private _name: string;
	private _strategy: BanditStrategy;
	private _arms: ArmDef[];
	private _contextKey: ContextKeyFn<any> | string;
	private _storage: ExperimentStorage;
	private _forceArmId: string | null = null;
	private _epsilonConfig?: EpsilonConfig;

	constructor(
		name: string,
		strategy: BanditStrategy,
		arms: ArmDef[],
		contextKey: ContextKeyFn<any> | string,
		epsilonConfig?: EpsilonConfig,
	) {
		this._name = name;
		this._strategy = strategy;
		this._arms = arms;
		this._contextKey = contextKey;
		this._epsilonConfig = epsilonConfig;
		this._storage = new ExperimentStorage(
			name,
			strategy,
			arms.map((a) => a.id),
		);
	}

	// ── 核心 API ──

	async select(context: unknown): Promise<string> {
		if (this._forceArmId) return this._forceArmId;

		const ctxKey = this._resolveContextKey(context);
		const states = this._getStates(ctxKey);

		return selectArm(this._strategy, this._armIds(), states, this._epsilonConfig);
	}

	async record(armId: string, outcome: Outcome, context: unknown): Promise<void> {
		const ctxKey = this._resolveContextKey(context);
		const current = this._storage.getArmState(ctxKey, armId) ?? {
			alpha: 1,
			beta: 1,
			firstAttempts: 0,
			totalCalls: 0,
			totalLatencyMs: 0,
		};

		this._storage.updateArmState(ctxKey, armId, {
			alpha: current.alpha + (outcome.success ? 1 : 0),
			beta: current.beta + (outcome.success ? 0 : 1),
			firstAttempts: current.firstAttempts + (outcome.firstAttempt ? 1 : 0),
			totalCalls: current.totalCalls + 1,
			totalLatencyMs: current.totalLatencyMs + (outcome.latencyMs ?? 0),
		});
	}

	// ── 统计 ──

	async stats(context?: unknown): Promise<Record<string, ArmState>> {
		if (context !== undefined) {
			const ctxKey = this._resolveContextKey(context);
			const map = this._storage.getArmStates(ctxKey);
			const result: Record<string, ArmState> = {};
			for (const [id, state] of map) {
				result[id] = state;
			}
			return result;
		}

		// 所有 context 汇总
		const result: Record<string, ArmState> = {};
		for (const arm of this._arms) {
			let alpha = 1;
			let beta = 1;
			let firstAttempts = 0;
			let totalCalls = 0;
			let totalLatencyMs = 0;

			for (const ctxKey of this._storage.getContextKeys()) {
				const state = this._storage.getArmState(ctxKey, arm.id);
				if (state) {
					alpha += state.alpha - 1;
					beta += state.beta - 1;
					firstAttempts += state.firstAttempts;
					totalCalls += state.totalCalls;
					totalLatencyMs += state.totalLatencyMs;
				}
			}

			result[arm.id] = {
				alpha,
				beta,
				firstAttempts,
				totalCalls,
				totalLatencyMs,
			};
		}
		return result;
	}

	getContextKeys(): string[] {
		return this._storage.getContextKeys();
	}

	getArmStates(contextKey: string): Map<string, ArmState> {
		return this._storage.getArmStates(contextKey);
	}

	getInfo() {
		return {
			name: this._name,
			forceArmId: this._forceArmId,
			...this._storage.getInfo(),
		};
	}

	// ── 控制 ──

	forceArm(armId: string | null): void {
		this._forceArmId = armId;
	}

	async reset(): Promise<void> {
		this._storage.resetAll();
		await this._storage.flush();
	}

	async flush(): Promise<void> {
		await this._storage.flush();
	}

	// ── 内部 ──

	private _armIds(): string[] {
		return this._arms.map((a) => a.id);
	}

	private _resolveContextKey(context: unknown): string {
		if (context === undefined || context === null) {
			return 'global';
		}
		if (typeof this._contextKey === 'function') {
			return (this._contextKey as ContextKeyFn<unknown>)(context);
		}
		return this._contextKey;
	}

	private _getStates(ctxKey: string): Map<string, ArmState> {
		return this._storage.getArmStates(ctxKey);
	}
}
