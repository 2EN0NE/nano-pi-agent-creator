/**
 * pi-lab 核心边界测试
 *
 * 覆盖：
 * - ExperimentManager 注册/生命周期/冲突裁决
 * - Experiment select（稳定哈希分流）/record/stats
 * - forceArm 覆盖
 * - JSONL 事件流存储
 * - 稳定哈希分桶 + 权重
 * - Thompson Sampling 行为
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

// ── 辅助：在临时目录模拟 extensions-data 路径 ──

const ORIGINAL_HOME = process.env.HOME;
let tmpHome: string;

function setupTempHome(): void {
	tmpHome = resolve(tmpdir(), `pi-lab-test-${randomUUID()}`);
	mkdirSync(resolve(tmpHome, '.pi', 'agent', 'extensions-data', 'pi-lab'), {
		recursive: true,
	});
	process.env.HOME = tmpHome;
}

function cleanupTempHome(): void {
	process.env.HOME = ORIGINAL_HOME;
	try {
		rmSync(tmpHome, { recursive: true, force: true });
	} catch {
		// ignore
	}
}

// ── 导入被测模块 ──

import { ExperimentManager } from '../../../extensions/meta/pi-lab/core/experiment-manager.js';
import { Experiment } from '../../../extensions/meta/pi-lab/core/experiment.js';
import { ExperimentStorage } from '../../../extensions/meta/pi-lab/core/storage.js';
import { setRNG } from '../../../extensions/meta/pi-lab/core/sampling.js';
import { stableHashAssign } from '../../../extensions/meta/pi-lab/core/allocation.js';
import {
	logExtractor,
	parseSignalLabel,
	tagExtractor,
} from '../../../extensions/meta/pi-lab/core/ingestion.js';

// ── 测试辅助 ──

const BIN = [{ id: 'success', type: 'binary' as const, direction: 'maximize' as const }];

/** LCG 可复现 RNG（用于消除蒙特卡洛采样的 flaky） */
function makeSeededRNG(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 0xffffffff;
	};
}

// ── Test Suite ──

