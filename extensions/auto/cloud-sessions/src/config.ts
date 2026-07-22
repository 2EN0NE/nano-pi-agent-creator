import { execSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@zenone/pi-logger';
import { resolveConfigPaths } from '@zenone/pi-config';

const log = createLogger('pi-cloud-sessions');

export type ProviderKind = 'git' | 'icloud';

export interface GitProviderConfig {
	repo: string;
	branch: string;
	remoteName: string;
}

export interface IcloudProviderConfig {
	dir: string;
}

export interface ProjectMatchConfig {
	/** Match session directories by the last N dash-delimited path segments. */
	suffixSegments?: number;
	/** Match by git remote "origin" URL (requires git, stores a `.project-map.json` in the cloud mirror). */
	gitRemote?: boolean;
}

export interface CloudSessionsConfig {
	provider: ProviderKind;
	autoPush: boolean;
	pullOnStart: boolean;
	pushDebounceMs: number;
	pollIntervalMs: number;
	machineId: string;
	git: GitProviderConfig;
	icloud: IcloudProviderConfig;
}

function expandTilde(value: string): string {
	if (value === '~') return homedir();
	if (value.startsWith('~/')) return join(homedir(), value.slice(2));
	return value;
}

/** User-level config path via @zenone/pi-config standard. */
const PLUGIN_NAME = 'cloud-sessions';

/** Directory for per-extension persistent data (`~/.pi/agent/extensions-data/cloud-sessions/`). */
function extensionsDataDir(): string {
	return resolveConfigPaths(PLUGIN_NAME).userDir;
}

/** Path to the project-match config file. */
export function projectMatchConfigPath(): string {
	return join(extensionsDataDir(), 'project-match.json');
}

/** Load project-match configuration from `extensions-data/cloud-sessions/project-match.json`. */
export async function loadProjectMatchConfig(): Promise<ProjectMatchConfig> {
	const path = projectMatchConfigPath();
	try {
		const content = await readFile(path, 'utf-8');
		const parsed = JSON.parse(content) as ProjectMatchConfig;
		return {
			suffixSegments: typeof parsed.suffixSegments === 'number' ? parsed.suffixSegments : 0,
			gitRemote: parsed.gitRemote === true,
		};
	} catch (err) {
		const nodeCode = (err as NodeJS.ErrnoException).code;
		if (nodeCode !== 'ENOENT') {
			log.warn('failed to parse %s, using defaults: %s', path, (err as Error).message ?? err);
		}
		return { suffixSegments: 0, gitRemote: false };
	}
}

function defaultIcloudDir(): string {
	return join(homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'pi-sessions');
}

function defaultMachineId(): string {
	if (process.env.PI_CLOUD_SESSIONS_MACHINE_ID) return process.env.PI_CLOUD_SESSIONS_MACHINE_ID;
	if (process.env.HOSTNAME) return process.env.HOSTNAME;
	if (process.env.HOST) return process.env.HOST;
	try {
		return execSync('hostname -s', { encoding: 'utf-8' }).trim();
	} catch {
		/* continue */
	}
	try {
		return execSync('scutil --get ComputerName', { encoding: 'utf-8' })
			.trim()
			.replace(/\s+/g, '-');
	} catch {
		/* continue */
	}
	return 'unknown-machine';
}

interface RawConfig {
	provider?: string;
	autoPush?: boolean;
	pullOnStart?: boolean;
	pushDebounceMs?: number;
	pollIntervalMs?: number;
	machineId?: string;
	git?: Partial<GitProviderConfig>;
	icloud?: Partial<IcloudProviderConfig>;
}

async function readRawConfig(): Promise<RawConfig> {
	const paths = resolveConfigPaths(PLUGIN_NAME);
	if (!existsSync(paths.userFile)) return {};
	try {
		return JSON.parse(await readFile(paths.userFile, 'utf-8')) as RawConfig;
	} catch (err) {
		log.warn(
			'failed to parse config file at %s, using defaults: %s',
			paths.userFile,
			(err as Error).message ?? err,
		);
		return {};
	}
}

function resolveProvider(raw: RawConfig): ProviderKind {
	const value = process.env.PI_CLOUD_SESSIONS_PROVIDER || raw.provider;
	return value === 'icloud' ? 'icloud' : 'git';
}

function asBool(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined) return fallback;
	return value !== '0' && value.toLowerCase() !== 'false';
}

function numberFrom(
	value: string | undefined,
	fileValue: number | undefined,
	fallback: number,
): number {
	if (value !== undefined && value.trim() !== '') {
		const n = Number(value);
		if (Number.isFinite(n)) return n;
	}
	if (typeof fileValue === 'number' && Number.isFinite(fileValue)) return fileValue;
	return fallback;
}

export async function loadConfig(): Promise<CloudSessionsConfig> {
	const raw = await readRawConfig();

	return {
		provider: resolveProvider(raw),
		autoPush: asBool(process.env.PI_CLOUD_SESSIONS_AUTO_PUSH, raw.autoPush ?? true),
		pullOnStart: asBool(process.env.PI_CLOUD_SESSIONS_PULL_ON_START, raw.pullOnStart ?? true),
		pushDebounceMs: numberFrom(
			process.env.PI_CLOUD_SESSIONS_DEBOUNCE_MS,
			raw.pushDebounceMs,
			4000,
		),
		pollIntervalMs: numberFrom(
			process.env.PI_CLOUD_SESSIONS_POLL_MS,
			raw.pollIntervalMs,
			60000,
		),
		machineId: process.env.PI_CLOUD_SESSIONS_MACHINE_ID || raw.machineId || defaultMachineId(),
		git: {
			repo: process.env.PI_CLOUD_SESSIONS_GIT_REPO || raw.git?.repo || '',
			branch: process.env.PI_CLOUD_SESSIONS_GIT_BRANCH || raw.git?.branch || 'main',
			remoteName: raw.git?.remoteName || 'origin',
		},
		icloud: {
			dir: expandTilde(
				process.env.PI_CLOUD_SESSIONS_ICLOUD_DIR || raw.icloud?.dir || defaultIcloudDir(),
			),
		},
	};
}

export async function readRawConfigFile(): Promise<Record<string, unknown>> {
	return readRawConfig() as Promise<Record<string, unknown>>;
}

export function isProviderConfigured(config: CloudSessionsConfig): boolean {
	if (config.provider === 'git') return config.git.repo.length > 0;
	return config.icloud.dir.length > 0;
}

export function configFilePath(): string {
	return resolveConfigPaths(PLUGIN_NAME).userFile;
}

export function configDir(): string {
	return resolveConfigPaths(PLUGIN_NAME).userDir;
}
