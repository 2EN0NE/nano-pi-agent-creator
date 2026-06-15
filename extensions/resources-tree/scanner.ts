import type {
	ExtensionContext,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ResourceItem, SkillEntry } from "./types.js";

// ── Resource Discovery (startup header) ───────────────────────────

function scanDirResources(agentDir: string, label: string): ResourceItem[] {
	const items: ResourceItem[] = [];
	const agentsFile = join(agentDir, "AGENTS.md");
	if (existsSync(agentsFile))
		items.push({
			name: "AGENTS.md",
			type: "context",
			sourceLabel: label,
			path: agentsFile,
		});

	const skillsDir = join(agentDir, "skills");
	if (existsSync(skillsDir)) {
		try {
			for (const e of readdirSync(skillsDir, { withFileTypes: true })) {
				if (e.isDirectory() && existsSync(join(skillsDir, e.name, "SKILL.md")))
					items.push({
						name: e.name,
						type: "skill",
						sourceLabel: label,
						path: join(skillsDir, e.name, "SKILL.md"),
					});
			}
		} catch {
			/* skip */
		}
	}

	const extDir = join(agentDir, "extensions");
	if (existsSync(extDir)) {
		try {
			for (const e of readdirSync(extDir, { withFileTypes: true })) {
				if (e.isFile() && e.name.endsWith(".ts"))
					items.push({
						name: e.name.replace(/\.ts$/, ""),
						type: "extension",
						sourceLabel: label,
						path: join(extDir, e.name),
					});
				else if (e.isDirectory() && !e.name.startsWith(".")) {
					const idx = join(extDir, e.name, "index.ts");
					if (existsSync(idx))
						items.push({
							name: e.name,
							type: "extension",
							sourceLabel: label,
							path: idx,
						});
				}
			}
		} catch {
			/* skip */
		}
	}

	const themesDir = join(agentDir, "themes");
	if (existsSync(themesDir)) {
		try {
			for (const e of readdirSync(themesDir, { withFileTypes: true })) {
				if (e.isFile() && (e.name.endsWith(".json") || e.name.endsWith(".ts")))
					items.push({
						name: e.name.replace(/\.(json|ts)$/, ""),
						type: "theme",
						sourceLabel: label,
						path: join(themesDir, e.name),
					});
			}
		} catch {
			/* skip */
		}
	}
	return items;
}

function resolveNpmPackageDir(pkg: string): string | null {
	const base = join(homedir(), ".pi", "agent", "npm", "node_modules");
	const dir = join(base, pkg);
	if (existsSync(dir)) return dir;
	if (pkg.startsWith("@")) {
		const parts = pkg.split("/");
		if (parts.length === 2) {
			const scoped = join(base, parts[0], parts[1]);
			if (existsSync(scoped)) return scoped;
		}
	}
	return null;
}

function scanNpmPackage(name: string, dir: string): ResourceItem[] {
	const items: ResourceItem[] = [];
	const label = `npm:${name}`;
	try {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			if (e.isFile() && e.name.endsWith(".ts")) {
				const n = e.name.replace(/\.ts$/, "");
				if (n === "index" || n === "types" || n.startsWith("_")) continue;
				items.push({
					name: n,
					type: "extension",
					sourceLabel: label,
					path: join(dir, e.name),
				});
			}
		}
	} catch {
		/* skip */
	}
	const sd = join(dir, "skills");
	if (existsSync(sd)) {
		try {
			for (const e of readdirSync(sd, { withFileTypes: true }))
				if (e.isDirectory() && existsSync(join(sd, e.name, "SKILL.md")))
					items.push({
						name: e.name,
						type: "skill",
						sourceLabel: label,
						path: join(sd, e.name, "SKILL.md"),
					});
		} catch {
			/* skip */
		}
	}
	const td = join(dir, "themes");
	if (existsSync(td)) {
		try {
			for (const e of readdirSync(td, { withFileTypes: true }))
				if (e.isFile() && (e.name.endsWith(".json") || e.name.endsWith(".ts")))
					items.push({
						name: e.name.replace(/\.(json|ts)$/, ""),
						type: "theme",
						sourceLabel: label,
						path: join(td, e.name),
					});
		} catch {
			/* skip */
		}
	}
	return items;
}

