/**
 * Types for custom-compaction extension.
 *
 * A CompactionProfile consists of two dimensions:
 * - trigger:  WHEN to compact (context_percent / fixed / reserve)
 * - mechanism: HOW to compact (summarize / pass_through / adapter)
 */

// ── Trigger: when to compact ────────────────────────────────────

export type TriggerType = 'context_percent' | 'fixed' | 'reserve';

export const TRIGGER_LABELS: Record<TriggerType, string> = {
	context_percent: 'Context percentage',
	fixed: 'Fixed token count',
	reserve: 'Reserve tokens',
};

/** Describe what a trigger condition means */
export function describeTrigger(trigger: { type: TriggerType; threshold: number }): string {
	switch (trigger.type) {
		case 'context_percent':
			return `Compact at ${trigger.threshold}% context window usage`;
		case 'fixed':
			return `Compact when tokens exceed ${trigger.threshold.toLocaleString()}`;
		case 'reserve':
			return `Compact when remaining tokens < ${trigger.threshold.toLocaleString()}`;
		default:
			return `Unknown trigger`;
	}
}

/** Validate a trigger threshold */
export function validateTriggerThreshold(type: TriggerType, value: number): string | null {
	switch (type) {
		case 'context_percent':
			if (!Number.isFinite(value) || value < 1 || value > 99)
				return 'Threshold must be between 1 and 99';
			break;
		case 'fixed':
			if (!Number.isFinite(value) || value < 1000)
				return 'Token count must be at least 1,000';
			break;
		case 'reserve':
			if (!Number.isFinite(value) || value < 100)
				return 'Reserve must be at least 100 tokens';
			break;
		default:
			return `Unknown trigger type`;
	}
	return null;
}

// ── Mechanism: how to compact ───────────────────────────────────

export type MechanismType = 'summarize' | 'pass_through' | 'adapter';

export const MECHANISM_LABELS: Record<MechanismType, string> = {
	summarize: 'LLM summarization',
	pass_through: 'Pass through (default Pi / other)',
	adapter: 'External adapter',
};

export function describeMechanism(mechanism: { type: MechanismType; adapterId?: string }): string {
	switch (mechanism.type) {
		case 'summarize':
			return 'LLM full summary (custom prompt)';
		case 'pass_through':
			return 'Let Pi default or other extensions handle compaction';
		case 'adapter':
			return `External adapter: ${mechanism.adapterId ?? '(none)'}`;
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
	model: 'current' | `${string}/${string}`;
	/**
	 * Optional model pattern to auto-select this profile.
	 * When set, this profile ONLY activates when the current Pi model matches the pattern.
	 * When undefined, the profile acts as a universal fallback (matches any model).
	 *
	 * Matching is case-insensitive. Examples:
	 *   "openai/gpt-4o"     → matches "openai/gpt-4o", "openai/gpt-4o-mini"
	 *   "openai/"           → matches any OpenAI model
	 *   "gpt-4o"            → matches any provider with "gpt-4o" in the model ID
	 *
	 * When multiple profiles match, the most specific (longest pattern) wins.
	 */
	matchModel?: string;
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
export const DEFAULT_AUTO_CONTINUE_MESSAGE = 'continue';

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
		id: 'default',
		name: 'Default',
		model: 'current',
		trigger: {
			type: 'context_percent',
			threshold: 20,
		},
		mechanism: {
			type: 'summarize',
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
		activeProfileId: 'default',
	};
}

// ── Model matching ──────────────────────────────────────────────

/**
 * Build a model spec string ("provider/id") from an object with provider and id fields.
 * Returns undefined if either field is missing.
 */
export function toModelSpec(modelLike?: { provider?: string; id?: string }): string | undefined {
	if (!modelLike?.provider || !modelLike?.id) return undefined;
	return `${modelLike.provider}/${modelLike.id}`;
}

/**
 * How well a profile's matchModel matches a given model spec (provider/id).
 * Lower value = better match. undefined = no match.
 */
export function modelMatchScore(
	matchModel: string | undefined,
	modelSpec: string,
): number | undefined {
	if (!matchModel) return undefined; // universal fallback — scored separately
	const pattern = matchModel.toLowerCase();
	const target = modelSpec.toLowerCase();

	if (pattern === target) return 0; // exact match, best
	if (target.startsWith(pattern)) return 1; // prefix match (e.g. "openai/" matches "openai/gpt-4o")
	if (target.includes(pattern)) return 2; // substring match (e.g. "gpt-4o" matches "openai/gpt-4o")
	return undefined; // no match
}

/**
 * Select the best-matching profile for a given model spec.
 *
 * Priority:
 * 1. Exact model spec match (score 0)
 * 2. Prefix match (score 1)
 * 3. Substring match (score 2)
 * 4. Universal fallback (matchModel undefined)
 * 5. First profile in the list (last resort)
 */
export function selectBestProfile(
	config: CompactionConfig,
	modelSpec: string | undefined,
): CompactionProfile | undefined {
	const entries = Object.entries(config.profiles);
	if (entries.length === 0) return undefined;

	if (!modelSpec) {
		// No model info — prefer a universal profile, fall back to first
		const universal = entries.find(([, p]) => !p.matchModel);
		if (universal) return universal[1];
		return entries[0][1];
	}

	// Score all profiles against the model spec
	let bestProfile: CompactionProfile | undefined;
	let bestScore = Infinity;
	let bestPatternLen = 0;

	for (const [, p] of entries) {
		if (!p.matchModel) {
			// Universal fallback — lowest priority among matched
			if (bestScore > 100) {
				bestScore = 100;
				bestProfile = p;
				bestPatternLen = 0;
			}
			continue;
		}
		const score = modelMatchScore(p.matchModel, modelSpec);
		if (score === undefined) continue;
		const len = p.matchModel.length;
		// Same score → longer pattern wins (more specific)
		if (score < bestScore || (score === bestScore && len > bestPatternLen)) {
			bestScore = score;
			bestProfile = p;
			bestPatternLen = len;
		}
	}

	return bestProfile ?? entries[0][1];
}
