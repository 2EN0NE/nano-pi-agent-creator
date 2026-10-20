/**
 * Tools Extension
 *
 * Provides a /tools command to enable/disable tools interactively.
 *
 * 状态模型（ADR-0049 / ADR-0050）：
 * - **基础层（base）**：`disabledTools`（opt-out）。用户显式禁用的工具；新注册工具默认启用。
 *   基础层由用户经 /tools 维护，持久化到 session entry `tools-config`。
 * - **叠加层（overlay）**：`presetOverlay`。preset 激活时设置的**封闭集白名单**（非 null 时生效）。
 *   有效活动集 = overlay ∩ allTools；overlay 为 null 时 = allTools - 基础禁用。
 * - preset **不得**把约束写进基础层；清除 preset 仅置 overlay 为 null。
 *
 * 限制权归属（ADR-0050）：活动工具集的"限制"只有 preset（overlay）与 /tools（基础层）
 * 两个来源；其它扩展/实验只能观测，不得调 setActiveTools 缩减。
 * `tool-range` 实验默认只观测、不限制；仅当用户在 extensions-data/tools/config.json
 * 显式设置 `enableToolRange: true` 报名后，才把臂结果写进基础层。
 */

import type { ExtensionAPI, ExtensionContext, ToolInfo } from '@earendil-works/pi-coding-agent';
import { getSettingsListTheme, DynamicBorder } from '@earendil-works/pi-coding-agent';
import { Container, type SettingItem, SettingsList } from '@earendil-works/pi-tui';
import { topBorder } from '../../../src/tui/helpers.js';
import { createLogger } from '@zenone/pi-logger';
import { loadLayeredConfig } from '@zenone/pi-config';

const log = createLogger('tools');

/**
 * 实验臂「core」的工具集（tool-range 实验，select 型）。
 *
 * core 臂 = 基础工具（BASE_TOOLS，与 preset「清除预设后恢复默认值」的
 * 4 工具对齐）+ 搜索类 3 工具。full 臂 = pi.getAllTools() 全部工具。
 */
const BASE_TOOLS = ['read', 'bash', 'edit', 'write'];

const SEARCH_TOOL_CANDIDATES = ['rg', 'ffgrep', 'fffind', 'grep', 'find', 'ls'];

/** 解析 core 臂工具集：基础 4 + 搜索 3（按候选优先级取实际存在的工具）。 */
export function resolveCoreToolNames(allNames: string[]): string[] {
	const base = BASE_TOOLS.filter((n) => allNames.includes(n));
	const search = SEARCH_TOOL_CANDIDATES.filter((n) => allNames.includes(n)).slice(0, 3);
	return [...base, ...search];
}

/** 基础层持久化状态：用户显式禁用的工具（opt-out）。 */
interface ToolsState {
	disabledTools: string[];
}

interface ToolRangeConfig {
	/** 显式报名 tool-range 实验（默认 false = 只观测不限制）。 */
	enableToolRange: boolean;
}

