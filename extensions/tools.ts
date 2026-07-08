/**
 * Tools Extension
 *
 * Provides a /tools command to enable/disable tools interactively.
 * Tool selection persists across session reloads and respects branch navigation.
 *
 * MCP / late-registered tools:
 * - New tools are auto-enabled on first sight (opt-out, not opt-in)
 * - Explicitly disabled tools stay disabled across re-registrations and reloads
 * - The tool_call handler enforces these rules at execution time
 *
 * Usage:
 * 1. Copy this file to ~/.pi/agent/extensions/ or your project's .pi/extensions/
 * 2. Use /tools to open the tool selector
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	type SettingItem,
	SettingsList,
} from "@earendil-works/pi-tui";
import { createLogger } from "@zenone/pi-logger";

const log = createLogger("tools");

log.debug("Extension loaded");

// State persisted to session
interface ToolsState {
	enabledTools: string[];
	/** Tools the user has explicitly disabled — survive reloads */
	disabledTools: string[];
}

export default function toolsExtension(pi: ExtensionAPI) {
	// Track enabled tools
	let enabledTools: Set<string> = new Set();
	/** Tools the user has explicitly disabled */
	let disabledTools: Set<string> = new Set();
	let allTools: ToolInfo[] = [];

	// Persist current state
	function persistState() {
		pi.appendEntry<ToolsState>("tools-config", {
			enabledTools: Array.from(enabledTools),
			disabledTools: Array.from(disabledTools),
		});
	}

	// Apply current tool selection
	function applyTools() {
		pi.setActiveTools(Array.from(enabledTools));
	}

	/**
	 * Call when a genuinely new tool is discovered (not in seenTools, not explicitly disabled).
	 * Auto-enables it and notifies the user.
	 */
	function autoEnableNewTool(toolName: string, ctx?: ExtensionContext) {
		if (disabledTools.has(toolName)) return; // user explicitly disabled it
		enabledTools.add(toolName);
		applyTools();
		persistState();
		log.info("auto-enabled new tool", { tool: toolName });
		if (ctx?.hasUI) {
			ctx.ui.notify(
				`New tool "${toolName}" auto-enabled — use /tools to manage.`,
				"info",
			);
		}
	}

	/**
	 * Auto-enable multiple new tools at once.
	 */
	function autoEnableNewTools(toolNames: string[], ctx?: ExtensionContext) {
		const trulyNew = toolNames.filter((t) => !disabledTools.has(t));
		if (trulyNew.length === 0) return;
		for (const t of trulyNew) enabledTools.add(t);
		applyTools();
		persistState();
		log.info("auto-enabled new tools", { tools: trulyNew });
		if (ctx?.hasUI) {
			ctx.ui.notify(
				`${trulyNew.length} new tool(s) auto-enabled: ${trulyNew.join(", ")}`,
				"info",
			);
		}
	}

	// Find the last tools-config entry in the current branch
	function restoreFromBranch(ctx: ExtensionContext) {
		allTools = pi.getAllTools();

		// Get entries in current branch only
		const branchEntries = ctx.sessionManager.getBranch();
		let savedEnabled: string[] | undefined;
		let savedDisabled: string[] | undefined;

		for (const entry of branchEntries) {
			if (entry.type === "custom" && entry.customType === "tools-config") {
				const data = entry.data as ToolsState | undefined;
				if (data?.enabledTools) {
					savedEnabled = data.enabledTools;
				}
				if (data?.disabledTools) {
					savedDisabled = data.disabledTools;
				}
			}
		}

		// Restore disabled tools (survive reloads)
		if (savedDisabled) {
			disabledTools = new Set(savedDisabled);
		}

		const allToolNames = allTools.map((t) => t.name);

		if (savedEnabled) {
			// Restore saved tool selection (filter to only tools that still exist)
			enabledTools = new Set(
				savedEnabled.filter((t: string) => allToolNames.includes(t)),
			);
			applyTools();
			log.debug("restoreFromBranch: restored from saved state", {
				enabled: enabledTools.size,
				total: allToolNames.length,
				disabled: disabledTools.size,
			});
		} else {
			// No saved state - sync with currently active tools
			enabledTools = new Set(pi.getActiveTools());
			log.debug("restoreFromBranch: initialized from active tools", {
				enabled: enabledTools.size,
				total: allToolNames.length,
			});
		}
	}

	// Register /tools command
	log.debug("registerCommand: tools");
	pi.registerCommand("tools", {
		description: "Enable/disable tools",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/tools requires TUI mode", "error");
				return;
			}

			// Refresh tool list
			allTools = pi.getAllTools();

			// Auto-enable any brand-new tools that appeared since last refresh
			const allToolNames = allTools.map((t) => t.name);
			for (const name of allToolNames) {
				if (!enabledTools.has(name) && !disabledTools.has(name)) {
					enabledTools.add(name);
					log.info("auto-enabled new tool (discovered via /tools)", {
						tool: name,
					});
				}
			}
			if (
				allToolNames.some((n) => !enabledTools.has(n) && !disabledTools.has(n))
			) {
				applyTools();
				persistState();
			}

			await ctx.ui.custom((tui, theme, _kb, done) => {
				// Build settings items for each tool
				const items: SettingItem[] = allTools.map((tool) => {
					// Format source info for display
					const si = tool.sourceInfo;
					let sourceLine = "来源: 未知";

					if (si) {
						const scopeTag =
							si.scope === "project"
								? "[项目]"
								: si.scope === "user"
									? "[用户]"
									: "[内置]";

						if (si.path.startsWith("<builtin:")) {
							sourceLine = `来源: 内置工具 ${scopeTag}`;
						} else {
							// Make path relative if possible
							let displayPath = si.path;
							const cwd = process.cwd();
							const home = process.env.HOME ?? "";
							if (home && si.path.startsWith(home)) {
								displayPath = "~" + si.path.slice(home.length);
							} else if (si.path.startsWith(cwd)) {
								displayPath = "." + si.path.slice(cwd.length);
							}
							sourceLine = `来源: ${displayPath}  ${scopeTag}`;
						}
					}

					// Append tool's own description if available
					const descParts = [sourceLine];
					if (tool.description) {
						descParts.push(`说明: ${tool.description}`);
					}

					return {
						id: tool.name,
						label: tool.name,
						description: descParts.join("\n"),
						currentValue: enabledTools.has(tool.name) ? "enabled" : "disabled",
						values: ["enabled", "disabled"],
					};
				});

				// Exposed helper — returns current enabled tool count vs total
				function getToolCounts() {
					return {
						enabled: enabledTools.size,
						total: allTools.length,
					};
				}

				const container = new Container();

				// Status header showing current enablement
				const statusHeader = new (class {
					render(_width: number) {
						const { enabled, total } = getToolCounts();
						return [
							theme.fg("accent", theme.bold("Tool Configuration")),
							`  ${theme.fg("muted", `Enabled tools: ${enabled}/${total}`)}`,
							"",
						];
					}
					invalidate() {}
				})();
				container.addChild(statusHeader);

				const settingsList = new SettingsList(
					items,
					Math.min(items.length + 2, 15),
					getSettingsListTheme(),
					(id, newValue) => {
						// Update enabled state and apply immediately
						if (newValue === "enabled") {
							enabledTools.add(id);
							disabledTools.delete(id);
						} else {
							enabledTools.delete(id);
							disabledTools.add(id);
						}
						applyTools();
						persistState();
					},
					() => {
						// Log final state on confirm (Esc)
						const { enabled, total } = getToolCounts();
						log.info("tools selection confirmed", {
							enabled,
							total,
							disabled: Array.from(disabledTools),
							enabledTools: Array.from(enabledTools),
						});
						done(undefined);
					},
					{ enableSearch: true },
				);

				container.addChild(settingsList);

				const component = {
					render(width: number) {
						return container.render(width);
					},
					invalidate() {
						container.invalidate();
					},
					handleInput(data: string) {
						settingsList.handleInput?.(data);
						tui.requestRender();
					},
				};

				return component;
			});
		},
	});

	/**
	 * Re-apply restrictions after state changes.
	 *
	 * Strategy:
	 * - Tools in active set but not in enabledTools:
	 *   → If explicitly disabled → re-remove from active (user's choice)
	 *   → Otherwise → auto-enable (genuinely new tool)
	 */
	function reapplyRestrictions(ctx: ExtensionContext) {
		const currentActive = pi.getActiveTools();

		// Split: which are newly discovered vs which were explicitly blocked?
		const newTools = currentActive.filter(
			(t) => !enabledTools.has(t) && !disabledTools.has(t),
		);
		const stale = currentActive.filter(
			(t) => !enabledTools.has(t) && disabledTools.has(t),
		);

		log.debug("reapplyRestrictions: active", {
			activeCount: currentActive.length,
			enabledCount: enabledTools.size,
			disabledCount: disabledTools.size,
			newCount: newTools.length,
			staleCount: stale.length,
		});

		if (newTools.length > 0) {
			autoEnableNewTools(newTools, ctx);
		}

		if (stale.length > 0) {
			log.warn("reapplyRestrictions: blocked re-enabled tools", stale);
			if (ctx.hasUI) {
				ctx.ui.notify(
					`${stale.length} tool(s) were re-enabled but blocked per /tools.`,
					"info",
				);
			}
			applyTools();
		}

		if (newTools.length === 0 && stale.length === 0) {
			log.debug("reapplyRestrictions: all tools in sync — no changes needed");
		}
	}

	/**
	 * Hard block: intercept every tool call.
	 *
	 * - If the tool is not in enabledTools but is valid and NOT explicitly disabled:
	 *   → auto-enable it (was registered after our last scan)
	 * - If the tool is not in enabledTools AND is explicitly disabled:
	 *   → block it with a warning
	 */
	pi.on("tool_call", (_event, ctx) => {
		const event = _event as { toolName?: string };
		const toolName = event.toolName;
		if (!toolName) return;

		if (!enabledTools.has(toolName)) {
			const allToolNames = pi.getAllTools().map((t) => t.name);

			if (!allToolNames.includes(toolName)) {
				// Not a known tool — could be a typo by the LLM, let pi handle it
				return;
			}

			if (!disabledTools.has(toolName)) {
				// Genuinely new tool — auto-enable
				autoEnableNewTool(toolName, ctx);
				return; // allow the call
			}

			// Explicitly disabled — block
			log.info("blocked tool call", {
				tool: toolName,
				enabledCount: enabledTools.size,
			});
			if (ctx.hasUI) {
				ctx.ui.notify(
					`Tool "${toolName}" is disabled per /tools settings.`,
					"warning",
				);
			}
			return {
				block: true,
				reason: `Tool "${toolName}" is disabled by /tools.`,
			};
		}
	});

	// Restore state on session start, then re-apply restrictions
	pi.on("session_start", async (_event, ctx) => {
		log.debug("event: session_start");
		restoreFromBranch(ctx);
		reapplyRestrictions(ctx);
	});

	// Restore state when navigating the session tree, then re-apply restrictions
	pi.on("session_tree", async (_event, ctx) => {
		log.debug("event: session_tree");
		restoreFromBranch(ctx);
		reapplyRestrictions(ctx);
	});
}
