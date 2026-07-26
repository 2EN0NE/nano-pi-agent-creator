/**
 * 实验管理器 — 管理所有实验的注册、查找、生命周期
 *
 * 提供双轨注册 API：
 *   registerStrongExperiment() — 强依赖（方案 B，import），优先级高
 *   registerWeakExperiment()   — 弱依赖（方案 A，bridge），优先级低
 *
 * 冲突裁决规则（高优先级始终赢）：
 *   - 强依赖已存在，弱依赖新来 → 阻断弱依赖
 *   - 弱依赖已存在，强依赖新来 → 覆盖弱依赖
 *   - 同级冲突 → 后注册覆盖先注册（last-wins）
 */

import { createLogger } from '@zenone/pi-logger';
import type {
	ArmDef,
	BanditStrategy,
	ConflictEvent,
	ContextKeyFn,
	ExperimentAPI,
	ExperimentDef,
	Outcome,
	RegistrationSource,
} from '../types.js';
import { REGISTRATION_PRIORITY } from '../types.js';
import { Experiment } from './experiment.js';
import type { EpsilonConfig } from './bandit.js';

const log = createLogger('pi-lab');

export class ExperimentManager {
	/** 实验名 → Experiment 实例的 map */
	private _experiments = new Map<string, Experiment>();
	/** 实验名 → 注册来源 */
	private _sources = new Map<string, RegistrationSource>();
	/** 冲突通知缓冲区（session_start 时冲刷到 UI） */
	private _conflictBuffer: ConflictEvent[] = [];

	private _status: 'off' | 'collecting' | 'switched' = 'off';

	// ── 状态 ──

	get status(): 'off' | 'collecting' | 'switched' {
		return this._status;
	}

	setStatus(status: 'off' | 'collecting' | 'switched'): void {
		this._status = status;
	}

	// ── 双轨注册 API ──

	/**
	 * 注册一个强依赖实验（方案 B，import）。
	 * 优先级高：不会被 registerWeakExperiment() 的同名实验覆盖。
	 *
	 * @param def 实验定义
	 * @returns ExperimentAPI
	 */
	registerStrongExperiment(def: ExperimentDef): ExperimentAPI {
		return this._registerExperiment(def, 'import');
	}

	/**
	 * 注册一个弱依赖实验（方案 A，bridge）。
	 * 优先级低：可能被 registerStrongExperiment() 的同名实验覆盖。
	 *
	 * @param def 实验定义
	 * @returns ExperimentAPI
	 */
	registerWeakExperiment(def: ExperimentDef): ExperimentAPI {
		return this._registerExperiment(def, 'bridge');
	}

	/**
	 * @deprecated 请改用 registerWeakExperiment() 或 registerStrongExperiment()
	 */
	registerExperiment(def: ExperimentDef): ExperimentAPI {
		return this.registerWeakExperiment(def);
	}

	// ── 获取 ──

	getExperiment(name: string): ExperimentAPI | undefined {
		const exp = this._experiments.get(name);
		return exp ? this._createAPI(exp) : undefined;
	}

	getExperimentInfo(name: string) {
		return this._experiments.get(name)?.getInfo();
	}

	getAllExperiments(): Array<{
		name: string;
		source: RegistrationSource | undefined;
		info: ReturnType<Experiment['getInfo']>;
	}> {
		return Array.from(this._experiments.entries()).map(([name, exp]) => ({
			name,
			source: this._sources.get(name),
			info: exp.getInfo(),
		}));
	}

	getExperimentRaw(name: string): Experiment | undefined {
		return this._experiments.get(name);
	}

	// ── 冲突通知 ──

	/**
	 * 获取缓存的冲突事件列表。
	 * 在 session_start 中调用 flushConflicts() 冲刷到 UI。
	 */
	getConflicts(): ConflictEvent[] {
		return [...this._conflictBuffer];
	}

	/**
	 * 将缓存的冲突通知冲刷到 pi-logger 和 UI。
	 * 应在 session_start 事件处理器中调用。
	 *
	 * @param notify UI 通知函数（如 ctx.ui.notify）
	 */
	flushConflicts(notify?: (message: string, level: 'info' | 'warn' | 'error') => void): void {
		while (this._conflictBuffer.length > 0) {
			const conflict = this._conflictBuffer.shift()!;
			const msg = this._formatConflictMessage(conflict);
			log.warn(msg);
			notify?.(msg, 'warn');
		}
	}

