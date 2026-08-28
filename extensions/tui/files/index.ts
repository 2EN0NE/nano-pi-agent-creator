/**
 * Files Extension（文件浏览器 + 变更记录器）
 *
 * + /files     — 浏览文件（含 git 状态和会话引用）
 * + /diff      — 选中 tracked 文件后直接打开 diff 视图
 * + /changes   — 列出本次会话所有被记录的文件变更（含工程外路径）
 * + /changes cls — 清空变更记录
 *
 * 快捷键：
 *   ctrl+shift+o — 浏览会话中引用的文件
 *   ctrl+shift+f — 在 Finder 中显示最近引用的文件
 *   ctrl+shift+r — 快速预览最近引用的文件
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createLogger } from '@zenone/pi-logger';
import { buildFileEntries, findLatestFileReference } from './scanner.js';
import { getAllChanges, clearChanges, setupRecorder } from './recorder.js';
import {
	openPath,
	editPath,
	revealPath,
	quickLookPath,
	openDiff,
	openFilesDiff,
	addFileToPrompt,
	getEditableContent,
} from './actions.js';
import { showFileSelector, showActionSelector, showChangesUI } from './ui.js';
import { toCanonicalPath } from './git.js';
import type { FileEntry } from './types.js';

const log = createLogger('files');

// ── File Browser ───────────────────────────────────────────────────────────

const runFileBrowser = async (pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> => {
	if (!ctx.hasUI) {
		log.warn('/files 被调用但当前不是交互模式');
		ctx.ui.notify('Files requires interactive mode', 'error');
		return;
	}

	log.info('/files 命令启动');
	const { files, gitRoots } = await buildFileEntries(pi, ctx);
	log.info('文件列表构建完成', {
		文件数: files.length,
		git仓库数: gitRoots.length,
	});
	if (files.length === 0) {
		ctx.ui.notify('未找到文件', 'info');
		return;
	}

	let lastSelectedPath: string | null = null;
	while (true) {
		const { selected, quickAction } = await showFileSelector(
			ctx,
			files,
			lastSelectedPath,
			gitRoots,
		);
		if (selected.length === 0) {
			ctx.ui.notify('Files cancelled', 'info');
			return;
		}

		if (selected.length === 1) {
			lastSelectedPath = selected[0].canonicalPath;
		}

		if (quickAction === 'diff' && selected.length === 1) {
			const fileGitRoot = selected[0].gitRoot ?? null;
			await openDiff(pi, ctx, selected[0], fileGitRoot);
			continue;
		}

		const allHaveChanges =
			gitRoots.length > 0 &&
			selected.every(
				(f) =>
					!f.isDirectory &&
					f.status !== undefined &&
					f.status !== '' &&
					f.status !== '??',
			);
		const canFileDiff = selected.length === 2 && selected.every((f) => !f.isDirectory);
		const allCanQuickLook =
			process.platform === 'darwin' && selected.every((f) => !f.isDirectory);

		const allCanEdit = selected.every((f) => getEditableContent(f).allowed);

		const action = await showActionSelector(ctx, {
			canQuickLook: allCanQuickLook,
			canEdit: allCanEdit,
			canViewChanges: allHaveChanges,
			canFileDiff,
		});
		if (!action) {
			continue;
		}

		for (const file of selected) {
			switch (action) {
				case 'quicklook':
					log.info('操作: quicklook', { 文件: file.displayPath });
					await quickLookPath(pi, ctx, file);
					break;
				case 'open':
					log.info('操作: open', { 文件: file.displayPath });
					await openPath(pi, ctx, file);
					break;
				case 'edit': {
					const ec = getEditableContent(file);
					if (!ec.allowed || ec.content === undefined) {
						log.warn('操作: edit 拒绝', {
							文件: file.displayPath,
							原因: ec.reason,
						});
						ctx.ui.notify(ec.reason ?? '文件无法编辑', 'warning');
						break;
					}
					log.info('操作: edit', { 文件: file.displayPath });
					await editPath(ctx, file, ec.content);
					break;
				}
				case 'addToPrompt':
					log.info('操作: addToPrompt', { 文件: file.displayPath });
					addFileToPrompt(ctx, file);
					break;
				case 'viewChanges':
					log.info('操作: viewChanges', { 文件: file.displayPath });
					await openDiff(pi, ctx, file, file.gitRoot ?? null);
					break;
				case 'fileDiff':
					if (selected.length === 2) {
						log.info('操作: fileDiff', {
							左: selected[0].displayPath,
							右: selected[1].displayPath,
						});
						await openFilesDiff(pi, ctx, selected[0], selected[1]);
					}
					break;
				default:
					log.info('操作: reveal', { 文件: file.displayPath });
					await revealPath(pi, ctx, file);
					break;
			}
		}
	}
};

// ── Diff Browser ───────────────────────────────────────────────────────────

const runDiffBrowser = async (pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> => {
	if (!ctx.hasUI) {
		log.warn('/diff 被调用但当前不是交互模式');
		ctx.ui.notify('diff 需要交互模式', 'error');
		return;
	}

	log.info('/diff 命令启动');
	const { files, gitRoots } = await buildFileEntries(pi, ctx);
	log.info('文件列表构建完成', {
		文件数: files.length,
		git仓库数: gitRoots.length,
	});

	if (files.length === 0) {
		ctx.ui.notify('未找到文件', 'info');
		return;
	}

	let lastSelectedPath: string | null = null;
	while (true) {
		const { selected } = await showFileSelector(ctx, files, lastSelectedPath, gitRoots);
		if (selected.length === 0) {
			log.info('/diff 用户取消选择');
			ctx.ui.notify('diff 已取消', 'info');
			return;
		}

		if (selected.length === 1) {
			lastSelectedPath = selected[0].canonicalPath;
		}

		const diffable = selected.filter(
			(f) => f.isTracked && !f.isDirectory && gitRoots.length > 0,
		);
		const nonDiffable = selected.filter(
			(f) => !(f.isTracked && !f.isDirectory && gitRoots.length > 0),
		);

		if (diffable.length > 0) {
			log.info('/diff: 直接打开 diff', { 文件数: diffable.length });
			for (const file of diffable) {
				await openDiff(pi, ctx, file, file.gitRoot ?? null);
			}
			if (nonDiffable.length === 0) return;
		}

		if (nonDiffable.length > 0) {
			for (const file of nonDiffable) {
				log.warn('/diff 跳过：文件不可 diff', {
					文件: file.displayPath,
					原因: file.isDirectory
						? '是目录'
						: !file.isTracked
							? '不是 tracked 文件'
							: '无 git 仓库',
				});
			}

			const anyCanQuickLook =
				process.platform === 'darwin' && nonDiffable.some((f) => !f.isDirectory);
			const anyCanEdit = nonDiffable.some((f) => getEditableContent(f).allowed);

			const action = await showActionSelector(ctx, {
				canQuickLook: anyCanQuickLook,
				canEdit: anyCanEdit,
				canViewChanges: false,
				canFileDiff: false,
			});
			if (!action) continue;

			for (const file of nonDiffable) {
				switch (action) {
					case 'quicklook':
						log.info('/diff 回退操作: quicklook', {
							文件: file.displayPath,
						});
						await quickLookPath(pi, ctx, file);
						break;
					case 'open':
						log.info('/diff 回退操作: open', {
							文件: file.displayPath,
						});
						await openPath(pi, ctx, file);
						break;
					case 'edit': {
						const ec = getEditableContent(file);
						if (!ec.allowed || ec.content === undefined) {
							log.warn('/diff 回退操作: edit 拒绝', {
								文件: file.displayPath,
								原因: ec.reason,
							});
							ctx.ui.notify(ec.reason ?? '文件无法编辑', 'warning');
							break;
						}
						log.info('/diff 回退操作: edit', {
							文件: file.displayPath,
						});
						await editPath(ctx, file, ec.content);
						break;
					}
					case 'addToPrompt':
						log.info('/diff 回退操作: addToPrompt', {
							文件: file.displayPath,
						});
						addFileToPrompt(ctx, file);
						break;
					default:
						log.info('/diff 回退操作: reveal', {
							文件: file.displayPath,
						});
						await revealPath(pi, ctx, file);
						break;
				}
			}
		}
	}
};

// ── Changes Command ────────────────────────────────────────────────────────

const runChangesCommand = async (
	args: string | undefined,
	ctx: ExtensionContext,
): Promise<void> => {
	// /changes cls — 在 !ctx.hasUI 检查之前处理（review 修复）
	if (args?.trim().toLowerCase() === 'cls') {
		clearChanges();
		ctx.ui.notify('变更记录已清空', 'info');
		return;
	}

	const changes = getAllChanges();

	if (!ctx.hasUI) {
		if (changes.length === 0) {
			ctx.ui.notify('未记录到任何文件变更', 'info');
			return;
		}
		const lines = changes.map((c) => {
			const icon =
				c.source === 'write'
					? '\u270f\ufe0f'
					: c.source === 'edit'
						? '\U0001f4dd'
						: c.source === 'bash_result'
							? '\u2699\ufe0f'
							: '\U0001f50d';
			const time = new Date(c.timestamp).toLocaleTimeString();
			return `${icon} ${c.display}  [${c.source}] x${c.count}  ${time}`;
		});
		ctx.ui.notify(`\U0001f4cb 变更文件 (${changes.length}):\n` + lines.join('\n'), 'info');
		return;
	}

	if (changes.length === 0) {
		ctx.ui.notify('本次会话未记录到任何文件变更', 'info');
		return;
	}

	await showChangesUI(ctx, changes);
};

// ── Entry Point ────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
	log.info('files 扩展已加载');

	// 启动变更记录引擎
	setupRecorder(pi);

	pi.registerCommand('files', {
		description: '浏览文件（含 git 状态和会话引用），支持 reveal/open/edit/diff/quicklook',
		handler: async (_args, ctx) => {
			log.info('命令 /files 被调用');
			await runFileBrowser(pi, ctx);
		},
	});

	pi.registerCommand('diff', {
		description: '打开文件选择器，选中 tracked 文件后直接打开 diff 视图',
		handler: async (_args, ctx) => {
			log.info('命令 /diff 被调用');
			await runDiffBrowser(pi, ctx);
		},
	});

	pi.registerCommand('changes', {
		description: '列出本次会话所有被记录的文件变更。/changes cls 清空记录。',
		handler: async (args, ctx) => {
			log.info('命令 /changes 被调用');
			await runChangesCommand(args, ctx);
		},
	});

	// ── 快捷键注册（pi-shortcuts 中心优先，缺失回退降级键） ──
	async function handleOpenBrowser(ctx: ExtensionContext): Promise<void> {
		log.info('快捷键触发：打开文件浏览器');
		await runFileBrowser(pi, ctx);
	}

	async function handleReveal(ctx: ExtensionContext): Promise<void> {
		log.info('快捷键触发：reveal 最新文件引用');
		const entries = ctx.sessionManager.getBranch();
		const latest = findLatestFileReference(entries, ctx.cwd);

		if (!latest) {
			log.warn('未找到会话中的文件引用');
			ctx.ui.notify('No file reference found in the session', 'warning');
			return;
		}

		const canonical = toCanonicalPath(latest.path);
		if (!canonical) {
			log.warn('引用的文件不存在', {
				路径: latest.display,
			});
			ctx.ui.notify(`File not found: ${latest.display}`, 'error');
			return;
		}

		log.debug('reveal 文件', { 路径: latest.display });
		await revealPath(pi, ctx, {
			canonicalPath: canonical.canonicalPath,
			resolvedPath: canonical.canonicalPath,
			displayPath: latest.display,
			exists: true,
			isDirectory: canonical.isDirectory,
			gitRoot: undefined,
			inRepo: false,
			isTracked: false,
			isReferenced: true,
			hasSessionChange: false,
			lastTimestamp: 0,
		});
	}

	async function handleQuickLook(ctx: ExtensionContext): Promise<void> {
		log.info('快捷键触发：Quick Look 最新文件引用');
		const entries = ctx.sessionManager.getBranch();
		const latest = findLatestFileReference(entries, ctx.cwd);

		if (!latest) {
			log.warn('未找到会话中的文件引用');
			ctx.ui.notify('No file reference found in the session', 'warning');
			return;
		}

		const canonical = toCanonicalPath(latest.path);
		if (!canonical) {
			log.warn('引用的文件不存在', {
				路径: latest.display,
			});
			ctx.ui.notify(`File not found: ${latest.display}`, 'error');
			return;
		}

		log.debug('Quick Look 文件', {
			路径: latest.display,
		});
		await quickLookPath(pi, ctx, {
			canonicalPath: canonical.canonicalPath,
			resolvedPath: canonical.canonicalPath,
			displayPath: latest.display,
			exists: true,
			isDirectory: canonical.isDirectory,
			gitRoot: undefined,
			inRepo: false,
			isTracked: false,
			isReferenced: true,
			hasSessionChange: false,
			lastTimestamp: 0,
		});
	}

	// session_start 时注册（消除加载顺序竞险：pi-shortcuts 的 __shortcutsApi 在所有扩展工厂函数执行后才挂载）
	pi.on('session_start', () => {
		const shortcutHub = (globalThis as any).__shortcutsApi;
		if (shortcutHub?.register) {
			shortcutHub.register({
				name: 'files',
				keys: ['f', 'o'],
				description: '浏览会话中引用的文件',
				handler: handleOpenBrowser,
			});
			shortcutHub.register({
				name: 'files',
				keys: ['f', 'r'],
				description: '在 Finder 中显示最近引用的文件',
				handler: handleReveal,
			});
			shortcutHub.register({
				name: 'files',
				keys: ['f', 'q'],
				description: '快速预览最近引用的文件',
				handler: handleQuickLook,
			});
		} else {
			pi.registerShortcut('ctrl+shift+o', {
				description: '浏览会话中引用的文件',
				handler: handleOpenBrowser,
			});
			pi.registerShortcut('ctrl+shift+f', {
				description: '在 Finder 中显示最近引用的文件',
				handler: handleReveal,
			});
			pi.registerShortcut('ctrl+shift+r', {
				description: '快速预览最近引用的文件',
				handler: handleQuickLook,
			});
		}
	});
}
