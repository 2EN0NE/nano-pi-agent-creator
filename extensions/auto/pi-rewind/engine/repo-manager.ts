import type { Dirent } from 'node:fs';
import path from 'node:path';
import { access, mkdir, open, readdir, rmdir, stat, writeFile } from 'node:fs/promises';
import { errorMessage } from '../util';
import { exec, execSafe, type ExecEnv } from './exec';
import { withRepoLock } from './lock';

const AUTO_EXCLUDE_SCAN_ALWAYS_PRUNE_DIRS = new Set(['.git', '.pi']);
/** 全树 exclude 重扫的最小间隔：同一实例内避免单条消息多次 stageAll 重复遍历。 */
const EXCLUDE_RESCAN_MIN_INTERVAL_MS = 5_000;
const AUTO_EXCLUDE_SCAN_CONFIGURED_PRUNE_DIRS = new Set([
	'node_modules',
	'dist',
	'build',
	'target',
	'.next',
	'.nuxt',
	'.svelte-kit',
	'.parcel-cache',
	'.turbo',
	'.cache',
	'coverage',
	'.venv',
	'venv',
	'.tox',
	'__pycache__',
	'Pods',
	'DerivedData',
	'.terraform',
	'.serverless',
	'.aws-sam',
]);
const WINDOWS_RESERVED_DEVICE_NAMES = [
	'CON',
	'PRN',
	'AUX',
	'NUL',
	'COM1',
	'COM2',
	'COM3',
	'COM4',
	'COM5',
	'COM6',
	'COM7',
	'COM8',
	'COM9',
	'LPT1',
	'LPT2',
	'LPT3',
	'LPT4',
	'LPT5',
	'LPT6',
	'LPT7',
	'LPT8',
	'LPT9',
	'COM¹',
	'COM²',
	'COM³',
	'LPT¹',
	'LPT²',
	'LPT³',
] as const;
const WINDOWS_RESERVED_DEVICE_NAME_SET = new Set<string>(WINDOWS_RESERVED_DEVICE_NAMES);

function getWindowsReservedPathExcludePatterns(): readonly string[] {
	return WINDOWS_RESERVED_DEVICE_NAMES.flatMap((name) => [name, `${name}.*`, `${name}[. ]*`]);
}

function getWindowsReservedPathspecExcludes(): readonly string[] {
	return WINDOWS_RESERVED_DEVICE_NAMES.flatMap((name) => [
		`:(exclude,icase,glob)**/${name}`,
		`:(exclude,icase,glob)**/${name}.*`,
		`:(exclude,icase,glob)**/${name}[. ]*`,
	]);
}

function usesWindowsReservedPathProtection(): boolean {
	return process.platform === 'win32';
}

/**
 * Whether any component of a Git-style path resolves to a Windows reserved device name.
 *
 * Windows treats device names case-insensitively, including when followed by an extension
 * or trailing dots/spaces. This helper is platform-independent so its normalization rules
 * can be tested directly; callers decide when Windows protection applies.
 */
export function isWindowsReservedDevicePath(filePath: string): boolean {
	return filePath.split(/[\\/]+/).some((component) => {
		const trimmed = component.replace(/[ .]+$/u, '');
		const extensionIndex = trimmed.indexOf('.');
		const baseName = extensionIndex === -1 ? trimmed : trimmed.slice(0, extensionIndex);
		return WINDOWS_RESERVED_DEVICE_NAME_SET.has(baseName.toUpperCase());
	});
}

function getDirectoryExcludePatterns(dirName: string): Set<string> {
	return new Set([
		dirName,
		`${dirName}/`,
		`${dirName}/**`,
		`**/${dirName}`,
		`**/${dirName}/`,
		`**/${dirName}/**`,
	]);
}

function hasDirectoryExclude(patterns: readonly string[], dirName: string): boolean {
	const directoryExcludePatterns = getDirectoryExcludePatterns(dirName);
	return patterns.some((pattern) => directoryExcludePatterns.has(pattern));
}

function shouldPruneAutoExcludeScanDir(dirName: string, patterns: readonly string[]): boolean {
	if (AUTO_EXCLUDE_SCAN_ALWAYS_PRUNE_DIRS.has(dirName)) return true;
	return (
		AUTO_EXCLUDE_SCAN_CONFIGURED_PRUNE_DIRS.has(dirName) &&
		hasDirectoryExclude(patterns, dirName)
	);
}

function toGitPath(workTree: string, absolutePath: string): string {
	return path.relative(workTree, absolutePath).replace(/[\\/]+/g, '/');
}

