/**
 * smart-context 路由策略 — 单元测试
 *
 * 策略逻辑内联测试（vitest 无法跨目录 import extension 源码）。
 * 测试通过后，在 extensions/context/smart-context/src/strategies/ 下实现。
 */
import { describe, it, expect } from 'vitest';

// ============================================================================
// Types (mirrors strategies/registry.ts)
// ============================================================================

type Complexity = 'trivial' | 'simple' | 'medium' | 'complex';

interface ModelRef {
	provider: string;
	model: string;
}

interface SessionSignals {
	promptLength: number;
	promptCodeBlocks: number;
	promptFileRefs: number;
	contextTokens: number | null;
	contextPercent: number | null;
	branchCount: number;
	checkpointCount: number;
	compactionCount: number;
	toolDistribution: Record<string, number>;
	toolErrorRate: number;
	isRetry: boolean;
	projectDocScore: number;
	agentsMdSize: number;
	readmeMdSize: number;
	commitCount: number;
	labelCount: number;
	userEngagementScore: number;
}

interface PickDecision {
	model: ModelRef;
	reason: string;
	detail: string;
}

// ============================================================================
// Mock helpers
// ============================================================================

function baseSignals(overrides: Partial<SessionSignals> = {}): SessionSignals {
	return {
		promptLength: 100,
		promptCodeBlocks: 0,
		promptFileRefs: 0,
		contextTokens: 100000,
		contextPercent: 50,
		branchCount: 0,
		checkpointCount: 0,
		compactionCount: 0,
		toolDistribution: {},
		toolErrorRate: 0,
		isRetry: false,
		projectDocScore: 50,
		agentsMdSize: 1000,
		readmeMdSize: 500,
		commitCount: 0,
		labelCount: 0,
		userEngagementScore: 0,
		...overrides,
	};
}

const DEFAULT_PROFILE: Record<Complexity, ModelRef> = {
	trivial: { provider: 'deepseek', model: 'deepseek-v4-flash' },
	simple: { provider: 'deepseek', model: 'deepseek-v4-flash' },
	medium: { provider: 'deepseek', model: 'deepseek-v4-pro' },
	complex: { provider: 'deepseek', model: 'deepseek-v4-pro' },
};

// ============================================================================
// Strategy: tree-escalation（内联实现）
// ============================================================================

const COMPLEXITY_ORDER: Complexity[] = ['trivial', 'simple', 'medium', 'complex'];

function escalate(current: Complexity, target: Complexity): Complexity {
	const ci = COMPLEXITY_ORDER.indexOf(current);
	const ti = COMPLEXITY_ORDER.indexOf(target);
	return COMPLEXITY_ORDER[Math.max(ci, ti)];
}

function treeEscalationDecide(_prompt: string, signals: SessionSignals): PickDecision | null {
	let complexity: Complexity = 'simple';

	if (signals.branchCount >= 3) complexity = escalate(complexity, 'medium');
	if (signals.checkpointCount >= 3) complexity = escalate(complexity, 'medium');
	if (signals.compactionCount >= 2) complexity = escalate(complexity, 'medium');
	if (signals.isRetry && signals.branchCount >= 2) complexity = escalate(complexity, 'medium');
	if (signals.contextPercent !== null && signals.contextPercent > 70)
		complexity = escalate(complexity, 'medium');

	if (complexity === 'simple') return null;

	return {
		model: DEFAULT_PROFILE[complexity],
		reason: 'classifier',
		detail: `tree-escalation: complexity=${complexity} branch=${signals.branchCount} cp=${signals.checkpointCount}`,
	};
}

// ============================================================================
// Strategy: pure-signals（内联实现）
// ============================================================================

function pureSignalsDecide(_prompt: string, signals: SessionSignals): PickDecision | null {
	let score = 0;
	score += signals.branchCount * 15;
	score += signals.checkpointCount * 10;
	score += signals.compactionCount * 20;
	score += signals.toolErrorRate * 25;
	score += signals.isRetry ? 30 : 0;
	score -= signals.projectDocScore * 0.3;
	score -= signals.userEngagementScore * 0.2;

	let complexity: Complexity;
	if (score >= 50) complexity = 'complex';
	else if (score >= 20) complexity = 'medium';
	else complexity = 'simple';

	if (complexity === 'simple') return null;

	return {
		model: DEFAULT_PROFILE[complexity],
		reason: 'heuristic',
		detail: `pure-signals: score=${score.toFixed(0)} complexity=${complexity}`,
	};
}

// ============================================================================
// Strategy: conservative（内联实现）
// ============================================================================

function conservativeDecide(_prompt: string, signals: SessionSignals): PickDecision | null {
	// 至少 2 个树信号同时触发才升级
	let triggers = 0;
	if (signals.branchCount >= 4) triggers++;
	if (signals.checkpointCount >= 3) triggers++;
	if (signals.compactionCount >= 2) triggers++;
	if (signals.isRetry) triggers++;
	if (signals.contextPercent !== null && signals.contextPercent > 80) triggers++;

	if (triggers < 2) return null; // 不够触发 → 保持 flash

	return {
		model: DEFAULT_PROFILE['medium'],
		reason: 'heuristic',
		detail: `conservative: ${triggers} triggers → medium`,
	};
}

// ============================================================================
// Strategy: project-first（内联实现）
// ============================================================================

