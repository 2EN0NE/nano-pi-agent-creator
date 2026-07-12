/**
 * Types for custom-compaction extension.
 *
 * A CompactionProfile consists of two dimensions:
 * - trigger:  WHEN to compact (context_percent / fixed / reserve)
 * - mechanism: HOW to compact (summarize / pass_through / adapter)
 */

// ── Trigger: when to compact ────────────────────────────────────

export type TriggerType = "context_percent" | "fixed" | "reserve";

export const TRIGGER_LABELS: Record<TriggerType, string> = {
	context_percent: "Context percentage",
	fixed: "Fixed token count",
	reserve: "Reserve tokens",
};

/** Describe what a trigger condition means */
export function describeTrigger(trigger: {
	type: TriggerType;
	threshold: number;
}): string {
	switch (trigger.type) {
		case "context_percent":
			return `Compact at ${trigger.threshold}% context window usage`;
		case "fixed":
			return `Compact when tokens exceed ${trigger.threshold.toLocaleString()}`;
		case "reserve":
			return `Compact when remaining tokens < ${trigger.threshold.toLocaleString()}`;
		default:
			return `Unknown trigger`;
	}
}

/** Validate a trigger threshold */
export function validateTriggerThreshold(
	type: TriggerType,
	value: number,
): string | null {
	switch (type) {
		case "context_percent":
			if (!Number.isFinite(value) || value < 1 || value > 99)
				return "Threshold must be between 1 and 99";
			break;
		case "fixed":
			if (!Number.isFinite(value) || value < 1000)
				return "Token count must be at least 1,000";
			break;
		case "reserve":
			if (!Number.isFinite(value) || value < 100)
				return "Reserve must be at least 100 tokens";
			break;
		default:
			return `Unknown trigger type`;
	}
	return null;
}

// ── Mechanism: how to compact ───────────────────────────────────

export type MechanismType = "summarize" | "pass_through" | "adapter";

export const MECHANISM_LABELS: Record<MechanismType, string> = {
	summarize: "LLM summarization",
	pass_through: "Pass through (default Pi / other)",
	adapter: "External adapter",
};

export function describeMechanism(mechanism: {
	type: MechanismType;
	adapterId?: string;
}): string {
	switch (mechanism.type) {
		case "summarize":
			return "LLM full summary (custom prompt)";
		case "pass_through":
			return "Let Pi default or other extensions handle compaction";
		case "adapter":
			return `External adapter: ${mechanism.adapterId ?? "(none)"}`;
	}
}

// ── Profile ─────────────────────────────────────────────────────

export interface TriggerCondition {
	type: TriggerType;
	/** Threshold meaning depends on type (see describeTrigger) */
	threshold: number;
}

export interface CompactionMechanism {
	type: MechanismType;
	/** Required when type="adapter" — the registered adapter ID */
	adapterId?: string;
	/** Optional adapter-specific config (adapter defines the schema) */
	adapterConfig?: Record<string, unknown>;
}

export interface CompactionProfile {
	/** Unique identifier */
	id: string;
	/** Human-readable name shown in the settings panel */
	name: string;
	/**
	 * Model specification:
	 * - "current": use ctx.model (the currently active Pi model)
	 * - "provider/modelId": use a specific model (e.g. "anthropic/claude-sonnet-4-20250514")
	 */
	model: "current" | `${string}/${string}`;
	/** WHEN to compact */
	trigger: TriggerCondition;
	/** HOW to compact */
	mechanism: CompactionMechanism;
	/**
	 * Custom summarization prompt.
	 * Only used when mechanism.type === "summarize".
	 * For adapter mechanisms, the adapter may also consult this.
	 */
	prompt: string;
	/** Whether to automatically resume work after compaction succeeds */
	autoContinue: boolean;
	/** Message sent via pi.sendUserMessage() when autoContinue is true */
	autoContinueMessage: string;
}

// ── Config ──────────────────────────────────────────────────────

export interface CompactionConfig {
	profiles: Record<string, CompactionProfile>;
	activeProfileId: string;
}

// ── Default values ──────────────────────────────────────────────

/** Default auto-continue message */
export const DEFAULT_AUTO_CONTINUE_MESSAGE = "continue";

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
		trigger: {
			type: "context_percent",
			threshold: 20,
		},
		mechanism: {
			type: "summarize",
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
	};
}
