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
	/**
	 * 锁定（ADR-0035）：激活态下四维度（model/tools/skills/instructions）
	 * 任一修改若导致偏离则拒绝（而非 widget 提醒）。默认不锁定。三级持久化。
	 */
	locked?: boolean;
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
	tools: string[];
}

/**
 * 清除预设后恢复的默认工具集。
 * 与 tools.ts 的 BASE_TOOLS（tool-range 实验 core 臂的基础部分）构成对照契约：
 * core 臂 = 本默认集 + 搜索类 3 工具（由 resolveCoreToolNames 动态解析），
 * 变更任一侧须同步另一侧。
 * （tool-range-contract.test.ts 固定此对照关系）
 */
export const DEFAULT_CLEAR_TOOLS = ['read', 'bash', 'edit', 'write'] as const;

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
	 * 工具变更委托：优先尝试 tools.ts 的 replaceTools API，不存在则退化到
	 * pi.setActiveTools() 直接操作。
	 *
	 * 解耦设计：preset.ts 不 import tools.ts，通过 `(globalThis as any).__toolsApi`
	 * 鸭子类型调用。若 tools.ts 未加载，`__toolsApi` 不存在，走 fallback。
	 *
	 * @param toolNames - 要启用的工具名列表
	 */
	function applyToolsToPi(toolNames: string[]) {
		// 从 globalThis 而非 pi 上读 __toolsApi（避免 pi 对象 Proxy / freeze）
		const api = (globalThis as any).__toolsApi;
		if (api?.replaceTools) {
			api.replaceTools(toolNames);
		} else {
			// Fallback: tools.ts 未加载，直接操作 pi 内置活性列表
			pi.setActiveTools(toolNames);
		}
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
				tools: pi.getActiveTools(),
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

		// Apply tools if specified
		// - 非空数组：白名单（只启用列出的工具，其余禁用）
		// - 空数组 []：不限制工具（恢复全部工具，等价于 pi -ne 的完整工具集）
		// - 未配置（undefined）：不改变当前工具状态
		if (preset.tools !== undefined) {
			const allToolNames = pi.getAllTools().map((t) => t.name);

			if (preset.tools.length > 0) {
				const validTools = preset.tools.filter((t) => allToolNames.includes(t));
				const invalidTools = preset.tools.filter((t) => !allToolNames.includes(t));

				if (invalidTools.length > 0) {
					ctx.ui.notify(
						`Preset "${name}": Unknown tools: ${invalidTools.join(', ')}`,
						'warning',
					);
				}

				if (validTools.length > 0) {
					applyToolsToPi(validTools);
				}
			} else {
				// 空数组 = 不限制工具，恢复全部工具
				applyToolsToPi(allToolNames);
			}
		}

		// Apply skills if specified
		// - 非空数组：白名单（只启用列出的技能）
		// - 空数组 []：全部禁止（如 raw-pi 模拟无扩展环境）
		// - 未配置（undefined）：不限制（不改变技能状态）
		if (preset.skills !== undefined) {
			const skillsApi = (
				globalThis as {
					__skillsApi?: { replaceSkills?: (s: string[] | null) => void };
				}
			).__skillsApi;
			if (skillsApi?.replaceSkills) {
				skillsApi.replaceSkills(preset.skills);
			}
		}

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
			if (originalState) {
				if (originalState.model) {
					await pi.setModel(originalState.model);
				}
				pi.setThinkingLevel(originalState.thinkingLevel);
				applyToolsToPi(originalState.tools);
			} else {
				applyToolsToPi([...DEFAULT_CLEAR_TOOLS]);
			}
			ctx.ui.notify('预设已清除，恢复默认值', 'info');
			updateStatus(ctx);
			return;
		}

		const scoped = resolveScopedPreset(name);
		if (scoped) {
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
				toggleLock: (name) => {
					const scoped = resolveScopedPreset(name);
					if (!scoped) return false;
					const newLocked = !scoped.preset.locked;
					const updated = { ...scoped.preset, locked: newLocked };
					if (scoped.scope === 'session') {
						sessionPresets.set(name, updated);
						persistSessionState();
					} else if (scoped.scope === 'project') {
						projectPresets = persistPresetToProject(ctx.cwd, name, updated);
					} else {
						userPresets = persistPresetToUser(ctx.cwd, name, updated);
					}
					// 锁定/解锁当前激活 preset 时，同步 activePreset（供守卫读取 locked）
					if (activePresetName === name) {
						activePreset = updated;
					}
					return newLocked;
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

	/**
	 * 判断「变更后的目标值」是否偏离 preset 在该维度的设定值。
	 * 仅在维度已被 preset 配置时调用（canModify 守卫用）。
	 */
	function dimensionDeviates(p: Preset, dim: string, nextValue: unknown): boolean {
		switch (dim) {
			case 'tools': {
				const expected = validToolNames(p.tools ?? []).sort();
				const next = [...(nextValue as string[])].sort();
				return next.join('\u0000') !== expected.join('\u0000');
			}
			case 'skills': {
				const expected = validSkillNames(p.skills ?? []).sort();
				const next = [...(nextValue as string[])].sort();
				return next.join('\u0000') !== expected.join('\u0000');
			}
			case 'instructions': {
				const ov = nextValue as { enabled: boolean; content?: string };
				if (ov.enabled === false) return true;
				if (ov.content !== undefined && ov.content !== p.instructions) return true;
				return false;
			}
			case 'model': {
				const m = nextValue as { provider: string; id: string };
				return m.provider !== p.provider || m.id !== p.model;
			}
			case 'thinking': {
				return nextValue !== p.thinkingLevel;
			}
			default:
				return false;
		}
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
				// 过滤无效工具名后再回滚（与 applyPreset 一致）；全部无效则 applyPreset 本就不改变工具状态，跳过。
				const validTools = validToolNames(p.tools);
				if (validTools.length === 0) return false;
				const api = (
					globalThis as { __toolsApi?: { replaceTools?: (t: string[]) => void } }
				).__toolsApi;
				if (!api?.replaceTools) return false;
				api.replaceTools(validTools);
				return true;
			}
			case 'skills': {
				if (p.skills === undefined) return false;
				const api = (
					globalThis as {
						__skillsApi?: { replaceSkills?: (s: string[] | null | undefined) => void };
					}
				).__skillsApi;
				if (!api?.replaceSkills) return false;
				// 过滤无效技能名后回滚（[] 仍表示「全部禁止」，与 applySkills 过滤结果对齐）。
				api.replaceSkills(validSkillNames(p.skills));
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
	 * turn 边界兜底回滚（ADR-0035）：model/thinking 已有事件即时回滚；
	 * tools/skills/instructions 无修改事件，只能在 turn_start 兜底——
	 * 检测到锁定 preset 的任一维度偏离，改回设定值并 notify（warning）。
	 */
	async function rollbackDrift(ctx: ExtensionContext): Promise<void> {
		if (!activePreset?.locked || !activePresetName) return;
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

				await applyPreset(name, scoped.preset, ctx);
				ctx.ui.notify(`预设 "${name}" 已激活`, 'info');
				updateStatus(ctx);
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

	// 锁定守卫（ADR-0035）：tools/skills/prompt 修改入口在修改前调用 canModify。
	// 按维度判断：仅「锁定且该维度被 preset 配置且本次变更会引入偏离」时拒绝；
	// 未配置维度放行，改回 preset 设定值（nextValue 等于设定）放行。
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
		canModify: (dimension: string, nextValue?: unknown) => {
			if (!activePreset?.locked) return { allowed: true };
			const p = activePreset;
			const dim = dimension as 'model' | 'thinking' | 'tools' | 'skills' | 'instructions';

			// 该维度未被 preset 配置 → 修改不会引入偏离 → 放行
			const configured =
				(dim === 'model' && !!p.provider && !!p.model) ||
				(dim === 'thinking' && !!p.thinkingLevel) ||
				(dim === 'tools' && !!p.tools && p.tools.length > 0) ||
				(dim === 'skills' && p.skills !== undefined) ||
				(dim === 'instructions' && !!p.instructions);
			if (!configured) return { allowed: true };

			// 调用方提供了目标新值 → 精确判断是否偏离设定值
			if (nextValue !== undefined) {
				if (dimensionDeviates(p, dim, nextValue)) {
					return {
						allowed: false,
						reason: `preset 已锁定，${dimension} 修改将偏离 preset 设定`,
					};
				}
				return { allowed: true };
			}

			// 无目标新值：该维度当前已偏离 → 放行（用户可能在改回）；未偏离 → 拒绝
			const currentDrift = latestCtx ? detectDrift(latestCtx) : [];
			if (currentDrift.includes(dim)) return { allowed: true };
			return { allowed: false, reason: `preset 已锁定，${dimension} 修改不被允许` };
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
		if (sessionId) {
			presetStore.setSessionId(sessionId);
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

		// 恢复选中状态：--preset flag 已由 applyPreset 设置 activePresetName，
		// 否则优先 presetStore.activeName（applyPreset 立即写，新机制），
		// fallback 到会话 entry（turn_start 写，旧机制）。
		const restoreName =
			!presetFlag && activePresetName === undefined
				? (restoredActiveName ?? presetEntry?.data?.name ?? null)
				: null;

		if (restoreName) {
			const scoped = resolveScopedPreset(restoreName);
			if (scoped) {
				activePresetName = restoreName;
				activePreset = scoped.preset;
				_startUsage(restoreName);
				// Re-apply preset tools so mode stays consistent.
				// User /tools changes in-session are respected;
				// preset re-applies only on session restart.
				if (scoped.preset.tools && scoped.preset.tools.length > 0) {
					const valid = scoped.preset.tools.filter((t) =>
						pi
							.getAllTools()
							.map((tt) => tt.name)
							.includes(t),
					);
					if (valid.length > 0) {
						applyToolsToPi(valid);
						log.debug('preset restored — tools re-applied', {
							preset: restoreName,
							tools: valid,
						});
					}
				}
			} else {
				// activeName 指向已不存在的 preset（如会话级 preset 被删），清空并落盘
				activePresetName = undefined;
				activePreset = undefined;
				persistSessionState();
			}
		}

		updateStatus(ctx);
	});

	// 状态栏偏离检测：用户手动改 model/thinking 后即时刷新（延迟到异步链完成），
	// tools 无变化事件，靠 turn_start 兜底检测。
	pi.on('model_select', async (_event, ctx) => {
		latestCtx = ctx;
		// 锁定守卫（ADR-0035）：锁定且 model 偏离 → 回滚 + error（/model 内置命令无法前置拦截）
		if (activePreset?.locked && activePreset.provider && activePreset.model) {
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
		// 锁定守卫（ADR-0035）：锁定且 thinking 偏离 → 回滚 + error
		if (activePreset?.locked && activePreset.thinkingLevel) {
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
		if (activePresetName) {
			pi.appendEntry('preset-state', { name: activePresetName });
		}
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
	/** l：切换锁定（ADR-0035）。三级持久化，返回新的锁定状态（true=已锁定） */
	toggleLock: (name: string) => boolean;
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
		} else if (matchesKey(data, 'l')) {
			// l：切换锁定（ADR-0035）。toggleLock 三级持久化 + 同步 activePreset。
			const item = this.items[this.selectedIndex];
			if (item && item.preset && this.actions) {
				const locked = this.actions.toggleLock(item.name);
				this.refreshItems(item.name);
				this.actions.notify(
					locked ? `已锁定「${item.name}」：偏离将被拒绝` : `已解锁「${item.name}」`,
					locked ? 'warning' : 'info',
				);
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
		const lockMark = item.preset?.locked ? ' [锁定]' : '';
		lines.push(this.cyan(topBorder(`── 预设详情: ${item.name}${lockMark} `, width)));

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
