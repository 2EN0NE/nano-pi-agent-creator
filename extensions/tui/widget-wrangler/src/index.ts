import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIContext,
	ExtensionWidgetOptions,
	WidgetPlacement,
} from "@earendil-works/pi-coding-agent";
import {
	getAgentDir,
	getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	type SettingItem,
	SettingsList,
	Text,
} from "@earendil-works/pi-tui";
import { createLogger } from "@zenone/pi-logger";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const log = createLogger("widget-wrangler");

const CUSTOM_TYPE = "widget-wrangler-config";
const OWN_WIDGET_KEY = "widget-wrangler";
const STATUS_PREFIX = "status:";

function configPath(): string {
	return join(getAgentDir(), "widget-wrangler.json");
}

function loadGlobalConfig(): string[] | null {
	try {
		const raw = readFileSync(configPath(), "utf8");
		const data = JSON.parse(raw) as WranglerState | undefined;
		return Array.isArray(data?.disabled) ? data.disabled : null;
	} catch {
		return null;
	}
}

function saveGlobalConfig(state: WranglerState): boolean {
	try {
		const path = configPath();
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
		renameSync(tmp, path);
		return true;
	} catch (err) {
		log.error("saveGlobalConfig: failed to persist config", err);
		return false;
	}
}

type WidgetContent = Parameters<ExtensionUIContext["setWidget"]>[1];

interface WidgetRecord {
	content: WidgetContent;
	options?: ExtensionWidgetOptions;
	rendered: boolean;
}

interface StatusRecord {
	text: string | undefined;
	rendered: boolean;
}

interface WranglerState {
	disabled: string[];
}

