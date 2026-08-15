/**
 * 实验管理器 — 管理所有实验的注册、查找、生命周期
 *
 * 提供双轨注册 API（source 仅表接入方式，不参与裁决）：
 *   registerStrongExperiment() — 强依赖（方案 B，import 直接依赖包）
 *   registerWeakExperiment()   — 弱依赖（方案 A，globalThis.__labApi 桥接）
 *
 * 以 (owner, name) 识别逻辑实验身份，注册裁决三分支：
 *   - 同 owner 同 name，定义未变 → 幂等重声明，静默返回已存在 API
 *   - 同 owner 同 name，定义演进 → 重建 + warn（含副作用说明）
 *   - 异 owner 同 name          → 硬冲突（error + UI 通知），阻断并返回 undefined
 */

import type {
	AllocationStrategy,
	ConflictEvent,
	ExperimentAPI,
	ExperimentDef,
	IngestionSource,
	Outcome,
	RegistrationSource,
	SignalExtractor,
} from '../types.js';
import { Experiment } from './experiment.js';
import { definitionDiff } from './definition-diff.js';
import { createLogger } from '@zenone/pi-logger';

const log = createLogger('pi-lab');

export class ExperimentManager {
	/** 实验名 → Experiment 实例的 map */
	private _experiments = new Map<string, Experiment>();
	/** 实验名 → 注册来源（仅表接入方式，不参与裁决） */
	private _sources = new Map<string, RegistrationSource>();
	/** 实验名 → 注册时传入的定义（重注册时比较用） */
	private _defs = new Map<string, ExperimentDef>();
	/** 实验名 → 注册方 owner */
	private _owners = new Map<string, string>();
	/** 注册事件缓冲区（owner-conflict / evolved，session_start 时冲刷到 UI） */
	private _conflictBuffer: ConflictEvent[] = [];
	private _ingestionSources = new Map<string, IngestionSource>();

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
	 * 注册一个强依赖实验（方案 B，import 直接依赖 @zenone/pi-lab 包）。
	 * source 仅表接入方式，不参与冲突裁决。
	 *
	 * @param def 实验定义
	 * @returns ExperimentAPI；异 owner 撞名时返回 undefined（硬冲突阻断）
	 */
	registerStrongExperiment(def: ExperimentDef): ExperimentAPI | undefined {
		return this._registerExperiment(def, 'import');
	}

	/**
	 * 注册一个弱依赖实验（方案 A，bridge 经 globalThis.__labApi 鸭子类型访问）。
	 * source 仅表接入方式，不参与冲突裁决。
	 *
	 * @param def 实验定义
	 * @returns ExperimentAPI；异 owner 撞名时返回 undefined（硬冲突阻断）
	 */
	registerWeakExperiment(def: ExperimentDef): ExperimentAPI | undefined {
		return this._registerExperiment(def, 'bridge');
	}

