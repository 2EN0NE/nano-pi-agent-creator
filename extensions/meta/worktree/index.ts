/**
 * pi-worktree — 基于 git worktree 的隔离开发管理插件
 *
 * 使用 /worktree 命令创建独立的 git worktree 进行特性隔离开发。
 * Worktree 名称自动从黄道十二宫 + 恒星名池分配。
 * Agent 自动感知 worktree 路径，将文件操作重定向到 worktree 目录。
 *
 * ── 快速开始 ──
 *   /worktree create         创建 worktree（自动分配名称）
 *   /worktree use <name>     切换到已有 worktree
 *   /worktree stop           退出 worktree，切回主仓库
 *   /worktree list           列出所有 worktree
 *   /worktree delete <name>  删除 worktree（含分支清理）
 *   /worktree mode [on|off]  开关 worktree 模式
 *   /worktree clean          清理已合并的 worktree
 *   /worktree shell          在 worktree 目录打开终端
 *
 * ── 工作流 ──
 *   1. /worktree create → 2. 开发（agent 自动定向 worktree 路径）
 *   3. 提交/推送/PR → 4. /worktree stop → 5. 重复 1-4
 *   6. /worktree cleanup / worktree delete <name>
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from '@earendil-works/pi-ai';
import { createLogger } from '@zenone/pi-logger';
import { basename, join } from 'node:path';
import { existsSync } from 'node:fs';
import { loadState, saveState, buildWorktreeContext, invalidateRepoCache } from './state.js';
import { registerWidget } from './lib/ui.js';
import { discoverRepos } from './lib/git.js';

const log = createLogger('pi-worktree');
import {
	pickAvailableName,
	createWorktree,
	removeWorktree,
	deleteWorktreeBranch,
	getExistingWorktrees,
} from './lib/worktree.js';

import { WORKTREES_DIR } from './lib/setup.js';
import {
	activeWorktree,
	activeWorktreePaths,
	worktreeMode,
	setActiveWorktree,
	clearActiveWorktree,
	addWorktreePath,
} from './state.js';
import { showWorktreeTui, pickWorktree, pickDeleteWorktree, confirmDelete } from './lib/ui.js';
import type { WorktreeInfo } from './types.js';
import {
	handleCreate,
	handleList,
	handleUse,
	handleStop,
	handleMode,
	handleWidget,
	handleShell,
	handleDelete,
	handleClean,
	handleMerge,
} from './lib/handlers.js';
import { diagnoseWorktreeEnv } from './lib/git.js';

export default function worktreeExtension(pi: ExtensionAPI): void {
	let sessionId = '';
	let widgetRegistered = false;

	function getSessionId(ctx: any): string {
		const file = ctx.sessionManager?.getSessionFile?.() || '';
		return file ? basename(file, '.json') : `mem-${Date.now()}`;
	}

	const widgetTracker = {
		get v() {
			return widgetRegistered;
		},
		set v(v: boolean) {
			widgetRegistered = v;
		},
	};

	// ── 生命周期 ──
	pi.on('session_start', (_e, ctx) => {
		sessionId = getSessionId(ctx);
		loadState(ctx.cwd, sessionId);
		if (activeWorktree) registerWidget(ctx, widgetTracker);

		// 启动提醒：有 worktree 但未激活
		if (worktreeMode && !activeWorktree) {
			try {
				const repos = discoverRepos(ctx.cwd);
				let total = 0;
				for (const repo of repos) {
					total += getExistingWorktrees(repo).length;
				}
				if (total > 0) {
					log.info('startup: worktree reminder', { existingWorktrees: total });
					ctx.ui.notify(
						`\u{1F30C} 发现 ${total} 个 worktree。使用 /worktree use <name> 选择工作分支。`,
						'info',
					);
				}
			} catch (err) {
				log.debug('worktree startup notify skipped', { error: String(err) });
			}
		}
	});

	pi.on('session_shutdown', async (_e, ctx) => {
		if (sessionId) saveState(ctx.cwd, sessionId);
	});

	// ── 每轮对话前注入 worktree 工作目录指令（置顶优先级）──
	pi.on('before_agent_start', (_e, _ctx) => {
		if (!activeWorktree || activeWorktreePaths.size === 0) return;
		const mappings = [...activeWorktreePaths.entries()]
			.map(([repo, p]) => `  ${repo}  →  ${p}`)
			.join('\n');
		const directive = [
			'## WORKTREE DIRECTIVE (highest priority)',
			'',
			`You are currently working inside worktree **"${activeWorktree}"**. ` +
				'ALL file operations (read, write, edit, bash, grep) MUST target the ' +
				'worktree directories listed below — NEVER the original repo paths.',
			'',
			'Worktree path mappings:',
			mappings,
			'',
			'For bash commands: `cd <worktree-path> && <command>`',
			'For file tools: use the worktree paths directly.',
			'',
			'Ignore the repo paths shown in the project context header — they are ' +
				'NOT the active worktree. The worktree paths above are authoritative.',
		].join('\n');
		log.info('[before_agent_start] injecting worktree directive', {
			activeWorktree,
			repoCount: activeWorktreePaths.size,
		});
		// 放在 system prompt 最前面，确保 agent 首先看到
		return { systemPrompt: directive + '\n\n' + (_e as any).systemPrompt };
	});

	// ── Agent 工具 ──

	pi.registerTool({
		name: 'get_worktree_paths',
		label: 'Worktree Paths',
		description:
			'Returns the active worktree paths mapping repos to their worktree directories.',
		promptSnippet: 'Get active worktree paths for file operations',
		promptGuidelines: [
			'Call `get_worktree_paths` before editing files. If active worktree exists, ALL reads/writes MUST use those paths instead of the main repo.',
			'If worktree mode is ON but no worktree is active, call `create_worktree` first.',
			'If a worktree is active but a needed repo is missing, call `attach_worktree_repos`.',
		],
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: 'text', text: buildWorktreeContext() }], details: {} };
		},
	});

	pi.registerTool({
		name: 'create_worktree',
		label: 'Create Worktree',
		description:
			'Creates a new worktree for specified repos and activates it. Name auto-assigned if not provided.',
		promptSnippet: 'Create and activate a git worktree for isolated work',
		parameters: Type.Object({
			repos: Type.Array(Type.String(), { description: 'Repo directory names' }),
			name: Type.Optional(
				Type.String({ description: 'Worktree name. Auto-generated if not provided.' }),
			),
			branch: Type.Optional(
				Type.String({ description: 'Branch name (defaults to wt/<name>)' }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const repos = discoverRepos(ctx.cwd);
			const targetRepos = repos.filter((r) => params.repos.includes(basename(r)));
			if (targetRepos.length === 0)
				return {
					content: [
						{
							type: 'text',
							text: `No matching repos. Available: ${repos.map((r) => basename(r)).join(', ')}`,
						},
					],
					details: {},
				};

			const name = params.name || pickAvailableName(targetRepos[0]);
			const results: string[] = [];
			clearActiveWorktree();

			for (const repo of targetRepos) {
				const result = createWorktree(repo, name, params.branch);
				results.push(result.ok ? `\u2713 ${result.message}` : `\u2717 ${result.message}`);
				if (result.ok)
					addWorktreePath(basename(repo), result.path || join(repo, WORKTREES_DIR, name));
			}

			if (activeWorktreePaths.size > 0) {
				setActiveWorktree(name);
				registerWidget(ctx, widgetTracker);
				saveState(ctx.cwd, sessionId);
				invalidateRepoCache();
			}
			return {
				content: [
					{ type: 'text', text: results.join('\n') + '\n\n' + buildWorktreeContext() },
				],
				details: {},
			};
		},
	});

	pi.registerTool({
		name: 'stop_worktree',
		label: 'Stop Worktree',
		description: 'Deactivates the current worktree.',
		promptSnippet: 'Deactivate the current worktree',
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (!activeWorktree)
				return { content: [{ type: 'text', text: 'No active worktree.' }], details: {} };
			const prev = activeWorktree;
			clearActiveWorktree();
			registerWidget(ctx, widgetTracker);
			saveState(ctx.cwd, sessionId);
			return {
				content: [{ type: 'text', text: `Deactivated worktree '${prev}'.` }],
				details: {},
			};
		},
	});

	pi.registerTool({
		name: 'list_worktrees',
		label: 'List Worktrees',
		description: 'Lists all existing worktrees across repos.',
		promptSnippet: 'List all existing git worktrees',
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const repos = discoverRepos(ctx.cwd);
			const lines: string[] = [];
			const details: Array<{
				repo: string;
				name: string;
				branch: string;
				path: string;
				active: boolean;
			}> = [];
			for (const repo of repos) {
				const wts = getExistingWorktrees(repo);
				if (wts.length === 0) continue;
				lines.push(`${basename(repo)}:`);
				for (const wt of wts) {
					const isActive = activeWorktree === wt.name;
					lines.push(`  ${wt.name} \u2192 ${wt.branch}${isActive ? ' (active)' : ''}`);
					details.push({
						repo: basename(repo),
						name: wt.name,
						branch: wt.branch,
						path: wt.path || '',
						active: isActive,
					});
				}
			}
			return {
				content: [
					{
						type: 'text',
						text: lines.length > 0 ? lines.join('\n') : 'No worktrees found.',
					},
				],
				details: { worktrees: details },
			};
		},
	});

	pi.registerTool({
		name: 'attach_worktree_repos',
		label: 'Attach Repos',
		description: 'Adds more repos to the active worktree.',
		promptSnippet: 'Attach additional repos to the active worktree',
		parameters: Type.Object({
			repos: Type.Array(Type.String(), { description: 'Repo names to attach' }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!activeWorktree)
				return { content: [{ type: 'text', text: 'No active worktree.' }], details: {} };
			const allRepos = discoverRepos(ctx.cwd);
			const targetRepos = allRepos.filter(
				(r) => params.repos.includes(basename(r)) && !activeWorktreePaths.has(basename(r)),
			);
			if (targetRepos.length === 0)
				return {
					content: [
						{
							type: 'text',
							text: `No new repos. Already active: ${[...activeWorktreePaths.keys()].join(', ')}`,
						},
					],
					details: {},
				};

			const results: string[] = [];
			for (const repo of targetRepos) {
				const result = createWorktree(repo, activeWorktree);
				if (result.ok) {
					addWorktreePath(
						basename(repo),
						result.path || join(repo, WORKTREES_DIR, activeWorktree),
					);
					results.push(`\u2713 ${result.message}`);
				} else {
					results.push(`\u2717 ${result.message}`);
				}
			}
			registerWidget(ctx, widgetTracker);
			saveState(ctx.cwd, sessionId);
			return {
				content: [
					{ type: 'text', text: results.join('\n') + '\n\n' + buildWorktreeContext() },
				],
				details: {},
			};
		},
	});

	pi.registerTool({
		name: 'detach_worktree_repos',
		label: 'Detach Repos',
		description: 'Removes repos from active worktree tracking without deleting worktree files.',
		promptSnippet: 'Remove repos from the active worktree',
		parameters: Type.Object({
			repos: Type.Array(Type.String(), { description: 'Repo names to remove' }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!activeWorktree)
				return { content: [{ type: 'text', text: 'No active worktree.' }], details: {} };
			const removed: string[] = [];
			for (const repo of params.repos) {
				if (activeWorktreePaths.has(repo)) {
					activeWorktreePaths.delete(repo);
					removed.push(repo);
				}
			}
			if (removed.length === 0)
				return {
					content: [
						{
							type: 'text',
							text: `Not in active worktree: ${params.repos.join(', ')}`,
						},
					],
					details: {},
				};
			if (activeWorktreePaths.size === 0) clearActiveWorktree();
			registerWidget(ctx, widgetTracker);
			saveState(ctx.cwd, sessionId);
			return {
				content: [
					{
						type: 'text',
						text: `Detached: ${removed.join(', ')}\n\n${buildWorktreeContext()}`,
					},
				],
				details: {},
			};
		},
	});

	pi.registerTool({
		name: 'delete_worktree',
		label: 'Delete Worktree',
		description:
			'Permanently removes worktree directories and branches from disk. Shows confirmation prompt in TUI mode.',
		promptSnippet: 'Delete a worktree and its branches from disk',
		parameters: Type.Object({
			name: Type.String({ description: "Worktree name (e.g. 'Aries-Hamal')" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const allRepos = discoverRepos(ctx.cwd);
			const results: string[] = [];

			if (ctx.hasUI) {
				const confirmed = await confirmDelete(ctx, params.name);
				if (!confirmed)
					return { content: [{ type: 'text', text: 'Delete cancelled.' }], details: {} };
			}

			for (const repo of allRepos) {
				if (!existsSync(join(repo, WORKTREES_DIR, params.name))) continue;

				const result = removeWorktree(repo, params.name);
				results.push(result.ok ? `\u2713 ${result.message}` : `\u2717 ${result.message}`);
				if (result.ok) {
					const branchMsgs = deleteWorktreeBranch(repo, params.name);
					results.push(...branchMsgs.map((m) => `  ${m}`));
				}
			}

			if (results.length === 0)
				return {
					content: [
						{ type: 'text', text: `Worktree '${params.name}' not found in any repo.` },
					],
					details: {},
				};
			if (activeWorktree === params.name) {
				clearActiveWorktree();
				registerWidget(ctx, widgetTracker);
				saveState(ctx.cwd, sessionId);
			}
			invalidateRepoCache();
			return { content: [{ type: 'text', text: results.join('\n') }], details: {} };
		},
	});

	// ── /worktree 命令 ──

	pi.registerCommand('worktree', {
		description: 'Manage git worktrees with zodiac+star themed names across repos',
		handler: async (args, ctx) => {
			const { command, flags } = parseArgs(args);
			const repos = discoverRepos(ctx.cwd);

			// ── 无参数：显示交互式 TUI ──
			if (command === 'help' || command === '') {
				const hasError = repos.length === 0 ? diagnoseWorktreeEnv(ctx.cwd) : '';
				if (!ctx.hasUI) {
					ctx.ui.notify(hasError || formatHelp(), hasError ? 'error' : 'info');
					return;
				}

				// 收集所有 worktree 信息用于 TUI
				let allWorktrees: WorktreeInfo[] = [];
				if (repos.length > 0) {
					for (const repo of repos) {
						allWorktrees = allWorktrees.concat(getExistingWorktrees(repo));
					}
				}

				const result = await showWorktreeTui(ctx, allWorktrees, repos, hasError);
				switch (result.action) {
					case 'create':
						await handleCreate(repos, {}, ctx, sessionId);
						break;
					case 'stop':
						handleStop(ctx, sessionId);
						break;
					case 'list': {
						await handleList(repos, {}, ctx);
						break;
					}
					case 'use': {
						if (allWorktrees.length === 0) break;
						const _picked1 = await pickWorktree(ctx, allWorktrees);
						if (_picked1) handleUse(repos, { _positional: _picked1 }, ctx, sessionId);
						break;
					}
					case 'delete': {
						if (allWorktrees.length === 0) break;
						const _picked2 = await pickDeleteWorktree(ctx, allWorktrees);
						if (_picked2)
							await handleDelete(
								repos,
								{ _positional: _picked2, remote: flags.remote || 'origin' },
								ctx,
								sessionId,
							);
						break;
					}
					case 'mode':
						handleMode(ctx, sessionId, {});
						break;
					case 'widget':
						handleWidget(ctx, sessionId, {});
						break;
					case 'merge':
						await handleMerge(repos, {}, ctx, sessionId);
						break;
					case 'help':
						ctx.ui.notify(formatHelp(), 'info');
						break;
					case 'quit':
						break;
				}
				return;
			}

			if (repos.length === 0) {
				const diag = diagnoseWorktreeEnv(ctx.cwd);
				ctx.ui.notify(diag || '未发现 git 仓库。请在 git 仓库目录中运行。', 'error');
				return;
			}

			switch (command) {
				case 'create':
					await handleCreate(repos, flags, ctx, sessionId);
					break;
				case 'list':
					handleList(repos, flags, ctx);
					break;
				case 'use':
					handleUse(repos, flags, ctx, sessionId);
					break;
				case 'stop':
					handleStop(ctx, sessionId);
					break;
				case 'mode':
					handleMode(ctx, sessionId, flags);
					break;
				case 'widget':
					handleWidget(ctx, sessionId, flags);
					break;
				case 'shell':
					handleShell(ctx);
					break;
				case 'delete':
					await handleDelete(repos, flags, ctx, sessionId);
					break;
				case 'clean':
					await handleClean(repos, flags, ctx);
					break;
				case 'merge':
					await handleMerge(repos, flags, ctx, sessionId);
					break;
				default:
					ctx.ui.notify(formatHelp(), 'info');
			}
		},
	});
}

function parseArgs(input: string): { command: string; flags: Record<string, string> } {
	const parts = input.trim().split(/\s+/);
	const command = parts[0] || 'help';
	const flags: Record<string, string> = {};
	for (let i = 1; i < parts.length; i++) {
		if (parts[i].startsWith('--')) {
			const key = parts[i].slice(2);
			flags[key] = parts[i + 1] && !parts[i + 1].startsWith('--') ? parts[++i] : '';
		} else if (!flags._positional) {
			flags._positional = parts[i];
		}
	}
	return { command, flags };
}

function formatHelp(): string {
	return [
		'Usage: /worktree <command> [options]',
		'',
		'Commands:',
		'  create [--repos repo1,repo2] [--branch name]',
		'  use    <name>   activate worktree (agent works in worktree paths)',
		'  stop            deactivate current worktree',
		'  mode   [on|off] toggle worktree mode (agent auto-creates worktrees)',
		'  widget [on|off] show/hide the worktree status widget',
		'  shell           open terminal(s) in worktree dirs (Herdr/tmux/Warp)',
		'  list   [--repos repo1,repo2]',
		'  delete <name> [--repos repo1,repo2] [--remote <name>]',
		'  clean  [--repos ...] [--bump patch|minor|major] [--dry-run] [--no-pr]',
		'  merge  [--source <name>] [--target <branch>]  merge worktree branch into target (default: main)',
		'',
		'Names are auto-assigned from a zodiac+star pool (e.g. Aries-Hamal).',
		'If omitted, --repos shows interactive picker (TUI).',
		'',
		'Setup: runs .pi/worktree-setup/<repo>.sh on create. Symlinks .env* by default.',
	].join('\n');
}
