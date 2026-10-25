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
import { getSettingsListTheme, DynamicBorder } from '@earendil-works/pi-coding-agent';
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

// ── Prompt 文本兜底（仅当 options.skills 进不了本次请求时使用） ──────

/** 反转 pi 在 `<available_skills>` 里对技能名做的 XML 转义（pi 只转义这 5 个实体）。 */
function decodeXml(s: string): string {
	return s
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, '&');
}

/** 提示词里所有 `<available_skills>` 块广告的技能名（pi 只渲染一块，但兜底不假设数量）。 */
function advertisedSkillNames(text: string): string[] {
	const names: string[] = [];
	for (const block of text.matchAll(/<available_skills>([\s\S]*?)<\/available_skills>/g)) {
		for (const m of block[1].matchAll(/<name>([^<]*)<\/name>/g)) {
			names.push(decodeXml(m[1].trim()));
		}
	}
	return names;
}

/**
 * 从提示词文本里每个 `<skills>` section 中裁掉不在 `visible` 中的技能条目。
 * 返回 null = 文本里没有 `<skills>` section（无从裁剪，交由调用方告警）。
 *
 * ⚠ 替换一律用**函数**形式：字符串形式的 `String.replace` 会展开 `$$` / `$&` / `` $` ``
 * 等替换模式，而 `pruned` 就是整段系统提示词（含 AGENTS.md、自定义 prompt），
 * 其中的 shell 片段会被静默改写。
 */
function pruneSkillsSection(text: string, visible: Set<string>): string | null {
	if (!/<skills>[\s\S]*?<\/skills>/.test(text)) return null;
	return text.replace(/<skills>[\s\S]*?<\/skills>/g, (section) => {
		const pruned = section.replace(/<skill>[\s\S]*?<\/skill>/g, (entry) => {
			const name = /<name>([^<]*)<\/name>/.exec(entry);
			return name && visible.has(decodeXml(name[1].trim())) ? entry : '';
		});
		// 条目全被裁掉时整段移除，避免留下空的 <available_skills></available_skills>
		return /<skill>/.test(pruned) ? pruned : '';
	});
}

// ── State ──────────────────────────────────────────────────────────

interface SkillsState {
	enabledSkills: string[];
}

