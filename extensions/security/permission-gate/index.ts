/**
 * Permission Gate Extension v2
 *
 * 增强版权限控制面板，提供：
 * - 危险命令拦截与用户确认
 * - 动态策略自动放行（同指令/同工具/同文件夹三级阈值）
 * - /permission-gate TUI 控制面板
 * - 持久化配置（项目级 > 用户级 > 默认值）
 * - --no-permission-gate CLI flag
 */

import { Container, SelectList, Text, type SelectItem } from '@earendil-works/pi-tui';
import { DynamicBorder } from '@earendil-works/pi-coding-agent';
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolCallEvent,
} from '@earendil-works/pi-coding-agent';
import { showConfirmDestructive } from '@zenone/pi-selector';
import { createLogger } from '@zenone/pi-logger';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve, sep } from 'node:path';
import {
	type PermissionGateConfig,
	getDefaultConfig,
	loadConfig,
	makeCommandKey,
	makeFolderKey,
	makeToolKey,
	saveConfig,
} from './config.js';

// ============================================================================
// Module-level state
// ============================================================================

const log = createLogger('permission-gate');
let _config: PermissionGateConfig = getDefaultConfig();

// ============================================================================
// Helpers
// ============================================================================

/** Truncate command for status display */
function summarizeCommand(command: string): string {
	const firstLine = command.split('\n')[0].trim();
	return firstLine.length > 120 ? firstLine.slice(0, 117) + '...' : firstLine;
}

// ============================================================================
// Dynamic policy helpers
// ============================================================================

/**
 * 检查路径是否在 scope 范围内。
 * 将路径解析为绝对路径后检查前缀匹配。
 */
function pathInScope(targetPath: string, scopePath: string): boolean {
	const absTarget = resolve(targetPath);
	const absScope = resolve(scopePath);
	return absTarget === absScope || absTarget.startsWith(absScope + sep);
}

/**
 * 从 bash 命令中提取所有看起来像文件/目录路径的参数。
 * 跳过以 - 开头的选项、重定向符号等。
 */
function extractTargetPaths(command: string): string[] {
	// 按空格分割，处理引号
	const tokens: string[] = [];
	let current = '';
	let inSingle = false;
	let inDouble = false;

	for (const ch of command) {
		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			continue;
		}
		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			continue;
		}
		if (inSingle || inDouble) {
			current += ch;
			continue;
		}
		if (/\s/.test(ch)) {
			if (current) {
				tokens.push(current);
				current = '';
			}
		} else {
			current += ch;
		}
	}
	if (current) tokens.push(current);

	// 提取可能为路径的 token：以 / 或 ./ 或 ~/ 开头，或者看起来像相对路径
	const paths = tokens.filter((t) => {
		if (t.startsWith('-')) return false;
		if (t === '>' || t === '>>' || t === '<' || t === '|' || t === '2>' || t === '&>')
			return false;
		// 匹配路径模式
		if (t.startsWith('/') || t.startsWith('./') || t.startsWith('../') || t.startsWith('~'))
			return true;
		// 包含 / 的也可能是路径
		if (t.includes('/') && !t.startsWith('--')) return true;
		return false;
	});

	return [...new Set(paths)]; // 去重
}

/**
 * 检查命令和 cwd 是否在动态策略范围内。
 */
function isInScope(command: string, cwd: string, scope: string): boolean {
	// 1. cwd 必须在 scope 内
	if (!pathInScope(cwd, scope)) {
		log.debug('isInScope: cwd %s not in scope %s', cwd, scope);
		return false;
	}

	// 2. 提取目标路径，必须全部在 scope 内
	const targetPaths = extractTargetPaths(command);
	if (targetPaths.length === 0) {
		// 没有目标路径，仅依赖 cwd 检查
		return true;
	}

	const allInScope = targetPaths.every((p) => {
		const absPath = p.startsWith('~') ? resolve(p.replace('~', homedir())) : resolve(cwd, p);
		return pathInScope(absPath, scope);
	});

	log.debug('isInScope: targets=%j, result=%s', targetPaths, allInScope);
	return allInScope;
}

/**
 * 从命令中提取工具名称（如 rm, sudo, chmod 等）。
 * 跳过 sudo/time/nohup/env/nice/npx/docker exec 等前缀。
 */
