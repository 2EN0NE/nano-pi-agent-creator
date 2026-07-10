/**
 * Settings persistence for custom-compaction extension.
 *
 * Config file precedence (highest first):
 * 1. <config-dir>/<sessionId>.json — session-specific config (created when user modifies profiles)
 * 2. <config-dir>/config.json — default config
 *
 * All files live under the deterministic path:
 *   ~/.pi/agent/extensions-data/custom-compaction/
 *
 * This avoids depending on import.meta.url (which jiti may resolve differently
 * across reloads), ensuring session configs are always found after /reload.
 *
 * Writing: All modifications create a session config at <sessionId>.json.
 * The base config.json is never modified by the UI.
 *
 * On /reload or new session: session_start fires → setSessionId(sid) is called
 * → if <sid>.json exists, it is loaded. This happens before any config reads,
 * so session settings always survive reload.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
// @ts-expect-error — @zenone/pi-logger resolves api.ts at runtime; LSP misses it
import { createLogger } from "@zenone/pi-logger";
import {
	type CompactionConfig,
	type CompactionProfile,
	createDefaultConfig,
} from "./types.js";

const log = createLogger("custom-compaction:config");

// ── Deterministic config directory ─────────────────────────────
// All config files (base + session) live under this single path.
// No dependency on import.meta.url, so it survives jiti reloads.

function getConfigDir(): string {
	return join(
		homedir(),
		".pi",
		"agent",
		"extensions-data",
		"custom-compaction",
	);
}

function getBaseConfigPath(): string {
	return join(getConfigDir(), "config.json");
}

function getSessionConfigPath(sessionId: string): string {
	return join(getConfigDir(), `${sessionId}.json`);
}

// ── Config loading state ────────────────────────────────────────

let _cachedConfig: CompactionConfig | undefined;
let _activeConfigPath: string | undefined;
let _activeSessionId: string | undefined;

/**
 * Whether the currently loaded config is session-specific.
 */
export function isSessionConfig(): boolean {
	if (!_activeConfigPath || !_activeSessionId) return false;
	return _activeConfigPath === getSessionConfigPath(_activeSessionId);
}

/**
 * Get the config label for display.
 * Returns "session级配置" when session-specific, otherwise the base profile name.
 */
export function getConfigLabel(): string {
	if (isSessionConfig()) return "session级配置";
	const config = loadConfig();
	const profile = config.profiles[config.activeProfileId];
	return profile?.name ?? "Default";
}

// ── Config load / save ──────────────────────────────────────────

/**
 * Set the current session ID and re-resolve the active config.
 * If a session-specific config file exists, it becomes the active config.
 * Called from the session_start event handler.
 */
export function setSessionId(sessionId: string): void {
	_activeSessionId = sessionId;
	const sessionPath = getSessionConfigPath(sessionId);

	if (existsSync(sessionPath)) {
		_activeConfigPath = sessionPath;
		reloadConfig();
		log.info("Session config loaded:", sessionPath);
	} else {
		// No session config yet — active path stays as base config
		// The in-memory cache may be stale from factory init; reload to be safe
		reloadConfig();
	}
}

/**
 * Load config from disk.
 * Priority: <sessionId>.json > config.json
 */
export function loadConfig(): CompactionConfig {
	if (_cachedConfig) return _cachedConfig;

	// Determine which file to read
	const sessionPath = _activeSessionId
		? getSessionConfigPath(_activeSessionId)
		: null;
	const basePath = getBaseConfigPath();
	const activePath =
		sessionPath && existsSync(sessionPath)
			? sessionPath
			: existsSync(basePath)
				? basePath
				: basePath; // fallback for first run

	_activeConfigPath = activePath;

	try {
		if (existsSync(activePath)) {
			const raw = readFileSync(activePath, "utf-8");
			const parsed = JSON.parse(raw) as CompactionConfig;

			if (!parsed.profiles || typeof parsed.profiles !== "object") {
				throw new Error("Invalid config: missing or invalid 'profiles'");
			}
			if (!parsed.activeProfileId || !parsed.profiles[parsed.activeProfileId]) {
				const firstKey = Object.keys(parsed.profiles)[0];
				parsed.activeProfileId = firstKey ?? "default";
			}

			_cachedConfig = parsed;
			log.info("Config loaded from", activePath);
			return parsed;
		}
	} catch (err) {
		log.warn("Failed to load config from", activePath, String(err));
	}

	// Return defaults
	const config = createDefaultConfig();
	_cachedConfig = config;
	return config;
}

/**
 * Save config to disk as a session-specific file (<sessionId>.json).
 * Never modifies the base config.json.
 */
export function saveConfig(config: CompactionConfig): boolean {
	if (!_activeSessionId) {
		log.warn("No session ID set, cannot save session-specific config");
		return false;
	}

	const targetPath = getSessionConfigPath(_activeSessionId);

	try {
		const dir = dirname(targetPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		writeFileSync(targetPath, JSON.stringify(config, null, 2), "utf-8");
		_cachedConfig = config;
		_activeConfigPath = targetPath;
		log.info("Config saved to", targetPath);
		return true;
	} catch (err) {
		log.error("Failed to save config to", targetPath, String(err));
		return false;
	}
}

/**
 * Force-reload config from disk (discard in-memory cache).
 */
export function reloadConfig(): CompactionConfig {
	_cachedConfig = undefined;
	_activeConfigPath = undefined;
	return loadConfig();
}

/**
 * Get the active config path for display.
 */
export function getActiveConfigPath(): string {
	if (_activeConfigPath) return _activeConfigPath;
	const basePath = getBaseConfigPath();
	const sessionPath = _activeSessionId
		? getSessionConfigPath(_activeSessionId)
		: null;
	return sessionPath && existsSync(sessionPath) ? sessionPath : basePath;
}

// ── Profile helpers ─────────────────────────────────────────────

/**
 * Get the currently active profile.
 */
export function getActiveProfile(): CompactionProfile {
	const config = loadConfig();
	const profile = config.profiles[config.activeProfileId];
	if (profile) return profile;

	const firstKey = Object.keys(config.profiles)[0];
	if (firstKey) return config.profiles[firstKey];

	const defaultProfile = createDefaultConfig().profiles.default;
	config.profiles.default = defaultProfile;
	config.activeProfileId = "default";
	saveConfig(config);
	return defaultProfile;
}

/**
 * Set the active profile by ID. Returns false if the profile doesn't exist.
 */
export function setActiveProfile(profileId: string): boolean {
	const config = loadConfig();
	if (!config.profiles[profileId]) return false;
	config.activeProfileId = profileId;
	return saveConfig(config);
}

/**
 * Upsert a profile (update only — no create).
 */
export function upsertProfile(profile: CompactionProfile): boolean {
	const config = loadConfig();
	config.profiles[profile.id] = profile;
	return saveConfig(config);
}

/**
 * Delete a profile by ID. Cannot delete the last remaining profile.
 */
export function deleteProfile(profileId: string): boolean {
	const config = loadConfig();
	const keys = Object.keys(config.profiles);
	if (keys.length <= 1) return false;
	if (!config.profiles[profileId]) return false;

	delete config.profiles[profileId];
	if (config.activeProfileId === profileId) {
		config.activeProfileId = keys.find((k) => k !== profileId) ?? keys[0];
	}
	return saveConfig(config);
}
