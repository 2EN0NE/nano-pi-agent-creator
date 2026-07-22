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
import {
	loadRecords,
	appendRecord,
	appendBlockedRecord,
	getStrategySummary,
	calcWidgetContentText,
	splitCompoundCommand,
	countNonBlockedEntries,
} from './records.js';
import { showTwoTabPanel } from './two-tab-panel.js';

// ============================================================================
// Module-level state
// ============================================================================

const log = createLogger('permission-gate');
let _config: PermissionGateConfig = getDefaultConfig();
let _counts: Record<string, number> = {};
// biome-ignore lint/style/noConst: must be reassigned on appendRecord
let _totalRecords = 0;

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
export function pathInScope(targetPath: string, scopePath: string): boolean {
	const absTarget = resolve(targetPath);
	const absScope = resolve(scopePath);
	return absTarget === absScope || absTarget.startsWith(absScope + sep);
}

/**
 * 从 bash 命令中提取所有看起来像文件/目录路径的参数。
 * 跳过以 - 开头的选项、重定向符号等。
 */
export function extractTargetPaths(command: string): string[] {
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
export function extractToolName(command: string): string {
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
export function extractTargetDir(command: string, cwd: string): string {
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
 * 检查是否在阈值内自动放行（并行检查：三个维度独立判断）。
 * 返回 { pass: boolean, dimensions: string[] }
 * pass=true 表示至少一个维度可以放行，dimensions 为所有通过维度的数组。
 */
export function checkThreshold(
	command: string,
	toolName: string,
	targetDir: string,
	config: PermissionGateConfig,
	counts: Record<string, number>,
): { pass: boolean; dimensions: string[] } {
	const thresholds = config.dynamicPolicy.thresholds;
	const passing: string[] = [];

	// 并行检查三个维度
	const cmdKey = makeCommandKey(command);
	const cmdCount = counts[cmdKey] ?? 0;
	if (cmdCount < thresholds.sameCommand) {
		passing.push('sameCommand');
	}

	const toolKey = makeToolKey(toolName);
	const toolCount = counts[toolKey] ?? 0;
	if (toolCount < thresholds.sameTool) {
		passing.push('sameTool');
	}

	const folderKey = makeFolderKey(targetDir);
	const folderCount = counts[folderKey] ?? 0;
	if (folderCount < thresholds.sameFolder) {
		passing.push('sameFolder');
	}

	const pass = passing.length > 0;
	if (pass) {
		log.debug(
			'Threshold check: parallel pass — dims=%j (cmd:%d/%d, tool:%d/%d, folder:%d/%d)',
			passing,
			cmdCount,
			thresholds.sameCommand,
			toolCount,
			thresholds.sameTool,
			folderCount,
			thresholds.sameFolder,
		);
	} else {
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
	}

	return { pass, dimensions: passing };
}

/**
 * 检查某条子命令是否已沉淀（存在 graduated 策略）。
 * 当命令的 cmd:hash 在 _counts 中计数 >= sameCommand 阈值时，
 * 表示该命令已积累了足够次数，可以自动放行。
 */
export function hasGraduatedStrategy(
	command: string,
	counts: Record<string, number>,
	thresholds: { sameCommand: number },
): boolean {
	// 阈值为 0 意味着"永不自动放行"，无沉淀策略
	if (thresholds.sameCommand <= 0) return false;
	const cmdKey = makeCommandKey(command);
	const count = counts[cmdKey] ?? 0;
	return count >= thresholds.sameCommand;
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

	const fullCommand = event.input.command as string;

	// 1. Gate 关闭 → 直接放行
	if (!_config.enabled) {
		log.debug('Gate disabled, passing through: %s', fullCommand.slice(0, 80));
		return undefined;
	}

	// 2. 拆分组合命令，逐条检查
	const subCommands = splitCompoundCommand(fullCommand);

	// 每条子命令的判断结果
	const results: Array<{
		cmd: string;
		dangerous: boolean;
		pass: boolean;
		dim: string | string[] | null;
	}> = [];

	let anyDangerous = false;

	for (const sub of subCommands) {
		const isDangerous = _config.patterns.some((p) => {
			try {
				return new RegExp(p, 'i').test(sub);
			} catch {
				log.warn('Invalid pattern: %s', p);
				return false;
			}
		});

		if (!isDangerous) {
			results.push({ cmd: sub, dangerous: false, pass: true, dim: null });
			continue;
		}

		anyDangerous = true;

		// 动态策略开启时，先查已沉淀策略，再查阈值
		if (_config.dynamicPolicyEnabled) {
			// 查已沉淀策略：cmd 已毕业 → 自动放行
			if (hasGraduatedStrategy(sub, _counts, _config.dynamicPolicy.thresholds)) {
				log.debug('Graduated strategy match: %s', sub.slice(0, 80));
				results.push({ cmd: sub, dangerous: true, pass: true, dim: 'graduated' });
				continue;
			}

			// 阈值检查（并行）
			const subTool = extractToolName(sub);
			const subDir = extractTargetDir(sub, ctx.cwd);

			if (isInScope(sub, ctx.cwd, _config.dynamicPolicy.scope)) {
				const thResult = checkThreshold(sub, subTool, subDir, _config, _counts);
				if (thResult.pass) {
					results.push({
						cmd: sub,
						dangerous: true,
						pass: true,
						dim: thResult.dimensions,
					});
					continue;
				}
				// 在 scope 内但阈值全超
				log.info(
					'Dynamic policy: in scope but thresholds exceeded — falling through to confirm',
				);
			} else {
				log.info(
					'Dynamic policy: not in scope — falling through to confirm (scope=%s)',
					_config.dynamicPolicy.scope,
				);
			}
		}

		// 需确认
		results.push({ cmd: sub, dangerous: true, pass: false, dim: null });
	}

	// 无危险子命令 → 直接放行
	if (!anyDangerous) {
		log.debug('No dangerous sub-commands in: %s', fullCommand.slice(0, 80));
		return undefined;
	}

	// 收集需确认的条目
	const needsConfirm = results.filter((r) => r.dangerous && !r.pass);

	// 有需确认的条目
	if (needsConfirm.length > 0) {
		// No-UI 模式 → 全部 block
		if (!ctx.hasUI) {
			log.warn('Dangerous command blocked (no UI): %s', fullCommand.slice(0, 80));
			for (const r of results) {
				if (r.dangerous) {
					appendBlockedRecord(ctx.cwd, {
						ts: new Date().toISOString(),
						cmd: r.cmd,
						tool: extractToolName(r.cmd),
						dir: extractTargetDir(r.cmd, ctx.cwd),
						dim: null,
						action: 'blocked',
					});
				}
			}
			return {
				block: true,
				reason: `Blocked -- no UI to confirm dangerous command.\n\`${summarizeCommand(fullCommand)}\``,
			};
		}

		// 显示确认对话框 — 展示原始命令 + 拆解后的子命令
		const subCmdList = results.map((r) => `  ${r.dangerous ? '⚠ ' : '  '}${r.cmd}`).join('\n');
		const confirmMessage = `${fullCommand}\n\nSub-commands:\n${subCmdList}`;
		const allowed = await showConfirmDestructive(ctx, '⚠  Dangerous Command', confirmMessage);

		if (allowed) {
			log.info('User allowed: %s', fullCommand.slice(0, 80));

			// 逐条记录 confirmed（dim=null 表示用户手动确认，非阈值自动放行）
			for (const r of results) {
				if (!r.dangerous) continue;
				appendRecord(
					ctx.cwd,
					{
						ts: new Date().toISOString(),
						cmd: r.cmd,
						tool: extractToolName(r.cmd),
						dir: extractTargetDir(r.cmd, ctx.cwd),
						dim: null,
						action: 'confirmed',
						originalCommand: fullCommand,
						subCommands,
					},
					_counts,
				);
				_totalRecords++;
			}

			event.input.command = `echo "✓ User approved"\n${fullCommand}`;
			updateWidgetStatus(ctx);
			return undefined;
		}

		// 用户拒绝
		log.info('User blocked: %s', fullCommand.slice(0, 80));
		for (const r of results) {
			if (r.dangerous) {
				appendBlockedRecord(ctx.cwd, {
					ts: new Date().toISOString(),
					cmd: r.cmd,
					tool: extractToolName(r.cmd),
					dir: extractTargetDir(r.cmd, ctx.cwd),
					dim: null,
					action: 'blocked',
				});
			}
		}
		return {
			block: true,
			reason: `User declined dangerous command.\n\`${summarizeCommand(fullCommand)}\``,
		};
	}

	// 全部自动放行 → 逐条记录 auto
	const autoDims = new Set<string>();
	for (const r of results) {
		if (!r.dangerous) continue;

		// graduated → dim=['sameCommand']; parallel check → dim 直接是数组
		const recordDim: string[] | null =
			r.dim === 'graduated' ? ['sameCommand'] : Array.isArray(r.dim) ? r.dim : null;

		appendRecord(
			ctx.cwd,
			{
				ts: new Date().toISOString(),
				cmd: r.cmd,
				tool: extractToolName(r.cmd),
				dir: extractTargetDir(r.cmd, ctx.cwd),
				dim: recordDim,
				action: 'auto',
				originalCommand: fullCommand,
				subCommands,
			},
			_counts,
		);
		_totalRecords++;
		if (r.dim && typeof r.dim === 'string') autoDims.add(r.dim);
		else if (Array.isArray(r.dim)) r.dim.forEach((d) => autoDims.add(d));
	}

	const dimSummary = [...autoDims].join(',');
	log.info('Auto-approved (%s): %s', dimSummary || 'graduated', fullCommand.slice(0, 80));
	event.input.command = `echo "✓ Auto-approved (${dimSummary || 'graduated'})"\n${fullCommand}`;
	updateWidgetStatus(ctx);
	return undefined;
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
 * 计算各维度策略总数的摘要字符串（用于 print 模式展示）。
 */
function summarizeApprovalCounts(): string {
	const summary = getStrategySummary(_counts, _config.dynamicPolicy.thresholds);
	const parts: string[] = [];
	if (summary.cmd.total > 0) parts.push(`Cmd(${summary.cmd.total})`);
	if (summary.tool.total > 0) parts.push(`Tool(${summary.tool.total})`);
	if (summary.dir.total > 0) parts.push(`Dir(${summary.dir.total})`);
	return parts.length > 0 ? parts.join(' - ') : 'No strategies';
}

/**
 * 更新 status widget，使用 calcWidgetContentText 计算纯文本 + ANSI 着色。
 *
 * Dynamic ON 时，对最优进度（仅限活跃策略，不包含已沉淀的）着色。
 * 注意：内层 th.fg() 避免嵌套，防止 \x1b[39m 重置外层 accent 色。
 */
function updateWidgetStatus(ctx: ExtensionContext | ExtensionCommandContext): void {
	if (!ctx.hasUI) return;
	if (!_config.widget.show) {
		ctx.ui.setStatus('permission-gate', '');
		return;
	}

	const th = ctx.ui.theme;
	const text = calcWidgetContentText(
		_config.enabled,
		_config.dynamicPolicyEnabled,
		_counts,
		_config.dynamicPolicy.thresholds,
		_totalRecords,
	);

	if (_config.widget.detailLevel === 'gate') {
		// 仅显示 gate 级别（取第一个括号段）
		const gateMatch = text.match(/^.*?\(\d+\[\d+\]\)/);
		if (gateMatch) {
			ctx.ui.setStatus('permission-gate', th.fg('accent', gateMatch[0]));
			return;
		}
	}

	// Gate OFF: 简洁着色
	if (!_config.enabled) {
		ctx.ui.setStatus('permission-gate', th.fg('dim', text));
		return;
	}

	// Dynamic OFF: 整体着色
	if (!_config.dynamicPolicyEnabled) {
		ctx.ui.setStatus('permission-gate', th.fg('accent', text));
		return;
	}

	// Dynamic ON: 对已达阈值的进度部分高亮
	// 提取 accent SGR 码，用于内层高亮后恢复外层 accent 色
	const accentTest = th.fg('accent', 'X');
	const sgrMatch = accentTest.match(/^\x1b\[\d+m/);
	const accentSgr = sgrMatch ? sgrMatch[0] : '';

	let colored = text;
	const dims: { prefix: string }[] = [
		{ prefix: 'cmd' },
		{ prefix: 'tool' },
		{ prefix: 'folder' },
	];
	for (const { prefix } of dims) {
		const re = new RegExp(`${prefix}\\(\\d+\\[\\d+\\]\\):(\\d+)/(\\d+)`);
		const m = text.match(re);
		if (!m) continue;
		const capped = parseInt(m[1], 10);
		const threshold = parseInt(m[2], 10);
		const atTh = capped >= threshold;
		if (!atTh) continue;

		const fullMatch = m[0];
		// 内层高亮：使用 th.fg() 但去除尾部的 \x1b[39m，替换为 accent 色码
		// 这样外层 th.fg('accent', colored) 的 \x1b[39m 是唯一的 reset
		const progressColored = th.fg('warning', `${capped}/${threshold}`);
		const progressFixed = progressColored.replace(/\x1b\[39m$/, accentSgr);
		const coloredFull = fullMatch.replace(`:${capped}/${threshold}`, `:${progressFixed}`);
		colored = colored.replace(fullMatch, coloredFull);
	}

	ctx.ui.setStatus('permission-gate', th.fg('accent', colored));
}

async function showMainMenu(ctx: ExtensionCommandContext): Promise<void> {
	let lastMenuIndex = 0;
	while (true) {
		const items: SelectItem[] = [
			{
				value: '__toggle_gate',
				label: `[${_config.enabled ? 'X' : ' '}]  Permission Gate`,
				description: _config.enabled
					? 'Enabled — commands are intercepted'
					: 'Disabled — all commands pass through',
			},
			{
				value: '__edit_patterns',
				label: '[Patterns]  Intercepted Commands',
				description: `${_config.patterns.length} patterns configured`,
			},
			{
				value: '__toggle_dynamic',
				label: `[${_config.dynamicPolicyEnabled ? 'X' : ' '}]  Dynamic Policy`,
				description: _config.dynamicPolicyEnabled
					? 'Enabled — auto-approve within thresholds'
					: 'Disabled — always ask',
			},
		];

		// 动态策略配置项（仅启用时显示）
		if (_config.dynamicPolicyEnabled) {
			items.push({
				value: '__edit_scope',
				label: '[Scope]',
				description: `Folder: ${_config.dynamicPolicy.scope}`,
			});
			items.push({
				value: '__edit_thresholds',
				label: '[Thresholds]',
				description: `Cmd:${_config.dynamicPolicy.thresholds.sameCommand}  Tool:${_config.dynamicPolicy.thresholds.sameTool}  Folder:${_config.dynamicPolicy.thresholds.sameFolder}`,
			});
		}

		items.push({
			value: '__view_strategies',
			label: `[Strategies]  Current Allowed  ${summarizeApprovalCounts()}`,
			description: 'View and manage strategies & history',
		});

		// Widget 控制选项
		items.push({
			value: '__toggle_widget_show',
			label: `[Widget]  ${_config.widget.show ? 'Shown' : 'Hidden'}`,
			description: 'Toggle widget display in status bar',
		});
		items.push({
			value: '__toggle_widget_detail',
			label: `[Widget Detail]  ${_config.widget.detailLevel === 'full' ? 'Full' : 'Gate Only'}`,
			description:
				_config.widget.detailLevel === 'full'
					? 'Show gate + cmd/tool/folder details'
					: 'Show gate summary only',
		});

		const selected = await makeCustomSelection(
			ctx,
			'Permission Gate Control Panel',
			items,
			'up/down navigate  enter select  esc close',
			lastMenuIndex,
		);

		if (!selected) {
			ctx.ui.notify('Permission Gate closed', 'info');
			return;
		}

		// 记住当前选中项的位置，下次循环恢复
		lastMenuIndex = items.findIndex((item) => item.value === selected);

		// 处理选中项
		switch (selected) {
			case '__toggle_gate': {
				_config.enabled = !_config.enabled;
				saveConfig(ctx.cwd, _config, 'project');
				ctx.ui.notify(
					`Permission Gate ${_config.enabled ? 'enabled' : 'disabled'}`,
					_config.enabled ? 'info' : 'warning',
				);
				updateWidgetStatus(ctx);
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
				updateWidgetStatus(ctx);
				break;
			}

			case '__edit_scope': {
				const newScopeVal = await ctx.ui.input(
					'Scope Folder Path',
					_config.dynamicPolicy.scope,
				);
				if (newScopeVal === undefined || !newScopeVal.trim()) break;
				const trimmedScope = newScopeVal.trim();
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

			case '__view_strategies': {
				await showTwoTabPanel(
					ctx,
					_counts,
					_config.dynamicPolicy.thresholds,
					(newCounts) => {
						_counts = newCounts;
						updateWidgetStatus(ctx);
					},
				);
				break;
			}

			case '__toggle_widget_show': {
				_config.widget.show = !_config.widget.show;
				saveConfig(ctx.cwd, _config, 'project');
				ctx.ui.notify(`Widget ${_config.widget.show ? 'shown' : 'hidden'}`, 'info');
				updateWidgetStatus(ctx);
				break;
			}

			case '__toggle_widget_detail': {
				_config.widget.detailLevel =
					_config.widget.detailLevel === 'full' ? 'gate' : 'full';
				saveConfig(ctx.cwd, _config, 'project');
				ctx.ui.notify(
					`Widget detail: ${_config.widget.detailLevel === 'full' ? 'Full' : 'Gate Only'}`,
					'info',
				);
				updateWidgetStatus(ctx);
				break;
			}

			default:
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
	defaultIndex = 0,
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

		if (defaultIndex > 0 && defaultIndex < items.length) {
			selectList.setSelectedIndex(defaultIndex);
		}

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
		items.push({ value: '__add_pattern', label: '[Add] Add custom pattern' });
		items.push({ value: '__back', label: '[Back] Back to main menu' });

		const selected = await makeCustomSelection(
			ctx,
			'Intercepted Commands',
			items,
			'up/down navigate  enter to remove  esc back',
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
				label: `[sameCommand]  Same Command Threshold`,
				description: `Current: ${_config.dynamicPolicy.thresholds.sameCommand}`,
			},
			{
				value: '__threshold_sameTool',
				label: `[sameTool]  Same Tool Threshold`,
				description: `Current: ${_config.dynamicPolicy.thresholds.sameTool}`,
			},
			{
				value: '__threshold_sameFolder',
				label: `[sameFolder]  Same Folder Threshold`,
				description: `Current: ${_config.dynamicPolicy.thresholds.sameFolder}`,
			},
			{
				value: '__back',
				label: '[Back] Back',
				description: 'Return to main menu',
			},
		];

		const selected = await makeCustomSelection(
			ctx,
			'Threshold Configuration',
			items,
			'up/down navigate  enter select  esc back',
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
			updateWidgetStatus(ctx);
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

		// Load approval records & migrate legacy counts (if any)
		const result = loadRecords(ctx.cwd);
		_counts = result.counts;
		_totalRecords = countNonBlockedEntries(result.entries);

		updateWidgetStatus(ctx);
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
