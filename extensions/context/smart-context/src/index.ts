import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { createLogger } from '@zenone/pi-logger';
import { createRouter } from './router.js';
import { createCompressor, isWindowTight } from './compression/pipeline.js';
import { initExperiments, runCompressionWithExperiment, recordRecoverContext } from './lab.js';
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

const log = createLogger('smart-context');

export default function (pi: ExtensionAPI) {
	const router = createRouter(pi);
	const store = createContentStore();
	const summarizer = createSummarizer();
	const compressor = createCompressor({ store, summarizer });

	let enabled = true;
	const debug = process.env.SMART_CONTEXT_DEBUG === '1';

	// ── pi-lab 实验注册（compression-aggression，压缩维度 A）──
	pi.on('session_start', async (_event, ctx) => {
		initExperiments(ctx);
	});

	// ── 首次安装：输出默认配置文件，让用户可以看到完整策略并可编辑 ──
	pi.on('session_start', async (_event, ctx) => {
		const cfgPath = configFilePath(ctx.cwd);
		if (!cfgPath) return;
		try {
			const [fs, path] = await Promise.all([import('node:fs'), import('node:path')]);
			if (!fs.existsSync(cfgPath)) {
				const defaultCfg = {
					activeProfile: 'balanced',
					profiles: {
						balanced: {
							classifier: { provider: 'deepseek', model: 'deepseek-v4-flash' },
							routing: {
								trivial: { provider: 'deepseek', model: 'deepseek-v4-flash' },
								simple: { provider: 'deepseek', model: 'deepseek-v4-flash' },
								medium: { provider: 'deepseek', model: 'deepseek-v4-pro' },
								complex: { provider: 'deepseek', model: 'deepseek-v4-pro' },
							},
							largeContext: {
								thresholdTokens: 500_000,
								model: { provider: 'deepseek', model: 'deepseek-v4-pro' },
							},
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
	});

	pi.on('before_agent_start', async (event, ctx) => {
		if (!enabled) {
			log.debug('Routing skipped (disabled)');
			return;
		}
		try {
			ctx.ui.setWorkingMessage('Routing...');
			const decision = await router.pick(event.prompt, ctx);
			if (!decision) {
				log.info('No route — keeping current model');
				if (debug) ctx.ui.notify('smart-context: 无路由（保持当前模型）', 'info');
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
			ctx.ui.notify(`smart-context 路由错误：${msg} [${getDiagnostics()}]`, 'warning');
		} finally {
			ctx.ui.setWorkingMessage();
		}
	});

	pi.on('context', async (event, ctx) => {
		ctx.ui.setWorkingMessage('压缩中...');
		try {
			const windowTight = isWindowTight(ctx);
			const run = await runCompressionWithExperiment(
				compressor,
				event.messages as unknown[],
				ctx,
				windowTight,
			);
			if (run.saved > 0) {
				log.info(
					'Context compressed | arm=%s before=%s after=%s saved=%s ratio=%s%%',
					run.armId,
					run.before,
					run.after,
					run.saved,
					Math.round((run.saved / run.before) * 100),
				);
			}
			return { messages: run.messages } as any;
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
		label: '恢复上下文',
		description:
			'恢复会话上下文中被压缩/摘要的消息的完整原始内容。传入 recover_context("id") 提示中显示的 id。',
		promptSnippet: '按 id 恢复被压缩消息的完整原始文本',
		promptGuidelines: [
			'当被压缩或摘要的消息缺少你需要的细节并显示 recover_context("id") 提示时，使用 recover_context。',
		],
		parameters: Type.Object({
			id: Type.String({
				description: '来自 recover_context("id") 提示的内容 id',
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
					content: [{ type: 'text', text: `没有 id 为 "${params.id}" 的存储内容。` }],
					details: {},
				};
			}
			// 上报恢复信号（压缩过度 → agent 频繁恢复原文），异步不阻塞工具返回
			void recordRecoverContext();
			return {
				content: [{ type: 'text', text: stored.original }],
				details: { id: stored.id, chars: stored.chars, role: stored.role },
			};
		},
	});

	pi.registerCommand('smart-context-toggle', {
		description: '启用或禁用 smart-context 模型路由',
		handler: async (_args, ctx) => {
			enabled = !enabled;
			ctx.ui.notify(`smart-context routing ${enabled ? '已启用' : '已禁用'}`, 'info');
		},
	});

	pi.registerCommand('smart-context', {
		description: '显示 smart-context 压缩统计与当前配置',
		handler: async (_args, ctx) => {
			const s = compressor.getStats();
			const profile = resolveProfile(ctx.cwd);
			ctx.ui.notify(
				`[${enabled ? 'on' : 'off'}] 配置=${_activeProfileName(profile)} ` +
					`已节省 ${s.totalSaved} 字符（${s.ratio}% 平均）| 轮次 ${s.turnsProcessed} | ` +
					`分类器 ${s.haikuCalls} 次调用 / ${s.haikuCacheHits} 次缓存 | 可恢复 ${s.storedItems}`,
				'info',
			);
		},
	});

	pi.registerCommand('smart-context-profile', {
		description:
			'列出或切换 smart-context 配置（balanced、fast、quality 或 custom）。 ' +
			'用法：/smart-context-profile          → 列出配置\n' +
			"       /smart-context-profile balanced → 切换到 'balanced'",
		handler: async (args, ctx) => {
			const profiles = builtinProfiles();

			// args is a raw string — trim it to get the profile name (if any)
			const profileArg = typeof args === 'string' ? args.trim() : '';

			if (!profileArg) {
				const current = resolveProfile(ctx.cwd);
				const names = Object.keys(profiles);
				const cfgPath = configFilePath(ctx.cwd);
				ctx.ui.notify(
					`可用配置：${names.join(', ')}\n` +
						`当前：${_activeProfileName(current)}\n` +
						`配置文件：${cfgPath}\n` +
						`切换方式：/smart-context-profile {profileName}`,
					'info',
				);
				return;
			}

			if (!profiles[profileArg]) {
				ctx.ui.notify(
					`未知配置 "${profileArg}". Available: ${Object.keys(profiles).join(', ')}`,
					'warning',
				);
				return;
			}

			// Write the profile selection to the config file
			const fs = await import('node:fs');
			const cfgPath = configFilePath(ctx.cwd);
			if (!cfgPath) {
				ctx.ui.notify('配置路径不可用；无法持久化配置选择。', 'warning');
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
				`已切换到配置 "${profileArg}"\n` +
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
