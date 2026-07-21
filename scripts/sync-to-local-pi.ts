#!/usr/bin/env node

/**
 * sync-to-local-pi.ts — Profile-driven sync tool for pi.dev resources.
 *
 * Reads a YAML config (sync-profiles.yaml), selects a profile, and syncs
 * the specified extensions/skills/themes/prompts from the project source
 * directories to a target directory (e.g. .pi/ or ~/.pi/agent/).
 *
 * Features:
 *  - Config-driven profiles (YAML, project + global merge)
 *  - Selective include with per-type exclude support
 *  - Incremental sync (mtime + size comparison)
 *  - Automatic npm install detection for packages with dependencies
 *  - Append log with timestamps
 *  - Dry-run mode
 *
 * Usage:
 *   npx tsx scripts/sync-to-local-pi.ts [options]
 *
 * Options:
 *   --profile <name>   Sync only the named profile
 *   --all              Sync all defined profiles
 *   --dry-run          Preview only, no writes
 *   --config <path>    Path to YAML config (default: ./scripts/sync-profiles.yaml)
 *   -h, --help         Show help
 */

import {
	readFileSync,
	writeFileSync,
	existsSync,
	mkdirSync,
	statSync,
	cpSync,
	rmSync,
	appendFileSync,
	readdirSync,
	type Dirent,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve, isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execSync, exec } from 'node:child_process';
import * as yaml from 'js-yaml';

// ══════════════════════════════════════════════════════════════════════════════
// Constants
// ══════════════════════════════════════════════════════════════════════════════

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, '..');
const DEFAULT_CONFIG_PATH = join(SCRIPT_DIR, 'sync-profiles.yaml');
const GLOBAL_CONFIG_PATH = join(homedir(), '.pi', 'agent', 'sync-profiles.yaml');
const LOG_FILE = join(SCRIPT_DIR, 'sync-to-local-pi.log');

// Supported resource types (matching pi.dev resource directory names)
const RESOURCE_TYPES = ['extensions', 'skills', 'themes', 'prompts'] as const;
type ResourceType = (typeof RESOURCE_TYPES)[number];

// ══════════════════════════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════════════════════════

interface ProfileConfig {
	description?: string;
	target: string; // target directory (relative to project root or absolute)
	extensions: string[] | '*';
	skills: string[] | '*';
	themes: string[] | '*';
	prompts: string[] | '*';
	exclude?: Partial<Record<ResourceType, string[]>>;
	// Extensions listed in npmBuild are treated as npm-style packages:
	// they get npm install + npm run build, and an index.ts bridge is
	// created pointing to dist/index.js for Pi auto-discovery.
	npmBuild?: string[];
}

interface SyncProfilesConfig {
	profiles: Record<string, ProfileConfig>;
}

interface ResolvedResource {
	type: ResourceType;
	name: string;
	sourcePath: string; // absolute path in source project
	targetPath: string; // absolute path in target directory
	isDirectory: boolean; // true for dir-based extensions, skills, etc.
}

type SyncAction = 'NEW' | 'UPDATE' | 'SKIP';

// (SyncLogEntry type removed — unused; log entries are written directly)

// ══════════════════════════════════════════════════════════════════════════════
// CLI Argument Parsing
// ══════════════════════════════════════════════════════════════════════════════

interface CLIOptions {
	profile: string | null;
	all: boolean;
	dryRun: boolean;
	config: string;
	// Inline mode args
	inline: boolean;
	inlineExtensions: string[];
	inlineSkills: string[];
	inlineThemes: string[];
	inlinePrompts: string[];
	inlineTarget: string | null;
}

function parseArgs(): CLIOptions {
	const args = process.argv.slice(2);
	const opts: CLIOptions = {
		profile: null,
		all: false,
		dryRun: false,
		config: DEFAULT_CONFIG_PATH,
		inline: false,
		inlineExtensions: [],
		inlineSkills: [],
		inlineThemes: [],
		inlinePrompts: [],
		inlineTarget: null,
	};

	for (let i = 0; i < args.length; i++) {
		switch (args[i]) {
			case '--profile':
			case '-p':
				opts.profile = args[++i] ?? null;
				break;
			case '--all':
			case '-a':
				opts.all = true;
				break;
			case '--dry-run':
			case '-n':
				opts.dryRun = true;
				break;
			case '--config':
			case '-c':
				opts.config = args[++i] ?? DEFAULT_CONFIG_PATH;
				break;
			case '--ext':
			case '--extension':
				opts.inline = true;
				opts.inlineExtensions.push(args[++i] ?? '');
				break;
			case '--skill':
				opts.inline = true;
				opts.inlineSkills.push(args[++i] ?? '');
				break;
			case '--theme':
				opts.inline = true;
				opts.inlineThemes.push(args[++i] ?? '');
				break;
			case '--prompt':
				opts.inline = true;
				opts.inlinePrompts.push(args[++i] ?? '');
				break;
			case '--target':
			case '-t':
				opts.inlineTarget = args[++i] ?? null;
				if (opts.inlineTarget) opts.inline = true;
				break;
			case '-h':
			case '--help':
				printHelp();
				process.exit(0);
			default:
				console.error(`Unknown argument: ${args[i]}`);
				printHelp();
				process.exit(1);
		}
	}

	return opts;
}

function printHelp(): void {
	console.log(`Usage: npx tsx scripts/sync-to-local-pi.ts [options]

Profile-driven sync tool for pi.dev resources.

MODES (choose one):
  Profile mode:             --profile <name>  (single)  or  default (all profiles)
  Inline mode:              --ext <name> --target <dir>  (and/or --skill, --theme, --prompt)

Options:
  --profile <name>   -p   Sync only the named profile
  --all              -a   Sync all defined profiles (default when no --profile)
  --dry-run          -n   Preview only, no writes
  --config <path>    -c   Path to YAML config (default: scripts/sync-profiles.yaml)

Inline mode options:
  --ext <name>            Extension name to sync (repeatable)
  --skill <name>          Skill name to sync (repeatable)
  --theme <name>          Theme name to sync (repeatable)
  --prompt <name>         Prompt name to sync (repeatable)
  --target <dir>     -t   Target directory (required in inline mode)

  -h, --help              Show this help

Examples:
  npx tsx scripts/sync-to-local-pi.ts                     # all profiles (default)
  npx tsx scripts/sync-to-local-pi.ts --profile user-install  # single profile
  npx tsx scripts/sync-to-local-pi.ts --dry-run               # preview all profiles
  npx tsx scripts/sync-to-local-pi.ts --ext sandbox --target ./.pi/test
  npx tsx scripts/sync-to-local-pi.ts --ext sandbox --ext pi-logger --target ~/.pi/agent
`);
}

// ══════════════════════════════════════════════════════════════════════════════
// Logging
// ══════════════════════════════════════════════════════════════════════════════

