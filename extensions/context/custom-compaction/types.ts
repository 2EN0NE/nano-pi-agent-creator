/**
 * Types for custom-compaction extension.
 *
 * Defines the profile/config schema used for compaction strategies.
 */

/** A single compaction strategy profile */
export interface CompactionProfile {
	/** Unique identifier (auto-generated UUID or slug) */
	id: string;
	/** Human-readable name shown in the settings panel */
	name: string;
	/**
	 * Model specification:
	 * - "current": use ctx.model (the currently active Pi model)
	 * - "provider/modelId": use a specific model (e.g. "anthropic/claude-sonnet-4-20250514")
	 */
	model: "current" | `${string}/${string}`;
	/**
	 * Trigger strategy that determines when compaction fires.
	 * Currently only "context_percent" is supported.
	 */
	strategy: {
		type: "context_percent";
		/** Threshold 1-99. Compact when context usage exceeds this percentage of the window. */
		threshold: number;
	};
	/**
	 * Custom summarization prompt appended to the default compaction prompt.
	 * If empty, a sensible default is used.
	 */
	prompt: string;
	/** Whether to automatically resume work after compaction succeeds */
	autoContinue: boolean;
	/** Message sent via pi.sendUserMessage() when autoContinue is true */
	autoContinueMessage: string;
}

/** Root config persisted to disk */
export interface CompactionConfig {
	profiles: Record<string, CompactionProfile>;
	activeProfileId: string;
	/** Schema version for future migrations */
	version: number;
}

/** Default auto-continue message */
export const DEFAULT_AUTO_CONTINUE_MESSAGE = "继续按目标完成任务，全部验证";

/** Default prompt used when a profile has no custom prompt */
export const DEFAULT_COMPACTION_PROMPT = `You are a conversation summarizer. Create a comprehensive summary of this conversation that captures:

1. The main goals and objectives discussed
2. Key decisions made and their rationale
3. Important code changes, file modifications, or technical details
4. Current state of any ongoing work
5. Any blockers, issues, or open questions
6. Next steps that were planned or suggested

Be thorough but concise. The summary will replace the ENTIRE conversation history, so include all information needed to continue the work effectively.

Format the summary as structured markdown with clear sections.`;

/** Default profile shipped with the extension */
export function createDefaultProfile(): CompactionProfile {
	return {
		id: "default",
		name: "Default",
		model: "current",
		strategy: {
			type: "context_percent",
			threshold: 80,
		},
		prompt: DEFAULT_COMPACTION_PROMPT,
		autoContinue: true,
		autoContinueMessage: DEFAULT_AUTO_CONTINUE_MESSAGE,
	};
}

export function createDefaultConfig(): CompactionConfig {
	return {
		profiles: {
			default: createDefaultProfile(),
		},
		activeProfileId: "default",
		version: 1,
	};
}
