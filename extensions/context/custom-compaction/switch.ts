/**
 * 自动切换 profile — 接口骨架（本次仅接口设计，不实现）。
 *
 * 设计原则：
 *  - 实验臂 = profile：显示/感知/运作三者一致，无运行时静默覆盖。
 *  - 信号源弱依赖：SwitchSignalProvider 缺失时 sample 返回 null 自然降级。
 *  - 手动激活优先：ProfileSource = 'manual' 的 profile 不被自动切换覆盖。
 *  - 触发时机：agent_end、压缩判断之前。
 *
 * 完整决策记录见 docs/adr/0021-custom-compaction-auto-switch.md
 */

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

// ── 信号源 ──────────────────────────────────────────────────────

/** 信号样本：provider 采样返回的任意载荷，由 decider 解释语义 */
export interface SignalSample {
	[key: string]: unknown;
}

/**
 * 自动切换信号源（弱依赖）。
 * 首批 provider（本次不实现）：
 *  - 'lab-stats'          ：pi-lab 的 profile 满意度统计
 *  - 'session-complexity' ：pi-session-tree 的会话复杂度（analyzeComplexity）
 */
export interface SwitchSignalProvider {
	/** 唯一 id，对应 signals map 的 key */
	id: string;
	/** 采样当前值；不可用返回 null（降级） */
	sample(ctx: ExtensionContext): Promise<SignalSample | null>;
}

// ── 决策器 ──────────────────────────────────────────────────────

/**
 * 自动切换决策器（单接口可替换，核心当调度器）。
 * 本次不实现具体策略。
 */
export interface ProfileSwitchDecider {
	/**
	 * 根据信号决定是否切换 profile。
	 * @param signals key = provider id
	 * @returns null = 不切换；否则返回切换目标 + 理由
	 */
	decide(
		ctx: ExtensionContext,
		signals: Record<string, SignalSample>,
	): Promise<SwitchDecision | null>;
}

/** 切换决策：切到哪个 profile + 理由（用于 UI 通知/日志） */
export interface SwitchDecision {
	toProfileId: string;
	reason: string;
}

// ── 生效 profile 来源 ──────────────────────────────────────────

/**
 * 生效 profile 的来源（运行时状态，不持久化）。
 *  - 'manual'     ：用户面板手动激活（锁定，decider 不得覆盖）
 *  - 'matchModel' ：模型匹配选中（decider 可切）
 *  - 'auto'       ：decider 自动切换（decider 可再切）
 */
export type ProfileSource = 'manual' | 'matchModel' | 'auto';

// ── 自动切换开关 ────────────────────────────────────────────────

/**
 * 自动切换开关（分层：session > project > user，复用 pi-config 三层机制）。
 * 默认全关（enabled = false）。
 * 本次仅声明类型，不接入 CompactionConfig。
 */
export interface AutoSwitchConfig {
	/** 是否启用自动切换（默认 false） */
	enabled: boolean;
}
