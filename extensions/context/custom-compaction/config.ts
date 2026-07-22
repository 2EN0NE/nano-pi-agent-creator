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
 * Uses @zenone/pi-config for layered loading (default → user → session).
 */

import { createLogger } from '@zenone/pi-logger';
import { createConfigStore, type ConfigStore } from '@zenone/pi-config';
import { type CompactionConfig, type CompactionProfile, createDefaultConfig } from './types.js';

const log = createLogger('custom-compaction:config');

// ── ConfigStore ──────────────────────────────────────────────────
// sessionScoped: 启用 session 级覆盖（<sessionId>.json 优先于 config.json）
// validate: 校验 profiles 并兜底 activeProfileId

const store: ConfigStore<CompactionConfig> = createConfigStore({
	pluginName: 'custom-compaction',
	defaults: createDefaultConfig(),
	sessionScoped: true,
	validate: (raw: unknown): Partial<CompactionConfig> | null => {
		const parsed = raw as CompactionConfig;
		if (!parsed.profiles || typeof parsed.profiles !== 'object') {
			log.warn('Invalid config: missing or invalid profiles field, skipping layer');
			return null;
		}
		if (!parsed.activeProfileId || !parsed.profiles[parsed.activeProfileId]) {
			parsed.activeProfileId = Object.keys(parsed.profiles)[0] ?? 'default';
		}
		return parsed;
	},
});

// ── State query helpers ─────────────────────────────────────────

/**
 * Whether the currently loaded config is session-specific.
 */
export function isSessionConfig(): boolean {
	return store.getActiveSource() === 'session';
}

/**
 * Get the config label for display.
 */
export function getConfigLabel(): string {
	if (isSessionConfig()) return 'session级配置';
	const config = store.get();
	const profile = config.profiles[config.activeProfileId];
	return profile?.name ?? 'Default';
}

// ── Config load / save ──────────────────────────────────────────

/**
 * Set the current session ID and re-resolve the active config.
 * Delegates to store.setSessionId — reloads on next get().
 */
export function setSessionId(sessionId: string): void {
	store.setSessionId(sessionId);
	log.info('Session ID set:', sessionId);
}

/**
 * Load config from disk. Priority: session > user > defaults
 */
export function loadConfig(): CompactionConfig {
	return store.get();
}

/**
 * Save config to disk as a session-specific file (<sessionId>.json).
 * Delegates to store.save with 'session' scope.
 */
export function saveConfig(config: CompactionConfig): boolean {
	return store.save(config, 'session');
}

/**
 * Force-reload config from disk (discard in-memory cache).
 */
export function reloadConfig(): CompactionConfig {
	return store.reload();
}

/**
 * Get the active config path for display.
 */
export function getActiveConfigPath(): string {
	const paths = store.getPaths();
	const source = store.getActiveSource();
	if (source === 'session') {
		// sessionFile is populated by getPaths() when sessionScoped is enabled
		// Fall back to userFile when no session file exists
		return (
			('sessionFile' in paths
				? (paths as { sessionFile?: string }).sessionFile
				: undefined) ?? paths.userFile
		);
	}
	return source === 'project' ? paths.projectFile : paths.userFile;
}

// ── Profile helpers ─────────────────────────────────────────────

export function getActiveProfile(): CompactionProfile {
	const config = store.get();
	const profile = config.profiles[config.activeProfileId];
	if (profile) return profile;

	const firstKey = Object.keys(config.profiles)[0];
	if (firstKey) return config.profiles[firstKey];

	const defaultProfile = createDefaultConfig().profiles.default;
	config.profiles.default = defaultProfile;
	config.activeProfileId = 'default';
	saveConfig(config);
	return defaultProfile;
}

export function setActiveProfile(profileId: string): boolean {
	const config = store.get();
	if (!config.profiles[profileId]) return false;
	config.activeProfileId = profileId;
	return saveConfig(config);
}

export function upsertProfile(profile: CompactionProfile): boolean {
	const config = store.get();
	config.profiles[profile.id] = profile;
	return saveConfig(config);
}

export function deleteProfile(profileId: string): boolean {
	const config = store.get();
	const keys = Object.keys(config.profiles);
	if (keys.length <= 1) return false;
	if (!config.profiles[profileId]) return false;

	delete config.profiles[profileId];
	if (config.activeProfileId === profileId) {
		config.activeProfileId = keys.find((k) => k !== profileId) ?? keys[0];
	}
	return saveConfig(config);
}