export default function widgetWranglerExtension(pi: ExtensionAPI) {
	const registry = new Map<string, WidgetRecord>();
	const statusRegistry = new Map<string, StatusRecord>();
	const disabled = new Set<string>();
	let originalSetWidget: ExtensionUIContext["setWidget"] | null = null;
	let originalSetStatus: ExtensionUIContext["setStatus"] | null = null;
	let patchedUi: ExtensionUIContext | null = null;

	function persist(): boolean {
		return saveGlobalConfig({ disabled: Array.from(disabled) });
	}

	function restoreConfig(ctx: ExtensionContext) {
		let saved = loadGlobalConfig();
		if (saved === null) {
			const legacy = readLegacyBranchConfig(ctx);
			saved = legacy;
			saveGlobalConfig({ disabled: saved });
		}
		disabled.clear();
		for (const key of saved) disabled.add(key);
	}

	function readLegacyBranchConfig(ctx: ExtensionContext): string[] {
		const entries = ctx.sessionManager.getBranch();
		let saved: string[] | undefined;
		for (const entry of entries) {
			if (entry.type === "custom" && entry.customType === CUSTOM_TYPE) {
				const data = entry.data as WranglerState | undefined;
				if (data?.disabled) saved = data.disabled;
			}
		}
		return saved ?? [];
	}

	function isEnabled(key: string): boolean {
		return !disabled.has(key);
	}

	function applyWidget(key: string) {
		if (!originalSetWidget) return;
		const record = registry.get(key);
		if (!record) return;
		if (isEnabled(key) && record.content !== undefined) {
			originalSetWidget(key, record.content as never, record.options);
			record.rendered = true;
		} else {
			originalSetWidget(key, undefined, record.options);
			record.rendered = false;
		}
	}

	function statusToggleKey(key: string): string {
		return `${STATUS_PREFIX}${key}`;
	}

	function applyStatus(key: string) {
		if (!originalSetStatus) return;
		const record = statusRegistry.get(key);
		if (!record) return;
		if (isEnabled(statusToggleKey(key)) && record.text !== undefined) {
			originalSetStatus(key, record.text);
			record.rendered = true;
		} else {
			originalSetStatus(key, undefined);
			record.rendered = false;
		}
	}

	function forceHideDisabled() {
		if (originalSetWidget) {
			for (const key of disabled) {
				if (key.startsWith(STATUS_PREFIX)) continue;
				if (key === OWN_WIDGET_KEY) continue;
				originalSetWidget(key, undefined);
				const record = registry.get(key);
				if (record) record.rendered = false;
			}
		}
		if (originalSetStatus) {
			for (const key of disabled) {
				if (!key.startsWith(STATUS_PREFIX)) continue;
				const statusKey = key.slice(STATUS_PREFIX.length);
				originalSetStatus(statusKey, undefined);
				const record = statusRegistry.get(statusKey);
				if (record) record.rendered = false;
			}
		}
	}

	function patchSetWidget(ui: ExtensionUIContext) {
		if (patchedUi === ui && originalSetWidget) return;
		originalSetWidget = ui.setWidget.bind(ui);
		patchedUi = ui;

		const wrapped: ExtensionUIContext["setWidget"] = ((
			key: string,
			content: WidgetContent,
			options?: ExtensionWidgetOptions,
		) => {
			if (key === OWN_WIDGET_KEY) {
				originalSetWidget?.(key, content as never, options);
				return;
			}
			if (content === undefined) {
				registry.delete(key);
				originalSetWidget?.(key, undefined, options);
				return;
			}
			const existing = registry.get(key);
			registry.set(key, {
				content,
				options,
				rendered: existing?.rendered ?? false,
			});
			applyWidget(key);
		}) as ExtensionUIContext["setWidget"];

		(ui as { setWidget: ExtensionUIContext["setWidget"] }).setWidget = wrapped;

		originalSetStatus = ui.setStatus.bind(ui);
		const wrappedStatus: ExtensionUIContext["setStatus"] = ((
			key: string,
			text: string | undefined,
		) => {
			if (registry.has(key)) {
				originalSetStatus?.(key, text);
				return;
			}
			if (text === undefined) {
				statusRegistry.delete(key);
				originalSetStatus?.(key, undefined);
				return;
			}
			const existing = statusRegistry.get(key);
			statusRegistry.set(key, { text, rendered: existing?.rendered ?? false });
			applyStatus(key);
		}) as ExtensionUIContext["setStatus"];

		(ui as { setStatus: ExtensionUIContext["setStatus"] }).setStatus =
			wrappedStatus;
	}

	function placementLabel(placement: WidgetPlacement | undefined): string {
		return placement === "belowEditor" ? "below" : "above";
	}

	function buildItems(): SettingItem[] {
		const widgetItems: SettingItem[] = Array.from(registry.keys())
			.sort((a, b) => a.localeCompare(b))
			.map((key) => {
				const record = registry.get(key);
				const enabled = isEnabled(key);
				return {
					id: key,
					label: key,
					description: `widget · ${placementLabel(record?.options?.placement)} editor${record?.content === undefined ? " · idle" : ""}`,
					currentValue: enabled ? "shown" : "hidden",
					values: ["shown", "hidden"],
				};
			});

		const statusItems: SettingItem[] = Array.from(statusRegistry.keys())
			.sort((a, b) => a.localeCompare(b))
			.map((key) => {
				const toggleKey = statusToggleKey(key);
				const record = statusRegistry.get(key);
				const enabled = isEnabled(toggleKey);
				return {
					id: toggleKey,
					label: `${key} (status)`,
					description: `footer status${record?.text === undefined ? " · idle" : ` · "${record?.text}"`}`,
					currentValue: enabled ? "shown" : "hidden",
					values: ["shown", "hidden"],
				};
			});

		return [...widgetItems, ...statusItems];
	}

	function setHidden(key: string, hidden: boolean, ui?: ExtensionUIContext) {
		if (hidden) disabled.add(key);
		else disabled.delete(key);
		if (key.startsWith(STATUS_PREFIX)) {
			applyStatus(key.slice(STATUS_PREFIX.length));
		} else {
			applyWidget(key);
		}
		if (!persist()) {
			ui?.notify(`保存小组件管理配置失败: ${configPath()} 🤠`, "error");
		}
	}

	async function openPanel(ctx: ExtensionContext) {
		if ((ctx as any).mode !== "tui") {
			ctx.ui.notify("小组件管理需要 TUI 模式 🤠", "error");
			return;
		}

		const items = buildItems();
		if (items.length === 0) {
			ctx.ui.notify("还没有发现任何小组件 🤠 — 围栏是空的", "info");
			return;
		}

		await ctx.ui.custom<void>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(
				new Text(
					`${theme.fg("accent", theme.bold("🤠 小组件管理"))}  ${theme.fg("muted", "空格/回车切换 · Esc 关闭")}`,
					1,
					1,
				),
			);

			const settingsList = new SettingsList(
				items,
				Math.min(items.length + 2, 15),
				getSettingsListTheme(),
				(id, newValue) => {
					setHidden(id, newValue === "hidden", ctx.ui);
					tui.requestRender();
				},
				() => done(undefined),
				{ enableSearch: true },
			);
			container.addChild(settingsList);

			return {
				render: (width: number) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					settingsList.handleInput?.(data);
					tui.requestRender();
				},
			};
		});
	}

	pi.registerCommand("wrangle", {
		description: "🤠 管理所有小组件和底部状态栏的显示/隐藏",
		handler: async (_args, ctx) => {
			await openPanel(ctx);
		},
	});

	pi.registerFlag("widget-wrangler-key", {
		description:
			"打开小组件管理面板的快捷键 (如 ctrl+shift+g, alt+w)。空值禁用快捷键。",
		type: "string",
		default: "ctrl+shift+g",
	});

	const shortcutKey = String(pi.getFlag("widget-wrangler-key") ?? "").trim();
	if (shortcutKey) {
		pi.registerShortcut(
			shortcutKey as Parameters<ExtensionAPI["registerShortcut"]>[0],
			{
				description: "🤠 打开小组件管理面板",
				handler: async (ctx) => {
					await openPanel(ctx);
				},
			},
		);
	}

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		patchSetWidget(ctx.ui);
		restoreConfig(ctx);
		forceHideDisabled();
		for (const key of registry.keys()) applyWidget(key);
		for (const key of statusRegistry.keys()) applyStatus(key);
	});

	pi.on("session_tree", (_event, ctx) => {
		if (!ctx.hasUI) return;
		patchSetWidget(ctx.ui);
		restoreConfig(ctx);
		forceHideDisabled();
		for (const key of registry.keys()) applyWidget(key);
		for (const key of statusRegistry.keys()) applyStatus(key);
	});
}