function isPathInside(basePath: string, candidatePath: string): boolean {
	const relative = path.relative(basePath, candidatePath);
	return relative.length === 0 || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export type SafeCheckoutFailureReason =
	| 'dirty'
	| 'dirty-check-failed'
	| 'storage-missing'
	| 'storage-corrupt'
	| 'target-missing'
	| 'invalid-target'
	| 'path-safety-failed'
	| 'lock-failed'
	| 'exclude-refresh-failed'
	| 'checkout-failed'
	| 'rollback-failed'
	| 'preflight-failed';

/**
 * Outcome of {@link RepoManager.safeCheckout}.
 *
 * Discriminated union so callers handle every path at the type level.
 */
export type SafeCheckoutResult =
	| { readonly ok: true; readonly safetyHash?: string }
	| {
			readonly ok: false;
			readonly reason: SafeCheckoutFailureReason;
			readonly message?: string;
			readonly error?: string;
			readonly rollbackError?: string;
	  };

function formatDirtyPaths(diffStdout: string): string | undefined {
	const paths = diffStdout
		.split(/\r?\n/)
		.map((line) =>
			line.includes('\t') ? line.slice(line.lastIndexOf('\t') + 1).trim() : line.trim(),
		)
		.filter((entry) => entry.length > 0);
	if (paths.length === 0) return undefined;

	const shown = paths.slice(0, 5).map((entry) => `- ${entry}`);
	const remaining = paths.length - shown.length;
	return [
		'Changed paths:',
		...shown,
		...(remaining > 0 ? [`- ...and ${remaining} more`] : []),
	].join('\n');
}

/**
 *
 * Each session gets its own bare repo under `~/.pi/agent/rewind/checkpoints/`.
 * The work tree points to the user's project directory so that `git add/checkout`
 * operate directly on the project files.
 */
const BINARY_PROBE_BYTES = 8000;

/** 读文件前 8KB 探测 NUL 字节，判断是否二进制。 */
async function isBinaryFile(absolutePath: string): Promise<boolean> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(absolutePath, 'r');
		const buffer = Buffer.alloc(BINARY_PROBE_BYTES);
		const { bytesRead } = await handle.read(buffer, 0, BINARY_PROBE_BYTES, 0);
		return buffer.subarray(0, bytesRead).includes(0);
	} catch {
		return false;
	} finally {
		await handle?.close().catch(() => {});
	}
}

export class RepoManager {
	private env: ExecEnv;

	private repoDir: string;

	private excludePatterns: readonly string[] | undefined;

	private maxFileBytes: number | undefined;

	private skipBinary = true;

	private includeUntracked = true;

	/** `setExclude` has already scanned nested repositories for the next stage operation. */
	private excludeIsFresh = false;

	/** Key (joined patterns) of the last full-tree exclude scan, for rescan throttling. */
	private lastExcludeScanKey: string | undefined;

	/** Timestamp (ms) of the last full-tree exclude scan. */
	private lastExcludeScanAtMs = 0;

	constructor(
		/** Absolute path to the bare `.git` directory. */
		private gitDir: string,
		/** Absolute path to the git index file (outside the work tree). */
		indexFile: string,
		/** Absolute path to the project working directory. */
		private workTree: string,
	) {
		this.repoDir = path.dirname(gitDir);
		this.env = {
			GIT_DIR: gitDir,
			GIT_WORK_TREE: workTree,
			GIT_INDEX_FILE: indexFile,
		};
	}

	/**
	 * Execute `fn` while holding an exclusive filesystem lock on this repo.
	 *
	 * Serialises concurrent access across processes and separate package installs.
	 */
	async withLock<T>(fn: () => Promise<T>): Promise<T> {
		return withRepoLock(this.repoDir, fn);
	}

	setMaxFileBytes(maxFileBytes: number | undefined): void {
		this.maxFileBytes = maxFileBytes;
	}

	setSkipBinary(skipBinary: boolean): void {
		this.skipBinary = skipBinary;
	}

	setIncludeUntracked(includeUntracked: boolean): void {
		this.includeUntracked = includeUntracked;
	}

	private gitArgs(): string[] {
		return [
			'-c',
			'core.autocrlf=false',
			'-c',
			'core.safecrlf=false',
			'-c',
			'core.filemode=false',
			'-c',
			'core.quotepath=false',
			// Checkpoint repos are session-scoped and short-lived; disable
			// auto-maintenance so `git commit` does not spawn `git maintenance
			// run --auto --detach`. A detached background git process is both
			// unnecessary here and harmful inside the extension runtime: it
			// inherits/contends for the same repo and can stall the ordinal
			// `exec` calls that follow (observed as `/rewind` hanging).
			'-c',
			'gc.auto=0',
			'-c',
			'maintenance.auto=false',
			`--git-dir=${this.gitDir}`,
			`--work-tree=${this.workTree}`,
		];
	}