describe('pi-lab: ExperimentManager', () => {
	let manager: ExperimentManager;

	beforeEach(() => {
		setupTempHome();
		manager = new ExperimentManager();
	});

	afterEach(() => {
		cleanupTempHome();
	});

	it('registers an experiment and returns ExperimentAPI', () => {
		const exp = manager.registerExperiment({
			owner: 'test',
			name: 'test-strategy',
			contextKey: () => 'global',
			arms: [
				{ id: 'a', label: 'Arm A' },
				{ id: 'b', label: 'Arm B' },
			],
			metrics: BIN,
		})!;

		expect(exp).toBeDefined();
		expect(typeof exp.select).toBe('function');
		expect(typeof exp.record).toBe('function');
		expect(typeof exp.stats).toBe('function');
		expect(typeof exp.forceArm).toBe('function');
		expect(typeof exp.reset).toBe('function');

		const info = exp.info();
		expect(info.name).toBe('test-strategy');
		expect(info.strategy).toBe('stable-hash');
		expect(info.forceArmId).toBeNull();
	});

	it('select() returns a valid arm ID', async () => {
		const exp = manager.registerExperiment({
			owner: 'test',
			name: 'test-select',
			contextKey: () => 'global',
			arms: [
				{ id: 'x', label: 'X' },
				{ id: 'y', label: 'Y' },
			],
			metrics: BIN,
		})!;

		const arm = await exp.select();
		expect(['x', 'y']).toContain(arm);
	});

	it('forceArm overrides select()', async () => {
		const exp = manager.registerExperiment({
			owner: 'test',
			name: 'test-force',
			contextKey: () => 'global',
			arms: [
				{ id: 'a', label: 'A' },
				{ id: 'b', label: 'B' },
			],
			metrics: BIN,
		})!;

		exp.forceArm('b');
		const arm1 = await exp.select();
		expect(arm1).toBe('b');
		const arm2 = await exp.select();
		expect(arm2).toBe('b');
	});

	it('forceArm(null) restores normal selection', async () => {
		const exp = manager.registerExperiment({
			owner: 'test',
			name: 'test-force-null',
			contextKey: () => 'global',
			arms: [
				{ id: 'a', label: 'A' },
				{ id: 'b', label: 'B' },
			],
			metrics: BIN,
		})!;

		exp.forceArm('a');
		expect(await exp.select()).toBe('a');
		exp.forceArm(null);
		const arm = await exp.select();
		expect(['a', 'b']).toContain(arm);
	});

	it('propagates isAA flag to getInfo', () => {
		manager.registerExperiment({
			owner: 'test',
			name: 'aa-flag',
			contextKey: () => 'global',
			arms: [
				{ id: 'a', label: 'A' },
				{ id: 'b', label: 'B' },
			],
			metrics: BIN,
			isAA: true,
		});
		expect(manager.getExperimentInfo('aa-flag')!.isAA).toBe(true);

		// 未声明 isAA 的实验缺省 false
		manager.registerExperiment({
			owner: 'test',
			name: 'non-aa-flag',
			contextKey: () => 'global',
			arms: [{ id: 'a', label: 'A' }],
			metrics: BIN,
		});
		expect(manager.getExperimentInfo('non-aa-flag')!.isAA).toBe(false);
	});

	it('preserves isAA through definition evolution (updateDef path)', () => {
		manager.registerExperiment({
			owner: 'test',
			name: 'aa-evolve',
			contextKey: () => 'global',
			arms: [{ id: 'a', label: 'A' }],
			metrics: BIN,
			isAA: true,
		});
		// arms 增删触发 definitionDiff.changed → updateDef（须保留 isAA）
		manager.registerExperiment({
			owner: 'test',
			name: 'aa-evolve',
			contextKey: () => 'global',
			arms: [
				{ id: 'a', label: 'A' },
				{ id: 'b', label: 'B' },
			],
			metrics: BIN,
			isAA: true,
		});
		expect(manager.getExperimentInfo('aa-evolve')!.isAA).toBe(true);
	});

	it('select() notifies select observer with experiment name and arm', async () => {
		const observed: Array<[string, string]> = [];
		manager.setSelectObserver((name, armId) => observed.push([name, armId]));

		const exp = manager.registerExperiment({
			owner: 'test',
			name: 'observer-test',
			contextKey: () => 'global',
			arms: [{ id: 'a', label: 'A' }],
			metrics: BIN,
		})!;

		const armId = await exp.select(null);
		expect(observed).toEqual([['observer-test', armId]]);
		expect(armId).toBe('a');
	});

	it('record() 多指标投影为 sum/count', async () => {
		const exp = manager.registerExperiment({
			owner: 'test',
			name: 'test-record',
			contextKey: () => 'global',
			arms: [
				{ id: 'a', label: 'A' },
				{ id: 'b', label: 'B' },
			],
			metrics: BIN,
		})!;

		await exp.record('a', { metrics: { success: 1 } });
		await exp.record('a', { metrics: { success: 1 } });
		await exp.record('b', { metrics: { success: 0 } });

		const stats = await exp.stats();

		expect(stats['a'].totalCalls).toBe(2);
		expect(stats['a'].metrics['success'].sum).toBe(2);
		expect(stats['a'].metrics['success'].count).toBe(2);

		expect(stats['b'].totalCalls).toBe(1);
		expect(stats['b'].metrics['success'].sum).toBe(0);
		expect(stats['b'].metrics['success'].count).toBe(1);
	});

	it('reset() clears all data', async () => {
		const exp = manager.registerExperiment({
			owner: 'test',
			name: 'test-reset',
			contextKey: () => 'global',
			arms: [{ id: 'a', label: 'A' }],
			metrics: BIN,
		})!;

		await exp.record('a', { metrics: { success: 1 } });
		const before = await exp.stats();
		expect(before['a'].totalCalls).toBe(1);

		await exp.reset();
		const after = await exp.stats();
		expect(after['a'].totalCalls).toBe(0);
	});

	it('status transitions correctly', () => {
		expect(manager.status).toBe('off');

		manager.registerExperiment({
			owner: 'test',
			name: 'test-status',
			contextKey: () => 'global',
			arms: [{ id: 'a', label: 'A' }],
			metrics: BIN,
		});
		expect(manager.status).toBe('collecting');
	});

	it('getAllExperiments returns all registered experiments', () => {
		manager.registerExperiment({
			owner: 'test',
			name: 'exp-a',
			contextKey: () => 'k',
			arms: [{ id: 'a1', label: 'A1' }],
			metrics: BIN,
		});
		manager.registerExperiment({
			owner: 'test',
			name: 'exp-b',
			contextKey: () => 'k',
			arms: [{ id: 'b1', label: 'B1' }],
			metrics: BIN,
		});

		const all = manager.getAllExperiments();
		expect(all.length).toBe(2);
		expect(all.map((e) => e.name).sort()).toEqual(['exp-a', 'exp-b']);
		// 每个实验携带 owner（插件名），供面板显示「插件名:实验名」
		expect(all.every((e) => e.owner === 'test')).toBe(true);
		expect(manager.getOwner('exp-a')).toBe('test');
		expect(manager.getOwner('nonexistent')).toBeUndefined();
	});

	// ── 双轨 API + 冲突裁决 ──

	it('registerWeakExperiment returns a valid ExperimentAPI', () => {
		const exp = manager.registerWeakExperiment({
			owner: 'test',
			name: 'weak-exp',
			contextKey: () => 'g',
			arms: [{ id: 'a', label: 'A' }],
			metrics: BIN,
		})!;
		expect(exp).toBeDefined();
		expect(typeof exp.select).toBe('function');
	});

	it('registerStrongExperiment returns a valid ExperimentAPI', () => {
		const exp = manager.registerStrongExperiment({
			owner: 'test',
			name: 'strong-exp',
			contextKey: () => 'g',
			arms: [{ id: 'b', label: 'B' }],
			metrics: BIN,
		})!;
		expect(exp).toBeDefined();
		expect(typeof exp.select).toBe('function');
	});

	// 注册三语义（幂等 / 演进 / 异 owner 硬冲突）完整测试见 pi-lab.registration.test.ts

	it('getAllExperiments includes source info', () => {
		manager.registerStrongExperiment({
			owner: 'test',
			name: 'exp-source-a',
			contextKey: () => 'k',
			arms: [{ id: 'a1', label: 'A1' }],
			metrics: BIN,
		});
		manager.registerWeakExperiment({
			owner: 'test',
			name: 'exp-source-b',
			contextKey: () => 'k',
			arms: [{ id: 'b1', label: 'B1' }],
			metrics: BIN,
		});

		const all = manager.getAllExperiments();
		const a = all.find((e) => e.name === 'exp-source-a');
		const b = all.find((e) => e.name === 'exp-source-b');

		expect(a?.source).toBe('import');
		expect(b?.source).toBe('bridge');
	});

	it('flushConflicts clears the buffer', () => {
		while (manager.getConflicts().length > 0) manager.flushConflicts();

		// 异 owner 撞名 → owner-conflict 事件
		manager.registerWeakExperiment({
			owner: 'owner-a',
			name: 'flush-test',
			contextKey: () => 'g',
			arms: [{ id: 'x', label: 'X' }],
			metrics: BIN,
		});
		manager.registerStrongExperiment({
			owner: 'owner-b',
			name: 'flush-test',
			contextKey: () => 'g',
			arms: [{ id: 'y', label: 'Y' }],
			metrics: BIN,
		});

		expect(manager.getConflicts().length).toBeGreaterThan(0);

		manager.flushConflicts();
		expect(manager.getConflicts().length).toBe(0);
	});

	it('ExperimentAPI select/record/stats 透传 context（函数型 contextKey 生效）', async () => {
		const exp = manager.registerExperiment({
			owner: 'test',
			name: 'api-ctx-key',
			contextKey: (ctx: any) => ctx.model,
			arms: [
				{ id: 'a', label: 'A' },
				{ id: 'b', label: 'B' },
			],
			metrics: BIN,
		})!;

		const arm1 = await exp.select({ model: 'm1' });
		// 同一 model 稳定（stable-hash 确定性）
		expect(await exp.select({ model: 'm1' })).toBe(arm1);

		await exp.record(arm1, { metrics: { success: 1 } }, { model: 'm1' });

		const stats1 = await exp.stats({ model: 'm1' });
		expect(stats1[arm1].totalCalls).toBe(1);

		// 不同 model 无数据（context 透传生效，而非固定 'global'）
		const stats2 = await exp.stats({ model: 'm2' });
		expect(Object.values(stats2).reduce((s, a) => s + a.totalCalls, 0)).toBe(0);
	});

	it('assignKey 与 contextKey 解耦：同会话稳定，不同会话同模型可分到两臂', async () => {
		const exp = manager.registerExperiment({
			owner: 'test',
			name: 'assign-decouple',
			// 分组键 = 模型（分析分层），分流键 = 会话（稳定单元）——两者解耦
			contextKey: (ctx: any) => ctx.model,
			assignKey: (ctx: any) => ctx.session,
			arms: [
				{ id: 'a', label: 'A' },
				{ id: 'b', label: 'B' },
			],
			metrics: BIN,
		})!;

		// 同一会话稳定（分流键确定性）
		const armS1 = await exp.select({ session: 'sess-1', model: 'm1' });
		expect(await exp.select({ session: 'sess-1', model: 'm1' })).toBe(armS1);

		// 不同会话、同一模型 → 分布到两臂（消除「臂=模型」混杂的关键）
		const armsForM1 = new Set<string>();
		for (let i = 0; i < 64; i++) {
			armsForM1.add(await exp.select({ session: `sess-${i}`, model: 'm1' }));
		}
		expect(armsForM1.size).toBe(2);

		// record 仍按 contextKey（模型）分桶：同一模型下两臂样本可对比
		await exp.record('a', { metrics: { success: 1 } }, { session: 'sess-x', model: 'm1' });
		await exp.record('b', { metrics: { success: 0 } }, { session: 'sess-y', model: 'm1' });
		const stats = await exp.stats({ model: 'm1' });
		expect(stats.a.totalCalls).toBe(1);
		expect(stats.b.totalCalls).toBe(1);
	});

	it('缺省 assignKey 时回退 contextKey（向后兼容：contextKey 兼作分流键）', async () => {
		const exp = manager.registerExperiment({
			owner: 'test',
			name: 'assign-default',
			contextKey: (ctx: any) => ctx.model,
			arms: [
				{ id: 'a', label: 'A' },
				{ id: 'b', label: 'B' },
			],
			metrics: BIN,
		})!;

		// 同模型稳定（旧行为：contextKey 即分流键）
		const armM1 = await exp.select({ model: 'm1' });
		expect(await exp.select({ model: 'm1' })).toBe(armM1);
	});
});