function writeLog(level: 'INFO' | 'WARN' | 'ERROR', message: string): void {
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, '0');
	const offset = -now.getTimezoneOffset();
	const offsetSign = offset >= 0 ? '+' : '-';
	const offsetHours = pad(Math.floor(Math.abs(offset) / 60));
	const offsetMins = pad(Math.abs(offset) % 60);
	const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${String(now.getMilliseconds()).padStart(3, '0')}${offsetSign}${offsetHours}:${offsetMins}`;
	const line = `[${timestamp}] [${level}] ${message}\n`;

	// Always write to log file (create dir if needed)
	try {
		const dir = dirname(LOG_FILE);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		appendFileSync(LOG_FILE, line, 'utf8');
	} catch (err) {
		console.error(`Failed to write log: ${err}`);
	}

	// Also print to console (with color for dry-run/warn/error)
	if (level === 'ERROR') {
		console.error(`  ${level}: ${message}`);
	} else if (level === 'WARN') {
		console.warn(`  ${level}: ${message}`);
	} else if (level === 'INFO') {
		console.log(`  ${level}: ${message}`);
	}
}

// ══════════════════════════════════════════════════════════════════════════════
// Config Loading (project + global merge, project takes precedence)
// ══════════════════════════════════════════════════════════════════════════════

function loadConfig(configPath: string): SyncProfilesConfig {
	let merged: SyncProfilesConfig = { profiles: {} };

	// 1. Load global config (~/.pi/agent/sync-profiles.yaml)
	if (existsSync(GLOBAL_CONFIG_PATH)) {
		try {
			const raw = readFileSync(GLOBAL_CONFIG_PATH, 'utf8');
			const parsed = yaml.load(raw) as SyncProfilesConfig;
			if (parsed?.profiles) {
				merged = parsed;
			}
		} catch (err) {
			console.warn(`Warning: Failed to load global config ${GLOBAL_CONFIG_PATH}: ${err}`);
		}
	}

	// 2. Load project-local config (overrides global)
	if (existsSync(configPath)) {
		try {
			const raw = readFileSync(configPath, 'utf8');
			const parsed = yaml.load(raw) as SyncProfilesConfig;
			if (parsed?.profiles) {
				// Merge: project-local profiles override global ones with the same name
				merged = {
					profiles: { ...merged.profiles, ...parsed.profiles },
				};
			}
		} catch (err) {
			console.error(`Error: Failed to load project config ${configPath}: ${err}`);
			process.exit(1);
		}
	} else {
		console.error(`Error: Config file not found: ${configPath}`);
		process.exit(1);
	}

	return merged;
}

// ══════════════════════════════════════════════════════════════════════════════
// Profile Selection
// ══════════════════════════════════════════════════════════════════════════════

function selectProfiles(
	config: SyncProfilesConfig,
	opts: CLIOptions,
): Array<{ name: string; profile: ProfileConfig }> {
	const profileNames = Object.keys(config.profiles);

	if (profileNames.length === 0) {
		console.error('Error: No profiles defined in config.');
		process.exit(1);
	}

	if (opts.all) {
		return profileNames.map((name) => ({
			name,
			profile: config.profiles[name],
		}));
	}

	if (opts.profile) {
		if (!config.profiles[opts.profile]) {
			console.error(
				`Error: Profile "${opts.profile}" not found. Available: ${profileNames.join(', ')}`,
			);
			process.exit(1);
		}
		return [{ name: opts.profile, profile: config.profiles[opts.profile] }];
	}

	// Default: run all profiles (equivalent to --all)
	return profileNames.map((name) => ({
		name,
		profile: config.profiles[name],
	}));
}

// ══════════════════════════════════════════════════════════════════════════════
// Resource Resolution
// ══════════════════════════════════════════════════════════════════════════════

function expandTargetPath(target: string, projectRoot: string): string {
	if (target.startsWith('~')) {
		return join(homedir(), target.slice(1));
	}
	if (isAbsolute(target)) {
		return target;
	}
	return resolve(projectRoot, target);
}

/**
 * Check if a directory is an npm-style package directory (has package.json with "pi" field).
 */
function isNpmPackageDir(dir: string): boolean {
	const pkgPath = join(dir, 'package.json');
	if (!existsSync(pkgPath)) return false;
	try {
		const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
		return !!(pkg.pi && Array.isArray(pkg.pi.extensions) && pkg.pi.extensions.length > 0);
	} catch {
		return false;
	}
}

/**
 * Recursively scan a directory for extension items (.ts files, directories with index.ts,
 * or npm-package directories with package.json containing "pi" field).
 * Skips node_modules and hidden directories.
 */
function scanExtensionsRecursively(dir: string, depth: number): string[] {
	if (depth > 6) return [];
	const results: string[] = [];
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	for (const entry of entries) {
		// Skip hidden, node_modules, and category directories at top level (tui/, auto/, etc.)
		if (entry.name.startsWith('.')) continue;
		if (entry.name === 'node_modules') continue;

		const fullPath = join(dir, entry.name);

		if (entry.isFile() && entry.name.endsWith('.ts')) {
			results.push(entry.name.slice(0, -3)); // remove .ts
		} else if (entry.isDirectory()) {
			// If it has an index.ts, it's an extension directory
			if (existsSync(join(fullPath, 'index.ts')) || isNpmPackageDir(fullPath)) {
				results.push(entry.name);
			} else {
				// Otherwise recurse into it (it's a category directory like tui/, auto/, etc.)
				results.push(...scanExtensionsRecursively(fullPath, depth + 1));
			}
		}
	}
	return results;
}

/**
 * Recursively scan the skills directory tree for skill directories (dirs with SKILL.md).
 * Supports category subdirectories (development/, research/, etc.) — similar to
 * scanExtensionsRecursively but for directory-based skills.
 */
function scanSkillsRecursively(dir: string, depth: number): string[] {
	if (depth > 6) return [];
	const results: string[] = [];
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	for (const entry of entries) {
		if (entry.name.startsWith('.')) continue;
		if (entry.name === 'node_modules') continue;

		const fullPath = join(dir, entry.name);
		if (!entry.isDirectory()) continue;

		// If it has SKILL.md, it's a skill directory
		if (existsSync(join(fullPath, 'SKILL.md'))) {
			results.push(entry.name);
		} else {
			// Otherwise recurse into it (it's a category directory like development/, research/, etc.)
			results.push(...scanSkillsRecursively(fullPath, depth + 1));
		}
	}
	return results;
}

/**
 * Recursively find an extension by name in the extensions directory tree.
 * Returns { relativePath, isDirectory } or null if not found.
 */
function findExtensionByName(
	name: string,
	extRoot: string,
): { relativePath: string; isDirectory: boolean } | null {
	function search(
		dir: string,
		depth: number,
	): { relativePath: string; isDirectory: boolean } | null {
		if (depth > 6) return null;
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return null;
		}
		for (const entry of entries) {
			if (entry.name.startsWith('.')) continue;
			if (entry.name === 'node_modules') continue;

			const fullPath = join(dir, entry.name);

			// Check if this entry itself is the named extension
			if (entry.isFile() && entry.name === `${name}.ts`) {
				return {
					relativePath: relative(extRoot, fullPath),
					isDirectory: false,
				};
			}
			if (
				entry.isDirectory() &&
				entry.name === name &&
				(existsSync(join(fullPath, 'index.ts')) || isNpmPackageDir(fullPath))
			) {
				return { relativePath: relative(extRoot, fullPath), isDirectory: true };
			}
			// Recurse into subdirectories, but skip directory extensions
			// (directories with index.ts — their internals aren't separate extensions)
			if (
				entry.isDirectory() &&
				!existsSync(join(fullPath, 'index.ts')) &&
				!isNpmPackageDir(fullPath)
			) {
				const result = search(fullPath, depth + 1);
				if (result) return result;
			}
		}
		return null;
	}
	return search(extRoot, 0);
}

/**
 * Resolve a list of resource names in a source directory.
 * Returns the full paths of matching items.
 */
/**
 * Scan the target directory for existing items per resource type.
 * Returns the list of item names (without extension for files) found in target.
 */
function scanTargetExistingItems(type: ResourceType, targetDir: string): string[] {
	const typeDir = join(targetDir, type);
	if (!existsSync(typeDir)) return [];

	const items: string[] = [];
	try {
		const entries = readdirSync(typeDir, { withFileTypes: true });
		for (const entry of entries) {
			const name = entry.name;
			if (name.startsWith('.')) continue;

			if (type === 'extensions') {
				if (entry.isFile() && name.endsWith('.ts')) {
					items.push(name.slice(0, -3));
				} else if (entry.isDirectory() && existsSync(join(typeDir, name, 'index.ts'))) {
					items.push(name);
				}
			} else if (type === 'skills') {
				if (entry.isDirectory() && existsSync(join(typeDir, name, 'SKILL.md'))) {
					items.push(name);
				}
			} else if (type === 'themes') {
				if (entry.isFile() && name.endsWith('.json')) {
					items.push(name.slice(0, -5));
				}
			} else if (type === 'prompts') {
				if (entry.isFile() || entry.isDirectory()) {
					items.push(name);
				}
			}
		}
	} catch {
		return [];
	}
	return items.sort();
}

/**
 * Build a name-to-path index for all extensions by scanning the tree once.
 * Avoids O(n*m) repeated tree walks in findExtensionByName.
 */
function buildExtensionIndex(
	extRoot: string,
): Map<string, { relativePath: string; isDirectory: boolean }> {
	const index = new Map<string, { relativePath: string; isDirectory: boolean }>();

	function scan(dir: string, depth: number) {
		if (depth > 6) return;
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			if (entry.name.startsWith('.')) continue;
			if (entry.name === 'node_modules') continue;
			const fullPath = join(dir, entry.name);

			if (entry.isFile() && entry.name.endsWith('.ts')) {
				const name = entry.name.slice(0, -3);
				if (!index.has(name)) {
					index.set(name, {
						relativePath: relative(extRoot, fullPath),
						isDirectory: false,
					});
				}
			} else if (entry.isDirectory()) {
				if (existsSync(join(fullPath, 'index.ts')) || isNpmPackageDir(fullPath)) {
					if (!index.has(entry.name)) {
						index.set(entry.name, {
							relativePath: relative(extRoot, fullPath),
							isDirectory: true,
						});
					}
				} else {
					scan(fullPath, depth + 1);
				}
			}
		}
	}

	scan(extRoot, 0);
	return index;
}

/**
 * Build a name-to-path index for all skills by scanning the tree once.
 * Avoids O(n*m) repeated tree walks in buildResource.
 */
function buildSkillIndex(
	skillRoot: string,
): Map<string, { relativePath: string; isDirectory: boolean }> {
	const index = new Map<string, { relativePath: string; isDirectory: boolean }>();

	function scan(dir: string, depth: number) {
		if (depth > 6) return;
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			if (entry.name.startsWith('.')) continue;
			if (entry.name === 'node_modules') continue;
			const fullPath = join(dir, entry.name);
			if (!entry.isDirectory()) continue;

			if (existsSync(join(fullPath, 'SKILL.md'))) {
				if (!index.has(entry.name)) {
					index.set(entry.name, {
						relativePath: relative(skillRoot, fullPath),
						isDirectory: true,
					});
				}
			} else {
				scan(fullPath, depth + 1);
			}
		}
	}

	scan(skillRoot, 0);
	return index;
}

function resolveSourceItems(
	type: ResourceType,
	names: string[] | '*',
	exclude: string[] | undefined,
	projectRoot: string,
): string[] {
	const sourceDir = join(projectRoot, type);
	if (!existsSync(sourceDir)) {
		return [];
	}

	// Build list of available items
	const available: string[] = [];

	if (type === 'extensions') {
		// Recursively scan all subdirectories (tui/, auto/, etc.)
		available.push(...scanExtensionsRecursively(sourceDir, 0));
	} else if (type === 'skills') {
		// Recursively scan category subdirectories (development/, research/, etc.)
		available.push(...scanSkillsRecursively(sourceDir, 0));
	} else {
		const entries = readdirSync(sourceDir, { withFileTypes: true });

		for (const entry of entries) {
			const name = entry.name;

			if (type === 'themes') {
				if (entry.isFile() && name.endsWith('.json')) {
					available.push(name.slice(0, -5)); // remove .json
				}
			} else if (type === 'prompts') {
				// Any file or directory in prompts/ dir
				if (entry.isFile() || entry.isDirectory()) {
					available.push(name);
				}
			}
		}
	}

	// Normalize ["*"] to "*" for cleaner wildcard handling
	let effectiveNames = names;
	if (Array.isArray(effectiveNames) && effectiveNames.length === 1 && effectiveNames[0] === '*') {
		effectiveNames = '*';
	}

	// Filter by names list
	let selected: string[];
	if (effectiveNames === '*') {
		selected = [...available];
	} else if (Array.isArray(effectiveNames)) {
		selected = effectiveNames.filter((n) => available.includes(n));
		const missing = effectiveNames.filter((n) => !available.includes(n));
		for (const m of missing) {
			console.warn(`  Warning: ${type} "${m}" not found in ${sourceDir}`);
		}
	} else {
		selected = [];
	}

	// Apply exclude list
	if (exclude && exclude.length > 0) {
		selected = selected.filter((n) => !exclude.includes(n));
	}

	return selected.sort();
}

/**
 * Build a ResolvedResource with source and target paths.
 */
function buildResource(
	type: ResourceType,
	name: string,
	projectRoot: string,
	targetDir: string,
	extIndex?: Map<string, { relativePath: string; isDirectory: boolean }>,
	skillIndex?: Map<string, { relativePath: string; isDirectory: boolean }>,
): ResolvedResource {
	const sourceDir = join(projectRoot, type);
	const targetSubDir = join(targetDir, type);

	let sourcePath: string;
	let targetPath: string;
	let isDirectory = false;

	if (type === 'extensions') {
		if (extIndex) {
			const found = extIndex.get(name);
			if (found) {
				sourcePath = join(sourceDir, found.relativePath);
				targetPath = found.isDirectory
					? join(targetSubDir, name)
					: join(targetSubDir, `${name}.ts`);
				isDirectory = found.isDirectory;
			} else {
				// Fallback
				sourcePath = join(sourceDir, `${name}.ts`);
				targetPath = join(targetSubDir, `${name}.ts`);
				isDirectory = false;
			}
		} else {
			const found = findExtensionByName(name, sourceDir);
			if (found) {
				sourcePath = join(sourceDir, found.relativePath);
				targetPath = found.isDirectory
					? join(targetSubDir, name)
					: join(targetSubDir, `${name}.ts`);
				isDirectory = found.isDirectory;
			} else {
				sourcePath = join(sourceDir, `${name}.ts`);
				targetPath = join(targetSubDir, `${name}.ts`);
				isDirectory = false;
			}
		}
	} else if (type === 'skills') {
		if (skillIndex) {
			const found = skillIndex.get(name);
			if (found) {
				sourcePath = join(sourceDir, found.relativePath);
				targetPath = join(targetSubDir, name);
				isDirectory = true;
			} else {
				// Fallback: flat directory
				sourcePath = join(sourceDir, name);
				targetPath = join(targetSubDir, name);
				isDirectory = true;
			}
		} else {
			sourcePath = join(sourceDir, name);
			targetPath = join(targetSubDir, name);
			isDirectory = true;
		}
	} else if (type === 'themes') {
		sourcePath = join(sourceDir, `${name}.json`);
		targetPath = join(targetSubDir, `${name}.json`);
		isDirectory = false;
	} else if (type === 'prompts') {
		// prompts can be files or directories
		const filePath = join(sourceDir, name);
		if (existsSync(filePath)) {
			sourcePath = filePath;
			targetPath = join(targetSubDir, name);
			isDirectory = statSync(sourcePath).isDirectory();
		} else {
			// Fallback: treat as file
			sourcePath = join(sourceDir, name);
			targetPath = join(targetSubDir, name);
			isDirectory = false;
		}
	} else {
		throw new Error(`Unknown resource type: ${type}`);
	}

	return { type, name, sourcePath, targetPath, isDirectory };
}

/**
 * Resolve all resources to sync for a given profile.
 */
function resolveResources(profile: ProfileConfig, projectRoot: string): ResolvedResource[] {
	const targetDir = expandTargetPath(profile.target, projectRoot);
	const resources: ResolvedResource[] = [];

	// Build index once for O(n*m) tree walks
	const extSourceDir = join(projectRoot, 'extensions');
	const extIndex = existsSync(extSourceDir) ? buildExtensionIndex(extSourceDir) : undefined;
	const skillSourceDir = join(projectRoot, 'skills');
	const skillIndex = existsSync(skillSourceDir) ? buildSkillIndex(skillSourceDir) : undefined;

	for (const type of RESOURCE_TYPES) {
		const names = profile[type]; // string[] | "*"
		const exclude = profile.exclude?.[type];
		const selectedNames = resolveSourceItems(type, names, exclude, projectRoot);

		for (const name of selectedNames) {
			resources.push(buildResource(type, name, projectRoot, targetDir, extIndex, skillIndex));
		}
	}

	return resources;
}

// ══════════════════════════════════════════════════════════════════════════════
// Sync Core — Copy with Incremental Logic
// ══════════════════════════════════════════════════════════════════════════════

interface SyncResult {
	action: SyncAction;
	resource: ResolvedResource;
}

/**
 * Compare a source file to its target by mtime and size.
 * Returns true if the source should be copied (source is newer or different size).
 */
function needsUpdate(sourcePath: string, targetPath: string): boolean {
	if (!existsSync(targetPath)) return true;

	try {
		const srcStat = statSync(sourcePath);
		const tgtStat = statSync(targetPath);

		// Only update if source is newer (mtime) or different size
		const srcMtime = Math.floor(srcStat.mtimeMs / 1000);
		const tgtMtime = Math.floor(tgtStat.mtimeMs / 1000);
		return srcMtime > tgtMtime || srcStat.size !== tgtStat.size;
	} catch (err) {
		console.warn(`Warning: needsUpdate() failed for ${sourcePath}: ${err}`);
		return true;
	}
}

/** Directories to skip when comparing for incremental sync */
const IGNORE_DIRS = new Set(['node_modules', '.git', '.svn', '.hg']);

/**
 * Recursively compare directories for incremental sync.
 * Returns true if any file within differs.
 * Skips node_modules and other generated directories.
 */
function dirNeedsUpdate(sourceDir: string, targetDir: string): boolean {
	if (!existsSync(targetDir)) return true;

	try {
		const srcEntries = readdirSync(sourceDir, { withFileTypes: true });
		for (const entry of srcEntries) {
			// Skip ignored directories (node_modules, .git, etc.)
			if (entry.isDirectory() && IGNORE_DIRS.has(entry.name)) continue;

			const srcPath = join(sourceDir, entry.name);
			const tgtPath = join(targetDir, entry.name);
			if (entry.isDirectory()) {
				if (dirNeedsUpdate(srcPath, tgtPath)) return true;
			} else {
				if (needsUpdate(srcPath, tgtPath)) return true;
			}
		}
		// Also check for files in target that don't exist in source
		const tgtEntries = readdirSync(targetDir, { withFileTypes: true });
		for (const entry of tgtEntries) {
			if (entry.isDirectory() && IGNORE_DIRS.has(entry.name)) continue;
			const srcPath = join(sourceDir, entry.name);
			if (!existsSync(srcPath)) return true; // file deleted from source
		}
	} catch (err) {
		console.warn(`Warning: dirNeedsUpdate() failed for ${sourceDir}: ${err}`);
		return true;
	}

	return false;
}

/**
 * Copy a single file from source to target, creating parent dirs.
 */
function copyFile(sourcePath: string, targetPath: string): void {
	mkdirSync(dirname(targetPath), { recursive: true });
	cpSync(sourcePath, targetPath, { force: true });
}

/**
 * Copy a directory recursively from source to target.
 */
function copyDir(sourceDir: string, targetDir: string): void {
	mkdirSync(targetDir, { recursive: true });

	const entries = readdirSync(sourceDir, { withFileTypes: true });
	for (const entry of entries) {
		// Skip node_modules, .git, etc. to avoid symlink/directory copy errors
		if (entry.isDirectory() && IGNORE_DIRS.has(entry.name)) continue;

		const srcPath = join(sourceDir, entry.name);
		const tgtPath = join(targetDir, entry.name);

		if (entry.isDirectory()) {
			copyDir(srcPath, tgtPath);
		} else {
			copyFile(srcPath, tgtPath);
		}
	}
}

/**
 * Remove target files that no longer exist in the source.
 */
function cleanStaleFiles(sourceDir: string, targetDir: string): string[] {
	const removed: string[] = [];
	if (!existsSync(targetDir)) return removed;

	try {
		const tgtEntries = readdirSync(targetDir, { withFileTypes: true });
		for (const entry of tgtEntries) {
			const srcPath = join(sourceDir, entry.name);
			const tgtPath = join(targetDir, entry.name);

			if (!existsSync(srcPath)) {
				// Stale — remove it
				if (entry.isDirectory()) {
					rmSync(tgtPath, { recursive: true, force: true });
				} else {
					rmSync(tgtPath, { force: true });
				}
				removed.push(tgtPath);
			} else if (entry.isDirectory()) {
				// Recurse into subdirectories
				removed.push(...cleanStaleFiles(srcPath, tgtPath));
			}
		}
	} catch (err) {
		console.warn(`Warning: cleanStaleFiles() failed for ${targetDir}: ${err}`);
	}

	return removed;
}

/**
 * Sync a single resource. Returns the action taken.
 */
function syncResource(
	resource: ResolvedResource,
	dryRun: boolean,
	cleanStale: boolean,
): SyncResult {
	const { sourcePath, targetPath, isDirectory } = resource;

	// Determine if update is needed
	let shouldUpdate: boolean;
	if (isDirectory) {
		shouldUpdate = dirNeedsUpdate(sourcePath, targetPath);
	} else {
		shouldUpdate = needsUpdate(sourcePath, targetPath);
	}

	if (!shouldUpdate && existsSync(targetPath)) {
		return { action: 'SKIP', resource };
	}

	const action: SyncAction = existsSync(targetPath) ? 'UPDATE' : 'NEW';

	if (!dryRun) {
		mkdirSync(dirname(targetPath), { recursive: true });

		if (isDirectory) {
			// Remove old content first to avoid stale files
			if (existsSync(targetPath)) {
				rmSync(targetPath, { recursive: true, force: true });
			}
			copyDir(sourcePath, targetPath);
		} else {
			copyFile(sourcePath, targetPath);
		}

		// Clean stale files in target (for directories)
		if (cleanStale && isDirectory && existsSync(targetPath)) {
			cleanStaleFiles(sourcePath, targetPath);
		}
	}

	return { action, resource };
}

// ══════════════════════════════════════════════════════════════════════════════
// npm install Handling
// ══════════════════════════════════════════════════════════════════════════════

interface NpmInstallResult {
	path: string;
	success: boolean;
	output: string;
}

/**
 * Check if a directory has a package.json with dependencies.
 */
function hasDependencies(dir: string): boolean {
	const pkgPath = join(dir, 'package.json');
	if (!existsSync(pkgPath)) return false;

	try {
		const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
		if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) return true;
		if (pkg.devDependencies && Object.keys(pkg.devDependencies).length > 0) return true;
		if (pkg.peerDependencies && Object.keys(pkg.peerDependencies).length > 0) return true;
		return false;
	} catch {
		return false;
	}
}

/**
 * Scan target extensions directory for local @zenone/* packages (directories with package.json
 * whose name starts with "@zenone/"). These packages are both pi extensions AND npm packages
 * used by other extensions via import.
 */
/**
 * Scan a directory for @zenone/* npm packages (directories with package.json
 * whose name starts with "@zenone/"). Recursively searches subdirectories.
 */
function findZenonePackages(dir: string): Map<string, string> {
	const packages = new Map<string, string>();
	if (!existsSync(dir)) return packages;

	function scan(currentDir: string, depth: number) {
		if (depth > 6) return;
		let entries: Dirent[];
		try {
			entries = readdirSync(currentDir, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			if (entry.name.startsWith('.')) continue;
			if (entry.name === 'node_modules') continue;
			if (!entry.isDirectory()) continue;

			const fullPath = join(currentDir, entry.name);
			const pkgPath = join(fullPath, 'package.json');
			if (!existsSync(pkgPath)) {
				// Recurse into category dirs (auto/, tui/, etc.)
				scan(fullPath, depth + 1);
				continue;
			}

			try {
				const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
				if (pkg.name && typeof pkg.name === 'string' && pkg.name.startsWith('@zenone/')) {
					if (!packages.has(pkg.name)) {
						packages.set(pkg.name, fullPath);
					}
				}
			} catch {
				// Skip invalid package.json
			}
		}
	}

	scan(dir, 0);
	return packages;
}

/**
 * Build the root package.json dependency map for @zenone/* local packages.
 *
 * Scans both the target extensions dir (already-synced packages, relative paths)
 * and the project source extensions dir (all @zenone/* packages, absolute paths).
 * Source extensions not found in the target get absolute-path entries so that
 * npm-style extensions (e.g. ci-watch) can resolve their @zenone/* peer/dev deps
 * even when the dependency package is in a different sync profile.
 *
 * The target-dir entries take priority (keep relative paths for synced packages).
 */
function findLocalPackages(targetDir: string): Map<string, string> {
	const packages = new Map<string, string>();

	// 1. Scan target extensions dir for already-synced packages (relative paths)
	const extDir = join(targetDir, 'extensions');
	if (existsSync(extDir)) {
		let entries: Dirent[];
		try {
			entries = readdirSync(extDir, { withFileTypes: true });
		} catch {
			entries = [];
		}

		for (const entry of entries) {
			if (entry.name.startsWith('.')) continue;
			if (entry.name === 'node_modules') continue;
			if (!entry.isDirectory()) continue;

			const pkgPath = join(extDir, entry.name, 'package.json');
			if (!existsSync(pkgPath)) continue;

			try {
				const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
				if (pkg.name && typeof pkg.name === 'string' && pkg.name.startsWith('@zenone/')) {
					packages.set(pkg.name, `./extensions/${entry.name}`);
				}
			} catch {
				// Skip invalid package.json
			}
		}
	}

	// 2. Scan source extensions dir for any @zenone/* packages not yet in the map.
	//    These get absolute paths so they're resolvable for npm-style extension builds
	//    even when the package belongs to a different sync profile.
	const sourceExtDir = join(PROJECT_ROOT, 'extensions');
	if (existsSync(sourceExtDir)) {
		const sourcePackages = findZenonePackages(sourceExtDir);
		for (const [name, absPath] of sourcePackages) {
			if (!packages.has(name)) {
				packages.set(name, absPath);
			}
		}
	}

	return packages;
}

/**
 * Run npm install in a directory. Returns the result.
 */
function runNpmInstall(dir: string, dryRun: boolean): NpmInstallResult {
	if (dryRun) {
		return {
			path: dir,
			success: true,
			output: '[dry-run] npm install would run here',
		};
	}

	try {
		const output = execSync('npm install', {
			cwd: dir,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
			timeout: 120_000, // 2 minute timeout
		});
		return { path: dir, success: true, output: output.trim() };
	} catch (err: unknown) {
		const error = err as { stdout?: string; stderr?: string; message?: string };
		const msg = error.stderr || error.stdout || error.message || 'unknown error';
		return { path: dir, success: false, output: msg };
	}
}

const execPromise = promisify(exec);

/**
 * Async version of npm install (for parallel execution across extensions).
 */
async function runNpmInstallAsync(dir: string, dryRun: boolean): Promise<NpmInstallResult> {
	if (dryRun) {
		return { path: dir, success: true, output: '[dry-run] npm install would run here' };
	}

	try {
		const { stdout, stderr } = await execPromise('npm install', {
			cwd: dir,
			encoding: 'utf8',
			timeout: 120_000,
		});
		return { path: dir, success: true, output: (stdout + stderr).trim() };
	} catch (err: unknown) {
		const error = err as { stdout?: string; stderr?: string; code?: number; message?: string };
		const msg = (error.stderr || error.stdout || error.message || 'unknown error').toString();
		return { path: dir, success: false, output: msg };
	}
}

/**
 * Check whether npm install can be skipped because node_modules is already up-to-date.
 * Returns true if node_modules/ exists and is newer than package.json
 * (and package-lock.json if present).
 */
function shouldSkipNpmInstall(dir: string): boolean {
	const pkgPath = join(dir, 'package.json');
	const nodeModulesPath = join(dir, 'node_modules');
	if (!existsSync(nodeModulesPath)) return false;
	if (!existsSync(pkgPath)) return true;
	try {
		const pkgStat = statSync(pkgPath);
		const nmStat = statSync(nodeModulesPath);
		const lockPath = join(dir, 'package-lock.json');
		if (existsSync(lockPath)) {
			const lockStat = statSync(lockPath);
			return nmStat.mtimeMs >= Math.max(pkgStat.mtimeMs, lockStat.mtimeMs);
		}
		return nmStat.mtimeMs >= pkgStat.mtimeMs;
	} catch {
		return false;
	}
}

// ══════════════════════════════════════════════════════════════════════════════
// Profile Processing (shared by config mode and inline mode)
// ══════════════════════════════════════════════════════════════════════════════

interface ProfileSummary {
	name: string;
	target: string;
	resources: number;
	newItems: Record<ResourceType, string[]>;
	updatedItems: Record<ResourceType, string[]>;
	staleItems: Record<ResourceType, string[]>;
	extensionNames: string[];
	npmCount: number;
	npmSkippedCount: number;
	npmFailCount: number;
	npmBuildCount: number;
	npmBuildFailCount: number;
}

/**
 * Sync a single profile: resolve resources, copy files, run npm install, log results.
 */

async function processProfile(
	name: string,
	profile: ProfileConfig,
	opts: CLIOptions,
): Promise<ProfileSummary> {
	writeLog('INFO', `Profile "${name}" started`);

	const targetDir = expandTargetPath(profile.target, PROJECT_ROOT);
	const resources = resolveResources(profile, PROJECT_ROOT);

	if (resources.length === 0) {
		console.log(`  📦 [${name}] No resources to sync.`);
		writeLog('INFO', `Profile "${name}" completed (0 resources)`);
		return {
			name,
			target: expandTargetPath(profile.target, PROJECT_ROOT),
			resources: 0,
			newItems: {} as Record<ResourceType, string[]>,
			updatedItems: {} as Record<ResourceType, string[]>,
			staleItems: {} as Record<ResourceType, string[]>,
			extensionNames: [],
			npmCount: 0,
			npmSkippedCount: 0,
			npmFailCount: 0,
			npmBuildCount: 0,
			npmBuildFailCount: 0,
		};
	}

	console.log(`  📦 [${name}] ${profile.description || ''}`);
	console.log(`      Target: ${targetDir}`);
	console.log(`      Resources: ${resources.length} total`);
	console.log();

	// Group by type for display
	const byType: Record<string, ResolvedResource[]> = {};
	for (const r of resources) {
		if (!byType[r.type]) byType[r.type] = [];
		byType[r.type].push(r);
	}
	for (const [type, items] of Object.entries(byType)) {
		console.log(`      ${type}/ (${items.length}): ${items.map((i) => i.name).join(', ')}`);
	}
	console.log();

	// ── Scan target for existing items (to detect stale/deletion candidates) ──
	const targetExistingNames: Record<ResourceType, string[]> = {
		extensions: [],
		skills: [],
		themes: [],
		prompts: [],
	};
	for (const t of RESOURCE_TYPES) {
		targetExistingNames[t] = scanTargetExistingItems(t, targetDir);
	}
	const sourceNames: Record<ResourceType, Set<string>> = {
		extensions: new Set(),
		skills: new Set(),
		themes: new Set(),
		prompts: new Set(),
	};
	for (const r of resources) {
		sourceNames[r.type].add(r.name);
	}

	// Sync each resource
	const newItems: Record<ResourceType, string[]> = {
		extensions: [],
		skills: [],
		themes: [],
		prompts: [],
	};
	const updatedItems: Record<ResourceType, string[]> = {
		extensions: [],
		skills: [],
		themes: [],
		prompts: [],
	};
	const skipByType: Record<ResourceType, number> = {
		extensions: 0,
		skills: 0,
		themes: 0,
		prompts: 0,
	};
	const staleDeleted: Record<ResourceType, string[]> = {
		extensions: [],
		skills: [],
		themes: [],
		prompts: [],
	};

	for (const resource of resources) {
		const result = syncResource(resource, opts.dryRun, true);

		const label = `${resource.type}:${resource.name}`;
		const targetRel = relative(PROJECT_ROOT, resource.targetPath);

		switch (result.action) {
			case 'NEW':
				console.log(`    ✅ [NEW] ${label} → ${targetRel}`);
				writeLog('INFO', `[NEW] ${label} → ${resource.targetPath}`);
				newItems[resource.type].push(resource.name);
				break;
			case 'UPDATE':
				console.log(`    🔄 [UPDATE] ${label} → ${targetRel}`);
				writeLog('INFO', `[UPDATE] ${label} → ${resource.targetPath}`);
				updatedItems[resource.type].push(resource.name);
				break;
			case 'SKIP':
				skipByType[resource.type]++;
				break;
		}
	}

	// ── Root-level local package resolution (link @zenone/* packages) ──
	// MUST run BEFORE per-extension npm install so that npm-style extensions
	// (e.g. ci-watch) can resolve @zenone/* peer/dev deps from root node_modules.
	let npmCount = 0;
	let npmFailCount = 0;
	let npmSkippedCount = 0;

	const localPackages = findLocalPackages(targetDir);
	if (localPackages.size > 0) {
		const rootPkgPath = join(targetDir, 'package.json');
		let rootPkg: Record<string, unknown> = {};
		if (existsSync(rootPkgPath)) {
			try {
				rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf8'));
			} catch {
				rootPkg = {};
			}
		}

		rootPkg.private = true;
		rootPkg.type = 'module';
		if (!rootPkg.dependencies) {
			rootPkg.dependencies = {} as Record<string, string>;
		}
		const deps = rootPkg.dependencies as Record<string, string>;

		// Rebuild @zenone/* entries from scratch — remove stale ones, add new ones.
		// Non-@zenone/* entries are preserved (e.g. user-added deps).
		let packagesAdded = 0;
		let packagesRemoved = 0;

		// Phase 1: Remove stale @zenone/* entries that no longer exist as local packages
		for (const depName of Object.keys(deps)) {
			if (depName.startsWith('@zenone/') && !localPackages.has(depName)) {
				delete deps[depName];
				packagesRemoved++;
			}
		}

		// Phase 2: Add new @zenone/* entries from localPackages
		for (const [name, relPath] of localPackages) {
			if (deps[name] !== relPath) {
				deps[name] = relPath;
				packagesAdded++;
			}
		}

		if (packagesAdded > 0 || packagesRemoved > 0) {
			if (!opts.dryRun) {
				writeFileSync(rootPkgPath, JSON.stringify(rootPkg, null, 2) + '\n', 'utf8');
			}
			const parts: string[] = [];
			if (packagesAdded > 0) parts.push(`added ${packagesAdded}`);
			if (packagesRemoved > 0) parts.push(`removed ${packagesRemoved}`);
			console.log(
				`      📝 Updated root package.json (${parts.join(', ')}) — ${localPackages.size} local package(s)`,
			);
			writeLog('INFO', `Updated root package.json at ${rootPkgPath} (${parts.join(', ')})`);
		} else if (existsSync(rootPkgPath)) {
			console.log(
				`      ⏭️  Root package.json up-to-date (${localPackages.size} local package(s))`,
			);
		}

		// Run npm install in target root (creates node_modules symlinks for file: deps)
		const rootPkgChanged = packagesAdded > 0 || packagesRemoved > 0;
		if (!opts.dryRun) {
			if (!rootPkgChanged && shouldSkipNpmInstall(targetDir)) {
				console.log(`      ⏭️  Root node_modules up-to-date, skipping`);
				npmSkippedCount++;
			} else {
				console.log(
					`      ⚙️  Running npm install in ${relative(PROJECT_ROOT, targetDir)}...`,
				);
				writeLog('INFO', `Running npm install in ${targetDir}`);
				const result = runNpmInstall(targetDir, opts.dryRun);
				if (result.success) {
					console.log(
						`      ✅ npm install completed in ${relative(PROJECT_ROOT, targetDir)}`,
					);
					writeLog('INFO', `npm install completed successfully in ${targetDir}`);
					npmCount++;
				} else {
					console.error(
						`      ❌ npm install failed in ${relative(PROJECT_ROOT, targetDir)}`,
					);
					console.error(`         ${result.output.slice(0, 200)}`);
					writeLog(
						'ERROR',
						`npm install failed in ${targetDir}: ${result.output.slice(0, 200)}`,
					);
					npmFailCount++;
				}
			}
		} else {
			console.log(
				`      ⚙️  [dry-run] npm install would run in ${relative(PROJECT_ROOT, targetDir)}`,
			);
		}
	} else {
		console.log(`      ⏭️  No local @zenone/* packages found — skipping root npm install`);
	}

	// ── Per-extension npm install (sequential) ──
	interface NpmInstallTask {
		path: string;
		name: string;
	}

	const npmInstallTasks: NpmInstallTask[] = [];
	for (const resource of resources) {
		const checkPath = resource.isDirectory ? resource.targetPath : dirname(resource.targetPath);

		// Skip npm-style packages (with "pi" field in package.json) – their
		// @zenone/* dependencies are resolved from the root node_modules via
		// the root package.json file: references. Running npm install inside
		// these extensions would fail because @zenone/* packages aren't on npm.
		if (resource.isDirectory && isNpmPackageDir(checkPath)) {
			console.log(
				`      ⏭️  [npm:${resource.name}] npm-style package — deps resolved from root`,
			);
			continue;
		}

		const hasDep = hasDependencies(checkPath);
		if (hasDep && !opts.dryRun) {
			if (shouldSkipNpmInstall(checkPath)) {
				console.log(`      ⏭️  [npm:${resource.name}] node_modules up-to-date, skipping`);
				npmSkippedCount++;
			} else {
				npmInstallTasks.push({ path: checkPath, name: resource.name });
			}
		} else if (hasDep && opts.dryRun) {
			console.log(
				`      ⚙️  [dry-run] npm install would run in ${relative(PROJECT_ROOT, checkPath)}`,
			);
		}
	}

	if (npmInstallTasks.length > 0) {
		console.log(`      ⚙️  Running ${npmInstallTasks.length} npm install(s) sequentially...`);
		writeLog('INFO', `Running ${npmInstallTasks.length} npm install(s) sequentially`);

		for (const task of npmInstallTasks) {
			const result = await runNpmInstallAsync(task.path, opts.dryRun);
			if (result.success) {
				console.log(`      ✅ [npm:${task.name}] completed`);
				writeLog('INFO', `npm install completed in ${task.path}`);
				npmCount++;
			} else {
				console.error(`      ❌ [npm:${task.name}] FAILED`);
				console.error(`         ${result.output.slice(0, 200)}`);
				writeLog(
					'ERROR',
					`npm install failed in ${task.path}: ${result.output.slice(0, 200)}`,
				);
				npmFailCount++;
			}
		}
	}

	// -- npm package extension: bridge creation --
	// Auto-detects extensions with package.json + "pi" field (npm-style packages).
	// Falls back to profile.npmBuild for explicit opt-in.
	let npmBuildCount = 0;
	let npmBuildFailCount = 0;

	const npmBuildNames = new Set(profile.npmBuild ?? []);
	// Also auto-detect: directories with package.json containing "pi" field.
	// This ensures inline mode works without explicit npmBuild config.
	for (const resource of resources) {
		if (resource.type !== 'extensions') continue;
		if (!resource.isDirectory) continue;
		if (npmBuildNames.has(resource.name)) continue;
		if (isNpmPackageDir(resource.sourcePath)) {
			npmBuildNames.add(resource.name);
		}
	}

	if (npmBuildNames.size > 0) {
		for (const resource of resources) {
			if (resource.type !== 'extensions') continue;
			if (!resource.isDirectory) continue;
			if (!npmBuildNames.has(resource.name)) continue;

			const npmDir = resource.targetPath;
			if (!existsSync(npmDir)) {
				if (opts.dryRun) {
					console.log(
						`      🌉  [npm:${resource.name}] bridge index.ts → src/index.ts (dry-run)`,
					);
				}
				continue;
			}

			const bridgePath = join(npmDir, 'index.ts');
			const srcEntry = join(npmDir, 'src', 'index.ts');
			const bridgeContent = `// Auto-generated by sync-to-local-pi - do not edit\nexport { default } from "./src/index.ts";\n`;

			if (opts.dryRun) {
				if (!existsSync(bridgePath)) {
					console.log(
						`      🌉  [npm:${resource.name}] bridge index.ts → src/index.ts (dry-run)`,
					);
				}
				continue;
			}

			if (existsSync(bridgePath)) {
				// Bridge already exists — nothing to do
				continue;
			}

			if (!existsSync(srcEntry)) {
				console.error(
					`      ❌ [npm:${resource.name}] src/index.ts not found in ${npmDir}`,
				);
				writeLog('ERROR', `Bridge failed for ${resource.name}: src/index.ts not found`);
				npmBuildFailCount++;
				continue;
			}

			// Ensure node_modules exists (per-extension npm install may have been
			// skipped for npm-style packages). Check if root node_modules provides
			// the dependencies instead of running a local install that would fail
			// on unresolvable @zenone/* packages.
			if (!existsSync(join(npmDir, 'node_modules'))) {
				const rootNodeModules = join(dirname(dirname(npmDir)), 'node_modules');
				if (existsSync(rootNodeModules)) {
					console.log(
						`      ⏭️  [npm:${resource.name}] using root node_modules — skipping local install`,
					);
				} else {
					console.log(`      ⚙️  [npm:${resource.name}] Running npm install...`);
					const installResult = runNpmInstall(npmDir, false);
					if (!installResult.success) {
						console.error(
							`         ❌ npm install failed: ${installResult.output.slice(0, 200)}`,
						);
						writeLog(
							'ERROR',
							`npm install failed for ${resource.name}: ${installResult.output.slice(0, 200)}`,
						);
						npmBuildFailCount++;
						continue;
					}
				}
			}

			// Create bridge index.ts
			writeFileSync(bridgePath, bridgeContent, 'utf8');
			console.log(`      🌉  [npm:${resource.name}] Created bridge: index.ts → src/index.ts`);
			writeLog('INFO', `Bridge index.ts created for ${resource.name} in ${npmDir}`);
			npmBuildCount++;
		}
	}

	// ── Summary for this profile ──
	const skipTotal = Object.values(skipByType).reduce((a, b) => a + b, 0);
	const newTotal = Object.values(newItems).reduce((a, b) => a + b.length, 0);
	const updatedTotal = Object.values(updatedItems).reduce((a, b) => a + b.length, 0);
	const summaryParts: string[] = [];
	if (newTotal > 0) summaryParts.push(`${newTotal} new`);
	if (updatedTotal > 0) summaryParts.push(`${updatedTotal} updated`);
	if (skipTotal > 0 && opts.dryRun) summaryParts.push(`${skipTotal} would-be-skipped`);
	else if (skipTotal > 0) {
		const byTypeStr = Object.entries(skipByType)
			.filter(([_, c]) => c > 0)
			.map(([t, c]) => `${c} ${t}`)
			.join(', ');
		summaryParts.push(`${skipTotal} skipped (${byTypeStr})`);
	}
	if (npmCount > 0) summaryParts.push(`${npmCount} npm installs`);
	if (npmSkippedCount > 0) summaryParts.push(`${npmSkippedCount} npm installs cached`);
	if (npmFailCount > 0) summaryParts.push(`${npmFailCount} npm installs FAILED`);
	if (npmBuildCount > 0) summaryParts.push(`${npmBuildCount} npm builds`);
	if (npmBuildFailCount > 0) summaryParts.push(`${npmBuildFailCount} npm builds FAILED`);

	const summary = summaryParts.length > 0 ? summaryParts.join(', ') : 'no changes';
	console.log(`\n  ✅ [${name}] Done — ${summary}`);

	// ── Per-category breakdown (NEW / UPDATED / STALE CANDIDATES) ──
	const absTarget = expandTargetPath(profile.target, PROJECT_ROOT);
	let hasStale = false;

	console.log(`\n  🗂️  "${name}" — per-category breakdown:\n`);
	for (const t of RESOURCE_TYPES) {
		const n = newItems[t].length;
		const u = updatedItems[t].length;
		const s = skipByType[t];
		const candidates = targetExistingNames[t].filter((item) => !sourceNames[t].has(item));
		const d = candidates.length;

		const parts: string[] = [];
		if (n > 0) parts.push(`${n} NEW`);
		if (u > 0) parts.push(`${u} UPDATED`);
		if (s > 0) parts.push(`${s} skipped`);
		if (d > 0) parts.push(`${d} deleted`);
		const status = parts.length > 0 ? ` [${parts.join(' | ')}]` : ' [no changes]';

		console.log(`    ${t}/${status}`);

		if (d > 0) {
			hasStale = true;
			for (const c of candidates) {
				let delPath: string;
				if (t === 'extensions') {
					const tsPath = join(absTarget, t, c + '.ts');
					if (existsSync(tsPath)) {
						delPath = tsPath;
					} else {
						delPath = join(absTarget, t, c);
					}
				} else if (t === 'themes') {
					delPath = join(absTarget, t, c + '.json');
				} else {
					delPath = join(absTarget, t, c);
				}

				if (opts.dryRun) {
					console.log(`      ⚰️  [would delete] ${delPath}`);
					staleDeleted[t].push(c);
				} else {
					try {
						if (existsSync(delPath)) {
							const isDir = statSync(delPath).isDirectory();
							if (isDir) {
								rmSync(delPath, { recursive: true, force: true });
							} else {
								rmSync(delPath, { force: true });
							}
							staleDeleted[t].push(c);
							writeLog('INFO', `[DELETE] ${t}:${c} → ${delPath}`);
						}
					} catch (err) {
						console.error(`      ❌ Failed to delete ${delPath}: ${err}`);
						writeLog('ERROR', `Failed to delete ${delPath}: ${err}`);
					}
				}
			}
		}
	}

	if (!hasStale) {
		console.log(`      (no stale items — nothing to clean up)`);
	}
	console.log();

	writeLog('INFO', `Profile "${name}" completed (${resources.length} resources, ${summary})`);

	// Collect stale items per type (actually deleted in non-dry-run mode; would-be-deleted in dry-run mode)
	const staleItems: Record<ResourceType, string[]> = {} as Record<ResourceType, string[]>;
	for (const t of RESOURCE_TYPES) {
		staleItems[t] = staleDeleted[t];
	}

	// Collect extension names for overlap analysis
	const extensionNames: string[] = [];
	for (const r of resources) {
		if (r.type === 'extensions') {
			extensionNames.push(r.name);
		}
	}

	return {
		name,
		target: expandTargetPath(profile.target, PROJECT_ROOT),
		resources: resources.length,
		newItems,
		updatedItems,
		staleItems,
		extensionNames,
		npmCount,
		npmSkippedCount,
		npmFailCount,
		npmBuildCount,
		npmBuildFailCount,
	};
}

// ══════════════════════════════════════════════════════════════════════════════
/**
 * Print a final aggregation table across all profiles, including extension overlap analysis.
 */
