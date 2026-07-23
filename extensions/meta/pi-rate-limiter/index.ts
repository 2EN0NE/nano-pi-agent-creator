/**
 * Rate Limiter Extension for pi.dev
 *
 * Solves the "432 - input token rate limit exceeded" problem by:
 * 1. Actively throttling requests before they hit the provider
 * 2. Showing real-time RPM / TPM usage in the footer (via setStatus, stacked below default footer)
 * 3. Auto-resuming on 432 errors after the window resets
 *
 * == 自适应限流算法 ==
 *
 * adaptiveRateLimit 支持四种模式（通过 /rate-limit 面板或 YAML 配置）：
 *
 *   off       — 关闭自适应限流，仅使用用户配置的固定阈值
 *   bayesian  — Gamma-Poisson 贝叶斯模型，防御型下限调整
 *   ucb       — UCB + AIMD 上限探索，进取型天花板发现
 *   both      — 两者同时启用（推荐）
 *
 * 算法对比:
 *
 *               贝叶斯 (bayesian)              |  UCB + AIMD (ucb)
 *  ────────────────────────────────────────────┼────────────────────────────
 *  方向       向下调整——找到安全下限           |  向上探索——发现真实上限
 *  对 432     降低有效限流值，更保守           |  退到 85% 后减小步长，续试探
 *  对成功     增加置信度（更稳定）             |  提高天花板，加速上升
 *  上限       硬封顶 2× 配置值                 |  无封顶，API 说多少就是多少
 *  成本       无额外成本（被动观察）           |  偶发 432（探索的代价）
 *  本质       防御型：避免频繁 432             |  进取型：找到 API 真实容量
 *
 * 两者同时启用时：贝叶斯保证安全下限不踩线，UCB 负责向上探索真实容量。
 * 当 UCB 探索到新高度后，贝叶斯也因更多成功样本而变得更自信——两者协同。
 *
 * Usage:
 *   pi -e ~/.pi/agent/extensions/pi-rate-limiter
 * Or add to models.json extensions list for auto-load.
 */

import type { AssistantMessage } from '@earendil-works/pi-ai';
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import { getSettingsListTheme } from '@earendil-works/pi-coding-agent';
import { Container, type SettingItem, SettingsList } from '@earendil-works/pi-tui';
import { AdaptiveLearner } from './adaptive-learner.js';
import { GlobalRateLimiter } from './global-state.js';
import { estimateTokensAccurate } from './token-counter.js';
import { join } from 'node:path';
import { deepMerge, resolveConfigPaths } from '@zenone/pi-config';
import {
	CUSTOM_TYPE,
	DEFAULT_CONFIG,
	detectModelFromPayload,
	estimateTokensFromPayload,
	getEffectiveLimits,
	getWindowStart,
	is432LikeError,
	loadConfig,
	logger,
	setLogFile,
	setLogLevel,
	sleep,
	STATUS_KEY,
	type AdaptiveMode,
	type PersistedState,
	type RateLimitConfig,
	type RequestLogEntry,
} from './utils.js';

// ============================================================================
// Extension Factory
// ============================================================================

