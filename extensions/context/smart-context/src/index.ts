import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { createLogger } from '@zenone/pi-logger';
import { createRouter } from './router.js';
import { createCompressor } from './compression/pipeline.js';
import { createContentStore } from './compression/store.js';
import { createSummarizer } from './compression/haiku-summarize.js';
import { getDiagnostics } from './host-ai.js';
import {
	resolveProfile,
	builtinProfiles,
	configFilePath,
	clearCache,
	type ModelProfile,
} from './config.js';
import { setupSessionInit } from './session-init.js';
import { StrategyRegistry } from './strategies/registry.js';
import { classifierStrategy } from './strategies/classifier.js';
import { treeEscalationStrategy } from './strategies/tree-escalation.js';
import { pureSignalsStrategy } from './strategies/pure-signals.js';
import { conservativeStrategy } from './strategies/conservative.js';
import { projectFirstStrategy } from './strategies/project-first.js';
import { collectAllSignals } from './signals.js';

const log = createLogger('smart-context');

export default function (pi: ExtensionAPI) {
	const router = createRouter(pi);
	const store = createContentStore();
	const summarizer = createSummarizer();
	const compressor = createCompressor({ store, summarizer });

	let enabled = true;
	const debug = process.env.SMART_CONTEXT_DEBUG === '1';

	// ── 策略注册表 ──
	const registry = new StrategyRegistry();
	registry.register(classifierStrategy);
	registry.register(treeEscalationStrategy);
	registry.register(pureSignalsStrategy);
	registry.register(conservativeStrategy);
	registry.register(projectFirstStrategy);

	// ── pi-lab turn-routing 桥接 ──
	let labSelect: (() => Promise<string>) | undefined;
	let labRecord: ((armId: string, success: boolean) => Promise<void>) | undefined;
	const pendingOutcomes = new Map<number, { armId: string }>();
	let turnIndex = 0;

	// ── 首次安装：输出默认配置文件，让用户可以看到完整策略并可编辑 ──
	// ── 子任务检测：pi-lab session-init 实验 ──
	pi.on('session_start', async (_event, ctx) => {
		// 默认配置初始化
		const cfgPath = configFilePath(ctx.cwd);
		if (cfgPath) {
			try {
				const [fs, path] = await Promise.all([import('node:fs'), import('node:path')]);
				if (!fs.existsSync(cfgPath)) {
					const defaultCfg = {
						activeProfile: 'balanced',
						profiles: {
							balanced: {
								classifier: { provider: 'deepseek', model: 'deepseek-v4-flash' },
								routing: {
									trivial: {
										provider: 'litellm',
										model: 'leihuo-deepseek-v4-pro',
									},
									simple: {
										provider: 'litellm',
										model: 'leihuo-deepseek-v4-pro',
									},
									medium: { provider: 'litellm', model: 'leihuo-gpt-5.3-codex' },
									complex: {
										provider: 'litellm',
										model: 'leihuo-claude-sonnet-5',
									},
								},
								largeContext: {
									thresholdTokens: 500_000,
									model: { provider: 'litellm', model: 'leihuo-claude-sonnet-5' },
								},
							},
						},
						strategies: {
							'tree-escalation': {
								branchThreshold: 3,
								checkpointThreshold: 3,
								compactionThreshold: 2,
								contextPercentThreshold: 70,
							},
							'pure-signals': {
								branchWeight: 15,
								checkpointWeight: 10,
								compactionWeight: 20,
								mediumThreshold: 20,
								complexThreshold: 50,
							},
							conservative: {
								minTriggers: 2,
								branchThreshold: 4,
								checkpointThreshold: 3,
								compactionThreshold: 2,
								contextPercentThreshold: 80,
							},
							'project-first': {
								sparseDocThreshold: 20,
								goodDocThreshold: 50,
								extremeBranchThreshold: 5,
							},
						},
					};
					fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
					fs.writeFileSync(cfgPath, JSON.stringify(defaultCfg, null, 2) + '\n');
					log.info('Default config written | path=%s', cfgPath);
				}
			} catch (err) {
				log.warn('Failed to write default config', { error: String(err) });
			}
		}

		// 子任务检测 + session-init 实验
		try {
			await setupSessionInit(pi, ctx);
		} catch (err) {
			log.warn('session-init setup failed', {
				error: err instanceof Error ? err.message : String(err),
			});
		}

		// pi-lab turn-routing 实验注册
		const labApi = (globalThis as any).__labApi;
		if (labApi) {
			try {
				const mgr = labApi.getExperimentManager();
				if (mgr) {
					const exp = mgr.registerWeakExperiment({
						name: 'turn-routing',
						namespace: 'smart-context',
						contextKey: 'global',
						arms: registry.getArmIds().map((id) => ({ id, label: `${id} strategy` })),
						strategy: 'thompson-sampling',
					});
					labSelect = () => exp.select();
					labRecord = async (armId: string, success: boolean) => {
						await exp.record(armId, {
							success,
							metadata: { strategy: armId },
						});
					};
					log.info(
						'turn-routing experiment registered | arms=%s',
						registry.getArmIds().join(','),
					);
				}
			} catch (err) {
				log.warn('Failed to register turn-routing experiment', {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		} else {
			log.info('pi-lab not available — turn-routing without experiment');
		}
	});

	// ── Turn 追踪（outcome 记录）──
	pi.on('turn_start', async (event) => {
		turnIndex = event.turnIndex;
	});

	pi.on('turn_end', async () => {
		const pending = pendingOutcomes.get(turnIndex);
		if (pending && labRecord) {
			// 默认 success=true（用户未主动回滚即成功）
			// 回滚检测由 session_tree 事件处理
			try {
				await labRecord(pending.armId, true);
				log.debug('Outcome recorded | turn=%s arm=%s', turnIndex, pending.armId);
			} catch (err) {
				log.warn('Failed to record outcome', {
					error: err instanceof Error ? err.message : String(err),
				});
			}
			pendingOutcomes.delete(turnIndex);
		}
	});

	pi.on('before_agent_start', async (event, ctx) => {
		if (!enabled) {
			log.debug('Routing skipped (disabled)');
			return;
		}
		try {
			ctx.ui.setWorkingMessage('Routing...');

			// 尝试 pi-lab 实验路由
			let decision = null;
			const labAvailable = !!labSelect && !!labRecord;

			if (labAvailable) {
				const armId = await labSelect!();
				const strategy = registry.get(armId);
				if (strategy) {
					const signals = await collectAllSignals(event.prompt, ctx);
					decision = await strategy.decide(event.prompt, ctx, signals);
					pendingOutcomes.set(turnIndex, { armId });
				}
			}

			// 回退到原 router（classifier 策略返回 null 时由 router 处理）
			if (!decision) {
				decision = await router.pick(event.prompt, ctx);
			}

			if (!decision) {
				log.info('No route — keeping current model');
				if (debug) ctx.ui.notify('smart-context: no route (keeping current model)', 'info');
				return;
			}
			const { model } = decision;
			const resolved = ctx.modelRegistry.find(model.provider, model.model);
			if (!resolved) {
				log.warn('Route target not found in registry', {
					provider: model.provider,
					model: model.model,
				});
				if (debug)
					ctx.ui.notify(
						`smart-context: model ${model.provider}/${model.model} not found`,
						'warning',
					);
				return;
			}
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(resolved);
			if (!auth.ok || !auth.apiKey) {
				log.warn('Route target auth failed', {
					provider: model.provider,
					model: model.model,
				});
				if (debug)
					ctx.ui.notify(
						`smart-context: no auth for ${model.provider}/${model.model}`,
						'warning',
					);
				return;
			}
			await pi.setModel(resolved);
			log.info(
				'Model switched | provider=%s model=%s reason=%s',
				model.provider,
				model.model,
				decision.reason,
			);
			ctx.ui.notify(
				`smart-context: ${decision.detail} → 切换到 ${model.provider}/${model.model}`,
				'info',
			);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			log.error('Routing error', { error: msg, diagnostics: getDiagnostics() });
			ctx.ui.notify(`smart-context routing error: ${msg} [${getDiagnostics()}]`, 'warning');
		} finally {
			ctx.ui.setWorkingMessage();
		}
	});

	pi.on('context', async (event, ctx) => {
		ctx.ui.setWorkingMessage('Compressing...');
		const before = JSON.stringify(event.messages).length;
		try {
			const messages = await compressor.compress(event.messages as any[], ctx);
			const after = JSON.stringify(messages).length;
			const saved = before - after;
			if (saved > 0) {
				log.info(
					'Context compressed | before=%s after=%s saved=%s ratio=%s%%',
					before,
					after,
					saved,
					Math.round((saved / before) * 100),
				);
			}
			return { messages } as any;
		} finally {
			ctx.ui.setWorkingMessage();
		}
	});

	pi.on('tool_result', async (event) => {
		if (event.toolName !== 'bash' && event.toolName !== 'read' && event.toolName !== 'grep') {
			return;
		}
		const compressed = compressor.compressToolResult(event.toolName, event.content as any[]);
		if (compressed) {
			log.debug('Tool result compressed on the fly', {
				tool: event.toolName,
			});
			return { content: compressed } as any;
		}
	});

	pi.registerTool({
		name: 'recover_context',
		label: 'Recover Context',
		description:
			'Recover the full original content of a message that was compressed/summarized in the conversation context. Pass the id shown in a recover_context("id") hint.',
		promptSnippet: 'Recover full original text of a compressed message by its id',
		promptGuidelines: [
			'Use recover_context when a compressed or summarized message lacks detail you need and shows a recover_context("id") hint.',
		],
		parameters: Type.Object({
			id: Type.String({
				description: 'The content id from a recover_context("id") hint',
			}),
		}),
		async execute(
			_toolCallId,
			params,
		): Promise<{
			content: { type: 'text'; text: string }[];
			details: Record<string, unknown>;
		}> {
			const stored = store.get(params.id);
			if (!stored) {
				return {
					content: [{ type: 'text', text: `No stored content for id "${params.id}".` }],
					details: {},
				};
			}
			return {
				content: [{ type: 'text', text: stored.original }],
				details: { id: stored.id, chars: stored.chars, role: stored.role },
			};
		},
	});

	pi.registerCommand('smart-context-toggle', {
		description: 'Enable or disable smart-context model routing',
		handler: async (_args, ctx) => {
			enabled = !enabled;
			ctx.ui.notify(`smart-context routing ${enabled ? 'enabled' : 'disabled'}`, 'info');
		},
	});

	pi.registerCommand('smart-context', {
		description: 'Show smart-context compression stats and current profile',
		handler: async (_args, ctx) => {
			const s = compressor.getStats();
			const profile = resolveProfile(ctx.cwd);
			ctx.ui.notify(
				`[${enabled ? 'on' : 'off'}] profile=${_activeProfileName(profile)} ` +
					`Saved ${s.totalSaved} chars (${s.ratio}% avg) | turns ${s.turnsProcessed} | ` +
					`classifier ${s.haikuCalls} calls / ${s.haikuCacheHits} cached | recoverable ${s.storedItems}`,
				'info',
			);
		},
	});

	pi.registerCommand('smart-context-profile', {
		description:
			'List or switch smart-context profiles (balanced, fast, quality, or custom). ' +
			'Usage: /smart-context-profile          → list profiles\n' +
			"       /smart-context-profile balanced → switch to 'balanced'",
		handler: async (args, ctx) => {
			const profiles = builtinProfiles();

			// args is a raw string — trim it to get the profile name (if any)
			const profileArg = typeof args === 'string' ? args.trim() : '';

			if (!profileArg) {
				const current = resolveProfile(ctx.cwd);
				const names = Object.keys(profiles);
				const cfgPath = configFilePath(ctx.cwd);
				ctx.ui.notify(
					`Available profiles: ${names.join(', ')}\n` +
						`Current: ${_activeProfileName(current)}\n` +
						`Config: ${cfgPath}\n` +
						`To switch: /smart-context-profile {profileName}`,
					'info',
				);
				return;
			}

			if (!profiles[profileArg]) {
				ctx.ui.notify(
					`Unknown profile "${profileArg}". Available: ${Object.keys(profiles).join(', ')}`,
					'warning',
				);
				return;
			}

			// Write the profile selection to the config file
			const fs = await import('node:fs');
			const cfgPath = configFilePath(ctx.cwd);
			if (!cfgPath) {
				ctx.ui.notify(
					'Config path unavailable; cannot persist profile selection.',
					'warning',
				);
				return;
			}

			let config: Record<string, unknown> = {};
			try {
				config = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
			} catch {
				// file doesn't exist or is invalid — start fresh
			}

			// If switching to a profile, set as activeProfile and clear flat fields to avoid confusion
			config.activeProfile = profileArg;
			delete config.classifier;
			delete config.routing;
			delete config.largeContext;

			fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2) + '\n');
			clearCache();

			const p = resolveProfile(ctx.cwd);
			ctx.ui.notify(
				`Switched to profile "${profileArg}"\n` +
					`classifier: ${p.classifier.provider}/${p.classifier.model}\n` +
					`trivial → ${p.routing.trivial.provider}/${p.routing.trivial.model}\n` +
					`simple  → ${p.routing.simple.provider}/${p.routing.simple.model}\n` +
					`medium  → ${p.routing.medium.provider}/${p.routing.medium.model}\n` +
					`complex → ${p.routing.complex.provider}/${p.routing.complex.model}\n` +
					`largeContext → ${p.largeContext.model.provider}/${p.largeContext.model.model}`,
				'info',
			);
		},
	});
}

function _activeProfileName(profile: ModelProfile): string {
	// Try to detect which built-in profile matches
	const bi = builtinProfiles();
	for (const [name, p] of Object.entries(bi)) {
		if (
			p.classifier.provider === profile.classifier.provider &&
			p.classifier.model === profile.classifier.model &&
			p.routing.trivial.provider === profile.routing.trivial.provider &&
			p.routing.trivial.model === profile.routing.trivial.model &&
			p.routing.simple.provider === profile.routing.simple.provider &&
			p.routing.simple.model === profile.routing.simple.model &&
			p.routing.medium.provider === profile.routing.medium.provider &&
			p.routing.medium.model === profile.routing.medium.model &&
			p.routing.complex.provider === profile.routing.complex.provider &&
			p.routing.complex.model === profile.routing.complex.model
		) {
			return name;
		}
	}
	return 'custom';
}
