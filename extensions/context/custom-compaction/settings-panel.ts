/**
 * Settings panel for /custom-compaction-setting command.
 *
 * Interaction flow:
 * 1. Main panel → top selection bar "▸ 配置: {label}" (press Enter)
 * 2. Profile tree (level 1: profile names, level 2: details on navigate)
 * 3. Press Enter on a profile → field editor (key-value tree of all fields)
 * 4. Select any field → edit its value directly
 * 5. Save creates/updates session-level config
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	type CompactionConfig,
	type CompactionProfile,
	type TriggerType,
	type MechanismType,
	TRIGGER_LABELS,
	MECHANISM_LABELS,
	describeTrigger,
	describeMechanism,
	validateTriggerThreshold,
	DEFAULT_AUTO_CONTINUE_MESSAGE,
} from "./types.js";
import {
	loadConfig,
	reloadConfig,
	getActiveConfigPath,
	getConfigLabel,
	setActiveProfile,
	upsertProfile,
} from "./config.js";
import { getAllAdapters } from "./mechanisms/index.js";

// ── Helpers ─────────────────────────────────────────────────────

/** Safely describe a profile — handles partial/incomplete profiles */
function safeDescribe(p: CompactionProfile): string {
	const parts: string[] = [];
	parts.push(`Model: ${p.model === "current" ? "Current" : p.model}`);
	if (p.trigger) {
		parts.push(`Trigger: ${describeTrigger(p.trigger)}`);
	} else {
		parts.push("Trigger: (not configured — edit profile to set)");
	}
	if (p.mechanism) {
		parts.push(`Mechanism: ${describeMechanism(p.mechanism)}`);
	} else {
		parts.push("Mechanism: (not configured — edit profile to set)");
	}
	parts.push(`Auto-continue: ${p.autoContinue ? "Yes" : "No"}`);
	return parts.join(" | ");
}

/** Alias for backward compat */
const profileDescription = safeDescribe;

// ── Profile field editor (inline key-value tree) ────────────────

/**
 * Field definitions for a CompactionProfile.
 * Each field knows how to render its current value and how to edit it.
 */
interface ProfileField {
	key: string;
	label: string;
	readValue: (p: CompactionProfile) => string;
	edit: (
		ctx: ExtensionCommandContext,
		p: CompactionProfile,
	) => Promise<boolean>;
}

