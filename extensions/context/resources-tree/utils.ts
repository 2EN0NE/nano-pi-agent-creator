import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

/** Map a sourceInfo (source + scope) to a display label. */
export function srcLabel(
	src: string | undefined,
	scope: string | undefined,
): string {
	if (scope === "user") return "~/.pi/agent";
	if (scope === "project") return ".pi";
	if (src?.startsWith("npm:")) return src;
	if (scope === "temporary" && src === "local") return "other";
	if (!src || src === "builtin" || src === "system" || src === "pi")
		return "builtin";
	return src;
}

/** Preferred sort order for source groups. */
export function srcOrderIndex(label: string): number {
	const order = ["builtin", "~/.pi/agent", ".pi"];
	const idx = order.indexOf(label);
	return idx === -1 ? 99 : idx;
}

/**
 * Compute an ANSI 256-color code based on usage ratio.
 * Returns a function that wraps a string in the color.
 */
export function makeUsageColor(ratio: number): (s: string) => string {
	if (ratio <= 0) return (s: string) => s;

	// gray(240) → gray(249) → light yellow(228) → yellow(226) → orange(214) → red(196) → dark red(160)
	let code: number;
	if (ratio > 0.35) code = 160;
	else if (ratio > 0.28) code = 196;
	else if (ratio > 0.22) code = 202;
	else if (ratio > 0.18) code = 208;
	else if (ratio > 0.14) code = 214;
	else if (ratio > 0.1) code = 220;
	else if (ratio > 0.07) code = 226;
	else if (ratio > 0.04) code = 228;
	else if (ratio > 0.02) code = 249;
	else code = 240;

	return (s: string) => `\x1b[38;5;${code}m${s}\x1b[0m`;
}

/** Sort groups by source order, then alphabetically. */
export function sortGroups<T>(groups: Map<string, T[]>): [string, T[]][] {
	return [...groups.entries()].sort(([a], [b]) => {
		const ai = srcOrderIndex(a),
			bi = srcOrderIndex(b);
		if (ai !== bi) return ai - bi;
		return a.localeCompare(b);
	});
}

/** Wrap text lines to fit a given width. */
export function wrapLines(lines: string[], width: number): string[] {
	const r: string[] = [];
	for (const line of lines) r.push(...wrapTextWithAnsi(line, width));
	return r;
}
