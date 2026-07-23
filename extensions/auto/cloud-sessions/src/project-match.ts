import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdir, readdir, copyFile, stat as fsStat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createLogger } from '@zenone/pi-logger';
import type { ProjectMatchConfig } from './config.js';

const log = createLogger('pi-cloud-sessions:project-match');
const execFileAsync = promisify(execFile);

/**
 * Encode an absolute filesystem path to Pi's session-directory format.
 *
 * Pi encodes the cwd by stripping the leading `/` and replacing every `/`
 * with `-`, then wrapping in `--`.  Example:
 *   /home/user/Projects/my-app  →  --home-user-Projects-my-app--
 */
export function encodeCwd(absolutePath: string): string {
	const normalized = absolutePath.replace(/\/$/, '');
	const withoutRoot = normalized.replace(/^\//, '');
	return '--' + withoutRoot.replace(/\//g, '-') + '--';
}

/** Return the Pi-encoded name of the current working directory. */
export function getEncodedCwd(): string {
	return encodeCwd(process.cwd());
}

/** Detect the current project's git remote "origin" URL (or null). */
export async function getGitRemoteUrl(): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
			timeout: 5000,
			encoding: 'utf-8',
		});
		const url = stdout.trim();
		if (!url) return null;
		log.debug('git remote detected: %s', url);
		return url;
	} catch (err) {
		log.debug('failed to detect git remote (non-fatal): %s', (err as Error).message ?? err);
		return null;
	}
}

/** Normalise a git remote URL for comparison (strip trailing .git, lowercase). */
export function normalizeGitUrl(url: string): string {
	return url.replace(/\.git$/, '').toLowerCase();
}

// ─── Project map ──────────────────────────────────────────────────────────

export interface ProjectMapEntry {
	gitRemote: string;
	encodedCwd: string;
	machineId: string;
	lastSeen: string;
}

interface ProjectMap {
	version: number;
	entries: ProjectMapEntry[];
}

function projectMapPath(mirrorRoot: string): string {
	return join(mirrorRoot, '.project-map.json');
}

export async function readProjectMap(mirrorRoot: string): Promise<ProjectMap> {
	try {
		const content = await readFile(projectMapPath(mirrorRoot), 'utf-8');
		return JSON.parse(content) as ProjectMap;
	} catch (err) {
		const nodeCode = (err as NodeJS.ErrnoException).code;
		if (nodeCode === 'ENOENT') {
			// Fresh state — no project map exists yet, return default
			return { version: 1, entries: [] };
		}
		log.warn(
			'failed to read/parse %s, resetting to empty: %s',
			projectMapPath(mirrorRoot),
			(err as Error).message ?? err,
		);
		return { version: 1, entries: [] };
	}
}

export async function writeProjectMap(mirrorRoot: string, map: ProjectMap): Promise<void> {
	await writeFile(projectMapPath(mirrorRoot), JSON.stringify(map, null, 2));
}

// ─── Matching logic ────────────────────────────────────────────────────────

/**
 * Match two Pi-encoded directory names by the last `segments` path components.
 *
 * @returns true if the last `segments` dash-delimited parts are equal.
 *
 * ⚠️ Limitation: because `/` in the original path maps to `-` in the encoded
 * form, a path component that naturally contains a hyphen (e.g. `my-project`)
 * will be split into multiple segments.  For typical project paths without
 * hyphens this works reliably.
 */
export function matchBySuffix(encodedCwd: string, dirName: string, segments: number): boolean {
	if (encodedCwd === dirName) return true;

	const strip = (s: string) => s.replace(/^--|--$/g, '');
	const currentParts = strip(encodedCwd).split('-');
	const dirParts = strip(dirName).split('-');

	if (currentParts.length < segments || dirParts.length < segments) {
		return false;
	}

	const currentSuffix = currentParts.slice(-segments);
	const dirSuffix = dirParts.slice(-segments);

	return currentSuffix.every((part, i) => part === dirSuffix[i]);
}

// ─── ProjectMatcher 接口 ───────────────────────────────────────────────────

/**
 * 从同步镜像中查找同一项目的其他机器目录，复制匹配会话到当前 cwd 目录。
 */
export interface ProjectMatcher {
	match(
		config: ProjectMatchConfig,
		machineId: string,
		sessionsRoot: string,
		mirrorRoot: string,
	): Promise<MergeResult>;
}

/**
 * SuffixAndGitMatcher — 默认 ProjectMatcher 实现。
 * 通过路径后缀匹配 + git remote URL 匹配查找同一项目的其他机器目录。
 */
export class SuffixAndGitMatcher implements ProjectMatcher {
	async match(
		config: ProjectMatchConfig,
		machineId: string,
		sessionsRoot: string,
		mirrorRoot: string,
	): Promise<MergeResult> {
		return mergeMatchingSessions(config, machineId, sessionsRoot, mirrorRoot);
	}
}

