import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { scanAllResources } from "./scanner.js";
import { srcLabel, srcOrderIndex, wrapLines } from "./utils.js";
import { state } from "./state.js";

/** Build the startup header lines showing all discovered resources. */
function buildHeaderLines(ctx: ExtensionContext): string[] {
	const resources = scanAllResources(ctx);
	const t = ctx.ui.theme;
	const lines: string[] = [];
	lines.push(t.fg("accent", t.bold("Resources Tree")));

	const add = (
		title: string,
		items: { name: string; sourceLabel: string }[],
	) => {
		if (!items.length) return;
		lines.push("");
		lines.push(`  ${t.fg("accent", t.bold(`[${title}]`))}`);
		const g = new Map<string, string[]>();
		for (const i of items) {
			if (!g.has(i.sourceLabel)) g.set(i.sourceLabel, []);
			g.get(i.sourceLabel)!.push(i.name);
		}
		const sorted = [...g.entries()].sort(
			([a], [b]) => srcOrderIndex(a) - srcOrderIndex(b) || a.localeCompare(b),
		);
		for (const [src, names] of sorted) {
			names.sort();
			lines.push(
				`    ${t.fg("dim", src + "/")} ${t.fg("muted", "\u2192")} ${names.join(t.fg("muted", ", "))}`,
			);
		}
	};

	add("Context", resources.context);
	add("Skills", resources.skills);
	add("Extensions", resources.extensions);
	add("Themes", resources.themes);
	lines.push("");
	lines.push(
		t.fg(
			"dim",
			"  esc interrupt \u00B7 ctrl+c/ctrl+d clear/exit \u00B7 / commands",
		),
	);
	return lines;
}

/** Set the startup header component. */
export function setHeader(ctx: ExtensionContext): void {
	try {
		state.cachedHeader = buildHeaderLines(ctx);
	} catch (error) {
		state.cachedHeader = [
			ctx.ui.theme.fg("error", `[resources-tree] ${(error as Error).message}`),
		];
	}
	ctx.ui.setHeader((_tui, _theme) => ({
		render(w: number) {
			return wrapLines(state.cachedHeader, w);
		},
		invalidate() {},
		dispose() {},
	}));
}
