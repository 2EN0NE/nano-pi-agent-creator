/**
 * smart-context — 信号采集器
 *
 * 从各维度采集 SessionSignals：
 *   D1: prompt 结构 + 上下文使用
 *   D2: pi-session-tree 树指标（含重试检测）
 *   D3: 工程文档 score
 *   D4: commit/label 进度
 */

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createLogger } from '@zenone/pi-logger';
import type { SessionSignals } from './strategies/registry.js';

const log = createLogger('smart-context:signals');

// ── Helpers ─────────────────────────────────────────────────────────

/** 从消息 content 提取纯文本 */
function msgText(msg: any): string {
	if (!msg) return '';
	const c = msg.content;
	if (typeof c === 'string') return c;
	if (Array.isArray(c))
		return c
			.filter((p: any) => p.type === 'text')
			.map((p: any) => p.text)
			.join(' ');
	return '';
}

/** Jaccard 相似度（0-1），基于词袋 */
function jaccardSimilarity(a: string, b: string): number {
	const tokenize = (s: string) =>
		new Set(
			s
				.toLowerCase()
				.replace(/[^\w\s]/g, ' ')
				.split(/\s+/)
				.filter((t) => t.length > 1),
		);
	const setA = tokenize(a);
	const setB = tokenize(b);
	if (setA.size === 0 && setB.size === 0) return 1;
	const intersection = new Set([...setA].filter((x) => setB.has(x)));
	const union = new Set([...setA, ...setB]);
	return intersection.size / union.size;
}

// ── D1: turn-local ──────────────────────────────────────────────────

function collectPromptSignals(prompt: string) {
	const codeBlockMatches = prompt.match(/```/g);
	return {
		promptLength: prompt.length,
		promptCodeBlocks: codeBlockMatches ? Math.floor(codeBlockMatches.length / 2) : 0,
		promptFileRefs: (prompt.match(/[^\s]+\.[a-z]{1,6}(\s|$|[:,\]])/g) || []).length,
	};
}

function collectContextSignals(ctx: ExtensionContext) {
	const usage = ctx.getContextUsage();
	return { contextTokens: usage?.tokens ?? null, contextPercent: usage?.percent ?? null };
}

// ── D2: session tree ───────────────────────────────────────────────

function collectTreeSignals(
	ctx: ExtensionContext,
	prompt: string,
): Pick<
	SessionSignals,
	| 'branchCount'
	| 'checkpointCount'
	| 'compactionCount'
	| 'toolDistribution'
	| 'toolErrorRate'
	| 'isRetry'
> {
	try {
		const sm = ctx.sessionManager as any;
		const entries: any[] = sm.getEntries?.() ?? [];
		const tree: any[] = sm.getTree?.() ?? [];

		let branchCount = 0;
		function walk(n: any) {
			if (n.children?.length > 1) branchCount++;
			n.children?.forEach(walk);
		}
		for (const root of tree) walk(root);

		const compactionCount = entries.filter((e: any) => e.type === 'compaction').length;
		const checkpointCount = entries.filter((e: any) => e.type === 'label').length;

		const toolDistribution: Record<string, number> = {};
		let toolErrors = 0,
			toolTotal = 0;
		for (const e of entries) {
			if (e.type === 'message' && e.message?.toolResults) {
				for (const tr of e.message.toolResults) {
					toolDistribution[tr.toolName || 'unknown'] =
						(toolDistribution[tr.toolName || 'unknown'] || 0) + 1;
					toolTotal++;
					if (tr.isError) toolErrors++;
				}
			}
		}

		// 重试检测：比较最后两条用户消息
		const userMsgs = entries
			.filter((e: any) => e.type === 'message' && e.message?.role === 'user')
			.map((e: any) => msgText(e.message));
		let isRetry = false;
		if (userMsgs.length >= 2) {
			const prev = userMsgs[userMsgs.length - 2];
			const sim = jaccardSimilarity(prompt, prev);
			isRetry = sim > 0.6;
			if (isRetry) log.debug('Retry detected | similarity=%s', sim.toFixed(2));
		}

		return {
			branchCount,
			checkpointCount,
			compactionCount,
			toolDistribution,
			toolErrorRate: toolTotal > 0 ? toolErrors / toolTotal : 0,
			isRetry,
		};
	} catch (err) {
		log.warn('Failed to collect tree signals', {
			error: err instanceof Error ? err.message : String(err),
		});
		return {
			branchCount: 0,
			checkpointCount: 0,
			compactionCount: 0,
			toolDistribution: {},
			toolErrorRate: 0,
			isRetry: false,
		};
	}
}

// ── D3: project profile ────────────────────────────────────────────

async function collectProjectSignals(ctx: ExtensionContext) {
	let agentsMdSize = 0;
	let readmeMdSize = 0;
	try {
		const [fs, path] = await Promise.all([import('node:fs'), import('node:path')]);
		const agentsPath = path.join(ctx.cwd, 'AGENTS.md');
		const readmePath = path.join(ctx.cwd, 'README.md');
		if (fs.existsSync(agentsPath)) agentsMdSize = fs.statSync(agentsPath).size;
		if (fs.existsSync(readmePath)) readmeMdSize = fs.statSync(readmePath).size;
	} catch {
		/* filesystem access may fail */
	}

	let projectDocScore = 0;
	if (agentsMdSize > 0) projectDocScore += 40;
	if (agentsMdSize > 5000) projectDocScore += 20;
	if (readmeMdSize > 0) projectDocScore += 25;
	if (readmeMdSize > 3000) projectDocScore += 15;
	return { projectDocScore, agentsMdSize, readmeMdSize };
}

// ── D4: session progress ───────────────────────────────────────────

async function collectProgressSignals(ctx: ExtensionContext) {
	let commitCount = 0;
	let labelCount = 0;

	try {
		const entries = (ctx.sessionManager as any).getEntries?.() ?? [];
		labelCount = entries.filter((e: any) => e.type === 'label').length;

		// 采集项目 commit 数（通过 git rev-list）
		const { execSync } = await import('node:child_process');
		try {
			const out = execSync('git rev-list --count HEAD', {
				cwd: ctx.cwd,
				timeout: 2000,
				encoding: 'utf-8',
			});
			commitCount = parseInt(out.trim(), 10) || 0;
		} catch {
			// git not available or not a repo — commitCount stays 0
		}
	} catch {
		/* ignore */
	}

	const userEngagementScore = Math.min(labelCount * 20 + commitCount * 30, 100);
	return { commitCount, labelCount, userEngagementScore };
}

// ── Aggregate ───────────────────────────────────────────────────────

/** 采集全部信号 */
export async function collectAllSignals(
	prompt: string,
	ctx: ExtensionContext,
): Promise<SessionSignals> {
	return {
		...collectPromptSignals(prompt),
		...collectContextSignals(ctx),
		...collectTreeSignals(ctx, prompt),
		...(await collectProjectSignals(ctx)),
		...collectProgressSignals(ctx),
	};
}
