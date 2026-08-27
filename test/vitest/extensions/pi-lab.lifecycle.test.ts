/**
 * pi-lab lifecycle 信号源 — Vitest tests
 *
 * Covers:
 *   - extractLifecycleDelta：从 __lifecycle__ 事件投影通用指标增量
 *   - TurnAttributor：turn 级归因（select 登记 + turn_end flush + 共享观测）
 */
import { describe, it, expect } from 'vitest';
import {
	LIFECYCLE_METRIC_DEFS,
	extractLifecycleDelta,
	injectLifecycleMetrics,
	TurnAttributor,
	zeroDelta,
} from '../../../extensions/meta/pi-lab/core/lifecycle.js';

describe('LIFECYCLE_METRIC_DEFS', () => {
	it('declares the three generic metrics with tool_/turn_ prefix', () => {
		const ids = LIFECYCLE_METRIC_DEFS.map((m) => m.id);
		expect(ids).toEqual(['tool_error_rate', 'tool_latency_ms', 'turn_token_usage']);
		// 前缀隔离：不与插件自声明 metric（如 latency_ms）撞名
		for (const m of LIFECYCLE_METRIC_DEFS) {
			expect(m.id.startsWith('tool_') || m.id.startsWith('turn_')).toBe(true);
		}
	});
});

describe('extractLifecycleDelta', () => {
	it('returns null for non-lifecycle source', () => {
		expect(extractLifecycleDelta({ source: 'edit', details: {} })).toBeNull();
	});

	it('returns null for missing details', () => {
		expect(extractLifecycleDelta({ source: '__lifecycle__' })).toBeNull();
	});

	it('projects tool_execution_end (error) into tool delta', () => {
		const delta = extractLifecycleDelta({
			source: '__lifecycle__',
			details: { toolCallId: 't1', duration: 42, isError: true },
		});
		expect(delta).toEqual({
			toolErrorCount: 1,
			toolCallCount: 1,
			toolLatencySum: 42,
			tokenSum: 0,
		});
	});

	it('projects tool_execution_end (success) with zero error', () => {
		const delta = extractLifecycleDelta({
			source: '__lifecycle__',
			details: { duration: 10, isError: false },
		});
		expect(delta).toEqual({
			toolErrorCount: 0,
			toolCallCount: 1,
			toolLatencySum: 10,
			tokenSum: 0,
		});
	});

	it('projects message_end usage.totalTokens', () => {
		const delta = extractLifecycleDelta({
			source: '__lifecycle__',
			details: { role: 'assistant', usage: { totalTokens: 1234 } },
		});
		expect(delta).toEqual({
			toolErrorCount: 0,
			toolCallCount: 0,
			toolLatencySum: 0,
			tokenSum: 1234,
		});
	});

	it('projects message_end usage split into input+output', () => {
		const delta = extractLifecycleDelta({
			source: '__lifecycle__',
			details: { usage: { inputTokens: 100, outputTokens: 200 } },
		});
		expect(delta!.tokenSum).toBe(300);
	});

	it('returns null for irrelevant details', () => {
		expect(
			extractLifecycleDelta({ source: '__lifecycle__', details: { turnIndex: 1 } }),
		).toBeNull();
	});
});

describe('TurnAttributor', () => {
	it('returns empty when no arm selected', () => {
		const a = new TurnAttributor();
		a.startTurn('turn-1');
		expect(a.endTurn()).toEqual([]);
	});

	it('flushes aggregated metrics to the active arm', () => {
		const a = new TurnAttributor();
		a.startTurn('turn-1');
		a.noteSelect('edit:edit-strategy', 'classic');
		a.noteLifecycle({
			toolErrorCount: 1,
			toolCallCount: 4,
			toolLatencySum: 200,
			tokenSum: 5000,
		});
		const results = a.endTurn();
		expect(results).toHaveLength(1);
		expect(results[0].experimentName).toBe('edit:edit-strategy');
		expect(results[0].armId).toBe('classic');
		expect(results[0].metrics).toEqual({
			tool_error_rate: 0.25,
			tool_latency_ms: 200,
			turn_token_usage: 5000,
		});
		expect(results[0].metadata.turnId).toBe('turn-1');
	});

	it('shared observation: same metrics flushed to each active experiment arm', () => {
		const a = new TurnAttributor();
		a.startTurn('turn-2');
		a.noteSelect('edit:edit-strategy', 'row-script');
		a.noteSelect('custom-compaction:profile-satisfaction', 'default');
		a.noteLifecycle({
			toolErrorCount: 0,
			toolCallCount: 2,
			toolLatencySum: 80,
			tokenSum: 1000,
		});
		const results = a.endTurn();
		expect(results).toHaveLength(2);
		expect(results.map((r: { armId: string }) => r.armId).sort()).toEqual([
			'default',
			'row-script',
		]);
		// 共享观测：两份事件 metrics 相同，允许跨实验重复归因
		expect(results[0].metrics.turn_token_usage).toBe(1000);
		expect(results[1].metrics.turn_token_usage).toBe(1000);
	});

	it('later select overrides earlier arm for same experiment', () => {
		const a = new TurnAttributor();
		a.startTurn();
		a.noteSelect('exp', 'arm-a');
		a.noteSelect('exp', 'arm-b');
		const results = a.endTurn();
		expect(results).toHaveLength(1);
		expect(results[0].armId).toBe('arm-b');
	});

	it('zero call count yields zero error rate', () => {
		const a = new TurnAttributor();
		a.startTurn();
		a.noteSelect('exp', 'arm');
		const results = a.endTurn();
		expect(results[0].metrics.tool_error_rate).toBe(0);
	});

	it('startTurn resets prior state', () => {
		const a = new TurnAttributor();
		a.startTurn('t1');
		a.noteSelect('exp', 'arm');
		a.noteLifecycle({ toolErrorCount: 1, toolCallCount: 1, toolLatencySum: 10, tokenSum: 10 });
		a.startTurn('t2');
		expect(a.endTurn()).toEqual([]);
	});

	it('zeroDelta returns all-zero', () => {
		expect(zeroDelta()).toEqual({
			toolErrorCount: 0,
			toolCallCount: 0,
			toolLatencySum: 0,
			tokenSum: 0,
		});
	});
});

describe('injectLifecycleMetrics', () => {
	it('appends generic metrics to declared metrics', () => {
		const declared = [
			{ id: 'match_success', type: 'binary' as const, direction: 'maximize' as const },
		];
		const result = injectLifecycleMetrics(declared);
		expect(result.map((m) => m.id)).toEqual([
			'match_success',
			'tool_error_rate',
			'tool_latency_ms',
			'turn_token_usage',
		]);
	});

	it('does not override an experiment-declared generic metric id', () => {
		const declared = [
			{
				id: 'tool_error_rate',
				type: 'binary' as const,
				direction: 'maximize' as const,
				description: 'custom',
			},
		];
		const result = injectLifecycleMetrics(declared);
		expect(result).toHaveLength(3);
		// 保留实验自声明版本（binary + 自定义描述），不注入通用版
		expect(result.find((m) => m.id === 'tool_error_rate')!.type).toBe('binary');
		expect(result.find((m) => m.id === 'tool_error_rate')!.description).toBe('custom');
	});

	it('handles undefined metrics (consumer may skip via bridge)', () => {
		const result = injectLifecycleMetrics(undefined);
		expect(result.map((m) => m.id)).toEqual([
			'tool_error_rate',
			'tool_latency_ms',
			'turn_token_usage',
		]);
	});
});
