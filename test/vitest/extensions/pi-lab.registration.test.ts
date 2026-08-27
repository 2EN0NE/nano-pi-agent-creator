/**
 * pi-lab 注册身份模型测试（owner + 三语义裁决）
 *
 * 覆盖 seam：
 * - definitionDiff 纯函数（口径字段比较，跳过 function contextKey）
 * - registerWeak/Strong 的三分支返回语义（幂等 / 演进 / 异 owner 硬冲突）
 * - getConflicts / flushConflicts 事件类型与文案（含副作用说明）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ExperimentManager } from '../../../extensions/meta/pi-lab/core/experiment-manager.js';
import { definitionDiff } from '../../../extensions/meta/pi-lab/core/definition-diff.js';

// ── 辅助：临时 HOME ──

const ORIGINAL_HOME = process.env.HOME;
let tmpHome: string;

function setupTempHome(): void {
	tmpHome = resolve(tmpdir(), `pi-lab-reg-${randomUUID()}`);
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

const BIN = [{ id: 'success', type: 'binary' as const, direction: 'maximize' as const }];
const ARM_A = [{ id: 'a', label: 'Arm A' }];
const ARM_AB = [
	{ id: 'a', label: 'Arm A' },
	{ id: 'b', label: 'Arm B' },
];

describe('pi-lab: definitionDiff 纯函数', () => {
	it('相同定义 → changed=false', () => {
		const def = {
			owner: 'o',
			name: 'x',
			contextKey: () => 'g',
			arms: ARM_AB,
			metrics: BIN,
			strategy: 'stable-hash' as const,
		};
		expect(definitionDiff(def, { ...def }).changed).toBe(false);
	});

	it('arms 增删 → 描述变化', () => {
		const diff = definitionDiff(
			{ owner: 'o', name: 'x', contextKey: () => 'g', arms: ARM_A, metrics: BIN },
			{ owner: 'o', name: 'x', contextKey: () => 'g', arms: ARM_AB, metrics: BIN },
		);
		expect(diff.changed).toBe(true);
		expect(diff.changes).toContain('arms 新增 b');
	});

	it('arm 权重变化 → 口径变化', () => {
		const diff = definitionDiff(
			{
				owner: 'o',
				name: 'x',
				contextKey: () => 'g',
				arms: [{ id: 'a', label: 'A', weight: 1 }],
				metrics: BIN,
			},
			{
				owner: 'o',
				name: 'x',
				contextKey: () => 'g',
				arms: [{ id: 'a', label: 'A', weight: 9 }],
				metrics: BIN,
			},
		);
		expect(diff.changed).toBe(true);
		expect(diff.changes).toContain('arm a 权重变化');
	});

	it('arm label 变化（仅展示）→ changed=false', () => {
		const diff = definitionDiff(
			{
				owner: 'o',
				name: 'x',
				contextKey: () => 'g',
				arms: [{ id: 'a', label: 'Old' }],
				metrics: BIN,
			},
			{
				owner: 'o',
				name: 'x',
				contextKey: () => 'g',
				arms: [{ id: 'a', label: 'New' }],
				metrics: BIN,
			},
		);
		expect(diff.changed).toBe(false);
	});

	it('metric 增删 / 口径变化 / 仅 description 变化', () => {
		const base = {
			owner: 'o',
			name: 'x',
			contextKey: () => 'g',
			arms: ARM_A,
		};
		// 增删
		const addMetric = definitionDiff(
			{ ...base, metrics: BIN },
			{
				...base,
				metrics: [
					...BIN,
					{ id: 'latency', type: 'continuous' as const, direction: 'minimize' as const },
				],
			},
		);
		expect(addMetric.changed).toBe(true);
		expect(addMetric.changes).toContain('metrics 新增 latency');

		// 口径变化（direction）
		const dirChange = definitionDiff(
			{
				...base,
				metrics: [
					{ id: 'success', type: 'binary' as const, direction: 'maximize' as const },
				],
			},
			{
				...base,
				metrics: [
					{ id: 'success', type: 'binary' as const, direction: 'minimize' as const },
				],
			},
		);
		expect(dirChange.changed).toBe(true);
		expect(dirChange.changes).toContain('metric success 口径变化');

		// 仅 description 变化 → 不算演进
		const descChange = definitionDiff(
			{
				...base,
				metrics: [
					{
						id: 'success',
						type: 'binary' as const,
						direction: 'maximize' as const,
						description: '旧',
					},
				],
			},
			{
				...base,
				metrics: [
					{
						id: 'success',
						type: 'binary' as const,
						direction: 'maximize' as const,
						description: '新',
					},
				],
			},
		);
		expect(descChange.changed).toBe(false);
	});

	it('function 型 contextKey 跳过（不同闭包视为未变）', () => {
		const diff = definitionDiff(
			{ owner: 'o', name: 'x', contextKey: () => 'g', arms: ARM_A, metrics: BIN },
			{ owner: 'o', name: 'x', contextKey: () => 'other', arms: ARM_A, metrics: BIN },
		);
		expect(diff.changed).toBe(false);
	});

	it('string 型 contextKey 变化 → 描述变化', () => {
		const diff = definitionDiff(
			{ owner: 'o', name: 'x', contextKey: 'g', arms: ARM_A, metrics: BIN },
			{ owner: 'o', name: 'x', contextKey: 'h', arms: ARM_A, metrics: BIN },
		);
		expect(diff.changed).toBe(true);
		expect(diff.changes).toContain('contextKey g → h');
	});

	it('isAA 变化 → 口径变化（触发 updateDef，AA 校准启停不被静默忽略）', () => {
		const base = { owner: 'o', name: 'x', contextKey: 'g', arms: ARM_A, metrics: BIN };
		const diff = definitionDiff(base, { ...base, isAA: true });
		expect(diff.changed).toBe(true);
		expect(diff.changes).toContain('isAA false → true');
	});

	it('isAA 未声明与显式 false 视为等价（不误报演进）', () => {
		const base = { owner: 'o', name: 'x', contextKey: 'g', arms: ARM_A, metrics: BIN };
		expect(definitionDiff(base, { ...base, isAA: false }).changed).toBe(false);
	});
});

describe('pi-lab: 注册三语义', () => {
	let manager: ExperimentManager;

	beforeEach(() => {
		setupTempHome();
		manager = new ExperimentManager();
	});

	afterEach(() => {
		cleanupTempHome();
	});

	it('全新注册返回 API 且记录 source', () => {
		const exp = manager.registerWeakExperiment({
			owner: 'o',
			name: 'x',
			contextKey: () => 'g',
			arms: ARM_A,
			metrics: BIN,
		});
		expect(exp).toBeDefined();
		// source（接入方式）在 getAllExperiments 里暴露，用于面板展示归属
		expect(manager.getAllExperiments().find((e) => e.name === 'x')?.source).toBe('bridge');
	});

	it('同 owner 同 name 同定义 → 幂等：静默、保留状态、无冲突事件', () => {
		const exp1 = manager.registerWeakExperiment({
			owner: 'o',
			name: 'x',
			contextKey: () => 'g',
			arms: ARM_AB,
			metrics: BIN,
		})!;
		exp1.forceArm('b');

		const exp2 = manager.registerWeakExperiment({
			owner: 'o',
			name: 'x',
			contextKey: () => 'g',
			arms: ARM_AB,
			metrics: BIN,
		});

		// 未重建：forceArmId 保留（session 级状态未丢失）
		expect(exp2!.info().forceArmId).toBe('b');
		// 无冲突事件
		expect(manager.getConflicts()).toHaveLength(0);
	});

	it('同 owner 同 name 定义演进 → 重建 + evolved 事件 + 副作用文案', () => {
		const exp1 = manager.registerWeakExperiment({
			owner: 'o',
			name: 'x',
			contextKey: () => 'g',
			arms: ARM_A,
			metrics: BIN,
		})!;
		exp1.forceArm('a');

		const exp2 = manager.registerWeakExperiment({
			owner: 'o',
			name: 'x',
			contextKey: () => 'g',
			arms: ARM_AB,
			metrics: BIN,
		});

		// 重建：forceArmId 丢失
		expect(exp2!.info().forceArmId).toBeNull();
		// 新定义生效
		const arms = manager
			.getExperimentRaw('x')!
			.getInfo()
			.arms.map((a) => a.id);
		expect(arms).toEqual(['a', 'b']);

		// evolved 事件
		const conflicts = manager.getConflicts();
		expect(conflicts).toHaveLength(1);
		expect(conflicts[0].type).toBe('evolved');
		expect(conflicts[0].changes).toContain('arms 新增 b');

		// 文案含副作用说明
		let notified = '';
		let level = '';
		manager.flushConflicts((msg, lvl) => {
			notified = msg;
			level = lvl;
		});
		expect(level).toBe('warn');
		expect(notified).toContain('副作用');
		expect(notified).toContain('arms 新增 b');
	});

	it('异 owner 同 name → 硬冲突：返回 undefined、不覆盖、owner-conflict 事件', () => {
		const exp1 = manager.registerWeakExperiment({
			owner: 'owner-a',
			name: 'x',
			contextKey: () => 'g',
			arms: ARM_A,
			metrics: BIN,
		});
		expect(exp1).toBeDefined();

		const exp2 = manager.registerStrongExperiment({
			owner: 'owner-b',
			name: 'x',
			contextKey: () => 'g',
			arms: ARM_AB,
			metrics: BIN,
		});

		// 后注册者被阻断
		expect(exp2).toBeUndefined();

		// 原实验未被覆盖
		const raw = manager.getExperimentRaw('x')!;
		expect(raw.getInfo().arms.map((a) => a.id)).toEqual(['a']);

		// owner-conflict 事件
		const conflicts = manager.getConflicts();
		expect(conflicts).toHaveLength(1);
		expect(conflicts[0].type).toBe('owner-conflict');
		expect(conflicts[0].owner).toBe('owner-b');
		expect(conflicts[0].existingOwner).toBe('owner-a');
	});

	it('flushConflicts 文案：owner-conflict 含阻断说明', () => {
		manager.registerWeakExperiment({
			owner: 'owner-a',
			name: 'x',
			contextKey: () => 'g',
			arms: ARM_A,
			metrics: BIN,
		});
		manager.registerStrongExperiment({
			owner: 'owner-b',
			name: 'x',
			contextKey: () => 'g',
			arms: ARM_A,
			metrics: BIN,
		});

		let notified = '';
		let level = '';
		manager.flushConflicts((msg, lvl) => {
			notified = msg;
			level = lvl;
		});
		expect(level).toBe('error');
		expect(notified).toContain('owner "owner-b"');
		expect(notified).toContain('owner "owner-a"');
		expect(notified).toContain('阻断');
	});

	it('演进后数据保留（JSONL append-only，仅定义口径变化）', async () => {
		const exp1 = manager.registerWeakExperiment({
			owner: 'o',
			name: 'x',
			contextKey: () => 'g',
			arms: ARM_A,
			metrics: BIN,
		})!;
		await exp1.record('a', { metrics: { success: 1 } });

		manager.registerWeakExperiment({
			owner: 'o',
			name: 'x',
			contextKey: () => 'g',
			arms: ARM_AB,
			metrics: BIN,
		});

		// 旧数据仍在（未自动 reset）
		const stats = await manager.getExperimentRaw('x')!.stats();
		expect(stats.a.totalCalls).toBe(1);
	});
});
