import type { ContextFileEntry, SkillEntry } from "./types.js";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Shared mutable state for the extension. */
export const state = {
	/** Reference to pi API, set by index.ts on startup. */
	pi: null as ExtensionAPI | null,
	// ── Skills ─────────────────────────────────────────────────
	// totalSkills: all loaded from FS (denominator, set once on session_start)
	// loadedSkills: actually sent to model via <skill name="">    (numerator, updated each before_agent_start)
	totalSkills: null as SkillEntry[] | null,
	loadedSkills: null as SkillEntry[] | null,
	loadedContextFiles: null as ContextFileEntry[] | null,

	// ── Usage tracking ──────────────────────────────────────────────
	toolUsageCounts: new Map<string, number>(),
	skillUsageCounts: new Map<string, number>(),
	totalToolCalls: 0,
	totalSkillLoads: 0,
	recentToolNames: [] as string[],
	recentSkillNames: [] as string[],

	// ── Widget state ────────────────────────────────────────────────
	widgetVisible: true,
	widgetCollapsed: true,
	refreshIntervalMs: 2000,
	refreshTimer: null as ReturnType<typeof setInterval> | null,

	// ── Cached header ───────────────────────────────────────────────
	cachedHeader: [] as string[],
};

/** Get usage ratio for a named resource (tool or skill). */
export function getUsageRatio(name: string): number {
	const toolCount = state.toolUsageCounts.get(name) ?? 0;
	const skillCount = state.skillUsageCounts.get(name) ?? 0;
	const count = Math.max(toolCount, skillCount);
	const total = Math.max(state.totalToolCalls, state.totalSkillLoads);
	if (total === 0) return 0;
	return count / total;
}
