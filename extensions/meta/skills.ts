/**
 * Skills Extension
 *
 * Provides a /skills command to enable/disable skills interactively.
 * Skill selection is persisted via @zenone/pi-config (user-level: ~/.pi/agent/extensions-data/skills/config.json,
 * project-level: <cwd>/.pi/extensions-data/skills/config.json) for cross-session
 * persistence, plus session entries for branch navigation within a session.
 * Disabled skills are filtered out of the <available_skills> block in the system prompt.
 * Closing the dialog posts a summary message to the conversation (non-LLM-triggering).
 *
 * Usage:
 * 1. Copy this file to ~/.pi/agent/extensions/ or .pi/extensions/
 * 2. Use /skills to open the skill selector
 * 3. Toggle skills on/off — changes take effect on the next LLM turn
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { getSettingsListTheme, formatSkillsForPrompt } from '@earendil-works/pi-coding-agent';
import { Container, type SettingItem, SettingsList, truncateToWidth } from '@earendil-works/pi-tui';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLogger } from '@zenone/pi-logger';
import { resolveConfigPaths } from '@zenone/pi-config';

const log = createLogger('skills');

// ── State ──────────────────────────────────────────────────────────

interface SkillsState {
	enabledSkills: string[];
}

export default function skillsExtension(pi: ExtensionAPI) {
	log.info('Skills extension loaded');
	let enabledSkills: Set<string> = new Set();
	let allSkills: { name: string; description: string }[] = [];
	let initialized = false;
	let configFilePath: string | undefined;

	// ── File I/O (cross-session persistence) ────────────────────────

	function ensureDir(dir: string) {
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
	}

	function loadFromFile(): string[] | undefined {
		if (!configFilePath) return undefined;
		try {
			if (existsSync(configFilePath)) {
				const data = JSON.parse(readFileSync(configFilePath, 'utf-8')) as SkillsState;
				if (data?.enabledSkills && Array.isArray(data.enabledSkills)) {
					return data.enabledSkills;
				}
			}
		} catch {
			// Corrupt file — treat as missing
		}
		return undefined;
	}

	function saveToFile(enabled: string[]) {
		if (!configFilePath) return;
		try {
			ensureDir(dirname(configFilePath));
			writeFileSync(
				configFilePath,
				JSON.stringify({ enabledSkills: enabled }, null, 2),
				'utf-8',
			);
		} catch {
			// Best-effort: don't crash if file can't be written
		}
	}

	// ── State management ───────────────────────────────────────────

	function mergeSavedSkills(
		fileSkills: string[] | undefined,
		branchSkills: string[] | undefined,
	) {
		const saved = branchSkills ?? fileSkills;
		if (saved) {
			const allSkillNames = new Set(allSkills.map((s) => s.name));
			enabledSkills = new Set(saved.filter((s) => allSkillNames.has(s)));
		} else {
			enabledSkills = new Set(allSkills.map((s) => s.name));
		}
	}

	function persistState() {
		const enabled = Array.from(enabledSkills);
		// Session entries: branch-aware within-session navigation
		pi.appendEntry<SkillsState>('skills-config', {
			enabledSkills: enabled,
		});
		// Config file: cross-session persistence
		saveToFile(enabled);
	}

	function getBranchSkills(ctx: ExtensionContext): string[] | undefined {
		const branchEntries = ctx.sessionManager.getBranch();
		for (const entry of branchEntries) {
			if (entry.type === 'custom' && entry.customType === 'skills-config') {
				const data = entry.data as SkillsState | undefined;
				if (data?.enabledSkills) {
					return data.enabledSkills;
				}
			}
		}
		return undefined;
	}

	function initialize(ctx: ExtensionContext) {
		if (initialized) return;
		initialized = true;

		if (!configFilePath) {
			configFilePath = resolveConfigPaths('skills', { cwd: ctx.cwd }).projectFile;
		}

		const fileSkills = loadFromFile();
		const branchSkills = getBranchSkills(ctx);
		mergeSavedSkills(fileSkills, branchSkills);
		log.info('Skills: initialized, %d skills enabled', enabledSkills.size);
	}

	// ── Deduplicate skills by name (same skill may load from multiple sources) ──

	function dedupeSkills(
		list: { name: string; description: string }[],
	): { name: string; description: string }[] {
		const seen = new Set<string>();
		return list.filter((s) => {
			if (seen.has(s.name)) return false;
			seen.add(s.name);
			return true;
		});
	}

	// ── Summary message ─────────────────────────────────────────────

	function sendSummary(changedSkills: { name: string; description: string }[]) {
		const total = allSkills.length;
		const enabled = enabledSkills.size;
		const lines: string[] = [];

		for (const s of changedSkills) {
			const glyph = enabledSkills.has(s.name) ? '● Enabled' : '○ Disabled';
			lines.push(`  ${glyph}: ${s.name}`);
		}

		const header =
			changedSkills.length > 0
				? `⚙  Skills: ${enabled}/${total} enabled`
				: `⚙  Skills: ${enabled}/${total} enabled (no changes)`;

		pi.sendMessage(
			{
				customType: 'skills-summary',
				content: `${header}\n${lines.join('\n')}`,
				display: true,
				details: {
					enabledCount: enabled,
					totalCount: total,
					changed: changedSkills.map((s) => ({
						name: s.name,
						enabled: enabledSkills.has(s.name),
					})),
				},
			},
			{ triggerTurn: false },
		);
	}

	// ── Command ─────────────────────────────────────────────────────

	pi.registerCommand('skills', {
		description: 'Enable/disable skills',
		handler: async (_args, ctx) => {
			if (ctx.mode !== 'tui') {
				ctx.ui.notify('/skills requires TUI mode', 'error');
				return;
			}

			const options = ctx.getSystemPromptOptions();
			const skills = (options.skills || []).map((s) => ({
				name: s.name,
				description: s.description,
			}));

			if (skills.length === 0) {
				ctx.ui.notify('No skills loaded', 'warning');
				return;
			}

			allSkills = dedupeSkills(skills);
			initialize(ctx);

			// ── Build tool name list for fuzzy matching ──
			const snippetTools = Object.keys(options.toolSnippets || {});
			const knownTools = [
				// Extension tools not always in toolSnippets
				'send_to_session',
				'list_sessions',
				'get_goal',
				'create_goal',
				'update_goal',
				'signal_loop_success',
				'todo',
				'questionnaire',
				'rg',
				'structured_output',
				'subagent',
				// Merge with active tool snippets
				...snippetTools,
			];

			// ── Fuzzy match: skill name ↔ tool names ──
			function findRelatedTools(skillName: string): string[] {
				const norm = skillName.toLowerCase();
				const forms = [norm, norm.replace(/-/g, '_'), norm.replace(/-/g, '')];
				const genericTools = new Set(['read', 'bash', 'edit', 'write', 'rg']);

				return knownTools.filter((toolName) => {
					if (genericTools.has(toolName)) return false;
					const tn = toolName.toLowerCase();
					return forms.some((form) => {
						// Tool name starts with form
						if (tn.startsWith(form)) return true;
						// Form starts with tool name
						if (form.startsWith(tn)) return true;

						// Part matching: split skill name by dash/underscore
						// e.g. "web-browser" → parts ["web", "browser"]
						// check if any tool starts with a significant part
						const parts = form.split(/[_-]+/);
						return parts.some((part) => part.length > 2 && tn.startsWith(part));
					});
				});
			}

			const beforeSnapshot = new Set(enabledSkills);
			let warningText = '';

			await ctx.ui.custom((tui, theme, _kb, done) => {
				const items: SettingItem[] = skills.map((skill) => ({
					id: skill.name,
					label: `${enabledSkills.has(skill.name) ? '●' : '○'}  ${skill.name}`,
					description: skill.description,
					currentValue: '',
					values: ['●'],
				}));

				const container = new Container();
				container.addChild(
					new (class {
						render(_width: number) {
							return [
								theme.fg('accent', theme.bold('Skill Configuration')),
								theme.fg('dim', '  (Enter/Space toggle  ·  Esc/q close)'),
								'',
							];
						}
						invalidate() {}
					})(),
				);

				const settingsList = new SettingsList(
					items,
					Math.min(items.length + 2, 15),
					getSettingsListTheme(),
					(id, _newValue) => {
						const wasEnabled = enabledSkills.has(id);
						if (wasEnabled) {
							enabledSkills.delete(id);
							log.info('Skills: disabled %s', id);
						} else {
							enabledSkills.add(id);
							log.info('Skills: enabled %s', id);
						}

						const item = items.find((i) => i.id === id);
						if (item) {
							item.label = `${enabledSkills.has(id) ? '●' : '○'}  ${id}`;
						}

						// When disabling a skill, check for related tools
						warningText = '';
						if (wasEnabled) {
							const related = findRelatedTools(id);
							if (related.length > 0) {
								const toolList = related.slice(0, 5).join(', ');
								warningText = `⚠  "${id}" 与 tools: ${toolList}${
									related.length > 5 ? '…' : ''
								} 可能有联动，关闭 skill 不代表禁用这些 tool`;
							}
						}

						persistState();
						tui.requestRender();
					},
					() => {
						warningText = '';
						const changed = allSkills.filter(
							(s) => beforeSnapshot.has(s.name) !== enabledSkills.has(s.name),
						);
						sendSummary(changed);
						done(undefined);
					},
				);

				container.addChild(settingsList);

				const component = {
					render(width: number) {
						const lines = container.render(width);
						if (warningText) {
							lines.push('');
							lines.push(
								theme.fg('warning', truncateToWidth(`  ${warningText}`, width)),
							);
						}
						return lines;
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

	// ── Events ──────────────────────────────────────────────────────

	pi.on('before_agent_start', async (event, ctx) => {
		const systemSkills = event.systemPromptOptions.skills;
		if (!systemSkills || systemSkills.length === 0) return;

		if (!initialized) {
			allSkills = dedupeSkills(
				systemSkills.map((s: { name: string; description: string }) => ({
					name: s.name,
					description: s.description,
				})),
			);
			initialize(ctx);
		}

		if (enabledSkills.size === allSkills.length) return;

		const visibleSkills = systemSkills.filter((s) => enabledSkills.has(s.name));
		const fullXml = formatSkillsForPrompt(systemSkills);
		const filteredXml = formatSkillsForPrompt(visibleSkills);

		if (fullXml) {
			// Replace the <available_skills> XML block using regex, which is
			// robust against ordering differences between the prompt and the
			// output of formatSkillsForPrompt (exact string match can fail
			// when the skill arrays are sorted differently).
			let newPrompt = event.systemPrompt.replace(fullXml, filteredXml);
			if (newPrompt === event.systemPrompt) {
				// Exact match failed — fall back to regex-based replacement
				// of just the <available_skills>…</available_skills> block.
				const filteredBlock = filteredXml.match(
					/<available_skills>[\s\S]*<\/available_skills>/,
				);
				if (filteredBlock) {
					newPrompt = event.systemPrompt.replace(
						/<available_skills>[\s\S]*?<\/available_skills>/,
						filteredBlock[0],
					);
				}
			}
			if (newPrompt !== event.systemPrompt) {
				return { systemPrompt: newPrompt };
			}
		}
	});

	pi.on('session_start', async () => {
		log.info('Skills: session started');
	});

	pi.on('session_tree', async (_event, ctx) => {
		if (!initialized) return;

		// Re-evaluate on branch navigation: file baseline + branch entries
		if (!configFilePath) {
			configFilePath = resolveConfigPaths('skills', { cwd: ctx.cwd }).projectFile;
		}
		const fileSkills = loadFromFile();
		const branchSkills = getBranchSkills(ctx);
		mergeSavedSkills(fileSkills, branchSkills);
	});
}