function scanNpmPackagesFromSettings(): ResourceItem[] {
	const items: ResourceItem[] = [];
	try {
		const raw = readFileSync(
			join(homedir(), ".pi", "agent", "settings.json"),
			"utf8",
		);
		const settings = JSON.parse(raw);
		for (const pkg of settings.packages ?? []) {
			if (!pkg.startsWith("npm:")) continue;
			const name = pkg.slice(4);
			const dir = resolveNpmPackageDir(name);
			if (dir) items.push(...scanNpmPackage(name, dir));
		}
	} catch {
		/* skip */
	}
	return items;
}

export interface ScannedResources {
	context: ResourceItem[];
	skills: ResourceItem[];
	extensions: ResourceItem[];
	themes: ResourceItem[];
}

export function scanAllResources(ctx: ExtensionContext): ScannedResources {
	const userDir = join(homedir(), ".pi", "agent");
	const projDir = join(ctx.cwd, ".pi");
	const user = scanDirResources(userDir, "~/.pi/agent");
	const project = scanDirResources(projDir, ".pi");
	const npm = scanNpmPackagesFromSettings();

	const byType = (items: ResourceItem[]) => ({
		context: items.filter((i) => i.type === "context"),
		skills: items.filter((i) => i.type === "skill"),
		extensions: items.filter((i) => i.type === "extension"),
		themes: items.filter((i) => i.type === "theme"),
	});

	const u = byType(user);
	const p = byType(project);
	const n = byType(npm);

	return {
		context: [...u.context, ...p.context],
		skills: [...u.skills, ...p.skills, ...n.skills],
		extensions: [...u.extensions, ...p.extensions, ...n.extensions],
		themes: [...u.themes, ...p.themes, ...n.themes],
	};
}

// ── Skills FS loader (widget, before before_agent_start) ──────────

export function loadAllSkillsFromFs(): SkillEntry[] {
	const result: SkillEntry[] = [];

	const userDir = join(homedir(), ".pi", "agent", "skills");
	if (existsSync(userDir)) {
		const loaded = loadSkillsFromDir({ dir: userDir, source: "user" });
		for (const s of loaded.skills) {
			result.push({
				name: s.name,
				filePath: s.filePath,
				sourceInfo: { source: s.sourceInfo.source, scope: s.sourceInfo.scope },
			});
		}
	}

	const projectDir = join(process.cwd(), ".pi", "skills");
	if (existsSync(projectDir)) {
		const loaded = loadSkillsFromDir({ dir: projectDir, source: "project" });
		for (const s of loaded.skills) {
			result.push({
				name: s.name,
				filePath: s.filePath,
				sourceInfo: { source: s.sourceInfo.source, scope: s.sourceInfo.scope },
			});
		}
	}

	const npmRoot = join(homedir(), ".pi", "agent", "npm", "node_modules");
	if (existsSync(npmRoot)) {
		for (const pkg of readdirSync(npmRoot, { withFileTypes: true })) {
			if (!pkg.isDirectory()) continue;
			const skillsDir = join(npmRoot, pkg.name, "skills");
			if (!existsSync(skillsDir)) continue;
			const loaded = loadSkillsFromDir({
				dir: skillsDir,
				source: `npm:${pkg.name}`,
			});
			for (const s of loaded.skills) {
				result.push({
					name: s.name,
					filePath: s.filePath,
					sourceInfo: {
						source: s.sourceInfo.source,
						scope: s.sourceInfo.scope as string | undefined,
					},
				});
			}
		}
	}

	return result;
}