function printFinalSummaryTable(
	summaries: ProfileSummary[],
	_profileDescriptors: Array<{ name: string; target: string }>,
): void {
	const mode =
		process.argv.includes('--dry-run') || process.argv.includes('-n') ? ' (dry-run)' : '';
	console.log();
	console.log(`  ${'─'.repeat(58)}`);
	console.log(`   Final Summary${mode}`);
	console.log(`  ${'─'.repeat(58)}`);

	// Table header
	const sep = `  ${'─'.repeat(18)} ${'─'.repeat(9)} ${'─'.repeat(5)} ${'─'.repeat(7)} ${'─'.repeat(7)} ${'─'.repeat(5)}`;
	console.log(
		`  ${'Profile'.padEnd(18)} ${'Resources'.padStart(9)} ${'New'.padStart(5)} ${'Updated'.padStart(7)} ${'Deleted'.padStart(7)} ${'npm'.padStart(5)}`,
	);
	console.log(sep);

	let totalResources = 0;
	let totalNew = 0;
	let totalUpdated = 0;
	let totalStale = 0;
	let totalNpm = 0;

	for (const s of summaries) {
		const n = Object.values(s.newItems).reduce((a, b) => a + b.length, 0);
		const u = Object.values(s.updatedItems).reduce((a, b) => a + b.length, 0);
		const st = Object.values(s.staleItems).reduce((a, b) => a + b.length, 0);
		const npm = s.npmCount + s.npmSkippedCount;

		console.log(
			`  ${s.name.padEnd(18)} ${String(s.resources).padStart(9)} ${String(n).padStart(5)} ${String(u).padStart(7)} ${String(st).padStart(7)} ${String(npm).padStart(5)}`,
		);

		totalResources += s.resources;
		totalNew += n;
		totalUpdated += u;
		totalStale += st;
		totalNpm += npm;
	}

	console.log(sep);
	console.log(
		`  ${'TOTAL'.padEnd(18)} ${String(totalResources).padStart(9)} ${String(totalNew).padStart(5)} ${String(totalUpdated).padStart(7)} ${String(totalStale).padStart(7)} ${String(totalNpm).padStart(5)}`,
	);

	// Extension overlap detection
	const extSets = summaries.map((s) => new Set(s.extensionNames));
	if (extSets.length >= 2) {
		const overlap = [...extSets[0]].filter((name) => extSets.every((set) => set.has(name)));
		console.log();
		if (overlap.length > 0) {
			console.log(
				`  ⚠⃣  Extension overlap: ${overlap.length} extension(s) synced to multiple profiles`,
			);
			const names = overlap.sort();
			if (names.length <= 8) {
				console.log(`      ${names.join(', ')}`);
			} else {
				console.log(
					`      ${names.slice(0, 8).join(', ')} ... and ${names.length - 8} more`,
				);
			}
		} else {
			console.log(`  ✅ No extension overlap between profiles`);
		}
	}

	// Stale items summary
	const allStale: Array<{ profile: string; type: string; item: string }> = [];
	for (const s of summaries) {
		for (const t of ['extensions', 'skills', 'themes', 'prompts'] as const) {
			for (const item of s.staleItems[t]) {
				allStale.push({ profile: s.name, type: t, item });
			}
		}
	}
	if (allStale.length > 0) {
		console.log();
		console.log('  🗑️  Stale items removed:');
		for (const { profile, type, item } of allStale.slice(0, 10)) {
			console.log(`      ${profile}/${type}/${item}`);
		}
		if (allStale.length > 10) {
			console.log(`      ... and ${allStale.length - 10} more`);
		}
	}

	console.log();
}

