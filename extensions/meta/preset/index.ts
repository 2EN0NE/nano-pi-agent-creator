/**
 * Preset Extension
 *
 * Allows defining named presets that configure model, thinking level, tools,
 * and system prompt instructions. Presets are defined in JSON config files
 * and can be activated via CLI flag, /preset command, or the selector panel.
 *
 * Config sources (merged by priority: session > project > user, using @zenone/pi-config standard):
 * - session (in-memory only, created via TUI panel; not persisted, cleared on session_shutdown)
 * - ~/.pi/agent/extensions-data/preset/config.json (user global)
 * - <cwd>/.pi/extensions-data/preset/config.json (project-local)
 *
 * There are no built-in default presets — with no config.json, the preset list
 * is empty (ADR-0032).
 *
 * Example config.json:
 * ```json
 * {
 *   "plan": {
 *     "provider": "openai-codex",
 *     "model": "gpt-5.2-codex",
 *     ...
 *   },
 *   "implement": {
 *     "provider": "anthropic",
 *     ...
 *   }
 * }
 * ```
 *
 * Usage:
 * - `pi --preset plan` - start with plan preset
 * - `/preset` - show selector to switch presets mid-session
 * - `/preset implement` - switch to implement preset directly
 * - `alt+. p` - open preset selector panel (fallback: Ctrl+Shift+P)
 *
 * CLI flags always override preset values.
 */

import type { Api, Model } from '@earendil-works/pi-ai/compat';
import {
	type ExtensionAPI,
	type ExtensionContext,
	DynamicBorder,
	ExtensionInputComponent,
	getSettingsListTheme,
	type Theme,
} from '@earendil-works/pi-coding-agent';
import {
	bottomBorder,
	makeThemeColors,
	TitleBar,
	topBorder,
	type StyleFn,
} from '../../../src/tui/helpers.js';
import { createLogger } from '@zenone/pi-logger';
import {
	type Component,
	Container,
	Key,
	matchesKey,
	type SettingItem,
	SettingsList,
	Text,
	type TUI,
	truncateToWidth,
	wrapTextWithAnsi,
} from '@earendil-works/pi-tui';
import { readJsonFile, resolveConfigPaths, writeJsonAtomic } from '@zenone/pi-config';
import { createStateStore } from '@zenone/pi-state';
import { showConfirm, showSelect } from '@zenone/pi-selector';
import { existsSync } from 'node:fs';
// 子模块：工具/技能/命令/prompt 控制（作为 preset 的基础能力，统一注册命令）
import toolsExtension from './tools.js';
import skillsExtension from './skills.js';
import commandsExtension from './commands.js';
import promptEditorExtension from './prompt-editor.js';
import modelExtension, { pickModel } from './model.js';

const log = createLogger('preset');

// Preset configuration
interface Preset {
	/** Provider name (e.g., "anthropic", "openai") */
	provider?: string;
	/** Model ID (e.g., "claude-sonnet-4-5") */
	model?: string;
	/** Thinking level */
	thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
	/** Tools to enable (replaces default set) */
	tools?: string[];
	/**
	 * 技能控制（三态，与 tools 语义不同，见 preset README）：
	 * - 非空数组：白名单（只启用列出的技能）
	 * - []：全部禁止（如 raw-pi 模拟无扩展环境）
	 * - 未配置（undefined）：不限制（不改变技能状态）
	 */
	skills?: string[];
	/** Instructions to append to system prompt */
	instructions?: string;
}

interface PresetsConfig {
	[name: string]: Preset;
}

/**
 * preset 来源（作用域）：会话级（内存，TUI 临时）/ 项目级（项目配置文件）/ 全局级（用户配置文件）。
 * 优先级：session > project > user（同名 shadow）。
 */
export type PresetScope = 'session' | 'project' | 'user';

/** preset 面板可编辑的字段。 */
export type PresetField =
	'name' | 'provider' | 'model' | 'thinkingLevel' | 'tools' | 'skills' | 'instructions';

/** 带来源的 preset 条目。 */
export interface ScopedPreset {
	scope: PresetScope;
	preset: Preset;
}

/** 文件级 preset 分层加载结果（分别保留用户级与项目级，供来源标记与 shadow 判断）。 */
interface FilePresets {
	user: PresetsConfig;
	project: PresetsConfig;
}

/**
 * Load file-level presets from config files (user + project, 不合并).
 * Uses @zenone/pi-config standard paths.
 */
function loadFilePresets(cwd: string): FilePresets {
	const paths = resolveConfigPaths('preset', { cwd });
	const user = (readJsonFile(paths.userFile) as PresetsConfig | null) ?? {};
	const project = (readJsonFile(paths.projectFile) as PresetsConfig | null) ?? {};
	return { user, project };
}

/**
 * 内置默认全局 preset（首次启动且无用户配置时写入用户级 config.json）。
 * 写入后用户可自由修改 config.json，此处仅作为「种子」，不覆盖已有配置。
 */
export const DEFAULT_PRESETS: PresetsConfig = {
	plan: {
		provider: 'cli-proxy-api',
		model: 'deepseek-v4-pro',
		thinkingLevel: 'high',
		tools: ['read', 'grep', 'find', 'ls'],
		instructions:
			'规划模式：仅做调研与规划，绝不修改任何代码、不执行写操作。\n' +
			'- 事实靠探索环境（读代码、文件系统、工具）确认，不臆测。\n' +
			'- 决策类问题一次只问一个，逐个提交用户确认；用户确认共识前不采取任何行动。',
	},
	implement: {
		provider: 'cli-proxy-api',
		model: 'deepseek-v4-pro',
		thinkingLevel: 'medium',
		instructions:
			'实现模式：按 spec/ticket 分步骤实现，遵循 TDD。\n' +
			'- 每步之间做中间验证（类型检查、单元测试）。\n' +
			'- 完成后做端到端集成验证，最后运行完整测试套件一次。\n' +
			'- 交付前自查可观测性与验证方式，确保用户 UAT 一次性通过。',
	},
	raw: {
		tools: ['read', 'bash', 'powershell', 'edit', 'write', 'grep', 'find', 'ls'],
		skills: [],
	},
};

/**
 * 首次启动（用户级 config.json 不存在）时，写入内置默认 preset。
 * 已存在则跳过，尊重用户已有配置（不覆盖、不合并）。
 */
function ensureDefaultPresets(cwd: string): void {
	const paths = resolveConfigPaths('preset', { cwd });
	if (!existsSync(paths.userFile)) {
		writeJsonAtomic(paths.userFile, DEFAULT_PRESETS);
		log.info('已生成默认全局 preset（plan/implement/raw）', { path: paths.userFile });
	}
}

/**
 * 合并三级 preset（纯函数，供测试）：同名 session > project > user（shadow）。
 * 先插入低优先级（user），再覆盖高优先级（project → session）。
 */
export function mergeScopedPresets(
	userPresets: PresetsConfig,
	projectPresets: PresetsConfig,
	sessionPresets: ReadonlyMap<string, Preset>,
): Array<ScopedPreset & { name: string }> {
	const merged = new Map<string, ScopedPreset>();
	for (const [name, preset] of Object.entries(userPresets)) {
		merged.set(name, { scope: 'user', preset });
	}
	for (const [name, preset] of Object.entries(projectPresets)) {
		merged.set(name, { scope: 'project', preset });
	}
	for (const [name, preset] of sessionPresets) {
		merged.set(name, { scope: 'session', preset });
	}
	return [...merged.entries()].map(([name, s]) => ({ name, ...s }));
}

/**
 * 生成复制副本名：`原名-复制`，已存在则递增 `-复制2`、`-复制3`…（纯函数，供测试）。
 */
export function nextCopyName(name: string, exists: (n: string) => boolean): string {
	let copyName = `${name}-复制`;
	let i = 2;
	while (exists(copyName)) {
		copyName = `${name}-复制${i++}`;
	}
	return copyName;
}

/**
 * 将 preset 写入项目级 config.json（读-改-写，保留其他 preset），返回更新后的项目级配置。
 * 纯函数（除文件 IO），供提升（promote）逻辑与测试复用。
 */
export function persistPresetToProject(cwd: string, name: string, preset: Preset): PresetsConfig {
	const paths = resolveConfigPaths('preset', { cwd });
	const projectRaw = (readJsonFile(paths.projectFile) as PresetsConfig | null) ?? {};
	projectRaw[name] = preset;
	writeJsonAtomic(paths.projectFile, projectRaw);
	return projectRaw;
}

/**
 * 将 preset 写入用户级 config.json（读-改-写，保留其他 preset），返回更新后的用户级配置。
 * 与 persistPresetToProject 对称，供 instructions 等多行字段编辑后写回全局级 preset。
 */
export function persistPresetToUser(cwd: string, name: string, preset: Preset): PresetsConfig {
	const paths = resolveConfigPaths('preset', { cwd });
	const userRaw = (readJsonFile(paths.userFile) as PresetsConfig | null) ?? {};
	userRaw[name] = preset;
	writeJsonAtomic(paths.userFile, userRaw);
	return userRaw;
}

