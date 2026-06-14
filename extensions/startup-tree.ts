import { readdirSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	// ── Types ─────────────────────────────────────────────────────

	type ResourceType = "context" | "skill" | "extension" | "theme";

	interface ResourceItem {
		name: string;
		type: ResourceType;
		sourceLabel: string;
		path: string;
	}

	// ── Resource Discovery ────────────────────────────────────────

	function scanDirResources(agentDir: string, label: string): ResourceItem[] {
		const items: ResourceItem[] = [];

		const agentsFile = join(agentDir, "AGENTS.md");
		if (existsSync(agentsFile)) {
			items.push({
				name: "AGENTS.md",
				type: "context",
				sourceLabel: label,
				path: agentsFile,
			});
		}

		const skillsDir = join(agentDir, "skills");
		if (existsSync(skillsDir)) {
			try {
				const entries = readdirSync(skillsDir, { withFileTypes: true });
				for (const entry of entries) {
					if (entry.isDirectory()) {
						const skillFile = join(skillsDir, entry.name, "SKILL.md");
						if (existsSync(skillFile)) {
							items.push({
								name: entry.name,
								type: "skill",
								sourceLabel: label,
								path: skillFile,
							});
						}
					}
				}
			} catch {
				// permission errors
			}
		}

		const extensionsDir = join(agentDir, "extensions");
		if (existsSync(extensionsDir)) {
			try {
				const entries = readdirSync(extensionsDir, { withFileTypes: true });
				for (const entry of entries) {
					if (entry.isFile() && entry.name.endsWith(".ts")) {
						const name = entry.name.replace(/\.ts$/, "");
						items.push({
							name,
							type: "extension",
							sourceLabel: label,
							path: join(extensionsDir, entry.name),
						});
					} else if (entry.isDirectory() && !entry.name.startsWith(".")) {
						const indexFile = join(extensionsDir, entry.name, "index.ts");
						if (existsSync(indexFile)) {
							items.push({
								name: entry.name,
								type: "extension",
								sourceLabel: label,
								path: indexFile,
							});
						}
					}
				}
			} catch {
				// permission errors
			}
		}

		const themesDir = join(agentDir, "themes");
		if (existsSync(themesDir)) {
			try {
				const entries = readdirSync(themesDir, { withFileTypes: true });
				for (const entry of entries) {
					if (
						entry.isFile() &&
						(entry.name.endsWith(".json") || entry.name.endsWith(".ts"))
					) {
						const name = entry.name.replace(/\.(json|ts)$/, "");
						items.push({
							name,
							type: "theme",
							sourceLabel: label,
							path: join(themesDir, entry.name),
						});
					}
				}
			} catch {
				// permission errors
			}
		}

		return items;
	}

	function resolveNpmPackageDir(pkgName: string): string | null {
		const base = join(homedir(), ".pi", "agent", "npm", "node_modules");
		const pkgDir = join(base, pkgName);
		if (existsSync(pkgDir)) return pkgDir;

		if (pkgName.startsWith("@")) {
			const parts = pkgName.split("/");
			if (parts.length === 2) {
				const scopedDir = join(base, parts[0], parts[1]);
				if (existsSync(scopedDir)) return scopedDir;
			}
		}

		return null;
	}

	function scanNpmPackage(pkgName: string, pkgDir: string): ResourceItem[] {
		const items: ResourceItem[] = [];
		const label = `npm:${pkgName}`;

		try {
			const entries = readdirSync(pkgDir, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.isFile() && entry.name.endsWith(".ts")) {
					const name = entry.name.replace(/\.ts$/, "");
					if (name === "index" || name === "types" || name.startsWith("_"))
						continue;
					items.push({
						name,
						type: "extension",
						sourceLabel: label,
						path: join(pkgDir, entry.name),
					});
				}
			}
		} catch {
			// skip unreadable packages
		}

		const skillsDir = join(pkgDir, "skills");
		if (existsSync(skillsDir)) {
			try {
				const skillEntries = readdirSync(skillsDir, { withFileTypes: true });
				for (const entry of skillEntries) {
					if (entry.isDirectory()) {
						const skillFile = join(skillsDir, entry.name, "SKILL.md");
						if (existsSync(skillFile)) {
							items.push({
								name: entry.name,
								type: "skill",
								sourceLabel: label,
								path: skillFile,
							});
						}
					}
				}
			} catch {
				// skip
			}
		}

		const themesDir = join(pkgDir, "themes");
		if (existsSync(themesDir)) {
			try {
				const themeEntries = readdirSync(themesDir, { withFileTypes: true });
				for (const entry of themeEntries) {
					if (
						entry.isFile() &&
						(entry.name.endsWith(".json") || entry.name.endsWith(".ts"))
					) {
						const name = entry.name.replace(/\.(json|ts)$/, "");
						items.push({
							name,
							type: "theme",
							sourceLabel: label,
							path: join(themesDir, entry.name),
						});
					}
				}
			} catch {
				// skip
			}
		}

		return items;
	}

	function scanNpmPackages(): ResourceItem[] {
		const settingsPath = join(homedir(), ".pi", "agent", "settings.json");
		const items: ResourceItem[] = [];

		try {
			const raw = readFileSync(settingsPath, "utf8");
			const settings = JSON.parse(raw);
			const packages: string[] = settings.packages ?? [];

			for (const pkg of packages) {
				if (!pkg.startsWith("npm:")) continue;
				const pkgName = pkg.slice("npm:".length);
				const pkgDir = resolveNpmPackageDir(pkgName);
				if (pkgDir) {
					const pkgItems = scanNpmPackage(pkgName, pkgDir);
					items.push(...pkgItems);
				}
			}
		} catch {
			// settings might not exist or be unreadable
		}

		return items;
	}

	function scanAllResources(ctx: ExtensionContext): {
		context: ResourceItem[];
		skills: ResourceItem[];
		extensions: ResourceItem[];
		themes: ResourceItem[];
	} {
		const userDir = join(homedir(), ".pi", "agent");
		const projectDir = join(ctx.cwd, ".pi");
		const userItems = scanDirResources(userDir, "~/.pi/agent");
		const projectItems = scanDirResources(projectDir, ".pi");
		const npmItems = scanNpmPackages();

		const groupByType = (items: ResourceItem[]) => {
			const ctx: ResourceItem[] = [];
			const skills: ResourceItem[] = [];
			const ext: ResourceItem[] = [];
			const themes: ResourceItem[] = [];
			for (const item of items) {
				switch (item.type) {
					case "context":
						ctx.push(item);
						break;
					case "skill":
						skills.push(item);
						break;
					case "extension":
						ext.push(item);
						break;
					case "theme":
						themes.push(item);
						break;
				}
			}
			return { context: ctx, skills, extensions: ext, themes };
		};

		const user = groupByType(userItems);
		const project = groupByType(projectItems);
		const npm = groupByType(npmItems);

		return {
			context: [...user.context, ...project.context],
			skills: [...user.skills, ...project.skills, ...npm.skills],
			extensions: [
				...user.extensions,
				...project.extensions,
				...npm.extensions,
			],
			themes: [...user.themes, ...project.themes, ...npm.themes],
		};
	}

	// ── Tree Formatting with ANSI Colors ─────────────────────────

	const srcOrder = ["~/.pi/agent", ".pi"];

	function buildTreeLines(ctx: ExtensionContext): string[] {
		const resources = scanAllResources(ctx);
		const t = ctx.ui.theme;
		const lines: string[] = [];

		// Title
		lines.push("");
		lines.push(t.fg("accent", t.bold("  ═══════════════════╗")));
		lines.push(t.fg("accent", t.bold("  ║  Resources Tree  ║")));
		lines.push(t.fg("accent", t.bold("  ╚═══════════════════╝")));

		const addSection = (title: string, items: ResourceItem[]) => {
			if (items.length === 0) return;

			lines.push("");
			lines.push(`  ${t.fg("accent", t.bold(`[${title}]`))}`);

			const groups = new Map<string, string[]>();
			for (const item of items) {
				if (!groups.has(item.sourceLabel)) groups.set(item.sourceLabel, []);
				groups.get(item.sourceLabel)!.push(item.name);
			}

			const sorted = [...groups.entries()].sort((a, b) => {
				const ai = srcOrder.indexOf(a[0]);
				const bi = srcOrder.indexOf(b[0]);
				if (ai !== -1 && bi !== -1) return ai - bi;
				if (ai !== -1) return -1;
				if (bi !== -1) return 1;
				return a[0].localeCompare(b[0]);
			});

			for (const [source, names] of sorted) {
				names.sort((a, b) => a.localeCompare(b));
				lines.push(
					`    ${t.fg("dim", source + "/")} ${t.fg("muted", "→")} ${names.join(t.fg("muted", ", "))}`,
				);
			}
		};

		addSection("Context", resources.context);
		addSection("Skills", resources.skills);
		addSection("Extensions", resources.extensions);
		addSection("Themes", resources.themes);

		// Footer
		lines.push("");
		lines.push(
			t.fg("dim", "  ───────────────────────────────────────────────────"),
		);
		lines.push(
			t.fg(
				"dim",
				"  esc interrupt  ·  ctrl+c/ctrl+d clear/exit  ·  / commands",
			),
		);

		return lines;
	}

	// ── Show Tree as Custom Header ───────────────────────────────

	let cachedLines: string[] = [];

	function setTreeAsHeader(ctx: ExtensionContext): void {
		try {
			cachedLines = buildTreeLines(ctx);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			cachedLines = [ctx.ui.theme.fg("error", `[startup-tree] Failed: ${msg}`)];
		}

		ctx.ui.setHeader((_tui, _theme) => ({
			render(_width: number) {
				return cachedLines;
			},
			invalidate() {
				// no cached rendering state
			},
			dispose() {
				// nothing to clean up
			},
		}));
	}

	// ── Event: session_start ─────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.hasUI) {
			setTreeAsHeader(ctx);
		}
	});

	// ── Command: /resources ──────────────────────────────────────

	pi.registerCommand("resources", {
		description:
			"Show tree view of loaded resources (Context, Skills, Extensions, Themes) grouped by source directory",
		handler: async (_args, ctx) => {
			setTreeAsHeader(ctx);
		},
	});
}
