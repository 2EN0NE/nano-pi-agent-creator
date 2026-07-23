/**
 * Files Extension — Action Handlers
 *
 * 文件操作：打开、编辑、reveal、Quick Look、diff、添加到提示词等。
 */

import { spawnSync } from 'node:child_process';
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createLogger } from '@zenone/pi-logger';
import type { DiffToolCommand, EditCheckResult, FileEntry } from './types.js';
import { toggleTuiOffline, promptDiffDisplayMode, showDiffInPiPanel } from './ui.js';

const log = createLogger('files:actions');

const MAX_EDIT_BYTES = 40 * 1024 * 1024;

// ── Edit Check ─────────────────────────────────────────────────────────────

export const getEditableContent = (target: FileEntry): EditCheckResult => {
	if (!existsSync(target.resolvedPath)) {
		return { allowed: false, reason: 'File not found' };
	}

	const stats = statSync(target.resolvedPath);
	if (stats.isDirectory()) {
		return { allowed: false, reason: 'Directories cannot be edited' };
	}

	if (stats.size >= MAX_EDIT_BYTES) {
		return { allowed: false, reason: 'File is too large' };
	}

	const buffer = readFileSync(target.resolvedPath);
	if (buffer.includes(0)) {
		return { allowed: false, reason: 'File contains null bytes' };
	}

	return { allowed: true, content: buffer.toString('utf8') };
};

// ── Open in System App ─────────────────────────────────────────────────────

export const openPath = async (
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	target: FileEntry,
): Promise<void> => {
	if (!existsSync(target.resolvedPath)) {
		log.warn('openPath 失败：文件不存在', { 路径: target.displayPath });
		ctx.ui.notify(`File not found: ${target.displayPath}`, 'error');
		return;
	}

	const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
	const result = await pi.exec(command, [target.resolvedPath]);
	if (result.code !== 0) {
		const errorMessage = result.stderr?.trim() || `Failed to open ${target.displayPath}`;
		log.error('openPath 执行失败', {
			命令: command,
			路径: target.displayPath,
			错误: errorMessage,
		});
		ctx.ui.notify(errorMessage, 'error');
		return;
	}
	log.debug('openPath 成功', { 路径: target.displayPath });
};

// ── External Editor ────────────────────────────────────────────────────────

const openExternalEditor = (editorCmd: string, content: string): string | null => {
	const tmpFile = path.join(os.tmpdir(), `pi-files-edit-${Date.now()}.txt`);

	try {
		writeFileSync(tmpFile, content, 'utf8');

		const [editor, ...editorArgs] = editorCmd.split(' ');
		const result = spawnSync(editor, [...editorArgs, tmpFile], {
			stdio: 'inherit',
		});

		if (result.status === 0) {
			return readFileSync(tmpFile, 'utf8').replace(/\n$/, '');
		}

		return null;
	} finally {
		try {
			unlinkSync(tmpFile);
		} catch {}
	}
};

export const editPath = async (
	ctx: ExtensionContext,
	target: FileEntry,
	content: string,
): Promise<void> => {
	const editorCmd = process.env.VISUAL || process.env.EDITOR;
	if (!editorCmd) {
		log.warn('editPath 跳过：未设置 \$VISUAL/\$EDITOR');
		ctx.ui.notify('No editor configured. Set \$VISUAL or \$EDITOR.', 'warning');
		return;
	}

	log.debug('editPath 启动外部编辑器', {
		编辑器: editorCmd,
		文件: target.displayPath,
	});

	const updated = await ctx.ui.custom<string | null>((_tui, _theme, _kb, done) => {
		toggleTuiOffline.set(true);
		queueMicrotask(() => {
			const result = openExternalEditor(editorCmd, content);
			toggleTuiOffline.set(false);
			done(result);
		});

		return {
			render: () => [],
			invalidate: () => {},
			handleInput: () => {},
		};
	});

	if (updated === null) {
		log.info('editPath 取消编辑', { 文件: target.displayPath });
		ctx.ui.notify('Edit cancelled', 'info');
		return;
	}

	try {
		writeFileSync(target.resolvedPath, updated, 'utf8');
		log.info('editPath 保存成功', { 文件: target.displayPath });
	} catch (err) {
		log.error('editPath 保存失败', {
			文件: target.displayPath,
			错误: String(err),
		});
		ctx.ui.notify(`Failed to save ${target.displayPath}`, 'error');
	}
};

