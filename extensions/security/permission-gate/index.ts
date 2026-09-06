/**
 * Permission Gate Extension v2
 *
 * 增强版权限控制面板，提供：
 * - 危险命令拦截与用户确认
 * - 动态策略自动放行（同指令/同工具/同文件夹三级阈值）
 * - /permission-gate TUI 控制面板
 * - 持久化配置（项目级 > 用户级 > 默认值）
 * - --no-permission-gate CLI flag
 *
 * ── 状态模型 ──
 * 使用 PermissionGateState 作为显式状态容器，在 session_start 时创建，
 * 通过参数传递给所有 handler。不再使用模块级 let 变量。
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolCallEvent,
} from '@earendil-works/pi-coding-agent';
import { createLogger } from '@zenone/pi-logger';
import { homedir } from 'node:os';
import { dirname, resolve, sep } from 'node:path';
import {
	type PermissionGateConfig,
	type DangerTier,
	getDefaultConfig,
	loadConfig,
	makeCommandKey,
	makeFolderKey,
	makeToolKey,
	saveConfig,
} from './config.js';
import { assessTier, type TierHit } from './tiering.js';
import { getRuleCounts, setRulesSessionId, cleanupRulesStore } from './approval-store.js';
import {
	hasManualStrategy,
	addManualStrategy,
	setManualStrategiesSessionId,
	cleanupManualStrategiesStore,
} from './manual-strategies.js';
import { warmBashParser } from './bash-parser.js';
import { showConfirmTree, type ConfirmTreeLeaf } from './confirm-tree.js';
import { appendAudit, newRequestId, cleanupAudit } from './audit-log.js';
import {
	installPermissionGateApi,
	registerPendingRequest,
	resolvePendingRequest,
	type ConfirmDecision,
} from './confirm-api.js';
import {
	getStrategySummary,
	calcWidgetContentText,
	splitCompoundCommand,
	getProjectKey,
	migrateApprovalsToAudit,
} from './records.js';
import { showTwoTabPanel } from './two-tab-panel.js';
import { PermissionGateState } from './state.js';

const log = createLogger('permission-gate');

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

	// 并行检查三个维度：计数达到该维度阈值 → 该维度"毕业"→ 可放行（graduated 语义）
	// 阈值 0 表示"永不自动放行"（与 hasGraduatedStrategy 的 `<= 0 return false` 一致）
	const cmdKey = makeCommandKey(command);
	const cmdCount = counts[cmdKey] ?? 0;
	if (thresholds.sameCommand > 0 && cmdCount >= thresholds.sameCommand) {
		passing.push('sameCommand');
	}

	const toolKey = makeToolKey(toolName);
	const toolCount = counts[toolKey] ?? 0;
	if (thresholds.sameTool > 0 && toolCount >= thresholds.sameTool) {
		passing.push('sameTool');
	}

	const folderKey = makeFolderKey(targetDir);
	const folderCount = counts[folderKey] ?? 0;
	if (thresholds.sameFolder > 0 && folderCount >= thresholds.sameFolder) {
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
 * 当命令的 cmd:hash 在 counts 中计数 >= sameCommand 阈值时，
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
	state: PermissionGateState,
): Promise<{ block?: boolean; reason?: string } | undefined> {
	if (event.toolName !== 'bash') {
		return undefined;
	}

	const fullCommand = event.input.command as string;
	// 每次命令执行的唯一 request/control ID（ADR-0027）
	const requestId = newRequestId();
	const ts = new Date().toISOString();
	// 项目标识（audit 记录按此过滤历史）
	const projectKey = getProjectKey(ctx.cwd);
	// 审计溯源（UX3）：会话 ID / 项目路径 / 会话名快照——历史按来源范围筛选与展示
	const auditOrigin = {
		sessionId: ctx.sessionManager.getSessionId(),
		projectPath: ctx.cwd,
		sessionName: ctx.sessionManager.getSessionName(),
	};
	// 统一在写审计时附加溯源字段
	const audit = (entry: Parameters<typeof appendAudit>[0]) =>
		appendAudit({ ...auditOrigin, ...entry });

	// 1. Gate 关闭 → 直接放行
	if (!state.config.enabled) {
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
		tier: DangerTier | null;
		reasons: string[];
		hits: TierHit[];
	}> = [];

	let anyDangerous = false;

	for (const sub of subCommands) {
		const assessment = assessTier(sub, state.config);
		const isDangerous = assessment !== null;

		if (!isDangerous) {
			results.push({
				cmd: sub,
				dangerous: false,
				pass: true,
				dim: null,
				tier: null,
				reasons: [],
				hits: [],
			});
			continue;
		}

		anyDangerous = true;

		// 手动策略优先（ADR-0030）：命中用户显式创建的策略 → 直接放行，
		// 不依赖动态策略开关，且优先于 graduated 计数。
		const subKey = makeCommandKey(sub);
		if (hasManualStrategy(subKey)) {
			log.debug('Manual strategy match: %s', sub.slice(0, 80));
			results.push({
				cmd: sub,
				dangerous: true,
				pass: true,
				dim: 'manual',
				tier: assessment!.tier,
				reasons: assessment!.reasons,
				hits: assessment!.hits,
			});
			continue;
		}

		// 动态策略开启时，先查已沉淀策略，再查阈值
		if (state.config.dynamicPolicyEnabled) {
			// 查已沉淀策略：cmd 已毕业 → 自动放行
			if (hasGraduatedStrategy(sub, getRuleCounts(), state.config.dynamicPolicy.thresholds)) {
				log.debug('Graduated strategy match: %s', sub.slice(0, 80));
				results.push({
					cmd: sub,
					dangerous: true,
					pass: true,
					dim: 'graduated',
					tier: assessment!.tier,
					reasons: assessment!.reasons,
					hits: assessment!.hits,
				});
				continue;
			}

			// 阈值检查（并行）
			const subTool = extractToolName(sub);
			const subDir = extractTargetDir(sub, ctx.cwd);

			if (isInScope(sub, ctx.cwd, state.config.dynamicPolicy.scope)) {
				const thResult = checkThreshold(
					sub,
					subTool,
					subDir,
					state.config,
					getRuleCounts(),
				);
				if (thResult.pass) {
					results.push({
						cmd: sub,
						dangerous: true,
						pass: true,
						dim: thResult.dimensions,
						tier: assessment!.tier,
						reasons: assessment!.reasons,
						hits: assessment!.hits,
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
					state.config.dynamicPolicy.scope,
				);
			}
		}

		// 需确认
		results.push({
			cmd: sub,
			dangerous: true,
			pass: false,
			dim: null,
			tier: assessment!.tier,
			reasons: assessment!.reasons,
			hits: assessment!.hits,
		});
	}

	// 无危险子命令 → 直接放行（全量审计：allow）
	if (!anyDangerous) {
		log.debug('No dangerous sub-commands in: %s', fullCommand.slice(0, 80));
		audit({
			id: requestId,
			ts,
			tool: 'bash',
			command: summarizeCommand(fullCommand),
			tier: null,
			decision: 'allow',
			reasons: [],
			projectKey,
			originalCommand: fullCommand,
			subCommands,
		});
		return undefined;
	}

	// 收集需确认的条目
	// 计算最高 tier（用于审计记录）
	const rank = (t: DangerTier) => (t === 'critical' ? 3 : t === 'warning' ? 2 : 1);
	let highestTier: DangerTier | null = null;
	for (const r of results) {
		if (r.tier && (highestTier === null || rank(r.tier) > rank(highestTier))) {
			highestTier = r.tier;
		}
	}

	const needsConfirm = results.filter((r) => r.dangerous && !r.pass);

	// 有需确认的条目
	if (needsConfirm.length > 0) {
		// No-UI 模式 → 全部 block
		if (!ctx.hasUI) {
			log.warn('Dangerous command blocked (no UI): %s', fullCommand.slice(0, 80));
			audit({
				id: requestId,
				ts,
				tool: 'bash',
				command: summarizeCommand(fullCommand),
				tier: highestTier,
				decision: 'deny',
				reasons: results.filter((r) => r.dangerous).flatMap((r) => r.reasons),
				projectKey,
				originalCommand: fullCommand,
				subCommands,
			});
			return {
				block: true,
				reason: `Blocked -- no UI to confirm dangerous command.\n\`${summarizeCommand(fullCommand)}\``,
			};
		}

		// 显示阻断确认树（ADR-0030）——两层命令树：根=完整命令，叶子=拆解的子命令
		const leaves: ConfirmTreeLeaf[] = results.map((r) => ({
			cmd: r.cmd,
			tier: r.tier,
			reasons: r.reasons,
			hits: r.hits,
		}));
		// 注册待确认请求（外部通道可并行确认，ADR-0028）
		const pending = registerPendingRequest({
			requestId,
			tool: 'bash',
			command: summarizeCommand(fullCommand),
			level: highestTier ?? 'info',
			reasons: results.filter((r) => r.dangerous).flatMap((r) => r.reasons),
		});

		// 系统通知（ask 拦截时触发，ADR-0028）—— 弱桥接，notify 插件缺失时跳过
		// SAFETY: __notifyApi 由 notify 插件写入，形状固定为 { notify(title, body) }
		const notifyBridge = (
			globalThis as unknown as {
				__notifyApi?: { notify: (title: string, body: string) => void };
			}
		).__notifyApi;
		if (notifyBridge) {
			notifyBridge.notify(
				'危险命令待确认',
				`[${pending.shortCode}] ${summarizeCommand(fullCommand)}`,
			);
		}

		// TUI 对话框与外部通道竞争：谁先来谁生效。
		// AbortController 用于外部通道先确认时关闭尚未落败的 TUI 确认框（P2 修复）。
		const abortController = new AbortController();
		const tuiDecision = showConfirmTree(ctx, fullCommand, leaves, {
			signal: abortController.signal,
			defaultScope: state.config.defaultPersistenceScope,
			onAddStrategy: (leaf, scope) => {
				addManualStrategy(makeCommandKey(leaf.cmd), leaf.cmd, scope);
				log.info('Manual strategy added: %s → %s', leaf.cmd.slice(0, 80), scope);
			},
		}).then((v): ConfirmDecision => (v === 'allow' ? 'allow' : 'deny'));

		const decision = await Promise.race([tuiDecision, pending.result]);
		// 关闭尚未落败的 TUI 确认框——外部通道先 confirm 时模态框不再滞留截获按键；
		// TUI 先来时 overlay 已关闭，abort 是 no-op（signal 监听器已随 dispose 移除）。
		abortController.abort();
		// 清理 pending（TUI 先来时释放外部通道的等待；外部先来时已解析，此处 no-op）
		resolvePendingRequest(requestId, decision);
		const allowed = decision === 'allow';

		if (allowed) {
			log.info('User allowed: %s', fullCommand.slice(0, 80));

			// 逐条累加 confirmed 计数（pi-state；审计由下方 appendAudit 记录）
			for (const r of results) {
				if (!r.dangerous || !r.tier) continue;
				state.recordApprovalFor(
					{
						cmd: r.cmd,
						tool: extractToolName(r.cmd),
						dir: extractTargetDir(r.cmd, ctx.cwd),
					},
					r.tier,
				);
			}

			event.input.command = `echo "[OK] User approved"\n${fullCommand}`;
			audit({
				id: requestId,
				ts,
				tool: 'bash',
				command: summarizeCommand(fullCommand),
				tier: highestTier,
				decision: 'ask',
				reasons: results.filter((r) => r.dangerous).flatMap((r) => r.reasons),
				projectKey,
				originalCommand: fullCommand,
				subCommands,
			});
			updateWidgetStatus(ctx, state);
			return undefined;
		}

		// 用户拒绝
		log.info('User blocked: %s', fullCommand.slice(0, 80));
		audit({
			id: requestId,
			ts,
			tool: 'bash',
			command: summarizeCommand(fullCommand),
			tier: highestTier,
			decision: 'deny',
			reasons: results.filter((r) => r.dangerous).flatMap((r) => r.reasons),
			projectKey,
			originalCommand: fullCommand,
			subCommands,
		});
		return {
			block: true,
			reason: `User declined dangerous command.\n\`${summarizeCommand(fullCommand)}\``,
		};
	}

	// 全部自动放行 → 逐条记录 auto
	const autoDims = new Set<string>();
	for (const r of results) {
		if (!r.dangerous) continue;
		if (r.tier && (highestTier === null || rank(r.tier) > rank(highestTier))) {
			highestTier = r.tier;
		}

		state.recordApprovalFor(
			{
				cmd: r.cmd,
				tool: extractToolName(r.cmd),
				dir: extractTargetDir(r.cmd, ctx.cwd),
			},
			r.tier!,
		);
		if (r.dim && typeof r.dim === 'string') autoDims.add(r.dim);
		else if (Array.isArray(r.dim)) r.dim.forEach((d) => autoDims.add(d));
	}

	const dimSummary = [...autoDims].join(',');
	log.info('Auto-approved (%s): %s', dimSummary || 'graduated', fullCommand.slice(0, 80));
	event.input.command = `echo "[OK] Auto-approved (${dimSummary || 'graduated'})"\n${fullCommand}`;
	audit({
		id: requestId,
		ts,
		tool: 'bash',
		command: summarizeCommand(fullCommand),
		tier: highestTier,
		decision: 'auto',
		reasons: [...autoDims],
		projectKey,
		originalCommand: fullCommand,
		subCommands,
	});
	updateWidgetStatus(ctx, state);
	return undefined;
}

// ============================================================================
// Control panel: /permission-gate
// ============================================================================

async function handlePermissionGateCommand(
	_args: string,
	ctx: ExtensionCommandContext,
	state: PermissionGateState,
): Promise<void> {
	if (!ctx.hasUI) {
		// Print mode: output config as text
		const lines = [
			'权限门配置：',
			`  已启用: ${state.config.enabled}`,
			`  动态策略: ${state.config.dynamicPolicyEnabled}`,
			`  范围: ${state.config.dynamicPolicy.scope}`,
			`  模式 (${state.config.patterns.length}):`,
			...state.config.patterns.map((p) => `    - ${p.pattern}  [${p.tier}]`),
			`  阈值:`,
			`    相同命令: ${state.config.dynamicPolicy.thresholds.sameCommand}`,
			`    相同工具: ${state.config.dynamicPolicy.thresholds.sameTool}`,
			`    相同目录: ${state.config.dynamicPolicy.thresholds.sameFolder}`,
			`  放行计数: ${summarizeApprovalCounts(state)}`,
		];
		ctx.ui.notify(lines.join('\n'), 'info');
		return;
	}

	// 直接打开分层策略面板（ADR-0030：主菜单取消，设置项并入面板的「设置」tab）
	await showTwoTabPanel(ctx, state.config, () => {
		saveConfig(ctx.cwd, state.config, 'project');
		updateWidgetStatus(ctx, state);
	});
}

/**
 * 从 counts 派生"总放行次数"（cmd: 前缀计数总和 ≈ 确认/放行次数）。
 */
