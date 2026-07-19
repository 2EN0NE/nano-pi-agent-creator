/**
 * pi-worktree — 命令处理器（/worktree create / delete / clean / use / list 等）
 */
import { createLogger } from '@zenone/pi-logger';
import { basename, join } from 'node:path';
import { spawnSync, spawn, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { getDefaultBranch, getCurrentBranch, bumpPackageVersion } from './git.js';
import {
	createWorktree,
	removeWorktree,
	deleteWorktreeBranch,
	getExistingWorktrees,
	findMergedWorktrees,
	pickAvailableName,
} from './worktree.js';
import { WORKTREES_DIR } from './setup.js';
import {
	registerWidget,
	confirmDelete,
	confirmForceDelete,
	promptWorktreeName,
	confirmDirtyStart,
} from './ui.js';

const log = createLogger('pi-worktree');
import {
	activeWorktree,
	activeWorktreePaths,
	setActiveWorktree,
	clearActiveWorktree,
	addWorktreePath,
	setWorktreeMode,
	setWidgetHidden,
	worktreeMode,
	widgetHidden,
	saveState,
	invalidateRepoCache,
} from '../state.js';

// ═══════════════════════════════════════════
// create

function checkDirty(repo: string): string[] {
	try {
		const out = execSync('git status --porcelain', {
			cwd: repo,
			encoding: 'utf-8',
			maxBuffer: 64 * 1024,
		});
		return out.trim().split('\n').filter(Boolean);
	} catch {
		return [];
	}
}

export async function handleCreate(
	repos: string[],
	flags: Record<string, string>,
	ctx: any,
	sessionId: string,
): Promise<void> {
	let targetRepos: string[] = [];
	if (flags.repos) {
		const selected = new Set(flags.repos.split(',').map((r) => r.trim()));
		targetRepos = repos.filter((r) => selected.has(basename(r)));
	} else if (ctx.hasUI) {
		const repoNames = repos.map((r) => basename(r));
		const picked = await (ctx.ui.custom as <T>(...args: any[]) => Promise<T>)<string[]>(
			(tui: any, theme: any, _keybindings: any, done: (v: any[]) => void) => {
				const selected = new Set<number>();
				let cursor = 0;
				let filter = '';
				const getFiltered = () =>
					!filter
						? repoNames.map((_, i) => i)
						: repoNames.reduce<number[]>((acc, n, i) => {
								if (n.toLowerCase().includes(filter.toLowerCase())) acc.push(i);
								return acc;
							}, []);
				return {
					render(_w: number): string[] {
						const lines: string[] = [];
						lines.push(
							theme.bold(
								' Select repos (space=toggle, enter=confirm, esc=cancel, type to filter)',
							),
						);
						lines.push(
							` ${theme.fg('accent', '\u276F')} ${filter || theme.fg('dim', 'type to filter...')}`,
						);
						lines.push('');
						const visible = getFiltered();
						for (let vi = 0; vi < visible.length; vi++) {
							const i = visible[vi];
							lines.push(
								`${vi === cursor ? theme.fg('accent', '\u276F ') : '  '}${selected.has(i) ? theme.fg('accent', '\u25CF') : '\u25CB'} ${repoNames[i]}`,
							);
						}
						lines.push('', theme.fg('dim', ` ${selected.size} selected`));
						return lines;
					},
					handleInput(data: string): void {
						const visible = getFiltered();
						if (data === '\x1B[A') cursor = Math.max(0, cursor - 1);
						else if (data === '\x1B[B')
							cursor = Math.min(visible.length - 1, cursor + 1);
						else if (data === ' ') {
							const i = visible[cursor];
							if (i !== undefined) {
								selected.has(i) ? selected.delete(i) : selected.add(i);
							}
						} else if (data === '\r' || data === '\n') {
							done([...selected].map((i) => repos[i]));
							return;
						} else if (data === '\x1B' || data === '\x03') {
							done([]);
							return;
						} else if (data === '\x7F' || data === '\b') {
							filter = filter.slice(0, -1);
							cursor = 0;
						} else if (data.length === 1 && data >= ' ') {
							filter += data;
							cursor = 0;
						}
						tui.requestRender();
					},
					invalidate(): void {},
				};
			},
			{
				overlay: true,
				overlayOptions: { anchor: 'bottom-center', width: '100%', maxHeight: '85%' },
			},
		);
		if (!picked || picked.length === 0) {
			ctx.ui.notify('Cancelled', 'warning');
			return;
		}
		targetRepos = picked;
	} else {
		targetRepos = repos;
	}

	if (targetRepos.length === 0) {
		ctx.ui.notify('No repos selected', 'warning');
		return;
	}

	// dirty 检查：有未提交更改则确认
	for (const repo of targetRepos) {
		const dirty = checkDirty(repo);
		if (dirty.length > 0) {
			const ok = await confirmDirtyStart(ctx, basename(repo), dirty);
			if (!ok) {
				ctx.ui.notify('Cancelled — commit or stash changes first', 'warning');
				return;
			}
		}
	}

	// 名字：优先 flags.name，其次 TUI 交互，取不到用自动生成
	let name: string | undefined = flags.name;
	if (!name && ctx.hasUI) {
		const input = await promptWorktreeName(ctx);
		if (input === null) {
			ctx.ui.notify('Cancelled', 'warning');
			return;
		}
		if (input !== '') name = input;
	}
	if (!name) name = pickAvailableName(targetRepos[0]);

	log.info('creating worktree', { name, repos: targetRepos.map((b) => basename(b)) });
	const results: string[] = [];
	clearActiveWorktree();

	for (const repo of targetRepos) {
		const result = createWorktree(repo, name, flags.branch);
		results.push(result.ok ? `\u2713 ${result.message}` : `\u2717 ${result.message}`);
		if (result.ok)
			addWorktreePath(basename(repo), result.path || join(repo, WORKTREES_DIR, name));
	}

	if (activeWorktreePaths.size > 0) {
		setActiveWorktree(name);
		registerWidget(ctx, { v: false });
		saveState(ctx.cwd, sessionId);
		invalidateRepoCache();
	}
	ctx.ui.notify(results.join('\n'), 'info');
}

// ═══════════════════════════════════════════
// list
// ═══════════════════════════════════════════
export function handleList(repos: string[], flags: Record<string, string>, ctx: any): void {
	const selectedRepos = flags.repos
		? repos.filter((r) => new Set(flags.repos.split(',').map((s) => s.trim())).has(basename(r)))
		: repos;
	const lines: string[] = [];
	for (const repo of selectedRepos) {
		const worktrees = getExistingWorktrees(repo);
		if (worktrees.length === 0) continue;
		lines.push(`${basename(repo)}:`);
		for (const wt of worktrees) lines.push(`  ${wt.name} \u2192 ${wt.branch}`);
	}
	ctx.ui.notify(lines.length > 0 ? lines.join('\n') : 'No worktrees found', 'info');
}

// ═══════════════════════════════════════════
// use
// ═══════════════════════════════════════════
export function handleUse(
	repos: string[],
	flags: Record<string, string>,
	ctx: any,
	sessionId: string,
): void {
	const name = flags._positional || flags.name;
	if (!name) {
		ctx.ui.notify('Usage: /worktree use <name>', 'warning');
		return;
	}

	const selectedRepos = flags.repos
		? repos.filter((r) => new Set(flags.repos.split(',').map((s) => s.trim())).has(basename(r)))
		: repos;
	clearActiveWorktree();

	for (const repo of selectedRepos) {
		const wtPath = join(repo, WORKTREES_DIR, name);
		if (existsSync(wtPath) && existsSync(join(wtPath, '.git')))
			addWorktreePath(basename(repo), wtPath);
	}

	if (activeWorktreePaths.size === 0) {
		ctx.ui.notify(`Worktree '${name}' not found in any repo`, 'warning');
		return;
	}
	setActiveWorktree(name);
	log.info('switched worktree', { name });
	registerWidget(ctx, { v: false });
	saveState(ctx.cwd, sessionId);
	ctx.ui.notify(`Activated worktree '${name}' (${activeWorktreePaths.size} repos)`, 'info');
}

// ═══════════════════════════════════════════
// stop
// ═══════════════════════════════════════════
export function handleStop(ctx: any, sessionId: string): void {
	if (!activeWorktree) {
		ctx.ui.notify('No active worktree', 'warning');
		return;
	}
	const prev = activeWorktree;
	clearActiveWorktree();
	log.info('stopped worktree', { prev: activeWorktree });
	registerWidget(ctx, { v: false });
	saveState(ctx.cwd, sessionId);
	ctx.ui.notify(`Deactivated worktree '${prev}'`, 'info');
}

// ═══════════════════════════════════════════
// mode / widget
// ═══════════════════════════════════════════
export function handleMode(ctx: any, sessionId: string, flags: Record<string, string>): void {
	const value = flags._positional?.toLowerCase();
	if (value === 'on') setWorktreeMode(true);
	else if (value === 'off') {
		setWorktreeMode(false);
		clearActiveWorktree();
		registerWidget(ctx, { v: false });
	} else setWorktreeMode(!worktreeMode);
	ctx.ui.notify(`Worktree mode: ${worktreeMode ? 'ON' : 'OFF'}`, 'info');
	saveState(ctx.cwd, sessionId);
}

export function handleWidget(ctx: any, sessionId: string, flags: Record<string, string>): void {
	const value = flags._positional?.toLowerCase();
	if (value === 'on' || value === 'show') setWidgetHidden(false);
	else if (value === 'off' || value === 'hide') setWidgetHidden(true);
	else setWidgetHidden(!widgetHidden);
	registerWidget(ctx, { v: false });
	saveState(ctx.cwd, sessionId);
	ctx.ui.notify(`Worktree widget: ${widgetHidden ? 'hidden' : 'visible'}`, 'info');
}

// ═══════════════════════════════════════════
// shell
// ═══════════════════════════════════════════
export function handleShell(ctx: any): void {
	if (!activeWorktree || activeWorktreePaths.size === 0) {
		ctx.ui.notify('No active worktree. Use /worktree use <name> first.', 'warning');
		return;
	}

	const inHerdr = !!process.env.HERDR_ENV || !!process.env.HERDR_PANE_ID;
	const inTmux = !!process.env.TMUX;
	const inWarp =
		process.env.TERM_PROGRAM === 'WarpTerminal' || !!process.env.WARP_IS_LOCAL_SHELL_SESSION;

	if (!inHerdr && !inTmux && !inWarp) {
		ctx.ui.notify('shell requires Herdr, tmux, or Warp Terminal.', 'error');
		return;
	}

	const paths = [...activeWorktreePaths.values()];

	if (inHerdr) {
		let sourcePane = process.env.HERDR_PANE_ID;
		for (let i = 0; i < paths.length; i++) {
			const args = [
				'pane',
				'split',
				'--direction',
				i === 0 ? 'right' : 'down',
				'--cwd',
				paths[i],
				'--no-focus',
			];
			if (sourcePane) args.splice(2, 0, sourcePane);
			const result = spawnSync('herdr', args, { encoding: 'utf-8' });
			if (result.status !== 0) {
				ctx.ui.notify(
					`herdr pane split failed: ${result.stderr?.trim() || result.error?.message || 'unknown error'}`,
					'error',
				);
				return;
			}
			if (i > 0) {
				try {
					const parsed = JSON.parse(result.stdout || '');
					const np = parsed?.result?.pane?.pane_id;
					if (np) sourcePane = np;
				} catch {
					/* ignore */
				}
			}
		}
	} else if (inTmux) {
		paths.forEach((p, i) =>
			spawn(
				'tmux',
				i === 0 ? ['split-window', '-h', '-c', p] : ['split-window', '-v', '-c', p],
				{ stdio: 'ignore' },
			),
		);
	} else {
		const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
		paths.forEach((p) =>
			spawn(opener, [`warp://action/new_tab?path=${encodeURIComponent(p)}`], {
				detached: true,
				stdio: 'ignore',
			}).unref(),
		);
	}

	ctx.ui.notify(
		`Opened shell in: ${[...activeWorktreePaths.keys()].slice(0, paths.length).join(', ')}`,
		'info',
	);
}

// ═══════════════════════════════════════════
// delete
// ═══════════════════════════════════════════
export async function handleDelete(
	repos: string[],
	flags: Record<string, string>,
	ctx: any,
	sessionId: string,
): Promise<void> {
	const name = flags._positional || flags.name;
	if (!name) {
		ctx.ui.notify('Usage: /worktree delete <name> [--repos repo1,repo2]', 'warning');
		return;
	}

	const confirmed = await confirmDelete(ctx, name);
	if (!confirmed) {
		ctx.ui.notify('Delete cancelled', 'info');
		return;
	}

	const selectedRepos = flags.repos
		? repos.filter((r) => new Set(flags.repos.split(',').map((s) => s.trim())).has(basename(r)))
		: repos;
	const results: string[] = [];
	const deleteRemote = flags.remote || 'origin';

	for (const repo of selectedRepos) {
		if (!existsSync(join(repo, WORKTREES_DIR, name))) continue;

		// 先尝试安全删除
		let result = removeWorktree(repo, name);
		let forceUsed = false;

		// 检测到脏文件——弹窗询问是否强制删除
		if (
			!result.ok &&
			(result.message.includes('modified') ||
				result.message.includes('untracked') ||
				result.message.includes('contains'))
		) {
			const forceOk = await confirmForceDelete(ctx, name, repo);
			if (forceOk) {
				result = removeWorktree(repo, name, true);
				forceUsed = true;
			}
		}

		results.push(
			result.ok
				? `\u2713 ${result.message}${forceUsed ? ' (--force)' : ''}`
				: `\u2717 ${result.message}`,
		);
		if (result.ok) {
			const branchMsgs = deleteWorktreeBranch(repo, name, deleteRemote);
			results.push(...branchMsgs.map((m) => `  ${m}`));
		}
	}

	if (results.length === 0) {
		ctx.ui.notify(`Worktree '${name}' not found in any repo`, 'warning');
		return;
	}

	// 删除成功（任意 repo）后，清理活跃状态 + 自动切回主分支
	if (activeWorktree === name) {
		clearActiveWorktree();
		registerWidget(ctx, { v: false });
		saveState(ctx.cwd, sessionId);
	}
	invalidateRepoCache();
	ctx.ui.notify(results.join('\n'), 'info');
}

// ═══════════════════════════════════════════
// clean
// ═══════════════════════════════════════════
export async function handleClean(
	repos: string[],
	flags: Record<string, string>,
	ctx: any,
): Promise<void> {
	const selectedRepos = flags.repos
		? repos.filter((r) => new Set(flags.repos.split(',').map((s) => s.trim())).has(basename(r)))
		: repos;
	const exclude = new Set<string>(activeWorktree ? [activeWorktree] : []);
	const dryRun = flags.dry !== undefined || flags['dry-run'] !== undefined;
	const bumpKind = (['major', 'minor', 'patch'].includes(flags.bump) ? flags.bump : 'patch') as
		'major' | 'minor' | 'patch';
	const skipPr = flags['no-pr'] !== undefined;

	ctx.ui.notify('Scanning for merged worktrees\u2026', 'info');

	const removedByRepo: Array<{ repo: string; name: string; branch: string }> = [];
	for (const repo of selectedRepos) {
		for (const wt of findMergedWorktrees(repo, exclude)) {
			removedByRepo.push({ repo, name: wt.name, branch: wt.branch });
		}
	}

	if (removedByRepo.length === 0) {
		ctx.ui.notify('No merged worktrees to clean.', 'info');
		return;
	}
	if (dryRun) {
		ctx.ui.notify(
			`Would remove ${removedByRepo.length} merged worktree(s):\n${removedByRepo.map((r) => `  ${basename(r.repo)}/${r.name} (${r.branch})`).join('\n')}`,
			'info',
		);
		return;
	}

	const results: string[] = [];
	for (const { repo, name } of removedByRepo) {
		const result = removeWorktree(repo, name);
		results.push(result.ok ? `\u2713 ${result.message}` : `\u2717 ${result.message}`);
		if (result.ok) {
			const branchMsgs = deleteWorktreeBranch(repo, name);
			results.push(...branchMsgs.map((m) => `  ${m}`));
		}
	}

	// bump & PR (仅限于 arvore-pi-extensions 仓库)
	//
	// ⚠ 自动 commit + push + gh pr create 是高危操作。
	// 推送前让用户审查变更内容。
	const confirmMsg =
		`即将执行以下操作：\n` +
		`1. 清理 ${removedByRepo.length} 个已合并 worktree\n` +
		`2. 版本号 bump (${bumpKind})\n` +
		`3. git commit + git push\n` +
		`4. 创建 PR\n\n` +
		`确认继续？`;
	if (!(await ctx.ui.confirm('Clean worktrees', confirmMsg))) {
		ctx.ui.notify('Clean cancelled', 'info');
		return;
	}

	const piRepo = repos.find((r) => basename(r) === 'arvore-pi-extensions');
	if (!piRepo) {
		ctx.ui.notify(
			results.join('\n') +
				'\n\narvore-pi-extensions repo not found \u2014 skipped version bump/PR.',
			'warning',
		);
		return;
	}

	const pkgPath = join(piRepo, 'packages', 'worktree', 'package.json');
	const bumped = bumpPackageVersion(pkgPath, bumpKind);
	if (!bumped) {
		ctx.ui.notify(
			results.join('\n') + `\n\nCould not read ${pkgPath} \u2014 skipped version bump/PR.`,
			'warning',
		);
		return;
	}
	results.push(`\u2713 Bumped @arvoretech/pi-worktree ${bumped.from} \u2192 ${bumped.to}`);

	if (skipPr) {
		ctx.ui.notify(
			results.join('\n') + '\n\n--no-pr set: version bumped locally, no commit/PR created.',
			'info',
		);
		return;
	}

	const branchName = `worktree-clean/bump-${bumped.to}`;
	const removedList = removedByRepo
		.map((r) => `- ${basename(r.repo)}/${r.name} (${r.branch})`)
		.join('\n');
	const prTitle = `chore(worktree): clean merged worktrees, bump to ${bumped.to}`;
	const prBody = `## Summary\n\nRemoved merged worktrees and bumped \`@arvoretech/pi-worktree\` to \`${bumped.to}\`.\n\n### Removed worktrees\n${removedList}\n\n_Automated by \`/worktree clean\`._`;

	const git = (args: string[]) => spawnSync('git', args, { cwd: piRepo, encoding: 'utf-8' });
	const dirty = (git(['status', '--porcelain']).stdout || '').trim();
	if (!dirty.split('\n').every((l) => l === '' || l.endsWith('packages/worktree/package.json'))) {
		ctx.ui.notify(
			results.join('\n') +
				'\n\narvore-pi-extensions has uncommitted changes \u2014 version bumped locally, but skipped commit/PR.',
			'warning',
		);
		return;
	}

	const baseBranch = getDefaultBranch(piRepo) || getCurrentBranch(piRepo);
	git(['checkout', '-b', branchName]);
	git(['add', pkgPath]);
	if (git(['commit', '-m', prTitle]).status !== 0) {
		ctx.ui.notify(results.join('\n') + '\n\nCommit failed.', 'error');
		return;
	}
	if (git(['push', '-u', 'origin', branchName]).status !== 0) {
		ctx.ui.notify(results.join('\n') + '\n\nPush failed.', 'error');
		return;
	}

	const pr = spawnSync(
		'gh',
		[
			'pr',
			'create',
			'--title',
			prTitle,
			'--body',
			prBody,
			'--base',
			baseBranch,
			'--head',
			branchName,
		],
		{ cwd: piRepo, encoding: 'utf-8' },
	);
	if (pr.status !== 0) {
		ctx.ui.notify(
			results.join('\n') + `\n\nBranch pushed, but PR creation failed: ${pr.stderr?.trim()}`,
			'warning',
		);
		return;
	}
	results.push(`\u2713 Opened PR: ${(pr.stdout || '').trim()}`);
	ctx.ui.notify(results.join('\n'), 'info');
}

// ═══════════════════════════════════════════
// merge — 合并 worktree 分支到目标分支
// ═══════════════════════════════════════════

/**
 * 执行 git merge：在 repo 的 target 分支上合并 source 分支
 */
function execMerge(
	repo: string,
	sourceBranch: string,
	targetBranch: string,
): { ok: boolean; message: string; conflicts: Array<{ file: string; lines: string }> } {
	const git = (args: string[], cwd?: string) =>
		spawnSync('git', args, {
			cwd: cwd || repo,
			encoding: 'utf-8',
			maxBuffer: 16 * 1024 * 1024,
		});

	// 1. 保存原始分支
	const origBranch = getCurrentBranch(repo);

	// 2. 暂存当前分支的更改
	const dirty = (git(['status', '--porcelain']).stdout || '').trim();
	if (dirty) {
		const stash = git(['stash', 'push', '-m', 'worktree-merge-auto-' + Date.now()]);
		if (stash.status !== 0) {
			return {
				ok: false,
				message: 'Cannot stash changes: ' + (stash.stderr || '').trim(),
				conflicts: [],
			};
		}
	}

	// 3. 切到 target 分支
	const checkout = git(['checkout', targetBranch]);
	if (checkout.status !== 0) {
		if (dirty) git(['stash', 'pop']);
		return {
			ok: false,
			message: "Cannot checkout '" + targetBranch + "': " + (checkout.stderr || '').trim(),
			conflicts: [],
		};
	}

	// 4. pull 最新（仅当 origin remote 存在。本地仓库无 remote 时可跳过）
	const hasRemote = git(['remote', 'get-url', 'origin']).status === 0;
	if (hasRemote) {
		const pull = git(['pull', 'origin', targetBranch, '--ff-only']);
		if (pull.status !== 0) {
			git(['checkout', origBranch]);
			if (dirty) git(['stash', 'pop']);
			return {
				ok: false,
				message: "Cannot pull '" + targetBranch + "': " + (pull.stderr || '').trim(),
				conflicts: [],
			};
		}
	}

	// 5. merge source 分支
	const merge = git(['merge', sourceBranch, '--no-ff', '--log']);
	const output = (merge.stdout || '') + (merge.stderr || '');

	if (merge.status === 0) {
		// 成功 — 切回原始分支
		git(['checkout', origBranch]);
		if (dirty) {
			const pop = git(['stash', 'pop']);
			if (pop.status !== 0) {
				log.warn('stash pop after successful merge failed; stash remains at stash@{0}', {
					stderr: (pop.stderr || '').trim(),
				});
			}
		}
		return {
			ok: true,
			message: "Merged '" + sourceBranch + "' -> '" + targetBranch + "'",
			conflicts: [],
		};
	}

	// 6. 有冲突 — 切回原始分支、恢复 stash，再返回冲突信息
	// 注意：merge 冲突状态保留在目标分支上，切换回来不会丢失
	git(['checkout', origBranch]);
	if (dirty) {
		const pop = git(['stash', 'pop']);
		if (pop.status !== 0) {
			log.warn('stash pop after merge conflict failed; stash remains at stash@{0}', {
				stderr: (pop.stderr || '').trim(),
			});
		}
	}
	const unmerged = (git(['diff', '--name-only', '--diff-filter=U']).stdout || '').trim();
	const conflictFiles = unmerged
		.split('\n')
		.filter(Boolean)
		.map((f) => {
			const lines = (git(['diff', '--', f.trim()]).stdout || '')
				.split('\n')
				.filter((l) => l.startsWith('@@'))
				.slice(0, 3)
				.join('; ');
			return { file: f.trim(), lines };
		});

	return {
		ok: false,
		message:
			'Merge failed. Conflicts in ' + conflictFiles.length + ' file(s).\n' + output.trim(),
		conflicts: conflictFiles,
	};
}

export async function handleMerge(
	repos: string[],
	flags: Record<string, string>,
	ctx: any,
	sessionId: string,
): Promise<void> {
	const repo = repos[0];
	if (!repo) {
		ctx.ui.notify('No repos found', 'error');
		return;
	}

	const allWorktrees = getExistingWorktrees(repo);
	if (allWorktrees.length === 0 && !activeWorktree) {
		ctx.ui.notify('No worktrees to merge. Create one first with /worktree create.', 'warning');
		return;
	}

	// 确定源 worktree（flags 优先 -> 当前活跃 -> TUI 选择）
	let sourceWorktree: string | undefined = flags.source;
	if (!sourceWorktree) {
		if (activeWorktree) {
			sourceWorktree = activeWorktree;
		} else if (ctx.hasUI) {
			const { pickMergeSource } = await import('./ui.js');
			const picked = await pickMergeSource(ctx, allWorktrees);
			if (!picked) {
				ctx.ui.notify('Cancelled', 'warning');
				return;
			}
			sourceWorktree = picked;
		} else {
			ctx.ui.notify(
				'Usage: /worktree merge --source <worktree-name> [--target main]',
				'warning',
			);
			return;
		}
	}

	const sourceBranch = 'wt/' + sourceWorktree;
	const targetBranch = flags.target || 'main';

	// TUI 确认对话框
	if (ctx.hasUI) {
		const { confirmMerge } = await import('./ui.js');
		const confirmed = await confirmMerge(ctx, sourceWorktree, sourceBranch, targetBranch);
		if (!confirmed) {
			ctx.ui.notify('Merge cancelled', 'info');
			return;
		}
	}

	log.info('merging', { repo: basename(repo), source: sourceBranch, target: targetBranch });
	ctx.ui.notify("Merging '" + sourceBranch + "' -> '" + targetBranch + "'...", 'info');

	const result = execMerge(repo, sourceBranch, targetBranch);

	if (result.ok) {
		log.info('merge succeeded', { source: sourceBranch, target: targetBranch });
		ctx.ui.notify(result.message, 'success');
		// 自动重新激活源 worktree
		if (sourceWorktree !== activeWorktree) {
			for (const r of repos) {
				const wtPath = join(r, '.worktrees', sourceWorktree);
				if (existsSync(wtPath) && existsSync(join(wtPath, '.git'))) {
					addWorktreePath(basename(r), wtPath);
				}
			}
			if (activeWorktreePaths.size > 0) {
				setActiveWorktree(sourceWorktree);
				registerWidget(ctx, { v: false });
				saveState(ctx.cwd, sessionId);
			}
		}
	} else if (result.conflicts.length > 0) {
		log.warn('merge conflicts', {
			source: sourceBranch,
			target: targetBranch,
			files: result.conflicts.length,
		});
		const summary = result.conflicts.map((c) => '  - ' + c.file + ': ' + c.lines).join('\n');
		ctx.ui.notify(
			'Merge conflict in ' +
				result.conflicts.length +
				' file(s). Switch to the target branch, resolve then commit.\n' +
				summary,
			'error',
		);
	} else {
		log.warn('merge failed', {
			source: sourceBranch,
			target: targetBranch,
			message: result.message,
		});
		ctx.ui.notify('Merge failed: ' + result.message, 'error');
	}
}
