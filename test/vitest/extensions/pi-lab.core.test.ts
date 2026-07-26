/**
 * pi-lab 核心边界测试
 *
 * 覆盖：
 * - ExperimentManager 注册/生命周期
 * - Experiment select/record/stats
 * - forceArm 覆盖
 * - 存储持久化
 * - Thompson Sampling 行为
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { unlinkSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

// ── 辅助：在临时目录模拟 extensions-data 路径 ──

const ORIGINAL_HOME = process.env.HOME;
let tmpHome: string;

function setupTempHome(): void {
	tmpHome = resolve(tmpdir(), `pi-lab-test-${randomUUID()}`);
	mkdirSync(tmpHome, { recursive: true });
	mkdirSync(resolve(tmpHome, '.pi', 'agent', 'extensions-data', 'pi-lab'), {
		recursive: true,
	});
	process.env.HOME = tmpHome;
}

function cleanupTempHome(): void {
	process.env.HOME = ORIGINAL_HOME;
	try {
		unlinkSync(resolve(tmpHome, '.pi', 'agent', 'extensions-data', 'pi-lab', 'test-exp.json'));
	} catch {
		// ignore
	}
	try {
		unlinkSync(
			resolve(tmpHome, '.pi', 'agent', 'extensions-data', 'pi-lab', 'test-exp-b.json'),
		);
	} catch {
		// ignore
	}
}

// ── 导入被测模块 ──

import { ExperimentManager } from '../../../extensions/meta/pi-lab/core/experiment-manager.js';
import { Experiment } from '../../../extensions/meta/pi-lab/core/experiment.js';
import { ExperimentStorage } from '../../../extensions/meta/pi-lab/core/storage.js';
import { selectArm, winProbability } from '../../../extensions/meta/pi-lab/core/bandit.js';

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
			name: 'test-strategy',
			contextKey: () => 'global',
			arms: [
				{ id: 'a', label: 'Arm A' },
				{ id: 'b', label: 'Arm B' },
			],
			strategy: 'thompson-sampling',
		});

		expect(exp).toBeDefined();
		expect(typeof exp.select).toBe('function');
		expect(typeof exp.record).toBe('function');
		expect(typeof exp.stats).toBe('function');
		expect(typeof exp.forceArm).toBe('function');
		expect(typeof exp.reset).toBe('function');

		const info = exp.info();
		expect(info.name).toBe('test-strategy');
		expect(info.strategy).toBe('thompson-sampling');
		expect(info.forceArmId).toBeNull();
	});

	it('select() returns a valid arm ID', async () => {
		const exp = manager.registerExperiment({
			name: 'test-select',
			contextKey: () => 'global',
			arms: [
				{ id: 'x', label: 'X' },
				{ id: 'y', label: 'Y' },
			],
			strategy: 'thompson-sampling',
		});

		const arm = await exp.select();
		expect(['x', 'y']).toContain(arm);
	});

	it('forceArm overrides select()', async () => {
		const exp = manager.registerExperiment({
			name: 'test-force',
			contextKey: () => 'global',
			arms: [
				{ id: 'a', label: 'A' },
				{ id: 'b', label: 'B' },
			],
			strategy: 'thompson-sampling',
		});

		exp.forceArm('b');
		const arm1 = await exp.select();
		expect(arm1).toBe('b');
		const arm2 = await exp.select();
		expect(arm2).toBe('b');
	});

	it('forceArm(null) restores normal selection', async () => {
		const exp = manager.registerExperiment({
			name: 'test-force-null',
			contextKey: () => 'global',
			arms: [
				{ id: 'a', label: 'A' },
				{ id: 'b', label: 'B' },
			],
			strategy: 'thompson-sampling',
		});

		exp.forceArm('a');
		expect(await exp.select()).toBe('a');
		exp.forceArm(null);
		const arm = await exp.select();
		expect(['a', 'b']).toContain(arm);
	});

	it('record() updates stats', async () => {
		const exp = manager.registerExperiment({
			name: 'test-record',
			contextKey: () => 'global',
			arms: [
				{ id: 'a', label: 'A' },
				{ id: 'b', label: 'B' },
			],
			strategy: 'thompson-sampling',
		});

		await exp.record('a', { success: true, firstAttempt: true, latencyMs: 100 });
		await exp.record('a', { success: true, firstAttempt: false, latencyMs: 200 });
		await exp.record('b', { success: false, latencyMs: 50 });

		const stats = await exp.stats();

		// Arm A: α=1+2=3, β=1+0=1, 2 calls, 1 firstAttempt, 300ms
		expect(stats['a'].alpha).toBe(3);
		expect(stats['a'].beta).toBe(1);
		expect(stats['a'].totalCalls).toBe(2);
		expect(stats['a'].firstAttempts).toBe(1);
		expect(stats['a'].totalLatencyMs).toBe(300);

		// Arm B: α=1+0=1, β=1+1=2, 1 call
		expect(stats['b'].alpha).toBe(1);
		expect(stats['b'].beta).toBe(2);
		expect(stats['b'].totalCalls).toBe(1);
	});

	it('reset() clears all data', async () => {
		const exp = manager.registerExperiment({
			name: 'test-reset',
			contextKey: () => 'global',
			arms: [{ id: 'a', label: 'A' }],
			strategy: 'thompson-sampling',
		});

		await exp.record('a', { success: true });
		const before = await exp.stats();
		expect(before['a'].totalCalls).toBe(1);

		await exp.reset();
		const after = await exp.stats();
		expect(after['a'].totalCalls).toBe(0);
	});

	it('status transitions correctly', () => {
		expect(manager.status).toBe('off');

		manager.registerExperiment({
			name: 'test-status',
			contextKey: () => 'global',
			arms: [{ id: 'a', label: 'A' }],
			strategy: 'thompson-sampling',
		});
		expect(manager.status).toBe('collecting');
	});

	it('getAllExperiments returns all registered experiments', () => {
		manager.registerExperiment({
			name: 'exp-a',
			contextKey: () => 'k',
			arms: [{ id: 'a1', label: 'A1' }],
			strategy: 'thompson-sampling',
		});
		manager.registerExperiment({
			name: 'exp-b',
			contextKey: () => 'k',
			arms: [{ id: 'b1', label: 'B1' }],
			strategy: 'thompson-sampling',
		});

		const all = manager.getAllExperiments();
		expect(all.length).toBe(2);
		expect(all.map((e) => e.name).sort()).toEqual(['exp-a', 'exp-b']);
	});

	// ── 双轨 API + 冲突裁决 ──

	it('registerWeakExperiment returns a valid ExperimentAPI', () => {
		const exp = manager.registerWeakExperiment({
			name: 'weak-exp',
			contextKey: () => 'g',
			arms: [{ id: 'a', label: 'A' }],
			strategy: 'thompson-sampling',
		});
		expect(exp).toBeDefined();
		expect(typeof exp.select).toBe('function');
	});

	it('registerStrongExperiment returns a valid ExperimentAPI', () => {
		const exp = manager.registerStrongExperiment({
			name: 'strong-exp',
			contextKey: () => 'g',
			arms: [{ id: 'b', label: 'B' }],
			strategy: 'thompson-sampling',
		});
		expect(exp).toBeDefined();
		expect(typeof exp.select).toBe('function');
	});

	it('strong experiment overwrites existing weak experiment', () => {
		manager.registerWeakExperiment({
			name: 'conflict-overwrite',
			contextKey: () => 'g',
			arms: [{ id: 'a', label: 'A' }],
			strategy: 'thompson-sampling',
		});

		// Strong 覆盖已存在的 Weak
		const exp = manager.registerStrongExperiment({
			name: 'conflict-overwrite',
			contextKey: () => 'g',
			arms: [{ id: 'b', label: 'B' }],
			strategy: 'thompson-sampling',
		});

		// 新实验的臂是 'b'（被覆盖了）
		const info = exp.info();
		expect(info.name).toBe('conflict-overwrite');

		// 应该有冲突事件被缓存
		const conflicts = manager.getConflicts();
		expect(conflicts.length).toBeGreaterThan(0);
		const overwrite = conflicts.find((c) => c.type === 'overwrite');
		expect(overwrite).toBeDefined();
		expect(overwrite!.existingSource).toBe('bridge');
		expect(overwrite!.newSource).toBe('import');
	});

	it('weak experiment is blocked when strong already exists', () => {
		// 清理冲突缓冲区
		while (manager.getConflicts().length > 0) manager.flushConflicts();

		manager.registerStrongExperiment({
			name: 'conflict-block',
			contextKey: () => 'g',
			arms: [{ id: 'a', label: 'A' }],
			strategy: 'thompson-sampling',
		});

		// Weak 尝试覆盖已有的 Strong → 阻断
		const blockedExp = manager.registerWeakExperiment({
			name: 'conflict-block',
			contextKey: () => 'g',
			arms: [{ id: 'b', label: 'B' }],
			strategy: 'thompson-sampling',
		});

		// 返回的 API 应该引用原有的 strong 实验
		// 验证：选择的臂应该还是 'a'（strong 原有的臂），而不是 'b'
		// 先 force 到 'a' 验证确实是原有的臂
		blockedExp.forceArm('a');
		expect(blockedExp.info().forceArmId).toBe('a');

		// 应该有冲突事件被缓存
		const conflicts = manager.getConflicts();
		const blocked = conflicts.find((c) => c.type === 'blocked');
		expect(blocked).toBeDefined();
		expect(blocked!.existingSource).toBe('import');
		expect(blocked!.newSource).toBe('bridge');
	});

	it('same-source overwrites (last-wins) with conflict event', () => {
		// 清理冲突缓冲区
		while (manager.getConflicts().length > 0) manager.flushConflicts();

		manager.registerStrongExperiment({
			name: 'same-source-last-wins',
			contextKey: () => 'g',
			arms: [{ id: 'first', label: 'First' }],
			strategy: 'thompson-sampling',
		});

		manager.registerStrongExperiment({
			name: 'same-source-last-wins',
			contextKey: () => 'g',
			arms: [{ id: 'second', label: 'Second' }],
			strategy: 'thompson-sampling',
		});

		const conflicts = manager.getConflicts();
		const overwrite = conflicts.find(
			(c) => c.type === 'overwrite' && c.experimentName === 'same-source-last-wins',
		);
		expect(overwrite).toBeDefined();
		expect(overwrite!.newSource).toBe('import');
		expect(overwrite!.existingSource).toBe('import');
	});

	it('getAllExperiments includes source info', () => {
		manager.registerStrongExperiment({
			name: 'exp-source-a',
			contextKey: () => 'k',
			arms: [{ id: 'a1', label: 'A1' }],
			strategy: 'thompson-sampling',
		});
		manager.registerWeakExperiment({
			name: 'exp-source-b',
			contextKey: () => 'k',
			arms: [{ id: 'b1', label: 'B1' }],
			strategy: 'thompson-sampling',
		});

		const all = manager.getAllExperiments();
		const a = all.find((e) => e.name === 'exp-source-a');
		const b = all.find((e) => e.name === 'exp-source-b');

		expect(a?.source).toBe('import');
		expect(b?.source).toBe('bridge');
	});

	it('flushConflicts clears the buffer', () => {
		// 清理冲突缓冲区
		while (manager.getConflicts().length > 0) manager.flushConflicts();

		manager.registerWeakExperiment({
			name: 'flush-test',
			contextKey: () => 'g',
			arms: [{ id: 'x', label: 'X' }],
			strategy: 'thompson-sampling',
		});
		manager.registerStrongExperiment({
			name: 'flush-test',
			contextKey: () => 'g',
			arms: [{ id: 'y', label: 'Y' }],
			strategy: 'thompson-sampling',
		});

		expect(manager.getConflicts().length).toBeGreaterThan(0);

		manager.flushConflicts();
		expect(manager.getConflicts().length).toBe(0);
	});
});

describe('pi-lab: Experiment (standalone)', () => {
	let experiment: Experiment;

	beforeEach(() => {
		setupTempHome();
		experiment = new Experiment(
			'test-exp-b',
			'thompson-sampling',
			[
				{ id: 'control', label: 'Control' },
				{ id: 'treatment', label: 'Treatment' },
			],
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

	it('record updates Beta counts correctly', async () => {
		await experiment.record('control', { success: true }, {});
		await experiment.record('control', { success: true }, {});
		await experiment.record('control', { success: false }, {});

		const stats = await experiment.stats({});
		expect(stats['control'].alpha).toBe(3); // 1 + 2 successes
		expect(stats['control'].beta).toBe(2); // 1 + 1 failure
	});

	it('multiple context keys are stored separately', async () => {
		const exp2 = new Experiment(
			'multi-ctx',
			'thompson-sampling',
			[{ id: 'arm', label: 'Arm' }],
			(ctx: any) => ctx.model,
		);

		await exp2.record('arm', { success: true }, { model: 'm1' });
		await exp2.record('arm', { success: false }, { model: 'm2' });

		const ctxKeys = exp2.getContextKeys();
		expect(ctxKeys).toContain('m1');
		expect(ctxKeys).toContain('m2');

		const m1Stats = await exp2.stats({ model: 'm1' });
		expect(m1Stats['arm'].alpha).toBe(2);

		const m2Stats = await exp2.stats({ model: 'm2' });
		expect(m2Stats['arm'].beta).toBe(2);
	});
});

describe('pi-lab: ExperimentStorage', () => {
	let storage: ExperimentStorage;
	const expName = 'test-storage';

	beforeEach(() => {
		setupTempHome();
		storage = new ExperimentStorage(expName, 'thompson-sampling', ['classic', 'row-script']);
	});

	afterEach(() => {
		cleanupTempHome();
	});

	it('getArmState returns undefined for uninitialized', () => {
		const state = storage.getArmState('m1', 'classic');
		expect(state).toBeUndefined();
	});

	it('updateArmState and then getArmStates returns data', () => {
		storage.updateArmState('m1', 'classic', {
			alpha: 5,
			beta: 2,
			firstAttempts: 4,
			totalCalls: 6,
			totalLatencyMs: 1000,
		});

		const states = storage.getArmStates('m1');
		expect(states.get('classic')?.alpha).toBe(5);
		expect(states.get('classic')?.beta).toBe(2);
		expect(states.get('classic')?.totalCalls).toBe(6);
	});

	it('persists to disk and is reloadable', async () => {
		storage.updateArmState('m1', 'classic', {
			alpha: 10,
			beta: 3,
			firstAttempts: 8,
			totalCalls: 13,
			totalLatencyMs: 5000,
		});
		await storage.flush();

		// 新建 storage 实例读取
		const storage2 = new ExperimentStorage(expName, 'thompson-sampling', [
			'classic',
			'row-script',
		]);
		const states = storage2.getArmStates('m1');
		expect(states.get('classic')?.alpha).toBe(10);
		expect(states.get('classic')?.beta).toBe(3);
	});

	it('resetAll clears data', async () => {
		storage.updateArmState('m1', 'classic', {
			alpha: 5,
			beta: 1,
			firstAttempts: 4,
			totalCalls: 5,
			totalLatencyMs: 100,
		});
		storage.resetAll();

		const states = storage.getArmStates('m1');
		expect(states.size).toBe(0);
	});
});

describe('pi-lab: bandit algorithm', () => {
	it('selectArm with 1 arm returns that arm', () => {
		const states = new Map();
		const arm = selectArm('thompson-sampling', ['only'], states);
		expect(arm).toBe('only');
	});

	it('selectArm returns one of the available arms', () => {
		const states = new Map();
		for (let i = 0; i < 50; i++) {
			const arm = selectArm('thompson-sampling', ['a', 'b'], states);
			expect(['a', 'b']).toContain(arm);
		}
	});

	it('thompson sampling favors high-alpha arm over many trials', () => {
		// 给 arm 'a' 很多成功，arm 'b' 很多失败
		const states = new Map();
		states.set('a', {
			alpha: 50,
			beta: 5,
			firstAttempts: 45,
			totalCalls: 55,
			totalLatencyMs: 0,
		});
		states.set('b', {
			alpha: 5,
			beta: 50,
			firstAttempts: 3,
			totalCalls: 55,
			totalLatencyMs: 0,
		});

		let aCount = 0;
		const trials = 500;
		for (let i = 0; i < trials; i++) {
			const arm = selectArm('thompson-sampling', ['a', 'b'], states);
			if (arm === 'a') aCount++;
		}

		// arm a 应明显多于 arm b（>80%）
		expect(aCount).toBeGreaterThan(trials * 0.8);
	});

	it('winProbability with 1 arm returns 100%', () => {
		const states = new Map();
		states.set('only', {
			alpha: 5,
			beta: 5,
			firstAttempts: 0,
			totalCalls: 10,
			totalLatencyMs: 0,
		});
		const probs = winProbability(states, 1000);
		expect(probs.get('only')).toBe(1);
	});

	it('winProbability reflects strong preference', () => {
		const states = new Map();
		states.set('a', {
			alpha: 80,
			beta: 5,
			firstAttempts: 0,
			totalCalls: 85,
			totalLatencyMs: 0,
		});
		states.set('b', {
			alpha: 5,
			beta: 80,
			firstAttempts: 0,
			totalCalls: 85,
			totalLatencyMs: 0,
		});
		const probs = winProbability(states, 2000);
		expect(probs.get('a') ?? 0).toBeGreaterThan(0.9);
	});

	it('epsilon-greedy explores', () => {
		const states = new Map();
		states.set('a', {
			alpha: 99,
			beta: 1,
			firstAttempts: 98,
			totalCalls: 100,
			totalLatencyMs: 0,
		});
		states.set('b', {
			alpha: 1,
			beta: 99,
			firstAttempts: 0,
			totalCalls: 100,
			totalLatencyMs: 0,
		});

		let bCount = 0;
		const trials = 200;
		for (let i = 0; i < trials; i++) {
			const arm = selectArm('epsilon-greedy', ['a', 'b'], states, { epsilon: 0.15 });
			if (arm === 'b') bCount++;
		}

		// 15% epsilon 下应至少探索到几次 b
		expect(bCount).toBeGreaterThan(5);
	});
});