const PROFILE_FIELDS: ProfileField[] = [
	{
		key: "name",
		label: "Profile name",
		readValue: (p) => p.name,
		edit: async (ctx, p) => {
			const val = await ctx.ui.input("Profile name", p.name);
			if (val === undefined) return false;
			if (val.trim()) p.name = val.trim();
			return true;
		},
	},
	{
		key: "model",
		label: "Model",
		readValue: (p) =>
			p.model === "current" ? "Current (Pi's active model)" : p.model,
		edit: async (ctx, p) => {
			// Build list of available models (only those with configured API keys)
			const available = ctx.modelRegistry.getAvailable();
			const modelOptions = [
				`Current (use Pi's active model)${p.model === "current" ? " ✓" : ""}`,
			];
			// Track model labels for reliable reverse-lookup
			const modelLabelToSpec = new Map<string, string>();
			for (const m of available) {
				const spec = `${m.provider}/${m.id}`;
				const label = `  ${spec}`;
				modelLabelToSpec.set(label, spec);
				modelOptions.push(`${label}${p.model === spec ? " ✓" : ""}`);
			}

			const choice = await ctx.ui.select("Select model", modelOptions);
			if (choice === undefined) return false;
			if (choice.startsWith("Current")) {
				p.model = "current";
			} else {
				// Look up by exact label match (no regex parsing needed)
				const trimmed = choice.replace(/ ✓$/, "");
				const spec = modelLabelToSpec.get(trimmed);
				if (spec) {
					p.model = spec as "current" | `${string}/${string}`;
				}
				// If not found by label, fall back to nothing (keep current value)
			}
			return true;
		},
	},
	{
		key: "triggerType",
		label: "Trigger type",
		readValue: (p) => {
			if (!p.trigger?.type) return "(not configured)";
			return TRIGGER_LABELS[p.trigger.type] || p.trigger.type;
		},
		edit: async (ctx, p) => {
			// Ensure trigger object exists (defensive — migration should handle this)
			if (!p.trigger) p.trigger = { type: "context_percent", threshold: 20 };
			const options = (["context_percent", "fixed", "reserve"] as const).map(
				(t) => {
					const label = TRIGGER_LABELS[t];
					const desc = describeTrigger({
						type: t,
						threshold:
							t === "context_percent" ? 20 : t === "fixed" ? 200000 : 10000,
					});
					const checked = t === p.trigger.type ? " ✓" : "";
					return `${label}${checked} — ${desc}`;
				},
			);
			const choice = await ctx.ui.select("Select trigger type", options);
			if (choice === undefined) return false;

			for (const t of ["context_percent", "fixed", "reserve"] as const) {
				if (choice.startsWith(TRIGGER_LABELS[t])) {
					p.trigger.type = t;
					if (t === "context_percent") p.trigger.threshold = 20;
					else if (t === "fixed") p.trigger.threshold = 200000;
					else p.trigger.threshold = 10000;
					return true;
				}
			}
			return false;
		},
	},
	{
		key: "threshold",
		label: "Trigger threshold",
		readValue: (p) => {
			const t = p.trigger;
			if (!t?.type) return "(not configured)";
			switch (t.type) {
				case "context_percent":
					return `${t.threshold}%`;
				case "fixed":
					return `${t.threshold.toLocaleString()} tokens`;
				case "reserve":
					return `${t.threshold.toLocaleString()} tokens reserved`;
			}
		},
		edit: async (ctx, p) => {
			if (!p.trigger) p.trigger = { type: "context_percent", threshold: 20 };
			const hints: Record<TriggerType, string> = {
				context_percent: "Percentage of context window (1-99)",
				fixed: "Absolute token count (min 1,000)",
				reserve: "Minimum tokens to keep free (min 100)",
			};
			const val = await ctx.ui.input(
				hints[p.trigger.type],
				String(p.trigger.threshold),
			);
			if (val === undefined) return false;
			const n = parseInt(val, 10);
			if (isNaN(n)) {
				ctx.ui.notify("Invalid number", "warning");
				return false;
			}
			const err = validateTriggerThreshold(p.trigger.type, n);
			if (err) {
				ctx.ui.notify(err, "warning");
				return false;
			}
			p.trigger.threshold = n;
			return true;
		},
	},
	{
		key: "mechanismType",
		label: "Compression mechanism",
		readValue: (p) => {
			if (!p.mechanism) return "(not configured)";
			return describeMechanism(p.mechanism);
		},
		edit: async (ctx, p) => {
			if (!p.mechanism) p.mechanism = { type: "summarize" };
			const mechTypes: MechanismType[] = [
				"summarize",
				"pass_through",
				"adapter",
			];
			const baseOptions = mechTypes.map((t) => {
				const label = MECHANISM_LABELS[t];
				const checked = t === p.mechanism.type ? " ✓" : "";
				return `${label}${checked}`;
			});
			const choice = await ctx.ui.select(
				"Select compression mechanism",
				baseOptions,
			);
			if (choice === undefined) return false;

			for (const t of mechTypes) {
				if (choice.startsWith(MECHANISM_LABELS[t])) {
					p.mechanism.type = t;
					if (t === "adapter") {
						const adapters = getAllAdapters();
						if (adapters.length > 0) {
							const adpOptions = adapters.map((a) =>
								a.id === p.mechanism.adapterId
									? `✓ ${a.name} — ${a.description}`
									: `  ${a.name} — ${a.description}`,
							);
							const adpChoice = await ctx.ui.select(
								"Select adapter",
								adpOptions,
							);
							if (adpChoice) {
								for (const a of adapters) {
									if (adpChoice.includes(a.name)) {
										p.mechanism.adapterId = a.id;
										break;
									}
								}
							}
						} else {
							ctx.ui.notify(
								"No adapters registered. Install a compatible compaction extension.",
								"warning",
							);
						}
					} else {
						p.mechanism.adapterId = undefined;
					}
					return true;
				}
			}
			return false;
		},
	},
	{
		key: "prompt",
		label: "Custom prompt",
		readValue: (p) =>
			p.prompt
				? p.prompt.slice(0, 60) + (p.prompt.length > 60 ? "…" : "")
				: "(default)",
		edit: async (ctx, p) => {
			const val = await ctx.ui.editor(
				"Custom compaction prompt (leave empty for default)",
				p.prompt,
			);
			if (val === undefined) return false;
			p.prompt = val.trim();
			return true;
		},
	},
	{
		key: "autoContinue",
		label: "Auto-continue",
		readValue: (p) => (p.autoContinue ? "Yes" : "No"),
		edit: async (ctx, p) => {
			const val = await ctx.ui.confirm(
				"Auto-continue after compaction?",
				`Current: ${p.autoContinue ? "Yes" : "No"}`,
			);
			if (val === undefined) return false;
			p.autoContinue = val;
			return true;
		},
	},
	{
		key: "autoContinueMessage",
		label: "Continue message",
		readValue: (p) =>
			p.autoContinue ? `"${p.autoContinueMessage}"` : "(disabled)",
		edit: async (ctx, p) => {
			const val = await ctx.ui.input(
				"Auto-continue message",
				p.autoContinueMessage || DEFAULT_AUTO_CONTINUE_MESSAGE,
			);
			if (val === undefined) return false;
			p.autoContinueMessage = val.trim() || DEFAULT_AUTO_CONTINUE_MESSAGE;
			return true;
		},
	},
];

/**
 * Inline field editor for a profile.
 * Changes are saved immediately when any field is edited.
 * No explicit save/cancel — just "← 返回" to go back.
 */
