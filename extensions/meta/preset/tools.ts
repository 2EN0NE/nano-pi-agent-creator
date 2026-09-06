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

import type { ExtensionAPI, ExtensionContext, ToolInfo } from '@earendil-works/pi-coding-agent';
import { getSettingsListTheme, DynamicBorder } from '@earendil-works/pi-coding-agent';
import { Container, type SettingItem, SettingsList } from '@earendil-works/pi-tui';
import { topBorder } from '../../../src/tui/helpers.js';
import { createLogger } from '@zenone/pi-logger';

const log = createLogger('tools');

log.debug('Extension loaded');

/**
 * 实验臂「core」的工具集（tool-range 实验，select 型）。
 *
 * core 臂 = 基础工具（BASE_TOOLS，与 preset.ts「清除预设后恢复默认值」的
 * 4 工具对齐）+ 搜索类 3 工具。full 臂 = pi.getAllTools() 全部工具。
 *
 * 搜索类工具按 SEARCH_TOOL_CANDIDATES 优先级动态解析：增强工具
 * （rg 由 truncated-tool、ffgrep/fffind 由 @ff-labs/pi-fff 扩展提供）存在时优先，
 * 否则回退 pi 内置搜索工具（grep/find/ls）——保证任何环境下 core 臂都有
 * 搜索能力且恒为 7 个工具，避免实验臂含义随环境漂移。
 */
const BASE_TOOLS = ['read', 'bash', 'edit', 'write'];

const SEARCH_TOOL_CANDIDATES = ['rg', 'ffgrep', 'fffind', 'grep', 'find', 'ls'];