	private static async configureIdentity(gitDir: string): Promise<void> {
		await exec('git', [`--git-dir=${gitDir}`, 'config', 'user.email', 'pi@checkpoint.local']);
		await exec('git', [`--git-dir=${gitDir}`, 'config', 'user.name', 'Pi Checkpoint']);
	}

	/** Initialize a fresh bare repo and set default git config. */
	async init(): Promise<void> {
		await mkdir(path.dirname(this.gitDir), { recursive: true });
		await exec('git', ['init', '--bare', this.gitDir]);
		await RepoManager.configureIdentity(this.gitDir);
	}

	/** Initialize the bare repo while holding the repo lock. */
	async lockedInit(): Promise<void> {
		await this.withLock(async () => {
			await this.init();
		});
	}

	/**
	 * Silently re-initialise the bare repo if it has been deleted externally.
	 *
	 * Used before operations that assume the repo exists (e.g. checkpoint).
	 * Does nothing when the repo is still intact.
	 */
	async ensureReady(excludePatterns?: readonly string[]): Promise<void> {
		try {
			await exec(
				'git',
				[...this.gitArgs(), 'rev-parse', '--git-dir'],
				this.env,
				this.workTree,
			);
		} catch {
			await this.init();
		}

		if (excludePatterns) {
			await this.setExclude(excludePatterns);
		}
	}

	/** Ensure the bare repo exists while holding the repo lock. */
	async lockedEnsureReady(excludePatterns?: readonly string[]): Promise<void> {
		await this.withLock(async () => {
			await this.ensureReady(excludePatterns);
		});
	}

	private async findNestedGitRepoExcludes(patterns: readonly string[]): Promise<string[]> {
		const workTree = path.resolve(this.workTree);
		const roots: string[] = [];
		const stack = [workTree];

		while (true) {
			const current = stack.pop();
			if (current === undefined) break;

			let entries: Dirent[];
			try {
				entries = await readdir(current, { withFileTypes: true });
			} catch {
				continue;
			}

			const hasGitMarker = entries.some(
				(entry) => entry.name === '.git' && (entry.isDirectory() || entry.isFile()),
			);
			if (current !== workTree && hasGitMarker) {
				const relative = toGitPath(workTree, current);
				roots.push(`${relative}/`);
				continue;
			}

			for (const entry of entries) {
				if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
				if (
					usesWindowsReservedPathProtection() &&
					isWindowsReservedDevicePath(entry.name)
				) {
					continue;
				}
				if (shouldPruneAutoExcludeScanDir(entry.name, patterns)) continue;
				stack.push(path.join(current, entry.name));
			}
		}

		return roots.sort();
	}

	private async writeExclude(patterns: readonly string[]): Promise<void> {
		const excludePath = path.join(this.gitDir, 'info', 'exclude');
		const autoExcludes = await this.findNestedGitRepoExcludes(patterns);
		const internalStorageExcludes = isPathInside(this.workTree, this.repoDir)
			? Array.from(getDirectoryExcludePatterns(toGitPath(this.workTree, this.repoDir)))
			: [];
		const windowsReservedExcludes = usesWindowsReservedPathProtection()
			? getWindowsReservedPathExcludePatterns()
			: [];
		const allPatterns = [
			...patterns,
			...internalStorageExcludes,
			...autoExcludes,
			...windowsReservedExcludes,
		];
		await mkdir(path.dirname(excludePath), { recursive: true });
		await writeFile(excludePath, allPatterns.join('\n') + '\n', 'utf8');
	}

	private async refreshExclude(): Promise<void> {
		if (!this.excludePatterns) return;
		// 单条用户消息会多次触发 stageAll（turnStart before / finalize after /
		// dirty guard），每次都做全树扫描找嵌套 git 仓库代价高昂（大仓库逐目录
		// readdir）。同一实例内 patterns 未变且刚扫过时跳过重复扫描——新建嵌套
		// git 仓库导致排除滞后的窗口仅存在于同一实例的 <5s 内，下一轮 stage 即收敛。
		const key = this.excludePatterns.join('\n');
		const nowMs = Date.now();
		if (
			this.lastExcludeScanKey === key &&
			nowMs - this.lastExcludeScanAtMs < EXCLUDE_RESCAN_MIN_INTERVAL_MS
		) {
			this.excludeIsFresh = true;
			return;
		}
		await this.writeExclude(this.excludePatterns);
		this.lastExcludeScanKey = key;
		this.lastExcludeScanAtMs = nowMs;
		this.excludeIsFresh = true;
	}

