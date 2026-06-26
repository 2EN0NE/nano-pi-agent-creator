import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { state } from "./state.js";
import { loadAllSkillsFromFs, scanAllResources } from "./scanner.js";
import { setHeader } from "./header.js";
import {
	updateWidget,
	showWidget,
	stopTimer,
	toggleCollapsed,
} from "./widget/core.js";
import { openSettings } from "./widget/settings.js";

// ── Logging helpers ───────────────────────────────────────────────
// Uses pi.events.emit() directly — same EventBus channel as pi-logger.
// Unlike importing createLogger from pi-logger/api.js, this avoids
// module caching issues when running as a separate extension.

const LOG_EVENT_CHANNEL = "pi:log";
const LOG_SOURCE = "resources-tree";

function emitLog(
	pi: ExtensionAPI,
	level: string,
	message: string,
	details?: unknown,
): void {
	pi.events.emit(LOG_EVENT_CHANNEL, {
		level,
		source: LOG_SOURCE,
		message,
		details,
		timestamp: Date.now(),
	});
}

// ── Helpers ───────────────────────────────────────────────────────

/**
 * Extract raw system prompt text from a provider payload.
 * Returns the first found system prompt text, or null if none exists.
 * Handles both simple string and array-of-content-blocks formats.
 */
function extractSystemText(payload: unknown): string | null {
	if (typeof payload !== "object" || payload === null) return null;
	const p = payload as Record<string, unknown>;

	// Anthropic-style: messages[].role === "system"
	if (Array.isArray(p.messages)) {
		for (const msg of p.messages) {
			if (
				msg &&
				typeof msg === "object" &&
				(msg as Record<string, unknown>).role === "system"
			) {
				const content = (msg as Record<string, unknown>).content;
				if (typeof content === "string") return content;
				if (Array.isArray(content)) {
					for (const block of content) {
						if (
							block &&
							typeof block === "object" &&
							typeof (block as Record<string, unknown>).text === "string"
						) {
							return (block as Record<string, unknown>).text as string;
						}
					}
				}
			}
		}
	}

	// Anthropic-style: top-level system field
	if (p.system !== undefined && p.system !== null) {
		if (typeof p.system === "string") return p.system;
		if (Array.isArray(p.system)) {
			for (const block of p.system) {
				if (
					block &&
					typeof block === "object" &&
					typeof (block as Record<string, unknown>).text === "string"
				) {
					return (block as Record<string, unknown>).text as string;
				}
			}
		}
	}

	return null;
}

/**
 * Count <name> tags inside <available_skills> in a system prompt text.
 * If the text has <available_skills> but it's empty or absent, returns 0.
 * Returns null only when no system prompt text is found at all.
 */
function countSkillsInPayload(payload: unknown): number | null {
	const systemText = extractSystemText(payload);
	if (systemText === null) return null;

	const m = systemText.match(
		/<available_skills>([\s\S]*?)<\/available_skills>/,
	);
	if (!m) return 0; // System text exists but no XML block → 0 skills

	return (m[1].match(/<name>/g) || []).length;
}

