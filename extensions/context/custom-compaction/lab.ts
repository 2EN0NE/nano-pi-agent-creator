/**
 * pi-lab experiment integration for custom-compaction.
 *
 * 并行 3 个维度实验（机制 / prompt / 阈值），select/record 直报：
 *  - 每次压缩对各实验独立 select() 选臂，决定实际机制/prompt/阈值（不写回持久化配置）
 *  - 反馈信号对各实验独立 record()（armId 即当时 select 结果，消除并行归因混淆）
 *
 * 信号：
 *  - 过程指标（guardrail）：压缩耗时 latency_ms、token 节省 saved_tokens、摘要长度 summary_length
 *  - 用户行为信号：回退（重点）/ 重压（补充）/ 打标（GOOD/BAD）
 *
 * 弱依赖（方案 A）：globalThis.__labApi 桥接，pi-lab 缺失时自然降级（返回 null）。
 * 注册必须在 session_start 中做（消除加载顺序竞险）。
 */

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
// 说明：semgrep 的 pi.logger-imported-but-unused 规则存在误报（import 节点上 pattern-not const 声明恒成立），
// nosemgrep 注释用于抑制该误报；const log = createLogger(...) 在下方实例化并被 log.info/error 实际使用。
import { createLogger } from '@zenone/pi-logger'; // nosemgrep: pi.logger-imported-but-unused
import { getAdapter } from './mechanisms/index.js';
import type { CompactionProfile } from './types.js';

const log = createLogger('custom-compaction:lab');

// ── 实验臂定义（注册时声明） ────────────────────────────────────

/** 机制实验：臂 id 映射到 CompactionMechanism */
export const MECHANISM_ARMS = [
	{ id: 'summarize', label: 'LLM 摘要' },
	{ id: 'smart-compact', label: 'EESV Smart Compact' },
] as const;
export type MechanismArm = (typeof MECHANISM_ARMS)[number]['id'];

/** prompt 实验：臂 id 映射到预设摘要 prompt */
export const PROMPT_ARMS = [
	{ id: 'structured', label: '结构化摘要（目标/决策/变更/状态/阻塞/下一步）' },
	{ id: 'narrative', label: '叙事式精简（连贯故事线，保留关键路径）' },
] as const;
export type PromptArm = (typeof PROMPT_ARMS)[number]['id'];

/** 阈值实验：臂 id 即 context_percent 阈值数值 */
export const THRESHOLD_ARMS = [
	{ id: '60', label: '60%' },
	{ id: '70', label: '70%' },
	{ id: '80', label: '80%' },
] as const;
export type ThresholdArm = (typeof THRESHOLD_ARMS)[number]['id'];

/** 叙事式 prompt 变体（与结构化默认形成对照实验） */
export const NARRATIVE_PROMPT = `You are a conversation summarizer. Write a concise narrative summary of this conversation that captures the flow of work as a coherent story:

1. Where we started and what we were trying to achieve
2. The path we took: key turns, discoveries, and pivots (keep cause -> effect)
3. What is decided and working, what is broken or uncertain
4. The exact current state of files/code so work can resume mid-stream
5. Anything the user explicitly asked to remember

Write it as flowing prose with short sections, not bullet lists. Preserve file paths, numbers, and technical specifics verbatim. The summary will replace the ENTIRE conversation history.`;

/** 结构化 prompt 变体（语义等价于默认，作为 v1 对照的显式声明） */
export const STRUCTURED_PROMPT = `You are a conversation summarizer. Create a comprehensive summary of this conversation that captures:

1. The main goals and objectives discussed
2. Key decisions made and their rationale
3. Important code changes, file modifications, or technical details
4. Current state of any ongoing work
5. Any blockers, issues, or open questions
6. Next steps that were planned or suggested

Be thorough but concise. The summary will replace the ENTIRE conversation history, so include all information needed to continue the work effectively.

Format the summary as structured markdown with clear sections.`;

/** 三个实验共用的观测指标（过程指标 guardrail + 满意度信号） */
const EXPERIMENT_METRICS = [
	{
		id: 'latency_ms',
		type: 'continuous',
		direction: 'minimize',
		description: '压缩耗时（毫秒）',
	},
	{
		id: 'saved_tokens',
		type: 'continuous',
		direction: 'maximize',
		description: '压缩节省的 token',
	},
	{
		id: 'summary_length',
		type: 'continuous',
		direction: 'minimize',
		description: '摘要长度（字符）',
	},
	{
		id: 'satisfaction',
		type: 'binary',
		direction: 'maximize',
		description: '用户满意（1=满意/0=不满意）',
	},
] as const;