	/** Write exclude patterns to `info/exclude` inside the bare repo. */
	async setExclude(patterns: readonly string[]): Promise<void> {
		const explicitPatterns = [...patterns];
		this.excludePatterns = explicitPatterns;
		await this.writeExclude(explicitPatterns);
		this.excludeIsFresh = true;
	}

	/** Write exclude patterns while holding the repo lock. */
	async lockedSetExclude(patterns: readonly string[]): Promise<void> {
		await this.withLock(async () => {
			await this.setExclude(patterns);
		});
	}

	private async commitStagedCheckpoint(entryId: string, allowEmpty: boolean): Promise<string> {
		const allowEmptyArgs = allowEmpty ? ['--allow-empty'] : [];
		await exec(
			'git',
			[...this.gitArgs(), 'commit', '-m', `[pi] entry:${entryId}`, ...allowEmptyArgs],
			this.env,
			this.workTree,
		);
		const { stdout } = await exec(
			'git',
			[...this.gitArgs(), 'rev-parse', 'HEAD'],
			this.env,
			this.workTree,
		);
		return stdout.trim();
	}

	/**
	 * Stage all files and create a checkpoint commit.
	 *
	 * @param entryId - Session entry id to embed in the commit message.
	 * @returns The 40-character commit hash.
	 */
	async checkpoint(entryId: string): Promise<string> {
		await this.stageAll();
		return this.commitStagedCheckpoint(entryId, true);
	}

	/**
	 * Create a checkpoint from the already staged index.
	 *
	 * Callers must only use this after staging changes relative to the intended base.
	 */
	async checkpointStaged(entryId: string): Promise<string> {
		return this.commitStagedCheckpoint(entryId, false);
	}

	/**
	 * Stage all files and create a checkpoint only when they differ from `baseCommit`.
	 *
	 * If the base commit is no longer available, creates a complete checkpoint instead
	 * of risking an unprotected Turn boundary.
	 */
	async checkpointIfChanged(entryId: string, baseCommit: string): Promise<string> {
		await this.stageAll();
		try {
			const diff = await this.diffAgainst(baseCommit);
			if (diff.length === 0) return baseCommit;
			return this.checkpointStaged(entryId);
		} catch {
			return this.commitStagedCheckpoint(entryId, true);
		}
	}

	/** Create a checkpoint while holding the repo lock. */
	async lockedCheckpoint(entryId: string): Promise<string> {
		return this.withLock(async () => this.checkpoint(entryId));
	}

	/** Hard-reset the work tree to `commitHash` and remove untracked files. */
	async checkoutCommit(commitHash: string): Promise<void> {
		// Files present in the current tree (the safety commit) but absent in the
		// target — `reset --hard` deletes these and can leave their parent
		// directories empty (git does not remove directories). Collect them so the
		// emptied directories can be pruned, matching the previous `git clean -fd`
		// cleanup without deleting directories that still hold files.
		const { stdout } = await exec(
			'git',
			[
				...this.gitArgs(),
				'diff',
				'--name-only',
				'-z',
				'--diff-filter=A',
				'--no-renames',
				commitHash,
				'HEAD',
			],
			this.env,
			this.workTree,
		);
		const resetRemovedPaths = stdout.split('\0').filter((entry) => entry.length > 0);

		await exec(
			'git',
			[...this.gitArgs(), 'reset', '--hard', commitHash],
			this.env,
			this.workTree,
		);
		await this.cleanUntrackedAfterCheckout(resetRemovedPaths);
	}

