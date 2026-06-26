import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	visibleWidth,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { state } from "../state.js";
import { makeUsageColor } from "../utils.js";
import { buildToolLines } from "./tools.js";
import { buildSkillsLines } from "./skills.js";
import { buildPromptLines } from "./prompt.js";

export const WIDGET_KEY = "resources-tree-tools";

// ── Timer ─────────────────────────────────────────────────────

export function startTimer(ctx: ExtensionContext): void {
	stopTimer();
	if (state.refreshIntervalMs <= 0 || !state.widgetVisible) return;
	state.refreshTimer = setInterval(
		() => updateWidget(ctx),
		state.refreshIntervalMs,
	);
}

export function stopTimer(): void {
	if (state.refreshTimer) {
		clearInterval(state.refreshTimer);
		state.refreshTimer = null;
	}
}

// ── Widget lifecycle ─────────────────────────────────────────

export function updateWidget(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	try {
		const col1 = buildToolLines(ctx);
		const col2 = buildSkillsLines(ctx);
		const col3 = buildPromptLines(ctx);

		ctx.ui.setWidget(WIDGET_KEY, (_tui, _theme) => {
			const theme = _theme as unknown as Theme;
			return {
				render(fullWidth: number) {
					if (state.widgetCollapsed) return renderCollapsed(fullWidth, theme);
					return renderExpanded(col1, col2, col3, fullWidth, theme);
				},
				invalidate() {},
				dispose() {},
			};
		});
	} catch {
		/* silent */
	}
}

export function showWidget(ctx: ExtensionContext): void {
	state.widgetVisible = true;
	updateWidget(ctx);
	startTimer(ctx);
}

export function hideWidget(ctx: ExtensionContext): void {
	state.widgetVisible = false;
	stopTimer();
	ctx.ui.setWidget(WIDGET_KEY, undefined);
}

export function toggleCollapsed(ctx: ExtensionContext): void {
	state.widgetCollapsed = !state.widgetCollapsed;
	updateWidget(ctx);
}

// ── Render helpers ─────────────────────────────────────────────

function usageRatio(name: string): number {
	const count = Math.max(
		state.toolUsageCounts.get(name) ?? 0,
		state.skillUsageCounts.get(name) ?? 0,
	);
	const total = Math.max(state.totalToolCalls, state.totalSkillLoads);
	return total === 0 ? 0 : count / total;
}

function renderCollapsed(fullWidth: number, theme: Theme): string[] {
	const skillCountStr = `${state.xmlSkillCount}/${state.fsSkillCount}`;
	const promptCount = state.loadedContextFiles?.length ?? 0;
	const toolActive = state.pi?.getActiveTools().length ?? 0;
	const toolTotal = state.pi?.getAllTools().length ?? 0;

	const sep = theme.fg("borderMuted", "\u2502");
	const cw = Math.floor((fullWidth - 2) / 3);
	const padTo = (s: string) => {
		const vis = visibleWidth(s);
		return vis > cw
			? truncateToWidth(s, cw, "\u2026")
			: s + " ".repeat(Math.max(0, cw - vis));
	};

	const row1 = `${padTo(theme.fg("accent", `Tools ${toolActive}/${toolTotal}`))}${sep}${padTo(theme.fg("accent", `Skills ${skillCountStr}`))}${sep}${padTo(theme.fg("accent", `Prompt ${promptCount}`))}`;

	const toolsActive =
		state.recentToolNames.length > 0
			? state.recentToolNames
					.map((n, idx) => {
						const c = makeUsageColor(usageRatio(n));
						return `${idx === 0 ? theme.fg("accent", "\u25B6") : ""}${c(n)}`;
					})
					.join(theme.fg("borderMuted", " | "))
			: theme.fg("dim", "(idle)");

	const skillsActive =
		state.recentSkillNames.length > 0
			? state.recentSkillNames
					.map((n, idx) => {
						const c = makeUsageColor(usageRatio(n));
						return `${idx === 0 ? theme.fg("accent", "\u25B6") : ""}${c(n)}`;
					})
					.join(theme.fg("borderMuted", " | "))
			: theme.fg("dim", `${skillCountStr} loaded`);

	const row2 = `${padTo(toolsActive)}${sep}${padTo(skillsActive)}${sep}${padTo(theme.fg("dim", `${promptCount} file(s)`))}`;

	return [
		row1,
		row2,
		theme.fg("dim", "  Ctrl+Shift+Z toggle \u00B7 /resource-tree settings"),
	];
}

function renderExpanded(
	col1: string[],
	col2: string[],
	col3: string[],
	fullWidth: number,
	theme: Theme,
): string[] {
	const sepCount = 2;
	const colWidth = Math.floor((fullWidth - sepCount) / 3);
	const sep = theme.fg("borderMuted", "\u2502");

	const wrap = (lines: string[]) => {
		const r: string[] = [];
		for (const line of lines) r.push(...wrapTextWithAnsi(line, colWidth));
		return r;
	};

	const w1 = wrap(col1);
	const w2 = wrap(col2);
	const w3 = wrap(col3);

	const max = Math.max(w1.length, w2.length, w3.length);
	const result: string[] = [];
	for (let i = 0; i < max; i++) {
		const parts: string[] = [];
		for (const col of [w1, w2, w3]) {
			const line = i < col.length ? col[i] : "";
			const vis = visibleWidth(line);
			const pad =
				vis >= colWidth ? "" : " ".repeat(Math.max(0, colWidth - vis));
			const out =
				vis > colWidth ? truncateToWidth(line, colWidth, "\u2026") : line + pad;
			parts.push(out);
		}
		result.push(parts.join(sep));
	}
	return result;
}