// ── Reveal in Finder ───────────────────────────────────────────────────────

export const revealPath = async (
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	target: FileEntry,
): Promise<void> => {
	if (!existsSync(target.resolvedPath)) {
		log.warn('revealPath 失败：文件不存在', { 路径: target.displayPath });
		ctx.ui.notify(`File not found: ${target.displayPath}`, 'error');
		return;
	}

	const isDir = target.isDirectory || statSync(target.resolvedPath).isDirectory();
	let command = 'open';
	let args: string[] = [];

	if (process.platform === 'darwin') {
		args = isDir ? [target.resolvedPath] : ['-R', target.resolvedPath];
	} else {
		command = 'xdg-open';
		args = [isDir ? target.resolvedPath : path.dirname(target.resolvedPath)];
	}

	log.debug('revealPath 执行', {
		路径: target.displayPath,
		命令: command,
		参数: args,
	});
	const result = await pi.exec(command, args);
	if (result.code !== 0) {
		const errorMessage = result.stderr?.trim() || `Failed to reveal ${target.displayPath}`;
		log.error('revealPath 执行失败', {
			路径: target.displayPath,
			错误: errorMessage,
		});
		ctx.ui.notify(errorMessage, 'error');
	}
};

// ── Quick Look ─────────────────────────────────────────────────────────────

export const quickLookPath = async (
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	target: FileEntry,
): Promise<void> => {
	if (process.platform !== 'darwin') {
		log.warn('quickLookPath 跳过：非 macOS 平台');
		ctx.ui.notify('Quick Look is only available on macOS', 'warning');
		return;
	}

	if (!existsSync(target.resolvedPath)) {
		log.warn('quickLookPath 失败：文件不存在', { 路径: target.displayPath });
		ctx.ui.notify(`File not found: ${target.displayPath}`, 'error');
		return;
	}

	const isDir = target.isDirectory || statSync(target.resolvedPath).isDirectory();
	if (isDir) {
		log.warn('quickLookPath 跳过：不支持目录', { 路径: target.displayPath });
		ctx.ui.notify('Quick Look only works on files', 'warning');
		return;
	}

	log.debug('quickLookPath 执行', { 路径: target.displayPath });
	const result = await pi.exec('qlmanage', ['-p', target.resolvedPath]);
	if (result.code !== 0) {
		const errorMessage = result.stderr?.trim() || `Failed to Quick Look ${target.displayPath}`;
		log.error('quickLookPath 执行失败', {
			路径: target.displayPath,
			错误: errorMessage,
		});
		ctx.ui.notify(errorMessage, 'error');
	}
};

// ── Diff ───────────────────────────────────────────────────────────────────

export const getDiffToolCommand = async (pi: ExtensionAPI): Promise<DiffToolCommand> => {
	const editorCmd = process.env.VISUAL || process.env.EDITOR || '';
	const editorBase = path.basename(editorCmd.split(' ')[0] ?? '');
	if (editorBase.includes('nvim') || editorBase === 'neovim') {
		log.debug('检测到 \$EDITOR=nvim，使用 nvim -d --clean');
		return {
			cmd: 'nvim',
			args: (left, right) => ['-d', '--clean', left, right],
		};
	}
	if (editorBase.includes('vim')) {
		log.debug('检测到 \$EDITOR=vim，使用 vimdiff');
		return {
			cmd: 'vimdiff',
			args: (left, right) => [left, right],
		};
	}

	const difftoolCheck = await pi.exec('git', ['config', '--get', 'diff.tool']);
	if (difftoolCheck.code === 0 && difftoolCheck.stdout.trim()) {
		log.debug('检测到 git difftool 配置，使用 git difftool', {
			工具: difftoolCheck.stdout.trim(),
		});
		return {
			cmd: 'git',
			args: (left, right) => [
				'difftool',
				'--no-prompt',
				'--tool',
				difftoolCheck.stdout.trim(),
				left,
				right,
			],
		};
	}

	const vimCheck = await pi.exec('which', ['vimdiff']);
	if (vimCheck.code === 0) {
		log.debug('使用系统 vimdiff');
		return {
			cmd: 'vimdiff',
			args: (left, right) => [left, right],
		};
	}

	const codeCheck = await pi.exec('which', ['code']);
	if (codeCheck.code === 0 && codeCheck.stdout.trim()) {
		log.debug('未检测到 vim 类工具，回退到 code --diff');
		return {
			cmd: 'code',
			args: (left, right) => ['--diff', left, right],
		};
	}

	return null;
};

