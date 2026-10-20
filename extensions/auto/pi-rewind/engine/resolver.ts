import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

/** Root directory for all session checkpoint repos. */
export function getCheckpointSessionsRoot(): string {
	return path.join(os.homedir(), '.pi', 'agent', 'rewind', 'checkpoints');
}

/** Stable short hash of an absolute path, safe for use as a directory name. */
function hashScope(input: string): string {
	return createHash('sha1').update(input).digest('hex').slice(0, 16);
}

/**
 * Resolve the checkpoint repo directory for a given session file.
 *
 * @param sessionFile - Absolute path to the session `.jsonl` file.
 * @param cwd - Session working directory. Required when `sessionFile` is
 *   undefined (ephemeral runs): different projects must not share one bare
 *   repo/index, otherwise their file trees would be staged and restored into
 *   each other's work trees.
 * @returns Directory where the bare repo and index should live.
 */
export function getRepoDir(sessionFile: string | undefined, cwd?: string): string {
	if (!sessionFile) {
		const scope = cwd ? `-${hashScope(path.resolve(cwd))}` : '';
		return path.join(getCheckpointSessionsRoot(), `ephemeral${scope}`);
	}
	const base = path.basename(sessionFile, '.jsonl');
	return path.join(getCheckpointSessionsRoot(), base);
}

/** Resolve the bare `.git` directory inside a repo dir. */
export function getGitDir(repoDir: string): string {
	return path.join(repoDir, '.git');
}

/** Resolve the external git index file path (kept outside the work tree). */
export function getIndexPath(repoDir: string): string {
	return path.join(repoDir, 'index');
}