function extractToolName(command: string): string {
	const tokens = command.trim().split(/\s+/);
	let i = 0;
	// 跳过常见前缀
	while (
		i < tokens.length - 1 &&
		(tokens[i] === 'sudo' ||
			tokens[i] === 'time' ||
			tokens[i] === 'nohup' ||
			tokens[i] === 'env' ||
			tokens[i] === 'nice' ||
			tokens[i] === 'npx')
	) {
		i++;
	}
	// 特殊处理 "docker exec"
	if (tokens[i] === 'docker' && tokens[i + 1] === 'exec') {
		i += 2;
	}
	return tokens[i]?.split('/').pop() || '';
}

/**
 * 从命令中提取目标文件夹父路径（用于 sameFolder 前缀匹配）。
 * 无论目标路径存在与否、是文件还是目录，都取其父目录作为 key，
 * 使同一父目录下的不同子路径共享 sameFolder 计数。
 *
 * 例如：rm -rf a/b/c 和 rm -rf a/b/d 都产生 dir:<abs>/a/b。
 */
function extractTargetDir(command: string, cwd: string): string {
	const paths = extractTargetPaths(command);
	if (paths.length === 0) return cwd;

	const firstPath = paths[0];
	const absPath = firstPath.startsWith('~')
		? resolve(firstPath.replace('~', homedir()))
		: resolve(cwd, firstPath);

	// 始终取父目录，实现同一文件夹前缀匹配
	return dirname(absPath);
}

/**
 * 检查是否在阈值内自动放行。
 * 返回 { pass: boolean, dimension: string | null }
 * pass=true 表示可以自动放行，dimension 指明命中的维度。
 */
function checkThreshold(
	command: string,
	toolName: string,
	targetDir: string,
	config: PermissionGateConfig,
): { pass: boolean; dimension: string | null } {
	const thresholds = config.dynamicPolicy.thresholds;
	const counts = config.approvalCounts;

	// 1. sameCommand 检查
	const cmdKey = makeCommandKey(command);
	const cmdCount = counts[cmdKey] ?? 0;
	if (cmdCount < thresholds.sameCommand) {
		log.debug('Threshold check: sameCommand pass (%d < %d)', cmdCount, thresholds.sameCommand);
		return { pass: true, dimension: 'sameCommand' };
	}

	// 2. sameTool 检查
	const toolKey = makeToolKey(toolName);
	const toolCount = counts[toolKey] ?? 0;
	if (toolCount < thresholds.sameTool) {
		log.debug('Threshold check: sameTool pass (%d < %d)', toolCount, thresholds.sameTool);
		return { pass: true, dimension: 'sameTool' };
	}

	// 3. sameFolder 检查
	const folderKey = makeFolderKey(targetDir);
	const folderCount = counts[folderKey] ?? 0;
	if (folderCount < thresholds.sameFolder) {
		log.debug('Threshold check: sameFolder pass (%d < %d)', folderCount, thresholds.sameFolder);
		return { pass: true, dimension: 'sameFolder' };
	}

	// 全部超过阈值
	log.info(
		'Dynamic policy: all thresholds exceeded for "%s" (cmd:%d/%d, tool:%d/%d, folder:%d/%d)',
		command.slice(0, 80),
		cmdCount,
		thresholds.sameCommand,
		toolCount,
		thresholds.sameTool,
		folderCount,
		thresholds.sameFolder,
	);
	return { pass: false, dimension: null };
}

/**
 * 更新计数并持久化。
 */
function incrementCountAndSave(key: string, cwd: string): void {
	_config.approvalCounts[key] = (_config.approvalCounts[key] ?? 0) + 1;
	// 保存到项目级
	saveConfig(cwd, _config, 'project');
}

// ============================================================================
// Tool call handler
// ============================================================================

