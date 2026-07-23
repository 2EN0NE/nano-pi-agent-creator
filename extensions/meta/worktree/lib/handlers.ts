/**
 * pi-worktree — 命令处理器
 */
import { createLogger } from '@zenone/pi-logger';
import { basename } from 'node:path';
import { spawnSync, spawn, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { MergeStrategy } from '../types.js';
import {
	getCurrentBranch,
	execRebase,
	isMergeInProgress,
	isRebaseInProgress,
	getConflictFiles,
	getMergeSourceBranch,
	popWorktreeStash,
} from './git.js';
import {
	createWorktree,
	removeWorktree,
	deleteWorktreeBranch,
	pickAvailableName,
	findMergedWorktrees,
} from './worktree.js';
import {
	getManagedWorktrees,
	getWorktreePath,
	getRepoRoot,
	isWorktreeCwd,
	getNameFromCwd,
} from './paths.js';
import {
	showWorktreeTui,
	showOperationSubmenu,
	askSessionStrategy,
	askSymlinkTargetsPanel,
	askMergeStrategy,
	promptWorktreeName,
	confirmDelete,
	confirmRebaseFF,
	confirmForceDelete,
	askBranchDelete,
	showConflictPanel,
	showPostMergeGuide,
} from './ui.js';
import {
	switchToSession,
	findExistingSession,
	createSession,
	cloneSession,
	hasClonedSession,
	findClonedSessionFile,
} from './session.js';

const log = createLogger('pi-worktree');

// ═══════════════════════════════════════════
// 入参解析
// ═══════════════════════════════════════════

function parseArgs(input: string): { command: string; flags: Record<string, string> } {
	const trimmed = input.trim();
	const parts = trimmed ? trimmed.split(/\s+/) : [];
	const command = parts.length > 0 ? parts[0] : '';
	const flags: Record<string, string> = {};
	const extraPositional: string[] = [];
	for (let i = 1; i < parts.length; i++) {
		if (parts[i].startsWith('--')) {
			const key = parts[i].slice(2);
			flags[key] = parts[i + 1] && !parts[i + 1].startsWith('--') ? parts[++i] : '';
		} else if (!flags._positional) {
			flags._positional = parts[i];
		} else {
			extraPositional.push(parts[i]);
		}
	}
	if (extraPositional.length > 0) {
		flags._extraPositional = extraPositional.join(',');
	}
	return { command, flags };
}

// ═══════════════════════════════════════════
// 命令配置
// ═══════════════════════════════════════════

export const COMMANDS = [
	'create [--name <n>] [--branch <b>]',
	'use <name>  or  main',
	'list',
	'delete <name>',
	'merge [--source <n>] [--target <b>] [--strategy <merge|squash|rebase-ff>]',
	'rebase [--source <n>] [--target <b>]',
	'continue',
	'abort',
	'status',
	'clean [--dry-run]',
	'shell',
	'widget <on|off>',
];

export function formatHelp(): string {
	return [
		'Usage: /worktree <command> [options]',
		'',
		'Commands:',
		...COMMANDS.map((c) => `  ${c}`),
		'',
		'  (no args)  open interactive switcher panel',
		'',
		'Names are auto-assigned from zodiac+star pool (e.g. Aries-Hamal).',
		'Worktrees created outside the repo in <repo>-worktrees/ directory.',
	].join('\n');
}

// ═══════════════════════════════════════════
// 获取当前身份
// ═══════════════════════════════════════════

export interface RepoContext {
	repoRoot: string;
	currentName: string | null; // null = main, string = worktree name
	isWorktree: boolean;
	errorMsg: string;
}

export function getRepoContext(cwd: string): RepoContext {
	const repoRoot = getRepoRoot(cwd);
	if (!repoRoot) {
		return {
			repoRoot: '',
			currentName: null,
			isWorktree: false,
			errorMsg: 'Not inside a git repository.',
		};
	}
	if (isWorktreeCwd(cwd, repoRoot)) {
		const name = getNameFromCwd(cwd, repoRoot);
		return {
			repoRoot,
			currentName: name,
			isWorktree: true,
			errorMsg: '',
		};
	}
	return {
		repoRoot,
		currentName: null,
		isWorktree: false,
		errorMsg: '',
	};
}

// ═══════════════════════════════════════════
// 主调度
// ═══════════════════════════════════════════

export async function handleWorktreeCommand(
	args: string,
	ctx: any,
	_sessionId?: string,
): Promise<void> {
	const { command, flags } = parseArgs(args);
	const repoRoot = getRepoRoot(ctx.cwd);

	if (!repoRoot) {
		ctx.ui.notify('Not inside a git repository.', 'error');
		return;
	}

	// 显式 help：始终显示帮助文本
	if (command === 'help') {
		ctx.ui.notify(formatHelp(), 'info');
		return;
	}

	// 无参数：在 TUI 模式下显示切换器面板，否则显示帮助
	if (command === '') {
		if (!ctx.hasUI) {
			ctx.ui.notify(formatHelp(), 'info');
			return;
		}
		await handlePanel(repoRoot, ctx);
		return;
	}

	switch (command) {
		case 'create':
			await handleCreate(repoRoot, flags, ctx);
			break;
		case 'use':
			await handleUse(repoRoot, flags, ctx);
			break;
		case 'list':
			handleList(repoRoot, ctx);
			break;
		case 'delete':
			await handleDelete(repoRoot, flags, ctx);
			break;
		case 'merge':
			await handleMerge(repoRoot, flags, ctx);
			break;
		case 'rebase':
			await handleRebase(repoRoot, flags, ctx);
			break;
		case 'continue':
			await handleContinue(repoRoot, ctx);
			break;
		case 'abort':
			await handleAbort(repoRoot, ctx);
			break;
		case 'status':
			handleStatus(repoRoot, ctx);
			break;
		case 'clean':
			await handleClean(repoRoot, flags, ctx);
			break;
		case 'shell':
			handleShell(repoRoot, ctx);
			break;
		case 'widget':
			handleWidget(flags, ctx);
			break;
		default:
			ctx.ui.notify(formatHelp(), 'info');
	}

	// 多余位置参数警告
	if (flags._extraPositional) {
		ctx.ui.notify(
			`Warning: unexpected extra arguments: ${flags._extraPositional}. Only one positional argument is supported.`,
			'warning',
		);
	}
}

// ═══════════════════════════════════════════
// 工具函数

function _getCurrentName(repoRoot: string, cwd: string): string | null {
	if (isWorktreeCwd(cwd, repoRoot)) return getNameFromCwd(cwd, repoRoot);
	return null;
}

/**
 * 脏文件预览文本（用于 force 删除弹窗）。
 * 在目标 worktree 目录运行 git status，显示真实脏文件。
 */
function _dirtyPreview(worktreePath: string): string {
	try {
		const out = execSync('git status --porcelain', {
			cwd: worktreePath,
			encoding: 'utf-8',
		});
		return out.trim() || 'clean';
	} catch {
		return '(unknown)';
	}
}

/**
 * 对主仓库运行 git status（备用，当 worktree 目录不可访问时使用）。
 */
// 面板
// ═══════════════════════════════════════════

async function handlePanel(repoRoot: string, ctx: any): Promise<void> {
	const currentName = _getCurrentName(repoRoot, ctx.cwd);
	const worktrees = getManagedWorktrees(repoRoot);
	const result = await showWorktreeTui(ctx, worktrees, currentName, '', repoRoot);

	switch (result.action) {
		case 'switch':
			if (result.target) {
				await handleUse(repoRoot, { _positional: result.target }, ctx);
			}
			break;
		case 'operations':
			if (result.target) {
				await handleOperationsSubmenu(repoRoot, result.target, ctx);
			}
			break;
		case 'fork':
			await handleFork(repoRoot, result.target || 'main', ctx);
			break;
		case 'create':
			await handleCreate(repoRoot, {}, ctx);
			break;
		case 'delete':
			if (result.target) {
				await handleDelete(repoRoot, { _positional: result.target }, ctx);
			}
			break;
		case 'merge':
			await handleMerge(repoRoot, {}, ctx);
			break;
		case 'rebase':
			await handleRebase(repoRoot, {}, ctx);
			break;
		case 'shell':
			handleShell(repoRoot, ctx, result.target);
			break;
		case 'quit':
			break;
	}
}

// ═══════════════════════════════════════════
// create
// ═══════════════════════════════════════════

async function handleCreate(
	repoRoot: string,
	flags: Record<string, string>,
	ctx: any,
): Promise<void> {
	// 1. 名称
	let name: string | undefined = flags.name || flags._positional;
	if (!name && ctx.hasUI) {
		const input = await promptWorktreeName(ctx);
		if (input === null) {
			ctx.ui.notify('Cancelled', 'warning');
			return;
		}
		if (input) name = input;
	}
	if (!name) name = pickAvailableName(repoRoot);

	// 2. 选择软链接目标
	const selections = await askSymlinkTargetsPanel(ctx);
	if (selections === null) {
		ctx.ui.notify('Cancelled', 'warning');
		return;
	}

	log.info('creating worktree', {
		name,
		nodeModulesStrategy: selections.nodeModulesStrategy,
		targetIds: selections.targets.map((t) => t.id).join(','),
	});

	// 3. 创建
	const result = createWorktree(
		repoRoot,
		name,
		flags.branch,
		selections.nodeModulesStrategy,
		selections,
	);
	if (!result.ok) {
		ctx.ui.notify(result.message, 'error');
		return;
	}

	ctx.ui.notify(result.message, 'info');

	// 4. 自动切换
	const targetDir = result.path!;
	_switchWithCreate(repoRoot, name, targetDir, ctx);
}

async function _switchWithCreate(
	repoRoot: string,
	name: string,
	targetDir: string,
	ctx: any,
): Promise<void> {
	// 切换到新 worktree — 询问策略
	const wtDir = targetDir;
	const sessionFile = findExistingSession(wtDir, repoRoot, name);
	const hasHistory = !!sessionFile;
	const strategy = await askSessionStrategy(ctx, name, hasHistory);

	if (strategy === 'cancel') return;

	if (strategy === 'resume' && sessionFile) {
		await switchToSession(ctx, wtDir, sessionFile);
	} else {
		// 新开会话
		const newSessionFile = createSession(wtDir, repoRoot, name);
		await switchToSession(ctx, wtDir, newSessionFile);
	}
}

// ═══════════════════════════════════════════
// use（切换）
// ═══════════════════════════════════════════

async function handleUse(repoRoot: string, flags: Record<string, string>, ctx: any): Promise<void> {
	const target = flags._positional || flags.name;
	if (!target) {
		ctx.ui.notify('Usage: /worktree use <name> or use main', 'warning');
		return;
	}

	const isMain = target === 'main';
	const targetCwd = isMain ? repoRoot : getWorktreePath(repoRoot, target);

	if (!existsSync(targetCwd)) {
		ctx.ui.notify(
			isMain ? 'Main repo root not found.' : `Worktree '${target}' not found at ${targetCwd}`,
			'error',
		);
		return;
	}

	// 验证 git 有效性
	const repoOfTarget = getRepoRoot(targetCwd);
	if (!repoOfTarget) {
		ctx.ui.notify(
			`${isMain ? 'Main repo' : `Worktree '${target}'`} is not a valid git repository.`,
			'error',
		);
		return;
	}

	// 询问操作策略
	const sessionFile = findExistingSession(targetCwd, repoRoot, target);
	const hasHistory = !!sessionFile;
	const strategy = await askSessionStrategy(ctx, target, hasHistory);

	if (strategy === 'cancel') return;

	// 策略1：仅 checkout 分支，不切换 session
	// 仅对 main 目标有效——worktree 分支已被对应目录占用，git 禁止重复 checkout
	if (strategy === 'checkout') {
		const currentBranch = getCurrentBranch(repoRoot);
		if (currentBranch === 'main') {
			ctx.ui.notify('Already on branch main', 'info');
			return;
		}
		try {
			execSync('git checkout main', { cwd: repoRoot, encoding: 'utf-8' });
			ctx.ui.notify("Switched to branch 'main'", 'success');
		} catch (err: any) {
			ctx.ui.notify(`Checkout failed: ${err.stderr?.trim() || err.message}`, 'error');
		}
		return;
	}

	// 策略2-4：切换 session
	let fileToUse: string;
	if (strategy === 'resume' && sessionFile) {
		fileToUse = sessionFile;
	} else if (strategy === 'clone') {
		// clone 当前会话到 worktree 目录
		const sourceFile: string | undefined = ctx.sessionManager?.getSessionFile?.();
		if (!sourceFile || !existsSync(sourceFile)) {
			ctx.ui.notify('No active session file to clone from.', 'error');
			return;
		}
		// 检查是否已有 clone 版本
		const existingClone = hasClonedSession(targetCwd, repoRoot);
		if (existingClone) {
			// 已有 clone, 询问是否覆盖
			try {
				const overwrite = await ctx.ui.confirm?.(
					`Worktree '${target}' already has a cloned session from this project.\n` +
						'Overwrite with current session? [Y] Yes [N] Keep existing [Esc] Cancel',
				);
				if (overwrite === false) {
					// 保留现有 clone 会话
					const existingFile = findClonedSessionFile(targetCwd, repoRoot);
					if (existingFile) {
						await switchToSession(ctx, targetCwd, existingFile);
					} else {
						ctx.ui.notify(
							'Found clone meta but no session file. Creating new session.',
							'warning',
						);
						fileToUse = createSession(targetCwd, repoRoot, target);
						await switchToSession(ctx, targetCwd, fileToUse);
					}
					return;
				}
				if (overwrite === undefined) return; // 取消
			} catch {
				/* ui.confirm 不支持 */
			}
		}
		fileToUse = cloneSession(sourceFile, targetCwd);
	} else {
		fileToUse = createSession(targetCwd, repoRoot, target);
	}

	log.info('switching', { target, cwd: targetCwd, sessionFile: fileToUse });
	await switchToSession(ctx, targetCwd, fileToUse);
}

// ═══════════════════════════════════════════
// fork（携带上下文切换）
// ═══════════════════════════════════════════

async function handleFork(repoRoot: string, target: string, ctx: any): Promise<void> {
	const isMain = target === 'main';
	const targetCwd = isMain ? repoRoot : getWorktreePath(repoRoot, target);

	if (!existsSync(targetCwd)) {
		ctx.ui.notify(
			isMain ? 'Main repo root not found.' : `Worktree '${target}' not found.`,
			'error',
		);
		return;
	}

	log.info('fork switching', { target, cwd: targetCwd });

	// 克隆当前会话到目标 worktree
	const sourceFile: string | undefined = ctx.sessionManager?.getSessionFile?.();
	if (!sourceFile || !existsSync(sourceFile)) {
		ctx.ui.notify('No active session to clone from. Creating new session.', 'warning');
		const sessionFile = createSession(targetCwd, repoRoot, target);
		await switchToSession(ctx, targetCwd, sessionFile);
		return;
	}

	const sessionFile = cloneSession(sourceFile, targetCwd);
	await switchToSession(ctx, targetCwd, sessionFile);
}

// ═══════════════════════════════════════════
// list
// ═══════════════════════════════════════════

function handleList(repoRoot: string, ctx: any): void {
	const wts = getManagedWorktrees(repoRoot);
	if (wts.length === 0) {
		ctx.ui.notify('No managed worktrees.', 'info');
		return;
	}
	const lines = wts.map((wt) => `  ${wt.name} -> ${wt.branch}`);
	ctx.ui.notify(`Worktrees:\n${lines.join('\n')}`, 'info');
}

// ═══════════════════════════════════════════
// delete
// ═══════════════════════════════════════════

async function handleDelete(
	repoRoot: string,
	flags: Record<string, string>,
	ctx: any,
): Promise<void> {
	const name = flags._positional || flags.name;
	if (!name) {
		ctx.ui.notify('Usage: /worktree delete <name>', 'warning');
		return;
	}

	const currentName = _getCurrentName(repoRoot, ctx.cwd);
	const isCurrent = currentName === name;

	// 先确认
	const confirmed = await confirmDelete(ctx, name);
	if (!confirmed) {
		ctx.ui.notify('Cancelled', 'info');
		return;
	}

	// 如果是当前 worktree，先切回 main
	if (isCurrent) {
		ctx.ui.notify(`Currently in worktree "${name}". Switching to main first...`, 'info');
		const mainSessionFile = createSession(repoRoot, repoRoot, 'main');
		await switchToSession(ctx, repoRoot, mainSessionFile);
	}

	// 尝试安全删除
	let result = removeWorktree(repoRoot, name);

	// 脏文件？
	if (
		!result.ok &&
		(result.message.includes('modified') ||
			result.message.includes('untracked') ||
			result.message.includes('contains'))
	) {
		const preview = _dirtyPreview(getWorktreePath(repoRoot, name));
		const forceOk = await confirmForceDelete(ctx, name, preview);
		if (forceOk) {
			result = removeWorktree(repoRoot, name, true);
		} else {
			ctx.ui.notify(result.message, 'error');
			return;
		}
	}

	if (!result.ok) {
		ctx.ui.notify(result.message, 'error');
		return;
	}

	// 分支处理：检查是否已合并
	const branch = `wt/${name}`;
	const mergedCheck = spawnSync('git', ['merge-base', '--is-ancestor', branch, 'HEAD'], {
		cwd: repoRoot,
		encoding: 'utf-8',
	});
	const unmerged = mergedCheck.status !== 0;
	const branchDecision = await askBranchDelete(ctx, name, unmerged);
	if (branchDecision === 'delete') {
		const branchMsgs = deleteWorktreeBranch(repoRoot, name, true);
		result.message += '\n' + branchMsgs.join('\n');
	} else if (branchDecision === 'keep') {
		result.message += '\n(branch kept)';
	}

	ctx.ui.notify(result.message, 'info');
}

// ═══════════════════════════════════════════
// merge
// ═══════════════════════════════════════════

export interface MergeResult {
	ok: boolean;
	message: string;
	conflicts: Array<{ file: string; lines: string }>;
	/** 当前所在分支（冲突时留在 targetBranch） */
	currentBranch?: string;
	/** 是否进行了 stash（用户后续需处理） */
	stashed?: boolean;
	/** 切换 stash 前的原始分支（用于 abort 时恢复） */
	originalBranch?: string;
}

export function execMerge(
	repo: string,
	sourceBranch: string,
	targetBranch: string,
	strategy: MergeStrategy = 'merge',
): MergeResult {
	const git = (args: string[]) =>
		spawnSync('git', args, { cwd: repo, encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 });

	const origBranch = getCurrentBranch(repo);
	let dirty = '';
	let stashed = false;
	try {
		dirty = execSync('git status --porcelain', { cwd: repo, encoding: 'utf-8' }).trim();
	} catch {
		/* may not be a git repo in merge context */
	}

	if (dirty) {
		const stash = git(['stash', 'push', '-m', 'worktree-merge-auto-' + Date.now()]);
		if (stash.status !== 0) {
			return { ok: false, message: 'Cannot stash changes', conflicts: [] };
		}
		stashed = true;
	}

	const checkout = git(['checkout', targetBranch]);
	if (checkout.status !== 0) {
		if (stashed) git(['stash', 'pop']);
		return { ok: false, message: "Cannot checkout '" + targetBranch + "'", conflicts: [] };
	}

	const hasRemote = git(['remote', 'get-url', 'origin']).status === 0;
	if (hasRemote) {
		git(['pull', 'origin', targetBranch, '--ff-only']);
	}

	const isSquash = strategy === 'squash';
	const merge = git(
		isSquash
			? ['merge', sourceBranch, '--squash']
			: ['merge', sourceBranch, '--no-ff', '--log'],
	);

	if (merge.status === 0) {
		// squash 需手动提交
		if (isSquash) {
			const commit = git([
				'commit',
				'-m',
				`Squash merge '${sourceBranch}' -> '${targetBranch}'`,
			]);
			if (commit.status !== 0) {
				git(['checkout', origBranch]);
				if (stashed) git(['stash', 'pop']);
				return {
					ok: false,
					message: 'Squash merge succeeded but commit failed',
					conflicts: [],
				};
			}
		}
		git(['checkout', origBranch]);
		if (stashed) git(['stash', 'pop']);
		return {
			ok: true,
			message: "Merged '" + sourceBranch + "' -> '" + targetBranch + "' (" + strategy + ')',
			conflicts: [],
		};
	}

	const unmerged = (git(['diff', '--name-only', '--diff-filter=U']).stdout || '').trim();
	const conflictFiles = unmerged
		.split('\n')
		.filter(Boolean)
		.map((f) => ({
			file: f,
			lines: (git(['diff', '--', f]).stdout || '')
				.split('\n')
				.filter((l) => l.startsWith('@@'))
				.slice(0, 3)
				.join('; '),
		}));

	if (conflictFiles.length > 0) {
		// P0-1: 冲突
		if (isSquash) {
			// squash merge 不产生 MERGE_HEAD，/worktree continue/abort 均不可用
			// 必须主动 reset 清理工作区
			git(['reset', '--hard', 'HEAD']);
			git(['checkout', origBranch]);
			if (stashed) git(['stash', 'pop']);
			return {
				ok: false,
				message:
					'Squash merge conflict in ' +
					conflictFiles.length +
					' file(s). Working tree has been reset. Resolve conflicts in the worktree and re-run merge.',
				conflicts: conflictFiles,
			};
		}
		// 普通 merge：留在 targetBranch，用户解决后用 /worktree continue
		return {
			ok: false,
			message: 'Merge failed. ' + conflictFiles.length + ' file(s) conflict.',
			conflicts: conflictFiles,
			currentBranch: targetBranch,
			stashed,
			originalBranch: stashed ? origBranch : undefined,
		};
	}

	// 非冲突失败（分支不存在等）→ 恢复原始状态
	git(['checkout', origBranch]);
	if (stashed) git(['stash', 'pop']);
	const stderr = merge.stderr?.trim() || 'unknown error';
	return {
		ok: false,
		message: 'Merge failed: ' + stderr.split('\n').pop(),
		conflicts: [],
	};
}

// ═══════════════════════════════════════════
// rebase + fast-forward（线性历史，无 merge commit）
// ═══════════════════════════════════════════

/**
 * Rebase worktree 分支到 target 分支后 fast-forward 合并。
 *
 * 核心约束：sourceBranch 在 worktree 中被 checkout，git 禁止从主仓库 rebase 它。
 * 因此 rebase 操作必须从 worktree 目录内执行（那里 branch 已是当前 HEAD）。
 *
 * 流程：
 *   1. stash 主仓库 dirty
 *   2. fetch + checkout target（主仓库内完成，target 即 main，不是 worktree branch）
 *   3. 在 worktree 目录内 `git rebase origin/<target>`（当前 HEAD = sourceBranch）
 *   4. 若冲突 → abort（从 worktree 内），恢复原始状态，报告
 *   5. 切回主仓库 target → `git merge <sourceBranch> --ff-only`（此时已可 ff）
 *   6. 恢复原始分支，pop stash
 *
 * @param sourceDir source worktree 的实际目录路径（rebase 在此目录内执行）
 */
export function execRebaseFF(
	repo: string,
	sourceBranch: string,
	targetBranch: string,
	sourceDir: string,
): MergeResult {
	const mainGit = (args: string[]) =>
		spawnSync('git', args, { cwd: repo, encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 });
	const wtGit = (args: string[]) =>
		spawnSync('git', args, { cwd: sourceDir, encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 });

	if (!existsSync(sourceDir)) {
		return { ok: false, message: 'Worktree directory not found: ' + sourceDir, conflicts: [] };
	}

	// 验证 worktree 的 HEAD 确实是 sourceBranch
	const wtBranch = getCurrentBranch(sourceDir);
	if (wtBranch !== sourceBranch) {
		return {
			ok: false,
			message:
				"Worktree is on '" +
				wtBranch +
				"', expected '" +
				sourceBranch +
				"'. Cannot rebase.",
			conflicts: [],
		};
	}

	// 检查 worktree 是否有脏文件（rebase 前清理，避免 git 拒绝的模糊报错）
	try {
		const wtDirty = execSync('git status --porcelain', {
			cwd: sourceDir,
			encoding: 'utf-8',
		}).trim();
		if (wtDirty) {
			return {
				ok: false,
				message:
					"Worktree '" +
					sourceBranch +
					"' has uncommitted changes. Commit or stash them first.",
				conflicts: [],
			};
		}
	} catch {
		/* worktree dir might be inaccessible, skip dirty check */
	}

	const origBranch = getCurrentBranch(repo);
	let mainDirty = '';
	let mainStashed = false;
	try {
		mainDirty = execSync('git status --porcelain', { cwd: repo, encoding: 'utf-8' }).trim();
	} catch {
		/* git inaccessible, treat as clean */
	}

	if (mainDirty) {
		const stashResult = mainGit(['stash', 'push', '-m', 'worktree-merge-auto-' + Date.now()]);
		if (stashResult.status !== 0) {
			return { ok: false, message: 'Cannot stash changes in main repo', conflicts: [] };
		}
		mainStashed = true;
	}

	// Fetch + checkout target（主仓库内）
	const hasRemote = mainGit(['remote', 'get-url', 'origin']).status === 0;
	if (hasRemote) {
		mainGit(['fetch', 'origin', targetBranch, '--quiet']);
	}

	const checkout = mainGit(['checkout', targetBranch]);
	if (checkout.status !== 0) {
		if (mainStashed) mainGit(['stash', 'pop']);
		return { ok: false, message: "Cannot checkout '" + targetBranch + "'", conflicts: [] };
	}

	if (hasRemote) {
		const pull = mainGit(['pull', 'origin', targetBranch, '--ff-only']);
		if (pull.status !== 0) {
			mainGit(['checkout', origBranch]);
			if (mainStashed) mainGit(['stash', 'pop']);
			return {
				ok: false,
				message: "Pull on '" + targetBranch + "' failed, aborting.",
				conflicts: [],
			};
		}
	}

	// ═══════════════════════════════════════════════
	// Rebase 在 worktree 目录内执行
	// 不需要指定 branch——worktree 的 HEAD 就是 sourceBranch
	// ═══════════════════════════════════════════════
	const ontoRef = hasRemote ? 'origin/' + targetBranch : targetBranch;
	const rebase = wtGit(['rebase', ontoRef]);

	if (rebase.status !== 0) {
		const unmerged = (wtGit(['diff', '--name-only', '--diff-filter=U']).stdout || '').trim();
		const conflictFiles = unmerged.split('\n').filter(Boolean);

		if (conflictFiles.length > 0) {
			// 从 worktree 内 abort
			wtGit(['rebase', '--abort']);
			// 恢复主仓库
			mainGit(['checkout', origBranch]);
			if (mainStashed) mainGit(['stash', 'pop']);
			return {
				ok: false,
				message:
					'Rebase conflict: ' +
					conflictFiles.length +
					' file(s). Resolve conflicts in worktree and re-run merge with rebase+ff.',
				conflicts: conflictFiles.map((f) => ({
					file: f,
					lines: (wtGit(['diff', '--', f]).stdout || '')
						.split('\n')
						.filter((l) => l.startsWith('@@'))
						.slice(0, 3)
						.join('; '),
				})),
			};
		}

		// 非冲突失败——恢复主仓库
		mainGit(['checkout', origBranch]);
		if (mainStashed) mainGit(['stash', 'pop']);
		const stderr = rebase.stderr?.trim() || 'unknown error';
		return {
			ok: false,
			message: 'Rebase failed: ' + stderr.split('\n').pop(),
			conflicts: [],
		};
	}

	// Rebase 成功 → 切回主仓库 target → fast-forward merge
	mainGit(['checkout', targetBranch]);
	if (hasRemote) {
		const pull = mainGit(['pull', 'origin', targetBranch, '--ff-only']);
		if (pull.status !== 0) {
			mainGit(['checkout', origBranch]);
			if (mainStashed) mainGit(['stash', 'pop']);
			return {
				ok: false,
				message: "Pull on '" + targetBranch + "' failed after rebase, aborting.",
				conflicts: [],
			};
		}
	}

	const ffMerge = mainGit(['merge', sourceBranch, '--ff-only']);
	if (ffMerge.status !== 0) {
		mainGit(['checkout', origBranch]);
		if (mainStashed) mainGit(['stash', 'pop']);
		return {
			ok: false,
			message: 'Fast-forward merge failed after rebase (unexpected)',
			conflicts: [],
		};
	}

	mainGit(['checkout', origBranch]);
	if (mainStashed) mainGit(['stash', 'pop']);
	return {
		ok: true,
		message: "Rebased '" + sourceBranch + "' and fast-forward merged -> '" + targetBranch + "'",
		conflicts: [],
	};
}

async function handleMerge(
	repoRoot: string,
	flags: Record<string, string>,
	ctx: any,
): Promise<void> {
	const allWorktrees = getManagedWorktrees(repoRoot);
	const currentName = _getCurrentName(repoRoot, ctx.cwd);

	let sourceWorktree = flags.source || currentName || '';
	if (!sourceWorktree && allWorktrees.length > 0 && ctx.hasUI) {
		// Pick source from TUI
		const result = await showWorktreeTui(
			ctx,
			allWorktrees,
			currentName,
			'Select source to merge:',
			repoRoot,
		);
		if (
			result.action !== 'switch' &&
			result.action !== 'fork' &&
			result.action !== 'operations'
		) {
			ctx.ui.notify('Cancelled', 'info');
			return;
		}
		sourceWorktree = result.target || '';
	}

	if (!sourceWorktree || sourceWorktree === 'main') {
		ctx.ui.notify('Please specify --source <worktree-name>', 'warning');
		return;
	}

	const sourceBranch = 'wt/' + sourceWorktree;
	const targetBranch = flags.target || 'main';

	// ── 策略选择 ──
	let strategy: MergeStrategy = 'merge';
	if (flags.strategy === 'squash' || flags.strategy === 'rebase-ff') {
		strategy = flags.strategy;
	} else if (ctx.hasUI) {
		const picked = await askMergeStrategy(ctx);
		if (!picked) {
			ctx.ui.notify('Cancelled', 'info');
			return;
		}
		strategy = picked;
	}

	const strategyLabel = { merge: 'merge', squash: 'squash', 'rebase-ff': 'rebase+ff' }[strategy];

	log.info('merging', {
		source: sourceBranch,
		target: targetBranch,
		strategy,
		repo: basename(repoRoot),
	});

	// P2-6: 合并前确认
	if (ctx.hasUI) {
		let confirmed: boolean;
		if (strategy === 'rebase-ff') {
			confirmed = await confirmRebaseFF(ctx, sourceWorktree, sourceBranch, targetBranch);
		} else {
			confirmed = await ctx.ui.confirm(
				`Merge '${sourceBranch}' -> '${targetBranch}'? (${strategyLabel})`,
			);
		}
		if (!confirmed) {
			ctx.ui.notify('Cancelled', 'info');
			return;
		}
	}

	ctx.ui.notify(
		"Merging '" + sourceBranch + "' -> '" + targetBranch + "'... ['" + strategyLabel + "']",
		'info',
	);

	let result: MergeResult;
	if (strategy === 'rebase-ff') {
		const sourceDir = getWorktreePath(repoRoot, sourceWorktree);
		result = execRebaseFF(repoRoot, sourceBranch, targetBranch, sourceDir);
	} else {
		result = execMerge(repoRoot, sourceBranch, targetBranch, strategy);
	}

	// 根据策略选择 post-merge guide 类型
	const guideType: 'merge' | 'rebase' | 'rebase-ff' =
		strategy === 'rebase-ff' ? 'rebase-ff' : strategy === 'squash' ? 'merge' : 'merge';

	if (result.ok) {
		if (ctx.hasUI) {
			await showPostMergeGuide(ctx, repoRoot, result.message, guideType, targetBranch);
		} else {
			ctx.ui.notify(result.message, 'success');
		}
	} else if (result.conflicts.length > 0) {
		const stashMsg = result.stashed
			? '\n(note: your dirty files were auto-stashed; use /worktree abort to restore)'
			: '';
		if (ctx.hasUI) {
			await showConflictPanel(ctx, result.conflicts, repoRoot, stashMsg);
		} else {
			const summary = result.conflicts.map((c) => '  - ' + c.file).join('\n');
			ctx.ui.notify(
				'Merge conflict in ' +
					result.conflicts.length +
					' file(s):\n' +
					summary +
					stashMsg +
					'\nUse /worktree continue or /worktree abort',
				'error',
			);
		}
	} else {
		ctx.ui.notify('Merge failed: ' + result.message, 'error');
		// execMerge 可能在冲突后留下 MERGE_HEAD，需要清理
		// execRebaseFF 已自行清理，此处 abort 无害——无 merge 时 git 静默失败
		try {
			execSync('git merge --abort', {
				cwd: repoRoot,
				encoding: 'utf-8',
				timeout: 5000,
			});
		} catch {
			/* no merge in progress, nothing to abort */
		}
	}
}

// ═══════════════════════════════════════════
// rebase
// ═══════════════════════════════════════════

async function handleRebase(
	repoRoot: string,
	flags: Record<string, string>,
	ctx: any,
): Promise<void> {
	const allWorktrees = getManagedWorktrees(repoRoot);
	const currentName = _getCurrentName(repoRoot, ctx.cwd);

	let sourceWorktree = flags.source || currentName || '';
	if (!sourceWorktree && allWorktrees.length > 0 && ctx.hasUI) {
		// Pick source from TUI
		const result = await showWorktreeTui(
			ctx,
			allWorktrees,
			currentName,
			'Select source to rebase:',
			repoRoot,
		);
		if (
			result.action !== 'switch' &&
			result.action !== 'fork' &&
			result.action !== 'operations'
		) {
			ctx.ui.notify('Cancelled', 'info');
			return;
		}
		sourceWorktree = result.target || '';
	}

	if (!sourceWorktree || sourceWorktree === 'main') {
		ctx.ui.notify(
			'Please specify --source <worktree-name> or switch to a worktree first.',
			'warning',
		);
		return;
	}

	const sourceBranch = 'wt/' + sourceWorktree;
	const ontoBranch = flags.target || 'main';

	log.info('rebasing', { source: sourceBranch, onto: ontoBranch, repo: basename(repoRoot) });
	ctx.ui.notify(`Rebasing '${sourceBranch}' onto '${ontoBranch}'...`, 'info');

	const result = execRebase(repoRoot, sourceBranch, ontoBranch);

	if (result.ok) {
		// P0-2: rebase 成功 → 步骤引导
		if (ctx.hasUI) {
			await showPostMergeGuide(ctx, repoRoot, result.message, 'rebase');
		} else {
			ctx.ui.notify(result.message, 'success');
		}
	} else if (result.conflicts.length > 0) {
		// P0-1: 冲突保留（execRebase 已不再自动 abort）
		const conflictItems = result.conflicts.map((f) => ({ file: f, lines: '' }));
		if (ctx.hasUI) {
			await showConflictPanel(ctx, conflictItems, repoRoot);
		} else {
			const summary = result.conflicts.map((f) => '  - ' + f).join('\n');
			ctx.ui.notify(
				'Rebase conflict in ' +
					result.conflicts.length +
					' file(s):\n' +
					summary +
					'\nUse /worktree continue or /worktree abort',
				'error',
			);
		}
	} else {
		ctx.ui.notify('Rebase failed: ' + result.message, 'error');
		try {
			execSync('git rebase --abort', { cwd: repoRoot, encoding: 'utf-8' });
		} catch {
			/* ignore */
		}
	}
}

// ═══════════════════════════════════════════
// 操作子菜单分发
// ═══════════════════════════════════════════

async function handleOperationsSubmenu(
	repoRoot: string,
	worktreeName: string,
	ctx: any,
): Promise<void> {
	const subResult = await showOperationSubmenu(ctx, worktreeName);

	switch (subResult.action) {
		case 'switch':
			await handleUse(repoRoot, { _positional: worktreeName }, ctx);
			break;
		case 'fork':
			await handleFork(repoRoot, worktreeName, ctx);
			break;
		case 'merge':
			await handleMerge(repoRoot, { source: worktreeName }, ctx);
			break;
		case 'rebase':
			await handleRebase(repoRoot, { source: worktreeName }, ctx);
			break;
		case 'delete':
			await handleDelete(repoRoot, { _positional: worktreeName }, ctx);
			break;
		case 'shell':
			handleShell(repoRoot, ctx, worktreeName);
			break;
		case 'cancel':
			// 返回面板
			await handlePanel(repoRoot, ctx);
			break;
	}
}

// ═══════════════════════════════════════════
// clean
// ═══════════════════════════════════════════

async function handleClean(
	repoRoot: string,
	flags: Record<string, string>,
	ctx: any,
): Promise<void> {
	const currentName = _getCurrentName(repoRoot, ctx.cwd);
	const exclude = new Set(currentName ? [currentName] : []);
	const dryRun = flags.dry !== undefined || flags['dry-run'] !== undefined;

	const merged = findMergedWorktrees(repoRoot, exclude);
	if (merged.length === 0) {
		ctx.ui.notify('No merged worktrees to clean.', 'info');
		return;
	}
	if (dryRun) {
		ctx.ui.notify(
			`Would remove:\n${merged.map((m) => `  ${m.name} (${m.branch})`).join('\n')}`,
			'info',
		);
		return;
	}

	// P1-1: 确认弹窗
	if (ctx.hasUI) {
		const confirmed = await ctx.ui.confirm(`Delete ${merged.length} merged worktree(s)?`, {
			detail: merged.map((m) => `  ${m.name} (${m.branch})`).join('\n'),
		});
		if (!confirmed) {
			ctx.ui.notify('Cleaning cancelled.', 'info');
			return;
		}
	}

	const results: string[] = [];
	for (const wt of merged) {
		const r = removeWorktree(repoRoot, wt.name);
		results.push(r.ok ? 'Removed ' + wt.name : r.message);
		if (r.ok) {
			results.push(...deleteWorktreeBranch(repoRoot, wt.name, true));
		}
	}
	ctx.ui.notify(results.join('\n'), 'info');
}

// ═══════════════════════════════════════════
// continue（P0-3）
// ═══════════════════════════════════════════

async function handleContinue(repoRoot: string, ctx: any): Promise<void> {
	const isMerge = isMergeInProgress(repoRoot);
	const isRebase = isRebaseInProgress(repoRoot);

	if (!isMerge && !isRebase) {
		ctx.ui.notify('No merge or rebase in progress.', 'info');
		return;
	}

	ctx.ui.notify('Continuing...', 'info');

	if (isRebase) {
		try {
			execSync('git add -u', { cwd: repoRoot, encoding: 'utf-8' });
			execSync('git rebase --continue', { cwd: repoRoot, encoding: 'utf-8' });
			ctx.ui.notify('Rebase continued successfully.', 'success');
			// 尝试 pop stash（如果有的话）
			popWorktreeStash(repoRoot);
		} catch (err: any) {
			ctx.ui.notify('Continue failed: ' + (err.stderr?.trim() || err.message), 'error');
		}
		return;
	}

	if (isMerge) {
		// 合并需要用户先 git add 解决冲突的文件
		const conflictFiles = getConflictFiles(repoRoot);
		if (conflictFiles.length > 0) {
			ctx.ui.notify(
				'Merge conflict still present. Resolve conflicts first, then /worktree continue.\n' +
					'  Or use /worktree abort to cancel.',
				'warning',
			);
			return;
		}
		// 无冲突 → 尝试 git merge --continue
		try {
			execSync('git merge --continue --no-edit', {
				cwd: repoRoot,
				encoding: 'utf-8',
			});
			ctx.ui.notify('Merge continued successfully.', 'success');
			popWorktreeStash(repoRoot);
		} catch (err: any) {
			ctx.ui.notify('Continue failed: ' + (err.stderr?.trim() || err.message), 'error');
		}
	}
}

// ═══════════════════════════════════════════
// abort（P0-3）
// ═══════════════════════════════════════════

async function handleAbort(repoRoot: string, ctx: any): Promise<void> {
	const isMerge = isMergeInProgress(repoRoot);
	const isRebase = isRebaseInProgress(repoRoot);

	if (!isMerge && !isRebase) {
		ctx.ui.notify('No merge or rebase to abort.', 'info');
		return;
	}

	ctx.ui.notify('Aborting...', 'info');

	if (isRebase) {
		try {
			execSync('git rebase --abort', { cwd: repoRoot, encoding: 'utf-8' });
			ctx.ui.notify('Rebase aborted.', 'success');
			popWorktreeStash(repoRoot);
		} catch (err: any) {
			ctx.ui.notify('Abort failed: ' + (err.stderr?.trim() || err.message), 'error');
		}
	}
	if (isMerge) {
		try {
			execSync('git merge --abort', { cwd: repoRoot, encoding: 'utf-8' });
			ctx.ui.notify('Merge aborted.', 'success');
			popWorktreeStash(repoRoot);
		} catch (err: any) {
			ctx.ui.notify('Abort failed: ' + (err.stderr?.trim() || err.message), 'error');
		}
	}
}

// ═══════════════════════════════════════════
// status（P0-3）
// ═══════════════════════════════════════════

function handleStatus(repoRoot: string, ctx: any): void {
	const isMerge = isMergeInProgress(repoRoot);
	const isRebase = isRebaseInProgress(repoRoot);

	if (isRebase) {
		const conflicts = getConflictFiles(repoRoot);
		let branch = 'unknown';
		try {
			branch = execSync('git rev-parse --abbrev-ref HEAD', {
				cwd: repoRoot,
				encoding: 'utf-8',
			}).trim();
		} catch {
			/* ignore */
		}
		const msg =
			'Rebase in progress on ' +
			branch +
			(conflicts.length > 0 ? '\nConflict files: ' + conflicts.join(', ') : '');
		ctx.ui.notify(msg, 'info');
	} else if (isMerge) {
		const source = getMergeSourceBranch(repoRoot);
		const conflicts = getConflictFiles(repoRoot);
		const msg =
			'Merge in progress' +
			(source ? ' (merging ' + source + ')' : '') +
			(conflicts.length > 0 ? '\nConflict files: ' + conflicts.join(', ') : '');
		ctx.ui.notify(msg, 'info');
	} else {
		ctx.ui.notify('No merge or rebase in progress.', 'info');
	}
}

// ═══════════════════════════════════════════
// shell
// ═══════════════════════════════════════════

// ═══════════════════════════════════════════
// widget（切换 widget 可见性）
// ═══════════════════════════════════════════

function handleWidget(flags: Record<string, string>, ctx: any): void {
	const arg = flags._positional || '';
	if (arg === 'off') {
		log.info('widget hidden');
		try {
			// 尝试通过 widget-wrangler 或直接设置 widget
			ctx.ui.setStatus?.('pi-worktree', '');
		} catch {
			/* ignore */
		}
		ctx.ui.notify('Worktree widget hidden', 'info');
	} else if (arg === 'on') {
		log.info('widget visible');
		const repoRoot = getRepoRoot(ctx.cwd);
		if (repoRoot) {
			const wts = getManagedWorktrees(repoRoot);
			const currentName = _getCurrentName(repoRoot, ctx.cwd);
			const label = currentName ? `wt:${currentName}` : `main:${wts.length}`;
			try {
				ctx.ui.setStatus?.('pi-worktree', label);
			} catch {
				/* ignore */
			}
		}
		ctx.ui.notify('Worktree widget visible', 'info');
	} else {
		ctx.ui.notify(
			'Usage: /worktree widget <on|off>\n  on   Show worktree widget in status bar\n  off  Hide worktree widget',
			'info',
		);
	}
}

function handleShell(repoRoot: string, ctx: any, targetName?: string): void {
	const name = targetName || _getCurrentName(repoRoot, ctx.cwd);
	if (!name) {
		ctx.ui.notify('No active worktree. Switch to one first.', 'warning');
		return;
	}

	const isMain = name === 'main';
	const targetDir = isMain ? repoRoot : getWorktreePath(repoRoot, name);
	if (!existsSync(targetDir)) {
		ctx.ui.notify(`Worktree directory not found: ${targetDir}`, 'error');
		return;
	}

	const inTmux = !!process.env.TMUX;
	const inWarp =
		process.env.TERM_PROGRAM === 'WarpTerminal' || !!process.env.WARP_IS_LOCAL_SHELL_SESSION;
	const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';

	if (inTmux) {
		spawn('tmux', ['split-window', '-h', '-c', targetDir], { stdio: 'ignore' }).unref();
		ctx.ui.notify(`Opened shell in worktree "${name}"`, 'info');
	} else if (inWarp) {
		spawn(opener, [`warp://action/new_tab?path=${encodeURIComponent(targetDir)}`], {
			detached: true,
			stdio: 'ignore',
		}).unref();
		ctx.ui.notify(`Opened Warp tab for worktree "${name}"`, 'info');
	} else if (process.platform === 'darwin') {
		ctx.ui.notify(
			`Worktree path:\n  ${targetDir}\nUse 'cd "${targetDir}"' or open a new terminal.`,
			'info',
		);
	} else {
		ctx.ui.notify(`cd "${targetDir}"`, 'info');
	}
}
