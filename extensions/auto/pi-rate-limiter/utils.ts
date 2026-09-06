import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveConfigPaths, readJsonFile, deepMerge } from '@zenone/pi-config';

// ============================================================================
// Logger
// ============================================================================

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

let logLevel: LogLevel = 'info';
let logFile: string | undefined;

export function setLogLevel(level: LogLevel) {
	logLevel = level;
}

export function setLogFile(path: string) {
	logFile = path;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

export function log(level: LogLevel, message: string, data?: unknown): void {
	if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[logLevel]) return;

	const timestamp = new Date().toISOString();
	const dataStr = data !== undefined ? ' ' + JSON.stringify(data) : '';
	const line = `[${timestamp}] [${level.toUpperCase()}] ${message}${dataStr}\n`;

	// Always write to log file if configured
	if (logFile) {
		try {
			const dir = dirname(logFile);
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
			appendFileSync(logFile, line, 'utf8');
		} catch {
			// Ignore log write failures
		}
	}
}

export const logger = {
	debug: (msg: string, data?: unknown) => log('debug', msg, data),
	info: (msg: string, data?: unknown) => log('info', msg, data),
	warn: (msg: string, data?: unknown) => log('warn', msg, data),
	error: (msg: string, data?: unknown) => log('error', msg, data),
};

// ============================================================================
// Types & Defaults
// ============================================================================

export interface ModelProfile {
	modelPattern: string;
	maxRequestsPerMinute: number;
	maxTokensPerMinute: number;
	throttleThresholdPercent?: number;
}

export type AdaptiveMode = 'off' | 'bayesian' | 'ucb' | 'both';

export interface RateLimitConfig {
	maxRequestsPerMinute: number;
	maxTokensPerMinute: number;
	autoResumeOn432: boolean;
	tokenEstimateRatio: number;
	throttleThresholdPercent: number;
	globalRateLimit: boolean;
	heartbeatIntervalMs: number;
	lockTimeoutMs: number;
	staleProcessTimeoutMs: number;
	modelProfiles: ModelProfile[];
	adaptiveRateLimit: AdaptiveMode;
}

export const DEFAULT_CONFIG: RateLimitConfig = {
	maxRequestsPerMinute: 10,
	maxTokensPerMinute: 8000,
	autoResumeOn432: false,
	tokenEstimateRatio: 4,
	throttleThresholdPercent: 80,
	globalRateLimit: true,
	heartbeatIntervalMs: 500,
	lockTimeoutMs: 5000,
	staleProcessTimeoutMs: 30000,
	modelProfiles: [],
	adaptiveRateLimit: 'off',
};

export interface RequestLogEntry {
	timestamp: number;
	estimatedTokens: number;
}

export interface PersistedState {
	config: Partial<RateLimitConfig>;
}

export const CUSTOM_TYPE = 'rate-limiter-state';
export const STATUS_KEY = 'rate-limiter';

// ============================================================================
// Config loading (JSON-based, using @zenone/pi-config)
// ============================================================================

/**
 * Load config from user + project levels using pi-config standard paths.
 * Defaults are built-in; no bundled config file needed.
 */
export function loadConfig(cwd: string): Partial<RateLimitConfig> {
	const paths = resolveConfigPaths('pi-rate-limiter', { cwd });
	let merged: Partial<RateLimitConfig> = {};

	// User level
	const userRaw = readJsonFile(paths.userFile);
	if (userRaw !== null) {
		merged = deepMerge(merged, userRaw as Partial<RateLimitConfig>);
	}

	// Project level (highest priority)
	const projectRaw = readJsonFile(paths.projectFile);
	if (projectRaw !== null) {
		merged = deepMerge(merged, projectRaw as Partial<RateLimitConfig>);
	}

	return merged;
}

// ============================================================================
// Token estimation
// ============================================================================

export function estimateTokensFromPayload(payload: unknown, ratio: number): number {
	if (!payload || typeof payload !== 'object') return 0;
	const p = payload as Record<string, unknown>;
	const messages = p.messages;
	if (!Array.isArray(messages)) return 0;

	let chars = 0;
	for (const msg of messages) {
		if (!msg || typeof msg !== 'object') continue;
		const m = msg as Record<string, unknown>;

		// OpenAI / Anthropic message content
		const content = m.content;
		if (typeof content === 'string') {
			chars += content.length;
		} else if (Array.isArray(content)) {
			for (const block of content) {
				if (block && typeof block === 'object') {
					const text = (block as Record<string, unknown>).text;
					if (typeof text === 'string') chars += text.length;
				}
			}
		}
	}

	// Some providers put system prompt at payload.system
	const system = p.system;
	if (typeof system === 'string') chars += system.length;

	return Math.max(0, Math.ceil(chars / ratio));
}

// ============================================================================
// Error detection
// ============================================================================

export function is432LikeError(errorMessage: string | undefined): boolean {
	if (!errorMessage) return false;
	const lower = errorMessage.toLowerCase();
	return (
		lower.includes('432') ||
		lower.includes('token数已达每分钟上限') ||
		lower.includes('rate limit') ||
		lower.includes('too many requests') ||
		lower.includes('输入token') ||
		lower.includes('input token')
	);
}

// ============================================================================
// Window helpers
// ============================================================================

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getWindowStart(now: number): number {
	return Math.floor(now / 60000) * 60000;
}

// ============================================================================
// Model detection & profile matching
// ============================================================================

export function detectModelFromPayload(payload: unknown): string | undefined {
	if (!payload || typeof payload !== 'object') return undefined;
	const p = payload as Record<string, unknown>;
	const model = p.model;
	if (typeof model === 'string' && model.length > 0) {
		return model;
	}
	return undefined;
}

export function matchModelProfile(
	modelId: string,
	profiles: ModelProfile[],
): ModelProfile | undefined {
	for (const profile of profiles) {
		const pattern = profile.modelPattern;
		// Regex: starts and ends with /
		if (pattern.startsWith('/') && pattern.endsWith('/')) {
			try {
				const re = new RegExp(pattern.slice(1, -1));
				if (re.test(modelId)) return profile;
			} catch {
				// Invalid regex, fall through to glob/literal
			}
		}
		// Glob: contains *
		if (pattern.includes('*')) {
			const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
			if (regex.test(modelId)) return profile;
		}
		// Exact match
		if (pattern === modelId) return profile;
	}
	return undefined;
}

export function getEffectiveLimits(
	config: RateLimitConfig,
	modelId: string | undefined,
): { maxReq: number; maxTok: number; thresholdPercent: number } {
	if (modelId) {
		const profile = matchModelProfile(modelId, config.modelProfiles);
		if (profile) {
			return {
				maxReq: profile.maxRequestsPerMinute,
				maxTok: profile.maxTokensPerMinute,
				thresholdPercent:
					profile.throttleThresholdPercent ?? config.throttleThresholdPercent,
			};
		}
	}
	return {
		maxReq: config.maxRequestsPerMinute,
		maxTok: config.maxTokensPerMinute,
		thresholdPercent: config.throttleThresholdPercent,
	};
}
