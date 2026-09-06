/**
 * Custom Compaction Extension
 *
 * A folder-based extension that replaces Pi's default compaction behavior
 * with profile-based, configurable compaction strategies.
 *
 * Features:
 * - Uses Pi's current model for summarization (no manual API key resolution)
 * - Profile-based configuration (model, trigger strategy, prompt, auto-continue)
 * - Strategy types: context_percent, fixed (absolute token count), reserve (remaining tokens)
 * - Interactive settings panel via /custom-compaction-setting command
 * - Proactive compaction trigger on agent_end
 * - Manual compaction trigger via /custom-compact [profile-name]
 * - Auto-continue after compaction to resume work seamlessly
 *
 * Configuration is persisted in:
 *   ~/.pi/agent/extensions-data/custom-compaction/<sessionId>.json
 * (deterministic path, survives /reload)
 *
 * Usage:
 *   pi --extension custom-compaction
 *   /custom-compaction-setting         (open settings panel)
 *   /custom-compact                    (trigger compaction, pick profile if multiple)
 *   /custom-compact my-profile         (trigger compaction with a specific profile)
 */

import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { createLogger } from '@zenone/pi-logger';
import { showSelect } from '@zenone/pi-selector';
import { createSessionTreeWithPi } from '@zenone/pi-session-tree';
import {
	loadConfig,
	reloadConfig,
	setSessionId,
	getEnabledProfiles,
	getTriggerGranularity,
} from './config.js';
import {
	buildCompactionHandler,
	setPendingSupplement,
	setPendingProfile,
	getAndClearCompactResult,
} from './compactor.js';
import { openSettingsPanel } from './settings-panel.js';
import {
	resolveContinueDecision,
	filterContextMessages,
	INVISIBLE_CONTINUE_CUSTOM_TYPE,
} from './continue.js';
import {
	initExperiments,
	markCompactStart,
	markCompactEnd,
	reportProcessMetrics,
	reportRecompact,
	detectRollback,
	rememberModel,
	resetLabState,
	clearRecentCompact,
} from './lab.js';
import {
	type CompactionProfile,
	type ComplexityLevel,
	describeTrigger,
	toModelSpec,
} from './types.js';
import { shouldTrigger, selectProfileFromTriggered } from './trigger.js';
import { updateStatus } from './status.js';

// Auto-register available compaction adapters
import './mechanisms/smart-compact.js';

const log = createLogger('custom-compaction');

/** Debounce flag: true while a compaction is in progress */
let compactingInProgress = false;

/** Track the current model spec (provider/id) to detect model changes */

// ── Helpers ─────────────────────────────────────────────────────

/** 从 sessionManager 读取当前 leaf id（失败返回 null） */
function getLeafId(ctx: { sessionManager?: { getLeafId?: () => string | null } }): string | null {
	try {
		return ctx.sessionManager?.getLeafId?.() ?? null;
	} catch {
		return null;
	}
}

/**
 * Execute compaction with the active profile's settings.
 */
