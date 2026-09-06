/**
 * pi-lab 实验接入：compression-aggression（压缩维度 A）
 *
 * 臂 = balanced / aggressive（pipeline.ts 的 BALANCED_PROFILE / AGGRESSIVE_PROFILE）。
 * 形态：select 型（stable-hash 按会话分流），窗口充足时随机分流；
 * 安全阀（C 方案）：窗口紧张（小窗口模型或高用量）时不进实验，走原逻辑强制 aggressive。
 *
 * 信号：
 *  - saved_chars（maximize）：压缩节省的字符数，compress 完成后 record（仅 saved > 0 时）
 *  - recover_context_calls（minimize）：agent 调用 recover_context 恢复原文的次数，
 *    压缩过度丢关键信息的直接负信号，recover_context 工具 execute 时 record
 *  - 回退信号：第二版（依赖 pi-session-tree detectDiverge 原语）
 *
 * 弱依赖（方案 A）：globalThis.__labApi 桥接，pi-lab 缺失时自然降级。
 * 注册在 session_start（消除加载顺序竞险）。
 */

import { createLogger } from '@zenone/pi-logger';
import { profileForArm } from './compression/pipeline.js';
import type { AggressionProfile } from './compression/pipeline.js';

const log = createLogger('smart-context:lab');

// ── 观测指标 ────────────────────────────────────────────────────

const EXPERIMENT_METRICS = [
	{
		id: 'saved_chars',
		type: 'continuous',
		direction: 'maximize',
		description: '压缩节省的字符数（越大越好）',
	},
	{
		id: 'recover_context_calls',
		type: 'count',
		direction: 'minimize',
		description: 'agent 调用 recover_context 恢复原文的次数（压缩过度信号，越小越好）',
	},
] as const;

// ── pi-lab ExperimentAPI 最小接口（鸭子类型，弱依赖不需要真实类型）──

interface LabExperiment {
	select: (context?: unknown) => Promise<string>;
	record: (
		armId: string,
		outcome: { metrics: Record<string, number> },
		context?: unknown,
	) => Promise<void>;
	info: () => { name: string; strategy: string; forceArmId: string | null };
}

interface LabManager {
	__labApi?: {
		getExperimentManager?: () => {
			registerWeakExperiment: (def: unknown) => LabExperiment | undefined;
		};
	};
}

/** 实验接入所需的最小上下文（弱依赖，结构兼容 ExtensionContext） */
export interface LabCtx {
	model?: { provider?: string; id?: string };
	sessionManager?: { getSessionId?: () => string };
}

// ── 模块状态 ────────────────────────────────────────────────────

let _experiment: LabExperiment | null = null;
/** 最近一次压缩的 armId（recover_context_calls 归因用） */
let _recentArm: string | null = null;
/** 缓存最近模型（record 归因 context 用，与 select 的 contextKey 提取格式一致） */
let _lastCtxModel: { provider: string; id: string } | undefined;

// ── 注册（session_start 调用）────────────────────────────────────

export function initExperiments(ctx: LabCtx): void {
	rememberModel(ctx.model);
	// 每次 session_start 重置上一会话的臂归因，避免 recover_context 信号
	// 在同一进程连续会话时错误归因到旧的实验臂（污染统计）。
	_recentArm = null;

	// SAFETY: globalThis.__labApi 由 pi-lab 扩展在加载时挂载（形状见 LabManager 鸭子类型），
	// 此处经 unknown 桥接访问以保持弱依赖（不 import pi-lab 包）；缺失时下方判空降级。
	const mgr = (globalThis as unknown as LabManager).__labApi?.getExperimentManager?.();
	if (!mgr) {
		log.warn('pi-lab not available — smart-context running without compression experiment');
		_experiment = null;
		return;
	}

	try {
		const exp = mgr.registerWeakExperiment({
			owner: 'smart-context',
			name: 'compression-aggression',
			// 分组键 = 模型（分析按模型分层，控制模型效应混杂）
			contextKey: (c: LabCtx) =>
				`${c.model?.provider ?? 'unknown'}:${c.model?.id ?? 'unknown'}`,
			// 分流键 = 会话（跨模型分布的稳定单元）：同一会话稳定同一臂，
			// 不同会话即使同模型也会 hash 到不同臂，消除「臂=模型」混杂
			assignKey: (c: LabCtx) => c.sessionManager?.getSessionId?.() ?? 'unknown-session',
			arms: [
				{ id: 'balanced', label: '平衡压缩' },
				{ id: 'aggressive', label: '激进压缩' },
			],
			metrics: EXPERIMENT_METRICS,
			strategy: 'stable-hash',
		});
		_experiment = exp ?? null;
		if (exp) {
			log.info('Experiment registered: smart-context/compression-aggression');
		} else {
			log.warn('Experiment registration blocked (name conflict): compression-aggression');
		}
	} catch (err) {
		log.warn('Failed to register compression-aggression', {
			error: err instanceof Error ? err.message : String(err),
		});
		_experiment = null;
	}
}

