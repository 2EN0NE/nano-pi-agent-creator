/**
 * Global shared rate limiter state manager.
 *
 * Uses a JSON state file + atomic directory lock (mkdir) to coordinate
 * multiple pi.dev processes on the same machine.
 *
 * State directory: ~/.pi/agent/rate-limiter/
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ============================================================================
// Paths
// ============================================================================

export function getGlobalRateLimiterDir(): string {
	return join(homedir(), ".pi", "agent", "rate-limiter");
}

export function getGlobalStatePath(): string {
	return join(getGlobalRateLimiterDir(), "global-state.json");
}

export function getLockDir(): string {
	return join(getGlobalRateLimiterDir(), ".lock");
}

export function getSessionsDir(): string {
	return join(getGlobalRateLimiterDir(), ".sessions");
}

export function getHeartbeatPath(pid: number): string {
	return join(getSessionsDir(), `${pid}.json`);
}

// ============================================================================
// Types
// ============================================================================

export interface ProcessWindowStats {
	requests: number;
	tokens: number;
	lastHeartbeat: number;
}

export interface ModelWindowState {
	totalRequests: number;
	totalTokens: number;
	processes: Record<string, ProcessWindowStats>;
}

export interface GlobalStateData {
	version: number;
	windowStart: number;
	totalRequests: number;
	totalTokens: number;
	processes: Record<string, ProcessWindowStats>;
	// v2: per-model state
	models?: Record<string, ModelWindowState>;
}

export interface GlobalRateLimiterOptions {
	heartbeatIntervalMs: number;
	lockTimeoutMs: number;
	staleProcessTimeoutMs: number;
	lockMaxHoldMs: number;
}

export const DEFAULT_GLOBAL_OPTIONS: GlobalRateLimiterOptions = {
	heartbeatIntervalMs: 10000,
	lockTimeoutMs: 5000,
	staleProcessTimeoutMs: 30000,
	lockMaxHoldMs: 10000,
};

// ============================================================================
// Helpers
// ============================================================================

function ensureDir(dir: string): void {
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function getWindowStart(now: number): number {
	return Math.floor(now / 60000) * 60000;
}

function emptyState(windowStart: number): GlobalStateData {
	return {
		version: 2,
		windowStart,
		totalRequests: 0,
		totalTokens: 0,
		processes: {},
		models: {},
	};
}

function readStateFile(path: string): GlobalStateData | undefined {
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw) as GlobalStateData;
		if ((parsed.version !== 1 && parsed.version !== 2) || typeof parsed.windowStart !== "number") {
			return undefined;
		}
		// Migrate v1 to v2 on read
		if (parsed.version === 1) {
			parsed.version = 2;
			parsed.models = {};
		}
		// Ensure windowStart is aligned to minute boundary
		parsed.windowStart = getWindowStart(parsed.windowStart);
		return parsed;
	} catch {
		return undefined;
	}
}

function writeStateFile(path: string, state: GlobalStateData): void {
	const tmpPath = path + ".tmp";
	writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf8");
	// Atomic rename on POSIX; acceptable on Windows for our use-case
	renameSync(tmpPath, path);
}

// ============================================================================
// Optimistic State Manager (high-frequency sync)
// ============================================================================

export class OptimisticStateManager {
	private statePath: string;
	private maxRetries: number;

	constructor(statePath: string, maxRetries = 5) {
		this.statePath = statePath;
		this.maxRetries = maxRetries;
	}

	read(): GlobalStateData | undefined {
		return readStateFile(this.statePath);
	}

	/**
	 * Atomically update state using optimistic locking.
	 * Reads current state, calls mutator, then writes back only if state hasn't changed.
	 * Returns the updated state or undefined if all retries exhausted.
	 */
	update(mutator: (state: GlobalStateData) => void): GlobalStateData | undefined {
		for (let attempt = 0; attempt < this.maxRetries; attempt++) {
			const before = this.read();
			const state = before ? { ...before, processes: { ...before.processes } } : emptyState(getWindowStart(Date.now()));
			if (state.models) {
				state.models = { ...state.models };
				for (const key of Object.keys(state.models)) {
					state.models[key] = {
						...state.models[key],
						processes: { ...state.models[key].processes },
					};
				}
			}
			mutator(state);
			// Write to temp and rename atomically
			const tmpPath = this.statePath + ".tmp." + process.pid;
			try {
				writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf8");
				renameSync(tmpPath, this.statePath);
				return state;
			} catch {
				// Write conflict or error — retry after brief delay
				try {
					if (existsSync(tmpPath)) {
						rmSync(tmpPath, { force: true });
					}
				} catch {
					// ignore cleanup failure
				}
				// Brief backoff
				const backoff = Math.min(50, 10 * (attempt + 1));
				const start = Date.now();
				while (Date.now() - start < backoff) {
					// busy wait for sub-millisecond precision
				}
			}
		}
		return undefined;
	}
}