async function handleToolCall(
	event: ToolCallEvent,
	ctx: ExtensionContext,
): Promise<{ block?: boolean; reason?: string } | undefined> {
	if (event.toolName !== 'bash') {
		return undefined;
	}

	const command = event.input.command as string;

	// 1. Gate 关闭 → 直接放行
	if (!_config.enabled) {
		log.debug('Gate disabled, passing through: %s', command.slice(0, 80));
		return undefined;
	}

	// 2. 检查是否命中危险模式
	const isDangerous = _config.patterns.some((p) => {
		try {
			return new RegExp(p, 'i').test(command);
		} catch {
			log.warn('Invalid pattern: %s', p);
			return false;
		}
	});

	if (!isDangerous) {
		log.debug('Not dangerous: %s', command.slice(0, 80));
		return undefined;
	}

	log.debug('Dangerous command detected: %s', command.slice(0, 80));

	const toolName = extractToolName(command);
	const targetDir = extractTargetDir(command, ctx.cwd);

	// 3. 动态策略检查
	if (_config.dynamicPolicyEnabled) {
		const scope = _config.dynamicPolicy.scope;

		// 范围检查：cwd + 目标路径都在 scope 内
		if (isInScope(command, ctx.cwd, scope)) {
			const thresholdResult = checkThreshold(command, toolName, targetDir, _config);

			if (thresholdResult.pass) {
				// 自动放行：更新该维度的计数
				let key: string;
				switch (thresholdResult.dimension) {
					case 'sameCommand':
						key = makeCommandKey(command);
						break;
					case 'sameTool':
						key = makeToolKey(toolName);
						break;
					case 'sameFolder':
						key = makeFolderKey(targetDir);
						break;
					default:
						key = makeCommandKey(command);
				}
				incrementCountAndSave(key, ctx.cwd);

				log.info('Auto-approved (%s): %s', thresholdResult.dimension, command.slice(0, 80));
				// 添加提示到 command
				event.input.command = `echo "✓ Auto-approved (${thresholdResult.dimension})"\n${command}`;
				return undefined;
			}
			// 在 scope 内但阈值全超 → 仍需确认
			log.info(
				'Dynamic policy: in scope but thresholds exceeded — falling through to confirm',
			);
		} else {
			log.info('Dynamic policy: not in scope — falling through to confirm (scope=%s)', scope);
		}
	}

	// 4. No-UI 模式
	if (!ctx.hasUI) {
		log.warn('Dangerous command blocked (no UI): %s', command.slice(0, 80));
		return {
			block: true,
			reason: `Blocked – no UI to confirm dangerous command.\n\`${summarizeCommand(command)}\``,
		};
	}

	// 5. 确认对话框
	const summary = summarizeCommand(command);
	const allowed = await showConfirmDestructive(ctx, '⚠️  Dangerous Command', command);

	if (allowed) {
		log.info('User allowed: %s', command.slice(0, 80));

		// 批量更新三维度计数 + 一次写入（避免三次全量 I/O）
		const cmdKey = makeCommandKey(command);
		const toolKey = makeToolKey(toolName);
		const folderKey = makeFolderKey(targetDir);
		_config.approvalCounts[cmdKey] = (_config.approvalCounts[cmdKey] ?? 0) + 1;
		_config.approvalCounts[toolKey] = (_config.approvalCounts[toolKey] ?? 0) + 1;
		_config.approvalCounts[folderKey] = (_config.approvalCounts[folderKey] ?? 0) + 1;
		saveConfig(ctx.cwd, _config, 'project');

		event.input.command = `echo "✓ User approved: ${summary.replace(/"/g, '\\"')}"\n${command}`;
		return undefined;
	}

	log.info('User blocked: %s', command.slice(0, 80));
	return {
		block: true,
		reason: `🛑 User declined dangerous command.\n\`${summary}\``,
	};
}

// ============================================================================
// Control panel: /permission-gate
// ============================================================================

async function handlePermissionGateCommand(
	_args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (!ctx.hasUI) {
		// Print mode: output config as text
		const lines = [
			'Permission Gate Configuration:',
			`  Enabled: ${_config.enabled}`,
			`  Dynamic Policy: ${_config.dynamicPolicyEnabled}`,
			`  Scope: ${_config.dynamicPolicy.scope}`,
			`  Patterns (${_config.patterns.length}):`,
			..._config.patterns.map((p) => `    - ${p}`),
			`  Thresholds:`,
			`    Same Command: ${_config.dynamicPolicy.thresholds.sameCommand}`,
			`    Same Tool: ${_config.dynamicPolicy.thresholds.sameTool}`,
			`    Same Folder: ${_config.dynamicPolicy.thresholds.sameFolder}`,
			`  Approval Counts: ${summarizeApprovalCounts()}`,
		];
		ctx.ui.notify(lines.join('\n'), 'info');
		return;
	}

	await showMainMenu(ctx);
}

/**
 * 按动态策略维度汇总 approvalCounts，返回可读字符串。
 * 如 "Cmd:5 · Tool:3 · Dir:7 — 15 entries"
 */