// ── 实验运行时 ──────────────────────────────────────────────────

/** pi-lab ExperimentAPI 的最小接口（鸭子类型，弱依赖不需要真实类型） */
interface LabExperiment {
	select: (context?: unknown) => Promise<string>;
	record: (
		armId: string,
		outcome: { metrics: Record<string, number> },
		context?: unknown,
	) => Promise<void>;
	info: () => { name: string; strategy: string; forceArmId: string | null };
	stats: () => Promise<
		Record<
			string,
			{ totalCalls: number; metrics: Record<string, { sum: number; count: number }> }
		>
	>;
}

interface LabManager {
	__labApi?: {
		getExperimentManager?: () => {
			registerWeakExperiment: (def: unknown) => LabExperiment | undefined;
		};
	};
}

/** 一次压缩的选臂结果（三个维度各一臂）。
 * mechanism/prompt 为 null 表示对应实验未激活（不覆盖 profile 原配置）。
 */
export interface LabArmSelection {
	/** 机制臂（mechanism 实验未激活时为 null = 保留 profile 原机制） */
	mechanism: MechanismArm | null;
	/** prompt 臂（prompt 实验未激活时为 null = 保留 profile 自定义 prompt） */
	prompt: PromptArm | null;
	/** 阈值实验臂 id（数字字符串），未激活时为 null */
	threshold: ThresholdArm | null;
}

/** 最近一次自动压缩的记录（反馈归因用） */
export interface RecentCompactRecord {
	timestamp: number;
	/** 压缩前 leaf id（回退判定基准） */
	leafBefore: string | null;
	/** 压缩后 leaf id */
	leafAfter: string | null;
	/** 压缩来源：自动（agent_end 阈值触发）或手动（/custom-compact） */
	source: 'auto' | 'manual';
	arms: LabArmSelection;
}

// ── 模块状态 ────────────────────────────────────────────────────

let _experiments: Record<string, LabExperiment> = {};
let _recentCompact: RecentCompactRecord | null = null;
/** 正在进行的压缩的选臂（本扩展发起时设置，压缩结束清除；非本扩展压缩为 null） */
let _activeCompactArms: LabArmSelection | null = null;
/** 压缩后是否已 report 过过程指标（每次压缩只报一次） */
let _processReported = false;
/** 回退信号是否已上报（防重复；下次 markCompactStart 重置） */
let _rollbackReported = false;

/** contextKey：按模型分桶，同一模型稳定同一臂 */
function contextKey(ctx: { model?: { provider?: string; id?: string } }): string {
	return `${ctx.model?.provider ?? 'unknown'}:${ctx.model?.id ?? 'unknown'}`;
}

// ── 注册（session_start 调用） ──────────────────────────────────

/**
 * 注册三个并行实验。pi-lab 不可用时静默降级。
 * 必须在 session_start 中调用（消除加载顺序竞险）。
 */