function totalApprovalCount(counts: Record<string, number>): number {
	let total = 0;
	for (const [k, v] of Object.entries(counts)) {
		if (k.startsWith('cmd:')) total += v;
	}
	return total;
}

/**
 * 计算各维度策略总数的摘要字符串（用于 print 模式展示）。
 */
function summarizeApprovalCounts(state: PermissionGateState): string {
	const summary = getStrategySummary(getRuleCounts(), state.config.dynamicPolicy.thresholds);
	const parts: string[] = [];
	if (summary.cmd.total > 0) parts.push(`命令(${summary.cmd.total})`);
	if (summary.tool.total > 0) parts.push(`工具(${summary.tool.total})`);
	if (summary.dir.total > 0) parts.push(`目录(${summary.dir.total})`);
	return parts.length > 0 ? parts.join(' - ') : '无策略';
}

/**
 * 更新 status widget，使用 calcWidgetContentText 计算纯文本 + ANSI 着色。
 */
function updateWidgetStatus(
	ctx: ExtensionContext | ExtensionCommandContext,
	state: PermissionGateState,
): void {
	if (!ctx.hasUI) return;
	if (!state.config.widget.show) {
		ctx.ui.setStatus('permission-gate', '');
		return;
	}

	const th = ctx.ui.theme;
	const counts = getRuleCounts();
	const text = calcWidgetContentText(
		state.config.enabled,
		state.config.dynamicPolicyEnabled,
		counts,
		state.config.dynamicPolicy.thresholds,
		totalApprovalCount(counts),
	);

	if (state.config.widget.detailLevel === 'gate') {
		// 仅显示 gate 级别（取第一个括号段）
		const gateMatch = text.match(/^.*?\(\d+\[\d+\]\)/);
		if (gateMatch) {
			ctx.ui.setStatus('permission-gate', th.fg('accent', gateMatch[0]));
			return;
		}
	}

	// Gate OFF: 简洁着色
	if (!state.config.enabled) {
		ctx.ui.setStatus('permission-gate', th.fg('dim', text));
		return;
	}

	// Dynamic OFF: 整体着色
	if (!state.config.dynamicPolicyEnabled) {
		ctx.ui.setStatus('permission-gate', th.fg('accent', text));
		return;
	}

	// Dynamic ON: 对已达阈值的进度部分高亮
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
		const progressColored = th.fg('warning', `${capped}/${threshold}`);
		const progressFixed = progressColored.replace(/\x1b\[39m$/, accentSgr);
		const coloredFull = fullMatch.replace(`:${capped}/${threshold}`, `:${progressFixed}`);
		colored = colored.replace(fullMatch, coloredFull);
	}

	ctx.ui.setStatus('permission-gate', th.fg('accent', colored));
}

