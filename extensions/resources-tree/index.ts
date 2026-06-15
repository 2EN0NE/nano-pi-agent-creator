import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { state } from "./state.js";
import { loadAllSkillsFromFs } from "./scanner.js";
import { setHeader } from "./header.js";
import {
	updateWidget,
	showWidget,
	hideWidget,
	stopTimer,
	toggleCollapsed,
} from "./widget/core.js";
import { openSettings } from "./widget/settings.js";

export default function (pi: ExtensionAPI): void {
	// Store pi for modules that need it (tools column).
	state.pi = pi;

	// ── Events ────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		// Load skills from FS immediately (correct grouping from the start).
		state.totalSkills = loadAllSkillsFromFs();
		state.loadedSkills = null; // numerator starts null until before_agent_start

		// Restore totalSkills from prior session cache if richer (more entries).
		try {
			const branches = ctx.sessionManager.getBranch();
			for (const entry of branches) {
				if (entry.type === "custom" && entry.customType === "skills-cache") {
					const data = entry.data as
						| { skills: typeof state.totalSkills }
						| undefined;
					if (
						data?.skills &&
						data.skills.length > (state.totalSkills?.length ?? 0)
					) {
						state.totalSkills = data.skills;
					}
					break;
				}
			}
		} catch {
			/* first run */
		}

		setHeader(ctx);
		state.widgetVisible = true;
		showWidget(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!ctx.hasUI) return;

		if (event.systemPromptOptions.contextFiles) {
			state.loadedContextFiles = event.systemPromptOptions.contextFiles;
		}

		if (event.systemPromptOptions.skills) {
			// Parse system prompt to find real enabled skills (numerator).
			// skills.ts may have already filtered <skill name="..."> in systemPrompt.
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

			// Persist so reload resumes with correct grouping.
			pi.appendEntry("skills-cache", { skills: state.loadedSkills });

			// Ensure totalSkills is populated (fallback if session_start hasn't fired).
			if (!state.totalSkills) {
				state.totalSkills = all.map((s) => ({
					name: s.name,
					filePath: s.filePath,
					sourceInfo: s.sourceInfo
						? { source: s.sourceInfo.source, scope: s.sourceInfo.scope }
						: undefined,
				}));
			}
		}

		updateWidget(ctx);
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
			state.totalSkills = null;
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