	/**
	 * Remove untracked files after a hard reset — only those that were captured
	 * by the snapshot system may be cleaned.
	 *
	 * `git reset --hard` already removes/restores every tracked path, so `git
	 * clean` would only ever delete files that no checkpoint commit recorded.
	 * Deleting those is unsafe: files skipped by the size/binary guard
	 * (`maxFileBytes`/`skipBinary`) — or all untracked files when
	 * `includeUntracked` is false — never enter the bare repo, so neither the
	 * dirty guard nor the safety commit can account for them, and a plain
	 * `git clean -fd` would silently destroy them (ADR-0038: 未纳入快照即不清理).
	 *
	 * Candidates are enumerated with the same predicate the stage phase uses
	 * (`git ls-files -o --exclude-standard`), then the protected set (the same
	 * skip predicate as {@link findSkippedPaths}) is excluded before removal.
	 * Finally, directories emptied by either `reset --hard` or this clean are
	 * pruned (see {@link pruneEmptyParentDirectories}).
	 */
	private async cleanUntrackedAfterCheckout(resetRemovedPaths: readonly string[]): Promise<void> {
		if (!this.includeUntracked) {
			// includeUntracked=false 时 untracked 文件从未进入快照 → 一个也不清理，
			// 只修剪 reset --hard 自己删空了的父目录。
			await this.pruneEmptyParentDirectories(resetRemovedPaths);
			return;
		}

		const pathspecExcludes = usesWindowsReservedPathProtection()
			? getWindowsReservedPathspecExcludes()
			: [];
		const { stdout } = await exec(
			'git',
			[
				...this.gitArgs(),
				'ls-files',
				'-z',
				'-o',
				'--exclude-standard',
				'--',
				'.',
				...pathspecExcludes,
			],
			this.env,
			this.workTree,
		);
		let candidates = stdout.split('\0').filter((entry) => entry.length > 0);

		const skippedPaths = await this.findSkippedPaths();
		if (skippedPaths.length > 0 && candidates.length > 0) {
			const protectedPaths = new Set(skippedPaths);
			candidates = candidates.filter((candidate) => !protectedPaths.has(candidate));
		}

		const chunkSize = 100;
		for (let index = 0; index < candidates.length; index += chunkSize) {
			await exec(
				'git',
				[
					...this.gitArgs(),
					'clean',
					'-fd',
					'--',
					...candidates.slice(index, index + chunkSize),
				],
				this.env,
				this.workTree,
			);
		}

		// `git clean` 只删文件，被删文件的父目录会残留成空目录；连同
		// reset --hard 删空的目录一起修剪（rmdir 非递归，非空目录自动跳过）。
		await this.pruneEmptyParentDirectories([...resetRemovedPaths, ...candidates]);
	}

	/**
	 * Best-effort removal of directories emptied by a rollback.
	 *
	 * `git reset --hard` (and `git clean` with explicit file paths) deletes files
	 * but leaves their parent directories behind. Non-recursive `rmdir` succeeds
	 * only on empty directories, so directories that still hold files (including
	 * protected / skipped files) are untouched.
	 */
	private async pruneEmptyParentDirectories(paths: readonly string[]): Promise<void> {
		const directories = new Set<string>();
		for (const candidate of paths) {
			let dir = path.dirname(candidate);
			while (dir !== '.' && dir !== path.sep) {
				directories.add(dir);
				const parent = path.dirname(dir);
				if (parent === dir) break;
				dir = parent;
			}
		}
		// Deepest first, so an emptied nested directory is removed before its parent.
		const deepestFirst = [...directories].sort((left, right) => right.length - left.length);
		for (const dir of deepestFirst) {
			await rmdir(path.join(this.workTree, dir)).catch(() => undefined);
		}
	}

	/** Check out a commit while holding the repo lock. */
	async lockedCheckoutCommit(commitHash: string): Promise<void> {
		await this.withLock(async () => {
			await this.checkoutCommit(commitHash);
		});
	}

	/**
	 * Create a temporary safety commit capturing the current work tree state.
	 *
	 * Used before destructive operations so we can roll back on failure.
	 * @returns The safety commit hash.
	 */
	async createSafetyCommit(): Promise<string> {
		await this.stageAll();
		await exec(
			'git',
			[...this.gitArgs(), 'commit', '-m', '[pi] safety', '--allow-empty'],
			this.env,
			this.workTree,
		);
		const { stdout } = await exec(
			'git',
			[...this.gitArgs(), 'rev-parse', 'HEAD'],
			this.env,
			this.workTree,
		);
		return stdout.trim();
	}

	/** Create a safety commit while holding the repo lock. */
	async lockedCreateSafetyCommit(): Promise<string> {
		return this.withLock(async () => this.createSafetyCommit());
	}

	/** Clone a bare repo (used when forking/cloning a session). */
	static async cloneFrom(srcGitDir: string, dstGitDir: string): Promise<void> {
		await exec('git', ['clone', '--local', '--bare', srcGitDir, dstGitDir]);
		await RepoManager.configureIdentity(dstGitDir);
	}

	/** Update a git ref to point at `commitHash`. */
	async updateRef(ref: string, commitHash: string): Promise<void> {
		await exec(
			'git',
			[...this.gitArgs(), 'update-ref', ref, commitHash],
			this.env,
			this.workTree,
		);
	}

	/** Update a git ref while holding the repo lock. */
	async lockedUpdateRef(ref: string, commitHash: string): Promise<void> {
		await this.withLock(async () => {
			await this.updateRef(ref, commitHash);
		});
	}

