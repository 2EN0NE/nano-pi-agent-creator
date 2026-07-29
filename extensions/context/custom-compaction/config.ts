/**
 * Settings persistence for custom-compaction extension.
 *
 * Config file precedence (highest first):
 * 1. <config-dir>/<sessionId>.json — per-session overrides (temporary, resets on new session)
 * 2. <config-dir>/config.json       — user-level config (persists across sessions)
 * 3. <project>/.pi/extensions-data/  — project-level config (optional)
 *
 * All files live under:
 *   ~/.pi/agent/extensions-data/custom-compaction/
 *
 * Uses @zenone/pi-config for layered loading (default < user < project < session).
 * Save calls default to 'user' scope so profile edits persist across sessions.
 */

import { createLogger } from '@zenone/pi-logger';
import { createConfigStore, type ConfigStore } from '@zenone/pi-config';
import {
	type CompactionConfig,
	type CompactionProfile,
	createDefaultConfig,
	selectBestProfile,
} from './types.js';

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
	const source = store.getActiveSource();
	const profile = getActiveProfile();
	const profileName = profile?.name ?? 'Default';

	switch (source) {
		case 'session':
			return `${profileName} (session)`;
		case 'project':
			return `${profileName} (project)`;
		case 'user':
			return `${profileName} (user)`;
		default:
			return profileName;
	}
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
 * Save config to disk.
 *
 * @param config  The config object to save.
 * @param scope   Where to save. Default is 'user' (persists across sessions).
 *                Use 'session' for per-session overrides (not persistent).
 *                Use 'project' for project-level config (.pi/extensions-data/).
 */
export function saveConfig(
	config: CompactionConfig,
	scope: 'user' | 'session' | 'project' = 'user',
): boolean {
	return store.save(config, scope);
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

/**
 * Get the stored "active" profile from config.activeProfileId.
 * Pure read — returns undefined if no profile is found.
 *
 * The ConfigStore defaults (createDefaultConfig) ensure at least
 * one 'default' profile always exists, so undefined is an edge case
 * when all profiles were explicitly deleted.
 */
export function getActiveProfile(): CompactionProfile | undefined {
	const config = store.get();
	const profile = config.profiles[config.activeProfileId];
	if (profile) return profile;

	const firstKey = Object.keys(config.profiles)[0];
	if (firstKey) return config.profiles[firstKey];

	return undefined;
}

/**
 * Get the effective profile for the given model spec.
 *
 * Uses model-aware matching: picks the profile whose matchModel best matches
 * the given model spec. Falls back to getActiveProfile() if no match.
 *
 * @param modelSpec  Provider/model string (e.g. "openai/gpt-4o")
 */
export function getEffectiveProfile(modelSpec?: string): CompactionProfile | undefined {
	const config = store.get();
	const best = selectBestProfile(config, modelSpec);
	return best ?? getActiveProfile();
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