function summarizeApprovalCounts(): string {
	let cmd = 0;
	let tool = 0;
	let dir = 0;
	for (const key of Object.keys(_config.approvalCounts)) {
		if (key.startsWith('cmd:')) cmd++;
		else if (key.startsWith('tool:')) tool++;
		else if (key.startsWith('dir:')) dir++;
	}
	const total = cmd + tool + dir;
	if (total === 0) return '0 entries';
	return `Cmd:${cmd} · Tool:${tool} · Dir:${dir} — ${total} entries`;
}


/**
 * 计算各维度尚未达阈值的最高计数，并拼接为进度字符串。
 * 如 "[cmd:2/2,tool:1/3,folder:2/4]"
 * 各维度遍历计数中未超过阈值的最高值展示；
 * 若无任何记录则显示 0/threshold。
 */
function calcDynamicProgress(): string {
	if (!_config.dynamicPolicyEnabled) return '';

	const counts = _config.approvalCounts;
	const th = _config.dynamicPolicy.thresholds;

	// 命令维度：找未达阈值的最高 cmd 计数
	let bestCmd = 0;
	for (const key of Object.keys(counts)) {
		if (key.startsWith('cmd:')) {
			const c = counts[key];
			if (c < th.sameCommand && c > bestCmd) bestCmd = c;
		}
	}

	// 工具维度
	let bestTool = 0;
	for (const key of Object.keys(counts)) {
		if (key.startsWith('tool:')) {
			const c = counts[key];
			if (c < th.sameTool && c > bestTool) bestTool = c;
		}
	}

	// 文件夹维度
	let bestFolder = 0;
	for (const key of Object.keys(counts)) {
		if (key.startsWith('dir:')) {
			const c = counts[key];
			if (c < th.sameFolder && c > bestFolder) bestFolder = c;
		}
	}

	return `[cmd:${bestCmd}/${th.sameCommand},tool:${bestTool}/${th.sameTool},folder:${bestFolder}/${th.sameFolder}]`;
}

async function showMainMenu(ctx: ExtensionCommandContext): Promise<void> {
	while (true) {
		const items: SelectItem[] = [
			{
				value: '__toggle_gate',
				label: `${_config.enabled ? '✅' : '❌'}  Permission Gate`,
				description: _config.enabled
					? 'Enabled — commands are intercepted'
					: 'Disabled — all commands pass through',
			},
			{
				value: '__edit_patterns',
				label: `📋  Intercepted Commands`,
				description: `${_config.patterns.length} patterns configured`,
			},
			{
				value: '__toggle_dynamic',
				label: `${_config.dynamicPolicyEnabled ? '✅' : '❌'}  Dynamic Policy`,
				description: _config.dynamicPolicyEnabled
					? 'Enabled — auto-approve within thresholds'
					: 'Disabled — always ask',
			},
		];

		// 动态策略配置项（仅启用时显示）
		if (_config.dynamicPolicyEnabled) {
			items.push({
				value: '__edit_scope',
				label: '📁  Scope',
				description: `Folder: ${_config.dynamicPolicy.scope}`,
			});
			items.push({
				value: '__edit_thresholds',
				label: '📊  Thresholds',
				description: `Cmd:${_config.dynamicPolicy.thresholds.sameCommand}  Tool:${_config.dynamicPolicy.thresholds.sameTool}  Folder:${_config.dynamicPolicy.thresholds.sameFolder}`,
			});
		}

		items.push({
			value: '__reset_counts',
			label: '🔄  Reset Approval Counts',
			description: summarizeApprovalCounts(),
		});

		const selected = await makeCustomSelection(
			ctx,
			'⚙  Permission Gate Control Panel',
			items,
			'↑↓ navigate • enter select • esc close',
		);

		if (!selected) {
			ctx.ui.notify('Permission Gate closed', 'info');
			return;
		}

		// 处理选中项
		switch (selected) {
			case '__toggle_gate': {
				_config.enabled = !_config.enabled;
				saveConfig(ctx.cwd, _config, 'project');
				ctx.ui.notify(
					`Permission Gate ${_config.enabled ? 'enabled' : 'disabled'}`,
					_config.enabled ? 'info' : 'warning',
				);
				// 实时更新 TUI 状态图标
				if (ctx.hasUI) {
					ctx.ui.setStatus(
						'permission-gate',
						ctx.ui.theme.fg(
							_config.enabled ? 'accent' : 'dim',
							`${_config.enabled ? '🛡' : '◻'} gate:${_config.enabled ? 'on' : 'off'}${calcDynamicProgress()}`,
						),
					);
				}
				break;
			}

			case '__edit_patterns': {
				await editPatternsMenu(ctx);
				break;
			}

			case '__toggle_dynamic': {
				_config.dynamicPolicyEnabled = !_config.dynamicPolicyEnabled;
				saveConfig(ctx.cwd, _config, 'project');
				ctx.ui.notify(
					`Dynamic Policy ${_config.dynamicPolicyEnabled ? 'enabled' : 'disabled'}`,
					'info',
				);
				// 实时更新 TUI 进度
				if (ctx.hasUI) {
					ctx.ui.setStatus(
						'permission-gate',
						ctx.ui.theme.fg(
							_config.enabled ? 'accent' : 'dim',
							`${_config.enabled ? '🛡' : '◻'} gate:${_config.enabled ? 'on' : 'off'}${calcDynamicProgress()}`,
						),
					);
				}
				break;
			}

			case '__edit_scope': {
				const newScopeVal = await ctx.ui.input(
					'Scope Folder Path',
					_config.dynamicPolicy.scope,
				);
				if (newScopeVal === undefined || !newScopeVal.trim()) break;
				const trimmedScope = newScopeVal.trim();
				// 验证路径存在
				const absScopePath = resolve(ctx.cwd, trimmedScope);
				if (!existsSync(absScopePath)) {
					ctx.ui.notify(`Path does not exist: ${trimmedScope}`, 'error');
					break;
				}
				_config.dynamicPolicy.scope = trimmedScope;
				saveConfig(ctx.cwd, _config, 'project');
				ctx.ui.notify(`Scope set to: ${trimmedScope}`, 'info');
				break;
			}

			case '__edit_thresholds': {
				await editThresholdsMenu(ctx);
				break;
			}

			case '__reset_counts': {
				const confirmed = await showConfirmDestructive(
					ctx,
					'Reset Approval Counts?',
					`This will clear ${summarizeApprovalCounts().toLowerCase()}.`,
				);
				if (confirmed) {
					_config.approvalCounts = {};
					saveConfig(ctx.cwd, _config, 'project');
					ctx.ui.notify('Approval counts reset', 'info');
				}
				break;
			}

			default:
				// 未知选项，忽略
				break;
		}
	}
}