// ============================================================================
// Directory lock (atomic via mkdir)
// ============================================================================

export class DirectoryLock {
	private lockDir: string;
	private options: GlobalRateLimiterOptions;
	private held = false;

	constructor(lockDir: string, options: GlobalRateLimiterOptions) {
		this.lockDir = lockDir;
		this.options = options;
	}

	acquire(): boolean {
		const deadline = Date.now() + this.options.lockTimeoutMs;
		while (Date.now() < deadline) {
			try {
				mkdirSync(this.lockDir, { recursive: false });
				writeFileSync(
					join(this.lockDir, "ts"),
					String(Date.now()),
					"utf8",
				);
				this.held = true;
				return true;
			} catch {
				// Lock held; check for stale lock
				try {
					const tsRaw = readFileSync(
						join(this.lockDir, "ts"),
						"utf8",
					);
					const ts = Number(tsRaw);
					if (!Number.isNaN(ts) && Date.now() - ts > this.options.lockMaxHoldMs) {
						rmSync(this.lockDir, { recursive: true, force: true });
						continue;
					}
				} catch {
					// Stale check failed, keep waiting
				}
			}
			// Busy-wait with short sleep (acceptable for ms-scale waits)
			const remaining = deadline - Date.now();
			if (remaining > 0) {
				// Use Atomics.wait for sub-millisecond precision if available
				try {
					Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(10, remaining));
				} catch {
					// Fallback for environments where Atomics.wait is not available
				}
			}
		}
		return false;
	}

	release(): void {
		if (!this.held) return;
		try {
			rmSync(this.lockDir, { recursive: true, force: true });
		} catch {
			// Ignore release failures
		}
		this.held = false;
	}
}

// ============================================================================
// Global Rate Limiter
// ============================================================================

export class GlobalRateLimiter {
	private pid: number;
	private options: GlobalRateLimiterOptions;
	private stateDir: string;
	private statePath: string;
	private lockDir: string;
	private sessionsDir: string;
	private heartbeatPath: string;
	private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	private localRequests = 0;
	private localTokens = 0;
	private optimisticManager: OptimisticStateManager;

	constructor(options?: Partial<GlobalRateLimiterOptions> & { stateDir?: string; pid?: number }) {
		this.pid = options?.pid ?? process.pid;
		this.options = { ...DEFAULT_GLOBAL_OPTIONS, ...options };
		this.stateDir = options?.stateDir ?? getGlobalRateLimiterDir();
		this.statePath = join(this.stateDir, "global-state.json");
		this.lockDir = join(this.stateDir, ".lock");
		this.sessionsDir = join(this.stateDir, ".sessions");
		this.heartbeatPath = join(this.sessionsDir, `${this.pid}.json`);
		this.optimisticManager = new OptimisticStateManager(this.statePath);
	}

	// -------------------------------------------------------------------------
	// Lifecycle
	// -------------------------------------------------------------------------

	init(): void {
		ensureDir(this.stateDir);
		ensureDir(this.sessionsDir);
		this.writeHeartbeat();
		this.heartbeatTimer = setInterval(() => {
			this.writeHeartbeat();
		}, this.options.heartbeatIntervalMs);
	}

