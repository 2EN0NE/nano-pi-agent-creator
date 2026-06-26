import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { srcLabel, sortGroups, makeUsageColor } from "../utils.js";
import { state, getUsageRatio } from "../state.js";

/** Build the Skills column lines for the widget. */
export function buildSkillsLines(ctx: ExtensionContext): string[] {
	const t = ctx.ui.theme;
	const lines: string[] = [];

	if (state.loadedSkills) {
		lines.push(
			t.fg(
				"accent",
				t.bold(`Skills ${state.xmlSkillCount}/${state.fsSkillCount}`),
			),
		);

		// Recent skills queue
		if (state.recentSkillNames.length > 0) {
			const queueItems = state.recentSkillNames.map((n, idx) => {
				const color = makeUsageColor(getUsageRatio(n));
				const prefix = idx === 0 ? t.fg("accent", "\u25B6") : "";
				return `${prefix}${color(n)}`;
			});
			lines.push(queueItems.join(t.fg("borderMuted", " | ")));
		}

		// Group by source
		const groups = new Map<string, string[]>();
		for (const s of state.loadedSkills) {
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
			lines.push(
				`  ${t.fg("dim", src + "/")} ${t.fg("success", "\u2713")} ${unique.map((n) => makeUsageColor(getUsageRatio(n))(n)).join(", ")}`,
			);
		}
	} else {
		lines.push(t.fg("accent", t.bold("Skills 0")));
		lines.push(t.fg("dim", "(loading...)"));
	}

	return lines;
}