// ─── Merge ─────────────────────────────────────────────────────────────────

export interface MergeResult {
	copied: number;
	fromDirs: string[];
	mapUpdated: boolean;
}

/**
 * Scan every session directory in `sessionsRoot` and copy session files from
 * directories that match the current project (by suffix or git-remote) into
 * the current cwd's own session directory.
 *
 * When git-remote matching is enabled the project map (`.project-map.json`)
 * stored inside `mirrorRoot` is used both as a lookup table and as a
 * write-back cache so that other machines see this machine's cwd.
 */
export async function mergeMatchingSessions(
	projectMatch: ProjectMatchConfig,
	machineId: string,
	sessionsRoot: string,
	mirrorRoot: string,
): Promise<MergeResult> {
	const pm = projectMatch;
	if (!pm || (!pm.suffixSegments && !pm.gitRemote)) {
		return { copied: 0, fromDirs: [], mapUpdated: false };
	}

	const encodedCwd = getEncodedCwd();
	const currentDir = join(sessionsRoot, encodedCwd);
	const matchedDirs: string[] = [];
	let mapUpdated = false;

	// ── 1. Git remote matching ──────────────────────────────────────────
	const currentGitRemote = pm.gitRemote ? await getGitRemoteUrl() : null;
	if (currentGitRemote) {
		const normalizedCurrent = normalizeGitUrl(currentGitRemote);
		const map = await readProjectMap(mirrorRoot);

		for (const entry of map.entries) {
			if (
				normalizeGitUrl(entry.gitRemote) === normalizedCurrent &&
				entry.encodedCwd !== encodedCwd
			) {
				if (!matchedDirs.includes(entry.encodedCwd)) {
					log.info('git-remote match: %s → matches current project', entry.encodedCwd);
					matchedDirs.push(entry.encodedCwd);
				}
			}
		}

		// Write-back: record this machine's cwd if not already present
		const alreadyKnown = map.entries.some(
			(e) =>
				e.encodedCwd === encodedCwd && normalizeGitUrl(e.gitRemote) === normalizedCurrent,
		);
		if (!alreadyKnown) {
			log.info(
				'registering cwd %s in project-map for remote %s',
				encodedCwd,
				currentGitRemote,
			);
			map.entries.push({
				gitRemote: currentGitRemote,
				encodedCwd,
				machineId,
				lastSeen: new Date().toISOString(),
			});
			await writeProjectMap(mirrorRoot, map);
			mapUpdated = true;
		}
	}

	// ── 2. Suffix matching ──────────────────────────────────────────────
	if (pm.suffixSegments && pm.suffixSegments > 0) {
		let topEntries: string[];
		try {
			topEntries = await readdir(sessionsRoot);
		} catch {
			topEntries = [];
		}
		for (const name of topEntries) {
			if (!name.startsWith('--') || !name.endsWith('--')) continue;
			if (name === encodedCwd) continue;
			if (matchedDirs.includes(name)) continue;
			if (matchBySuffix(encodedCwd, name, pm.suffixSegments)) {
				log.debug('suffix match: %s (last %d segments)', name, pm.suffixSegments);
				matchedDirs.push(name);
			}
		}
	}

	// ── 3. Copy session files ───────────────────────────────────────────
	let copied = 0;
	await mkdir(currentDir, { recursive: true });

	for (const dirName of matchedDirs) {
		const sourceDir = join(sessionsRoot, dirName);
		let files: string[];
		try {
			files = await readdir(sourceDir);
		} catch {
			log.debug('source dir vanished during merge: %s', sourceDir);
			continue;
		}

		for (const file of files) {
			if (!file.endsWith('.jsonl')) continue;
			const src = join(sourceDir, file);
			const dst = join(currentDir, file);

			if (existsSync(dst)) {
				const [srcStat, dstStat] = await Promise.all([
					fsStat(src).catch(() => null),
					fsStat(dst).catch(() => null),
				]);
				if (srcStat && dstStat && srcStat.mtimeMs <= dstStat.mtimeMs) {
					continue;
				}
			}

			try {
				await copyFile(src, dst);
				copied++;
			} catch (err) {
				log.debug('failed to copy session %s: %s', file, (err as Error).message ?? err);
			}
		}
	}

	if (copied > 0) {
		log.info(
			'project-match: copied %d session(s) from %d matching dir(s)',
			copied,
			matchedDirs.length,
		);
	}
	if (matchedDirs.length > 0 && copied === 0) {
		log.debug(
			'project-match: %d matching dir(s) found but no new files to copy',
			matchedDirs.length,
		);
	}

	return { copied, fromDirs: matchedDirs, mapUpdated };
}
