import type { CheckpointEntry, RepoManager } from './engine';
import { parseDiffStats } from './engine';
import { errorMessage } from './util';

export type AutoCheckpointStartResult =
	| { readonly ok: true; readonly entries: readonly CheckpointEntry[] }
	| { readonly ok: false; readonly message: string };

export type AutoCheckpointEndResult = { readonly ok: true } | { readonly ok: false };

export type AutoCheckpointFinalizeResult =
	| { readonly ok: true; readonly entry: CheckpointEntry }
	| { readonly ok: false; readonly message?: string };

export interface AutoCheckpointProducerOptions {
	readonly repo: RepoManager;
	readonly exclude: readonly string[];
	readonly createTurnId: () => string;
	readonly now: () => Date;
	/** Latest active-branch file state, if the session already has one. */
	readonly initialCommit?: string;
}

export interface AutoCheckpointTurnStartInput {
	readonly userEntryId: string;
	readonly prompt: string;
}

export interface AutoCheckpointTurnEndInput {
	readonly userEntryId: string;
	readonly prompt: string;
}

export type AutoCheckpointAssistantStopReason = 'stop' | 'length' | 'toolUse' | 'error' | 'aborted';

export class AutoCheckpointProducer {
	private pendingTurnId: string | undefined;

	private pendingUserEntryId: string | undefined;

	private pendingBeforeCommit: string | undefined;

	private pendingPrompt = '';

	private pendingAssistantStopReason: AutoCheckpointAssistantStopReason | undefined;

	private latestCommit: string | undefined;

	constructor(private readonly options: AutoCheckpointProducerOptions) {
		this.latestCommit = options.initialCommit;
	}

	beginRun(): void {
		this.pendingTurnId = undefined;
		this.pendingUserEntryId = undefined;
		this.pendingBeforeCommit = undefined;
		this.pendingPrompt = '';
		this.pendingAssistantStopReason = undefined;
	}

	async turnStart(input: AutoCheckpointTurnStartInput): Promise<AutoCheckpointStartResult> {
		const entries: CheckpointEntry[] = [];

		if (this.pendingBeforeCommit) {
			if (this.pendingUserEntryId === input.userEntryId) {
				this.pendingAssistantStopReason = undefined;
				return { ok: true, entries };
			}

			const finalized = await this.finalizeRun();
			if (finalized.ok) entries.push(finalized.entry);
		}

		this.pendingTurnId = this.options.createTurnId();
		this.pendingUserEntryId = input.userEntryId;
		this.pendingPrompt = input.prompt;
		this.pendingAssistantStopReason = undefined;

		try {
			await this.options.repo.withLock(async () => {
				await this.options.repo.ensureReady(this.options.exclude);
				this.pendingBeforeCommit =
					this.latestCommit === undefined
						? await this.options.repo.checkpoint(input.userEntryId)
						: await this.options.repo.checkpointIfChanged(
								input.userEntryId,
								this.latestCommit,
							);
			});
			return { ok: true, entries };
		} catch (err) {
			this.beginRun();
			return { ok: false, message: `Checkpoint failed: ${errorMessage(err)}` };
		}
	}

	async turnEnd(input: AutoCheckpointTurnEndInput): Promise<AutoCheckpointEndResult> {
		if (!this.pendingTurnId || !this.pendingUserEntryId || !this.pendingBeforeCommit) {
			return { ok: false };
		}

		if (this.pendingUserEntryId === input.userEntryId) {
			this.pendingPrompt = input.prompt;
		}
		return { ok: true };
	}

	recordAssistantStopReason(stopReason: AutoCheckpointAssistantStopReason): void {
		if (!this.pendingBeforeCommit) return;
		this.pendingAssistantStopReason = stopReason;
	}

	shouldFinalizeOnAgentEnd(): boolean {
		if (!this.pendingBeforeCommit) return false;
		return this.pendingAssistantStopReason !== 'error';
	}

	async finalizeRun(): Promise<AutoCheckpointFinalizeResult> {
		if (!this.pendingTurnId || !this.pendingUserEntryId || !this.pendingBeforeCommit) {
			return { ok: false };
		}

		try {
			const turnId = this.pendingTurnId;
			const userEntryId = this.pendingUserEntryId;
			const beforeCommit = this.pendingBeforeCommit;
			const prompt = this.pendingPrompt;
			const entry = await this.options.repo.withLock(async (): Promise<CheckpointEntry> => {
				await this.options.repo.stageAll();
				const stdout = await this.options.repo.diffAgainst(beforeCommit);
				const parsed = parseDiffStats(stdout);
				const afterCommit =
					parsed.length > 0
						? await this.options.repo.checkpointStaged(userEntryId)
						: beforeCommit;

				return {
					v: 2,
					kind: 'checkpoint',
					turnId,
					userEntryId,
					beforeCommit,
					afterCommit,
					prompt,
					fileCount: parsed.length,
					fileChanges: parsed,
					createdAt: this.options.now().toISOString(),
				};
			});

			this.latestCommit = entry.afterCommit;
			return { ok: true, entry };
		} catch (err) {
			return { ok: false, message: `Checkpoint finalization failed: ${errorMessage(err)}` };
		} finally {
			this.beginRun();
		}
	}
}

// ============================================================================
// Event checkpoint（checkpointTrigger: "event" 的按需快照）
// ============================================================================

export interface EventCheckpointCapturerOptions {
	readonly repo: RepoManager;
	readonly exclude: readonly string[];
	readonly createTurnId: () => string;
	readonly now: () => Date;
}

export type EventCheckpointResult =
	| { readonly ok: true; readonly entry: CheckpointEntry }
	| { readonly ok: false; readonly message?: string };

/**
 * 在 fork/clone/tree 等事件前打一个「当前状态快照」checkpoint。
 *
 * 与按消息的 AutoCheckpointProducer 不同：event 快照没有 before/after 跨度，
 * beforeCommit 与 afterCommit 相等（快照点即恢复点），fileCount=0（无「本 turn 变更」
 * 语义）。消费方（findCleanCheckpointCommit / resolveTreeTargetCommit）遍历所有
 * checkpoint 的 before/after commit，与 event 快照完全兼容。
 */
export class EventCheckpointCapturer {
	constructor(private readonly options: EventCheckpointCapturerOptions) {}

	async capture(userEntryId: string, prompt: string): Promise<EventCheckpointResult> {
		try {
			const entry = await this.options.repo.withLock(async (): Promise<CheckpointEntry> => {
				await this.options.repo.ensureReady(this.options.exclude);
				const commit = await this.options.repo.checkpoint(userEntryId);
				return {
					v: 2,
					kind: 'checkpoint',
					turnId: this.options.createTurnId(),
					userEntryId,
					beforeCommit: commit,
					afterCommit: commit,
					prompt,
					fileCount: 0,
					fileChanges: [],
					createdAt: this.options.now().toISOString(),
				};
			});
			return { ok: true, entry };
		} catch (err) {
			return { ok: false, message: `Event checkpoint failed: ${errorMessage(err)}` };
		}
	}
}
