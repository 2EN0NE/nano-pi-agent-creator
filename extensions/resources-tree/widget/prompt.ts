import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { state } from "../state.js";

/** Build the Prompt column lines for the widget. */
export function buildPromptLines(ctx: ExtensionContext): string[] {
	const t = ctx.ui.theme;
	const lines: string[] = [];
	lines.push(t.fg("accent", t.bold("Prompt")));

	if (!state.loadedContextFiles) {
		lines.push("");
		lines.push(t.fg("dim", "  (waiting...)"));
		return lines;
	}

	const groups = new Map<string, string[]>();
	for (const cf of state.loadedContextFiles) {
		const parts = cf.path.split("/");
		const fn = parts.pop()!;
		const parent = parts.join("/");
		const display = parent.startsWith(homedir())
			? parent.replace(homedir(), "~")
			: parent;
		if (!groups.has(display)) groups.set(display, []);
		groups.get(display)!.push(fn);
	}

	for (const [dir, names] of groups) {
		names.sort();
		lines.push("");
		lines.push(`  ${t.fg("dim", dir + "/")}`);
		for (const n of names) lines.push(`  ${t.fg("success", "\u2713")} ${n}`);
	}
	return lines;
}