export default function skillsExtension(pi: ExtensionAPI) {
	log.info('Skills extension loaded');
	let enabledSkills: Set<string> = new Set();
	let allSkills: { name: string; description: string }[] = [];
	/**
	 * `allSkills` 是否已按本会话收集过。
	 * 只有「收集过」时 `getSkillNames()` 才可信——未收集时它返回 []，
	 * 消费方（preset 的陈旧引用检测）必须据此跳过，否则会把技能全判成不存在（ADR-0065）。
	 */
	let skillsKnown = false;
	let initialized = false;
	let configFilePath: string | undefined;
	/**
	 * preset 叠加层（ADR-0049 决策 5）：undefined = 无 overlay（用基础层）；
	 * [] = 全部禁止；非空 = 白名单。preset 不写基础层。
	 */
	let skillsOverlay: string[] | undefined;
	/** allSkills 尚未加载时暂存的 overlay。 */
	let pendingOverlay: string[] | undefined;
	let hasPendingOverlay = false;

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
	 * 有效技能集：overlay 存在时 = overlay ∩ allSkills（封闭集）；否则 = 基础层。
	 */
	function effectiveSkills(): Set<string> {
		if (skillsOverlay !== undefined) {
			return new Set(skillsOverlay.filter((n) => allSkills.some((s) => s.name === n)));
		}
		return enabledSkills;
	}

	/**
	 * 单个技能是否生效。所有「用户可感知」路径（system prompt 过滤、/skill: 拦截、
	 * /skills 面板展示）必须走此函数，保证 preset overlay（ADR-0049 R1）真正生效，
	 * 而不只是被 getEnabledSkills()（偏离检测）读取。
	 */
	function isSkillEnabled(name: string): boolean {
		return effectiveSkills().has(name);
	}

	function refreshDrift() {
		(globalThis as { __presetDriftRefresh?: () => void }).__presetDriftRefresh?.();
	}

	/** 设置 preset 叠加层（不写基础层、不写 session entry）。[] = 全部禁止。 */
	function setOverlay(skillNames: string[]) {
		if (allSkills.length === 0) {
			pendingOverlay = skillNames;
			hasPendingOverlay = true;
			return;
		}
		skillsOverlay = skillNames;
		refreshDrift();
	}

	/** 撤回 preset 叠加层（清除预设）。基础层原样保留。 */
	function clearOverlay() {
		if (allSkills.length === 0) {
			pendingOverlay = undefined;
			hasPendingOverlay = false;
			return;
		}
		skillsOverlay = undefined;
		refreshDrift();
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

		// 应用 preset 等扩展在 allSkills 加载前提交的 overlay（延迟应用）
		if (hasPendingOverlay) {
			skillsOverlay = pendingOverlay;
			pendingOverlay = undefined;
			hasPendingOverlay = false;
		}

		log.info(
			'Skills: initialized, %d skills enabled (overlay=%s)',
			effectiveSkills().size,
			skillsOverlay === undefined ? 'none' : String(skillsOverlay.length),
		);
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
		const enabled = effectiveSkills().size;
		const lines: string[] = [];

		for (const s of changedSkills) {
			const glyph = isSkillEnabled(s.name) ? '• Enabled' : '· Disabled';
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
			skillsKnown = true;
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
					label: `${isSkillEnabled(skill.name) ? '• ' : '  '}${skill.name}`,
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
		if (known && !isSkillEnabled(skillName)) {
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
			skillsKnown = true;
			initialize(ctx);
		}

		// 有效可见集 = 基础层 ∩ preset overlay（ADR-0049 R1/R3）；overlay 存在时
		// preset 是唯一策略源，必须真正作用于 system prompt，而非只影响偏离检测。
		//
		// 主路径（ADR-0066）：`event.systemPromptOptions` 是可变对象，`event.systemPrompt`
		// 是懒渲染（每次读取都从 options 重建）——裁剪 options.skills 后 pi 自己渲染出
		// 新的 <available_skills> 并以 section diff 下发。不要 `return { systemPrompt }`：
		// 那会转成 forceSystemPrompt，把整段提示词钉死、失去 diff（不利于 prompt cache）。
		const visibleSkills = systemSkills.filter((s) => isSkillEnabled(s.name));
		if (visibleSkills.length === systemSkills.length) return;

		event.systemPromptOptions.skills = visibleSkills;
		const visibleNames = new Set(visibleSkills.map((s) => s.name));

		// 兜底：若提示词快照里仍广告着被禁技能，说明 options.skills 进不了本次请求。
		// 两种成因：① 更早的 handler 返回过 `{ systemPrompt }`（forceSystemPrompt 会在
		// 发请求前整段覆盖 sections，早于本 handler 的 force 会拿到未过滤的快照）；
		// ② 基座的 systemPrompt 是静态快照，不回渲染 options。两者都与注册顺序有关，
		// 故不能只依赖主路径——preset 的 skills 白名单是硬策略（ADR-0049）。
		const rendered = event.systemPrompt;
		const stale = advertisedSkillNames(rendered).filter((n) => !visibleNames.has(n));
		let path: 'options' | 'force' | 'snapshot' = 'options';
		let forcedPrompt: string | undefined;
		if (stale.length > 0) {
			const pruned = pruneSkillsSection(rendered, visibleNames);
			if (pruned === null) {
				// 无从裁剪：本次提示词里没有 <skills> section。message 里带数字（details 不落盘），
				// 且**不打** path 日志——此时白名单对本次请求并未生效，标任何 path 都是误导。
				log.warn(
					'skills: no <skills> section to prune (visible=%s total=%s stale=%s)',
					visibleSkills.length,
					systemSkills.length,
					stale.join(','),
				);
				return;
			}
			if (event.systemPromptOptions.forceSystemPrompt !== undefined) {
				// 就地改写已被钉死的整段提示词（force 路径下 options 裁剪不参与渲染）
				event.systemPromptOptions.forceSystemPrompt = pruned;
				path = 'force';
			} else {
				// 基座不回渲染 options：沿用旧契约返回改写后的提示词
				path = 'snapshot';
				forcedPrompt = pruned;
			}
		}

		log.info('Skills: prompt skills filtered (path=%s)', path, {
			visible: visibleSkills.length,
			total: systemSkills.length,
			visibleNames: visibleSkills.map((s) => s.name),
		});
		if (forcedPrompt !== undefined) return { systemPrompt: forcedPrompt };
	});

	pi.on('session_start', async () => {
		// 技能清单只能在首次 before_agent_start 里拿到（event.systemPromptOptions.skills）；
		// 在那之前 `getSkillNames()` 不可信，消费方须按 `isLoaded()` 跳过（ADR-0065）。
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
		/** 设置 preset 叠加层（ADR-0049）：非空白名单；[] 全部禁止。不写基础层。 */
		setOverlay(skillNames: string[]) {
			setOverlay(skillNames);
		},
		/** 撤回 preset 叠加层（清除预设）。基础层原样保留。 */
		clearOverlay() {
			clearOverlay();
		},
		/** 兼容旧 API：完全替换基础层启用集。新代码请用 setOverlay/clearOverlay。 */
		replaceSkills(skillNames: string[] | null | undefined) {
			if (skillNames == null) {
				enabledSkills = new Set(allSkills.map((s) => s.name));
			} else {
				enabledSkills = new Set(
					skillNames.filter((n) => allSkills.some((s) => s.name === n)),
				);
			}
			pi.appendEntry<SkillsState>('skills-config', {
				enabledSkills: Array.from(enabledSkills),
			});
			refreshDrift();
		},
		/** 技能名是否已按本会话收集过（false = 未收集，`getSkillNames()` 不可信）。 */
		isLoaded(): boolean {
			return skillsKnown;
		},
		/** 本会话可用的技能名列表。 */
		getSkillNames(): string[] {
			return allSkills.map((s) => s.name);
		},
		/** 当前有效技能名列表（preset 偏离检测用）。 */
		getEnabledSkills(): string[] {
			return Array.from(effectiveSkills());
		},
	};
}
