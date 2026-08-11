import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createLogger } from '@zenone/pi-logger';
import { getComplete } from './host-ai.js';
import { loadConfig, configFilePath, type Complexity, type ModelRef } from './config.js';

const log = createLogger('smart-context:router');

/** 路由决策的完整元数据 */
export interface PickDecision {
	model: ModelRef;
	reason: 'classifier' | 'largeContext';
	detail: string;
	classifierResult?: {
		complexity: Complexity;
		rawAnswer: string;
	};
}

const CLASSIFICATION_PROMPT = `你是一个编码助手的任务复杂度分类器。基于最近的对话上下文和用户的最新消息，对 TASK 复杂度（而非消息复杂度）进行分类。

规则：
- 如果用户说了"好的"、"可以"、"继续"、"搞"、"干"、"来"、"行"、"做吧"、"开工"、"走起"等认同性回复，查看他们在同意什么——前一条助手消息定义了任务。
- "trivial": 简单的确认回复且没有待处理任务、问候、元对话
- "simple": 单文件修复、typo、小改动、有明确答案的快速问题
- "medium": 多文件变更、功能实现、调试、代码审查、大多数编码任务
- "complex": 架构设计、大型重构、安全审计、系统级变更、跨多服务的性能优化——仅用于最高要求的任务

在 simple 和 medium 之间犹豫时选 medium。在 medium 和 complex 之间犹豫时选 medium。

仅回复一个词：trivial、simple、medium 或 complex`;

export function createRouter(_pi: ExtensionAPI) {
	return {
		async pick(prompt: string, ctx: any): Promise<PickDecision | null> {
			const config = loadConfig(ctx.cwd);

			const usage = ctx.getContextUsage?.();
			log.info(
				`Router pick started | cwd=%s cfg=%s tokens=%s threshold=%s classifier=%s/%s`,
				ctx.cwd,
				configFilePath(ctx.cwd) ?? '<none>',
				usage?.tokens ?? 'n/a',
				config.largeContext.thresholdTokens,
				config.classifier.provider,
				config.classifier.model,
			);

			// ── 大上下文保护 ──
			if (usage && usage.tokens > config.largeContext.thresholdTokens) {
				const target = config.largeContext.model;
				log.info(
					`Routing decision | branch=largeContext target=%s/%s tokens=%s threshold=%s`,
					target.provider,
					target.model,
					usage.tokens,
					config.largeContext.thresholdTokens,
				);
				return {
					model: target,
					reason: 'largeContext',
					detail: `上下文 tokens ${usage.tokens} 超过阈值 ${config.largeContext.thresholdTokens}，强制使用大上下文模型`,
				};
			}

			// ── 分类器调用 ──
			const { classifier } = config;
			const model = ctx.modelRegistry.find(classifier.provider, classifier.model);
			if (!model) {
				log.warn(
					`Classifier model not in registry | provider=%s model=%s`,
					classifier.provider,
					classifier.model,
				);
				return null;
			}

			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok || !auth.apiKey) {
				log.warn(
					`Classifier auth failed | provider=%s model=%s ok=%s`,
					classifier.provider,
					classifier.model,
					auth.ok,
				);
				return null;
			}

			const complete = await getComplete();
			if (!complete) {
				log.error(`Host pi-ai complete() not resolvable`);
				throw new Error('could not resolve host pi-ai complete()');
			}

			const recentContext = buildRecentContext(ctx);
			log.debug(
				`Classifier input | ctxLen=%s prompt=%s`,
				recentContext.length,
				prompt.slice(0, 100),
			);

			const messages = [
				{
					role: 'user' as const,
					content: [
						{
							type: 'text' as const,
							text: `${recentContext}\n\n用户最新消息: "${prompt}"\n\n对 TASK 复杂度进行分类：`,
						},
					],
					timestamp: Date.now(),
				},
			];

			const response = await complete(
				model,
				{ messages, systemPrompt: CLASSIFICATION_PROMPT },
				{ apiKey: auth.apiKey, headers: auth.headers, maxTokens: 10 },
			);

			const answer = response.content
				.filter(
					(c: { type: string; text?: string }): c is { type: 'text'; text: string } =>
						c.type === 'text' && typeof c.text === 'string',
				)
				.map((c: { text: string }) => c.text.trim().toLowerCase())
				.join('');

			const complexity = parseComplexity(answer);
			const chosen = config.routing[complexity];

			log.info(
				`Routing decision | branch=classifier complexity=%s target=%s/%s raw=%s`,
				complexity,
				chosen.provider,
				chosen.model,
				answer,
			);

			return {
				model: chosen,
				reason: 'classifier',
				detail: `任务复杂度判定为 ${complexity}`,
				classifierResult: { complexity, rawAnswer: answer },
			};
		},
	};
}

const CONTEXT_CHAR_BUDGET = 6000;
const PER_MESSAGE_CHAR_CAP = 300;

function buildRecentContext(ctx: any): string {
	const entries = ctx.sessionManager?.getEntries?.();
	if (!entries || entries.length === 0) return '暂无历史上下文。';

	const lines: string[] = [];
	let budget = CONTEXT_CHAR_BUDGET;

	for (let i = entries.length - 1; i >= 0 && budget > 0; i--) {
		const entry = entries[i];
		if (entry.type !== 'message') continue;
		const role = entry.message?.role;
		const text = extractEntryText(entry);
		if (!role || !text) continue;
		const snippet = text.slice(0, PER_MESSAGE_CHAR_CAP);
		lines.unshift(`[${role}]: ${snippet}`);
		budget -= snippet.length;
	}

	return lines.length > 0 ? `截至目前对话（最近优先）:\n${lines.join('\n')}` : '暂无历史上下文。';
}

function extractEntryText(entry: any): string {
	const msg = entry.message;
	if (!msg) return '';
	if (typeof msg.content === 'string') return msg.content;
	if (Array.isArray(msg.content)) {
		return msg.content
			.filter((c: any) => c.type === 'text')
			.map((c: any) => c.text)
			.join(' ');
	}
	return '';
}

function parseComplexity(answer: string): Complexity {
	const match = answer
		.trim()
		.toLowerCase()
		.match(/\b(trivial|simple|medium|complex)\b/);
	if (match) return match[1] as Complexity;
	return 'medium';
}