export default function (pi: ExtensionAPI): void {
	// Store pi for modules that need it (tools column).
	state.pi = pi;

	// ── Events ────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		// Load skills from FS immediately (correct grouping from the start).
		state.loadedSkills = loadAllSkillsFromFs();

		// Restore cache from prior session if richer.
		try {
			const branches = ctx.sessionManager.getBranch();
			for (const entry of branches) {
				if (entry.type === "custom" && entry.customType === "skills-cache") {
					const data = entry.data as
						| { skills: typeof state.loadedSkills }
						| undefined;
					if (
						data?.skills &&
						data.skills.length > (state.loadedSkills?.length ?? 0)
					) {
						state.loadedSkills = data.skills;
					}
					break;
				}
			}
		} catch {
			/* first run */
		}

		// FS skill count = same logic as startup header (scanAllResources).
		state.fsSkillCount = new Set(
			scanAllResources(ctx).skills.map((s) => s.name),
		).size;

		setHeader(ctx);
		state.widgetVisible = true;
		showWidget(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		// ── System prompt deduplication ─────────────────────────────
		// Strip duplicate "Available skills:" line injected by prompt-customizer.
		// The native <available_skills> XML is the canonical source.
		let promptResult: { systemPrompt: string } | undefined;
		const cleanedPrompt = event.systemPrompt.replace(
			/^Available skills: .+$/m,
			"",
		);
		if (cleanedPrompt !== event.systemPrompt) {
			promptResult = { systemPrompt: cleanedPrompt };
		}

		// ── Skill count computation (best-effort estimate) ───────────
		// Count skills from <available_skills> XML in the system prompt at this
		// point. This may be updated later by before_provider_request with the
		// final payload (after all extensions have modified the prompt).
		if (event.systemPromptOptions.skills) {
			const xmlBlock = event.systemPrompt.match(
				/<available_skills>([\s\S]*?)<\/available_skills>/,
			);
			state.xmlSkillCount = 0;
			if (xmlBlock) {
				const nameMatches = xmlBlock[1].match(/<name>([^<]+)<\/name>/g);
				if (nameMatches) state.xmlSkillCount = nameMatches.length;
			}

			// Filter loadedSkills based on XML tags in system prompt.
			const enabledNames = new Set<string>();
			const re = /<skill name="([^"]+)"/g;
			let m: RegExpExecArray | null;
			while ((m = re.exec(event.systemPrompt)) !== null) {
				enabledNames.add(m[1]);
			}

			const all = event.systemPromptOptions.skills;
			const use =
				enabledNames.size > 0
					? all.filter((s) => enabledNames.has(s.name))
					: all;
			state.loadedSkills = use.map((s) => ({
				name: s.name,
				filePath: s.filePath,
				sourceInfo: s.sourceInfo
					? { source: s.sourceInfo.source, scope: s.sourceInfo.scope }
					: undefined,
			}));

			pi.appendEntry("skills-cache", { skills: state.loadedSkills });
		}

		// ── Denominator from Pi's authoritative total ──────────────
		// Update fsSkillCount from systemPromptOptions.skills (Pi's full loaded
		// list, including sources like ~/.agents/ that loadAllSkillsFromFs misses).
		if (event.systemPromptOptions.skills) {
			state.fsSkillCount = new Set(
				event.systemPromptOptions.skills.map((s) => s.name),
			).size;
		}

		// ── Debug logging (emitted to pi-logger EventBus if available) ──
		emitLog(pi, "info", "before_agent_start skill_counts", {
			xmlSkillCount: state.xmlSkillCount,
			fsSkillCount: state.fsSkillCount,
		});

		if (!ctx.hasUI) return promptResult;

		if (event.systemPromptOptions.contextFiles) {
			state.loadedContextFiles = event.systemPromptOptions.contextFiles;
		}

		updateWidget(ctx);
		return promptResult;
	});

	// ── Skill usage tracking ──────────────────────────────────

	pi.on("input", (event, ctx) => {
		if (!ctx.hasUI) return;

		if (event.text.startsWith("/skill:")) {
			const rest = event.text.slice(7).trim();
			const spaceIdx = rest.indexOf(" ");
			const skillName = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
			if (skillName) {
				state.skillUsageCounts.set(
					skillName,
					(state.skillUsageCounts.get(skillName) ?? 0) + 1,
				);
				state.totalSkillLoads++;
				state.recentSkillNames = [
					skillName,
					...state.recentSkillNames.filter((n) => n !== skillName),
				].slice(0, 3);
			}
		}

		if (event.text.startsWith("/reload")) {
			state.loadedSkills = null;
			state.loadedContextFiles = null;
			updateWidget(ctx);
		}
	});

	pi.on("message_start", (event, ctx) => {
		if (!ctx.hasUI) return;
		const msg = event.message;
		if (msg.role === "user" && msg.content && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (
					block.type === "text" &&
					typeof block.text === "string" &&
					block.text.startsWith('<skill name="')
				) {
					const match = block.text.match(/^<skill name="([^"]+)"/);
					if (match) {
						const skillName = match[1];
						state.skillUsageCounts.set(
							skillName,
							(state.skillUsageCounts.get(skillName) ?? 0) + 1,
						);
						state.totalSkillLoads++;
						state.recentSkillNames = [
							skillName,
							...state.recentSkillNames.filter((n) => n !== skillName),
						].slice(0, 3);
					}
				}
			}
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		if ("toolName" in event) {
			const name = (event as any).toolName as string;
			state.toolUsageCounts.set(
				name,
				(state.toolUsageCounts.get(name) ?? 0) + 1,
			);
			state.totalToolCalls++;
			state.recentToolNames = [
				name,
				...state.recentToolNames.filter((n) => n !== name),
			].slice(0, 3);
		}
		updateWidget(ctx);
	});

	pi.on("tool_execution_start", async (_event, ctx) => {
		updateWidget(ctx);
	});

	// ── Provider payload verification (ground truth) ────────────────
	// Inspect the actual payload before it's sent to the provider. This is the
	// authoritative count — it reflects what the LLM actually receives after all
	// extensions (including skills.ts) have modified the system prompt.
	// If the payload has system prompt text but no <available_skills> XML,
	// assume 0 skills (the XML was removed entirely by some extension).
	// If no system text is found at all, keep the previous estimate.
	pi.on("before_provider_request", (event, ctx) => {
		const actualCount = countSkillsInPayload(event.payload);
		if (actualCount === null) return; // No system text in payload yet

		const oldCount = state.xmlSkillCount;
		if (oldCount !== actualCount) {
			emitLog(pi, "info", "xmlSkillCount set from provider payload", {
				old: oldCount,
				new: actualCount,
			});
		}
		state.xmlSkillCount = actualCount;
		if (ctx.hasUI) updateWidget(ctx);
	});

	pi.on("session_shutdown", async () => {
		stopTimer();
	});

	// ── Command & Shortcut ──────────────────────────────────────

	pi.registerCommand("resource-tree", {
		description: "Open resource tree settings panel",
		handler: async (_args, ctx) => {
			openSettings(ctx);
		},
	});

	pi.registerShortcut("ctrl+shift+z", {
		description: "Toggle resource tree panel expand/collapse",
		handler: (ctx) => {
			toggleCollapsed(ctx);
		},
	});
}
