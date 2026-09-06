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
import {
	getSettingsListTheme,
	formatSkillsForPrompt,
	DynamicBorder,
} from '@earendil-works/pi-coding-agent';
import {
	Container,
	type SettingItem,
	SettingsList,
	Text,
	truncateToWidth,
} from '@earendil-works/pi-tui';
import { TitleBar } from '../../../src/tui/helpers.js';
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
	// 待应用的技能覆盖（allSkills 尚未加载时暂存，initialize 后应用）：
	//   null/undefined = 不限制（全部启用）；[] = 全部禁止；非空数组 = 白名单
	let pendingSkillsApply: string[] | null | undefined;

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

	/**
	 * 应用技能覆盖集（供 __skillsApi.replaceSkills 与 initialize 延迟应用共用）。
	 * - null/undefined：不限制（全部启用）
	 * - []：全部禁止
	 * - 非空数组：白名单（只启用列出的，无效名自动过滤）
	 *
	 * 仅写 session entry（跨 reload 保持），不写 config.json——preset 覆盖属会话级
	 * 模型配置，不得污染 /skills 的跨会话持久化配置。
	 */
	function applySkills(skillNames: string[] | null | undefined) {
		if (skillNames == null) {
			enabledSkills = new Set(allSkills.map((s) => s.name));
		} else {
			enabledSkills = new Set(skillNames.filter((n) => allSkills.some((s) => s.name === n)));
		}
		pi.appendEntry<SkillsState>('skills-config', {
			enabledSkills: Array.from(enabledSkills),
		});
		// 通知 preset 即时刷新偏离状态（用户手动改 skills 后「已偏离 skills」立即出现）
		(globalThis as { __presetDriftRefresh?: () => void }).__presetDriftRefresh?.();
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

		// 应用 preset 等扩展在 allSkills 加载前提交的覆盖（延迟应用）
		if (pendingSkillsApply !== undefined) {
			applySkills(pendingSkillsApply);
			pendingSkillsApply = undefined;
		}

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
			const glyph = enabledSkills.has(s.name) ? '• Enabled' : '· Disabled';
			lines.push(`  ${glyph}: ${s.name}`);
		}

		const header =
			changedSkills.length > 0
				? `[Skills] ${enabled}/${total} enabled`
				: `[Skills] ${enabled}/${total} enabled (no changes)`;

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
		description: '启用/禁用技能',
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
					label: `${enabledSkills.has(skill.name) ? '• ' : '  '}${skill.name}`,
					description: skill.description,
					currentValue: '',
					values: [''],
				}));

				const container = new Container();
				container.addChild(
					new TitleBar('技能配置', (s) => theme.fg('accent', theme.bold(s))),
				);
				container.addChild(
					new Text(theme.fg('dim', '  (Enter/Space 开关  ·  Esc/q 关闭)'), 1, 0),
				);
				container.addChild(new Text('', 1, 0));

				const settingsList = new SettingsList(
					items,
					Math.min(items.length + 2, 15),
					getSettingsListTheme(),
					(id, _newValue) => {
						// 锁定守卫（ADR-0035）：传入变更后的启用集，按维度判断是否偏离 preset 设定
						const guard = (
							globalThis as {
								__presetGuard?: {
									canModify: (
										d: string,
										nextValue?: unknown,
									) => { allowed: boolean; reason?: string };
								};
							}
						).__presetGuard;
						if (guard) {
							// 计算变更后的启用集
							const nextSkills = new Set(enabledSkills);
							if (enabledSkills.has(id)) nextSkills.delete(id);
							else nextSkills.add(id);
							const r = guard.canModify('skills', [...nextSkills]);
							if (!r.allowed) {
								ctx.ui.notify(r.reason ?? 'skills 修改不被允许', 'error');
								return;
							}
						}
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
							item.label = `${enabledSkills.has(id) ? '• ' : '  '}${id}`;
						}

						// When disabling a skill, check for related tools
						warningText = '';
						if (wasEnabled) {
							const related = findRelatedTools(id);
							if (related.length > 0) {
								const toolList = related.slice(0, 5).join(', ');
								warningText = `[WARN]  "${id}" 与 tools: ${toolList}${
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
				container.addChild(new DynamicBorder((s) => theme.fg('accent', s)));

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

	// ── AOP 拦截：禁用技能的 /skill:xxx 手动调用 ────────────────────
	// pi 的 skill 命令展开（_expandSkillCommand）不经过任何 enabled 检查，
	// 因此在此通过 input 事件（emitInput 早于 skill 展开，返回 handled 即短路）
	// 拦截被禁用技能的 /skill:xxx 手动调用，与 prompt 过滤形成完整闭环。
	// 注：首次输入早于 before_agent_start（allSkills 未加载）时放行，
	// 之后（已初始化）即可拦截。
	pi.on('input', (event, ctx) => {
		if (!initialized) return;
		const m = event.text.trim().match(/^\/skill:([^\s]+)/);
		if (!m) return;
		const skillName = m[1];

		const known = allSkills.some((s) => s.name === skillName);
		if (known && !enabledSkills.has(skillName)) {
			ctx.ui.notify(`Skill "${skillName}" is disabled per /skills settings.`, 'warning');
			return { action: 'handled' };
		}
	});

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

	// ── External API ────────────────────────────────────────────────
	// 供 preset.ts 等扩展通过 `(globalThis as any).__skillsApi` 调用，控制技能启用集。
	// 与 tools.ts 的 __toolsApi 对齐：挂 globalThis 而非 pi 对象（避免 Proxy/freeze）。
	(globalThis as any).__skillsApi = {
		/**
		 * 完全替换技能启用集。
		 * - 非空数组：白名单（只启用列出的）
		 * - []：全部禁止
		 * - null/undefined：不限制（全部启用）
		 */
		replaceSkills(skillNames: string[] | null | undefined) {
			pendingSkillsApply = skillNames;
			if (allSkills.length > 0) {
				applySkills(skillNames);
				pendingSkillsApply = undefined;
			}
		},
		/** 当前已加载的技能名列表（allSkills 未加载时为空数组）。 */
		getSkillNames(): string[] {
			return allSkills.map((s) => s.name);
		},
		/** 当前启用的技能名列表（preset 偏离检测用）。 */
		getEnabledSkills(): string[] {
			return Array.from(enabledSkills);
		},
	};
}