	/**
	 * Return `--numstat` diff between the commit's parent and the commit itself.
	 *
	 * Falls back to `git show --numstat` for the first commit (no parent).
	 */
	async diffStats(commitHash: string): Promise<string> {
		try {
			const { stdout } = await exec(
				'git',
				[...this.gitArgs(), 'diff', '--numstat', `${commitHash}~1`, commitHash],
				this.env,
				this.workTree,
			);
			return stdout;
		} catch {
			const { stdout } = await exec(
				'git',
				[...this.gitArgs(), 'show', '--numstat', '--format=', commitHash],
				this.env,
				this.workTree,
			);
			return stdout;
		}
	}

	/** Return `--numstat` diff between `commitHash` and the current working tree. */
	async diffWorkingTree(commitHash: string): Promise<string> {
		const { stdout } = await exec(
			'git',
			[...this.gitArgs(), 'diff', '--numstat', commitHash],
			this.env,
			this.workTree,
		);
		return stdout;
	}

	private async workTreeIsGitWorkTree(): Promise<boolean> {
		try {
			const { stdout } = await exec('git', [
				'-C',
				this.workTree,
				'rev-parse',
				'--is-inside-work-tree',
			]);
			return stdout.trim() === 'true';
		} catch {
			return false;
		}
	}

	private async findGitignoreIgnoredPaths(): Promise<readonly string[]> {
		const { stdout } = await exec(
			'git',
			[...this.gitArgs(), 'ls-files', '-z', '-o', '-i', '--exclude-standard'],
			this.env,
			this.workTree,
		);
		const candidates = stdout.split('\0').filter((entry) => entry.length > 0);
		if (candidates.length === 0) return [];

		const { stdout: ignoredDetails } = await exec(
			'git',
			[...this.gitArgs(), 'check-ignore', '--no-index', '-z', '-v', '--stdin'],
			this.env,
			this.workTree,
			{ input: candidates.join('\0') + '\0' },
		);
		const fields = ignoredDetails.split('\0');
		const paths: string[] = [];
		for (let index = 0; index + 3 < fields.length; index += 4) {
			const source = fields[index];
			const ignoredPath = fields[index + 3];
			if (
				source !== undefined &&
				ignoredPath !== undefined &&
				path.basename(source) === '.gitignore'
			) {
				paths.push(ignoredPath);
			}
		}
		return paths;
	}

	private async removeIgnoredFromIndex(): Promise<void> {
		const { stdout } = await exec(
			'git',
			[...this.gitArgs(), 'ls-files', '-z', '-i', '-c', '--exclude-standard'],
			this.env,
			this.workTree,
		);
		const paths = stdout.split('\0').filter((entry) => entry.length > 0);
		if (paths.length === 0) return;

		await this.removePathsFromIndex(paths);
	}

	private async removeWindowsReservedPathsFromIndex(): Promise<void> {
		if (!usesWindowsReservedPathProtection()) return;

		const { stdout } = await exec(
			'git',
			[...this.gitArgs(), 'ls-files', '-z'],
			this.env,
			this.workTree,
		);
		const paths = Array.from(
			new Set(
				stdout
					.split('\0')
					.filter((entry) => entry.length > 0 && isWindowsReservedDevicePath(entry)),
			),
		);
		await this.removePathsFromIndex(paths);
	}

	private async removePathsFromIndex(paths: readonly string[]): Promise<void> {
		if (paths.length === 0) return;

		const chunkSize = 100;
		for (let index = 0; index < paths.length; index += chunkSize) {
			const chunk = paths.slice(index, index + chunkSize);
			await exec(
				'git',
				[...this.gitArgs(), 'rm', '--cached', '-r', '--ignore-unmatch', '--', ...chunk],
				this.env,
				this.workTree,
			);
		}
	}

	private async findSkippedPaths(
		additionalCandidates: readonly string[] = [],
	): Promise<readonly string[]> {
		if (!this.maxFileBytes && !this.skipBinary) return [];

		const pathspecExcludes = usesWindowsReservedPathProtection()
			? getWindowsReservedPathspecExcludes()
			: [];
		const lsFilesArgs = this.includeUntracked ? ['-m', '-o'] : ['-m'];
		const { stdout } = await exec(
			'git',
			[
				...this.gitArgs(),
				'ls-files',
				...lsFilesArgs,
				'--exclude-standard',
				'-z',
				'--',
				'.',
				...pathspecExcludes,
			],
			this.env,
			this.workTree,
		);
		const candidates = Array.from(
			new Set([
				...stdout.split('\0').filter((entry) => entry.length > 0),
				...additionalCandidates,
			]),
		);
		const skipped: string[] = [];

		for (const candidate of candidates) {
			const absolutePath = path.join(this.workTree, candidate);
			let stats;
			try {
				stats = await stat(absolutePath);
			} catch {
				continue;
			}
			if (!stats.isFile()) continue;
			if (this.maxFileBytes && stats.size > this.maxFileBytes) {
				skipped.push(candidate);
				continue;
			}
			if (this.skipBinary && (await isBinaryFile(absolutePath))) {
				skipped.push(candidate);
			}
		}

		return skipped;
	}

