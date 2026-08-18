/**
 * pi-lab 实验接入（纯数据收集）。
 *
 * 只注册 1 个实验：profile-satisfaction。臂 = profile id（注册时由当前
 * config 的 profile 列表决定）。只 record 不 select——行为完全由 profile
 * 配置决定，pi-lab 零介入，仅作为「哪个 profile 用户更满意」的统计器。
 *
 * 信号：
 *  - 过程指标（guardrail）：压缩耗时 latency_ms、token 节省 saved_tokens、摘要长度 summary_length
 *  - 用户行为信号：回退（重点）/ 重压（补充）/ 打标（GOOD/BAD，复用 pi-session-tree，本次不做）
 *
 * 弱依赖（方案 A）：globalThis.__labApi 桥接，pi-lab 缺失时自然降级（record 空操作）。
 * 注册必须在 session_start 中做（消除加载顺序竞险）。
 */

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createLogger } from '@zenone/pi-logger';
import type { CompactionProfile } from './types.js';

const log = createLogger('custom-compaction:lab');

// ── 观测指标（过程指标 guardrail + 满意度信号） ────────────────────

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

// ── pi-lab ExperimentAPI 最小接口（鸭子类型，弱依赖不需要真实类型） ──

interface LabExperiment {
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

/** 最近一次压缩的记录（反馈归因用） */
export interface RecentCompactRecord {
	timestamp: number;
	/** 压缩前 leaf id（回退判定基准） */
	leafBefore: string | null;
	/** 压缩后 leaf id */
	leafAfter: string | null;
	/** 压缩来源：自动（agent_end 阈值触发）或手动（/custom-compact） */
	source: 'auto' | 'manual';
	/** 本次压缩生效的 profile id（record 的 armId） */
	profileId: string;
}

// ── 模块状态 ────────────────────────────────────────────────────

let _experiment: LabExperiment | null = null;
let _recentCompact: RecentCompactRecord | null = null;
/** 压缩后是否已 report 过过程指标（每次压缩只报一次） */
let _processReported = false;
/** 回退信号是否已上报（防重复；下次 markCompactStart 重置） */
let _rollbackReported = false;
let _lastCtxModel: { provider: string; id: string } | undefined;

/** contextKey：按模型分桶，同一模型稳定同一桶 */
function contextKey(ctx: { model?: { provider?: string; id?: string } }): string {
	return `${ctx.model?.provider ?? 'unknown'}:${ctx.model?.id ?? 'unknown'}`;
}

// ── 注册（session_start 调用，传入当前 profiles 作为臂） ─────────

export function initExperiments(_ctx: ExtensionContext, profiles: CompactionProfile[]): void {
	const mgr = (globalThis as unknown as LabManager).__labApi?.getExperimentManager?.();
	if (!mgr) {
		log.warn('pi-lab not available — custom-compaction running without experiments');
		_experiment = null;
		return;
	}

	try {
		const exp = mgr.registerWeakExperiment({
			owner: 'custom-compaction',
			name: 'profile-satisfaction',
			contextKey: (c: ExtensionContext) => contextKey(c),
			arms: profiles.map((p) => ({ id: p.id, label: p.name })),
			metrics: EXPERIMENT_METRICS,
			strategy: 'stable-hash',
		});
		_experiment = exp ?? null;
		if (!exp) {
			log.warn('Experiment registration blocked (name conflict): profile-satisfaction');
		} else {
			log.info('Experiment registered: custom-compaction/profile-satisfaction');
		}
	} catch (err) {
		log.warn('Failed to register experiment profile-satisfaction', {
			error: err instanceof Error ? err.message : String(err),
		});
		_experiment = null;
	}
}

/** 实验是否激活 */
export function isLabActive(): boolean {
	return _experiment !== null;
}

// ── 压缩记录（回退检测 + record 归因） ───────────────────────────

/**
 * 压缩开始时记录（doCompact 调用 compact() 前）。
 * leafBefore/leafAfter 用于回退检测；profileId 用于 record 归因。
 */
export function markCompactStart(
	_ctx: ExtensionContext,
	profileId: string,
	leafBefore: string | null,
	source: 'auto' | 'manual' = 'auto',
): void {
	if (!_experiment) return;
	_recentCompact = {
		timestamp: Date.now(),
		leafBefore,
		leafAfter: null,
		source,
		profileId,
	};
	_processReported = false;
	_rollbackReported = false;
}

/** 压缩完成后补充 leafAfter */
export function markCompactEnd(_ctx: ExtensionContext, leafAfter: string | null): void {
	if (!_recentCompact) return;
	_recentCompact.leafAfter = leafAfter;
}

/**
 * 压缩失败时清除最近压缩记录（onError 调用）。
 * 失败不产生可归因信号：保留 leafAfter=null 的记录会让 detectRollback 把
 * 「压缩后 leaf 未推进」误判为用户回退不满（satisfaction=0 污染数据）。
 */
export function clearRecentCompact(): void {
	_recentCompact = null;
	_rollbackReported = false;
}

/** 清理状态（会话关闭 / 重载） */
export function resetLabState(): void {
	_recentCompact = null;
	_processReported = false;
	_rollbackReported = false;
}

// ── record：armId = 生效 profile id ─────────────────────────────

/** 缓存当前模型（record 归因 context 用，与 select 的 contextKey 提取格式一致） */
export function rememberModel(model?: { provider?: string; id?: string }): void {
	_lastCtxModel =
		model?.provider && model?.id ? { provider: model.provider, id: model.id } : undefined;
}

/** 对 profile-satisfaction 实验 record 一次（armId = 最近压缩的 profile id） */
async function recordAll(metrics: Record<string, number>): Promise<void> {
	const profileId = _recentCompact?.profileId;
	if (!_experiment || !profileId) return;
	const ctx = _lastCtxModel ? { model: _lastCtxModel } : undefined;
	try {
		await _experiment.record(profileId, { metrics }, ctx);
		log.debug('Recorded to profile', profileId, metrics);
	} catch (err) {
		log.warn('Failed to record to profile', {
			profileId,
			error: err instanceof Error ? err.message : String(err),
		});
	}
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

// ── 回退信号检测（agent_end 调用） ───────────────────────────────

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
 *
 * @param ctx          扩展上下文（保留签名兼容）
 * @param currentLeafId 当前 leaf id（调用方从 sessionManager.getLeafId() 获取）
 * @param ancestorChain 当前 leaf 的祖先链（含自身，leaf → ... → root），由调用方构建
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

/** 查询实验状态（当前 profile + 样本量）。实验不可用时返回 { active: false } */
export async function getLabStatus(): Promise<LabStatus> {
	if (!_experiment) return { active: false, experiments: [] };

	try {
		const info = _experiment.info();
		const stats = await _experiment.stats();
		const totalCalls = Object.values(stats).reduce((n, a) => n + a.totalCalls, 0);
		const experiments: LabStatus['experiments'] = [
			{
				key: 'profile',
				name: info.name,
				strategy: info.strategy,
				forceArmId: info.forceArmId,
				currentArm: _recentCompact?.profileId ?? '(未压缩)',
				totalCalls,
			},
		];
		return { active: true, experiments };
	} catch (err) {
		log.warn('Failed to query experiment profile-satisfaction', {
			error: err instanceof Error ? err.message : String(err),
		});
		return { active: false, experiments: [] };
	}
}
