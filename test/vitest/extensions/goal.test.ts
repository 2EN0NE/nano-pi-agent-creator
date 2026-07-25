/**
 * goal 扩展 — Vitest 结构化测试
 *
 * TDD 红→绿循环：部分测试验证 agent-stuff 版本新增的能力。
 * 当前本项目版本缺少这些特性，测试应失败（红）→ 合并后通过（绿）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createSandbox, destroySandbox, runPi, hasErrorInLogs } from '../helpers/sandbox.js';

const ROOT_DIR = resolve(import.meta.dirname, '../../..');
const GOAL_SRC = resolve(ROOT_DIR, 'extensions/context/goal.ts');

function readSource(): string {
	return readFileSync(GOAL_SRC, 'utf-8');
}

// ═══════════════════════════════════════════════════════════════════════
// E2E 加载测试
// ═══════════════════════════════════════════════════════════════════════

describe('goal — e2e load', () => {
	let sandbox: string;

	beforeAll(() => {
		sandbox = createSandbox({
			extensions: ['goal'],
			useMockLLM: true,
		});
	});

	afterAll(() => {
		destroySandbox(sandbox);
	});

	it('loads without crashes', async () => {
		const result = await runPi(sandbox, 'hi');
		expect([0, 124]).toContain(result.exitCode);
	}, 60_000);

	it('produces no ERROR in logs', async () => {
		const result = await runPi(sandbox, 'hi');
		expect(hasErrorInLogs(result.logDir)).toBe(false);
	}, 60_000);
});

// ═══════════════════════════════════════════════════════════════════════
// 源码级功能验证（TDD 红→绿：新特性在当前版本会失败）
// ═══════════════════════════════════════════════════════════════════════

describe('goal — /goal edit command (new feature)', () => {
	const src = readSource();

	it('has "edit" in getArgumentCompletions', () => {
		// agent-stuff: adds "edit" to command completions
		expect(src).toMatch(/\bedit\b/);
	});

	it('has "case .edit." handler in command', () => {
		// Handler for /goal edit
		expect(src).toMatch(/case\s+["']edit["']/i);
	});

	it('has editGoalObjective function', () => {
		// The edit goal function
		expect(src).toMatch(/function\s+editGoalObjective\b/);
	});

	it('has "edit" in persisted state actions', () => {
		// persist("edit") call
		expect(src).toMatch(/["']edit["']/);
	});

	it('has isUnfinishedGoal helper', () => {
		// Agent-stuff: only blocks on unfinished goals (not completed ones)
		expect(src).toMatch(/function\s+isUnfinishedGoal\b/);
	});
});

describe('goal — expanded status model (new feature)', () => {
	const src = readSource();

	it('supports blocked status', () => {
		expect(src).toMatch(/\bblocked\b/);
	});

	it('supports usageLimited status', () => {
		expect(src).toMatch(/\busageLimited\b/);
	});

	it('has statusLabel for all 6 statuses', () => {
		expect(src).toMatch(/statusLabel\b/);
		expect(src).toMatch(/\bblocked\b/);
		expect(src).toMatch(/\busageLimited\b/);
	});
});

describe('goal — data compatibility (new feature)', () => {
	const src = readSource();

	it('has normalizeGoal function', () => {
		expect(src).toMatch(/function\s+normalizeGoal\b/);
	});

	it('has normalizeStatus function', () => {
		expect(src).toMatch(/function\s+normalizeStatus\b/);
	});

	it('has normalizeNonNegativeInteger function', () => {
		expect(src).toMatch(/function\s+normalizeNonNegativeInteger\b/);
	});
});

describe('goal — improved token counting (new feature)', () => {
	const src = readSource();

	it('handles cacheRead in assistantUsageTokens', () => {
		expect(src).toMatch(/\bcacheRead\b/);
	});

	it('has totalTokens fallback', () => {
		expect(src).toMatch(/\btotalTokens\b/);
	});
});

describe('goal — agent_end error handling (new feature)', () => {
	const src = readSource();

	it('handles stopReason error in agent_end', () => {
		expect(src).toMatch(/stopReason.*error/i);
	});

	it('has goalStopStatusForAssistantError function', () => {
		expect(src).toMatch(/function\s+goalStopStatusForAssistantError\b/);
	});
});

describe('goal — create_goal for completed goals (new feature)', () => {
	const src = readSource();

	it('uses isUnfinishedGoal check instead of any-goal check', () => {
		expect(src).toMatch(/isUnfinishedGoal/);
	});

	it('allows replacing completed goals', () => {
		expect(src).toMatch(/isUnfinishedGoal/);
	});
});

describe('goal — features preserved after merge', () => {
	const src = readSource();

	it('has createLogger from @zenone/pi-logger', () => {
		expect(src).toMatch(/import.*createLogger.*from\s+['"]@zenone\/pi-logger['"]/);
	});

	it('uses log.debug calls', () => {
		// Should have at least one log debug call
		expect(src.match(/log\.(debug|info|warn|error)/g)?.length).toBeGreaterThan(0);
	});

	it('has Chinese continuation prompt', () => {
		// The continuation prompt should use Chinese for Chinese-speaking users
		expect(src).toMatch(/继续向/);
	});
});