interface OriginalState {
	model: Model<Api> | undefined;
	thinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export default function presetExtension(pi: ExtensionAPI) {
	// 子模块：工具/技能/命令/prompt/模型控制（作为 preset 的基础能力，统一注册命令）
	toolsExtension(pi);
	skillsExtension(pi);
	commandsExtension(pi);
	promptEditorExtension(pi);
	modelExtension(pi);

	// 三级来源：会话级（pi-state session 层落盘，跟随 sessionId，/reload 后仍生效）/ 项目级（项目配置文件）/ 全局级（用户配置文件）
	const sessionPresets = new Map<string, Preset>();
	// 会话级 preset 持久化底座（session 层 = ~/.pi/agent/extensions-data/preset/<sessionId>.json）
	const presetStore = createStateStore<{
		presets: Record<string, Preset>;
		activeName: string | null;
	}>({
		pluginName: 'preset',
		defaults: { presets: {}, activeName: null },
	});

	/**
	 * 将 sessionPresets 整体覆盖写回 session 层（read-modify-write 保留未属字段）。
	 * 删除 preset 无法用 upsert 表达（deepMerge 不删 key），故统一走整体覆盖。
	 * 同时写入 activeName（当前选中 preset 名），使选中状态随会话一起持久化
	 * （否则 /reload 后选中状态丢失——之前只在 turn_start 写 entry，选中后未发对话即丢失）。
	 */
	function persistSessionState(): void {
		// 会话 entry 与文件落盘解耦：entry 是工具轴判定「preset 是否涉及过」的唯一判据，
		// 无 session 文件（如 --no-session）时它仍必须写（ADR-0065）。
		pi.appendEntry('preset-state', { name: activePresetName ?? null });
		const sessionFile = presetStore.getPaths().sessionFile;
		if (!sessionFile) return;
		// readJsonFile 对「文件不存在」与「损坏/非对象」都返回 null，须用 existsSync 区分：
		// 文件存在但解析失败时快速失败而非静默清空覆盖，避免丢失已持久化的会话级 preset。
		const existing = readJsonFile(sessionFile);
		if (existing === null && existsSync(sessionFile)) {
			throw new Error(`preset 会话文件损坏，拒绝覆盖以免丢失数据：${sessionFile}`);
		}
		writeJsonAtomic(sessionFile, {
			...(existing ?? {}),
			presets: Object.fromEntries(sessionPresets),
			activeName: activePresetName ?? null,
		});
	}
	let userPresets: PresetsConfig = {};
	let projectPresets: PresetsConfig = {};
	let activePresetName: string | undefined;
	let activePreset: Preset | undefined;
	let originalState: OriginalState | undefined;
	// 缓存最近的 ExtensionContext，供 tools.ts/skills.ts 修改启用集后触发偏离状态即时刷新
	let latestCtx: ExtensionContext | undefined;
	// 跨扩展即时刷新钩子：tools.ts/skills.ts 在 applyTools/applySkills 末尾调用，
	// preset 借此在工具/技能变化时立即更新状态栏「已偏离」括号说明（无需等 turn_start）。
	(globalThis as { __presetDriftRefresh?: () => void }).__presetDriftRefresh = () => {
		if (latestCtx) updateStatus(latestCtx);
	};

	/**
	 * 按优先级（session > project > user）解析一个 preset，返回带来源的条目。
	 */
	function resolveScopedPreset(name: string): ScopedPreset | undefined {
		const session = sessionPresets.get(name);
		if (session) return { scope: 'session', preset: session };
		if (projectPresets[name]) return { scope: 'project', preset: projectPresets[name] };
		if (userPresets[name]) return { scope: 'user', preset: userPresets[name] };
		return undefined;
	}

	/**
	 * 列出所有 preset（合并视图，含来源），同名 session > project > user（shadow）。
	 */
	function listScopedPresets(): Array<ScopedPreset & { name: string }> {
		return mergeScopedPresets(userPresets, projectPresets, sessionPresets);
	}

	/**
	 * 新建会话级 preset（空配置）。重名（任一来源）返回错误消息，成功返回 null。
	 */
	function addSessionPreset(name: string): string | null {
		if (resolveScopedPreset(name)) {
			return `已存在同名 preset：${name}`;
		}
		sessionPresets.set(name, {});
		persistSessionState();
		return null;
	}

	/**
	 * 删除会话级 preset。非会话级返回 false（不可删）。
	 */
	function deleteSessionPreset(name: string): boolean {
		if (!sessionPresets.has(name)) return false;
		sessionPresets.delete(name);
		persistSessionState();
		return true;
	}

	// ── pi-lab 实验接入（record 型：preset-usage，纯使用时长统计）──────────
	// 臂 = preset 名；唯一信号 use_duration_ms（continuous，maximize）。
	// 弱代理：仅反映「用了多久」，不构成满意度因果结论（方案①纯统计）。
	// 切换/清除时结算上一臂停留时长；session_shutdown 结算当前臂。

	let _labRecord: ((armId: string, metrics: Record<string, number>) => Promise<void>) | undefined;
	let _usageArm: string | null = null;
	let _usageArmStartTs: number | null = null;

	function _initUsageExperiment(_ctx: ExtensionContext): void {
		const armIds = listScopedPresets().map((s) => s.name);
		if (armIds.length === 0) {
			_labRecord = undefined;
			return;
		}
		// SAFETY: globalThis.__labApi 由 pi-lab 挂载，缺失时判空降级（弱依赖）。
		const mgr = (
			globalThis as unknown as {
				__labApi?: {
					getExperimentManager?: () => {
						registerWeakExperiment: (def: unknown) => unknown;
					};
				};
			}
		).__labApi?.getExperimentManager?.();
		if (!mgr) {
			_labRecord = undefined;
			return;
		}
		try {
			const exp = mgr.registerWeakExperiment({
				owner: 'preset',
				name: 'preset-usage',
				contextKey: 'global',
				arms: armIds.map((id) => ({ id, label: id })),
				metrics: [
					{
						id: 'use_duration_ms',
						type: 'continuous',
						direction: 'maximize',
						description:
							'使用时长（毫秒）。弱代理：仅反映使用程度，不构成满意度因果结论',
					},
				],
				strategy: 'stable-hash',
			});
			if (exp) {
				_labRecord = (armId, metrics) =>
					(exp as { record: (a: string, o: unknown) => Promise<void> }).record(armId, {
						metrics,
					});
				log.info('Experiment registered: preset/preset-usage');
			} else {
				_labRecord = undefined;
				log.warn('Experiment registration blocked (name conflict): preset-usage');
			}
		} catch (err) {
			log.warn('Failed to register experiment preset-usage', {
				error: err instanceof Error ? err.message : String(err),
			});
			_labRecord = undefined;
		}
	}

	function _settleUsage(): void {
		if (_labRecord && _usageArm && _usageArmStartTs !== null) {
			const dur = Date.now() - _usageArmStartTs;
			void _labRecord(_usageArm, { use_duration_ms: dur });
			log.debug('usage settled', { arm: _usageArm, durMs: dur });
		}
		_usageArm = null;
		_usageArmStartTs = null;
	}

	function _startUsage(armId: string | null): void {
		_settleUsage();
		if (armId) {
			_usageArm = armId;
			_usageArmStartTs = Date.now();
		}
	}

	/**
	 * 设置 / 撤回 tools 叠加层（ADR-0049 决策 5）。preset 不写基础层。
	 * toolNames = null → 撤回 overlay（该维度不限制）。
	 * tools.ts 未加载时退化到 pi.setActiveTools。
	 */
	function applyToolsOverlay(toolNames: string[] | null) {
		const api = (globalThis as any).__toolsApi;
		if (api?.setOverlay && api?.clearOverlay) {
			if (toolNames === null) api.clearOverlay();
			else api.setOverlay(toolNames);
		} else {
			pi.setActiveTools(toolNames ?? pi.getAllTools().map((t) => t.name));
		}
	}

	/**
	 * 设置 / 撤回 skills 叠加层（ADR-0049 决策 5）。
	 * undefined → 撤回 overlay；[] → 全部禁止；非空 → 白名单。
	 */
	function applySkillsOverlay(skills: string[] | undefined) {
		const api = (globalThis as any).__skillsApi;
		if (!api) return;
		if (skills === undefined) api.clearOverlay?.();
		else api.setOverlay?.(skills);
	}

	/** 清除 preset 在 /prompt 留下的 override（切换/清除预设时保证不残留）。 */
	function resetPresetInstructionsOverride() {
		const api = (
			globalThis as {
				__promptEditorApi?: { clearOverride?: (k: string) => boolean };
			}
		).__promptEditorApi;
		api?.clearOverride?.('preset_instructions:preset');
	}

	// Register --preset CLI flag
	pi.registerFlag('preset', {
		description: '要使用的预设配置',
		type: 'string',
	});

	/**
	 * Apply a preset configuration.
	 */
	async function applyPreset(
		name: string,
		preset: Preset,
		ctx: ExtensionContext,
	): Promise<boolean> {
		// Snapshot state before the first preset is applied (i.e. only when transitioning from no-preset)
		if (activePresetName === undefined) {
			originalState = {
				model: ctx.model,
				thinkingLevel: pi.getThinkingLevel(),
			};
		}

		// Apply model if specified
		if (preset.provider && preset.model) {
			const model = ctx.modelRegistry.find(preset.provider, preset.model);
			if (model) {
				const success = await pi.setModel(model);
				if (!success) {
					ctx.ui.notify(
						`Preset "${name}": No API key for ${preset.provider}/${preset.model}`,
						'warning',
					);
				}
			} else {
				ctx.ui.notify(
					`Preset "${name}": Model ${preset.provider}/${preset.model} not found`,
					'warning',
				);
			}
		}

		// Apply thinking level if specified
		if (preset.thinkingLevel) {
			pi.setThinkingLevel(preset.thinkingLevel);
		}

		// Apply tools as preset overlay（ADR-0049）：非空白名单 → 封闭集 overlay；
		// 空数组 / 未配置 → 撤回 overlay（该维度不限制）。不写基础层。
		if (preset.tools !== undefined) {
			const allToolNames = pi.getAllTools().map((t) => t.name);
			const invalidTools = preset.tools.filter((t) => !allToolNames.includes(t));
			if (invalidTools.length > 0) {
				ctx.ui.notify(
					`Preset "${name}": Unknown tools: ${invalidTools.join(', ')}`,
					'warning',
				);
			}
			// overlay 保留**声明名**（非当前已注册集）：白名单是封闭集，未注册名现在
			// 不生效，但一旦运行时注册（org/MCP 等）就按 preset 声明启用。若按「过滤后
			// 空集」回落为 null，会把非空白名单静默降级成「不限制」（ADR-0049 R3）。
			applyToolsOverlay(preset.tools.length > 0 ? preset.tools : null);
		} else {
			// 切换到未声明 tools 的 preset：撤回上一个 preset 的 overlay
			applyToolsOverlay(null);
		}
		// preset 接管工具维度时令 tool-range 实验退避（ADR-0050）
		(globalThis as any).__toolsApi?.clearExperimentInjection?.();

		// Apply skills as preset overlay（ADR-0049）：
		// 非空数组 → 白名单；[] → 全部禁止；未配置 → 撤回 overlay。
		applySkillsOverlay(preset.skills);
		// 切换预设时清除旧的 prompt override，避免抑制新预设的 instructions
		resetPresetInstructionsOverride();

		// Store active preset for system prompt injection
		activePresetName = name;
		activePreset = preset;
		_startUsage(name);
		persistSessionState();
		return true;
	}

	/**
	 * 应用一次选择结果：清除（(none)）或激活某个 preset。
	 * showPresetSelector 面板选择后统一走此入口（ADR-0031）。
	 */
	async function applySelection(name: string | null, ctx: ExtensionContext): Promise<void> {
		if (!name) return;

		if (name === '(none)') {
			// Clear preset and restore original state
			activePresetName = undefined;
			activePreset = undefined;
			_startUsage(null);
			persistSessionState();
			// 撤回 preset 叠加层（基础层原样保留，ADR-0049 决策 5）
			applyToolsOverlay(null);
			applySkillsOverlay(undefined);
			(globalThis as any).__toolsApi?.clearExperimentInjection?.();
			resetPresetInstructionsOverride();
			// model/thinking 恢复进入 preset 前的快照（非工具维度）
			if (originalState) {
				if (originalState.model) {
					await pi.setModel(originalState.model);
				}
				pi.setThinkingLevel(originalState.thinkingLevel);
			}
			ctx.ui.notify('预设已清除，恢复默认值', 'info');
			updateStatus(ctx);
			return;
		}

		const scoped = resolveScopedPreset(name);
		if (scoped) {
			// 陈旧引用：TUI 下先交互式修复，再激活（ADR-0065）
			if (ctx.mode === 'tui') {
				const issues = detectStaleIssues(scoped.preset, ctx);
				if (issues.length > 0) {
					const proceed = await repairStaleRefs(name, scoped.preset, issues, ctx);
					if (!proceed) {
						updateStatus(ctx);
						return;
					}
				}
			}
			await applyPreset(name, scoped.preset, ctx);
			ctx.ui.notify(`预设 "${name}" 已激活`, 'info');
			updateStatus(ctx);
		}
	}

	/**
	 * 单行文本输入（overlay 版）。ctx.ui.input 会 disposeActiveSelector 销毁外层面板，
	 * 嵌套在主面板内不可用；改用 ExtensionInputComponent + overlay:true 覆盖在面板上。
	 * 空输入返回空串（由调用方决定语义），Esc 返回 undefined。
	 */
	async function showTextInput(
		ctx: ExtensionContext,
		title: string,
		prefill?: string,
	): Promise<string | undefined> {
		if (!ctx.hasUI) return undefined;
		return ctx.ui.custom<string | undefined>(
			(tui, _theme, _kb, done) =>
				new ExtensionInputComponent(
					title,
					prefill ?? '',
					(value) => done(value),
					() => done(undefined),
					{ tui },
				),
			{ overlay: true },
		);
	}

	/**
	 * 多选辅助：用 SettingsList（基础工具的 TUI）一次性列出所有选项，
	 * Enter/Space 切换 `•` 启停标记，Esc 完成并返回选中项。
	 * 与 tools/skills 子模块的启停样式统一（custom-session-tree 的 `•` 小圆点）。
	 */
	async function showMultiSelect(
		ctx: ExtensionContext,
		options: string[],
		initial: Set<string>,
		title: string,
	): Promise<string[]> {
		const selected = new Set(initial);
		const result = await ctx.ui.custom<string[]>(
			(tui, theme, _kb, done) => {
				const items: SettingItem[] = options.map((o) => ({
					id: o,
					label: `${selected.has(o) ? '• ' : '  '}${o}`,
					currentValue: '',
					values: [''],
				}));
				const container = new Container();
				container.addChild(new TitleBar(title, (s) => theme.fg('accent', theme.bold(s))));
				container.addChild(
					new Text(theme.fg('dim', '  (Enter/Space 开关 · Esc 完成)'), 1, 0),
				);
				container.addChild(new Text('', 1, 0));
				const settingsList = new SettingsList(
					items,
					Math.min(items.length + 2, 15),
					getSettingsListTheme(),
					(id) => {
						if (selected.has(id)) selected.delete(id);
						else selected.add(id);
						const item = items.find((i) => i.id === id);
						if (item) item.label = `${selected.has(id) ? '• ' : '  '}${id}`;
						tui.requestRender();
					},
					() => done([...selected]),
				);
				container.addChild(settingsList);
				container.addChild(new DynamicBorder((s) => theme.fg('accent', s)));
				return {
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
			},
			{ overlay: true },
		);
		return result;
	}

	/**
	 * Show preset selector UI — master-detail 两级导航面板（ADR-0031）。
	 */
	async function showPresetSelector(ctx: ExtensionContext): Promise<void> {
		const buildItems = (): PresetPanelItem[] => {
			const list = listScopedPresets();
			const items: PresetPanelItem[] = list.map((s) => ({
				name: s.name,
				preset: s.preset,
				scope: s.scope,
				isActive: s.name === activePresetName,
			}));
			items.push({
				name: '(none)',
				preset: null,
				scope: undefined,
				isActive: activePresetName === undefined,
			});
			return items;
		};

		while (true) {
			const items = buildItems();
			if (items.length === 1) {
				// 仅 (none) 项 = 无任何 preset
				ctx.ui.notify(
					'No presets defined. Add presets to extensions-data/preset/config.json',
					'warning',
				);
				return;
			}

			// 初始选中 = 当前激活项（无则第一项）
			const activeIndex = items.findIndex((it) => it.isActive);
			const initialIndex = activeIndex >= 0 ? activeIndex : 0;

			// 面板 actions：连接 UI 与数据层（闭包捕获 ctx + presetExtension 数据）
			const actions: PresetPanelActions = {
				addSessionPreset: (name) => addSessionPreset(name),
				deleteSessionPreset: async (name) => {
					const ok = await showConfirm(
						ctx,
						'删除会话级 preset?',
						`将删除「${name}」（仅本会话生效的临时设定）`,
						'warning',
					);
					if (!ok) return false;
					return deleteSessionPreset(name);
				},
				getItems: buildItems,
				promptName: async (title) => {
					const v = await showTextInput(ctx, title);
					return v ?? null;
				},
				notify: (message, type) => ctx.ui.notify(message, type),
				editField: async (name, field, current) => {
					const isSession = sessionPresets.has(name);
					// 非 name 字段编辑：写回会话级 preset 并落盘（name 分支内部已处理重命名+写回）。
					// 之前只更新面板 items 不写回 sessionPresets，导致编辑丢失（问题1）。
					const commit = (result: { preset: Preset; name?: string }) => {
						if (isSession && field !== 'name') {
							sessionPresets.set(result.name ?? name, result.preset);
							persistSessionState();
						}
						return result;
					};
					switch (field) {
						case 'name': {
							const v = await showTextInput(
								ctx,
								`preset 名称（当前：${name}，直接回车保留）`,
							);
							if (v === undefined) return null;
							const trimmed = v.trim();
							if (!trimmed || trimmed === name) return null;
							if (resolveScopedPreset(trimmed)) {
								ctx.ui.notify(`已存在同名 preset：${trimmed}`, 'error');
								return null;
							}
							sessionPresets.delete(name);
							sessionPresets.set(trimmed, current);
							persistSessionState();
							if (activePresetName === name) {
								activePresetName = trimmed;
							}
							return { preset: current, name: trimmed };
						}
						case 'thinkingLevel': {
							const opts = THINKING_LEVELS.map((l) => ({ value: l, label: l }));
							const v = await showSelect<
								'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
							>(ctx, '选择思考级别', opts);
							if (!v) return null;
							return commit({ preset: { ...current, thinkingLevel: v.value } });
						}
						case 'model': {
							const picked = await pickModel(ctx, {
								provider: current.provider,
								modelId: current.model,
							});
							if (!picked) return null;
							if (
								picked.provider === current.provider &&
								picked.modelId === current.model
							) {
								return { preset: current };
							}
							return commit({
								preset: {
									...current,
									provider: picked.provider,
									model: picked.modelId,
								},
							});
						}
						case 'tools': {
							const allTools = pi.getAllTools().map((t) => t.name);
							const result = await showMultiSelect(
								ctx,
								allTools,
								new Set(current.tools ?? []),
								'选择工具',
							);
							return commit({
								preset: {
									...current,
									tools: result.length > 0 ? result : undefined,
								},
							});
						}
						case 'skills': {
							const allSkills = ((
								globalThis as { __skillsApi?: { getSkillNames?: () => string[] } }
							).__skillsApi?.getSkillNames?.() ?? []) as string[];
							const result = await showMultiSelect(
								ctx,
								allSkills,
								new Set(current.skills ?? allSkills),
								'选择技能',
							);
							let skills: string[] | undefined;
							if (result.length === 0) {
								skills = [];
							} else if (result.length === allSkills.length) {
								skills = undefined;
							} else {
								skills = result;
							}
							return commit({ preset: { ...current, skills } });
						}
						case 'instructions': {
							// 多行文本：单行输入体验差（默认 preset 的 instructions 含 \n），
							// 且 ExtensionInputComponent 的 placeholder 不渲染（无法预填当前值）。
							// 改为关面板后用 ctx.ui.editor（多行 + 预填当前值）编辑。
							return { preset: current, editInstructions: true };
						}
					}
					return null;
				},
				copyToSession: (name) => {
					const scoped = resolveScopedPreset(name);
					if (!scoped || scoped.scope === 'session') return null;
					const copyName = nextCopyName(name, (n) => Boolean(resolveScopedPreset(n)));
					sessionPresets.set(copyName, { ...scoped.preset });
					return copyName;
				},
				promoteToProject: async (name) => {
					const preset = sessionPresets.get(name);
					if (!preset) return false;
					if (projectPresets[name]) {
						const ok = await showConfirm(
							ctx,
							'覆盖项目级 preset?',
							`项目级已存在「${name}」，是否覆盖？`,
							'warning',
						);
						if (!ok) return false;
					}
					projectPresets = persistPresetToProject(ctx.cwd, name, preset);
					sessionPresets.delete(name);
					return true;
				},
			};

			const result = await ctx.ui.custom<string | null | EditInstructionsRequest>(
				(tui, theme, _kb, done) => {
					return new PresetPanelComponent(items, tui, theme, done, initialIndex, actions);
				},
			);

			// 多行 instructions 编辑：关面板后调 ctx.ui.editor（预填当前值），写回后重开面板
			if (isEditInstructionsRequest(result)) {
				const scoped = resolveScopedPreset(result.name);
				if (!scoped) continue;
				const newContent = await ctx.ui.editor(
					`编辑 Instructions: ${result.name}`,
					scoped.preset.instructions ?? '',
				);
				if (newContent === undefined) continue; // Esc 取消，重开面板
				const instructions = newContent.trim() || undefined;
				if (scoped.scope === 'session') {
					sessionPresets.set(result.name, { ...scoped.preset, instructions });
					persistSessionState();
				} else if (scoped.scope === 'project') {
					projectPresets = persistPresetToProject(ctx.cwd, result.name, {
						...scoped.preset,
						instructions,
					});
				} else {
					userPresets = persistPresetToUser(ctx.cwd, result.name, {
						...scoped.preset,
						instructions,
					});
				}
				continue;
			}

			await applySelection(result, ctx);
			return;
		}
	}

	/**
	 * Update status indicator.
	 */
	/**
	 * 过滤出 tools/skills 白名单中实际存在的名称（与 applyPreset/applySkills 的过滤一致）。
	 * 无效名（已改名/已删除）不参与偏离比较与回滚，避免「期望集含无效名」导致永不收敛。
	 */
	function validToolNames(tools: string[]): string[] {
		const all = pi.getAllTools().map((t) => t.name);
		return tools.filter((t) => all.includes(t));
	}

	function validSkillNames(skills: string[]): string[] {
		const api = (globalThis as { __skillsApi?: { getSkillNames?: () => string[] } })
			.__skillsApi;
		const all = api?.getSkillNames?.() ?? [];
		return skills.filter((n) => all.includes(n));
	}

	// ── 陈旧引用（stale reference）：只查本地可用性，不探测上游（ADR-0065）────────
	type StaleDimension = 'tools' | 'skills' | 'model';

	interface StaleIssue {
		dimension: StaleDimension;
		/** 当前值（tool/skill 名，或 `provider/model`）。 */
		value: string;
		reason: string;
		/** 本地可选的替换候选。 */
		candidates: string[];
	}

	const STALE_LABEL: Record<StaleDimension, string> = {
		tools: '工具',
		skills: '技能',
		model: '模型',
	};

	/** 本地可用模型（`provider/model` 形式）。 */
	function availableModelKeys(ctx: ExtensionContext): string[] {
		return ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`);
	}

	/** 该 preset 引用但本地已不存在的项。判定只看本地配置。 */
	function detectStaleIssues(preset: Preset, ctx: ExtensionContext): StaleIssue[] {
		const issues: StaleIssue[] = [];
		const allTools = pi.getAllTools().map((t) => t.name);
		for (const tool of preset.tools ?? []) {
			if (!allTools.includes(tool)) {
				issues.push({
					dimension: 'tools',
					value: tool,
					reason: '本地未注册该工具',
					candidates: allTools,
				});
			}
		}
		// 技能维度只在技能清单已收集时判定：未收集时 `getSkillNames()` 返回 []，
		// 会把 preset 声明的技能全判成「本地不存在」，用户选「移除」即误删配置（ADR-0065）。
		const skillsApi = (
			globalThis as {
				__skillsApi?: { getSkillNames?: () => string[]; isLoaded?: () => boolean };
			}
		).__skillsApi;
		if (skillsApi?.isLoaded?.()) {
			const allSkills = skillsApi.getSkillNames?.() ?? [];
			for (const skill of preset.skills ?? []) {
				if (!allSkills.includes(skill)) {
					issues.push({
						dimension: 'skills',
						value: skill,
						reason: '本地不存在该技能',
						candidates: allSkills,
					});
				}
			}
		}
		if (preset.provider && preset.model) {
			if (!ctx.modelRegistry.find(preset.provider, preset.model)) {
				issues.push({
					dimension: 'model',
					value: `${preset.provider}/${preset.model}`,
					reason: '本地 models 配置里没有该模型/provider',
					candidates: availableModelKeys(ctx),
				});
			}
		}
		return issues;
	}

	/** 在 preset 上就地替换（next=null 表示移除）。 */
	function applyStaleFix(preset: Preset, issue: StaleIssue, next: string | null): void {
		if (issue.dimension === 'tools') {
			preset.tools = (preset.tools ?? [])
				.map((t) => (t === issue.value ? next : t))
				.filter((t): t is string => Boolean(t));
			return;
		}
		if (issue.dimension === 'skills') {
			preset.skills = (preset.skills ?? [])
				.map((s) => (s === issue.value ? next : s))
				.filter((s): s is string => Boolean(s));
			return;
		}
		if (next === null) {
			delete preset.provider;
			delete preset.model;
			return;
		}
		const index = next.indexOf('/');
		preset.provider = index === -1 ? next : next.slice(0, index);
		preset.model = index === -1 ? preset.model : next.slice(index + 1);
	}

	/** 按 preset 的所属层级写回（project/user 落 config.json，session 落会话文件）。 */
	function saveScopedPreset(name: string, preset: Preset, ctx: ExtensionContext): void {
		const scoped = resolveScopedPreset(name);
		if (scoped?.scope === 'project') {
			projectPresets = persistPresetToProject(ctx.cwd, name, preset);
		} else if (scoped?.scope === 'user') {
			userPresets = persistPresetToUser(ctx.cwd, name, preset);
		} else {
			sessionPresets.set(name, preset);
		}
		persistSessionState();
	}

	/**
	 * 陈旧引用交互式修复（ADR-0065）。
	 *
	 * 第一个动作永远是「修改并保存」——逐项从本地候选里挑正确值写回；
	 * 第二个「移除」；第三个「取消」。返回 false = 用户取消，不应继续激活。
	 */
	async function repairStaleRefs(
		name: string,
		preset: Preset,
		issues: StaleIssue[],
		ctx: ExtensionContext,
	): Promise<boolean> {
		const detail = issues
			.map((i) => `${STALE_LABEL[i.dimension]}  ${i.value}  —  ${i.reason}`)
			.join('\n');
		const decision = await showSelect(
			ctx,
			`预设 "${name}" 有 ${issues.length} 项在本地已失效`,
			[
				{
					value: 'fix',
					label: '修改并保存',
					description: '逐项挑选本地可用的正确值，写回该预设',
				},
				{ value: 'remove', label: '移除', description: '删除这些失效项，写回该预设' },
				{ value: 'cancel', label: '取消', description: '不激活，也不修改配置' },
			],
			{ detail, mode: 'warning' },
		);
		if (!decision || decision.value === 'cancel') {
			log.info('stale refs: user cancelled', { preset: name, issues: issues.length });
			return false;
		}

		// 先把所有选择收齐，再统一改 preset：中途取消（Esc）时不能留下"改了一半"的内存状态
		// ——会话级 preset 在下一次 persistSessionState 时会被静默落盘（ADR-0065）。
		const picks: Array<{ issue: StaleIssue; next: string | null }> = [];
		if (decision.value === 'fix') {
			for (const issue of issues) {
				if (issue.candidates.length === 0) {
					ctx.ui.notify(
						`${STALE_LABEL[issue.dimension]} "${issue.value}" 没有本地候选可替换，已保留`,
						'warning',
					);
					continue;
				}
				const picked = await showSelect(
					ctx,
					`修改${STALE_LABEL[issue.dimension]}：${issue.value}（当前值）`,
					issue.candidates.map((c) => ({ value: c, label: c })),
				);
				if (!picked) {
					log.info('stale refs: user cancelled mid-fix, nothing applied', {
						preset: name,
					});
					return false;
				}
				picks.push({ issue, next: picked.value });
			}
		} else {
			for (const issue of issues) picks.push({ issue, next: null });
		}
		for (const { issue, next } of picks) applyStaleFix(preset, issue, next);

		saveScopedPreset(name, preset, ctx);
		log.info('stale refs repaired', {
			preset: name,
			action: decision.value,
			issues: issues.map((i) => `${i.dimension}:${i.value}`),
		});
		return true;
	}

	/**
	 * 检测当前实际状态是否偏离 activePreset 的设定。
	 * 返回偏离维度短名，空数组 = 未偏离。
	 * 用于状态栏「已偏离」括号说明：用户手动改 preset 设定的维度时提示。
	 * 仅提示类别（维度名），不展开具体内容。
	 */
	function detectDrift(ctx: ExtensionContext): string[] {
		if (!activePreset) return [];
		const p = activePreset;
		const drift: string[] = [];
		// model 偏离（preset 指定了 model，但当前 model 不一致）
		if (p.provider && p.model) {
			const m = ctx.model;
			if (!m || m.provider !== p.provider || m.id !== p.model) {
				drift.push('model');
			}
		}
		// thinking 偏离
		if (p.thinkingLevel && pi.getThinkingLevel() !== p.thinkingLevel) {
			drift.push('thinking');
		}
		// tools 偏离（preset 指定了 tools 白名单，当前启用集不一致）。
		// 用有效名过滤后比较：白名单全部无效时 applyPreset 不改变工具状态，不判定偏离。
		if (p.tools && p.tools.length > 0) {
			const expected = validToolNames(p.tools).sort();
			if (expected.length > 0) {
				const active = [...pi.getActiveTools()].sort();
				if (active.join('\u0000') !== expected.join('\u0000')) {
					drift.push('tools');
				}
			}
		}
		// skills 偏离（preset 指定了 skills 白名单/禁止，当前启用集不一致）。
		// 用有效名过滤后比较（[] 仍表示「全部禁止」，过滤后仍是空集）。
		if (p.skills !== undefined) {
			const skillsApi = (
				globalThis as {
					__skillsApi?: { getEnabledSkills?: () => string[] };
				}
			).__skillsApi;
			const active = [...(skillsApi?.getEnabledSkills?.() ?? [])].sort();
			const expected = validSkillNames(p.skills).sort();
			if (active.join('\u0000') !== expected.join('\u0000')) {
				drift.push('skills');
			}
		}
		// instructions 偏离（preset 指定了 instructions，但被 /prompt 覆盖禁用或改内容）
		if (p.instructions) {
			const promptApi = (
				globalThis as {
					__promptEditorApi?: {
						getOverride?: (
							key: string,
						) => { enabled: boolean; content?: string } | undefined;
					};
				}
			).__promptEditorApi;
			const ov = promptApi?.getOverride?.('preset_instructions:preset');
			if (
				ov &&
				(ov.enabled === false ||
					(ov.content !== undefined && ov.content !== p.instructions))
			) {
				drift.push('instructions');
			}
		}
		return drift;
	}

	/** 偏离维度 → 中文标签（notify 用）。 */
	const DIMENSION_LABEL: Record<string, string> = {
		model: '模型',
		thinking: '思考级别',
		tools: '工具',
		skills: '技能',
		instructions: '指令',
	};

	/**
	 * 将单个偏离维度回滚到 preset 设定值（ADR-0035 turn 边界兜底回滚）。
	 * 返回是否真正执行了回滚（false = 该维度无对应回滚手段，跳过）。
	 */
	async function rollbackDimension(dim: string, ctx: ExtensionContext): Promise<boolean> {
		const p = activePreset;
		if (!p) return false;
		switch (dim) {
			case 'model': {
				if (!p.provider || !p.model) return false;
				const m = ctx.modelRegistry.find(p.provider, p.model);
				if (!m) return false;
				await pi.setModel(m);
				return true;
			}
			case 'thinking': {
				if (!p.thinkingLevel) return false;
				pi.setThinkingLevel(p.thinkingLevel);
				return true;
			}
			case 'tools': {
				if (!p.tools || p.tools.length === 0) return false;
				if (validToolNames(p.tools).length === 0) return false;
				const api = (globalThis as { __toolsApi?: { setOverlay?: (t: string[]) => void } })
					.__toolsApi;
				if (!api?.setOverlay) return false;
				// 回滚写入声明名（非「当前已注册」过滤集），保持封闭集语义与 applyPreset 一致。
				api.setOverlay(p.tools);
				return true;
			}
			case 'skills': {
				if (p.skills === undefined) return false;
				const api = (globalThis as { __skillsApi?: { setOverlay?: (s: string[]) => void } })
					.__skillsApi;
				if (!api?.setOverlay) return false;
				// 过滤无效技能名后回滚（[] 仍表示「全部禁止」）。
				api.setOverlay(validSkillNames(p.skills));
				return true;
			}
			case 'instructions': {
				if (!p.instructions) return false;
				const api = (
					globalThis as {
						__promptEditorApi?: { clearOverride?: (k: string) => boolean };
					}
				).__promptEditorApi;
				if (!api?.clearOverride) return false;
				return api.clearOverride('preset_instructions:preset');
			}
			default:
				return false;
		}
	}

	/**
	 * turn 边界兜底回滚（ADR-0049 决策 4）：preset 激活即硬约束；
	 * 前置守卫已拒绝三子工具的写操作，此处兜底「第三方绕过入口直接改状态」的残留偏离。
	 */
	async function rollbackDrift(ctx: ExtensionContext): Promise<void> {
		if (!activePreset || !activePresetName) return;
		const drift = detectDrift(ctx);
		if (drift.length === 0) return;
		for (const dim of drift) {
			const rolledBack = await rollbackDimension(dim, ctx);
			if (rolledBack) {
				const label = DIMENSION_LABEL[dim] ?? dim;
				ctx.ui.notify(`preset 已锁定，「${label}」偏离已被改回`, 'warning');
			}
		}
	}

	function updateStatus(ctx: ExtensionContext) {
		if (activePresetName) {
			const drift = detectDrift(ctx);
			const suffix = drift.length > 0 ? ` (已偏离:${drift.join('/')})` : '';
			ctx.ui.setStatus(
				'preset',
				ctx.ui.theme.fg('accent', `| 预设:${activePresetName}${suffix}`),
			);
		} else {
			ctx.ui.setStatus('preset', undefined);
		}
	}

	log.debug('registerShortcut');
	async function handleShowSelector(ctx: ExtensionContext): Promise<void> {
		await showPresetSelector(ctx);
	}
	// session_start 时注册（消除加载顺序竞险：hub 在所有扩展工厂函数执行后才挂载）
	pi.on('session_start', () => {
		const shortcutHub = (globalThis as any).__shortcutsApi;
		if (shortcutHub?.register) {
			shortcutHub.register({
				name: 'preset',
				keys: ['p'],
				description: '打开 preset 选择面板',
				handler: handleShowSelector,
			});
		} else {
			pi.registerShortcut(Key.ctrlShift('p'), {
				description: '打开 preset 选择面板',
				handler: handleShowSelector,
			});
		}
	});

	// Register /preset command
	log.debug('registerCommand: preset');
	pi.registerCommand('mode', {
		description: '临时切换 model+thinking 组合（会话级，不落盘 preset）',
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			const picked = await pickModel(ctx);
			if (!picked) return;
			const opts = THINKING_LEVELS.map((l) => ({ value: l, label: l }));
			const thinking = await showSelect<
				'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
			>(ctx, '选择思考级别', opts);
			if (!thinking) return;
			const model = ctx.modelRegistry.find(picked.provider, picked.modelId);
			if (model) {
				const success = await pi.setModel(model);
				if (success) {
					pi.setThinkingLevel(thinking.value);
				} else {
					ctx.ui.notify(`No API key for ${picked.provider}/${picked.modelId}`, 'warning');
				}
			}
			// 偏离刷新交给 model_select / thinking_level_select 事件（setModel/setThinkingLevel 会触发）。
			// 此处不手动 updateStatus：setModel 后 ctx.model 尚未更新，手动检测会漏掉 model 偏离。
		},
	});

	pi.registerCommand('preset', {
		description: '切换预设配置',
		handler: async (args, ctx) => {
			// If preset name provided, apply directly
			if (args?.trim()) {
				const name = args.trim();
				const scoped = resolveScopedPreset(name);

				if (!scoped) {
					const available =
						listScopedPresets()
							.map((s) => s.name)
							.join(', ') || '(未定义)';
					ctx.ui.notify(`未知预设 "${name}"。可用：${available}`, 'error');
					return;
				}

				// 走 applySelection：含陈旧引用交互式修复（ADR-0065）
				await applySelection(name, ctx);
				return;
			}

			// Otherwise show selector
			await showPresetSelector(ctx);
		},
	});

	// instructions 改为经 prompt-editor 的 preset_instructions 组件注入（ADR-0035 决策 1）：
	// 本扩展不再在 before_agent_start 直接追加，prompt-editor 的 rebuildPrompt
	// 通过组件追加并支持 /prompt 覆盖。经 globalThis.__presetApi 暴露 instructions，
	// 供 prompt-editor 的 discoverComponents 读取。
	(globalThis as { __presetApi?: { getInstructions?: () => string | null } }).__presetApi = {
		getInstructions: () => activePreset?.instructions ?? null,
	};

	// 子工具锁死（ADR-0049 决策 4）：preset 激活期间，tools/skills/instructions
	// 的写操作一律拒绝并告警；非激活态放行（用户自由维护基础层）。
	(
		globalThis as {
			__presetGuard?: {
				canModify: (
					dimension: string,
					nextValue?: unknown,
				) => { allowed: boolean; reason?: string };
			};
		}
	).__presetGuard = {
		canModify: (dimension: string) => {
			if (!activePreset) return { allowed: true };
			const label = DIMENSION_LABEL[dimension] ?? dimension;
			return {
				allowed: false,
				reason: `preset「${activePresetName ?? ''}」已激活，${label} 修改不被允许（请先编辑或清除预设）`,
			};
		},
	};

	// Initialize on session start
	pi.on('session_start', async (_event, ctx) => {
		log.debug('event: session_start');
		latestCtx = ctx;
		// 首次启动生成默认全局 preset（plan/implement/raw），已存在则跳过
		ensureDefaultPresets(ctx.cwd);

		// Load file-level presets from config files (user + project 分层)
		const filePresets = loadFilePresets(ctx.cwd);
		userPresets = filePresets.user;
		projectPresets = filePresets.project;

		// 读回会话级 preset（session 层落盘，跟随 sessionId，/reload 后仍生效）。
		// 清理过期 session 文件（默认保留 30 天）放在 session_start 而非 shutdown：
		// /reload 会先触发 shutdown，在 shutdown 删会误删当前会话文件。
		const sessionId = ctx.sessionManager?.getSessionId?.();
		let restoredActiveName: string | null = null;
		// session 层是否已有落盘状态：存在时以它的 activeName 为准（含 null = 已清除），
		// 不再回落到旧 preset-state entry（否则 /reload 会复活已清除的 preset，ADR-0049 决策 2）。
		let hasStoredState = false;
		if (sessionId) {
			presetStore.setSessionId(sessionId);
			const sessionFile = presetStore.getPaths().sessionFile;
			hasStoredState = sessionFile ? existsSync(sessionFile) : false;
			presetStore.cleanupExpired();
			const stored = presetStore.get();
			for (const [name, preset] of Object.entries(stored.presets)) {
				sessionPresets.set(name, preset as Preset);
			}
			restoredActiveName = stored.activeName ?? null;
		}

		// 注册使用时长实验（臂 = 当前 preset 名），须在 applyPreset 之前
		_initUsageExperiment(ctx);

		// Check for --preset flag
		const presetFlag = pi.getFlag('preset');
		if (typeof presetFlag === 'string' && presetFlag) {
			const scoped = resolveScopedPreset(presetFlag);
			if (scoped) {
				if (ctx.mode === 'tui') {
					const issues = detectStaleIssues(scoped.preset, ctx);
					if (issues.length > 0) {
						const proceed = await repairStaleRefs(
							presetFlag,
							scoped.preset,
							issues,
							ctx,
						);
						if (!proceed) {
							// 取消 = 本次不激活任何 preset：工具轴必须回到默认工具选择，
							// 否则 pi 从会话记录恢复的旧限制会留在「无 preset」状态里（ADR-0065）。
							applyToolsOverlay(null);
							persistSessionState();
							updateStatus(ctx);
							return;
						}
					}
				}
				await applyPreset(presetFlag, scoped.preset, ctx);
				ctx.ui.notify(`预设 "${presetFlag}" 已激活`, 'info');
			} else {
				const available =
					listScopedPresets()
						.map((s) => s.name)
						.join(', ') || '(未定义)';
				ctx.ui.notify(`未知预设 "${presetFlag}"。可用：${available}`, 'warning');
			}
		}

		// Restore preset from session state
		const entries = ctx.sessionManager.getEntries();
		const presetEntry = entries
			.filter(
				(e: { type: string; customType?: string }) =>
					e.type === 'custom' && e.customType === 'preset-state',
			)
			.pop() as { data?: { name: string } } | undefined;

		// 恢复选中状态：--preset flag 已由 applyPreset 设置 activePresetName；
		// 否则以 session 层 activeName 为准（存在落盘状态时，null = 已清除，不回落到旧 entry）；
		// 仅当 session 层无落盘状态时，才 fallback 到会话 entry（旧机制）。
		const restoreName =
			!presetFlag && activePresetName === undefined
				? hasStoredState
					? restoredActiveName
					: (presetEntry?.data?.name ?? null)
				: null;

		if (restoreName) {
			const scoped = resolveScopedPreset(restoreName);
			if (scoped) {
				activePresetName = restoreName;
				activePreset = scoped.preset;
				_startUsage(restoreName);
				// 三轴 overlay 一致重建（ADR-0049 决策 5 / 修 N4）：tools 封闭集 + skills
				// overlay；instructions 由 activePreset 经 prompt 组件生效。
				// overlay 写声明名（未注册名留待运行时注册后生效），非空白名单不得降级为「不限制」。
				const declaredTools = scoped.preset.tools;
				const validTools = (declaredTools ?? []).filter((t) =>
					pi.getAllTools().some((tt) => tt.name === t),
				);
				applyToolsOverlay(declaredTools && declaredTools.length > 0 ? declaredTools : null);
				applySkillsOverlay(scoped.preset.skills);
				resetPresetInstructionsOverride();
				log.info('preset restored — overlays re-applied', {
					preset: restoreName,
					tools: validTools,
					skills: scoped.preset.skills ?? null,
				});
			} else {
				// activeName 指向已不存在的 preset（如会话级 preset 被删），清空并落盘
				activePresetName = undefined;
				activePreset = undefined;
				persistSessionState();
			}
		} else if (hasStoredState && restoredActiveName === null) {
			// 已清除的预设：会话层状态是权威判据（ADR-0049 决策 2），工具轴据此复位。
			// 只有当前分支末端不是 name=null 时才补写 entry，避免每次 session_start
			// 都往 transcript 追一条重复记录（ADR-0065）。
			applyToolsOverlay(null);
			if (presetEntry?.data?.name != null) persistSessionState();
		}

		updateStatus(ctx);
	});

	// 状态栏偏离检测：用户手动改 model/thinking 后即时刷新（延迟到异步链完成），
	// tools 无变化事件，靠 turn_start 兜底检测。
	pi.on('model_select', async (_event, ctx) => {
		latestCtx = ctx;
		// 硬约束（ADR-0049）：preset 激活且 model 偏离 → 回滚 + error（/model 内置命令无法前置拦截）
		if (activePreset && activePreset.provider && activePreset.model) {
			const m = ctx.model;
			if (m && (m.provider !== activePreset.provider || m.id !== activePreset.model)) {
				const presetModel = ctx.modelRegistry.find(
					activePreset.provider,
					activePreset.model,
				);
				if (presetModel) {
					await pi.setModel(presetModel);
					ctx.ui.notify('preset 已锁定，model 修改不被允许', 'error');
				}
			}
		}
		updateStatus(ctx);
	});
	pi.on('thinking_level_select', (_event, ctx) => {
		latestCtx = ctx;
		// 硬约束（ADR-0049）：preset 激活且 thinking 偏离 → 回滚 + error
		if (activePreset && activePreset.thinkingLevel) {
			if (pi.getThinkingLevel() !== activePreset.thinkingLevel) {
				pi.setThinkingLevel(activePreset.thinkingLevel);
				ctx.ui.notify('preset 已锁定，thinking 修改不被允许', 'error');
			}
		}
		updateStatus(ctx);
	});

	// Persist preset state
	pi.on('turn_start', async (_event, ctx) => {
		log.debug('event: turn_start');
		latestCtx = ctx;
		// 状态稳定边界：兜底回滚锁定 preset 的偏离维度（tools/skills/instructions 无修改事件，
		// 只能 turn 边界兜底；model/thinking 事件回滚失败的残留也在此兜底），再刷新状态栏。
		await rollbackDrift(ctx);
		updateStatus(ctx);
	});

	// 会话结束结算当前臂停留时长（/reload 会先触发 session_shutdown）。
	// 不删除会话级 preset 文件：跟随 sessionId 落盘，/reload 后仍生效；
	// 超期文件由 session_start 的 presetStore.cleanupExpired() 清理。
	pi.on('session_shutdown', async () => {
		log.debug('event: session_shutdown');
		_settleUsage();
		presetStore.setSessionId(null);
	});
}

/**
 * 选择面板中的一项：preset 名称 + 配置 + 是否激活。
 * preset 为 null 表示「(none) 清除」项。
 */
export interface PresetPanelItem {
	name: string;
	preset: Preset | null;
	/** 来源：会话级/项目级/全局级；(none) 项为 undefined */
	scope?: PresetScope;
	isActive: boolean;
}

/**
 * 面板的动作回调（由 showPresetSelector 闭包注入，连接 UI 与数据层）。
 * 面板组件保持纯 UI，输入/确认/数据变更都通过此接口。
 */
/** 编辑 Instructions 的请求：关面板后由 showPresetSelector 用 ctx.ui.editor 编辑（多行，不嵌套） */
interface EditInstructionsRequest {
	action: 'edit-instructions';
	name: string;
}

/** 类型守卫：收窄 custom 面板返回值中的 instructions 编辑请求。 */
function isEditInstructionsRequest(
	r: string | null | EditInstructionsRequest,
): r is EditInstructionsRequest {
	if (r === null || typeof r === 'string') return false;
	return r.action === 'edit-instructions';
}

export interface PresetPanelActions {
	/** n：新建会话级 preset（空配置），重名返回错误消息，成功返回 null */
	addSessionPreset: (name: string) => string | null;
	/** d：删除会话级 preset（含确认），返回是否删除 */
	deleteSessionPreset: (name: string) => Promise<boolean>;
	/** 重新获取面板项（数据变更后刷新列表） */
	getItems: () => PresetPanelItem[];
	/** 弹输入框获取名称，null = 取消 */
	promptName: (title: string) => Promise<string | null>;
	/** 通知 */
	notify: (message: string, type: 'info' | 'warning' | 'error') => void;
	/** e：编辑字段。返回 { preset, name?, editInstructions? } 或 null（取消）。
	 * editInstructions=true 表示需关面板后用 ctx.ui.editor 编辑多行 instructions。 */
	editField: (
		name: string,
		field: PresetField,
		current: Preset,
	) => Promise<{ preset: Preset; name?: string; editInstructions?: boolean } | null>;
	/** 文件级 e：复制为会话级（原名-复制，重名递增），返回副本名或 null */
	copyToSession: (name: string) => string | null;
	/** 会话级 s：提升为项目级（写 config.json + 移除会话级），返回是否成功 */
	promoteToProject: (name: string) => Promise<boolean>;
}

/** 详情视口最多展示的行数（超出则 ↑↓ 滚动）。 */
const DETAIL_MAX_VISIBLE = 10;
/** 一级列表视口最多展示的行数（超出则 ↑↓ 滚动，选中项始终可见）。 */
const LIST_MAX_VISIBLE = 10;
/** 内容行左缩进（纯横线范式无竖线，缩进表达层级）。 */
const PANEL_INDENT = '    ';

/** 来源标记：会话级/项目级/全局级（面板行首与 footer 图例共用）。 */
const SCOPE_LABEL: Record<PresetScope, string> = {
	session: '[会话]',
	project: '[项目]',
	user: '[全局]',
};

/** 思考级别枚举（选择器选项，与 Preset.thinkingLevel 联合类型一致）。 */
const THINKING_LEVELS: Array<'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'> = [
	'off',
	'minimal',
	'low',
	'medium',
	'high',
	'xhigh',
	'max',
];

/** 编辑模式下的字段列表（导航顺序）。 */
const EDIT_FIELDS: Array<{ key: PresetField; label: string }> = [
	{ key: 'name', label: 'Name' },
	{ key: 'model', label: 'Model' },
	{ key: 'thinkingLevel', label: 'Thinking' },
	{ key: 'tools', label: 'Tools' },
	{ key: 'skills', label: 'Skills' },
	{ key: 'instructions', label: 'Instructions' },
];

/**
 * preset 选择面板 — master-detail 两级导航（手绘组件，ADR-0031）。
 *
 * 一级列表：↑↓ 移动 · Enter/→ 进详情 · Space 选用/取消 · Esc 关闭。
 * 二级详情：展示全部 5 字段（未配置显式「未设置」）· ← 返回 · ↑↓ 滚动 · Esc 关闭。
 * 视觉遵循 ADR-0023 纯横线范式：topBorder/bottomBorder、每行 truncateToWidth 兜底、
 * 字段对齐用 padEnd（ASCII 字段名），无 emoji/图标。
 */
export class PresetPanelComponent implements Component {
	private mode: 'list' | 'detail' | 'edit' = 'list';
	private selectedIndex: number;
	private detailScrollOffset = 0;
	private listScrollOffset = 0;
	private editFieldIndex = 0;
	private items: PresetPanelItem[];
	private readonly tui: TUI;
	private readonly onDone: (result: string | null | EditInstructionsRequest) => void;
	private readonly actions?: PresetPanelActions;

	// themed colors (makeThemeColors)
	private dim!: StyleFn;
	private cyan!: StyleFn;
	private yellow!: StyleFn;

	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		items: PresetPanelItem[],
		tui: TUI,
		theme: Theme,
		onDone: (result: string | null | EditInstructionsRequest) => void,
		initialIndex = 0,
		actions?: PresetPanelActions,
	) {
		this.items = items;
		this.tui = tui;
		this.onDone = onDone;
		this.actions = actions;
		this.selectedIndex = Math.max(0, Math.min(initialIndex, items.length - 1));
		Object.assign(this, makeThemeColors(theme));
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	handleInput(data: string): void {
		if (this.mode === 'detail') {
			this.handleDetailInput(data);
		} else if (this.mode === 'edit') {
			this.handleEditInput(data);
		} else {
			this.handleListInput(data);
		}
	}

	private handleListInput(data: string): void {
		if (matchesKey(data, Key.up)) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			if (this.selectedIndex < this.listScrollOffset) {
				this.listScrollOffset = this.selectedIndex;
			}
			this.invalidate();
			this.tui.requestRender();
		} else if (matchesKey(data, Key.down)) {
			this.selectedIndex = Math.min(this.items.length - 1, this.selectedIndex + 1);
			if (this.selectedIndex >= this.listScrollOffset + LIST_MAX_VISIBLE) {
				this.listScrollOffset = this.selectedIndex - LIST_MAX_VISIBLE + 1;
			}
			this.invalidate();
			this.tui.requestRender();
		} else if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) {
			// Enter 与 → 同义：进详情看配置（不再激活，激活/取消交给 Space）
			this.mode = 'detail';
			this.detailScrollOffset = 0;
			this.invalidate();
			this.tui.requestRender();
		} else if (matchesKey(data, Key.space)) {
			// Space：切换激活/取消（单选，可取消到 (none)）
			const item = this.items[this.selectedIndex];
			if (item) {
				this.onDone(item.isActive ? '(none)' : item.name);
			}
		} else if (matchesKey(data, 'n')) {
			void this.handleAdd();
		} else if (matchesKey(data, 'd')) {
			void this.handleDelete();
		} else if (matchesKey(data, Key.escape)) {
			this.onDone(null);
		}
	}

	/**
	 * 数据变更后刷新列表（重新获取 items + 选中指定项）。
	 */
	private refreshItems(selectName?: string): void {
		if (!this.actions) return;
		this.items = this.actions.getItems();
		if (selectName) {
			const idx = this.items.findIndex((it) => it.name === selectName);
			this.selectedIndex = idx >= 0 ? idx : 0;
		} else {
			this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.items.length - 1));
		}
		this.listScrollOffset = 0;
		this.invalidate();
		this.tui.requestRender();
	}

	/**
	 * n：新建会话级 preset（输入名称 → 重名检查 → 添加 → 刷新并选中）。
	 */
	private async handleAdd(): Promise<void> {
		if (!this.actions) return;
		const name = await this.actions.promptName('请输入 preset 名称（新建会话级）');
		if (name === null) return;
		const trimmed = name.trim();
		if (!trimmed) {
			this.actions.notify('名称不能为空', 'warning');
			return;
		}
		const err = this.actions.addSessionPreset(trimmed);
		if (err) {
			this.actions.notify(err, 'error');
			return;
		}
		this.refreshItems(trimmed);
	}

	/**
	 * d：删除会话级 preset（仅会话级可删）。
	 */
	private async handleDelete(): Promise<void> {
		if (!this.actions) return;
		const item = this.items[this.selectedIndex];
		if (!item || item.scope !== 'session') return;
		const ok = await this.actions.deleteSessionPreset(item.name);
		if (ok) this.refreshItems();
	}

	private handleDetailInput(data: string): void {
		if (matchesKey(data, Key.left)) {
			this.mode = 'list';
			this.invalidate();
			this.tui.requestRender();
		} else if (matchesKey(data, 'e')) {
			const item = this.items[this.selectedIndex];
			if (!this.actions) return;
			if (item?.scope === 'session') {
				this.mode = 'edit';
				this.editFieldIndex = 0;
				this.invalidate();
				this.tui.requestRender();
			} else if (item && item.preset) {
				// 文件级：复制为临时（原名-复制）
				const copyName = this.actions.copyToSession(item.name);
				if (copyName) {
					this.refreshItems(copyName);
					this.mode = 'edit';
					this.editFieldIndex = 0;
					this.invalidate();
					this.tui.requestRender();
				}
			}
		} else if (matchesKey(data, 's')) {
			const item = this.items[this.selectedIndex];
			if (item?.scope === 'session') {
				void this.handlePromote();
			}
		} else if (matchesKey(data, Key.escape)) {
			this.onDone(null);
		} else if (matchesKey(data, Key.up)) {
			this.detailScrollOffset = Math.max(0, this.detailScrollOffset - 1);
			this.invalidate();
			this.tui.requestRender();
		} else if (matchesKey(data, Key.down)) {
			this.detailScrollOffset += 1;
			this.invalidate();
			this.tui.requestRender();
		}
	}

	private handleEditInput(data: string): void {
		if (matchesKey(data, Key.up)) {
			this.editFieldIndex = Math.max(0, this.editFieldIndex - 1);
			this.invalidate();
			this.tui.requestRender();
		} else if (matchesKey(data, Key.down)) {
			this.editFieldIndex = Math.min(EDIT_FIELDS.length - 1, this.editFieldIndex + 1);
			this.invalidate();
			this.tui.requestRender();
		} else if (matchesKey(data, Key.enter)) {
			void this.handleEditField();
		} else if (matchesKey(data, Key.escape)) {
			this.mode = 'detail';
			this.invalidate();
			this.tui.requestRender();
		}
	}

	/** 编辑当前选中字段：调用 actions.editField 并更新 items。 */
	private async handleEditField(): Promise<void> {
		if (!this.actions) return;
		const item = this.items[this.selectedIndex];
		if (!item || !item.preset) return;
		const field = EDIT_FIELDS[this.editFieldIndex];
		const result = await this.actions.editField(item.name, field.key, item.preset);
		if (!result) return;
		if (result.editInstructions) {
			// 多行 instructions：关面板 → ctx.ui.editor（预填当前值）→ 重开面板
			this.onDone({ action: 'edit-instructions', name: item.name });
			return;
		}
		item.preset = result.preset;
		if (result.name && result.name !== item.name) {
			item.name = result.name;
		}
		this.invalidate();
		this.tui.requestRender();
	}

	/** s：提升会话级 preset 为项目级（写文件 + 移除会话级）。 */
	private async handlePromote(): Promise<void> {
		if (!this.actions) return;
		const item = this.items[this.selectedIndex];
		if (!item || item.scope !== 'session') return;
		const ok = await this.actions.promoteToProject(item.name);
		if (ok) this.refreshItems(item.name);
	}

	private renderEdit(width: number): string[] {
		const lines: string[] = [];
		const item = this.items[this.selectedIndex];
		if (!item) return lines;
		lines.push(this.cyan(topBorder(`── 编辑预设: ${item.name} `, width)));

		const contentWidth = Math.max(0, width - PANEL_INDENT.length);
		const p = item.preset ?? {};
		const fieldValue = (f: PresetField): string => {
			switch (f) {
				case 'name':
					return item.name;
				case 'model':
					return p.provider && p.model ? `${p.provider}/${p.model}` : '未设置';
				case 'thinkingLevel':
					return p.thinkingLevel ?? '未设置';
				case 'tools':
					return p.tools && p.tools.length > 0 ? p.tools.join(', ') : '未设置';
				case 'skills':
					if (p.skills === undefined) return '不限制';
					if (p.skills.length === 0) return '全部禁止';
					return p.skills.join(', ');
				case 'instructions':
					return p.instructions
						? truncateToWidth(
								p.instructions.replace(/\s*\n+\s*/g, ' · '),
								Math.max(1, contentWidth - 16),
							)
						: '未设置';
			}
			return '未设置';
		};

		for (let i = 0; i < EDIT_FIELDS.length; i++) {
			const f = EDIT_FIELDS[i];
			const mark = i === this.editFieldIndex ? '> ' : '  ';
			const value = fieldValue(f.key);
			const row =
				PANEL_INDENT +
				truncateToWidth(`${mark}${f.label.padEnd(12, ' ')}  ${value}`, contentWidth);
			lines.push(i === this.editFieldIndex ? this.cyan(row) : this.dim(row));
		}

		lines.push(' ' + this.dim(bottomBorder(Math.max(0, width - 2))));
		lines.push(
			truncateToWidth(
				PANEL_INDENT + this.dim('↑↓ 选字段 · Enter 编辑 · Esc 返回详情'),
				width,
			),
		);
		lines.push(this.cyan(bottomBorder(width)));
		return lines;
	}

	render(width: number): string[] {
		if (this.cachedWidth === width && this.cachedLines) return this.cachedLines;
		const lines =
			this.mode === 'detail'
				? this.renderDetail(width)
				: this.mode === 'edit'
					? this.renderEdit(width)
					: this.renderList(width);
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
	private renderList(width: number): string[] {
		const lines: string[] = [];
		lines.push(this.cyan(topBorder('── 选择预设 ', width)));

		const contentWidth = Math.max(0, width - PANEL_INDENT.length);

		// 滚动视口：选中项始终可见（一级列表必带滚动上限，ADR 交互模式 3.2）
		const maxScroll = Math.max(0, this.items.length - LIST_MAX_VISIBLE);
		this.listScrollOffset = Math.max(0, Math.min(this.listScrollOffset, maxScroll));
		const start = this.listScrollOffset;
		const end = Math.min(this.items.length, start + LIST_MAX_VISIBLE);

		for (let i = start; i < end; i++) {
			const it = this.items[i];
			const mark = i === this.selectedIndex ? '> ' : '  ';
			let scopeLabel = '';
			if (it.scope === 'session') scopeLabel = `${this.yellow(SCOPE_LABEL.session)} `;
			else if (it.scope) scopeLabel = `${SCOPE_LABEL[it.scope]} `;
			const label = it.isActive ? `${it.name} (active)` : it.name;
			const row = PANEL_INDENT + truncateToWidth(mark + scopeLabel + label, contentWidth);
			lines.push(i === this.selectedIndex ? this.cyan(row) : this.dim(row));
		}

		if (maxScroll > 0) {
			lines.push(
				truncateToWidth(
					PANEL_INDENT + this.dim(`(${start + 1}-${end}/${this.items.length} ↑↓ 滚动)`),
					width,
				),
			);
		}

		// 内部分隔线（左右各缩进 1 格，ADR-0023）
		lines.push(' ' + this.dim(bottomBorder(Math.max(0, width - 2))));
		// footer 两行：来源图例 + 操作键
		lines.push(
			truncateToWidth(
				PANEL_INDENT +
					this.yellow('[会话]') +
					this.dim(' 临时 · [项目] [全局] 文件级（改配置文件）'),
				width,
			),
		);
		lines.push(
			truncateToWidth(
				PANEL_INDENT +
					this.dim('↑↓ 移动 · Enter/→ 详情 · Space 选用 · n 新建 · d 删除 · Esc 关闭'),
				width,
			),
		);
		lines.push(this.cyan(bottomBorder(width)));
		return lines;
	}

	private renderDetail(width: number): string[] {
		const lines: string[] = [];
		const item = this.items[this.selectedIndex];
		if (!item) return lines;
		lines.push(this.cyan(topBorder(`── 预设详情: ${item.name} `, width)));

		const contentWidth = Math.max(0, width - PANEL_INDENT.length);
		const body = this.buildDetailBody(item, contentWidth);

		const total = body.length;
		const maxScroll = Math.max(0, total - DETAIL_MAX_VISIBLE);
		this.detailScrollOffset = Math.max(0, Math.min(this.detailScrollOffset, maxScroll));
		const page = body.slice(
			this.detailScrollOffset,
			this.detailScrollOffset + DETAIL_MAX_VISIBLE,
		);

		for (const l of page) {
			lines.push(truncateToWidth(PANEL_INDENT + l, width));
		}
		if (maxScroll > 0) {
			lines.push(
				truncateToWidth(
					PANEL_INDENT +
						this.dim(
							`(${this.detailScrollOffset + 1}-${Math.min(this.detailScrollOffset + DETAIL_MAX_VISIBLE, total)}/${total} ↑↓ 滚动)`,
						),
					width,
				),
			);
		}

		lines.push(' ' + this.dim(bottomBorder(Math.max(0, width - 2))));
		let footerKeys = '← 返回 · Esc 关闭';
		if (item.scope === 'session') {
			footerKeys = 'e 编辑 · s 存为项目级 · l 锁定 · ← 返回 · Esc 关闭';
		} else if (item.preset) {
			footerKeys = 'e 复制为临时 · l 锁定 · ← 返回 · Esc 关闭';
		}
		lines.push(truncateToWidth(PANEL_INDENT + this.dim(footerKeys), width));
		lines.push(this.cyan(bottomBorder(width)));
		return lines;
	}

	private buildDetailBody(item: PresetPanelItem, contentWidth: number): string[] {
		const p = item.preset;
		const lines: string[] = [];
		if (!p) {
			lines.push('(none)');
			lines.push('');
			lines.push('清除活动预设，恢复默认值。');
			return lines;
		}

		const field = (label: string, value: string): string =>
			`${label.padEnd(12, ' ')}  ${value}`;

		lines.push(field('Model', p.provider && p.model ? `${p.provider}/${p.model}` : '未设置'));
		lines.push(field('Thinking', p.thinkingLevel ?? '未设置'));
		lines.push(field('Tools', p.tools && p.tools.length > 0 ? p.tools.join(', ') : '未设置'));
		lines.push('');
		lines.push('Instructions');
		if (p.instructions) {
			const wrapped = wrapTextWithAnsi(p.instructions, Math.max(1, contentWidth - 2));
			for (const l of wrapped) lines.push('  ' + l);
		} else {
			lines.push('  未设置');
		}
		return lines;
	}
}
