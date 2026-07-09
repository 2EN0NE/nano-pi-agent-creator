import type {
	ExtensionContext,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { srcLabel, sortGroups, makeUsageColor } from "../utils.js";
import { state, getUsageRatio } from "../state.js";

/** Build the Tools column lines for the widget. */
export function buildToolLines(ctx: ExtensionContext): string[] {
	const t = ctx.ui.theme;
	if (!state.pi) return [t.fg("dim", "(loading...)")];
	const activeNames = state.pi.getActiveTools();
	const allTools: ToolInfo[] = state.pi.getAllTools();
	const active: ToolInfo[] = [];
	const inactive: ToolInfo[] = [];
	for (const tool of allTools) {
		(activeNames.includes(tool.name) ? active : inactive).push(tool);
	}

	const lines: string[] = [];
	const total = active.length + inactive.length;
	lines.push(t.fg("accent", t.bold(`Tools ${active.length}/${total}`)));

	// Recent tools queue
	if (state.recentToolNames.length > 0) {
		const queueItems = state.recentToolNames.map((n, idx) => {
			const color = makeUsageColor(getUsageRatio(n));
			const prefix = idx === 0 ? t.fg("accent", "\u25B6") : "  ";
			return `${prefix}${color(n)}`;
		});
		lines.push(` ${queueItems.join(t.fg("borderMuted", " | "))}`);
	}

	// Group active tools by source
	const groups = new Map<string, string[]>();
	for (const tool of active) {
		const label = srcLabel(tool.sourceInfo?.source, tool.sourceInfo?.scope);
		if (!groups.has(label)) groups.set(label, []);
		groups.get(label)!.push(tool.name);
	}

	for (const [src, names] of sortGroups(groups)) {
		names.sort(
			(a, b) =>
				(state.toolUsageCounts.get(b) ?? 0) -
				(state.toolUsageCounts.get(a) ?? 0),
		);
		lines.push(
			`  ${t.fg("dim", src + "/")} ${t.fg("success", "\u2713")} ${names.map((n) => makeUsageColor(getUsageRatio(n))(n)).join(", ")}`,
		);
	}

	if (inactive.length) {
		const names = inactive.map((t2) => t2.name).sort();
		lines.push(`${t.fg("warning", "\u2717")} ${names.join(", ")}`);
	}

	return lines;
}