export function initExperiments(_ctx: ExtensionContext): void {
	const mgr = (globalThis as unknown as LabManager).__labApi?.getExperimentManager?.();
	if (!mgr) {
		log.warn('pi-lab not available — custom-compaction running without experiments');
		_experiments = {};
		return;
	}

	const ck = (c: ExtensionContext) => contextKey(c);
	const registered: Record<string, LabExperiment> = {};

	// 机制实验注册前提：smart_compact adapter 必须真实拦截压缩（handlesCompaction）。
	// 当前 adapter 是 collaboration 模式（beforeCompact 恒返回 false = pass-through），
	// 机制臂会落到与 summarize 相同的摘要路径，无对比度——跳过注册避免收集噪声数据。
	// prompt/threshold 实验不受影响。
	const mechanismUsable = getAdapter('smart_compact')?.handlesCompaction === true;

	const defs = [
		{
			key: 'mechanism',
			def: {
				owner: 'custom-compaction',
				name: 'mechanism-strategy',
				contextKey: ck,
				arms: MECHANISM_ARMS,
				metrics: EXPERIMENT_METRICS,
				strategy: 'stable-hash',
			},
		},
		{
			key: 'prompt',
			def: {
				owner: 'custom-compaction',
				name: 'prompt-strategy',
				contextKey: ck,
				arms: PROMPT_ARMS,
				metrics: EXPERIMENT_METRICS,
				strategy: 'stable-hash',
			},
		},
		{
			key: 'threshold',
			def: {
				owner: 'custom-compaction',
				name: 'threshold-strategy',
				contextKey: ck,
				arms: THRESHOLD_ARMS,
				metrics: EXPERIMENT_METRICS,
				strategy: 'stable-hash',
			},
		},
	] as const;

	for (const { key, def } of defs) {
		if (key === 'mechanism' && !mechanismUsable) {
			log.warn(
				'Mechanism experiment skipped: smart_compact adapter is collaboration pass-through (no real mechanism difference)',
			);
			continue;
		}
		try {
			const exp = mgr!.registerWeakExperiment(def);
			if (exp) {
				registered[key] = exp;
				log.info(`Experiment registered: custom-compaction/${def.name}`);
			} else {
				log.warn(`Experiment registration blocked (name conflict): ${def.name}`);
			}
		} catch (err) {
			log.warn(`Failed to register experiment ${def.name}`, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	_experiments = registered;
}

/** 实验是否激活（任一注册成功） */
export function isLabActive(): boolean {
	return Object.keys(_experiments).length > 0;
}

// ── 选臂（压缩时调用） ─────────────────────────────────────────

/**
 * 对激活实验选臂。实验不可用时返回 null（走原 profile 逻辑）。
 * 不写回持久化配置——选臂结果仅本次压缩生效（stable-hash 保证同模型稳定同臂）。
 */
export async function selectArms(ctx: ExtensionContext): Promise<LabArmSelection | null> {
	const keys = Object.keys(_experiments);
	if (keys.length === 0) return null;

	// 顺带缓存当前模型（record 归因 context 用，与 select 的 contextKey 格式一致）
	rememberModel(ctx.model);

	const selection: LabArmSelection = {
		mechanism: null,
		prompt: null,
		threshold: null,
	};
	try {
		if (_experiments.mechanism) {
			const arm = await _experiments.mechanism.select(ctx);
			if (MECHANISM_ARMS.some((a) => a.id === arm)) {
				selection.mechanism = arm as MechanismArm;
			} else {
				log.warn('Unknown mechanism arm from pi-lab:', arm);
			}
		}
		if (_experiments.prompt) {
			const arm = await _experiments.prompt.select(ctx);
			if (PROMPT_ARMS.some((a) => a.id === arm)) {
				selection.prompt = arm as PromptArm;
			} else {
				log.warn('Unknown prompt arm from pi-lab:', arm);
			}
		}
		if (_experiments.threshold) {
			const arm = await _experiments.threshold.select(ctx);
			if (THRESHOLD_ARMS.some((a) => a.id === arm)) {
				selection.threshold = arm as ThresholdArm;
			} else {
				log.warn('Unknown threshold arm from pi-lab:', arm);
			}
		}
		log.info('Lab arms selected:', selection);
		return selection;
	} catch (err) {
		log.warn('Failed to select lab arms, falling back to profile', {
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}

/** 机制臂 → 实际 adapterId（smart-compact 臂映射到 adapter） */
export function mechanismAdapterId(arm: MechanismArm): string | undefined {
	if (arm === 'smart-compact') return 'smart_compact';
	return undefined;
}

/** prompt 臂 → 预设 prompt 文本 */
export function promptForArm(arm: PromptArm): string {
	return arm === 'narrative' ? NARRATIVE_PROMPT : STRUCTURED_PROMPT;
}

/** 阈值臂 → 数值（null 表示未激活） */
export function thresholdValue(arm: ThresholdArm | null): number | null {
	return arm === null ? null : Number(arm);
}

// ── 最近压缩记录（反馈归因） ────────────────────────────────────

/**
 * 压缩开始时记录（doCompact 调用 compact() 前）。
 * leafBefore/leafAfter 用于回退检测；source 区分自动/手动（重压信号判定）。
 * 同时设置本次压缩的活跃选臂（compactor 在 session_before_compact 消费）。
 */
export function markCompactStart(
	_ctx: ExtensionContext,
	arms: LabArmSelection | null,
	leafBefore: string | null,
	source: 'auto' | 'manual' = 'auto',
): void {
	if (!arms) return;
	_recentCompact = {
		timestamp: Date.now(),
		leafBefore,
		leafAfter: null,
		source,
		arms,
	};
	_processReported = false;
	_rollbackReported = false;
	_activeCompactArms = arms;
}

/** 压缩完成后补充 leafAfter 并标记过程指标待报 */
export function markCompactEnd(_ctx: ExtensionContext, leafAfter: string | null): void {
	if (!_recentCompact) return;
	_recentCompact.leafAfter = leafAfter;
}

/** 当前正在进行的压缩的选臂（仅本扩展发起压缩期间有效；无实验或非本扩展压缩为 null） */
export function getActiveCompactArms(): LabArmSelection | null {
	return _activeCompactArms;
}

/** 压缩结束（onComplete/onError/session_compact）时清除，防止非本扩展压缩套用陈旧臂 */
export function clearActiveCompact(): void {
	_activeCompactArms = null;
}

/**
 * 应用实验选臂到 profile（克隆，不修改原对象/持久化配置）。
 * 覆盖三处：机制（summarize/smart-compact）、prompt 变体、触发阈值（context_percent 时）。
 * arms 为 null 时原样返回 profile。
 */
export function applyLabOverrides(
	profile: CompactionProfile,
	arms: LabArmSelection | null,
): CompactionProfile {
	if (!arms) return profile;
	const cloned: CompactionProfile = {
		...profile,
		trigger: { ...profile.trigger },
		mechanism: { ...profile.mechanism },
	};

	// 机制臂（仅 mechanism 实验激活时覆盖；null = 实验未注册，保留 profile 原机制）
	if (arms.mechanism === 'smart-compact') {
		cloned.mechanism = { type: 'adapter', adapterId: 'smart_compact' };
	} else if (arms.mechanism === 'summarize') {
		cloned.mechanism = { type: 'summarize' };
	}

	// prompt 臂（仅 prompt 实验激活时覆盖；null = 保留 profile 自定义 prompt）
	if (arms.prompt === 'narrative') {
		cloned.prompt = NARRATIVE_PROMPT;
	} else if (arms.prompt === 'structured') {
		cloned.prompt = STRUCTURED_PROMPT;
	}

	// 阈值臂（仅 context_percent 触发类型有意义）
	const t = thresholdValue(arms.threshold);
	if (t !== null && cloned.trigger.type === 'context_percent') {
		cloned.trigger.threshold = t;
	}

	return cloned;
}

/**
 * 重压信号：用户在上次**自动**压缩后 30 分钟内手动再次压缩 → 视为对上次压缩不满。
 * 补充信号（用户主要用回退表达不满，重压较少见）。
 */
export async function reportRecompact(): Promise<void> {
	if (!_recentCompact || _recentCompact.source !== 'auto') return;
	if (Date.now() - _recentCompact.timestamp > 30 * 60 * 1000) return;
	log.info('Recompact signal: manual re-compact within 30min of last auto compact');
	await recordAll({ satisfaction: 0 });
}

/** 清理最近压缩记录（会话关闭 / 重载） */
export function resetLabState(): void {
	_recentCompact = null;
	_processReported = false;
	_rollbackReported = false;
	_activeCompactArms = null;
}

/**
 * 压缩失败时清除最近压缩记录（onError 调用）。
 * 失败不产生可归因信号：保留 leafAfter=null 的记录会让 detectRollback 把
 * 「压缩后 leaf 未推进」误判为用户回退不满（satisfaction=0 污染实验数据）。
 */
export function clearRecentCompact(): void {
	_recentCompact = null;
	_rollbackReported = false;
}

// ── 信号上报 ────────────────────────────────────────────────────

/** 对全部激活实验 record 一次（同一信号广播到各实验各自臂） */
async function recordAll(metrics: Record<string, number>): Promise<void> {
	const arms = _recentCompact?.arms;
	if (!arms) return;
	// 与 select() 相同的 context 形状（{model:{provider,id}}），
	// 保证 select/record 经同一 contextKey fn 落到同一 ctxKey 桶
	const ctx = _lastCtxModel ? { model: _lastCtxModel } : undefined;
	for (const [key, exp] of Object.entries(_experiments)) {
		let armId: string | null = null;
		if (key === 'mechanism') armId = arms.mechanism;
		else if (key === 'prompt') armId = arms.prompt;
		else if (key === 'threshold') armId = arms.threshold;
		if (armId === null) continue;
		try {
			await exp.record(armId, { metrics }, ctx);
			log.debug(`Recorded to experiment ${key} arm ${armId}`, metrics);
		} catch (err) {
			log.warn(`Failed to record to experiment ${key}`, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
}

let _lastCtxModel: { provider: string; id: string } | undefined;

/** 缓存当前模型（record 归因 context 用，与 select 的 contextKey 提取格式一致） */
export function rememberModel(model?: { provider?: string; id?: string }): void {
	_lastCtxModel =
		model?.provider && model?.id ? { provider: model.provider, id: model.id } : undefined;
}

/**
 * 压缩完成后上报过程指标（onComplete 调用，一次压缩只报一次）。
 * 返回是否已上报（供调用方判断是否重报）。
 */
export async function reportProcessMetrics(feedback: {
	latencyMs: number;
	savedTokens: number;
	summaryLength: number;
}): Promise<boolean> {
	if (!_recentCompact || _processReported) return false;
	_processReported = true;
	await recordAll({
		latency_ms: feedback.latencyMs,
		saved_tokens: feedback.savedTokens,
		summary_length: feedback.summaryLength,
	});
	return true;
}

/**
 * 用户行为满意度信号（回退/重压/打标触发）。
 * satisfied=false 表示用户对最近一次压缩不满。
 */
export async function reportSatisfaction(satisfied: boolean): Promise<void> {
	if (!_recentCompact) return;
	await recordAll({ satisfaction: satisfied ? 1 : 0 });
}

// ── 回退信号检测（turn_end 调用） ───────────────────────────────

/**
 * 检测用户是否回退到压缩之前。
 * 压缩后 leaf 正常推进（新节点成为 leafAfter 的后代）；若当前 leaf 不在
 * leafAfter 的祖先链上 → 用户已回退到压缩点之前的分支重新开始（不满信号）。
 *
 * 为什么用「祖先链」而非「数组 index」：
 * pi 会话文件是 append-only（_appendEntry 只 push；branch() 仅移动 leaf 指针），
 * 用户回退到旧节点后发消息，fork 节点追加在文件末尾（index 恒最大）。
 * 若用 getEntries() 的 index 比较（旧实现 curIdx <= beforeIdx），在
 * 「回退 → 重新输入 prompt」的标准流程中 curIdx > beforeIdx 恒成立，永不命中。
 * 祖先链判定：当前 leaf 的祖先链不含压缩后节点（leafAfter）即视为离开压缩后分支。
 *
 * @param ctx          扩展上下文（保留签名兼容）
 * @param currentLeafId 当前 leaf id（调用方从 sessionManager.getLeafId() 获取）
 * @param ancestorChain 当前 leaf 的祖先链（含自身，leaf → ... → root），由调用方从
 *                      sessionManager.getEntry().parentId 逐级上溯构建
 * @returns 命中回退返回 true，并已上报满意度；否则 false
 */
export function detectRollback(
	_ctx: ExtensionContext,
	currentLeafId: string | null,
	ancestorChain: string[],
): boolean {
	if (!_recentCompact) return false;
	if (_rollbackReported) return false;
	const { leafBefore, leafAfter } = _recentCompact;
	if (!leafBefore || !currentLeafId) return false;
	// 祖先链构建失败（调用方 getAncestorChain 无法解析 parentId 链）→ 无法判定，
	// 保守不回退，避免误报 satisfaction=0 污染实验数据。
	if (ancestorChain.length === 0) return false;
	// 锚点：优先压缩后节点（leafAfter）；压缩未完成（markCompactEnd 未调用）时
	// 退化为压缩前节点（leafBefore），此时无法区分「正常推进」与「回退到 leafBefore」，
	// 属异常路径兜底。
	const anchor = leafAfter ?? leafBefore;
	// 当前 leaf 的祖先链含锚点 → 仍在压缩后分支（含压缩瞬间 leaf==leafAfter）→ 正常
	if (ancestorChain.includes(anchor)) return false;
	_rollbackReported = true;
	log.info('Rollback detected (current leaf off the post-compaction branch)');
	void reportSatisfaction(false);
	return true;
}

// ── 实验状态查询（settings panel 用） ───────────────────────────

export interface LabStatus {
	active: boolean;
	experiments: Array<{
		key: string;
		name: string;
		strategy: string;
		forceArmId: string | null;
		currentArm: string;
		totalCalls: number;
	}>;
}

/** 查询实验状态（当前臂 + 样本量）。实验不可用时返回 { active: false } */
export async function getLabStatus(): Promise<LabStatus> {
	const keys = Object.keys(_experiments);
	if (keys.length === 0) return { active: false, experiments: [] };

	const experiments: LabStatus['experiments'] = [];
	for (const key of keys) {
		const exp = _experiments[key];
		try {
			const info = exp.info();
			const stats = await exp.stats();
			const currentArm = info.forceArmId ?? (await currentArmFor(key));
			const totalCalls = Object.values(stats).reduce((n, a) => n + a.totalCalls, 0);
			experiments.push({
				key,
				name: info.name,
				strategy: info.strategy,
				forceArmId: info.forceArmId,
				currentArm,
				totalCalls,
			});
		} catch (err) {
			log.warn(`Failed to query experiment ${key}`, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	return { active: experiments.length > 0, experiments };
}

async function currentArmFor(key: string): Promise<string> {
	if (!_recentCompact) return '(未压缩)';
	const arms = _recentCompact.arms;
	if (key === 'mechanism') return arms.mechanism ?? '(未激活)';
	if (key === 'prompt') return arms.prompt ?? '(未激活)';
	return arms.threshold ?? '(未激活)';
}