	private async stageGitignoreIgnoredPaths(paths: readonly string[]): Promise<void> {
		const chunkSize = 100;
		for (let index = 0; index < paths.length; index += chunkSize) {
			await exec(
				'git',
				[...this.gitArgs(), 'add', '-f', '--', ...paths.slice(index, index + chunkSize)],
				this.env,
				this.workTree,
			);
		}
	}

	private async stageAllAfterRefresh(): Promise<void> {
		// `git add -u -- .` 在 index 尚无任何文件时会因 pathspec 无匹配直接失败。
		// 但「index 为空」有两种含义，必须在做任何 index 清理*之前*区分：
		//   ① 全新存储（HEAD 尚未诞生）→ 确实没有已跟踪变更可暂存，跳过；
		//   ② index 未初始化但 HEAD 已有 tree（典型：fork/clone 出的存储没有
		//      index 文件）→ 必须先 `read-tree HEAD` 重建 index，否则后续
		//      `commit --allow-empty` 会写出**空树 commit**：快照与工作区脱节，
		//      回滚 reset --hard 后文件纹丝不动却报成功。
		// 重建必须早于 removeIgnoredFromIndex/removeWindowsReservedPathsFromIndex，
		// 否则从 HEAD 恢复出来的被排除路径不会被再次剔除。
		if (!this.includeUntracked) {
			const { stdout } = await exec(
				'git',
				[...this.gitArgs(), 'ls-files', '-z'],
				this.env,
				this.workTree,
			);
			if (stdout.length === 0) {
				const headProbe = await execSafe(
					'git',
					[...this.gitArgs(), 'rev-parse', '--verify', '--quiet', 'HEAD'],
					this.env,
					this.workTree,
				);
				if (!headProbe.ok) return; // HEAD 未诞生：真正的「无已跟踪变更」
				await exec(
					'git',
					[...this.gitArgs(), 'read-tree', 'HEAD'],
					this.env,
					this.workTree,
				);
			}
		}

		await this.removeWindowsReservedPathsFromIndex();
		await this.removeIgnoredFromIndex();
		const gitignoreIgnoredPaths =
			!this.includeUntracked || (await this.workTreeIsGitWorkTree())
				? []
				: await this.findGitignoreIgnoredPaths();
		const skippedPaths = await this.findSkippedPaths(gitignoreIgnoredPaths);
		const skippedPathSet = new Set(skippedPaths);
		const pathspecExcludes = usesWindowsReservedPathProtection()
			? getWindowsReservedPathspecExcludes()
			: [];
		const addFlag = this.includeUntracked ? '-A' : '-u';
		const addArgs = [...this.gitArgs(), 'add', addFlag, '--', '.', ...pathspecExcludes];
		await exec(
			'git',
			[...addArgs, ...skippedPaths.map((candidate) => `:(exclude)${candidate}`)],
			this.env,
			this.workTree,
		);
		await this.stageGitignoreIgnoredPaths(
			gitignoreIgnoredPaths.filter((candidate) => !skippedPathSet.has(candidate)),
		);
	}

	/** Stage all changes in the working tree. */
	async stageAll(): Promise<void> {
		if (!this.excludeIsFresh) await this.refreshExclude();
		try {
			await this.stageAllAfterRefresh();
		} finally {
			this.excludeIsFresh = false;
		}
	}

	/** Stage all changes while holding the repo lock. */
	async lockedStageAll(): Promise<void> {
		await this.withLock(async () => {
			await this.stageAll();
		});
	}

	/** Return `--numstat` diff between the staged index and `commitHash`. */
	async diffAgainst(commitHash: string): Promise<string> {
		const { stdout } = await exec(
			'git',
			[...this.gitArgs(), 'diff', '--numstat', '--cached', commitHash],
			this.env,
			this.workTree,
		);
		return stdout;
	}

	private failure(
		reason: SafeCheckoutFailureReason,
		message: string,
		error?: string,
		rollbackError?: string,
	): SafeCheckoutResult {
		return {
			ok: false,
			reason,
			message,
			...(error ? { error } : {}),
			...(rollbackError ? { rollbackError } : {}),
		};
	}

	private passesPathSafetyChecks(): boolean {
		return (
			path.isAbsolute(this.gitDir) &&
			path.isAbsolute(this.repoDir) &&
			path.isAbsolute(this.workTree) &&
			path.resolve(this.gitDir) === path.resolve(this.repoDir, '.git')
		);
	}