async function editProfileFieldsInPlace(
	ctx: ExtensionCommandContext,
	profile: CompactionProfile,
	profileId: string,
): Promise<void> {
	let editing = true;

	while (editing) {
		// Build field list: each option shows "key: value"
		const fieldOptions = PROFILE_FIELDS.map(
			(f) => `${f.label.padEnd(24)} ${f.readValue(profile)}`,
		);
		fieldOptions.push("───", "← 返回");

		const title = [
			`编辑 Profile: ${profile.name}`,
			"(↑↓ 选择字段, Enter 编辑, 修改即时保存)",
			"",
		].join("\n");

		const choice = await ctx.ui.select(title, fieldOptions);

		if (!choice || choice === "← 返回") {
			editing = false;
			break;
		}

		if (choice === "───") continue;

		// Find which field was selected
		const idx = fieldOptions.indexOf(choice);
		if (idx < 0 || idx >= PROFILE_FIELDS.length) continue;

		const field = PROFILE_FIELDS[idx];
		const changed = await field.edit(ctx, profile);
		if (changed) {
			// Save immediately on each field edit
			profile.id = profileId;
			const ok = upsertProfile(profile);
			if (ok) {
				ctx.ui.notify(`"${field.label}" → 已保存`, "info");
			} else {
				ctx.ui.notify(`"${field.label}" 保存失败`, "error");
			}
		}
	}
}

// ── Profile tree (level 1 + level 2 inline) ─────────────────────

/**
 * Show the profile tree.
 * Level 1: profile names (navigate with ↑↓, details shown as description)
 * Press Enter → enter field-editing mode for the selected profile.
 */
async function openProfileTreeAndEdit(
	ctx: ExtensionCommandContext,
	config: CompactionConfig,
): Promise<void> {
	const entries = Object.entries(config.profiles);
	if (entries.length === 0) {
		ctx.ui.notify("No profiles available", "warning");
		return;
	}

	// Show profiles with descriptions (this is the multi-level tree: level 1 = names, level 2 = details)
	const profileOptions = entries.map(
		([id, p]) =>
			`${id === config.activeProfileId ? "⭐ " : "  "}${p.name} — ${profileDescription(p)}`,
	);

	const chosen = await ctx.ui.select(
		"选择 Profile (Enter 进入编辑, ↑↓ 浏览, 详情见下方)",
		profileOptions,
	);

	if (!chosen) return;

	// Extract the profile ID
	let profileId: string | undefined;
	for (const [id, p] of entries) {
		const prefix = id === config.activeProfileId ? "⭐ " : "  ";
		if (chosen.startsWith(`${prefix}${p.name}`)) {
			profileId = id;
			break;
		}
	}

	if (!profileId) {
		// Fallback by index
		const idx = profileOptions.indexOf(chosen);
		if (idx >= 0 && idx < entries.length) profileId = entries[idx][0];
	}

	if (!profileId || !config.profiles[profileId]) {
		ctx.ui.notify("Profile not found", "warning");
		return;
	}

	// Activate the selected profile first
	if (profileId !== config.activeProfileId) {
		const ok = setActiveProfile(profileId);
		if (ok) {
			ctx.ui.notify(
				`已切换至 Profile: ${config.profiles[profileId].name}`,
				"info",
			);
		}
	}

	// Deep clone the profile for editing
	let workingProfile: CompactionProfile;
	try {
		workingProfile = JSON.parse(JSON.stringify(config.profiles[profileId]));
	} catch {
		ctx.ui.notify("Failed to clone profile", "error");
		return;
	}

	// Enter field editor — changes save immediately, no explicit save step
	await editProfileFieldsInPlace(ctx, workingProfile, profileId);
}

// ── Main panel ──────────────────────────────────────────────────

/**
 * Open the custom-compaction settings panel.
 *
 * Layout:
 * - Top selection bar: "▸ 配置: {label}" — press Enter to open profile tree
 * - Below: current config details
 * - Actions: 关闭
 */
export async function openSettingsPanel(
	ctx: ExtensionCommandContext,
): Promise<void> {
	let navigating = true;

	while (navigating) {
		reloadConfig();
		const config = loadConfig();
		const activePath = getActiveConfigPath();
		const configLabel = getConfigLabel();
		const activeProfile = config.profiles[config.activeProfileId];

		// Details lines
		const details = activeProfile
			? PROFILE_FIELDS.map((f) => `  ${f.label}: ${f.readValue(activeProfile)}`)
			: ["  (no profile)"];

		// Options: first is the selection bar (press Enter to open tree)
		const options = [`▸ 配置: ${configLabel}`, "  关闭"];

		const titleLines = [
			`⚙️  Custom Compaction Settings`,
			`   ${activePath}`,
			"",
			"当前配置:",
			...details,
			"",
		];

		const choice = await ctx.ui.select(titleLines.join("\n"), options);

		if (!choice || choice === "  关闭") {
			navigating = false;
			break;
		}

		if (choice.startsWith("▸ 配置:")) {
			// Open profile tree → user selects a profile → field editor opens
			await openProfileTreeAndEdit(ctx, config);
		}
	}
}