export async function doCompact(
	pi: ExtensionAPI,
	ctx: Parameters<Parameters<typeof pi.on>[1]>[1],
	profile: CompactionProfile,
	source: 'auto' | 'manual' = 'auto',
) {
	if (compactingInProgress) {
		log.info('Compaction already in progress, skipping');
		return;
	}

	compactingInProgress = true;
	// 立即刷新状态栏 → 「压缩中」状态（避免停留在触发前的陈旧 percent）
	updateStatus(ctx, compactingInProgress);
	const triggerProfile = profile;
	const startTime = Date.now();

	// 丢弃上次中断压缩残留的过程指标（若上次压缩的 onComplete 未消费），
	// 避免陈旧结果归因到本次压缩
	getAndClearCompactResult();

	rememberModel(ctx.model);
	if (ctx.hasUI) {
		ctx.ui.notify(`Compaction starting (${describeTrigger(profile.trigger)})`, 'info');
	}

	// 记录压缩前 leaf 位置（回退信号基准）+ 生效 profile id（record 归因）
	const leafBefore = getLeafId(ctx);
	markCompactStart(ctx, profile.id, leafBefore, source);

	// 写入触发决策选中的 profile，供 session_before_compact 拦截阶段读取
	// （保证压缩机制/prompt/model 与触发决策一致，ADR-0036）
	setPendingProfile(profile);

	ctx.compact({
		onComplete: () => {
			log.info('Compaction completed successfully');
			compactingInProgress = false;
			// 清理 supplement：无论本次是否被消费（如 pass_through/失败回退），
			// 一次 compaction 结束后都不应残留到下一次
			setPendingSupplement(undefined);
			// 对称清理 pendingProfile：若本次 compact() 未触发 session_before_compact
			//（如「Nothing to compact」把切分点顶到首条），残留 profile 会泄漏到
			// 下一次无关压缩，用错误的 prompt/model/mechanism 做摘要。
			setPendingProfile(undefined);

			// 实验信号：记录压缩后 leaf + 过程指标（armId = 生效 profile id）
			markCompactEnd(ctx, getLeafId(ctx));
			const result = getAndClearCompactResult();
			if (result) {
				void reportProcessMetrics({
					latencyMs: Date.now() - startTime,
					savedTokens: result.savedTokens,
					summaryLength: result.summaryLength,
				});
			}

			// 压缩完成 → 立即脱离「压缩中」状态刷新状态栏（否则无后续 turn 时
			// 会停留在压缩开始写入的 accent 陈旧 usage）。ctx 在压缩后可能已
			// stale（会话替换/重载）——状态刷新与 UI 通知一并安全降级。
			try {
				updateStatus(ctx, compactingInProgress);
				if (ctx.hasUI) {
					ctx.ui.notify('Compaction completed', 'info');
				}
			} catch (e) {
				log.warn(
					'ctx unavailable in onComplete (session replaced):',
					e instanceof Error ? e.message : String(e),
				);
			}

			if (triggerProfile.autoContinue) {
				const decision = resolveContinueDecision(triggerProfile);
				if (decision.kind === 'message') {
					log.info('Auto-continue: sending message:', decision.text);
					pi.sendUserMessage(decision.text, {
						deliverAs: 'followUp',
					});
				} else if (decision.kind === 'invisible') {
					// 隐形 continue：隐藏 marker 触发 turn，context hook 过滤，LLM 零文本
					log.info('Auto-continue: sending invisible marker');
					void pi.sendMessage(
						{
							customType: INVISIBLE_CONTINUE_CUSTOM_TYPE,
							content: [],
							display: false,
							details: undefined,
						},
						{
							triggerTurn: true,
							deliverAs: 'followUp',
						},
					);
				}
			}
		},
		onError: (err) => {
			log.error('Compaction failed:', err.message);
			compactingInProgress = false;
			setPendingSupplement(undefined);
			setPendingProfile(undefined);
			// 压缩失败不产生可归因信号：清除最近压缩记录，防止后续
			// detectRollback 把「失败后 leaf 未推进」误判为用户回退不满。
			clearRecentCompact();

			// 压缩失败 → 同样立即脱离「压缩中」状态刷新（失败后无后续 turn，
			// 不刷新会一直显示压缩中）。ctx 可能已 stale——与通知一并安全降级。
			try {
				updateStatus(ctx, compactingInProgress);
				if (ctx.hasUI) {
					ctx.ui.notify(`Compaction failed: ${err.message}`, 'error');
				}
			} catch (e) {
				log.warn(
					'ctx unavailable in onError (session replaced):',
					e instanceof Error ? e.message : String(e),
				);
			}
		},
	});
}

/**
 * 触发评估核心（ADR-0036）：启用集 → 触发集 → tiebreak 择一 → doCompact。
 * 由三个触发粒度事件按配置调用（user_turn / agent_turn / tool）。
 * 导出供单元测试直接断言编排行为（事件接线仍通过 stubPi 收集 handler 验证）。
 */
