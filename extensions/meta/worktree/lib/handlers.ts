/**
 * pi-worktree — 命令处理器
 */
import { createLogger } from '@zenone/pi-logger';
import { basename } from 'node:path';
import { spawnSync, spawn, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { getCurrentBranch } from './git.js';
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
	askSessionStrategy,
	askNodeModulesStrategy,
	promptWorktreeName,
	confirmDelete,
	confirmForceDelete,
	askBranchDelete,
} from './ui.js';
import {
	switchToSession,
	findExistingSession,
	createSession,
	cloneSession,
	hasClonedSession,
	findClonedSessionFile,
} from './session.js';
import { getLastNodeModulesStrategy } from '../state.js';

const log = createLogger('pi-worktree');

// ═══════════════════════════════════════════
// 入参解析
// ═══════════════════════════════════════════

function parseArgs(input: string): { command: string; flags: Record<string, string> } {
	const parts = input.trim().split(/\s+/);
	const command = parts[0] || 'help';
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
	'merge [--source <n>] [--target <b>]',
	'clean [--dry-run]',
	'shell',
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

	// 无参数：显示切换器面板
	if (command === 'help' || command === '') {
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
		case 'clean':
			await handleClean(repoRoot, flags, ctx);
			break;
		case 'shell':
			handleShell(repoRoot, ctx);
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
		case 'shell':
			handleShell(repoRoot, ctx);
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

	// 2. node_modules 策略
	const lastStrat = getLastNodeModulesStrategy();
	const nodeModulesStrategy = await askNodeModulesStrategy(ctx, lastStrat);
	if (nodeModulesStrategy === null) {
		ctx.ui.notify('Cancelled', 'warning');
		return;
	}

	log.info('creating worktree', { name, nodeModulesStrategy });

	// 3. 创建
	const result = createWorktree(repoRoot, name, flags.branch, nodeModulesStrategy);
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

export function execMerge(
	repo: string,
	sourceBranch: string,
	targetBranch: string,
): { ok: boolean; message: string; conflicts: Array<{ file: string; lines: string }> } {
	const git = (args: string[]) =>
		spawnSync('git', args, { cwd: repo, encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 });

	const origBranch = getCurrentBranch(repo);
	let dirty = '';
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
	}

	const checkout = git(['checkout', targetBranch]);
	if (checkout.status !== 0) {
		if (dirty) git(['stash', 'pop']);
		return { ok: false, message: "Cannot checkout '" + targetBranch + "'", conflicts: [] };
	}

	const hasRemote = git(['remote', 'get-url', 'origin']).status === 0;
	if (hasRemote) {
		git(['pull', 'origin', targetBranch, '--ff-only']);
	}

	const merge = git(['merge', sourceBranch, '--no-ff', '--log']);

	if (merge.status === 0) {
		git(['checkout', origBranch]);
		if (dirty) git(['stash', 'pop']);
		return {
			ok: true,
			message: "Merged '" + sourceBranch + "' -> '" + targetBranch + "'",
			conflicts: [],
		};
	}

	git(['checkout', origBranch]);
	if (dirty) git(['stash', 'pop']);

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

	return {
		ok: false,
		message: 'Merge failed. ' + conflictFiles.length + ' file(s) conflict.',
		conflicts: conflictFiles,
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
		if (result.action !== 'switch' && result.action !== 'fork') {
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

	log.info('merging', { source: sourceBranch, target: targetBranch, repo: basename(repoRoot) });
	ctx.ui.notify("Merging '" + sourceBranch + "' -> '" + targetBranch + "'...", 'info');

	const result = execMerge(repoRoot, sourceBranch, targetBranch);

	if (result.ok) {
		ctx.ui.notify(result.message, 'success');
	} else if (result.conflicts.length > 0) {
		const summary = result.conflicts.map((c) => '  - ' + c.file).join('\n');
		ctx.ui.notify(
			'Merge conflict in ' + result.conflicts.length + ' file(s):\n' + summary,
			'error',
		);
	} else {
		ctx.ui.notify('Merge failed: ' + result.message, 'error');
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
// shell
// ═══════════════════════════════════════════

function handleShell(repoRoot: string, ctx: any): void {
	const currentName = _getCurrentName(repoRoot, ctx.cwd);
	if (!currentName) {
		ctx.ui.notify('No active worktree. Switch to one first.', 'warning');
		return;
	}

	const targetDir = getWorktreePath(repoRoot, currentName);
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
		ctx.ui.notify(`Opened shell in worktree "${currentName}"`, 'info');
	} else if (inWarp) {
		spawn(opener, [`warp://action/new_tab?path=${encodeURIComponent(targetDir)}`], {
			detached: true,
			stdio: 'ignore',
		}).unref();
		ctx.ui.notify(`Opened Warp tab for worktree "${currentName}"`, 'info');
	} else if (process.platform === 'darwin') {
		ctx.ui.notify(
			`Worktree path:\n  ${targetDir}\nUse 'cd "${targetDir}"' or open a new terminal.`,
			'info',
		);
	} else {
		ctx.ui.notify(`cd "${targetDir}"`, 'info');
	}
}