export const isTerminalBasedTool = (cmd: string): boolean => {
	const base = path.basename(cmd);
	return base.includes('vim') || base.includes('nvim') || base === 'vi';
};

const showDiffInTmuxSplit = async (
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	cmd: string,
	args: string[],
	gitRoot: string,
): Promise<void> => {
	const quotedArgs = args.map((a) => (a.includes(' ') ? `"${a}"` : a));
	const fullCmd = `${cmd} ${quotedArgs.join(' ')}`;

	log.info('在 tmux 中创建新窗口', { 命令: fullCmd });

	const result = await pi.exec('tmux', ['new-window', '-c', gitRoot, fullCmd]);
	if (result.code !== 0) {
		const errMsg = result.stderr?.trim() || 'tmux new-window failed';
		log.error('tmux 新窗口失败', { 错误: errMsg });
		ctx.ui.notify(`Tmux new-window failed: ${errMsg}`, 'error');
		return;
	}
	ctx.ui.notify('Diff opened in tmux new window', 'info');
};

export const openDiff = async (
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	target: FileEntry,
	gitRoot: string | null,
): Promise<void> => {
	if (!gitRoot) {
		log.warn('openDiff 跳过：无 git 仓库');
		ctx.ui.notify('Git repository not found', 'warning');
		return;
	}

	const relativePath = path.relative(gitRoot, target.resolvedPath).split(path.sep).join('/');
	log.debug('openDiff 开始', { 文件: target.displayPath, relativePath });

	const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'pi-files-'));
	const tmpFile = path.join(tmpDir, path.basename(target.displayPath));

	const existsInHead = await pi.exec('git', ['cat-file', '-e', `HEAD:${relativePath}`], {
		cwd: gitRoot,
	});
	if (existsInHead.code === 0) {
		const result = await pi.exec('git', ['show', `HEAD:${relativePath}`], {
			cwd: gitRoot,
		});
		if (result.code !== 0) {
			const errorMessage = result.stderr?.trim() || `Failed to diff ${target.displayPath}`;
			log.error('openDiff 获取 HEAD 版本失败', {
				文件: target.displayPath,
				错误: errorMessage,
			});
			ctx.ui.notify(errorMessage, 'error');
			return;
		}
		writeFileSync(tmpFile, result.stdout ?? '', 'utf8');
	} else {
		log.debug('openDiff 文件在 HEAD 中不存在，使用空文件对比', {
			文件: target.displayPath,
		});
		writeFileSync(tmpFile, '', 'utf8');
	}

	let workingPath = target.resolvedPath;
	if (!existsSync(target.resolvedPath)) {
		workingPath = path.join(tmpDir, `pi-files-working-${path.basename(target.displayPath)}`);
		writeFileSync(workingPath, '', 'utf8');
	}

	const diffTool = await getDiffToolCommand(pi);
	if (!diffTool) {
		const msg = 'No diff tool found (code, vimdiff, or git difftool)';
		log.error('openDiff 失败：' + msg);
		ctx.ui.notify(msg, 'error');
		return;
	}

	log.info('openDiff: 使用 diff 工具', {
		文件: target.displayPath,
		工具: diffTool.cmd,
		左: tmpFile,
		右: workingPath,
	});

	if (isTerminalBasedTool(diffTool.cmd)) {
		const inTmux = !!process.env.TMUX;
		const mode = await promptDiffDisplayMode(ctx, inTmux);
		if (!mode) {
			log.info('openDiff 用户取消 diff');
			return;
		}

		if (mode === 'tmux') {
			const diffArgs = diffTool.args(tmpFile, workingPath);
			await showDiffInTmuxSplit(pi, ctx, diffTool.cmd, diffArgs, gitRoot);
			log.debug('openDiff tmux 分屏完成', { 文件: target.displayPath });
			return;
		}

		const gitDiffResult = await pi.exec('git', ['diff', 'HEAD', '--', relativePath], {
			cwd: gitRoot,
		});
		const diffText =
			gitDiffResult.code === 0 && gitDiffResult.stdout
				? gitDiffResult.stdout
				: `(no diff output for ${target.displayPath})`;
		await showDiffInPiPanel(ctx, `Git 变更: ${target.displayPath}`, diffText);
		log.debug('openDiff pi 面板展示完成', { 文件: target.displayPath });
		return;
	}

	const diffArgs = diffTool.args(tmpFile, workingPath);
	const openResult = await pi.exec(diffTool.cmd, diffArgs, {
		cwd: gitRoot,
	});
	if (openResult.code !== 0) {
		const errorMessage =
			openResult.stderr?.trim() || `Failed to open diff for ${target.displayPath}`;
		log.error('openDiff 打开 diff 失败', {
			文件: target.displayPath,
			工具: diffTool.cmd,
			错误: errorMessage,
		});
		ctx.ui.notify(errorMessage, 'error');
		return;
	}
	log.debug('openDiff 成功', { 文件: target.displayPath });
};