// ============================================================================
// Extension factory
// ============================================================================

export default function permissionGateExtension(pi: ExtensionAPI) {
	// state 实例：session_start 时创建，闭包持有
	let state: PermissionGateState | null = null;

	// 1. Register CLI flag
	pi.registerFlag('no-permission-gate', {
		description: '完全禁用权限门',
		type: 'boolean',
		default: false,
	});

	// 1.5 Warm tree-sitter parser（before_agent_start，先于任何 tool call）
	pi.on('before_agent_start', async () => {
		await warmBashParser();
	});

	// 2. On session_start: load config, check CLI flag
	pi.on('session_start', async (_event, ctx) => {
		const flagDisabled = pi.getFlag('no-permission-gate') === true;
		if (flagDisabled) {
			log.info('Permission gate disabled via --no-permission-gate flag');
			state = new PermissionGateState({ ...getDefaultConfig(), enabled: false });
			updateWidgetStatus(ctx, state);
			if (ctx.hasUI) {
				ctx.ui.notify('Permission Gate 已通过 --no-permission-gate 禁用', 'warning');
			}
			return;
		}

		// Load config from files
		const config = loadConfig(ctx.cwd);
		log.info(
			'Config loaded: enabled=%s, dynamicPolicy=%s',
			config.enabled,
			config.dynamicPolicyEnabled,
		);

		// 一次性迁移旧 approvals.json → audit + pi-state（ADR-0027）
		migrateApprovalsToAudit(ctx.cwd);
		state = new PermissionGateState(config);

		// 设置会话 ID（启用 critical 的会话级放行规则，ADR-0025；手动策略会话层，ADR-0030）
		const sessionId = ctx.sessionManager?.getSessionId?.();
		if (sessionId) {
			setRulesSessionId(sessionId);
			setManualStrategiesSessionId(sessionId);
		}

		// 滚动清理过期审计分片（默认保留半年，ADR-0027）
		cleanupAudit();

		// 清理过期的会话级状态文件（默认保留 30 天，mtime 超期删除）。
		// 放在 session_start 而非 session_shutdown：/reload 会先触发 shutdown，
		// 在 shutdown 删除会误删当前会话文件，违背「会话级状态 /reload 后仍生效」。
		cleanupRulesStore();
		cleanupManualStrategiesStore();

		// 暴露通道无关确认接口（幂等，ADR-0028）
		installPermissionGateApi();

		updateWidgetStatus(ctx, state);
	});

	// 3. Register /permission-gate command
	pi.registerCommand('permission-gate', {
		description: '打开权限门控制面板',
		handler: async (args, ctx) => {
			if (!state) {
				ctx.ui.notify('权限门未初始化', 'error');
				return;
			}
			await handlePermissionGateCommand(args, ctx, state);
		},
	});

	// 4. Intercept bash tool calls
	pi.on('tool_call', async (event, ctx) => {
		if (!state) {
			return undefined;
		}
		return handleToolCall(event, ctx, state);
	});

	// 5. On session_shutdown: 仅解除会话层绑定，不删除会话级状态文件。
	//    会话级状态跟随 sessionId 落盘，/reload 后仍生效；超期文件由 session_start 的 cleanupRulesStore/cleanupManualStrategiesStore 清理（ADR-0025 / ADR-0030）。
	pi.on('session_shutdown', async () => {
		setRulesSessionId(null);
		setManualStrategiesSessionId(null);
	});

	log.debug('Permission Gate v2 loaded');
}
