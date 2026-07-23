import { copyFile, mkdir, readdir, stat, utimes } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CloudSessionsConfig, ProjectMatchConfig } from './config.js';
import { createProvider, type SyncProvider } from './providers/index.js';
import { listLocalSessionsForCwd, sessionsRoot } from './sessions.js';
import { mergeMatchingSessions, getEncodedCwd } from './project-match.js';
import { createLogger } from '@zenone/pi-logger';

const log = createLogger('pi-cloud-sessions:sync');
const MTIME_TOLERANCE_MS = 1500;

export interface SyncResult {
	pulled: string[];
	pushed: string[];
	unchanged: number;
}

interface FileState {
	hash: string;
	mtimeMs: number;
}

async function copyRemoteToLocal(
	remoteAbsolutePath: string,
	localRelativePath: string,
): Promise<void> {
	const dest = join(sessionsRoot(), localRelativePath);
	await mkdir(dirname(dest), { recursive: true });
	await copyFile(remoteAbsolutePath, dest);
	const info = await stat(remoteAbsolutePath);
	await utimes(dest, info.atime, info.mtime);
}

export class Sync {
	private readonly provider: SyncProvider;
	private readonly machineId: string;

	constructor(config: CloudSessionsConfig) {
		this.provider = createProvider(config);
		this.machineId = config.machineId;
	}

	get providerKind(): string {
		return this.provider.kind;
	}

	async run(pm?: ProjectMatchConfig): Promise<SyncResult> {
		await this.provider.ensureReady();
		await this.provider.pull();

		// Only operate on the current cwd's session directory — other projects'
		// sessions should not be pushed or pulled by this machine.
		const cwdPrefix = getEncodedCwd() + '/';
		const local = await listLocalSessionsForCwd(getEncodedCwd());
		const allRemote = await this.provider.listRemote();
		const remote = allRemote.filter((f) => f.relativePath.startsWith(cwdPrefix));

		const localByPath = new Map<string, FileState & { absolutePath: string }>();
		for (const f of local) {
			localByPath.set(f.relativePath, {
				hash: f.hash,
				mtimeMs: f.mtimeMs,
				absolutePath: f.absolutePath,
			});
		}
		const remoteByPath = new Map<string, FileState>();
		for (const f of remote) {
			remoteByPath.set(f.relativePath, { hash: f.hash, mtimeMs: f.mtimeMs });
		}

		const allPaths = new Set<string>([...localByPath.keys(), ...remoteByPath.keys()]);
		const result: SyncResult = { pulled: [], pushed: [], unchanged: 0 };

		for (const path of allPaths) {
			const l = localByPath.get(path);
			const r = remoteByPath.get(path);

			if (l && !r) {
				await this.provider.stageFromLocal(path, l.absolutePath);
				result.pushed.push(path);
				continue;
			}

			if (!l && r) {
				await copyRemoteToLocal(this.provider.mirrorPath(path), path);
				result.pulled.push(path);
				continue;
			}

			if (l && r) {
				if (l.hash === r.hash) {
					result.unchanged += 1;
					continue;
				}
				const delta = l.mtimeMs - r.mtimeMs;
				if (delta > MTIME_TOLERANCE_MS) {
					await this.provider.stageFromLocal(path, l.absolutePath);
					result.pushed.push(path);
				} else if (delta < -MTIME_TOLERANCE_MS) {
					await copyRemoteToLocal(this.provider.mirrorPath(path), path);
					result.pulled.push(path);
				} else if (l.mtimeMs >= r.mtimeMs) {
					await this.provider.stageFromLocal(path, l.absolutePath);
					result.pushed.push(path);
				} else {
					await copyRemoteToLocal(this.provider.mirrorPath(path), path);
					result.pulled.push(path);
				}
			}
		}

		// ── Project matching ──────────────────────────────────────────────
		// Merge sessions from other cwd directories that match the current
		// project (by suffix or git remote) into the current cwd's directory.
		if (pm && (pm.suffixSegments || pm.gitRemote)) {
			const matchResult = await mergeMatchingSessions(
				pm,
				this.machineId,
				sessionsRoot(),
				this.provider.rootDir(),
			);
			if (matchResult.copied > 0) {
				// Stage newly copied sessions into the mirror so they get pushed.
				// Only scan the current cwd's directory instead of the full tree.
				const currentEncoded = getEncodedCwd();
				const currentDir = join(sessionsRoot(), currentEncoded);
				let currentFiles: string[];
				try {
					currentFiles = await readdir(currentDir);
				} catch {
					currentFiles = [];
				}
				for (const file of currentFiles) {
					if (!file.endsWith('.jsonl')) continue;
					const relativePath = `${currentEncoded}/${file}`;
					if (!remoteByPath.has(relativePath)) {
						await this.provider.stageFromLocal(relativePath, join(currentDir, file));
						result.pushed.push(relativePath);
					}
				}
				log.info('project-match staged %d new session(s) for push', matchResult.copied);
			}
			if (matchResult.mapUpdated) {
				log.debug('project-map updated with current machine info');
			}
		}

		if (result.pushed.length > 0) {
			const message = `sync from ${this.machineId}: ${result.pushed.length} session(s) @ ${new Date().toISOString()}`;
			await this.provider.push(message);
		}

		return result;
	}
}