// ── 选臂（compress 前调用）──────────────────────────────────────

export interface ArmSelection {
	armId: 'balanced' | 'aggressive';
	/** 是否进入实验（窗口紧张或无实验时为 false，不 record） */
	inExperiment: boolean;
}

/**
 * 决定本次压缩用哪个 profile。
 * - 无实验：回退原行为（窗口紧张→aggressive，否则 balanced），不 record
 * - 有实验 + 窗口紧张：强制 aggressive（安全阀），不 record
 * - 有实验 + 窗口充足：select 随机分流，record
 */
export async function selectCompressionArm(
	ctx: LabCtx,
	windowTight: boolean,
): Promise<ArmSelection> {
	rememberModel(ctx.model);
	if (!_experiment) {
		return { armId: windowTight ? 'aggressive' : 'balanced', inExperiment: false };
	}
	if (windowTight) {
		// 安全阀：强制 aggressive 不 record。同时清除最近臂归因——
		// 否则窗口紧张后的 recover_context 会归因到上一次实验臂，污染数据。
		_recentArm = null;
		return { armId: 'aggressive', inExperiment: false };
	}
	let armId: string;
	try {
		armId = await _experiment.select(ctx);
	} catch (err) {
		// select 失败不阻断压缩管线：回退默认 balanced 臂（不 record），
		// 与 recordAll 的容错保持一致，避免 context 事件整体失败。
		log.warn('Failed to select compression arm, falling back to balanced', {
			error: err instanceof Error ? err.message : String(err),
		});
		_recentArm = null;
		return { armId: 'balanced', inExperiment: false };
	}
	const normalized: 'balanced' | 'aggressive' =
		armId === 'aggressive' ? 'aggressive' : 'balanced';
	_recentArm = normalized;
	return { armId: normalized, inExperiment: true };
}

// ── 压缩执行管线（index.ts context 事件的核心逻辑，抽取为可测函数）──

export interface CompressorLike {
	compress(messages: unknown[], ctx: unknown, profile?: AggressionProfile): Promise<unknown[]>;
}

export interface CompressionRunResult {
	messages: unknown[];
	armId: 'balanced' | 'aggressive';
	inExperiment: boolean;
	saved: number;
	before: number;
	after: number;
}

/**
 * 压缩决策 → 执行 → 上报 一体化管线：
 *   1. selectCompressionArm 分臂（窗口紧张走安全阀，不 record）
 *   2. profileForArm 映射臂 → profile
 *   3. compressor.compress 执行（注入 profileOverride）
 *   4. saved > 0 且 inExperiment 时 record saved_chars
 * 抽取为纯函数使集成点可在 vitest 中用 mock compressor 完整覆盖。
 */
export async function runCompressionWithExperiment(
	compressor: CompressorLike,
	messages: unknown[],
	ctx: LabCtx,
	windowTight: boolean,
): Promise<CompressionRunResult> {
	const before = JSON.stringify(messages).length;
	const arm = await selectCompressionArm(ctx, windowTight);
	const profile = profileForArm(arm.armId);
	const compressed = await compressor.compress(messages, ctx, profile);
	const after = JSON.stringify(compressed).length;
	const saved = Math.max(0, before - after);
	if (saved > 0 && arm.inExperiment) {
		await recordSavedChars(arm.armId, saved);
	}
	return {
		messages: compressed,
		armId: arm.armId,
		inExperiment: arm.inExperiment,
		saved,
		before,
		after,
	};
}

// ── record ──────────────────────────────────────────────────────

/** record 的 context：只需 model（contextKey fn 提取分桶键用） */
function contextFor(): { model: { provider: string; id: string } } | undefined {
	return _lastCtxModel ? { model: _lastCtxModel } : undefined;
}

async function recordAll(armId: string, metrics: Record<string, number>): Promise<void> {
	if (!_experiment) return;
	try {
		await _experiment.record(armId, { metrics }, contextFor());
		log.debug('Recorded to compression-aggression', { armId, ...metrics });
	} catch (err) {
		log.warn('Failed to record to compression-aggression', {
			armId,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/** 压缩完成后上报 saved_chars（JSON 字符数差，非 token 数） */
export async function recordSavedChars(armId: string, savedChars: number): Promise<void> {
	await recordAll(armId, { saved_chars: savedChars });
}

/** recover_context 工具被调用时上报（归因到最近一次压缩的 arm） */
export async function recordRecoverContext(): Promise<void> {
	if (!_recentArm) return;
	await recordAll(_recentArm, { recover_context_calls: 1 });
}

/** 实验是否激活 */
export function isLabActive(): boolean {
	return _experiment !== null;
}

/** 清理模块状态（会话关闭 / 重载 / 测试隔离） */
export function resetLabState(): void {
	_experiment = null;
	_recentArm = null;
	_lastCtxModel = undefined;
}

// ── 内部 ────────────────────────────────────────────────────────

function rememberModel(model?: { provider?: string; id?: string }): void {
	_lastCtxModel =
		model?.provider && model?.id ? { provider: model.provider, id: model.id } : undefined;
}