export const openFilesDiff = async (
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	left: FileEntry,
	right: FileEntry,
): Promise<void> => {
	log.info('openFilesDiff 开始', {
		左: left.displayPath,
		右: right.displayPath,
	});

	const diffTool = await getDiffToolCommand(pi);
	if (!diffTool) {
		const msg = 'No diff tool found (code, vimdiff, or git difftool)';
		log.error('openFilesDiff 失败：' + msg);
		ctx.ui.notify(msg, 'error');
		return;
	}

	const leftPath = existsSync(left.resolvedPath)
		? left.resolvedPath
		: path.join(os.tmpdir(), `pi-files-empty-left-${path.basename(left.displayPath)}`);
	const rightPath = existsSync(right.resolvedPath)
		? right.resolvedPath
		: path.join(os.tmpdir(), `pi-files-empty-right-${path.basename(right.displayPath)}`);

	if (!existsSync(left.resolvedPath)) {
		writeFileSync(leftPath, '', 'utf8');
	}
	if (!existsSync(right.resolvedPath)) {
		writeFileSync(rightPath, '', 'utf8');
	}

	log.info('openFilesDiff: 使用 diff 工具', {
		工具: diffTool.cmd,
		左: leftPath,
		右: rightPath,
	});

	if (isTerminalBasedTool(diffTool.cmd)) {
		const inTmux = !!process.env.TMUX;
		const mode = await promptDiffDisplayMode(ctx, inTmux);
		if (!mode) {
			log.info('openFilesDiff 用户取消');
			return;
		}

		if (mode === 'tmux') {
			const diffArgs = diffTool.args(leftPath, rightPath);
			await showDiffInTmuxSplit(pi, ctx, diffTool.cmd, diffArgs, ctx.cwd);
			log.debug('openFilesDiff tmux 分屏完成');
			return;
		}

		const diffResult = await pi.exec('diff', [leftPath, rightPath]);
		const diffText =
			diffResult.code === 0 ? '(两个文件内容一致)' : diffResult.stdout || '(diff 无输出)';
		await showDiffInPiPanel(
			ctx,
			`文件对比: ${left.displayPath} ↔ ${right.displayPath}`,
			diffText,
		);
		log.debug('openFilesDiff pi 面板展示完成');
		return;
	}

	const diffArgs = diffTool.args(leftPath, rightPath);
	const openResult = await pi.exec(diffTool.cmd, diffArgs);
	if (openResult.code !== 0) {
		const errorMessage =
			openResult.stderr?.trim() ||
			`Failed to diff ${left.displayPath} vs ${right.displayPath}`;
		log.error('openFilesDiff 打开 diff 失败', {
			工具: diffTool.cmd,
			错误: errorMessage,
		});
		ctx.ui.notify(errorMessage, 'error');
		return;
	}
	log.debug('openFilesDiff 成功', {
		左: left.displayPath,
		右: right.displayPath,
	});
};

// ── Add to Prompt ──────────────────────────────────────────────────────────

export const addFileToPrompt = (ctx: ExtensionContext, target: FileEntry): void => {
	const mentionTarget = target.displayPath || target.resolvedPath;
	const mention = `@${mentionTarget}`;
	const current = ctx.ui.getEditorText();
	const separator = current && !current.endsWith(' ') ? ' ' : '';
	ctx.ui.setEditorText(`${current}${separator}${mention}`);
	log.info('addToPrompt: 文件引用已添加到输入框', { 文件: mentionTarget });
	ctx.ui.notify(`Added ${mention} to prompt`, 'info');
};