/**
 * Helper: 创建一个 TUI 自定义选择组件并返回选中的 value。
 */
async function makeCustomSelection(
	ctx: ExtensionCommandContext,
	title: string,
	items: SelectItem[],
	footer: string,
): Promise<string | null> {
	return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg('accent', s)));
		container.addChild(new Text(theme.fg('accent', theme.bold(title)), 1, 0));

		const selectList = new SelectList(items, Math.min(items.length, 10), {
			selectedPrefix: (t) => theme.fg('accent', t),
			selectedText: (t) => theme.fg('accent', t),
			description: (t) => theme.fg('muted', t),
			scrollInfo: (t) => theme.fg('dim', t),
			noMatch: (t) => theme.fg('warning', t),
		});

		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(null);

		container.addChild(selectList);
		container.addChild(new Text(theme.fg('dim', footer), 1, 0));
		container.addChild(new DynamicBorder((s: string) => theme.fg('accent', s)));

		return {
			render: (w) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

/**
 * 编辑拦截命令模式列表。
 */
async function editPatternsMenu(ctx: ExtensionCommandContext): Promise<void> {
	while (true) {
		const items: SelectItem[] = _config.patterns.map((p, i) => ({
			value: `__pattern_${i}`,
			label: p,
		}));

		// 添加操作选项
		items.push({ value: '__add_pattern', label: '➕ Add custom pattern' });
		items.push({ value: '__back', label: '↩ Back to main menu' });

		const selected = await makeCustomSelection(
			ctx,
			'📋 Intercepted Commands',
			items,
			'↑↓ navigate • enter to remove • esc back',
		);

		if (!selected || selected === '__back') return;

		if (selected === '__add_pattern') {
			const newPattern = await ctx.ui.input('Enter regex pattern', '');
			if (newPattern && newPattern.trim()) {
				const trimmed = newPattern.trim();
				// 检查重复
				if (_config.patterns.includes(trimmed)) {
					ctx.ui.notify(`Pattern already exists: ${trimmed}`, 'error');
					continue;
				}
				try {
					new RegExp(trimmed);
					_config.patterns.push(trimmed);
					saveConfig(ctx.cwd, _config, 'project');
					ctx.ui.notify(`Pattern added: ${trimmed}`, 'info');
				} catch {
					ctx.ui.notify(`Invalid regex: ${trimmed}`, 'error');
				}
			}
			continue;
		}

		// Remove pattern
		const idx = parseInt(selected.replace('__pattern_', ''), 10);
		const pattern = _config.patterns[idx];
		if (pattern) {
			const confirmed = await showConfirmDestructive(
				ctx,
				'Remove Pattern?',
				`Remove pattern:\n\`${pattern}\``,
			);
			if (confirmed) {
				_config.patterns.splice(idx, 1);
				saveConfig(ctx.cwd, _config, 'project');
				ctx.ui.notify('Pattern removed', 'info');
			}
		}
	}
}

/**
 * 编辑阈值。
 */
async function editThresholdsMenu(ctx: ExtensionCommandContext): Promise<void> {
	while (true) {
		const items: SelectItem[] = [
			{
				value: '__threshold_sameCommand',
				label: `📝  Same Command Threshold`,
				description: `Current: ${_config.dynamicPolicy.thresholds.sameCommand}`,
			},
			{
				value: '__threshold_sameTool',
				label: `🔧  Same Tool Threshold`,
				description: `Current: ${_config.dynamicPolicy.thresholds.sameTool}`,
			},
			{
				value: '__threshold_sameFolder',
				label: `📁  Same Folder Threshold`,
				description: `Current: ${_config.dynamicPolicy.thresholds.sameFolder}`,
			},
			{
				value: '__back',
				label: '↩ Back',
				description: 'Return to main menu',
			},
		];

		const selected = await makeCustomSelection(
			ctx,
			'📊 Threshold Configuration',
			items,
			'↑↓ navigate • enter select • esc back',
		);

		if (!selected || selected === '__back') return;

		// 映射选择到配置键名
		const keyMap: Record<string, string> = {
			__threshold_sameCommand: 'sameCommand',
			__threshold_sameTool: 'sameTool',
			__threshold_sameFolder: 'sameFolder',
		};
		const configKey = keyMap[selected] as keyof typeof _config.dynamicPolicy.thresholds;
		if (!configKey) continue;

		const currentValue = _config.dynamicPolicy.thresholds[configKey];
		const input = await ctx.ui.input(`Enter threshold for ${configKey}`, String(currentValue));
		if (input !== undefined) {
			const num = parseInt(input.trim(), 10);
			if (!Number.isNaN(num) && num >= 0) {
				(_config.dynamicPolicy.thresholds as Record<string, number>)[configKey] = num;
				saveConfig(ctx.cwd, _config, 'project');
				ctx.ui.notify(`${configKey} threshold set to ${num}`, 'info');
			} else {
				ctx.ui.notify('Invalid number, please enter a non-negative integer', 'error');
			}
		}
	}
}

// ============================================================================
// Extension factory
// ============================================================================

export default function permissionGateExtension(pi: ExtensionAPI) {
	// 1. Register CLI flag
	pi.registerFlag('no-permission-gate', {
		description: 'Disable permission gate entirely',
		type: 'boolean',
		default: false,
	});

	// 2. On session_start: load config, check CLI flag
	pi.on('session_start', async (_event, ctx) => {
		const flagDisabled = pi.getFlag('no-permission-gate') === true;
		if (flagDisabled) {
			log.info('Permission gate disabled via --no-permission-gate flag');
			_config = { ...getDefaultConfig(), enabled: false };
			if (ctx.hasUI) {
				ctx.ui.notify('Permission Gate disabled via --no-permission-gate', 'warning');
			}
			return;
		}

		// Load config from files
		_config = loadConfig(ctx.cwd);
		log.info(
			'Config loaded: enabled=%s, dynamicPolicy=%s',
			_config.enabled,
			_config.dynamicPolicyEnabled,
		);

		// Set status widget
		if (ctx.hasUI) {
			const statusIcon = _config.enabled ? '🛡' : '◻';
			ctx.ui.setStatus(
				'permission-gate',
				ctx.ui.theme.fg(
					_config.enabled ? 'accent' : 'dim',
					`${statusIcon} gate:${_config.enabled ? 'on' : 'off'}${calcDynamicProgress()}`,
				),
			);
		}
	});

	// 3. Register /permission-gate command
	pi.registerCommand('permission-gate', {
		description: 'Open Permission Gate control panel',
		handler: handlePermissionGateCommand,
	});

	// 4. Intercept bash tool calls
	pi.on('tool_call', async (event, ctx) => {
		return handleToolCall(event, ctx);
	});

	log.debug('Permission Gate v2 loaded');
}
