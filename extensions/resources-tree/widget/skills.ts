import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { srcLabel, sortGroups, makeUsageColor } from "../utils.js";
import { state, getUsageRatio } from "../state.js";

/** Build the Skills column lines for the widget. */
export function buildSkillsLines(ctx: ExtensionContext): string[] {
	const t = ctx.ui.theme;
	const lines: string[] = [];

	if (state.totalSkills) {
		// ── Deduplicate by name for both total and loaded ──
		const totalNames = [...new Set(state.totalSkills.map((s) => s.name))];
		const allNames = state.loadedSkills
			? [...new Set(state.loadedSkills.map((s) => s.name))]
			: null;

		const numerator = allNames !== null ? allNames.length : "?";
		lines.push(
			t.fg("accent", t.bold(`Skills ${numerator}/${totalNames.length}`)),
		);

		// ── Enabled set for ✓/○ distinction ──
		const enabledSet = allNames ? new Set(allNames) : new Set<string>();

		// ── Recent skills queue ──
		if (state.recentSkillNames.length > 0) {
			const queueItems = state.recentSkillNames.map((n, idx) => {
				const color = makeUsageColor(getUsageRatio(n));
				const prefix = idx === 0 ? t.fg("accent", "\u25B6") : "";
				return `${prefix}${color(n)}`;
			});
			lines.push(queueItems.join(t.fg("borderMuted", " | ")));
		}

		// ── Group by source ──
		const groups = new Map<string, string[]>();
		const sourceList = state.loadedSkills ?? state.totalSkills;
		for (const s of sourceList) {
			const label = srcLabel(
				s.sourceInfo?.source,
				(s.sourceInfo as any)?.scope,
			);
			if (!groups.has(label)) groups.set(label, []);
			groups.get(label)!.push(s.name);
		}

		for (const [src, names] of sortGroups(groups)) {
			const unique = [...new Set(names)];
			unique.sort(
				(a, b) =>
					(state.skillUsageCounts.get(b) ?? 0) -
					(state.skillUsageCounts.get(a) ?? 0),
			);

			// Split into enabled and disabled
			const enabled = unique.filter((n) => enabledSet.has(n));
			const disabled = unique.filter((n) => !enabledSet.has(n));

			const parts: string[] = [];
			if (enabled.length > 0) {
				parts.push(
					t.fg("success", "\u2713") +
						" " +
						enabled.map((n) => makeUsageColor(getUsageRatio(n))(n)).join(", "),
				);
			}
			if (disabled.length > 0) {
				parts.push(
					t.fg("dim", "\u25CB") +
						" " +
						disabled.map((n) => makeUsageColor(getUsageRatio(n))(n)).join(", "),
				);
			}

			lines.push(`  ${t.fg("dim", src + "/")} ${parts.join("  ")}`);
		}
	} else {
		lines.push(t.fg("accent", t.bold("Skills 0")));
		lines.push(t.fg("dim", "(loading...)"));
	}

	return lines;
}
