/**
 * Beta 计数持久化存储
 *
 * 每个实验独立文件，路径：extensions-data/pi-lab/<experiment-name>.json
 * 写入策略：内存增量更新 + debounced 写盘（2s）+ shutdown flush
 */

import { readJsonFile, resolveConfigPaths, writeJsonAtomic } from '@zenone/pi-config';
import { join } from 'node:path';
import { createLogger } from '@zenone/pi-logger';
import type { ArmState, BanditStrategy, PersistedExperiment } from '../types.js';

const log = createLogger('pi-lab:storage');

export class ExperimentStorage {
	private _experimentName: string;
	private _data: PersistedExperiment;
	private _dirty = false;
	private _saveTimer: ReturnType<typeof setTimeout> | undefined;
	private _flushPromise: Promise<void> | undefined;

	constructor(experimentName: string, strategy: BanditStrategy, armIds: string[]) {
		this._experimentName = experimentName;
		this._data = this._load(armIds, strategy);
	}

	// ── 读取 ──

	getArmState(contextKey: string, armId: string): ArmState | undefined {
		return this._data.models[contextKey]?.[armId];
	}

	/** 获取某 context 下所有臂的状态 */
	getArmStates(contextKey: string): Map<string, ArmState> {
		const entry = this._data.models[contextKey];
		if (!entry) return new Map();
		return new Map(Object.entries(entry));
	}

	/** 获取所有 contextKey */
	getContextKeys(): string[] {
		return Object.keys(this._data.models);
	}

	/** 获取实验信息 */
	getInfo() {
		return {
			strategy: this._data.strategy,
			arms: this._data.arms,
			created: this._data.created,
			updated: this._data.updated,
		};
	}

	// ── 写入 ──

	updateArmState(contextKey: string, armId: string, update: Partial<ArmState>): void {
		if (!this._data.models[contextKey]) {
			this._data.models[contextKey] = {};
		}
		const current = this._data.models[contextKey][armId] ?? {
			alpha: 1,
			beta: 1,
			firstAttempts: 0,
			totalCalls: 0,
			totalLatencyMs: 0,
		};
		this._data.models[contextKey][armId] = { ...current, ...update };
		this._dirty = true;
		this._debouncedSave();
	}

	/** 重置某 context 下所有臂的状态 */
	resetContext(contextKey: string): void {
		delete this._data.models[contextKey];
		this._dirty = true;
		this._debouncedSave();
	}

	/** 重置全部 */
	resetAll(): void {
		this._data.models = {};
		this._dirty = true;
		this._debouncedSave();
	}

	// ── 持久化 ──

	/** 立即写盘 */
	async flush(): Promise<void> {
		if (!this._dirty) return;
		if (this._flushPromise) return this._flushPromise;

		this._flushPromise = this._doSave().finally(() => {
			this._flushPromise = undefined;
		});
		return this._flushPromise;
	}

	private _debouncedSave(): void {
		clearTimeout(this._saveTimer);
		this._saveTimer = setTimeout(() => {
			void this.flush();
		}, 2000);
	}

	private async _doSave(): Promise<void> {
		this._data.updated = new Date().toISOString();
		const filePath = this._getFilePath();
		try {
			await writeJsonAtomic(filePath, this._data);
			this._dirty = false;
		} catch (err) {
			// 写入失败不阻塞业务
			log.error('Failed to save experiment', {
				experiment: this._experimentName,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private _getFilePath(): string {
		const paths = resolveConfigPaths('pi-lab');
		return join(paths.userDir, `${this._experimentName}.json`);
	}

	/**
	 * 按分层策略加载实验数据: projectDir 为种子值，userDir 为累积值。
	 * 与配置分层保持一致: user models > project models > defaults。
	 *
	 * projectDir 作为"只读初始化种子"——在实验开始时提供初始数据。
	 * userDir 是写入目标，存放启动后通过 updateArmState 累积的数据。
	 * 启动时：以 project 数据为基底，用 user 数据中相同的 contextKey/arm 覆盖。
	 */
	private _load(armIds: string[], strategy: BanditStrategy): PersistedExperiment {
		const paths = resolveConfigPaths('pi-lab');
		const defaultData: PersistedExperiment = {
			version: 1,
			strategy,
			arms: armIds,
			models: {},
			created: new Date().toISOString(),
			updated: new Date().toISOString(),
		};

		const userPath = join(paths.userDir, `${this._experimentName}.json`);
		const userRaw = readJsonFile(userPath) as PersistedExperiment | null;

		const projectPath = join(paths.projectDir, `${this._experimentName}.json`);
		const projectRaw = readJsonFile(projectPath) as PersistedExperiment | null;

		if (projectRaw && projectRaw.version === 1) {
			// project 为基底，用 user 累积数据覆盖
			if (userRaw && userRaw.version === 1) {
				const merged: PersistedExperiment = {
					...projectRaw,
					models: { ...projectRaw.models },
				};
				for (const [ctxKey, arms] of Object.entries(userRaw.models)) {
					merged.models[ctxKey] = {
						...(merged.models[ctxKey] || {}),
						...arms,
					};
				}
				return merged;
			}
			return projectRaw;
		}

		if (userRaw && userRaw.version === 1) {
			return userRaw;
		}

		return defaultData;
	}
}
