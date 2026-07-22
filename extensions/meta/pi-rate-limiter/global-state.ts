/**
 * Global shared rate limiter state manager.
 *
 * Uses a JSON state file + atomic directory lock (mkdir) to coordinate
 * multiple pi.dev processes on the same machine.
 *
 * State directory: ~/.pi/agent/extensions-data/pi-rate-limiter/
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveConfigPaths } from '@zenone/pi-config';

// ============================================================================
// Paths
// ============================================================================

export function getGlobalRateLimiterDir(): string {
	return resolveConfigPaths('pi-rate-limiter').userDir;
}

export function getGlobalStatePath(): string {
	return join(getGlobalRateLimiterDir(), 'global-state.json');
}

export function getLockDir(): string {
	return join(getGlobalRateLimiterDir(), '.lock');
}

export function getSessionsDir(): string {
	return join(getGlobalRateLimiterDir(), '.sessions');
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
	lastTokenEstimate?: number; // Token estimate of the most recent request, for accurate correction
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
		const raw = readFileSync(path, 'utf8');
		const parsed = JSON.parse(raw) as GlobalStateData;
		if (
			(parsed.version !== 1 && parsed.version !== 2) ||
			typeof parsed.windowStart !== 'number'
		) {
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
	const tmpPath = path + '.tmp.' + process.pid;
	writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf8');
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
	 * Read the state file and return both parsed state and raw JSON string.
	 * The raw string serves as the "version token" for CAS.
	 * Returns undefined if the file doesn't exist or is unreadable.
	 */
	private readWithRaw(): { state: GlobalStateData; raw: string } | undefined {
		if (!existsSync(this.statePath)) return undefined;
		try {
			const raw = readFileSync(this.statePath, 'utf8');
			const state = JSON.parse(raw) as GlobalStateData;
			return { state, raw };
		} catch {
			return undefined;
		}
	}

	/**
	 * Deep clone a GlobalStateData for isolated mutation.
	 * Preserves all fields without shared references to the original.
	 */
	private deepCloneState(state: GlobalStateData): GlobalStateData {
		const cloned: GlobalStateData = {
			...state,
			processes: {},
		};
		for (const [key, proc] of Object.entries(state.processes)) {
			cloned.processes[key] = { ...proc };
		}
		if (state.models) {
			cloned.models = {};
			for (const [modelId, model] of Object.entries(state.models)) {
				cloned.models[modelId] = {
					...model,
					processes: {},
				};
				for (const [pidKey, proc] of Object.entries(model.processes)) {
					cloned.models[modelId].processes[pidKey] = { ...proc };
				}
			}
		}
		return cloned;
	}

	/**
	 * Compare-And-Swap update with raw JSON string as version token.
	 *
	 * Contract — the mutator MUST be idempotent:
	 *   Applying the same mutator to the same state twice must produce
	 *   the same result as applying it once. This is required because:
	 *
	 *   a) There is a TOCTOU race between the CAS comparison (step 5) and
	 *      the atomic rename (step 6). In practice the window is
	 *      microseconds, but two processes can both pass the check,
	 *      and one will silently overwrite the other. On the next
	 *      call, the overwritten process retries with fresh state.
	 *
	 *   b) The retry loop re-applies the mutator to fresh state if a
	 *      conflict is detected. If the mutator is idempotent, this
	 *      converges correctly.
	 *
	 *   All built-in mutators (counter increments, token adjustments,
	 *   process removal) are idempotent.
	 *
	 * How it works:
	 * 1. Read current state + its raw JSON string from disk (version token)
	 * 2. Deep clone for isolated mutation
	 * 3. Apply mutator to the clone
	 * 4. Serialize clone to temp file
	 * 5. Re-read the actual file's raw JSON string
	 * 6. If raw strings match → atomic rename (swap). No change detected.
	 * 7. If raw strings differ → conflict. Another process wrote between steps 1 and 5.
	 *    Remove temp, backoff, retry from step 1 with fresh state.
	 *
	 * If all retries are exhausted, returns undefined. The caller should
	 * then fall back to a mutual-exclusion mechanism (e.g. DirectoryLock).
	 *
	 * Returns the updated state on success, undefined if all retries exhausted.
	 */
	update(mutator: (state: GlobalStateData) => void): GlobalStateData | undefined {
		for (let attempt = 0; attempt < this.maxRetries; attempt++) {
			const entry = this.readWithRaw();
			let state: GlobalStateData;
			let originalRaw: string | undefined;

			if (entry) {
				state = this.deepCloneState(entry.state);
				originalRaw = entry.raw;
			} else {
				// File doesn't exist yet — first write, no CAS needed
				state = emptyState(getWindowStart(Date.now()));
			}

			mutator(state);

			// Serialize to temp file
			const tmpPath = this.statePath + '.cas.' + process.pid;
			try {
				writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf8');
			} catch {
				// Write failed (disk full, permissions), retry
				this.cleanupTmp(tmpPath);
				this.busyBackoff(attempt);
				continue;
			}

			// CAS check: only if we had an original to compare against
			if (originalRaw !== undefined) {
				try {
					const currentRaw = readFileSync(this.statePath, 'utf8');
					if (currentRaw !== originalRaw) {
						// Conflict: another process changed the file
						this.cleanupTmp(tmpPath);
						this.busyBackoff(attempt);
						continue;
					}
				} catch {
					// File disappeared or unreadable — retry
					this.cleanupTmp(tmpPath);
					this.busyBackoff(attempt);
					continue;
				}
			}

			// Atomic swap: renameSync is atomic on POSIX.
			// If another process writes between our CAS check and this rename,
			// one writer wins atomically — the loser retries on next call.
			try {
				renameSync(tmpPath, this.statePath);
				return state;
			} catch {
				// rename failed (permissions, cross-device), retry
				this.cleanupTmp(tmpPath);
				this.busyBackoff(attempt);
			}
		}
		return undefined;
	}

	private cleanupTmp(tmpPath: string): void {
		try {
			if (existsSync(tmpPath)) {
				rmSync(tmpPath, { force: true });
			}
		} catch {
			// Ignore cleanup failures
		}
	}

	private busyBackoff(attempt: number): void {
		const ms = Math.min(50, 10 * (attempt + 1));
		// Use Atomics.wait for sub-millisecond precision without busy-waiting
		// (yields the event loop instead of blocking it)
		try {
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
		} catch {
			// Fallback: busy-wait only when Atomics is unavailable (rare)
			const start = Date.now();
			while (Date.now() - start < ms) {
				// Minimal yield
			}
		}
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
				writeFileSync(join(this.lockDir, 'ts'), String(Date.now()), 'utf8');
				this.held = true;
				return true;
			} catch {
				// Lock held; check for stale lock
				try {
					const tsRaw = readFileSync(join(this.lockDir, 'ts'), 'utf8');
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
					Atomics.wait(
						new Int32Array(new SharedArrayBuffer(4)),
						0,
						0,
						Math.min(10, remaining),
					);
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
		this.statePath = join(this.stateDir, 'global-state.json');
		this.lockDir = join(this.stateDir, '.lock');
		this.sessionsDir = join(this.stateDir, '.sessions');
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
			const tmpPath = this.heartbeatPath + '.tmp';
			writeFileSync(tmpPath, JSON.stringify(data), 'utf8');
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
			estimatedTokens,
			maxReq,
			maxTok,
			thresholdPercent,
			modelId,
		);
		if (optimisticResult !== undefined) {
			return optimisticResult;
		}

		// Fallback to directory lock
		return this.checkAndRecordWithLock(
			estimatedTokens,
			maxReq,
			maxTok,
			thresholdPercent,
			modelId,
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
					state.models[modelId].processes[pidKey] = {
						requests: 0,
						tokens: 0,
						lastHeartbeat: now,
					};
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
			state.processes[pidKey].lastTokenEstimate = estimatedTokens;
			state.totalRequests += 1;
			state.totalTokens += estimatedTokens;

			if (modelId && state.models?.[modelId]) {
				state.models[modelId].processes[pidKey].requests += 1;
				state.models[modelId].processes[pidKey].tokens += estimatedTokens;
				state.models[modelId].processes[pidKey].lastHeartbeat = now;
				state.models[modelId].processes[pidKey].lastTokenEstimate = estimatedTokens;
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
					state.models[modelId].processes[pidKey] = {
						requests: 0,
						tokens: 0,
						lastHeartbeat: now,
					};
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
			state.processes[pidKey].lastTokenEstimate = estimatedTokens;
			state.totalRequests += 1;
			state.totalTokens += estimatedTokens;

			if (modelId && state.models?.[modelId]) {
				state.models[modelId].processes[pidKey].requests += 1;
				state.models[modelId].processes[pidKey].tokens += estimatedTokens;
				state.models[modelId].processes[pidKey].lastHeartbeat = now;
				state.models[modelId].processes[pidKey].lastTokenEstimate = estimatedTokens;
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
			const result = this.checkAndRecord(
				estimatedTokens,
				maxReq,
				maxTok,
				thresholdPercent,
				modelId,
			);
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
			if (!proc || proc.requests === 0 || proc.lastTokenEstimate === undefined) return;

			const diff = actualTokens - proc.lastTokenEstimate;
			if (diff !== 0) {
				proc.tokens += diff;
				proc.lastTokenEstimate = actualTokens;
				state.totalTokens += diff;
				this.localTokens = proc.tokens;
			}

			if (modelId && state.models?.[modelId]) {
				const modelProc = state.models[modelId].processes[pidKey];
				if (modelProc) {
					const modelDiff = actualTokens - (modelProc.lastTokenEstimate ?? 0);
					if (modelDiff !== 0) {
						modelProc.tokens += modelDiff;
						modelProc.lastTokenEstimate = actualTokens;
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
			if (!proc || proc.requests === 0 || proc.lastTokenEstimate === undefined) return;

			const diff = actualTokens - proc.lastTokenEstimate;
			if (diff !== 0) {
				proc.tokens += diff;
				proc.lastTokenEstimate = actualTokens;
				state.totalTokens += diff;
				this.localTokens = proc.tokens;
			}

			if (modelId && state.models?.[modelId]) {
				const modelProc = state.models[modelId].processes[pidKey];
				if (modelProc) {
					const modelDiff = actualTokens - (modelProc.lastTokenEstimate ?? 0);
					if (modelDiff !== 0) {
						modelProc.tokens += modelDiff;
						modelProc.lastTokenEstimate = actualTokens;
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

	getGlobalStats(
		modelId?: string,
	): { requests: number; tokens: number; windowStart: number } | undefined {
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
					const hbRaw = readFileSync(hbPath, 'utf8');
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
					const hbRaw = readFileSync(hbPath, 'utf8');
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