export default function rateLimiterExtension(pi: ExtensionAPI) {
	// Initialize logging
	const logDir = join(resolveConfigPaths('pi-rate-limiter').userDir);
	const logPath = join(logDir, 'extension.log');
	setLogFile(logPath);
	setLogLevel('debug');
	logger.info('rateLimiterExtension: factory invoked');

	// Mutable runtime state
	let config: RateLimitConfig = { ...DEFAULT_CONFIG };
	let requestLog: RequestLogEntry[] = [];
	let pendingResumeTimer: ReturnType<typeof setTimeout> | undefined;
	let statusRefreshTimer: ReturnType<typeof setInterval> | undefined;
	let isWaitingForWindow = false;
	let activeCtx: ExtensionContext | undefined;
	let globalRateLimiter: GlobalRateLimiter | undefined;
	let adaptiveLearner: AdaptiveLearner | undefined;
	let lastModelId: string | undefined;
	let lastRequestWasProbe = false;
	let lastRequestUpperBoundLimit: number | undefined; // TPM attempted for UCB tracking
	let outcomeClassified = false; // Prevents duplicate classifyAndRecordOutcome calls per turn
	let consecutive429Count = 0; // Track consecutive 432/429 responses
	const MAX_CONSECUTIVE_429 = 3; // Threshold before entering deep cooldown

	// Helper: is UCB mode active? (ucb or both)
	const isUcbMode = () =>
		config.adaptiveRateLimit === 'ucb' || config.adaptiveRateLimit === 'both';
	// Helper: is Bayesian mode active? (bayesian or both)
	const isBayesianMode = () =>
		config.adaptiveRateLimit === 'bayesian' || config.adaptiveRateLimit === 'both';
	// Helper: is adaptive mode on at all?
	const isAdaptiveOn = () => config.adaptiveRateLimit !== 'off';

	// -------------------------------------------------------------------------
	// Config management
	// -------------------------------------------------------------------------

	function loadConfigFromDisk(ctx: ExtensionContext) {
		logger.debug('loadConfig: loading JSON config', { cwd: ctx.cwd });
		const overrides = loadConfig(ctx.cwd);
		config = deepMerge(DEFAULT_CONFIG, overrides);
		logger.info('loadConfig: config loaded', {
			maxReq: config.maxRequestsPerMinute,
			maxTok: config.maxTokensPerMinute,
			globalRateLimit: config.globalRateLimit,
			adaptiveRateLimit: config.adaptiveRateLimit,
			profileCount: config.modelProfiles.length,
		});
	}

	function persistState() {
		logger.debug('persistState: saving state', {
			modelProfiles: config.modelProfiles.length,
			adaptiveRateLimit: config.adaptiveRateLimit,
		});
		pi.appendEntry<PersistedState>(CUSTOM_TYPE, {
			config: {
				maxRequestsPerMinute: config.maxRequestsPerMinute,
				maxTokensPerMinute: config.maxTokensPerMinute,
				autoResumeOn432: config.autoResumeOn432,
				tokenEstimateRatio: config.tokenEstimateRatio,
				throttleThresholdPercent: config.throttleThresholdPercent,
				modelProfiles: config.modelProfiles,
				adaptiveRateLimit: config.adaptiveRateLimit,
			},
		});
	}

	function restoreFromBranch(ctx: ExtensionContext) {
		const branchEntries = ctx.sessionManager.getBranch();
		let latest: PersistedState | undefined;
		for (const entry of branchEntries) {
			if (entry.type === 'custom' && entry.customType === CUSTOM_TYPE) {
				const data = entry.data as PersistedState | undefined;
				if (data) latest = data;
			}
		}
		if (latest?.config) {
			config = deepMerge(config, latest.config);
			if (latest.config.modelProfiles) {
				config.modelProfiles = latest.config.modelProfiles;
			}
			if (latest.config.adaptiveRateLimit !== undefined) {
				// Migrate old boolean format (true→'both', false→'off') to string
				if (typeof latest.config.adaptiveRateLimit === 'boolean') {
					config.adaptiveRateLimit = latest.config.adaptiveRateLimit ? 'both' : 'off';
				} else {
					config.adaptiveRateLimit = latest.config.adaptiveRateLimit as AdaptiveMode;
				}
			}
		}
	}

	// -------------------------------------------------------------------------
	// Rate limiting engine
	// -------------------------------------------------------------------------

	function getCurrentWindowStats(now: number): { requests: number; tokens: number } {
		const windowStart = getWindowStart(now);
		const recent = requestLog.filter((r) => r.timestamp >= windowStart);
		return {
			requests: recent.length,
			tokens: recent.reduce((sum, r) => sum + r.estimatedTokens, 0),
		};
	}

	// ANSI color codes for status-line coloring
	const C = {
		green: '\x1b[92m', // bright green
		yellow: '\x1b[93m', // bright yellow
		red: '\x1b[91m', // bright red
		reset: '\x1b[0m',
	};

	function colorizeByUsage(text: string, percent: number): string {
		if (percent >= 0.8) return C.red + text + C.reset;
		if (percent >= 0.6) return C.yellow + text + C.reset;
		return C.green + text + C.reset;
	}

	function buildStatusText(): string {
		const now = Date.now();
		let requests: number;
		let tokens: number;
		let isGlobal = false;

		// Prefer global stats when available
		const globalStats = globalRateLimiter?.getGlobalStats(lastModelId);
		if (config.globalRateLimit && globalStats) {
			requests = globalStats.requests;
			tokens = globalStats.tokens;
			isGlobal = true;
		} else {
			const local = getCurrentWindowStats(now);
			requests = local.requests;
			tokens = local.tokens;
		}

		const { maxReq, maxTok } = getEffectiveLimits(config, lastModelId);
		const fmtNum = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

		if (isWaitingForWindow) {
			const sec = Math.ceil((60000 - (now % 60000)) / 1000);
			return '| ' + C.yellow + `⏳ 限流等待 ${sec}s` + C.reset;
		}

		const modelPrefix = lastModelId ? `[${lastModelId}] ` : '';
		const prefix = modelPrefix + (isGlobal ? '全局' : '本地');
		const reqStr = maxReq > 0 ? `${requests}/${maxReq} req/min` : `${requests} req/min`;
		const tokStr =
			maxTok > 0
				? `${fmtNum(tokens)}/${fmtNum(maxTok)} tok/min`
				: `${fmtNum(tokens)} tok/min`;

		const percentReq = maxReq > 0 ? requests / maxReq : 0;
		const percentTok = maxTok > 0 ? tokens / maxTok : 0;
		const usagePercent = Math.max(percentReq, percentTok);

		return `| ${prefix}: ` + colorizeByUsage(`${reqStr} · ${tokStr}`, usagePercent);
	}

	function refreshStatus() {
		if (!activeCtx?.hasUI) return;
		activeCtx.ui.setStatus(STATUS_KEY, buildStatusText());
	}

	function startStatusTimer() {
		if (statusRefreshTimer) clearInterval(statusRefreshTimer);
		statusRefreshTimer = setInterval(() => {
			refreshStatus();
		}, 1000);
	}

	function stopStatusTimer() {
		if (statusRefreshTimer) {
			clearInterval(statusRefreshTimer);
			statusRefreshTimer = undefined;
		}
	}

	function getCurrentModelRate(modelId: string | undefined): number {
		if (!modelId) return 0;
		const now = Date.now();
		const windowStart = getWindowStart(now);
		const recent = requestLog.filter((r) => r.timestamp >= windowStart);
		return recent.length;
	}

	function classifyAndRecordOutcome(outcome: 'success' | 'rejected'): void {
		if (outcomeClassified) return; // Only classify once per turn
		outcomeClassified = true;
		if (!isAdaptiveOn() || !adaptiveLearner || !lastModelId) return;
		const modelId = lastModelId;
		const currentRate = getCurrentModelRate(modelId);
		const { maxReq } = getEffectiveLimits(config, modelId);
		const effectiveLimit = adaptiveLearner.getEffectiveLimit(modelId, maxReq);
		logger.debug('classifyAndRecordOutcome', {
			modelId,
			outcome,
			currentRate,
			effectiveLimit,
			wasProbe: lastRequestWasProbe,
			mode: config.adaptiveRateLimit,
		});

		// Record upper bound outcome (ucb/both modes)
		if (isUcbMode() && lastRequestUpperBoundLimit !== undefined) {
			const configuredTok = getEffectiveLimits(config, modelId).maxTok;
			adaptiveLearner.recordUpperBoundOutcome(
				modelId,
				lastRequestUpperBoundLimit,
				outcome === 'success',
				configuredTok > 0 ? configuredTok : config.maxTokensPerMinute,
			);
		}

		// Record Bayesian outcome (bayesian/both modes)
		if (isBayesianMode()) {
			if (outcome === 'rejected') {
				adaptiveLearner.recordOutcome(modelId, 'rejected', currentRate);
			} else if (lastRequestWasProbe) {
				adaptiveLearner.recordOutcome(modelId, 'probe', currentRate);
			} else if (currentRate >= effectiveLimit * 0.9) {
				adaptiveLearner.recordOutcome(modelId, 'near', currentRate);
			} else {
				adaptiveLearner.recordOutcome(modelId, 'safe', currentRate);
			}
		}
	}

	async function throttleIfNeeded(payload: unknown, retryCount = 0): Promise<void> {
		const modelId = detectModelFromPayload(payload);
		lastModelId = modelId;

		// Try accurate (model-aware) token counting, fall back to character estimation
		let estimatedTokens: number;
		try {
			const accurate = await estimateTokensAccurate(payload, modelId);
			estimatedTokens =
				accurate ?? estimateTokensFromPayload(payload, config.tokenEstimateRatio);
		} catch {
			estimatedTokens = estimateTokensFromPayload(payload, config.tokenEstimateRatio);
		}

		let { maxReq, maxTok, thresholdPercent } = getEffectiveLimits(config, modelId);
		logger.debug('throttleIfNeeded: start', {
			modelId,
			estimatedTokens,
			maxReq,
			maxTok,
			thresholdPercent,
		});

		// Adaptive learning override
		let isExploring = false;
		lastRequestUpperBoundLimit = undefined;
		if (isAdaptiveOn() && adaptiveLearner && modelId) {
			// Base configured limit for UCB exploration ratio calculation
			// Use a large baseline (1,000,000 TPM) so UCB exploration is not artificially
			// capped by the current effective limit — the algorithm discovers the real ceiling.
			const configuredTok = 1000000;

			if (isUcbMode()) {
				// UCB mode: systematic upward exploration, no ε-greedy
				// The UCB bonus naturally shrinks as confidence grows
				const ubTok = adaptiveLearner.getUpperBoundExplorationLimit(modelId, configuredTok);
				const ratio = configuredTok > 0 ? ubTok / configuredTok : 1;
				maxTok = Math.max(maxTok, ubTok);
				maxReq = Math.max(maxReq, Math.ceil(maxReq * ratio));
				lastRequestUpperBoundLimit = ubTok;
				if (isBayesianMode()) {
					// Both mode: also apply Bayesian effective limit as floor
					const bayesReq = adaptiveLearner.getEffectiveLimit(modelId, maxReq);
					const bayesTok = adaptiveLearner.getEffectiveLimit(modelId, maxTok);
					maxReq = Math.min(maxReq, bayesReq);
					maxTok = Math.min(maxTok, bayesTok);
				}
				logger.debug('throttleIfNeeded: UCB target', {
					modelId,
					baseTok: configuredTok,
					targetTok: ubTok,
				});
			} else {
				// Bayesian-only mode: ε-greedy exploration
				isExploring = adaptiveLearner.shouldExplore(modelId);
				if (isExploring) {
					maxReq = adaptiveLearner.getExplorationLimit(modelId, maxReq);
					maxTok = adaptiveLearner.getExplorationLimit(modelId, maxTok);
				} else {
					maxReq = adaptiveLearner.getEffectiveLimit(modelId, maxReq);
					maxTok = adaptiveLearner.getEffectiveLimit(modelId, maxTok);
				}
			}
			logger.debug('throttleIfNeeded: adaptive override', {
				modelId,
				isExploring,
				effectiveMaxReq: maxReq,
				effectiveMaxTok: maxTok,
				mode: config.adaptiveRateLimit,
			});
		}
		lastRequestWasProbe = isExploring;

		if (config.globalRateLimit && globalRateLimiter) {
			isWaitingForWindow = true;
			refreshStatus();
			await globalRateLimiter.throttle(
				estimatedTokens,
				maxReq,
				maxTok,
				thresholdPercent,
				modelId,
			);
			isWaitingForWindow = false;
			refreshStatus();
		} else {
			// Fallback to local-only rate limiting
			const now = Date.now();
			const { requests, tokens } = getCurrentWindowStats(now);

			const reqThreshold = maxReq * (thresholdPercent / 100);
			const tokThreshold = maxTok * (thresholdPercent / 100);

			const reqLimitHit = maxReq > 0 && requests >= reqThreshold;
			const tokLimitHit = maxTok > 0 && tokens + estimatedTokens >= tokThreshold;

			if (reqLimitHit || tokLimitHit) {
				if (retryCount >= 3) {
					// Max retries reached — allow the request through anyway to avoid deadlock
					logger.warn('throttleIfNeeded: max retries reached, allowing request', {
						retryCount,
					});
				} else {
					const delay = 60000 - (now % 60000) + 100;
					isWaitingForWindow = true;
					refreshStatus();
					await sleep(delay);
					isWaitingForWindow = false;
					refreshStatus();
					await throttleIfNeeded(payload, retryCount + 1);
					return;
				}
			}
		}

		// Record this request locally for display fallback
		const now = Date.now();
		requestLog.push({ timestamp: now, estimatedTokens });

		// Trim old entries older than 2 minutes to prevent unbounded growth
		const cutoff = now - 120_000;
		requestLog = requestLog.filter((r) => r.timestamp >= cutoff);
		refreshStatus();
	}

	// -------------------------------------------------------------------------
	// 432 Auto-resume
	// -------------------------------------------------------------------------

	function scheduleAutoResume() {
		if (pendingResumeTimer) clearTimeout(pendingResumeTimer);
		const now = Date.now();
		const delay = 60000 - (now % 60000) + 500; // wait until next minute
		logger.info('scheduleAutoResume: scheduling resume', { delayMs: delay });

		pendingResumeTimer = setTimeout(() => {
			pendingResumeTimer = undefined;
			try {
				logger.info('scheduleAutoResume: sending auto-resume message');
				pi.sendUserMessage('请继续刚才未完成的回答', { deliverAs: 'followUp' });
			} catch {
				// If agent is unexpectedly busy, ignore to prevent crash
			}
		}, delay);
	}

	function maybeHandle432(errorMessage: string | undefined, ctx: ExtensionContext) {
		if (!config.autoResumeOn432) return;
		if (!is432LikeError(errorMessage)) return;
		if (inDeepCooldown) {
			logger.debug('maybeHandle432: in deep cooldown, skipping auto-resume');
			return;
		}

		const now = Date.now();
		const sec = Math.ceil((60000 - (now % 60000)) / 1000);
		logger.warn('maybeHandle432: detected 432-like error', {
			errorMessage,
			autoResume: config.autoResumeOn432,
			waitSec: sec,
		});
		ctx.ui.notify(`检测到 432 限流，将在 ${sec} 秒后自动继续`, 'warning');
		scheduleAutoResume();
	}

	// -------------------------------------------------------------------------
	// Settings panel command
	// -------------------------------------------------------------------------

	pi.registerCommand('rate-limit', {
		description: '配置大模型调用频率限制器',
		handler: async (_args, ctx: ExtensionCommandContext) => {
			logger.info('rate-limit command invoked', { hasUI: ctx.hasUI });
			if (!ctx.hasUI) {
				ctx.ui.notify('/rate-limit 需要交互模式', 'error');
				return;
			}

			try {
				await ctx.ui.custom((tui, theme, _kb, done) => {
					logger.debug('rate-limit: building custom UI panel');
					let panelClosed = false;
					let autoCloseTimer: ReturnType<typeof setTimeout> | undefined;
					function closePanel() {
						if (panelClosed) return;
						panelClosed = true;
						if (autoCloseTimer) {
							clearTimeout(autoCloseTimer);
							autoCloseTimer = undefined;
						}
						logger.debug('rate-limit: closePanel() invoked');
						done(undefined);
					}
					// Auto-close after 2 minutes of inactivity to prevent blocking command re-invocation
					autoCloseTimer = setTimeout(() => {
						logger.debug('rate-limit: auto-closing panel after 2min timeout');
						closePanel();
					}, 120_000);
					const container = new Container();

					// Title + instructions
					container.addChild(
						new (class {
							render(_w: number) {
								return [
									theme.fg('accent', theme.bold('Rate Limiter 设置')),
									theme.fg('dim', '  ↑↓ 移动 · Enter/Space 修改 · Esc/q 关闭'),
									'',
								];
							}
							invalidate() {}
						})(),
					);

					const LABELS: Record<string, string> = {
						off: '关闭',
						bayesian: '贝叶斯',
						ucb: 'UCB',
						both: '两者',
					};
					const MODE_MAP: Record<string, AdaptiveMode> = {
						关闭: 'off',
						贝叶斯: 'bayesian',
						UCB: 'ucb',
						两者: 'both',
					};

					function buildItems(): SettingItem[] {
						logger.debug('rate-limit: building settings items', {
							profileCount: config.modelProfiles.length,
						});
						return [
							{
								id: 'maxRequestsPerMinute',
								label: '每分钟最大请求数',
								description: '0 = 不限制。达到阈值后开始限流。',
								currentValue: String(config.maxRequestsPerMinute),
								values: ['编辑'],
							},
							{
								id: 'maxTokensPerMinute',
								label: '每分钟最大输入 Token',
								description: '0 = 不限制。估算的输入 token 总量超过阈值后限流。',
								currentValue: String(config.maxTokensPerMinute),
								values: ['编辑'],
							},
							{
								id: 'tokenEstimateRatio',
								label: 'Token 估算分母',
								description: '字符数 ÷ 此值 = 估算 token 数。默认值 4。',
								currentValue: String(config.tokenEstimateRatio),
								values: ['编辑'],
							},
							{
								id: 'throttleThresholdPercent',
								label: '限流触发阈值 (%)',
								description: '达到限制百分比时开始限流。建议 80%。',
								currentValue: String(config.throttleThresholdPercent),
								values: ['编辑'],
							},
							{
								id: 'autoResumeOn432',
								label: '遇到 432 自动继续',
								description:
									'432 是输入 token 速率超限错误。开启后会在下一分钟自动重试。',
								currentValue: config.autoResumeOn432 ? '开启' : '关闭',
								values: ['开启', '关闭'],
							},
							{
								id: 'globalRateLimit',
								label: '全局共享限流',
								description: '多个 pi.dev 进程共享同一套限流计数。',
								currentValue: config.globalRateLimit ? '开启' : '关闭',
								values: ['开启', '关闭'],
							},
							{
								id: 'adaptiveRateLimit',
								label: '自适应限流算法',
								description:
									'关闭 — 仅使用固定阈值 | 贝叶斯 — 防御型下限调整 | UCB — 进取型上限探索 | 两者 — 协同工作（推荐）',
								currentValue: LABELS[config.adaptiveRateLimit],
								values: ['关闭', '贝叶斯', 'UCB', '两者'],
							},
							...config.modelProfiles.map((p, idx) => ({
								id: `modelProfile-${idx}`,
								label: `模型: ${p.modelPattern}`,
								currentValue: `${p.maxRequestsPerMinute}req / ${p.maxTokensPerMinute}tok`,
								values: ['编辑', '删除'],
							})),
							{
								id: 'addModelProfile',
								label: '+ 添加模型限流配置',
								currentValue: '',
								values: ['添加'],
							},
							{
								id: 'done',
								label: '✓ 完成 (关闭面板)',
								description:
									'选中此项并按 Enter 或 Space 关闭面板，之后可再次使用 /rate-limit。',
								currentValue: '',
								values: ['退出'],
							},
						];
					}

					let settingsList: SettingsList;
					const onCancelHandler = () => {
						logger.debug('rate-limit: panel closed via onCancel');
						closePanel();
					};
					const onChangeHandler = (id: string, newValue: string) => {
						logger.debug('rate-limit: onChange', { id, newValue });
						if (id === 'autoResumeOn432') {
							config.autoResumeOn432 = newValue === '开启';
							persistState();
							settingsList.updateValue(id, newValue);
							tui.requestRender();
							return;
						}

						if (id === 'globalRateLimit') {
							config.globalRateLimit = newValue === '开启';
							persistState();
							settingsList.updateValue(id, newValue);
							tui.requestRender();
							return;
						}

						if (id === 'adaptiveRateLimit') {
							const mode = MODE_MAP[newValue] ?? 'off';
							config.adaptiveRateLimit = mode;
							persistState();
							settingsList.updateValue(id, newValue);
							tui.requestRender();
							return;
						}

						// Done button
						if (id === 'done' && newValue === '退出') {
							logger.debug('rate-limit: user clicked done');
							closePanel();
							return;
						}

						// Model profile management
						if (id === 'addModelProfile' && newValue === '添加') {
							ctx.ui
								.input(
									'模型匹配模式 (如: claude-* 或 /^gpt-4.*/)',
									'claude-sonnet-4-6',
								)
								.then((pattern) => {
									if (!pattern) return;
									ctx.ui
										.input(
											'每分钟最大请求数',
											String(config.maxRequestsPerMinute),
										)
										.then((rpmStr) => {
											if (!rpmStr) return;
											const rpm = Number(rpmStr);
											if (Number.isNaN(rpm)) {
												ctx.ui.notify('请输入有效数字', 'error');
												return;
											}
											ctx.ui
												.input(
													'每分钟最大输入 Token',
													String(config.maxTokensPerMinute),
												)
												.then((tpmStr) => {
													if (!tpmStr) return;
													const tpm = Number(tpmStr);
													if (Number.isNaN(tpm)) {
														ctx.ui.notify('请输入有效数字', 'error');
														return;
													}
													config.modelProfiles.push({
														modelPattern: pattern,
														maxRequestsPerMinute: Math.max(0, rpm),
														maxTokensPerMinute: Math.max(0, tpm),
													});
													persistState();
													settingsList = new SettingsList(
														buildItems(),
														Math.min(7, 10),
														getSettingsListTheme(),
														onChangeHandler,
														onCancelHandler,
													);
													tui.requestRender();
												});
										});
								});
							return;
						}

						if (id.startsWith('modelProfile-')) {
							const idx = Number(id.slice('modelProfile-'.length));
							const profile = config.modelProfiles[idx];
							if (!profile) return;
							if (newValue === '删除') {
								config.modelProfiles.splice(idx, 1);
								persistState();
								settingsList = new SettingsList(
									buildItems(),
									Math.min(7, 10),
									getSettingsListTheme(),
									onChangeHandler,
									onCancelHandler,
								);
								tui.requestRender();
								return;
							}
							if (newValue === '编辑') {
								ctx.ui
									.input('模型匹配模式', profile.modelPattern)
									.then((pattern) => {
										if (pattern === undefined) return;
										ctx.ui
											.input(
												'每分钟最大请求数',
												String(profile.maxRequestsPerMinute),
											)
											.then((rpmStr) => {
												if (!rpmStr) return;
												const rpm = Number(rpmStr);
												if (Number.isNaN(rpm)) {
													ctx.ui.notify('请输入有效数字', 'error');
													return;
												}
												ctx.ui
													.input(
														'每分钟最大输入 Token',
														String(profile.maxTokensPerMinute),
													)
													.then((tpmStr) => {
														if (!tpmStr) return;
														const tpm = Number(tpmStr);
														if (Number.isNaN(tpm)) {
															ctx.ui.notify(
																'请输入有效数字',
																'error',
															);
															return;
														}
														profile.modelPattern = pattern;
														profile.maxRequestsPerMinute = Math.max(
															0,
															rpm,
														);
														profile.maxTokensPerMinute = Math.max(
															0,
															tpm,
														);
														persistState();
														settingsList = new SettingsList(
															buildItems(),
															Math.min(7, 10),
															getSettingsListTheme(),
															onChangeHandler,
															onCancelHandler,
														);
														tui.requestRender();
													});
											});
									});
								return;
							}
						}

						// For numeric fields, prompt via input dialog
						let title = '';
						let placeholder = '';
						switch (id) {
							case 'maxRequestsPerMinute':
								title = '每分钟最大请求数 (0=不限)';
								placeholder = String(config.maxRequestsPerMinute);
								break;
							case 'maxTokensPerMinute':
								title = '每分钟最大输入 Token (0=不限)';
								placeholder = String(config.maxTokensPerMinute);
								break;
							case 'tokenEstimateRatio':
								title = 'Token 估算分母';
								placeholder = String(config.tokenEstimateRatio);
								break;
							case 'throttleThresholdPercent':
								title = '限流触发阈值 %';
								placeholder = String(config.throttleThresholdPercent);
								break;
						}

						ctx.ui.input(title, placeholder).then((val) => {
							if (val === undefined) return;
							const num = Number(val);
							if (Number.isNaN(num)) {
								ctx.ui.notify('请输入有效数字', 'error');
								return;
							}
							switch (id) {
								case 'maxRequestsPerMinute':
									config.maxRequestsPerMinute = Math.max(0, num);
									break;
								case 'maxTokensPerMinute':
									config.maxTokensPerMinute = Math.max(0, num);
									break;
								case 'tokenEstimateRatio':
									config.tokenEstimateRatio = Math.max(1, num);
									break;
								case 'throttleThresholdPercent':
									config.throttleThresholdPercent = Math.max(
										1,
										Math.min(100, num),
									);
									break;
							}
							persistState();
							let updatedValue = '';
							switch (id) {
								case 'maxRequestsPerMinute':
									updatedValue = String(config.maxRequestsPerMinute);
									break;
								case 'maxTokensPerMinute':
									updatedValue = String(config.maxTokensPerMinute);
									break;
								case 'tokenEstimateRatio':
									updatedValue = String(config.tokenEstimateRatio);
									break;
								case 'throttleThresholdPercent':
									updatedValue = String(config.throttleThresholdPercent);
									break;
							}
							settingsList.updateValue(id, updatedValue);
							tui.requestRender();
						});
					};
					try {
						settingsList = new SettingsList(
							buildItems(),
							Math.min(7, 10),
							getSettingsListTheme(),
							onChangeHandler,
							onCancelHandler,
						);
					} catch (err) {
						logger.error('rate-limit: SettingsList creation error', err);
						throw err;
					}

					container.addChild(settingsList);

					return {
						render(w: number) {
							return container.render(w);
						},
						invalidate() {
							container.invalidate();
						},
						handleInput(data: string) {
							// Explicitly detect cancel/escape as fallback if SettingsList doesn't receive it
							if (data === '' || data === '' || data === 'q') {
								logger.debug('rate-limit: handleInput detected cancel key', {
									data: JSON.stringify(data),
								});
								closePanel();
								return;
							}
							settingsList.handleInput?.(data);
							if (!panelClosed) {
								tui.requestRender();
							}
						},
					};
				});
			} catch (err) {
				logger.error('rate-limit: failed to open settings panel', err);
				ctx.ui.notify('设置面板打开失败，请查看日志', 'error');
			}
		},
	});

	// -------------------------------------------------------------------------
	// Fork-on-consecutive-429 internal command
	// -------------------------------------------------------------------------

	pi.registerCommand('rate-limit-retry', {
		description: '连续 429 限流后创建分支会话重试',
		handler: async (args, ctx: ExtensionCommandContext) => {
			const targetId = args.trim();
			if (!targetId) {
				logger.warn('rate-limit-retry: missing target entry ID');
				if (ctx.hasUI) ctx.ui.notify('缺少目标 entry ID，无法重试', 'error');
				return;
			}

			logger.info('rate-limit-retry: forking session', { targetId });

			if (ctx.hasUI) {
				ctx.ui.notify('连续 429 限流，创建新会话重试中...', 'warning');
			}

			await ctx.fork(targetId, {
				position: 'at',
				withSession: async (forkCtx) => {
					logger.info('rate-limit-retry: new session created, sending continue message');
					if (forkCtx.hasUI) {
						forkCtx.ui.notify('已创建新会话，正在重试', 'info');
					}
					// Send the continue message in the fresh session
					await forkCtx.sendUserMessage('请继续刚才未完成的回答');
				},
			});

			logger.info('rate-limit-retry: fork completed');
		},
	});

	// -------------------------------------------------------------------------
	// Deep cooldown state
	// -------------------------------------------------------------------------
	// When consecutive 429s exceed MAX_CONSECUTIVE_429, we enter "deep cooldown":
	//   - No more continue messages are sent (stops filling history)
	//   - Rate limit thresholds are temporarily lowered
	//   - After cooldownWindows windows, we resume normal operation
	let inDeepCooldown = false;
	let cooldownTimer: ReturnType<typeof setTimeout> | undefined;
	let cooldownWindowsRemaining = 0;
	const COOLDOWN_WINDOWS = 2; // Wait 2 full rate-limit windows (2 min)

	/** Enter deep cooldown — stop continue, lower thresholds, wait for reset */
	function enterDeepCooldown(ctx: ExtensionContext) {
		if (inDeepCooldown) return;
		inDeepCooldown = true;
		consecutive429Count = 0;
		cooldownWindowsRemaining = COOLDOWN_WINDOWS;

		// Cancel any pending auto-resume
		if (pendingResumeTimer) {
			clearTimeout(pendingResumeTimer);
			pendingResumeTimer = undefined;
		}

		logger.warn('enterDeepCooldown: entered deep cooldown', {
			windows: COOLDOWN_WINDOWS,
		});

		if (ctx.hasUI) {
			ctx.ui.notify(
				`连续 ${MAX_CONSECUTIVE_429} 次 429 限流，已停止自动重试，等待 ${COOLDOWN_WINDOWS} 个窗口后恢复`,
				'warning',
			);
		}

		// Schedule cooldown recovery: wait for N full window boundaries
		scheduleCooldownEnd(ctx);
	}

	function scheduleCooldownEnd(ctx: ExtensionContext) {
		if (cooldownTimer) clearTimeout(cooldownTimer);

		const now = Date.now();
		const delay = 60000 - (now % 60000) + 500; // Wait until next minute boundary
		logger.debug('scheduleCooldownEnd: scheduling check', {
			delayMs: delay,
			windowsRemaining: cooldownWindowsRemaining,
		});

		cooldownTimer = setTimeout(() => {
			cooldownWindowsRemaining--;
			if (cooldownWindowsRemaining <= 0) {
				// Cooldown complete — resume normal operation
				inDeepCooldown = false;
				if (cooldownTimer) {
					clearTimeout(cooldownTimer);
					cooldownTimer = undefined;
				}
				logger.info('scheduleCooldownEnd: deep cooldown ended, resuming normal operation');
				if (activeCtx?.hasUI) {
					activeCtx.ui.notify('429 限流冷却结束，已恢复自动重试', 'info');
				}
				refreshStatus();
			} else {
				// Still in cooldown — schedule next check
				scheduleCooldownEnd(ctx);
			}
		}, delay);
	}

	// -------------------------------------------------------------------------
	// Event handlers
	// -------------------------------------------------------------------------

	pi.on('session_start', async (_event, ctx) => {
		logger.info('session_start');
		activeCtx = ctx;
		loadConfigFromDisk(ctx);
		restoreFromBranch(ctx);
		if (config.globalRateLimit) {
			logger.info('session_start: initializing global rate limiter');
			globalRateLimiter = new GlobalRateLimiter({
				heartbeatIntervalMs: config.heartbeatIntervalMs,
				lockTimeoutMs: config.lockTimeoutMs,
				staleProcessTimeoutMs: config.staleProcessTimeoutMs,
			});
			globalRateLimiter.init();
		}
		if (isAdaptiveOn()) {
			logger.info('session_start: initializing adaptive learner');
			adaptiveLearner = new AdaptiveLearner();
		}
		refreshStatus();
		startStatusTimer();

		// Reset consecutive 429 tracking on fresh session
		consecutive429Count = 0;
		inDeepCooldown = false;
		if (cooldownTimer) {
			clearTimeout(cooldownTimer);
			cooldownTimer = undefined;
		}
	});

	pi.on('session_tree', async (_event, ctx) => {
		activeCtx = ctx;
		restoreFromBranch(ctx);
		refreshStatus();

		// Reset consecutive 429 tracking on tree navigation
		consecutive429Count = 0;
		inDeepCooldown = false;
		if (cooldownTimer) {
			clearTimeout(cooldownTimer);
			cooldownTimer = undefined;
		}
	});

	pi.on('session_shutdown', async () => {
		logger.info('session_shutdown');
		if (pendingResumeTimer) {
			clearTimeout(pendingResumeTimer);
			pendingResumeTimer = undefined;
		}
		if (cooldownTimer) {
			clearTimeout(cooldownTimer);
			cooldownTimer = undefined;
		}
		stopStatusTimer();
		if (activeCtx?.hasUI) {
			activeCtx.ui.setStatus(STATUS_KEY, undefined);
		}
		activeCtx = undefined;
		if (globalRateLimiter) {
			globalRateLimiter.shutdown();
			globalRateLimiter = undefined;
		}
		if (adaptiveLearner) {
			adaptiveLearner.saveBeliefs();
			adaptiveLearner = undefined;
		}
	});

	pi.on('before_provider_request', async (event) => {
		try {
			outcomeClassified = false; // Reset outcome dedup for this provider request
			await throttleIfNeeded(event.payload);
		} catch (err) {
			logger.error('before_provider_request: throttle error', err);
			throw err;
		}
	});

	pi.on('message_end', async (event, ctx) => {
		try {
			const msg = event.message;
			if (msg.role !== 'assistant') return;
			const assistant = msg as AssistantMessage;

			// 1. Correct token estimate with actual usage if available
			if (assistant.usage && assistant.usage.input > 0) {
				// Global state correction
				if (config.globalRateLimit && globalRateLimiter) {
					globalRateLimiter.correctLastRequest(assistant.usage.input, lastModelId);
				}
				// Local fallback
				if (requestLog.length > 0) {
					const last = requestLog[requestLog.length - 1];
					if (last) {
						last.estimatedTokens = assistant.usage.input;
					}
				}
				refreshStatus();
			}

			// 2. Detect 432-like errors and record outcome
			if (assistant.stopReason === 'error') {
				if (is432LikeError(assistant.errorMessage)) {
					// Don't increment count during deep cooldown — it's managed by cooldown state
					if (!inDeepCooldown) {
						consecutive429Count++;
					}
					logger.warn('message_end: detected 432 error', {
						errorMessage: assistant.errorMessage,
						consecutive429Count,
					});

					// When consecutive 429s exceed threshold, enter deep cooldown
					if (inDeepCooldown) {
						// Already in cooldown — skip all 432 handling
						logger.debug('message_end: in deep cooldown, skipping 432 handling');
					} else if (consecutive429Count >= MAX_CONSECUTIVE_429) {
						logger.warn(
							'message_end: consecutive 429 threshold reached, entering deep cooldown',
							{
								consecutive429Count,
								cooldownWindows: COOLDOWN_WINDOWS,
							},
						);
						enterDeepCooldown(ctx);
					} else {
						// Normal 432 handling: schedule auto-resume
						maybeHandle432(assistant.errorMessage, ctx);
					}
					classifyAndRecordOutcome('rejected');
				} else {
					// Non-432 errors (timeout, auth failure, model not found, etc.)
					// still reflect API availability — record as rejected so the
					// adaptive learner can adjust.
					logger.warn('message_end: non-432 error, recording as rejected', {
						stopReason: assistant.stopReason,
						errorMessage: assistant.errorMessage,
					});
					consecutive429Count = 0;
					classifyAndRecordOutcome('rejected');
				}
			} else {
				consecutive429Count = 0;
				classifyAndRecordOutcome('success');
			}
		} catch (err) {
			logger.error('message_end: unexpected error', err);
		}
	});

	pi.on('after_provider_response', async (event, ctx) => {
		try {
			if (event.status === 432) {
				logger.warn('after_provider_response: detected 432 status', {
					status: event.status,
				});
				// Note: we intentionally do NOT increment consecutive429Count here.
				// HTTP 432 status codes are rare (most providers return 200 + error message).
				// The consecutive 429 tracking happens in message_end which catches
				// the assistant message with stopReason="error" + matching errorMessage.
				// If a provider returns 432 at HTTP level without a valid LLM response,
				// Pi's agent may not produce a message_end with stopReason="error",
				// so incrementing here could lead to false positives.
				maybeHandle432('432 rate limit', ctx);
			}
		} catch (err) {
			logger.error('after_provider_response: unexpected error', err);
		}
	});

	pi.on('agent_end', async (event, ctx) => {
		try {
			// Fallback: if the last assistant message in this turn is a 432 error
			const messages = event.messages;
			for (let i = messages.length - 1; i >= 0; i--) {
				const m = messages[i];
				if (m.role === 'assistant') {
					const assistant = m as AssistantMessage;
					if (
						assistant.stopReason === 'error' &&
						is432LikeError(assistant.errorMessage)
					) {
						maybeHandle432(assistant.errorMessage, ctx);
					}
					break;
				}
			}
		} catch (err) {
			logger.error('agent_end: unexpected error', err);
		}
	});
}
