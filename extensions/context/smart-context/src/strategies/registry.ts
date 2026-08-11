/**
 * smart-context — 路由策略接口 + 注册表
 *
 * 每个策略实现 RoutingStrategy 接口，
 * 在策略注册表中按 armId 索引。
 */

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { PickDecision } from '../router.js';

// ── SessionSignals ──────────────────────────────────────────────────

/** D1-D4 全维度会话信号 */
export interface SessionSignals {
	// D1: turn-local
	promptLength: number;
	promptCodeBlocks: number;
	promptFileRefs: number;
	contextTokens: number | null;
	contextPercent: number | null;

	// D2: session tree
	branchCount: number;
	checkpointCount: number;
	compactionCount: number;
	toolDistribution: Record<string, number>;
	toolErrorRate: number;
	isRetry: boolean;

	// D3: project profile
	projectDocScore: number; // 0-100
	agentsMdSize: number;
	readmeMdSize: number;

	// D4: session progress
	commitCount: number;
	labelCount: number;
	userEngagementScore: number; // 0-100
}

// ── Strategy ────────────────────────────────────────────────────────

/** 路由策略接口 */
export interface RoutingStrategy {
	/** 策略名（= armId） */
	name: string;

	/**
	 * 决定当前 turn 的路由决策。
	 * @param prompt 用户输入文本
	 * @param ctx Pi 扩展上下文
	 * @param signals 聚合的会话信号
	 * @returns 路由决策，或 null 表示不切换
	 */
	decide(
		prompt: string,
		ctx: ExtensionContext,
		signals: SessionSignals,
	): Promise<PickDecision | null>;
}

// ── Registry ────────────────────────────────────────────────────────

/** 策略注册表，按 armId 索引 */
export class StrategyRegistry {
	private strategies = new Map<string, RoutingStrategy>();

	register(strategy: RoutingStrategy): void {
		this.strategies.set(strategy.name, strategy);
	}

	get(armId: string): RoutingStrategy | undefined {
		return this.strategies.get(armId);
	}

	getAll(): RoutingStrategy[] {
		return Array.from(this.strategies.values());
	}

	getArmIds(): string[] {
		return Array.from(this.strategies.keys());
	}
}