describe('pi-lab: Experiment (standalone)', () => {
	let experiment: Experiment;

	beforeEach(() => {
		setupTempHome();
		experiment = new Experiment(
			'test-exp-b',
			'stable-hash',
			[
				{ id: 'control', label: 'Control' },
				{ id: 'treatment', label: 'Treatment' },
			],
			BIN,
			() => 'global',
		);
	});

	afterEach(() => {
		cleanupTempHome();
	});

	it('select returns valid arm on cold start', async () => {
		const arm = await experiment.select({});
		expect(['control', 'treatment']).toContain(arm);
	});

	it('record 多指标投影为 sum/count', async () => {
		await experiment.record('control', { metrics: { success: 1 } }, {});
		await experiment.record('control', { metrics: { success: 1 } }, {});
		await experiment.record('control', { metrics: { success: 0 } }, {});

		const stats = experiment.stats({});
		expect(stats['control'].metrics['success'].sum).toBe(2);
		expect(stats['control'].metrics['success'].count).toBe(3);
	});

	it('multiple context keys are stored separately', async () => {
		const exp2 = new Experiment(
			'multi-ctx',
			'stable-hash',
			[{ id: 'arm', label: 'Arm' }],
			BIN,
			(ctx: any) => ctx.model,
		);

		await exp2.record('arm', { metrics: { success: 1 } }, { model: 'm1' });
		await exp2.record('arm', { metrics: { success: 0 } }, { model: 'm2' });

		const ctxKeys = exp2.getContextKeys();
		expect(ctxKeys).toContain('m1');
		expect(ctxKeys).toContain('m2');

		const m1Stats = exp2.stats({ model: 'm1' });
		expect(m1Stats['arm'].metrics['success'].sum).toBe(1);

		const m2Stats = exp2.stats({ model: 'm2' });
		expect(m2Stats['arm'].metrics['success'].sum).toBe(0);
	});

	it('queryByCtxKey 按已解析 ctxKey 过滤（不经函数型 contextKey 二次解析）', async () => {
		const exp2 = new Experiment(
			'query-ctx-key',
			'stable-hash',
			[
				{ id: 'a', label: 'A' },
				{ id: 'b', label: 'B' },
			],
			BIN,
			(ctx: any) => ctx.model, // 函数型 contextKey：字符串会被二次解析成 undefined
		);

		await exp2.record('a', { metrics: { success: 1 } }, { model: 'm1' });
		await exp2.record('b', { metrics: { success: 0 } }, { model: 'm1' });

		// 面板 session-tab 路径：直接传已解析的 ctxKey 字符串
		const result = exp2.queryByCtxKey('success', 'm1');
		expect(result.arms).toHaveLength(2);
		expect(result.arms.find((a) => a.armId === 'a')!.n).toBe(1);
		expect(result.arms.find((a) => a.armId === 'b')!.n).toBe(1);
	});

	it('派生指标 weighted-sum 在 query 时投影计算', async () => {
		const exp2 = new Experiment(
			'derived-ws',
			'stable-hash',
			[{ id: 'a', label: 'A' }],
			[
				{ id: 'm1', type: 'binary', direction: 'maximize' },
				{ id: 'm2', type: 'binary', direction: 'maximize' },
				{
					id: 'score',
					type: 'continuous',
					direction: 'maximize',
					derived: {
						kind: 'weighted-sum',
						components: [
							{ metricId: 'm1', weight: 0.7 },
							{ metricId: 'm2', weight: 0.3 },
						],
					},
				},
			],
			() => 'global',
		);

		await exp2.record('a', { metrics: { m1: 1, m2: 0 } }, {});

		const result = exp2.query('score');
		expect(result.arms[0].n).toBe(1);
		// weighted-sum = 1*0.7 + 0*0.3 = 0.7
		expect(result.arms[0].mean).toBeCloseTo(0.7, 5);
	});

	it('派生指标 any-fail 在 query 时投影计算', async () => {
		const exp2 = new Experiment(
			'derived-af',
			'stable-hash',
			[{ id: 'a', label: 'A' }],
			[
				{ id: 'e1', type: 'binary', direction: 'minimize' },
				{ id: 'e2', type: 'binary', direction: 'minimize' },
				{
					id: 'any_error',
					type: 'binary',
					direction: 'minimize',
					derived: {
						kind: 'any-fail',
						components: [{ metricId: 'e1' }, { metricId: 'e2' }],
					},
				},
			],
			() => 'global',
		);

		await exp2.record('a', { metrics: { e1: 1, e2: 0 } }, {}); // e1 失败 → 1
		await exp2.record('a', { metrics: { e1: 0, e2: 0 } }, {}); // 都成功 → 0

		const result = exp2.query('any_error');
		expect(result.arms[0].n).toBe(2);
		// values=[1,0] → Beta 后验 mean = (1+1)/(1+1+1+1) = 0.5
		expect(result.arms[0].mean).toBeCloseTo(0.5, 5);
	});

	it('派生指标在 stats 时投影计算（不再恒为 0）', async () => {
		const exp3 = new Experiment(
			'derived-stats',
			'stable-hash',
			[{ id: 'a', label: 'A' }],
			[
				{ id: 'm1', type: 'binary', direction: 'maximize' },
				{
					id: 'score',
					type: 'continuous',
					direction: 'maximize',
					derived: {
						kind: 'weighted-sum',
						components: [{ metricId: 'm1', weight: 2 }],
					},
				},
			],
			() => 'global',
		);

		await exp3.record('a', { metrics: { m1: 1 } }, {});

		const stats = exp3.stats();
		// weighted-sum = 1*2 = 2，count = 1（与 query 投影一致，不再是 sum=0/count=0）
		expect(stats.a.metrics['score']).toEqual({ sum: 2, count: 1 });
	});
});