	private async validateRepoStorage(): Promise<SafeCheckoutResult | undefined> {
		const hasGitDir = await access(this.gitDir)
			.then(() => true)
			.catch(() => false);
		if (!hasGitDir) {
			return this.failure('storage-missing', 'Checkpoint storage is missing.');
		}

		try {
			await exec(
				'git',
				[...this.gitArgs(), 'rev-parse', '--git-dir'],
				this.env,
				this.workTree,
			);
			return undefined;
		} catch (error) {
			return this.failure(
				'storage-corrupt',
				'Checkpoint storage is unreadable.',
				errorMessage(error),
			);
		}
	}

	private isValidCommitReference(commitHash: string): boolean {
		return (
			commitHash.trim().length > 0 &&
			!commitHash.includes('\0') &&
			!commitHash.includes('\r') &&
			!commitHash.includes('\n')
		);
	}

	private async hasCommit(commitHash: string): Promise<boolean> {
		try {
			await exec(
				'git',
				[...this.gitArgs(), 'cat-file', '-e', `${commitHash}^{commit}`],
				this.env,
				this.workTree,
			);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Safely check out `targetCommit` with dirty-guard, safety-commit, and
	 * automatic rollback on failure.
	 *
	 * The entire sequence runs inside {@link withLock} so concurrent callers
	 * are serialised.
	 *
	 * @param targetCommit - The commit hash to check out.
	 * @param dirtyBaseCommit - If provided, compare the working tree against
	 *   this commit to detect unsnapshotted changes. When dirty, returns
	 *   `{ ok: false, reason: "dirty" }`.
	 */
	async safeCheckout(
		targetCommit: string,
		dirtyBaseCommit?: string,
	): Promise<SafeCheckoutResult> {
		try {
			return await this.withLock(async () => {
				if (!this.passesPathSafetyChecks()) {
					return this.failure(
						'path-safety-failed',
						'Checkpoint storage paths failed safety validation.',
					);
				}

				const storageFailure = await this.validateRepoStorage();
				if (storageFailure) return storageFailure;

				if (!this.isValidCommitReference(targetCommit)) {
					return this.failure('invalid-target', 'Checkpoint target is invalid.');
				}
				if (!(await this.hasCommit(targetCommit))) {
					return this.failure('target-missing', 'Checkpoint target does not exist.');
				}

				if (dirtyBaseCommit) {
					if (
						!this.isValidCommitReference(dirtyBaseCommit) ||
						!(await this.hasCommit(dirtyBaseCommit))
					) {
						return this.failure(
							'dirty-check-failed',
							'Could not verify the workspace is clean against the checkpoint base.',
						);
					}

					try {
						await this.refreshExclude();
					} catch (error) {
						return this.failure(
							'exclude-refresh-failed',
							'Failed to refresh checkpoint excludes before restore.',
							errorMessage(error),
						);
					}

					try {
						await this.stageAllAfterRefresh();
						const dirtyStdout = await this.diffAgainst(dirtyBaseCommit);
						if (dirtyStdout.trim().length > 0) {
							return this.failure(
								'dirty',
								[
									'Workspace has checkpoint-managed changes that are not captured by the selected checkpoint base.',
									formatDirtyPaths(dirtyStdout),
								]
									.filter((part): part is string => typeof part === 'string')
									.join('\n'),
							);
						}
					} catch (error) {
						return this.failure(
							'dirty-check-failed',
							'Could not verify the workspace is clean against the checkpoint base.',
							errorMessage(error),
						);
					}
				}

				let safetyHash: string;
				try {
					safetyHash = await this.createSafetyCommit();
				} catch (error) {
					return this.failure(
						'preflight-failed',
						'Failed to create a safety checkpoint before restore.',
						errorMessage(error),
					);
				}

				try {
					await this.refreshExclude();
				} catch (error) {
					return this.failure(
						'exclude-refresh-failed',
						'Failed to refresh checkpoint excludes before restore.',
						errorMessage(error),
					);
				}

				try {
					await this.checkoutCommit(targetCommit);
					return { ok: true, safetyHash };
				} catch (error) {
					try {
						await this.checkoutCommit(safetyHash);
					} catch (rollbackError) {
						return this.failure(
							'rollback-failed',
							'Checkpoint restore failed and rollback could not recover the previous state.',
							errorMessage(error),
							errorMessage(rollbackError),
						);
					}
					return this.failure(
						'checkout-failed',
						'Checkpoint restore failed.',
						errorMessage(error),
					);
				}
			});
		} catch (error) {
			return this.failure(
				'lock-failed',
				'Failed to lock checkpoint storage for restore.',
				errorMessage(error),
			);
		}
	}
}
