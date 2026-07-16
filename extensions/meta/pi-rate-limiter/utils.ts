import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
// Extension directory (for built-in default config)
// ============================================================================

export function getExtensionDir(): string {
	try {
		return dirname(fileURLToPath(import.meta.url));
	} catch {
		return __dirname;
	}
}

// ============================================================================
// YAML parsing
// ============================================================================

/**
 * Parse a minimal subset of YAML sufficient for this extension's config.
 * Supports top-level key: value pairs only. Numbers and booleans are auto-detected.
 */
export function parseSimpleYaml(text: string): Record<string, string | number | boolean> {
	const result: Record<string, string | number | boolean> = {};
	for (const raw of text.split('\n')) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		const colonIdx = line.indexOf(':');
		if (colonIdx === -1) continue;
		const key = line.slice(0, colonIdx).trim();
		const val = line.slice(colonIdx + 1).trim();
		if (val === 'true') {
			result[key] = true;
		} else if (val === 'false') {
			result[key] = false;
		} else if (val !== '' && !Number.isNaN(Number(val))) {
			result[key] = Number(val);
		} else {
			result[key] = val;
		}
	}
	return result;
}

// ============================================================================
// Config loading (4-layer priority)
// ============================================================================

export function loadYamlConfig(cwd: string, extensionDir: string): Partial<RateLimitConfig> {
	const builtinPath = join(extensionDir, 'pi-rate-limiter.yaml');
	const globalPath = join(
		homedir(),
		'.pi',
		'agent',
		'extensions-data',
		'pi-rate-limiter',
		'pi-rate-limiter.yaml',
	);
	const projectPath = join(cwd, '.pi', 'agent', 'extensions', 'pi-rate-limiter.yaml');

	let merged: Partial<RateLimitConfig> = {};

	for (const path of [builtinPath, globalPath, projectPath]) {
		if (existsSync(path)) {
			try {
				const raw = readFileSync(path, 'utf8');
				const parsed = parseSimpleYaml(raw);
				const picked: Partial<RateLimitConfig> = {};
				if ('maxRequestsPerMinute' in parsed)
					picked.maxRequestsPerMinute = Number(parsed.maxRequestsPerMinute);
				if ('maxTokensPerMinute' in parsed)
					picked.maxTokensPerMinute = Number(parsed.maxTokensPerMinute);
				if ('autoResumeOn432' in parsed)
					picked.autoResumeOn432 = Boolean(parsed.autoResumeOn432);
				if ('tokenEstimateRatio' in parsed)
					picked.tokenEstimateRatio = Number(parsed.tokenEstimateRatio);
				if ('throttleThresholdPercent' in parsed)
					picked.throttleThresholdPercent = Number(parsed.throttleThresholdPercent);
				if ('globalRateLimit' in parsed)
					picked.globalRateLimit = Boolean(parsed.globalRateLimit);
				if ('heartbeatIntervalMs' in parsed)
					picked.heartbeatIntervalMs = Number(parsed.heartbeatIntervalMs);
				if ('lockTimeoutMs' in parsed) picked.lockTimeoutMs = Number(parsed.lockTimeoutMs);
				if ('staleProcessTimeoutMs' in parsed)
					picked.staleProcessTimeoutMs = Number(parsed.staleProcessTimeoutMs);
				if ('adaptiveRateLimit' in parsed) {
					const raw = parsed.adaptiveRateLimit;
					if (raw === true || raw === 'true' || raw === 'both') picked.adaptiveRateLimit = 'both';
					else if (raw === false || raw === 'off' || raw === 'false') picked.adaptiveRateLimit = 'off';
					else if (raw === 'bayesian') picked.adaptiveRateLimit = 'bayesian';
					else if (raw === 'ucb') picked.adaptiveRateLimit = 'ucb';
				}
				if ('modelProfiles' in parsed) {
					try {
						const mp = JSON.parse(String(parsed.modelProfiles));
						if (Array.isArray(mp)) picked.modelProfiles = mp as ModelProfile[];
					} catch {
						// ignore malformed modelProfiles
					}
				}
				merged = { ...merged, ...picked };
			} catch {
				// ignore malformed config
			}
		}
	}

	return merged;
}

export function mergeConfig(
	base: RateLimitConfig,
	overrides: Partial<RateLimitConfig>,
): RateLimitConfig {
	return {
		maxRequestsPerMinute: overrides.maxRequestsPerMinute ?? base.maxRequestsPerMinute,
		maxTokensPerMinute: overrides.maxTokensPerMinute ?? base.maxTokensPerMinute,
		autoResumeOn432: overrides.autoResumeOn432 ?? base.autoResumeOn432,
		tokenEstimateRatio: overrides.tokenEstimateRatio ?? base.tokenEstimateRatio,
		throttleThresholdPercent:
			overrides.throttleThresholdPercent ?? base.throttleThresholdPercent,
		globalRateLimit: overrides.globalRateLimit ?? base.globalRateLimit,
		heartbeatIntervalMs: overrides.heartbeatIntervalMs ?? base.heartbeatIntervalMs,
		lockTimeoutMs: overrides.lockTimeoutMs ?? base.lockTimeoutMs,
		staleProcessTimeoutMs: overrides.staleProcessTimeoutMs ?? base.staleProcessTimeoutMs,
		modelProfiles: overrides.modelProfiles ?? base.modelProfiles,
		adaptiveRateLimit: overrides.adaptiveRateLimit ?? base.adaptiveRateLimit,
	};
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
