/**
 * Auto-Stage on Exit Extension
 *
 * Automatically stages files that changed during the session when the agent exits.
 * On session start, snapshots the working tree state (dirty files + their SHA-256 hashes).
 * On session shutdown, compares the current state to the snapshot and stages only
 * files whose content actually changed during the session — avoiding staging files
 * that were already dirty before the session started.
 *
 * No commit is created. The user retains full control over commit messages.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createLogger } from '@zenone/pi-logger';

const log = createLogger('auto-stage-on-exit');

/** File-path (absolute) → SHA-256 hex hash of file contents at session start. */
const initialFileHashes = new Map<string, string>();

/**
 * Compute the SHA-256 hex digest of a file's contents.
 * Returns null if the file cannot be read (doesn't exist, permission error, etc.).
 * Expects an absolute path.
 */
async function getFileHash(filePath: string): Promise<string | null> {
	try {
		const content = await readFile(filePath);
		return createHash('sha256').update(content).digest('hex');
	} catch {
		return null;
	}
}

/**
 * Parse `git status --porcelain` output and return the file paths
 * that exist on disk (or can be meaningfully hashed).
 *
 * Excludes files whose working-tree status is "deleted" (` D`, `D `).
 */
function parseDirtyFilePaths(statusOutput: string): string[] {
	const paths: string[] = [];
	for (const line of statusOutput.split('\n')) {
		if (!line || line.length < 3) continue;

		const stagingStatus = line[0];
		const worktreeStatus = line[1];

		// Rename/Copy entries have format: "R  OLD -> NEW"
		if ((stagingStatus === 'R' || stagingStatus === 'C') && line.includes('->')) {
			const arrowIndex = line.indexOf('->');
			const newPath = line.slice(arrowIndex + 2).trim();
			if (newPath) paths.push(newPath);
			continue;
		}

		// Extract the file path after the two status characters
		const filePath = line.slice(3).trim();
		if (!filePath) continue;

		// Skip entries where the working tree deletion marker is set
		// (file no longer exists on disk — nothing to hash or stage)
		if (worktreeStatus === 'D') continue;

		// Skip entries that are only staged deletions
		if (stagingStatus === 'D') continue;

		paths.push(filePath);
	}
	return paths;
}

/**
 * Stage specific files via `git add`.
 * Returns the number of files successfully staged.
 */
async function stageFiles(
	pi: ExtensionAPI,
	files: string[],
	ctx: ExtensionContext,
): Promise<number> {
	if (files.length === 0) return 0;

	const { code } = await pi.exec('git', ['add', '--', ...files]);

	if (ctx.hasUI) {
		if (code === 0) {
			ctx.ui.notify(`已自动暂存 ${files.length} 个会话期间变更的文件`, 'info');
		} else {
			ctx.ui.notify('自动暂存：git add 失败', 'error');
		}
	}

	return code === 0 ? files.length : 0;
}

export default function (pi: ExtensionAPI) {
	// ---------------------------------------------------------------
	// Session start: snapshot the dirty file set and their content hashes
	// ---------------------------------------------------------------
	pi.on('session_start', async (_event, ctx: ExtensionContext) => {
		initialFileHashes.clear();

		const { stdout: status, code } = await pi.exec('git', ['status', '--porcelain'], {
			cwd: ctx.cwd,
		});

		if (code !== 0 || status.trim().length === 0) {
			return; // Not a git repo or clean working tree
		}

		const dirtyFiles = parseDirtyFilePaths(status);
		for (const filePath of dirtyFiles) {
			const absolutePath = path.resolve(ctx.cwd, filePath);
			const hash = await getFileHash(absolutePath);
			if (hash !== null) {
				initialFileHashes.set(absolutePath, hash);
			}
		}
	});

	// ---------------------------------------------------------------
	// Session shutdown: compare current state, stage changed files only
	// ---------------------------------------------------------------
	pi.on('session_shutdown', async (_event, ctx: ExtensionContext) => {
		const ast0 = Date.now();

		if (initialFileHashes.size === 0) {
			log.debug('session_shutdown: no tracked dirty files, skip');
			return;
		}

		const { stdout: status, code } = await pi.exec('git', ['status', '--porcelain'], {
			cwd: ctx.cwd,
		});
		const ast1 = Date.now();
		log.info('auto-stage:timing: git_status=%dms', ast1 - ast0);

		if (code !== 0) {
			return; // Not a git repo (shouldn't happen, but be safe)
		}

		if (status.trim().length === 0) {
			log.debug('session_shutdown: clean working tree, skip');
			return;
		}

		const currentDirtyFiles = parseDirtyFilePaths(status);
		const filesToStage: string[] = [];

		for (const filePath of currentDirtyFiles) {
			const absolutePath = path.resolve(ctx.cwd, filePath);
			const storedHash = initialFileHashes.get(absolutePath);
			const ht0 = Date.now();

			// File was NOT in the initial snapshot → appeared during the session → stage it
			if (storedHash === undefined) {
				// Verify the file exists before staging
				const currentHash = await getFileHash(absolutePath);
				if (currentHash !== null) {
					filesToStage.push(filePath);
				}
				const ht1 = Date.now();
				if (ht1 - ht0 > 10) {
					log.info(
						'auto-stage:timing: hash_check(file=%s, new)=%dms',
						filePath,
						ht1 - ht0,
					);
				}
				continue;
			}

			// File was in the initial snapshot → compare hashes
			const currentHash = await getFileHash(absolutePath);

			const ht1 = Date.now();

			// If the file can't be read now (deleted), skip it
			if (currentHash === null) {
				if (ht1 - ht0 > 10) {
					log.info(
						'auto-stage:timing: hash_check(file=%s, deleted)=%dms',
						filePath,
						ht1 - ht0,
					);
				}
				continue;
			}

			if (ht1 - ht0 > 10) {
				log.info('auto-stage:timing: hash_check(file=%s)=%dms', filePath, ht1 - ht0);
			}

			// If the hash changed, the file was modified during the session
			if (currentHash !== storedHash) {
				filesToStage.push(filePath);
			}
		}
		const ast2 = Date.now();
		log.info(
			'auto-stage:timing: hash_compare=%dms files_processed=%d files_to_stage=%d',
			ast2 - ast1,
			currentDirtyFiles.length,
			filesToStage.length,
		);

		let stageMs = 0;
		if (filesToStage.length > 0) {
			const st0 = Date.now();
			await stageFiles(pi, filesToStage, ctx);
			stageMs = Date.now() - st0;
			log.info(
				'auto-stage:timing: git_add=%dms files_staged=%d',
				stageMs,
				filesToStage.length,
			);
		}

		const ast3 = Date.now();
		log.info(
			'auto-stage:timing: total=%dms (git_status=%d + hash_compare=%d + stage=%d)',
			ast3 - ast0,
			ast1 - ast0,
			ast2 - ast1,
			stageMs,
		);

		initialFileHashes.clear();
	});
}