export async function evaluateProactiveTrigger(
	pi: ExtensionAPI,
	ctx: Parameters<Parameters<typeof pi.on>[1]>[1],
): Promise<void> {
	if (compactingInProgress) return;

	const contextUsage = ctx.getContextUsage();
	if (!contextUsage) {
		log.info('Proactive trigger: getContextUsage() returned undefined');
		return;
	}
	if (contextUsage.tokens === null) {
		log.info('Proactive trigger: tokens is null');
		return;
	}

	const contextWindow = ctx.model?.contextWindow;

	// 启用集 → 触发集（第一/二道闸）
	const enabled = getEnabledProfiles();
	if (enabled.length === 0) return;
	const usage = contextUsage as { tokens: number; percent: number | null };
	const triggered = enabled.filter((p) => shouldTrigger(p.trigger, usage, contextWindow));
	// 「Proactive trigger check:」每次评估都输出（e2e 靠它定位日志，触发与否都要有）
	log.info(
		'Proactive trigger check:',
		`${usage.tokens.toLocaleString()} tokens`,
		usage.percent !== null ? `(${usage.percent.toFixed(1)}%)` : '',
		'enabled:',
		enabled.map((p) => p.id),
		'triggered:',
		triggered.map((p) => p.id),
	);
	if (triggered.length === 0) return;

	// 复杂度 level（仅在存在复杂度维度路由规则时计算，省开销）
	const routingRules = loadConfig().routingRules;
	let complexityLevel: ComplexityLevel | undefined;
	if (routingRules.some((r) => r.complexity !== undefined)) {
		try {
			const tree = createSessionTreeWithPi(
				ctx.sessionManager as Parameters<typeof createSessionTreeWithPi>[0],
			);
			complexityLevel = tree.analyzeComplexity().level;
		} catch (e) {
			log.warn('complexity analysis failed:', e instanceof Error ? e.message : String(e));
		}
	}

	// 选择算法三层：路由规则 → matchModel 隐式 → tiebreak（ADR-0036）
	const profile = selectProfileFromTriggered(triggered, {
		modelSpec: toModelSpec(ctx.model),
		complexityLevel,
		routingRules,
	});
	if (!profile) return;

	log.info('Proactive compaction triggered', {
		type: profile.trigger.type,
		threshold: profile.trigger.threshold,
		tokens: contextUsage.tokens,
		percent: contextUsage.percent,
		profile: profile.id,
		enabled: enabled.map((p) => p.id),
	});
	await doCompact(pi, ctx, profile, 'auto');
}