	// ── 生命周期 ──

	async flushAll(): Promise<void> {
		for (const exp of this._experiments.values()) {
			await exp.flush();
		}
	}

	// ── 内部 ──

	/**
	 * 共享注册实现。按优先级裁决冲突：
	 *
	 * | 已有      | 新来     | 结果                         |
	 * |-----------|----------|------------------------------|
	 * | import    | bridge   | 阻断 bridge（日志 + 缓冲）   |
	 * | bridge    | import   | 覆盖 bridge（日志 + 缓冲）   |
	 * | import    | import   | 覆盖（last-wins，日志+缓冲） |
	 * | bridge    | bridge   | 覆盖（last-wins，日志+缓冲） |
	 */
	private _registerExperiment(def: ExperimentDef, newSource: RegistrationSource): ExperimentAPI {
		const existing = this._experiments.get(def.name);
		const existingSource = this._sources.get(def.name);

		if (existing && existingSource !== undefined) {
			// 检查是否需要阻断
			const newPri = REGISTRATION_PRIORITY[newSource];
			const existingPri = REGISTRATION_PRIORITY[existingSource];

			if (newPri < existingPri) {
				// 低优先级想覆盖高优先级 → 阻断
				this._bufferConflict({
					type: 'blocked',
					experimentName: def.name,
					newSource,
					existingSource,
					timestamp: new Date().toISOString(),
				});
				// 返回已存在的实验 API（让调用方有一个可用的 API，但不会被记录）
				return this._createAPI(existing);
			}

			// 同级或高优先级 → 覆盖
			if (newPri >= existingPri) {
				this._bufferConflict({
					type: 'overwrite',
					experimentName: def.name,
					newSource,
					existingSource,
					timestamp: new Date().toISOString(),
				});
			}
		}

		const experiment = new Experiment(def.name, def.strategy, def.arms, def.contextKey);

		this._experiments.set(def.name, experiment);
		this._sources.set(def.name, newSource);
		this.setStatus('collecting');

		log.info('Experiment registered', {
			name: def.name,
			source: newSource,
			arms: def.arms.map((a) => a.id),
			strategy: def.strategy,
		});

		return this._createAPI(experiment);
	}

	private _bufferConflict(conflict: ConflictEvent): void {
		this._conflictBuffer.push(conflict);
	}

	private _formatConflictMessage(conflict: ConflictEvent): string {
		const sourceLabel: Record<RegistrationSource, string> = {
			import: 'strong (import)',
			bridge: 'weak (bridge)',
		};

		if (conflict.type === 'blocked') {
			return (
				`Experiment "${conflict.experimentName}" blocked: ` +
				`${sourceLabel[conflict.newSource]} tried to register but ` +
				`${sourceLabel[conflict.existingSource]} has higher priority`
			);
		}

		return (
			`Experiment "${conflict.experimentName}" overwritten: ` +
			`${sourceLabel[conflict.existingSource]} → ${sourceLabel[conflict.newSource]}`
		);
	}

	private _createAPI(experiment: Experiment): ExperimentAPI {
		return {
			select: async () => {
				const armId = await experiment.select(undefined);
				return armId;
			},
			record: async (armId: string, outcome: Outcome) => {
				await experiment.record(armId, outcome, undefined);
			},
			stats: async () => {
				return experiment.stats(undefined);
			},
			forceArm: (armId: string | null) => {
				experiment.forceArm(armId);
				this.setStatus(armId ? 'switched' : 'collecting');
				log.info('Arm forced', {
					experiment: experiment.getInfo().name,
					armId,
				});
			},
			info: () => {
				const info = experiment.getInfo();
				return {
					name: info.name,
					source: this._sources.get(info.name),
					strategy: info.strategy,
					forceArmId: info.forceArmId,
				};
			},
			reset: async () => {
				await experiment.reset();
				log.info('Experiment reset', {
					name: experiment.getInfo().name,
				});
			},
		};
	}
}