/**
 * Extract profile name+target descriptors for the summary table.
 */
function descriptors(
	profiles: Array<{ name: string; profile: ProfileConfig }>,
): Array<{ name: string; target: string }> {
	return profiles.map((p) => ({
		name: p.name,
		target: expandTargetPath(p.profile.target, PROJECT_ROOT),
	}));
}

// Main Execution
// ══════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
	const opts = parseArgs();

	console.log(`\n🔧 Pi Sync Tool — Profile-Driven Resource Sync\n`);

	if (opts.dryRun) {
		console.log('  ⚠️  DRY RUN MODE — no files will be written\n');
	}

	// ── Inline mode: build ad-hoc profile from CLI args ─────────────
	if (opts.inline) {
		if (!opts.inlineTarget) {
			console.error('Error: --target is required in inline mode');
			process.exit(1);
		}
		if (
			opts.inlineExtensions.length === 0 &&
			opts.inlineSkills.length === 0 &&
			opts.inlineThemes.length === 0 &&
			opts.inlinePrompts.length === 0
		) {
			console.error(
				'Error: At least one of --ext, --skill, --theme, or --prompt is required in inline mode',
			);
			process.exit(1);
		}

		const inlineProfile: ProfileConfig = {
			description: `Inline sync (${opts.inlineExtensions.length} ext, ${opts.inlineSkills.length} skill, ${opts.inlineThemes.length} theme, ${opts.inlinePrompts.length} prompt)`,
			target: opts.inlineTarget,
			extensions: opts.inlineExtensions.length > 0 ? opts.inlineExtensions : [],
			skills: opts.inlineSkills.length > 0 ? opts.inlineSkills : [],
			themes: opts.inlineThemes.length > 0 ? opts.inlineThemes : [],
			prompts: opts.inlinePrompts.length > 0 ? opts.inlinePrompts : [],
		};

		await processProfile('(inline)', inlineProfile, opts);
		writeLog('INFO', `Inline sync completed (target: ${inlineProfile.target})`);
		console.log(`  ✨ Inline sync done!`);
		console.log(`     Log: ${LOG_FILE}`);
		console.log();
		return;
	}

	// ── Config mode: load profiles from YAML ──────────────────────
	const config = loadConfig(opts.config);
	const profiles = selectProfiles(config, opts);

	console.log(`  Config: ${opts.config}`);

	if (opts.all) {
		console.log(`  Profiles: ALL (${profiles.length} total)`);
	} else {
		console.log(`  Profile: "${profiles[0].name}"`);
	}
	console.log();

	const summaries: ProfileSummary[] = [];
	for (const { name, profile } of profiles) {
		const s = await processProfile(name, profile, opts);
		summaries.push(s);
	}

	printFinalSummaryTable(summaries, descriptors(profiles));

	const totalProfiles = profiles.length;
	const mode = opts.dryRun ? ' (dry run)' : '';
	console.log(`  ✨ All done! ${totalProfiles} profile(s) synced${mode}`);
	console.log(`     Log: ${LOG_FILE}`);
	console.log();
}

main().catch((err) => {
	console.error('Fatal error:', err);
	writeLog('ERROR', `Fatal error: ${err}`);
	process.exit(1);
});