describe('pi-lab: ExperimentStorage', () => {
	let storage: ExperimentStorage;
	const expName = 'test-storage';

	beforeEach(() => {
		setupTempHome();
		storage = new ExperimentStorage(expName);
	});

	afterEach(() => {
		cleanupTempHome();
	});

	it('starts empty', () => {
		expect(storage.getEvents()).toEqual([]);
	});

	it('appendEvent 后 getEvents 返回事件', () => {
		storage.appendEvent({ ts: 't1', armId: 'a', ctxKey: 'm1', metrics: { success: 1 } });
		expect(storage.getEvents()).toHaveLength(1);
		expect(storage.getEvents()[0].armId).toBe('a');
	});

	it('persists to JSONL and reloads', async () => {
		storage.appendEvent({ ts: 't1', armId: 'a', ctxKey: 'm1', metrics: { success: 1 } });
		await storage.flush();

		const storage2 = new ExperimentStorage(expName);
		expect(storage2.getEvents()).toHaveLength(1);
		expect(storage2.getEvents()[0].metrics['success']).toBe(1);
	});

	it('reset clears events and file', async () => {
		storage.appendEvent({ ts: 't1', armId: 'a', ctxKey: 'm1', metrics: { success: 1 } });
		await storage.flush();
		await storage.reset();
		expect(storage.getEvents()).toEqual([]);

		const storage2 = new ExperimentStorage(expName);
		expect(storage2.getEvents()).toEqual([]);
	});

	it('flush 增量 append 不重复', async () => {
		storage.appendEvent({ ts: 't1', armId: 'a', ctxKey: 'm1', metrics: { success: 1 } });
		await storage.flush();
		storage.appendEvent({ ts: 't2', armId: 'b', ctxKey: 'm1', metrics: { success: 0 } });
		await storage.flush();

		const storage2 = new ExperimentStorage(expName);
		expect(storage2.getEvents()).toHaveLength(2);
	});

	it('加载时跳过损坏行，保留有效事件', () => {
		const filePath = resolve(
			tmpHome,
			'.pi',
			'agent',
			'extensions-data',
			'pi-lab',
			`${expName}.jsonl`,
		);
		writeFileSync(
			filePath,
			'{"ts":"t1","armId":"a","ctxKey":"m1","metrics":{"success":1}}\n' +
				'{corrupted json line\n' +
				'{"ts":"t2","armId":"b","ctxKey":"m1","metrics":{"success":0}}\n',
			'utf8',
		);
		const loaded = new ExperimentStorage(expName);
		expect(loaded.getEvents()).toHaveLength(2);
		expect(loaded.getEvents()[0].armId).toBe('a');
		expect(loaded.getEvents()[1].armId).toBe('b');
	});

	it('尾部空行与无换行结尾均可正常加载', () => {
		const filePath = resolve(
			tmpHome,
			'.pi',
			'agent',
			'extensions-data',
			'pi-lab',
			`${expName}.jsonl`,
		);
		// 有效行 + 尾部空行
		writeFileSync(
			filePath,
			'{"ts":"t1","armId":"a","ctxKey":"m1","metrics":{"success":1}}\n\n',
			'utf8',
		);
		const loaded = new ExperimentStorage(expName);
		expect(loaded.getEvents()).toHaveLength(1);
		expect(loaded.getEvents()[0].armId).toBe('a');
	});
});