/** 解析 core 臂工具集：基础 4 + 搜索 3（按候选优先级取实际存在的工具）。 */
export function resolveCoreToolNames(allNames: string[]): string[] {
	const base = BASE_TOOLS.filter((n) => allNames.includes(n));
	const search = SEARCH_TOOL_CANDIDATES.filter((n) => allNames.includes(n)).slice(0, 3);
	return [...base, ...search];
}

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

	/**
	 * 外部覆盖标记。
	 *
	 * 当 preset.ts 等扩展通过 __toolsApi.replaceTools() 调用来批量替换工具
	 * 集时，此标记为 true。restoreFromBranch 检测到此标记后会跳过自有恢复逻辑，
	 * 避免用旧的 session branch 数据覆盖 replaceTools 刚设定的状态。
	 *
	 * 复位：restoreFromBranch 检查后立即复位为 false，保证后续 session_tree
	 * 等事件仍正常触发恢复。
	 */
	let externalOverride = false;

	/**
	 * tool-range 实验（select 型）的 select 引用。
	 * 在 session_start 中延迟注册（消除加载顺序竞险）；pi-lab 不可用时为 undefined。
	 */
	let labSelect: ((context?: unknown) => Promise<string>) | undefined;

	/**
	 * tool-range 实验注入的禁用工具（core 臂时非基础工具被实验禁用）。
	 * 与用户显式禁用区分：/tools 面板据此标注来源，用户手动调整即接管并退出注入。
	 * 每次 session_start 分流时重建；分流被跳过/降级时清空。
	 */
	let labInjectedDisabled: Set<string> = new Set();

	// Persist current state
	function persistState() {
		pi.appendEntry<ToolsState>('tools-config', {
			enabledTools: Array.from(enabledTools),
			disabledTools: Array.from(disabledTools),
		});
	}

	// Apply current tool selection
	function applyTools() {
		pi.setActiveTools(Array.from(enabledTools));
		// 通知 preset 即时刷新偏离状态（用户手动改 tools 后「已偏离 tools」立即出现）
		(globalThis as { __presetDriftRefresh?: () => void }).__presetDriftRefresh?.();
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
		log.info('auto-enabled new tool', { tool: toolName });
		if (ctx?.hasUI) {
			ctx.ui.notify(`新工具 "${toolName}" 已自动启用——使用 /tools 管理。`, 'info');
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
		log.info('auto-enabled new tools', { tools: trulyNew });
		if (ctx?.hasUI) {
			ctx.ui.notify(
				`${trulyNew.length} new tool(s) auto-enabled: ${trulyNew.join(', ')}`,
				'info',
			);
		}
	}

	/**
	 * 从 session 记录中恢复工具状态。
	 *
	 * 使用 getEntries()（全局视图）而非 getBranch()（树路径过滤），
	 * 因为工具配置是 session 级全局设定，不受分支导航影响。
	 *
	 * 若 externalOverride 为 true（表示 replaceTools 已被外部调用并设置
	 * 了正确状态），跳过自有恢复逻辑，避免用旧数据覆盖。
	 */
	function restoreFromBranch(ctx: ExtensionContext) {
		// 外部已接管：replaceTools 已完成全部状态设置（enabled / disabled /
		// apply / persist），不需要本函数再覆盖
		if (externalOverride) {
			log.debug('restoreFromBranch: skipped — external override in effect');
			// 同步 disabledTools（replaceTools 也会更新 disabledTools，但
			// 此处兜底确保 session branch 中的禁用记录也得到反映）
			const entries = ctx.sessionManager.getEntries();
			let savedDisabled: string[] | undefined;
			for (const entry of entries) {
				if (entry.type === 'custom' && entry.customType === 'tools-config') {
					const data = entry.data as ToolsState | undefined;
					if (data?.disabledTools) savedDisabled = data.disabledTools;
				}
			}
			if (savedDisabled) disabledTools = new Set(savedDisabled);
			externalOverride = false;
			return;
		}

		allTools = pi.getAllTools();

		// 全局视图：所有 session entries，而非树路径过滤
		const entries = ctx.sessionManager.getEntries();
		let savedEnabled: string[] | undefined;
		let savedDisabled: string[] | undefined;

		for (const entry of entries) {
			if (entry.type === 'custom' && entry.customType === 'tools-config') {
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
			enabledTools = new Set(savedEnabled.filter((t: string) => allToolNames.includes(t)));
			applyTools();
			log.debug('restoreFromBranch: restored from saved state', {
				enabled: enabledTools.size,
				total: allToolNames.length,
				disabled: disabledTools.size,
			});
		} else {
			// No saved state - sync with currently active tools
			enabledTools = new Set(pi.getActiveTools());
			log.debug('restoreFromBranch: initialized from active tools', {
				enabled: enabledTools.size,
				total: allToolNames.length,
			});
		}
	}

	// Register /tools command
	log.debug('registerCommand: tools');
	pi.registerCommand('tools', {
		description: '启用/禁用工具',
		handler: async (_args, ctx) => {
			if (ctx.mode !== 'tui') {
				ctx.ui.notify('/tools requires TUI mode', 'error');
				return;
			}

			// Refresh tool list
			allTools = pi.getAllTools();

			// Auto-enable any brand-new tools that appeared since last refresh
			const allToolNames = allTools.map((t) => t.name);
			for (const name of allToolNames) {
				if (!enabledTools.has(name) && !disabledTools.has(name)) {
					enabledTools.add(name);
					log.info('auto-enabled new tool (discovered via /tools)', {
						tool: name,
					});
				}
			}
			if (allToolNames.some((n) => !enabledTools.has(n) && !disabledTools.has(n))) {
				applyTools();
				persistState();
			}

			await ctx.ui.custom((tui, theme, _kb, done) => {
				// Build settings items for each tool
				const items: SettingItem[] = allTools.map((tool) => {
					// Format source info for display
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
					if (labInjectedDisabled.has(tool.name)) {
						descParts.push('状态: 实验禁用(tool-range core 组)，启用即退出实验');
					}

					return {
						id: tool.name,
						label: `${enabledTools.has(tool.name) ? '• ' : '  '}${tool.name}`,
						description: descParts.join('\n'),
						currentValue: '',
						values: [''],
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
					render(width: number) {
						const { enabled, total } = getToolCounts();
						return [
							theme.fg(
								'accent',
								theme.bold(topBorder('── Tool Configuration ', width)),
							),
							`  ${theme.fg('muted', `Enabled tools: ${enabled}/${total}`)}`,
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
						// Update enabled state and apply immediately（toggle：当前禁用则启用，反之禁用）
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
							// 计算变更后的启用集（含 lab 注入退出的连带解禁）
							const nextTools = new Set(enabledTools);
							if (!enabledTools.has(id)) {
								nextTools.add(id);
								if (labInjectedDisabled.has(id)) {
									for (const injected of labInjectedDisabled)
										nextTools.add(injected);
								}
							} else {
								nextTools.delete(id);
							}
							const r = guard.canModify('tools', [...nextTools]);
							if (!r.allowed) {
								ctx.ui.notify(r.reason ?? 'tools 修改不被允许', 'error');
								return;
							}
						}
						if (!enabledTools.has(id)) {
							enabledTools.add(id);
							disabledTools.delete(id);
							// 用户在 core 臂下启用被实验禁用的工具 → 整体退出实验注入：
							// 把其余注入禁用一并解禁，避免会话停留在「core + 手动启用」混合态
							// （否则后续 turn 的通用指标仍归因到 core 臂，污染 A/B 对照数据）。
							if (labInjectedDisabled.has(id)) {
								for (const injected of labInjectedDisabled) {
									enabledTools.add(injected);
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
							enabledTools.delete(id);
							disabledTools.add(id);
							// 用户手动禁用时解除该工具的注入标记（若此前被实验注入禁用）
							labInjectedDisabled.delete(id);
						}
						applyTools();
						persistState();
						const toggled = items.find((i) => i.id === id);
						if (toggled) {
							toggled.label = `${enabledTools.has(id) ? '• ' : '  '}${id}`;
						}
						tui.requestRender();
					},
					() => {
						// Log final state on confirm (Esc)
						const { enabled, total } = getToolCounts();
						log.info('tools selection confirmed', {
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
		const newTools = currentActive.filter((t) => !enabledTools.has(t) && !disabledTools.has(t));
		const stale = currentActive.filter((t) => !enabledTools.has(t) && disabledTools.has(t));

		log.debug('reapplyRestrictions: active', {
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
			log.warn('reapplyRestrictions: blocked re-enabled tools', stale);
			if (ctx.hasUI) {
				ctx.ui.notify(
					`${stale.length} tool(s) were re-enabled but blocked per /tools.`,
					'info',
				);
			}
			applyTools();
		}

		if (newTools.length === 0 && stale.length === 0) {
			log.debug('reapplyRestrictions: all tools in sync — no changes needed');
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
	pi.on('tool_call', (_event, ctx) => {
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
			log.info('blocked tool call', {
				tool: toolName,
				enabledCount: enabledTools.size,
			});
			if (ctx.hasUI) {
				ctx.ui.notify(`Tool "${toolName}" is disabled per /tools settings.`, 'warning');
			}
			return {
				block: true,
				reason: `Tool "${toolName}" is disabled by /tools.`,
			};
		}
	});

	// ── pi-lab 实验接入（tool-range，select 型）──────────────────
	// 臂：core（resolveCoreToolNames 基础工具集）vs full（全部工具）。
	// 分流时机：session_start，仅在用户未显式配置工具时 select。
	// 尊重用户显式指定：session 有 tools-config entry（/tools 或 preset 写过）
	// 或 --preset flag 存在时，跳过实验分流（避免数据污染）。
	// outcome：tool_error_rate 等通用过程指标由 pi-lab 自动注入（ADR-0023），
	// 无需手动声明；行为信号（回退/纠正/重复修改）留待第二版。

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
			log.warn('pi-lab not available — tools running without tool-range experiment');
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
				// 通用过程指标（tool_error_rate / tool_latency_ms / turn_token_usage）
				// 由 pi-lab 自动注入，无需声明。
				metrics: [],
				strategy: 'stable-hash',
			});
			if (exp) {
				labSelect = (context) =>
					(exp as { select: (c: unknown) => Promise<string> }).select(context);
				log.info('Experiment registered: tools/tool-range');
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

	/** session 里是否已有 tools-config entry（用户显式 /tools 或 preset 写过） */
	function hasUserToolConfig(ctx: ExtensionContext): boolean {
		const entries = ctx.sessionManager.getEntries();
		return entries.some((e) => e.type === 'custom' && e.customType === 'tools-config');
	}

	/**
	 * 实验分流：select 选臂并应用到工具集。
	 * 仅在「无用户显式配置」时执行；返回是否已分流。
	 * 注意：分流结果不 persistState——不写 tools-config entry，
	 * 避免下次 session_start 误判为「用户显式配置过」而不再分流。
	 * 跨 session 的臂稳定性由 stable-hash（assignKey=sessionId）保证。
	 */
	async function assignToolRangeArm(ctx: ExtensionContext): Promise<boolean> {
		// 每次 session_start 重建实验注入集合：分流被跳过/降级时清空残留标注
		labInjectedDisabled = new Set();
		if (!labSelect) return false;
		if (hasUserToolConfig(ctx)) {
			log.debug('tool-range: skip — user has explicit tools-config');
			return false;
		}
		// --preset 指定（无论 preset 是否含 tools）视为用户显式意图，跳过实验
		const presetFlag = pi.getFlag('preset');
		if (typeof presetFlag === 'string' && presetFlag) {
			log.debug('tool-range: skip — --preset flag present');
			return false;
		}

		let armId: string;
		try {
			armId = await labSelect(ctx);
		} catch (err) {
			// select 失败不阻断 session_start：跳过实验分流（保持 restoreFromBranch 结果）
			log.warn('Failed to select tool-range arm, skipping experiment', {
				error: err instanceof Error ? err.message : String(err),
			});
			return false;
		}
		allTools = pi.getAllTools();
		const allNames = allTools.map((t) => t.name);

		if (armId === 'core') {
			const coreNames = resolveCoreToolNames(allNames);
			enabledTools = new Set(coreNames);
			// 非 core 工具加入 disabledTools，使 tool_call handler 真正 block 它们
			//（否则它们既不在 enabled 也不在 disabled，会被 auto-enable，core 臂形同虚设）
			disabledTools = new Set(allNames.filter((n) => !coreNames.includes(n)));
			// 记录实验注入的禁用，供 /tools 面板标注来源
			labInjectedDisabled = new Set(disabledTools);
		} else {
			enabledTools = new Set(allNames);
			disabledTools = new Set();
		}

		applyTools();
		if (ctx.hasUI) {
			ctx.ui.notify(
				armId === 'core'
					? `tool-range 实验: 已分入「core」组（仅 ${enabledTools.size} 个基础工具），扩展工具被实验禁用。可在 /tools 中启用任意工具退出实验。`
					: 'tool-range 实验: 已分入「full」组（全部工具可用）。',
				'info',
			);
		}
		log.info(
			'tool-range assigned arm=%s enabled=%s disabled=%s',
			armId,
			enabledTools.size,
			disabledTools.size,
		);
		return true;
	}

	// Restore state on session start, then re-apply restrictions
	pi.on('session_start', async (_event, ctx) => {
		log.debug('event: session_start');
		restoreFromBranch(ctx);
		reapplyRestrictions(ctx);
		// 实验注册 + 分流（顺序在 restoreFromBranch 之后：
		// 有用户显式配置时 restoreFromBranch 已恢复，分流会被跳过）
		initToolRangeExperiment(ctx);
		await assignToolRangeArm(ctx);
	});

	// Restore state when navigating the session tree, then re-apply restrictions
	pi.on('session_tree', async (_event, ctx) => {
		log.debug('event: session_tree');
		restoreFromBranch(ctx);
		reapplyRestrictions(ctx);
	});

	// ──────────────────────────────────────────────────────────
	// External API — 供 preset.ts 等扩展通过 `(globalThis as any).__toolsApi`
	// 调用，在不直接耦合 imports 的情况下协作修改工具状态。
	//
	// 设计原则：
	//   - replaceTools() 完全替换 enabled 集，排出的工具自动加入
	//     disabledTools，确保 tool_call handler 能拦截
	//   - 调用方自行负责识别自身是否与 tools.ts 共存（不存在时
	//     退化回 pi.setActiveTools()）
	//   - 所有变更即时持久化到 session branch，跨 reload 不丢失
	// ──────────────────────────────────────────────────────────

	// 挂到 globalThis 而非 pi 对象上，避免 ExtensionAPI 的 Proxy / freeze
	// 限制导致属性赋值被静默吞掉
	(globalThis as any).__toolsApi = {
		/**
		 * 完全替换当前工具启用集。
		 *
		 * - 新列表中的工具 → enabled，并从 disabledTools 中移除
		 * - 已知工具中不在新列表的 → 加入 disabledTools（确保 tool_call handler 能拦截）
		 * - 即时调用 applyTools() 推送到 pi 运行时 + persistState() 持久化
		 *
		 * @param toolNames — 启用工具名列表（无效名自动过滤）
		 */
		replaceTools(toolNames: string[]) {
			// 标记外部覆盖，通知 restoreFromBranch 跳过自有恢复，
			// 避免在 handler 执行顺序不确定时旧的 session 数据
			// 覆盖本函数刚设置的值
			externalOverride = true;

			const allToolNames = pi.getAllTools().map((t) => t.name);
			const validTools = toolNames.filter((t) => allToolNames.includes(t));

			if (validTools.length === 0 && toolNames.length > 0) {
				log.warn('replaceTools: all requested tools are unknown', {
					requested: toolNames,
				});
				externalOverride = false; // 无有效工具，复位标记
				return;
			}

			// ① 替换 enabled 集
			enabledTools = new Set(validTools);

			// ② 同步 disabledTools：新列表中包含的 → 解禁；不含的 → 禁用
			for (const t of allToolNames) {
				if (validTools.includes(t)) {
					disabledTools.delete(t);
				} else {
					disabledTools.add(t);
				}
			}

			applyTools();
			persistState();
			log.info('replaceTools: tools replaced', {
				enabled: validTools,
				disabled: [...disabledTools],
			});
		},
	};
}