	/**
	 * @deprecated 请改用 registerWeakExperiment() 或 registerStrongExperiment()
	 */
	registerExperiment(def: ExperimentDef): ExperimentAPI | undefined {
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

	// ── 信号入口 ──

	/**
	 * 注册一个信号源（扩展点）。
	 * extractor 把原始信号（TAG label、日志行等）转成带 armId 的实验事件。
	 * armId 归因是 extractor 的职责——异步信号无法由 pi-lab 推断 arm。
	 */
	registerIngestionSource(name: string, extractor: SignalExtractor): void {
		this._ingestionSources.set(name, { name, extract: extractor });
		log.info('Ingestion source registered', { name });
	}

	/** 获取已注册的信号源 */
	getIngestionSources(): IngestionSource[] {
		return Array.from(this._ingestionSources.values());
	}

	/**
	 * 从已注册信号源提取事件并写入实验。
	 *
	 * @param experimentName 目标实验
	 * @param sourceName 信号源名（须先 registerIngestionSource）
	 * @param rawData 原始信号（TAG 节点列表 / 日志行数组等）
	 * @returns 写入的事件条数（0 表示实验或信号源不存在）
	 */
	async ingest(experimentName: string, sourceName: string, rawData: unknown): Promise<number> {
		const exp = this._experiments.get(experimentName);
		const source = this._ingestionSources.get(sourceName);
		if (!exp || !source) {
			log.warn('Ingest skipped', {
				experimentName,
				sourceName,
				hasExperiment: !!exp,
				hasSource: !!source,
			});
			return 0;
		}
		const events = source.extract(rawData);
		const armIds = new Set(exp.getInfo().arms.map((a) => a.id));
		const metricIds = new Set(exp.getInfo().metrics.map((m) => m.id));
		let count = 0;
		for (const e of events) {
			// 过滤不属于本实验的 arm 信号（信号可能来自其他实验的同名 arm）
			if (!armIds.has(e.armId)) continue;
			// 告警未知 metricId：extractor 拼写错误会导致事件永不出现在聚合/分析中
			const unknownMetrics = Object.keys(e.metrics).filter((id) => !metricIds.has(id));
			if (unknownMetrics.length > 0) {
				log.warn('Ingest event has unknown metric ids', {
					experiment: experimentName,
					source: sourceName,
					armId: e.armId,
					unknownMetrics,
				});
			}
			// appendEvent 返回是否实际写入（dedupKey 去重后可能为 false）
			if (exp.appendEvent(e)) count++;
		}
		return count;
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
			// owner-conflict 是配置错误（error 级），evolved 是口径变化提示（warn 级）
			const level: 'warn' | 'error' = conflict.type === 'owner-conflict' ? 'error' : 'warn';
			if (level === 'error') log.error(msg);
			else log.warn(msg);
			notify?.(msg, level);
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
	 * 共享注册实现。以 (owner, name) 识别逻辑实验身份，三分支裁决：
	 *
	 * | 已有                | 结果                                          |
	 * |---------------------|-----------------------------------------------|
	 * | 无                  | 全新注册，返回新 API                           |
	 * | 同 owner，定义未变  | 幂等重声明，静默返回已存在 API                  |
	 * | 同 owner，定义演进  | 重建 + warn（含副作用），返回新 API             |
	 * | 异 owner            | 硬冲突（error + UI 通知），阻断，返回 undefined |
	 */
	private _registerExperiment(
		def: ExperimentDef,
		newSource: RegistrationSource,
	): ExperimentAPI | undefined {
		const existing = this._experiments.get(def.name);
		const existingOwner = this._owners.get(def.name);
		const existingDef = this._defs.get(def.name);

		if (existing && existingOwner !== undefined && existingDef) {
			if (existingOwner === def.owner) {
				// 同 owner 同 name → 重声明
				const diff = definitionDiff(existingDef, def);
				if (diff.changed) {
					// 演进：口径变化，原地更新定义（不重建 storage，保留内存/文件数据）
					this._bufferConflict({
						type: 'evolved',
						experimentName: def.name,
						owner: def.owner,
						timestamp: new Date().toISOString(),
						changes: diff.changes,
					});
					const strategy = def.strategy ?? 'stable-hash';
					this._checkBanditTarget(def, strategy);
					existing.updateDef(strategy, def.arms, def.metrics, def.contextKey);
					this._defs.set(def.name, def);
					this._sources.set(def.name, newSource);
					log.warn('Experiment definition evolved', {
						name: def.name,
						owner: def.owner,
						changes: diff.changes,
					});
					return this._createAPI(existing);
				}
				// 幂等：静默返回已存在 API（不重建，零开销）
				return this._createAPI(existing);
			}
			// 异 owner 同 name → 硬冲突（不覆盖，返回 undefined 让消费方降级）
			this._bufferConflict({
				type: 'owner-conflict',
				experimentName: def.name,
				owner: def.owner,
				existingOwner,
				newSource,
				existingSource: this._sources.get(def.name),
				timestamp: new Date().toISOString(),
			});
			log.error('Experiment name conflict (different owner)', {
				name: def.name,
				owner: def.owner,
				existingOwner,
			});
			return undefined;
		}

		// 全新注册
		const experiment = this._buildExperiment(def);
		this._experiments.set(def.name, experiment);
		this._defs.set(def.name, def);
		this._owners.set(def.name, def.owner);
		this._sources.set(def.name, newSource);
		this.setStatus('collecting');

		log.info('Experiment registered', {
			name: def.name,
			owner: def.owner,
			source: newSource,
			arms: def.arms.map((a) => a.id),
			strategy: def.strategy ?? 'stable-hash',
		});

		return this._createAPI(experiment);
	}

	/** bandit 策略依赖 binary 目标 metric；缺失时 Thompson 采样退化为均匀随机（静默降级，注册即告警） */
	private _checkBanditTarget(def: ExperimentDef, strategy: AllocationStrategy): void {
		if (strategy === 'stable-hash') return;
		const hasBinaryTarget = def.metrics.some(
			(m) => m.type === 'binary' && !m.isGuardrail && !m.derived,
		);
		if (!hasBinaryTarget) {
			log.warn('Bandit strategy without binary target metric (uniform-random fallback)', {
				name: def.name,
				strategy,
			});
		}
	}

	/** 构造 Experiment 实例 */
	private _buildExperiment(def: ExperimentDef): Experiment {
		const strategy = def.strategy ?? 'stable-hash';
		this._checkBanditTarget(def, strategy);
		return new Experiment(def.name, strategy, def.arms, def.metrics, def.contextKey);
	}

	private _bufferConflict(conflict: ConflictEvent): void {
		this._conflictBuffer.push(conflict);
	}

	private _formatConflictMessage(conflict: ConflictEvent): string {
		if (conflict.type === 'owner-conflict') {
			return (
				`实验 "${conflict.experimentName}" 注册冲突: owner "${conflict.owner}" 尝试注册，` +
				`但该实验已被 owner "${conflict.existingOwner}" 占用。` +
				`两个插件撞名是配置错误——后注册者已被阻断，请改实验名或统一 owner`
			);
		}

		// evolved：定义演进，说明变化点 + 副作用
		const changes = conflict.changes?.length ? conflict.changes.join('、') : '未知变化';
		return (
			`实验 "${conflict.experimentName}" 定义较上次变化（owner=${conflict.owner}）：${changes}。` +
			`副作用：历史事件按旧定义采集，与新定义口径不一致（旧数据可能被忽略、新维度从零开始），` +
			`如需干净基线请在 /lab 面板执行 reset`
		);
	}

	private _createAPI(experiment: Experiment): ExperimentAPI {
		return {
			select: async (context?: unknown) => {
				const armId = await experiment.select(context);
				return armId;
			},
			record: async (armId: string, outcome: Outcome, context?: unknown) => {
				await experiment.record(armId, outcome, context);
			},
			stats: async (context?: unknown) => {
				return experiment.stats(context);
			},
			query: async (metricId: string, context?: unknown) => {
				return experiment.query(metricId, context);
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