describe('pi-lab: stable hash allocation', () => {
	let manager: ExperimentManager;

	beforeEach(() => {
		setupTempHome();
		manager = new ExperimentManager();
	});

	afterEach(() => {
		cleanupTempHome();
	});

	it('select() 默认稳定：同一上下文键多次选择返回同一 arm', async () => {
		const exp = manager.registerExperiment({
			owner: 'test',
			name: 'stable-default',
			contextKey: () => 'global',
			arms: [
				{ id: 'a', label: 'A' },
				{ id: 'b', label: 'B' },
			],
			metrics: BIN,
		})!;

		const first = await exp.select();
		for (let i = 0; i < 20; i++) {
			expect(await exp.select()).toBe(first);
		}
	});

	it('stableHashAssign 对不同键按权重分配流量', () => {
		const arms = [
			{ id: 'a', label: 'A', weight: 9 },
			{ id: 'b', label: 'B', weight: 1 },
		];
		let aCount = 0;
		const trials = 10000;
		for (let i = 0; i < trials; i++) {
			if (stableHashAssign(`ctx-${i}`, arms) === 'a') aCount++;
		}
		expect(aCount / trials).toBeGreaterThan(0.87);
		expect(aCount / trials).toBeLessThan(0.93);
	});

	it('stableHashAssign 对同一键始终稳定', () => {
		const arms = [
			{ id: 'a', label: 'A' },
			{ id: 'b', label: 'B' },
			{ id: 'c', label: 'C' },
		];
		const first = stableHashAssign('fixed-key', arms);
		for (let i = 0; i < 100; i++) {
			expect(stableHashAssign('fixed-key', arms)).toBe(first);
		}
	});

	it('stableHashAssign 单臂直接返回该臂', () => {
		expect(stableHashAssign('k', [{ id: 'only', label: 'Only' }])).toBe('only');
	});

	it('stableHashAssign 空臂抛错', () => {
		expect(() => stableHashAssign('k', [])).toThrow('无可用实验臂');
	});

	it('stableHashAssign 总权重非正抛错', () => {
		const arms = [
			{ id: 'a', label: 'A', weight: 0 },
			{ id: 'b', label: 'B', weight: 0 },
		];
		expect(() => stableHashAssign('k', arms)).toThrow('实验臂权重总和必须为正');
	});
});