// ── Extension entry ─────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	log.info('Extension loaded');

	// Load config on startup
	loadConfig();

	// 隐形 continue：provider 序列化前移除隐藏 marker（吸收 pi-invisible-continue 技术）。
	// invisible 模式发送的 custom marker 在此被过滤，LLM 收到零新文本；
	// 可见的 autoContinueMessage（injectContinueText=true）不受影响。
	pi.on('context', (event) => {
		return filterContextMessages(event.messages);
	});

	// ── On session start/reload: set session ID, track model, load session-specific config ──
	pi.on('session_start', async (_event, ctx) => {
		const sid = ctx.sessionManager.getSessionId();
		if (sid) {
			setSessionId(sid);
		} else {
			reloadConfig();
		}
		// 记录当前模型 + 启用集（日志用）
		const modelSpec = toModelSpec(ctx.model);
		log.info(
			'Session start — model:',
			modelSpec ?? 'unknown',
			'enabled:',
			getEnabledProfiles().map((p) => p.id),
		);
		// 注册 pi-lab 实验（弱依赖，不可用时降级）；臂 = 当前 config 的 profile id
		initExperiments(ctx, Object.values(loadConfig().profiles));
		updateStatus(ctx, compactingInProgress);
	});

	// ── Register /custom-compaction-setting command ───────────
	pi.registerCommand('custom-compaction-setting', {
		description: '打开自定义压缩设置面板',
		handler: async (_args, ctx) => {
			reloadConfig();
			await openSettingsPanel(ctx);
			updateStatus(ctx, compactingInProgress);
		},
	});

	// ── Register /custom-compact command ──────────────────────
	// Usage:
	//   /custom-compact                        — pick profile via selector (Tab to supplement)
	//   /custom-compact <profile-name>         — compact with the named profile
	const triggerHandler = async (_args: string, ctx: ExtensionCommandContext) => {
		const config = loadConfig();
		const entries = Object.entries(config.profiles);
		if (entries.length === 0) {
			if (ctx.hasUI) ctx.ui.notify('没有可用的压缩配置', 'error');
			return;
		}

		let chosenProfile: CompactionProfile | undefined;
		let supplement: string | undefined;
		const trimmedName = _args.trim();

		if (trimmedName) {
			// Arg given → try to match as profile id or name (case-insensitive)
			const match = entries.find(
				([id, p]) =>
					id.toLowerCase() === trimmedName.toLowerCase() ||
					p.name.toLowerCase() === trimmedName.toLowerCase(),
			);
			if (match) {
				chosenProfile = match[1];
			} else if (ctx.hasUI) {
				ctx.ui.notify(`未找到配置 "${trimmedName}"`, 'warning');
			}
		}

		if (!chosenProfile) {
			// Resolve which profile to use
			if (entries.length === 1) {
				chosenProfile = entries[0][1];
				// Supplement can still be provided via the selector prompt
			} else if (ctx.hasUI) {
				// Use the shared selector for multi-profile picker
				const selectOptions = entries.map(([id, p]) => ({
					value: id,
					label: p.name,
					description: describeTrigger(p.trigger),
				}));
				const result = await showSelect(
					ctx,
					'选择 compaction profile  (Tab 可补充说明)',
					selectOptions,
				);
				if (!result) return;
				chosenProfile = config.profiles[result.value];
				supplement = result.supplement;
			} else {
				return;
			}
		}

		// Store supplement for the compactor to pick up
		if (supplement) setPendingSupplement(supplement);
		// 重压信号（自动压缩后 30min 内手动重压 = 对上次不满）
		await reportRecompact();
		await doCompact(pi, ctx, chosenProfile!, 'manual');
	};

	pi.registerCommand('custom-compact', {
		description:
			'手动触发压缩。用法：/custom-compact [配置名]。 ' +
			'不带配置名时，通过选择器挑选（Tab 可补充说明）。',
		handler: triggerHandler,
	});

	// ── /tree 分支切换后刷新状态栏 ───────────────────────
	// navigateTree 切换分支会立即替换 agent context（buildSessionContext），
	// 但不触发 agent_end，widget 若不刷新会停留在旧分支的 percent/tokens。
	// session_tree 在切换完成后 emit（带 newLeafId/oldLeafId），此处取实时 usage 刷新。
	pi.on('session_tree', async (_event, ctx) => {
		updateStatus(ctx, compactingInProgress);
	});

	// ── Proactive trigger: monitor context usage on agent_end ──
	// agent_end fires when the agent has completed its processing loop.
	// We do NOT check isIdle() here because pi's internal isStreaming
	// flag is still true when agent_end fires (even though processing is done).
	// The compactingInProgress flag prevents re-entry.
	pi.on('agent_end', async (_event, ctx) => {
		updateStatus(ctx, compactingInProgress);

		// 回退信号检测：用户是否回到压缩之前的位置（对最近一次压缩不满）。
		// 树判断委托 pi-session-tree 的 detectDiverge 基础原语（ADR 0023）。
		const tree = createSessionTreeWithPi(
			ctx.sessionManager as Parameters<typeof createSessionTreeWithPi>[0],
		);
		if (detectRollback(ctx, tree)) {
			log.info('Rollback signal reported');
		}

		if (compactingInProgress) return;

		// 触发评估（agent_turn 粒度，ADR-0036）
		if (getTriggerGranularity() === 'agent_turn') {
			await evaluateProactiveTrigger(pi, ctx);
		}
	});

	// ── widget 分子刷新（Ticket 05）+ user_turn 粒度触发评估（Ticket 03）──
	pi.on('message_end', async (event, ctx) => {
		// 每次消息结束（user/assistant/toolResult）刷新 widget 分子，
		// 对齐 pi 原生 footer；流式 message_update 不在此处理（避免逐 token 重绘）
		updateStatus(ctx, compactingInProgress);
		if (getTriggerGranularity() === 'user_turn' && event.message?.role === 'user') {
			await evaluateProactiveTrigger(pi, ctx);
		}
	});

	// ── tool 粒度：每次工具执行结束评估 ──
	pi.on('tool_execution_end', async (_event, ctx) => {
		if (getTriggerGranularity() !== 'tool') return;
		await evaluateProactiveTrigger(pi, ctx);
	});

	// ── Intercept compaction: custom summarization ────────────
	pi.on('session_before_compact', buildCompactionHandler());

	// ── Cleanup after compaction (belt-and-suspenders) ────────
	pi.on('session_compact', async () => {
		compactingInProgress = false;
	});

	// ── Cleanup on session shutdown ───────────────────────────
	pi.on('session_shutdown', async () => {
		compactingInProgress = false;
		setPendingSupplement(undefined);
		setPendingProfile(undefined);
		resetLabState();
	});
}
