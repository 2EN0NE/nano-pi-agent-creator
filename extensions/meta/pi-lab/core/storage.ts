/**
 * 实验事件流持久化存储
 *
 * 每实验一个 JSONL 文件，路径：extensions-data/pi-lab/<experiment-name>.jsonl
 * 写入策略：append + debounced flush（2s）+ shutdown flush
 */

import { appendFile, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolveConfigPaths } from '@zenone/pi-config';
import { dirname, join } from 'node:path';
import type { ExperimentEvent } from '../types.js';
import { createLogger } from '@zenone/pi-logger';

const log = createLogger('pi-lab:storage');

/** flush 写盘失败后的有界重试次数（首次 + 重试 MAX_FLUSH_RETRIES 次） */
const MAX_FLUSH_RETRIES = 2;

export class ExperimentStorage {
	private _experimentName: string;
	private _events: ExperimentEvent[] = [];
	private _flushedCount = 0;
	private _saveTimer: ReturnType<typeof setTimeout> | undefined;
	private _flushPromise: Promise<void> | undefined;
	private _loadWarning: string | null = null;

	constructor(experimentName: string) {
		this._experimentName = experimentName;
		this._events = this._load();
		this._flushedCount = this._events.length;
	}

	// ── 读取 ──

	/** 读全部事件（含本次会话新增与历史落盘） */
	getEvents(): ExperimentEvent[] {
		return this._events;
	}

	/** 加载警告（整体读取失败时非空），供面板提示「历史数据加载失败」而非静默空态 */
	getLoadWarning(): string | null {
		return this._loadWarning;
	}

	/** 按上下文键过滤事件 */
	getEventsByContext(ctxKey: string): ExperimentEvent[] {
		return this._events.filter((e) => e.ctxKey === ctxKey);
	}

	// ── 写入 ──

	appendEvent(event: ExperimentEvent): void {
		this._events.push(event);
		this._debouncedSave();
	}

	/** 清空全部事件（reset）。写盘失败会抛错，内存态保持不变（避免假成功）。 */
	async reset(): Promise<void> {
		if (this._saveTimer) clearTimeout(this._saveTimer);
		// 等待在途 flush 完成，避免其把旧事件 append 回已清空的文件
		if (this._flushPromise) await this._flushPromise;
		// 先写盘清空，成功后再清内存——写失败时内存态保持，磁盘旧数据可下次加载，
		// 不会出现「内存已清、磁盘未清」的静默假成功。
		const filePath = this._getFilePath();
		mkdirSync(dirname(filePath), { recursive: true });
		await writeFile(filePath, '', 'utf8');
		this._events = [];
		this._flushedCount = 0;
	}

	// ── 持久化 ──

	/** 把尚未落盘的事件增量 append 到 JSONL */
	async flush(): Promise<void> {
		// 循环直到全部落盘：覆盖「在途 flush 期间又有新事件 append」的竞态，
		// 避免 session_shutdown 前追加的事件因 debounce 定时器未触发而丢失。
		while (this._events.length > this._flushedCount) {
			if (this._flushPromise) {
				await this._flushPromise;
				continue;
			}
			this._flushPromise = this._doFlush().finally(() => {
				this._flushPromise = undefined;
			});
			await this._flushPromise;
		}
	}

	private _debouncedSave(): void {
		clearTimeout(this._saveTimer);
		this._saveTimer = setTimeout(() => {
			void this.flush();
		}, 2000);
	}

	private async _doFlush(): Promise<void> {
		const filePath = this._getFilePath();
		// 记录本次 flush 的起点，只推进到「本次实际写入」的数量——
		// 若 appendEvent 在 await appendFile 期间并发 push，新事件不在 pending 内，
		// 不能把它们标记为已落盘（否则下一次 flush 会因长度相等而跳过，导致丢事件）。
		const startCount = this._flushedCount;
		// 有界重试：写失败可能是瞬时错误（磁盘满、句柄竞争等），先重试 MAX_FLUSH_RETRIES 次。
		// 每次重试重新 slice，把重试期间并发新增的事件一并写入，推进口径始终一致。
		let lastError: unknown;
		for (let attempt = 0; attempt <= MAX_FLUSH_RETRIES; attempt++) {
			try {
				// 确保目录存在：首次使用 pi-lab 时 extensions-data/pi-lab/ 尚未创建，
				// appendFile 会因 ENOENT 抛错；若不推进 _flushedCount，flush() 的
				// while 循环会无限重试同一批事件导致死循环（pi 进程卡死不退出）。
				mkdirSync(dirname(filePath), { recursive: true });

				const pending = this._events.slice(startCount);
				const lines = pending.map((e) => JSON.stringify(e)).join('\n');
				const content = lines.length > 0 ? lines + '\n' : '';
				await appendFile(filePath, content, 'utf8');
				this._flushedCount = startCount + pending.length;
				return;
			} catch (err) {
				lastError = err;
			}
		}
		// 重试耗尽仍失败：丢弃本批事件（fail-open 遥测语义——实验数据可接受丢失）。
		// 必须推进 _flushedCount，否则 flush() 的 while 循环会永久重试、进程卡死；
		// 被丢弃的事件未落盘、下次会话无法重载，属不可恢复。
		log.error('Failed to flush events (dropping unsaved events after retries)', {
			experiment: this._experimentName,
			dropped: this._events.length - startCount,
			attempts: MAX_FLUSH_RETRIES + 1,
			error: lastError instanceof Error ? lastError.message : String(lastError),
		});
		this._flushedCount = this._events.length;
	}

	private _getFilePath(): string {
		const paths = resolveConfigPaths('pi-lab');
		return join(paths.userDir, `${this._experimentName}.jsonl`);
	}

	/**
	 * 检测旧版本化 JSON 存储（<name>.json）。存储已切换为 append-only JSONL，
	 * 旧 .json 历史数据不再读取——若存在则告警，避免历史实验数据被静默丢弃。
	 */
	private _warnLegacyJson(): void {
		const paths = resolveConfigPaths('pi-lab');
		for (const dir of [paths.userDir, paths.projectDir]) {
			const legacyPath = join(dir, `${this._experimentName}.json`);
			if (existsSync(legacyPath)) {
				log.warn('Legacy JSON experiment data detected (not migrated)', {
					experiment: this._experimentName,
					legacyPath,
					hint: '存储已切换为 append-only JSONL，旧 .json 历史数据不再读取，如需保留请手动迁移',
				});
			}
		}
	}

	private _load(): ExperimentEvent[] {
		this._warnLegacyJson();
		const filePath = this._getFilePath();
		if (!existsSync(filePath)) return [];
		try {
			const raw = readFileSync(filePath, 'utf8');
			const events: ExperimentEvent[] = [];
			const lines = raw.split('\n');
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i].trim();
				if (line.length === 0) continue;
				try {
					events.push(JSON.parse(line) as ExperimentEvent);
				} catch (err) {
					// 逐行容错是刻意决策（非静默回退）：JSONL 单行损坏时保留其余有效事件，
					// 好过整文件丢弃历史数据。记录行号便于定位损坏来源。
					log.warn('Skipping corrupted event line', {
						experiment: this._experimentName,
						line: i + 1,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}
			return events;
		} catch (err) {
			// 文件整体读取失败（权限/编码）：记录告警供面板提示，返回空态继续运行。
			// 历史事件在本次会话不可见，但磁盘旧数据仍保留，下次可重试加载。
			const message = err instanceof Error ? err.message : String(err);
			this._loadWarning = message;
			log.error('Failed to load events', {
				experiment: this._experimentName,
				error: message,
			});
			return [];
		}
	}
}