describe('pi-lab: query analysis', () => {
	let manager: ExperimentManager;

	beforeEach(() => {
		setupTempHome();
		manager = new ExperimentManager();
		setRNG(makeSeededRNG(42)); // 固定种子，消除蒙特卡洛采样 flaky
	});

	afterEach(() => {
		setRNG(() => Math.random()); // 恢复默认 RNG，避免影响其他 suite
		cleanupTempHome();
	});

	it('binary metric 返回后验均值与胜出概率', async () => {
		setRNG(makeSeededRNG(42)); // 固定种子，消除蒙特卡洛胜出概率断言的 flaky
		const exp = manager.registerExperiment({
			owner: 'test',
			name: 'query-binary',
			contextKey: () => 'global',
			arms: [
				{ id: 'a', label: 'A' },
				{ id: 'b', label: 'B' },
			],
			metrics: BIN,
		})!;

		// a 成功 3 次，b 失败 3 次
		await exp.record('a', { metrics: { success: 1 } });
		await exp.record('a', { metrics: { success: 1 } });
		await exp.record('a', { metrics: { success: 1 } });
		await exp.record('b', { metrics: { success: 0 } });
		await exp.record('b', { metrics: { success: 0 } });
		await exp.record('b', { metrics: { success: 0 } });

		const result = await exp.query('success');
		expect(result.metricId).toBe('success');
		expect(result.arms).toHaveLength(2);

		const armA = result.arms.find((a) => a.armId === 'a')!;
		const armB = result.arms.find((a) => a.armId === 'b')!;

		// a: α=1+3=4, β=1+0=1, 后验均值 = 4/5 = 0.8
		expect(armA.n).toBe(3);
		expect(armA.mean).toBeCloseTo(0.8, 2);
		// b: α=1, β=4, 后验均值 = 1/5 = 0.2
		expect(armB.mean).toBeCloseTo(0.2, 2);

		// a 胜出概率应显著高
		expect(armA.winProbability).toBeGreaterThan(0.9);
		expect(armB.winProbability).toBeLessThan(0.1);

		// credible interval 应覆盖后验均值
		expect(armA.credibleInterval.low).toBeLessThan(armA.mean);
		expect(armA.credibleInterval.high).toBeGreaterThan(armA.mean);
	});

	it('query 未知 metric 抛错', async () => {
		const exp = manager.registerExperiment({
			owner: 'test',
			name: 'query-unknown',
			contextKey: () => 'global',
			arms: [{ id: 'a', label: 'A' }],
			metrics: BIN,
		})!;

		await expect(exp.query('nope')).rejects.toThrow('未知指标');
	});

	it('guardrail metric 显著恶化时告警', async () => {
		const exp = manager.registerExperiment({
			owner: 'test',
			name: 'query-guardrail',
			contextKey: () => 'global',
			arms: [
				{ id: 'a', label: 'A' },
				{ id: 'b', label: 'B' },
			],
			metrics: [
				{ id: 'error_rate', type: 'binary', direction: 'minimize', isGuardrail: true },
			],
		})!;

		// a 报错率低（success=0 表示无错误），b 报错率高
		for (let i = 0; i < 10; i++) await exp.record('a', { metrics: { error_rate: 0 } });
		for (let i = 0; i < 10; i++) await exp.record('b', { metrics: { error_rate: 1 } });

		const result = await exp.query('error_rate');
		// b 是 guardrail 最差（报错率最高），应触发告警
		const alert = result.guardrailAlert.find((g) => g.armId === 'b');
		expect(alert).toBeDefined();
		expect(alert!.pWorse).toBeGreaterThan(0.95);
	});

	it('count metric 用 Poisson-Gamma 后验均值', async () => {
		const exp = manager.registerExperiment({
			owner: 'test',
			name: 'query-count',
			contextKey: () => 'global',
			arms: [{ id: 'a', label: 'A' }],
			metrics: [{ id: 'retries', type: 'count', direction: 'minimize' }],
		})!;
		// 3 次观测：0, 2, 4 → Σx=6, n=3
		await exp.record('a', { metrics: { retries: 0 } });
		await exp.record('a', { metrics: { retries: 2 } });
		await exp.record('a', { metrics: { retries: 4 } });

		const result = await exp.query('retries');
		const armA = result.arms.find((a) => a.armId === 'a')!;
		expect(armA.n).toBe(3);
		// mean = (1+Σx)/(1+n) = 7/4 = 1.75
		expect(armA.mean).toBeCloseTo(1.75, 5);
	});

	it('continuous metric 用样本均值', async () => {
		const exp = manager.registerExperiment({
			owner: 'test',
			name: 'query-continuous',
			contextKey: () => 'global',
			arms: [{ id: 'a', label: 'A' }],
			metrics: [{ id: 'latency_ms', type: 'continuous', direction: 'minimize' }],
		})!;
		// 4 次观测：100, 120, 110, 130 → mean=115
		await exp.record('a', { metrics: { latency_ms: 100 } });
		await exp.record('a', { metrics: { latency_ms: 120 } });
		await exp.record('a', { metrics: { latency_ms: 110 } });
		await exp.record('a', { metrics: { latency_ms: 130 } });

		const result = await exp.query('latency_ms');
		const armA = result.arms.find((a) => a.armId === 'a')!;
		expect(armA.n).toBe(4);
		expect(armA.mean).toBeCloseTo(115, 5);
	});

	it('continuous metric n=1 时后验有界（Normal-Gamma 先验，非魔法数）', async () => {
		const exp = manager.registerExperiment({
			owner: 'test',
			name: 'query-continuous-n1',
			contextKey: () => 'global',
			arms: [{ id: 'a', label: 'A' }],
			metrics: [{ id: 'latency_ms', type: 'continuous', direction: 'minimize' }],
		})!;
		await exp.record('a', { metrics: { latency_ms: 100 } });

		const result = await exp.query('latency_ms');
		const armA = result.arms.find((a) => a.armId === 'a')!;
		expect(armA.n).toBe(1);
		// 无信息均值先验（λ₀=0）不把单样本均值拉向 0
		expect(armA.mean).toBeCloseTo(100, 5);
		// Normal-Gamma 后验给出有限 credibleInterval（而非旧实现的任意方差 1）
		expect(Number.isFinite(armA.credibleInterval.low)).toBe(true);
		expect(Number.isFinite(armA.credibleInterval.high)).toBe(true);
		expect(armA.credibleInterval.low).toBeLessThan(armA.mean);
		expect(armA.credibleInterval.high).toBeGreaterThan(armA.mean);
	});

	it('无数据臂的 credibleInterval 为 NaN', async () => {
		const exp = manager.registerExperiment({
			owner: 'test',
			name: 'query-nan',
			contextKey: () => 'global',
			arms: [
				{ id: 'a', label: 'A' },
				{ id: 'b', label: 'B' },
			],
			metrics: [{ id: 'success', type: 'binary', direction: 'maximize' }],
		})!;
		// 只给 a 记录，b 无数据
		await exp.record('a', { metrics: { success: 1 } });

		const result = await exp.query('success');
		const armB = result.arms.find((a) => a.armId === 'b')!;
		expect(armB.n).toBe(0);
		expect(Number.isNaN(armB.credibleInterval.low)).toBe(true);
		expect(Number.isNaN(armB.credibleInterval.high)).toBe(true);
	});
});