	shutdown(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = undefined;
		}
		try {
			if (existsSync(this.heartbeatPath)) {
				rmSync(this.heartbeatPath, { force: true });
			}
		} catch {
			// ignore
		}
		this.removeSelfFromGlobalState();
	}

	// -------------------------------------------------------------------------
	// Heartbeat
	// -------------------------------------------------------------------------

	private writeHeartbeat(): void {
		try {
			const data = {
				pid: this.pid,
				timestamp: Date.now(),
				localRequests: this.localRequests,
				localTokens: this.localTokens,
			};
			const tmpPath = this.heartbeatPath + ".tmp";
			writeFileSync(tmpPath, JSON.stringify(data), "utf8");
			renameSync(tmpPath, this.heartbeatPath);
		} catch {
			// ignore heartbeat write failures
		}
	}

	// -------------------------------------------------------------------------
	// Core: check + record (called inside before_provider_request)
	// -------------------------------------------------------------------------

	/**
	 * Atomically check global limits and record the request if allowed.
	 * Uses optimistic locking as primary, directory lock as fallback.
	 * Returns { allowed: true } if the request can proceed.
	 * Returns { allowed: false, delayMs } if we need to wait for the next window.
	 */
	checkAndRecord(
		estimatedTokens: number,
		maxReq: number,
		maxTok: number,
		thresholdPercent: number,
		modelId?: string,
	): { allowed: true } | { allowed: false; delayMs: number } {
		// Try optimistic locking first
		const optimisticResult = this.checkAndRecordOptimistic(
			estimatedTokens, maxReq, maxTok, thresholdPercent, modelId,
		);
		if (optimisticResult !== undefined) {
			return optimisticResult;
		}

		// Fallback to directory lock
		return this.checkAndRecordWithLock(
			estimatedTokens, maxReq, maxTok, thresholdPercent, modelId,
		);
	}

	private checkAndRecordOptimistic(
		estimatedTokens: number,
		maxReq: number,
		maxTok: number,
		thresholdPercent: number,
		modelId?: string,
	): { allowed: true } | { allowed: false; delayMs: number } | undefined {
		const now = Date.now();
		const windowStart = getWindowStart(now);

		const result = this.optimisticManager.update((state) => {
			// Clear any stale throttled flag from previous writes
			(state as GlobalStateData & { __throttled?: boolean }).__throttled = false;

			// Rotate window if needed
			if (state.windowStart !== windowStart) {
				state.windowStart = windowStart;
				state.totalRequests = 0;
				state.totalTokens = 0;
				state.processes = {};
				state.models = {};
			}

			const pidKey = String(this.pid);

			// Update own heartbeat
			if (!state.processes[pidKey]) {
				state.processes[pidKey] = { requests: 0, tokens: 0, lastHeartbeat: now };
			} else {
				state.processes[pidKey].lastHeartbeat = now;
			}

			// Clean up stale processes globally
			this.cleanStaleProcesses(state);
			this.recalcTotals(state);

			// Per-model state
			if (modelId) {
				if (!state.models) state.models = {};
				if (!state.models[modelId]) {
					state.models[modelId] = { totalRequests: 0, totalTokens: 0, processes: {} };
				}
				if (!state.models[modelId].processes[pidKey]) {
					state.models[modelId].processes[pidKey] = { requests: 0, tokens: 0, lastHeartbeat: now };
				} else {
					state.models[modelId].processes[pidKey].lastHeartbeat = now;
				}
				this.cleanStaleProcessesForModel(state, modelId);
				this.recalcModelTotals(state, modelId);
			}

			// Check thresholds
			const reqThreshold = maxReq > 0 ? maxReq * (thresholdPercent / 100) : Infinity;
			const tokThreshold = maxTok > 0 ? maxTok * (thresholdPercent / 100) : Infinity;

			let reqLimitHit: boolean;
			let tokLimitHit: boolean;

			if (modelId && state.models?.[modelId]) {
				const model = state.models[modelId];
				reqLimitHit = maxReq > 0 && model.totalRequests >= reqThreshold;
				tokLimitHit = maxTok > 0 && model.totalTokens + estimatedTokens >= tokThreshold;
			} else {
				reqLimitHit = maxReq > 0 && state.totalRequests >= reqThreshold;
				tokLimitHit = maxTok > 0 && state.totalTokens + estimatedTokens >= tokThreshold;
			}

			if (reqLimitHit || tokLimitHit) {
				// Signal throttled by setting a flag on state (we'll check outside)
				(state as GlobalStateData & { __throttled?: boolean }).__throttled = true;
				return;
			}

			// Record request
			state.processes[pidKey].requests += 1;
			state.processes[pidKey].tokens += estimatedTokens;
			state.processes[pidKey].lastHeartbeat = now;
			state.totalRequests += 1;
			state.totalTokens += estimatedTokens;

			if (modelId && state.models?.[modelId]) {
				state.models[modelId].processes[pidKey].requests += 1;
				state.models[modelId].processes[pidKey].tokens += estimatedTokens;
				state.models[modelId].processes[pidKey].lastHeartbeat = now;
				state.models[modelId].totalRequests += 1;
				state.models[modelId].totalTokens += estimatedTokens;
			}

			this.localRequests = state.processes[pidKey].requests;
			this.localTokens = state.processes[pidKey].tokens;
		});

		if (result === undefined) {
			// Optimistic locking failed after retries
			return undefined;
		}

		const throttled = (result as GlobalStateData & { __throttled?: boolean }).__throttled;
		if (throttled) {
			const delayMs = 60000 - (now % 60000) + 100;
			return { allowed: false, delayMs };
		}

		return { allowed: true };
	}

	private checkAndRecordWithLock(
		estimatedTokens: number,
		maxReq: number,
		maxTok: number,
		thresholdPercent: number,
		modelId?: string,
	): { allowed: true } | { allowed: false; delayMs: number } {
		const lock = new DirectoryLock(this.lockDir, this.options);
		const acquired = lock.acquire();
		if (!acquired) {
			this.localRequests += 1;
			this.localTokens += estimatedTokens;
			return { allowed: true };
		}

		try {
			const now = Date.now();
			const windowStart = getWindowStart(now);
			let state = readStateFile(this.statePath) ?? emptyState(windowStart);

			if (state.windowStart !== windowStart) {
				state = emptyState(windowStart);
			}

			const pidKey = String(this.pid);
			if (!state.processes[pidKey]) {
				state.processes[pidKey] = { requests: 0, tokens: 0, lastHeartbeat: now };
			} else {
				state.processes[pidKey].lastHeartbeat = now;
			}

			this.cleanStaleProcesses(state);
			this.recalcTotals(state);

			if (modelId) {
				if (!state.models) state.models = {};
				if (!state.models[modelId]) {
					state.models[modelId] = { totalRequests: 0, totalTokens: 0, processes: {} };
				}
				if (!state.models[modelId].processes[pidKey]) {
					state.models[modelId].processes[pidKey] = { requests: 0, tokens: 0, lastHeartbeat: now };
				}
				this.cleanStaleProcessesForModel(state, modelId);
				this.recalcModelTotals(state, modelId);
			}

			const reqThreshold = maxReq > 0 ? maxReq * (thresholdPercent / 100) : Infinity;
			const tokThreshold = maxTok > 0 ? maxTok * (thresholdPercent / 100) : Infinity;

			let reqLimitHit: boolean;
			let tokLimitHit: boolean;
			if (modelId && state.models?.[modelId]) {
				const model = state.models[modelId];
				reqLimitHit = maxReq > 0 && model.totalRequests >= reqThreshold;
				tokLimitHit = maxTok > 0 && model.totalTokens + estimatedTokens >= tokThreshold;
			} else {
				reqLimitHit = maxReq > 0 && state.totalRequests >= reqThreshold;
				tokLimitHit = maxTok > 0 && state.totalTokens + estimatedTokens >= tokThreshold;
			}

			if (reqLimitHit || tokLimitHit) {
				const delayMs = 60000 - (now % 60000) + 100;
				return { allowed: false, delayMs };
			}

			state.processes[pidKey].requests += 1;
			state.processes[pidKey].tokens += estimatedTokens;
			state.processes[pidKey].lastHeartbeat = now;
			state.totalRequests += 1;
			state.totalTokens += estimatedTokens;

			if (modelId && state.models?.[modelId]) {
				state.models[modelId].processes[pidKey].requests += 1;
				state.models[modelId].processes[pidKey].tokens += estimatedTokens;
				state.models[modelId].totalRequests += 1;
				state.models[modelId].totalTokens += estimatedTokens;
			}

			this.localRequests = state.processes[pidKey].requests;
			this.localTokens = state.processes[pidKey].tokens;

			writeStateFile(this.statePath, state);
			return { allowed: true };
		} finally {
			lock.release();
		}
	}

	/**
	 * Wait-loop wrapper: keeps checking (and waiting) until allowed.
	 */
	async throttle(
		estimatedTokens: number,
		maxReq: number,
		maxTok: number,
		thresholdPercent: number,
		modelId?: string,
	): Promise<void> {
		while (true) {
			const result = this.checkAndRecord(estimatedTokens, maxReq, maxTok, thresholdPercent, modelId);
			if (result.allowed) {
				return;
			}
			await sleep(result.delayMs);
		}
	}

	// -------------------------------------------------------------------------
	// Correct token estimate with actual usage
	// -------------------------------------------------------------------------

	correctLastRequest(actualTokens: number, modelId?: string): void {
		// Try optimistic first
		const optimisticResult = this.optimisticManager.update((state) => {
			const now = Date.now();
			const windowStart = getWindowStart(now);
			if (state.windowStart !== windowStart) return;

			const pidKey = String(this.pid);
			const proc = state.processes[pidKey];
			if (!proc || proc.requests === 0) return;

			const diff = actualTokens - proc.tokens;
			if (diff !== 0) {
				proc.tokens = actualTokens;
				state.totalTokens += diff;
				this.localTokens = proc.tokens;
			}

			if (modelId && state.models?.[modelId]) {
				const modelProc = state.models[modelId].processes[pidKey];
				if (modelProc) {
					const modelDiff = actualTokens - modelProc.tokens;
					if (modelDiff !== 0) {
						modelProc.tokens = actualTokens;
						state.models[modelId].totalTokens += modelDiff;
					}
				}
			}
		});

		if (optimisticResult !== undefined) return;

		// Fallback to directory lock
		const lock = new DirectoryLock(this.lockDir, this.options);
		const acquired = lock.acquire();
		if (!acquired) return;

		try {
			const now = Date.now();
			const windowStart = getWindowStart(now);
			let state = readStateFile(this.statePath);
			if (!state) return;
			if (state.windowStart !== windowStart) return;

			const pidKey = String(this.pid);
			const proc = state.processes[pidKey];
			if (!proc || proc.requests === 0) return;

			const diff = actualTokens - proc.tokens;
			if (diff !== 0) {
				proc.tokens = actualTokens;
				state.totalTokens += diff;
				this.localTokens = proc.tokens;
			}

			if (modelId && state.models?.[modelId]) {
				const modelProc = state.models[modelId].processes[pidKey];
				if (modelProc) {
					const modelDiff = actualTokens - modelProc.tokens;
					if (modelDiff !== 0) {
						modelProc.tokens = actualTokens;
						state.models[modelId].totalTokens += modelDiff;
					}
				}
			}

			writeStateFile(this.statePath, state);
		} finally {
			lock.release();
		}
	}

	// -------------------------------------------------------------------------
	// Read global stats for footer (best-effort, no blocking)
	// -------------------------------------------------------------------------

	getGlobalStats(modelId?: string): { requests: number; tokens: number; windowStart: number } | undefined {
		try {
			const now = Date.now();
			const windowStart = getWindowStart(now);
			const state = readStateFile(this.statePath);
			if (!state || state.windowStart !== windowStart) {
				return undefined;
			}
			if (modelId && state.models?.[modelId]) {
				return {
					requests: state.models[modelId].totalRequests,
					tokens: state.models[modelId].totalTokens,
					windowStart: state.windowStart,
				};
			}
			return {
				requests: state.totalRequests,
				tokens: state.totalTokens,
				windowStart: state.windowStart,
			};
		} catch {
			return undefined;
		}
	}

	// -------------------------------------------------------------------------
	// Private helpers
	// -------------------------------------------------------------------------

	private cleanStaleProcesses(state: GlobalStateData): void {
		const now = Date.now();
		for (const [pidKey, proc] of Object.entries(state.processes)) {
			if (now - proc.lastHeartbeat > this.options.staleProcessTimeoutMs) {
				try {
					const hbPath = getHeartbeatPath(Number(pidKey));
					const hbRaw = readFileSync(hbPath, "utf8");
					const hb = JSON.parse(hbRaw) as { timestamp?: number };
					if (!hb.timestamp || now - hb.timestamp > this.options.staleProcessTimeoutMs) {
						delete state.processes[pidKey];
					}
				} catch {
					delete state.processes[pidKey];
				}
			}
		}
		// Also clean per-model process entries
		if (state.models) {
			for (const modelId of Object.keys(state.models)) {
				this.cleanStaleProcessesForModel(state, modelId);
			}
		}
	}

	private cleanStaleProcessesForModel(state: GlobalStateData, modelId: string): void {
		if (!state.models?.[modelId]) return;
		const now = Date.now();
		for (const [pidKey, proc] of Object.entries(state.models[modelId].processes)) {
			if (now - proc.lastHeartbeat > this.options.staleProcessTimeoutMs) {
				try {
					const hbPath = getHeartbeatPath(Number(pidKey));
					const hbRaw = readFileSync(hbPath, "utf8");
					const hb = JSON.parse(hbRaw) as { timestamp?: number };
					if (!hb.timestamp || now - hb.timestamp > this.options.staleProcessTimeoutMs) {
						delete state.models[modelId].processes[pidKey];
					}
				} catch {
					delete state.models[modelId].processes[pidKey];
				}
			}
		}
		this.recalcModelTotals(state, modelId);
	}

	private recalcTotals(state: GlobalStateData): void {
		let totalRequests = 0;
		let totalTokens = 0;
		for (const proc of Object.values(state.processes)) {
			totalRequests += proc.requests;
			totalTokens += proc.tokens;
		}
		state.totalRequests = totalRequests;
		state.totalTokens = totalTokens;
	}

	private recalcModelTotals(state: GlobalStateData, modelId: string): void {
		if (!state.models?.[modelId]) return;
		let totalRequests = 0;
		let totalTokens = 0;
		for (const proc of Object.values(state.models[modelId].processes)) {
			totalRequests += proc.requests;
			totalTokens += proc.tokens;
		}
		state.models[modelId].totalRequests = totalRequests;
		state.models[modelId].totalTokens = totalTokens;
	}

	private removeSelfFromGlobalState(): void {
		// Try optimistic first
		const optimisticResult = this.optimisticManager.update((state) => {
			const now = Date.now();
			const windowStart = getWindowStart(now);
			if (state.windowStart !== windowStart) return;

			const pidKey = String(this.pid);
			if (state.processes[pidKey]) {
				delete state.processes[pidKey];
				this.recalcTotals(state);
			}
			if (state.models) {
				for (const modelId of Object.keys(state.models)) {
					if (state.models[modelId].processes[pidKey]) {
						delete state.models[modelId].processes[pidKey];
						this.recalcModelTotals(state, modelId);
					}
				}
			}
		});

		if (optimisticResult !== undefined) return;

		// Fallback to directory lock
		const lock = new DirectoryLock(this.lockDir, this.options);
		const acquired = lock.acquire();
		if (!acquired) return;

		try {
			const now = Date.now();
			const windowStart = getWindowStart(now);
			let state = readStateFile(this.statePath);
			if (!state || state.windowStart !== windowStart) return;

			const pidKey = String(this.pid);
			if (state.processes[pidKey]) {
				delete state.processes[pidKey];
				this.recalcTotals(state);
			}
			if (state.models) {
				for (const modelId of Object.keys(state.models)) {
					if (state.models[modelId].processes[pidKey]) {
						delete state.models[modelId].processes[pidKey];
						this.recalcModelTotals(state, modelId);
					}
				}
			}
			writeStateFile(this.statePath, state);
		} finally {
			lock.release();
		}
	}
}