function projectFirstDecide(_prompt: string, signals: SessionSignals): PickDecision | null {
	// 工程文档完善度决定基线
	let baseline: Complexity;
	if (signals.projectDocScore < 20) baseline = 'medium';
	else if (signals.projectDocScore < 50) baseline = 'simple';
	else baseline = 'trivial';

	// 树信号兜底
	if (signals.branchCount >= 5) baseline = escalate(baseline, 'complex');
	if (signals.isRetry) baseline = escalate(baseline, 'medium');

	if (baseline === 'trivial' || baseline === 'simple') return null;

	return {
		model: DEFAULT_PROFILE[baseline],
		reason: 'heuristic',
		detail: `project-first: docScore=${signals.projectDocScore} baseline=${baseline}`,
	};
}

// ============================================================================
// Tests
// ============================================================================

describe('treeEscalationStrategy', () => {
	it('returns null for normal session', () => {
		expect(treeEscalationDecide('hi', baseSignals())).toBeNull();
	});

	it('escalates with branchCount >= 3', () => {
		const r = treeEscalationDecide('hi', baseSignals({ branchCount: 3 }));
		expect(r).not.toBeNull();
		expect(r!.detail).toContain('medium');
	});

	it('escalates with compactionCount >= 2', () => {
		const r = treeEscalationDecide('hi', baseSignals({ compactionCount: 2 }));
		expect(r).not.toBeNull();
	});

	it('escalates with isRetry + branchCount', () => {
		const r = treeEscalationDecide('hi', baseSignals({ isRetry: true, branchCount: 2 }));
		expect(r).not.toBeNull();
	});

	it('escalates with context pressure', () => {
		const r = treeEscalationDecide('hi', baseSignals({ contextPercent: 85 }));
		expect(r).not.toBeNull();
	});
});

describe('pureSignalsStrategy', () => {
	it('returns null for low-signal session', () => {
		expect(pureSignalsDecide('hi', baseSignals())).toBeNull();
	});

	it('scores high with many branches', () => {
		const r = pureSignalsDecide(
			'hi',
			baseSignals({ branchCount: 3, compactionCount: 2, isRetry: true }),
		);
		expect(r).not.toBeNull();
		expect(r!.detail).toContain('pure-signals');
	});

	it('scores low with good docs and engagement', () => {
		const r = pureSignalsDecide(
			'hi',
			baseSignals({
				projectDocScore: 80,
				userEngagementScore: 50,
				branchCount: 1,
			}),
		);
		expect(r).toBeNull();
	});

	it('upgrades to complex for very high score', () => {
		const r = pureSignalsDecide(
			'hi',
			baseSignals({
				branchCount: 5,
				compactionCount: 3,
				isRetry: true,
				toolErrorRate: 0.5,
			}),
		);
		expect(r).not.toBeNull();
		expect(r!.detail).toContain('complex');
	});
});

describe('conservativeStrategy', () => {
	it('returns null with only 1 trigger', () => {
		const r = conservativeDecide('hi', baseSignals({ branchCount: 4 }));
		expect(r).toBeNull();
	});

	it('upgrades with 2+ triggers', () => {
		const r = conservativeDecide('hi', baseSignals({ branchCount: 4, isRetry: true }));
		expect(r).not.toBeNull();
		expect(r!.detail).toContain('conservative');
	});

	it('upgrades with context pressure + compaction', () => {
		const r = conservativeDecide('hi', baseSignals({ contextPercent: 85, compactionCount: 2 }));
		expect(r).not.toBeNull();
	});
});

describe('projectFirstStrategy', () => {
	it('returns null for well-documented project', () => {
		const r = projectFirstDecide('hi', baseSignals({ projectDocScore: 60 }));
		expect(r).toBeNull();
	});

	it('uses medium baseline for sparse docs', () => {
		const r = projectFirstDecide('hi', baseSignals({ projectDocScore: 10 }));
		expect(r).not.toBeNull();
		expect(r!.detail).toContain('medium');
	});

	it('escalates to complex when many branches', () => {
		const r = projectFirstDecide('hi', baseSignals({ projectDocScore: 40, branchCount: 5 }));
		expect(r).not.toBeNull();
		expect(r!.detail).toContain('complex');
	});

	it('escalates on retry', () => {
		const r = projectFirstDecide('hi', baseSignals({ projectDocScore: 40, isRetry: true }));
		expect(r).not.toBeNull();
		expect(r!.detail).toContain('medium');
	});
});

describe('strategy differentiation', () => {
	const highStress = baseSignals({
		branchCount: 3,
		compactionCount: 1,
		contextPercent: 72,
	});

	it('tree-escalation upgrades while conservative stays', () => {
		const te = treeEscalationDecide('hi', highStress);
		const cv = conservativeDecide('hi', highStress);
		// tree-escalation should upgrade (branch >= 3 or context > 70)
		// conservative should not (only 1-2 triggers, need >= 2)
		expect(te).not.toBeNull();
		expect(cv).toBeNull();
	});

	it('project-first and tree-escalation diverge on doc-poor project', () => {
		const sigs = baseSignals({ projectDocScore: 10, branchCount: 1 });
		const pf = projectFirstDecide('hi', sigs);
		const te = treeEscalationDecide('hi', sigs);
		// project-first should upgrade (poor docs)
		// tree-escalation should not (branch < 3)
		expect(pf).not.toBeNull();
		expect(te).toBeNull();
	});
});