describe('pi-lab: ingestion sources', () => {
	let manager: ExperimentManager;

	beforeEach(() => {
		setupTempHome();
		manager = new ExperimentManager();
	});

	afterEach(() => {
		cleanupTempHome();
	});

	it('parseSignalLabel 解析三段式 label', () => {
		expect(parseSignalLabel('row-script:match_success:1')).toEqual({
			armId: 'row-script',
			metricId: 'match_success',
			value: 1,
		});
		expect(parseSignalLabel('a:b:-1.5')).toEqual({ armId: 'a', metricId: 'b', value: -1.5 });
	});

	it('parseSignalLabel 拒绝非法 label', () => {
		expect(parseSignalLabel('metric:value')).toBeNull(); // 两段（无 arm）
		expect(parseSignalLabel('a:b:notanumber')).toBeNull(); // 非数值
		expect(parseSignalLabel('a:b:c:d')).toBeNull(); // 四段
		expect(parseSignalLabel('')).toBeNull();
	});

	it('tagExtractor 从节点提取事件', () => {
		const events = tagExtractor([
			{ label: 'classic:match_success:1', ctxKey: 'model-x' },
			{ label: 'classic:latency_ms:120', ctxKey: 'model-x' },
			{ label: 'not-a-signal', ctxKey: 'model-x' }, // 非法 label，跳过
			{ ctxKey: 'model-x' }, // 无 label，跳过
		]);
		expect(events).toHaveLength(2);
		expect(events[0]).toEqual({
			armId: 'classic',
			ctxKey: 'model-x',
			metrics: { match_success: 1 },
		});
		expect(events[1]).toEqual({
			armId: 'classic',
			ctxKey: 'model-x',
			metrics: { latency_ms: 120 },
		});
	});

	it('tagExtractor 解析逗号分隔的多标签节点且幂等键含标签内容', () => {
		const events = tagExtractor([
			{ label: 'a:match_success:1,b:latency_ms:80', ctxKey: 'model-x', targetId: 'n1' },
		]);
		expect(events).toHaveLength(2);
		expect(events[0].metrics).toEqual({ match_success: 1 });
		expect(events[1].metrics).toEqual({ latency_ms: 80 });
		// 幂等键含 targetId + 标签内容：改标后新标签可再次摄入
		expect(events[0].dedupKey).toBe('tag:n1:a:match_success:1');
		expect(events[1].dedupKey).toBe('tag:n1:b:latency_ms:80');
	});

	it('logExtractor 从日志行提取事件', () => {
		const events = logExtractor([
			'[pi-lab-signal] arm=row-script metric=match_success value=1 ctx=model-y',
			'[pi-lab-signal] arm=classic metric=latency_ms value=88.5',
			'[pi-logger] some other log line', // 非法，跳过
		]);
		expect(events).toHaveLength(2);
		expect(events[0]).toEqual({
			armId: 'row-script',
			ctxKey: 'model-y',
			metrics: { match_success: 1 },
		});
		expect(events[1]).toEqual({
			armId: 'classic',
			ctxKey: 'global', // 无 ctx 缺省 global
			metrics: { latency_ms: 88.5 },
		});
	});

	it('registerIngestionSource + ingest 写入事件流', async () => {
		const exp = manager.registerExperiment({
			owner: 'test',
			name: 'ingest-test',
			contextKey: () => 'global',
			arms: [
				{ id: 'a', label: 'A' },
				{ id: 'b', label: 'B' },
			],
			metrics: [{ id: 'match_success', type: 'binary', direction: 'maximize' }],
		})!;

		manager.registerIngestionSource('my-tags', tagExtractor);

		const count = await manager.ingest('ingest-test', 'my-tags', [
			{ label: 'a:match_success:1', ctxKey: 'model-z' },
			{ label: 'b:match_success:0', ctxKey: 'model-z' },
		]);
		expect(count).toBe(2);

		const stats = await exp.stats();
		expect(stats.a.totalCalls).toBe(1);
		expect(stats.b.totalCalls).toBe(1);

		// ingest 到不存在的实验/信号源 → 0
		expect(await manager.ingest('nope', 'my-tags', [])).toBe(0);
		expect(await manager.ingest('ingest-test', 'nope', [])).toBe(0);
	});

	it('ingest 过滤不属于本实验的 arm 信号', async () => {
		const exp = manager.registerExperiment({
			owner: 'test',
			name: 'ingest-foreign-arm',
			contextKey: () => 'global',
			arms: [{ id: 'a', label: 'A' }],
			metrics: [{ id: 'match_success', type: 'binary', direction: 'maximize' }],
		})!;
		manager.registerIngestionSource('my-tags', tagExtractor);

		// 信号里混入陌生 arm 'b'（可能来自其他实验的同名 arm），应被过滤
		const count = await manager.ingest('ingest-foreign-arm', 'my-tags', [
			{ label: 'a:match_success:1', ctxKey: 'k' },
			{ label: 'b:match_success:1', ctxKey: 'k' },
		]);

		expect(count).toBe(1);
		const events = manager.getExperimentRaw('ingest-foreign-arm')!.getEvents();
		expect(events).toHaveLength(1);
		expect(events[0].armId).toBe('a');
	});

	it('ingest 遇到未知 metricId 时仍追加事件但不污染声明指标聚合', async () => {
		const exp = manager.registerExperiment({
			owner: 'test',
			name: 'ingest-unknown-metric',
			contextKey: () => 'global',
			arms: [{ id: 'a', label: 'A' }],
			metrics: [{ id: 'match_success', type: 'binary', direction: 'maximize' }],
		})!;
		manager.registerIngestionSource('my-tags', tagExtractor);

		// extractor 拼写错误（typo_metric）会告警，但事件仍写入、不影响声明指标聚合
		const count = await manager.ingest('ingest-unknown-metric', 'my-tags', [
			{ label: 'a:typo_metric:1', ctxKey: 'k' },
		]);

		expect(count).toBe(1);
		const raw = manager.getExperimentRaw('ingest-unknown-metric')!;
		expect(raw.getEvents()).toHaveLength(1);
		expect(raw.getEvents()[0].metrics).toEqual({ typo_metric: 1 });

		const stats = await exp.stats();
		expect(stats.a.metrics['match_success'].count).toBe(0);
	});
});
