/**
 * sync.ts — 同步编排器
 *
 * 职责：
 *   1. syncFiles()：用 ConflictResolver 逐个文件做 push/pull/merge 决策
 *   2. applyProjectMatch()：用 ProjectMatcher 发现同一项目的其他机器会话
 *   3. run()：组合上述两步，最终一次 provider.push() 保证原子性
 *
 * 注入 seam：
 *   - ConflictResolver（默认 MtimeResolver）
 *   - Merger（可选，处理 merge action）
 *   - ProjectMatcher（可选，默认 SuffixAndGitMatcher）
 */

import { copyFile, mkdir, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CloudSessionsConfig, ProjectMatchConfig } from './config.js';
import { createProvider, type SyncProvider } from './providers/index.js';
import { listLocalSessionsForCwd, sessionsRoot } from './sessions.js';
import { getEncodedCwd } from './project-match.js';
import {
	type ConflictResolver,
	type Merger,
	type FileState as ReconcileFileState,
	MtimeResolver,
} from './reconcile.js';
import type { ProjectMatcher } from './project-match.js';
import { createLogger } from '@zenone/pi-logger';

const log = createLogger('pi-cloud-sessions:sync');

export interface SyncResult {
	pulled: string[];
	pushed: string[];
	unchanged: number;
}

/** 扩展的本地文件状态 — 包含绝对路径以便文件操作 */
interface LocalState extends ReconcileFileState {
	absolutePath: string;
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
	private readonly resolver: ConflictResolver;
	private readonly merger: Merger | null;
	private readonly projectMatcher: ProjectMatcher | null;

	constructor(
		config: CloudSessionsConfig,
		opts?: {
			resolver?: ConflictResolver;
			merger?: Merger;
			projectMatcher?: ProjectMatcher;
		},
	) {
		this.provider = createProvider(config);
		this.machineId = config.machineId;
		this.resolver = opts?.resolver ?? new MtimeResolver();
		this.merger = opts?.merger ?? null;
		this.projectMatcher = opts?.projectMatcher ?? null;
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

		// 1. 文件级同步（逐个冲突解决）
		const result = await this.syncFiles(local, remote);

		// 2. 项目匹配（同一项目的其他机器会话）
		if (pm) await this.applyProjectMatch(pm, result, remote);

		// 3. 一次原子推送
		if (result.pushed.length > 0) {
			const message = `sync from ${this.machineId}: ${result.pushed.length} session(s) @ ${new Date().toISOString()}`;
			await this.provider.push(message);
		}

		return result;
	}

	// ── 文件级同步 ────────────────────────────────────────────────────

	private async syncFiles(
		local: Array<{ relativePath: string; absolutePath: string; hash: string; mtimeMs: number }>,
		remote: Array<{ relativePath: string; hash: string; mtimeMs: number }>,
	): Promise<SyncResult> {
		const localByPath = new Map<string, LocalState>();
		for (const f of local) {
			localByPath.set(f.relativePath, {
				hash: f.hash,
				mtimeMs: f.mtimeMs,
				absolutePath: f.absolutePath,
			});
		}
		const remoteByPath = new Map<string, ReconcileFileState>();
		for (const f of remote) {
			remoteByPath.set(f.relativePath, { hash: f.hash, mtimeMs: f.mtimeMs });
		}

		const allPaths = new Set<string>([...localByPath.keys(), ...remoteByPath.keys()]);
		const result: SyncResult = { pulled: [], pushed: [], unchanged: 0 };

		for (const path of allPaths) {
			const l = localByPath.get(path) ?? null;
			const r = remoteByPath.get(path) ?? null;
			const resolution = this.resolver.resolve(l, r);

			switch (resolution.action) {
				case 'push_local':
					if (l) {
						await this.provider.stageFromLocal(path, l.absolutePath);
						result.pushed.push(path);
					}
					break;

				case 'pull_remote':
					await copyRemoteToLocal(this.provider.mirrorPath(path), path);
					result.pulled.push(path);
					break;

				case 'merge':
					await this.handleMerge(path, l, r, result);
					break;

				case 'skip':
					result.unchanged += 1;
					break;
			}
		}

		return result;
	}

	// ── Merge 处理 ────────────────────────────────────────────────────

	private async handleMerge(
		path: string,
		l: LocalState | null,
		r: ReconcileFileState | null,
		result: SyncResult,
	): Promise<void> {
		if (!this.merger || !l || !r) {
			// No merger configured or missing one side:
			//   - remote exists → fall back to pull_remote
			//   - only local exists → count as unchanged (nothing to merge with)
			if (r) {
				await copyRemoteToLocal(this.provider.mirrorPath(path), path);
				result.pulled.push(path);
			} else {
				result.unchanged += 1;
			}
			return;
		}

		const mergedContent = await this.merger.merge(
			l.absolutePath,
			this.provider.mirrorPath(path),
		);

		// Write merged content locally
		const destPath = join(sessionsRoot(), path);
		await mkdir(dirname(destPath), { recursive: true });
		await writeFile(destPath, mergedContent);
		await this.provider.stageFromLocal(path, destPath);
		result.pushed.push(path);
	}

	// ── 项目匹配 ──────────────────────────────────────────────────────

	private async applyProjectMatch(
		pm: ProjectMatchConfig,
		result: SyncResult,
		remote: Array<{ relativePath: string }>,
	): Promise<void> {
		if (!pm.suffixSegments && !pm.gitRemote) return;

		const remoteByPath = new Set(remote.map((f) => f.relativePath));

		let matchResult: { copied: number; fromDirs: string[]; mapUpdated: boolean };

		if (this.projectMatcher) {
			matchResult = await this.projectMatcher.match(
				pm,
				this.machineId,
				sessionsRoot(),
				this.provider.rootDir(),
			);
		} else {
			// Fallback: lazy-import for backward compat
			const { mergeMatchingSessions } = await import('./project-match.js');
			matchResult = await mergeMatchingSessions(
				pm,
				this.machineId,
				sessionsRoot(),
				this.provider.rootDir(),
			);
		}

		if (matchResult.copied > 0) {
			// Stage newly copied sessions into the mirror so they get pushed.
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
}