export default function toolsExtension(pi: ExtensionAPI) {
	/** 基础层：用户显式禁用的工具（opt-out）。 */
	let disabledTools: Set<string> = new Set();
	let allTools: ToolInfo[] = [];
	/**
	 * preset 叠加层：非 null 时活动集 = 该白名单 ∩ allTools（封闭集）。
	 * null = 无 preset 约束。
	 */
	let presetOverlay: string[] | null = null;
	/**
	 * tool-range 实验注入的禁用工具（仅显式报名后存在）。
	 * 与用户显式禁用区分：/tools 面板据此标注来源，用户手动调整即接管并退出注入。
	 */
	let labInjectedDisabled: Set<string> = new Set();
	/** tool-range 实验（select 型）的 select 引用；pi-lab 不可用时 undefined。 */
	let labSelect: ((context?: unknown) => Promise<string>) | undefined;

	function toolNames(): string[] {
		return allTools.map((t) => t.name);
	}

	/**
	 * 有效活动工具集：
	 * - overlay 存在（preset 激活）→ 白名单 ∩ allTools（封闭集，遮蔽运行时新注册的工具）
	 * - overlay 为 null → allTools - 基础禁用
	 */
	function effectiveTools(): string[] {
		const names = toolNames();
		if (presetOverlay !== null) {
			const overlay = new Set(presetOverlay);
			return names.filter((n) => overlay.has(n));
		}
		return names.filter((n) => !disabledTools.has(n));
	}

	// Persist base-layer state to session entry
	function persistState() {
		pi.appendEntry<ToolsState>('tools-config', {
			disabledTools: Array.from(disabledTools),
		});
	}

	// Compute effective set and push to pi runtime
	function applyTools(source: string) {
		// 每次重算前刷新工具清单（运行时可能新注册工具）
		allTools = pi.getAllTools();
		const effective = effectiveTools();
		pi.setActiveTools(effective);
		log.info('tools applied', {
			source,
			baseDisabled: Array.from(disabledTools),
			overlay: presetOverlay,
			effectiveCount: effective.length,
			total: allTools.length,
			effective,
		});
		// 通知 preset 即时刷新偏离状态（用户手动改 tools 后「已偏离 tools」立即出现）
		(globalThis as { __presetDriftRefresh?: () => void }).__presetDriftRefresh?.();
	}

	/**
	 * 从 session 记录恢复基础层。
	 *
	 * 使用 getEntries()（全局视图）而非 getBranch()（树路径过滤），
	 * 因为工具配置是 session 级全局设定，不受分支导航影响。
	 *
	 * 旧格式迁移：历史 entry 含 `enabledTools`（白名单）时，换算为
	 * 「禁用 = 全集 - enabled」，把旧的融合状态还原为基础层。
	 */
	function restoreFromBranch(ctx: ExtensionContext) {
		allTools = pi.getAllTools();
		const names = toolNames();
		const entries = ctx.sessionManager.getEntries();
		let savedDisabled: string[] | undefined;

		for (const entry of entries) {
			if (entry.type === 'custom' && entry.customType === 'tools-config') {
				const data = entry.data as
					{ disabledTools?: string[]; enabledTools?: string[] } | undefined;
				if (data?.enabledTools) {
					const enabled = new Set(data.enabledTools);
					savedDisabled = names.filter((n) => !enabled.has(n));
				} else if (data?.disabledTools) {
					savedDisabled = data.disabledTools;
				}
			}
		}

		if (savedDisabled) {
			disabledTools = new Set(savedDisabled.filter((n) => names.includes(n)));
		} else if (presetOverlay === null) {
			// 无持久状态：以 pi 当前活动集为基准（未激活者视为基础禁用）。
			// overlay 生效时**不得**这么做：此刻活动集 == overlay 白名单，反推会把
			// overlay 排除的工具写成基础层禁用，清除预设后约束无法撤回（ADR-0049 决策 5）。
			const active = new Set(pi.getActiveTools());
			disabledTools = new Set(names.filter((n) => !active.has(n)));
		}
		applyTools('restore');
	}

	// Register /tools command
	pi.registerCommand('tools', {
		description: '启用/禁用工具',
		handler: async (_args, ctx) => {
			if (ctx.mode !== 'tui') {
				ctx.ui.notify('/tools requires TUI mode', 'error');
				return;
			}

			allTools = pi.getAllTools();

			await ctx.ui.custom((tui, theme, _kb, done) => {
				const enabled = () => new Set(effectiveTools());

				// Build settings items for each tool
				const items: SettingItem[] = allTools.map((tool) => {
					const si = tool.sourceInfo;
					let sourceLine = '来源: 未知';

					if (si) {
						const scopeTag =
							si.scope === 'project'
								? '[项目]'
								: si.scope === 'user'
									? '[用户]'
									: '[内置]';

						if (si.path.startsWith('<builtin:')) {
							sourceLine = `来源: 内置工具 ${scopeTag}`;
						} else {
							// Make path relative if possible
							let displayPath = si.path;
							const cwd = process.cwd();
							const home = process.env.HOME ?? '';
							if (home && si.path.startsWith(home)) {
								displayPath = '~' + si.path.slice(home.length);
							} else if (si.path.startsWith(cwd)) {
								displayPath = '.' + si.path.slice(cwd.length);
							}
							sourceLine = `来源: ${displayPath}  ${scopeTag}`;
						}
					}

					// Append tool's own description if available
					const descParts = [sourceLine];
					if (tool.description) {
						descParts.push(`说明: ${tool.description}`);
					}
					if (presetOverlay !== null && !presetOverlay.includes(tool.name)) {
						descParts.push('状态: 被预设限制（封闭集），不可启用');
					} else if (labInjectedDisabled.has(tool.name)) {
						descParts.push('状态: 实验禁用(tool-range core 组)，启用即退出实验');
					}

					return {
						id: tool.name,
						label: `${enabled().has(tool.name) ? '• ' : '  '}${tool.name}`,
						description: descParts.join('\n'),
						currentValue: '',
						values: [''],
					};
				});

				// Exposed helper — returns current enabled tool count vs total
				function getToolCounts() {
					return {
						enabled: effectiveTools().length,
						total: allTools.length,
						locked: presetOverlay !== null,
					};
				}

				const container = new Container();

				// Status header showing current enablement
				const statusHeader = new (class {
					render(width: number) {
						const { enabled, total, locked } = getToolCounts();
						return [
							theme.fg(
								'accent',
								theme.bold(topBorder('── Tool Configuration ', width)),
							),
							`  ${theme.fg('muted', `Enabled tools: ${enabled}/${total}`)}${
								locked ? theme.fg('warning', '  [预设锁定]') : ''
							}`,
							'',
						];
					}
					invalidate() {}
				})();
				container.addChild(statusHeader);

				const settingsList = new SettingsList(
					items,
					Math.min(items.length + 2, 15),
					getSettingsListTheme(),
					(id) => {
						// 锁定守卫（ADR-0049 决策 4）：preset 激活期间拒绝写操作
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
							const nextTools = new Set(effectiveTools());
							if (disabledTools.has(id) || !nextTools.has(id)) nextTools.add(id);
							else nextTools.delete(id);
							const r = guard.canModify('tools', [...nextTools]);
							if (!r.allowed) {
								ctx.ui.notify(r.reason ?? 'tools 修改不被允许', 'error');
								return;
							}
						}
						if (disabledTools.has(id)) {
							disabledTools.delete(id);
							// 用户在 core 臂下启用被实验禁用的工具 → 整体退出实验注入
							if (labInjectedDisabled.has(id)) {
								for (const injected of labInjectedDisabled) {
									disabledTools.delete(injected);
								}
								labInjectedDisabled.clear();
								log.info(
									'tool-range: user override — experiment injection exited',
									{
										tool: id,
									},
								);
							}
						} else {
							disabledTools.add(id);
							labInjectedDisabled.delete(id);
						}
						applyTools('manual');
						persistState();
						const toggled = items.find((i) => i.id === id);
						if (toggled) {
							toggled.label = `${!disabledTools.has(id) ? '• ' : '  '}${id}`;
						}
						tui.requestRender();
					},
					() => {
						// Log final state on confirm (Esc)
						const { enabled, total } = getToolCounts();
						log.info('tools config closed', {
							enabled,
							total,
							disabled: Array.from(disabledTools),
						});
						done(undefined);
					},
					{ enableSearch: true },
				);

				container.addChild(settingsList);
				container.addChild(new DynamicBorder((s) => theme.fg('accent', s)));

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
	 * Hard block: intercept every tool call.
	 * 不在有效活动集内的已知工具一律拦截（preset 封闭集 / 基础禁用）。
	 */
	pi.on('tool_call', (_event, ctx) => {
		const event = _event as { toolName?: string };
		const toolName = event.toolName;
		if (!toolName) return;
		if (!toolNames().includes(toolName)) {
			// Not a known tool — could be a typo by the LLM, let pi handle
			return;
		}
		if (effectiveTools().includes(toolName)) return;

		const reason =
			presetOverlay !== null
				? `Tool "${toolName}" is restricted by the active preset.`
				: `Tool "${toolName}" is disabled by /tools.`;
		log.warn('tool blocked', { tool: toolName, byPreset: presetOverlay !== null });
		if (ctx.hasUI) {
			ctx.ui.notify(reason, 'warning');
		}
		return { block: true, reason };
	});

	// ── pi-lab 实验接入（tool-range，select 型）──────────────────
	// 默认只观测不限制；仅显式报名（config.json enableToolRange=true）后写基础层。
	function initToolRangeExperiment(_ctx: ExtensionContext): void {
		// SAFETY: globalThis.__labApi 由 pi-lab 扩展在加载时挂载；缺失时判空降级。
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
			labSelect = undefined;
			return;
		}

		try {
			const exp = mgr.registerWeakExperiment({
				owner: 'tools',
				name: 'tool-range',
				contextKey: (c: ExtensionContext) =>
					`${c.model?.provider ?? 'unknown'}:${c.model?.id ?? 'unknown'}`,
				assignKey: (c: ExtensionContext) =>
					c.sessionManager?.getSessionId?.() ?? 'unknown-session',
				arms: [
					{ id: 'core', label: '基础工具集' },
					{ id: 'full', label: '全部工具' },
				],
				metrics: [],
				strategy: 'stable-hash',
			});
			if (exp) {
				labSelect = (context) =>
					(exp as { select: (c: unknown) => Promise<string> }).select(context);
			} else {
				labSelect = undefined;
				log.warn('Experiment registration blocked (name conflict): tool-range');
			}
		} catch (err) {
			log.warn('Failed to register tool-range', {
				error: err instanceof Error ? err.message : String(err),
			});
			labSelect = undefined;
		}
	}

	/** session 里是否已有 tools-config entry（用户显式 /tools 写过） */
	function hasUserToolConfig(ctx: ExtensionContext): boolean {
		const entries = ctx.sessionManager.getEntries();
		return entries.some((e) => e.type === 'custom' && e.customType === 'tools-config');
	}

	/**
	 * 实验分流（仅显式报名时）。
	 * 未报名：只观测，不改变活动集（ADR-0050 决策 3 / B2）。
	 * 返回是否实际写入了基础层。
	 */
	async function assignToolRangeArm(ctx: ExtensionContext): Promise<boolean> {
		labInjectedDisabled = new Set();
		if (!labSelect) return false;

		const cfg = loadLayeredConfig<ToolRangeConfig>({
			pluginName: 'tools',
			defaults: { enableToolRange: false },
			cwd: ctx.cwd,
		}).config;
		if (!cfg.enableToolRange) {
			log.info('tool-range: not enrolled — observe only, no restriction');
			return false;
		}
		if (hasUserToolConfig(ctx)) {
			log.info('tool-range: skipped (user has explicit tools config)');
			return false;
		}
		// --preset 指定（无论 preset 是否含 tools）视为用户显式意图，跳过实验
		const presetFlag = pi.getFlag('preset');
		if (typeof presetFlag === 'string' && presetFlag) {
			log.info('tool-range: skipped (--preset flag)');
			return false;
		}
		if (presetOverlay !== null) {
			log.info('tool-range: skipped (preset overlay active)');
			return false;
		}

		let armId: string;
		try {
			armId = await labSelect(ctx);
		} catch (err) {
			log.warn('Failed to select tool-range arm, skipping experiment', {
				error: err instanceof Error ? err.message : String(err),
			});
			return false;
		}
		allTools = pi.getAllTools();
		const allNames = toolNames();

		if (armId === 'core') {
			const coreNames = resolveCoreToolNames(allNames);
			disabledTools = new Set(allNames.filter((n) => !coreNames.includes(n)));
			labInjectedDisabled = new Set(disabledTools);
		} else {
			disabledTools = new Set();
		}

		applyTools('tool-range');
		if (ctx.hasUI) {
			ctx.ui.notify(
				armId === 'core'
					? `tool-range 实验（已报名）: 分入「core」组（仅 ${effectiveTools().length} 个基础工具）。可在 /tools 中启用任意工具退出实验。`
					: 'tool-range 实验（已报名）: 分入「full」组（全部工具可用）。',
			);
		}
		// 消息内嵌 arm/effective：file appender 的 pattern 不含 details，
		// 仅传对象参数会让该结果在日志文件中不可观测（e2e 无法断言分流结果）。
		log.info('tool-range assigned arm=%s effective=%d', armId, effectiveTools().length);
		return true;
	}

	// Restore base state on session start, then (only if enrolled) run experiment
	pi.on('session_start', async (_event, ctx) => {
		restoreFromBranch(ctx);
		initToolRangeExperiment(ctx);
		await assignToolRangeArm(ctx);
	});

	// Re-apply on branch navigation (base layer re-read; overlay unchanged)
	pi.on('session_tree', async (_event, ctx) => {
		restoreFromBranch(ctx);
	});

	// 动态注册遮蔽：preset overlay 生效时，每次请求前重算（封闭集遮蔽运行时新注册的工具）。
	// 无 overlay 时不干预：基础层由用户/注册方自管（org off-duty 收回自有工具不应被覆盖）。
	pi.on('before_agent_start', () => {
		if (presetOverlay === null) return;
		applyTools('before_agent_start');
	});

	// ──────────────────────────────────────────────────────────
	// External API — 供 preset.ts 等扩展通过 `(globalThis as any).__toolsApi`
	// 调用，在不直接耦合 imports 的情况下协作修改工具状态（ADR-0049/0050）。
	// ──────────────────────────────────────────────────────────
	(globalThis as any).__toolsApi = {
		/**
		 * 设置 preset 叠加层（封闭集白名单）。不写基础层。
		 */
		setOverlay(toolNames: string[]) {
			allTools = pi.getAllTools();
			presetOverlay = [...toolNames];
			applyTools('preset-overlay');
		},
		/** 撤回 preset 叠加层（清除预设）。基础层原样保留。 */
		clearOverlay() {
			presetOverlay = null;
			applyTools('preset-clear');
		},
		/** 当前有效活动集（供测试/调试观测）。 */
		getEffective(): string[] {
			return effectiveTools();
		},
		/** 撤回 tool-range 注入的限制（preset 激活时实验退避）。 */
		clearExperimentInjection() {
			if (labInjectedDisabled.size === 0) return;
			for (const t of labInjectedDisabled) disabledTools.delete(t);
			labInjectedDisabled = new Set();
			applyTools('experiment-backoff');
		},
		/**
		 * 兼容旧 API：设置基础层禁用集（禁用 = 全集 - 给定列表）。
		 * 新代码请用 setOverlay/clearOverlay。
		 */
		replaceTools(names: string[]) {
			allTools = pi.getAllTools();
			const all = toolNames();
			const wanted = new Set(names.filter((n) => all.includes(n)));
			disabledTools = new Set(all.filter((n) => !wanted.has(n)));
			applyTools('replace-base');
			persistState();
		},
	};
}
