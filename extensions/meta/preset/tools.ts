/**
 * Tools Extension
 *
 * Provides a /tools command to enable/disable tools interactively.
 *
 * 状态模型（ADR-0065，取代 ADR-0049 的"两层"假设）：
 * - **无 preset 状态** = pi 的**默认工具选择**：`defaultTools` 设置（`+name`/`-name` 修饰按 pi 语义）
 *   ∪ 非内置工具。本扩展**不持有**任何基础层快照，也不再写 `tools-config` entry。
 * - **preset 叠加层**：`presetOverlay`。preset 激活时设置**封闭集白名单**（非 null 时生效）；
 *   有效活动集 = overlay ∩ allTools。清除 / 切换 preset → 复位到默认工具选择。
 * - **会话恢复**：只按会话里已落痕的 preset 状态判定——已清除则复位，仍激活则由 preset 重放；
 *   从未涉及 preset 则**不干预** pi（尊重 pi 自己的装载清单恢复）。
 * - `/tools` 手改直接写 pi 的活动集（由 pi 记录），**不跨** preset 切换保留。
 *
 * 限制权归属（ADR-0050）：活动工具集的"限制"只有 preset（overlay）与 `/tools`（用户手改）
 * 两个来源；其它扩展/实验只能观测，不得调 setActiveTools 缩减。
 * `tool-range` 实验默认只观测、不限制；仅当用户在 extensions-data/tools/config.json
 * 显式设置 `enableToolRange: true` 报名后，才按其臂结果收紧活动集（不落任何长期状态）。
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

/** pi 的内置默认工具（`defaultTools` 未配置时的启动默认，与 pi 语义一致）。 */
const DEFAULT_TOOL_NAMES = ['read', 'bash', 'edit', 'write'];

/** `+name` / `-name` 修饰项判定（与 pi 的 defaultTools 语义一致）。 */
function isToolModifier(entry: string): boolean {
	return entry.startsWith('+') || entry.startsWith('-');
}

/** 按 pi 语义解析声明的 defaultTools：纯名字替换默认集，`+name`/`-name` 依次增删。 */
export function resolveDeclaredDefaultTools(entries: string[]): string[] {
	const plain = entries.filter((e) => !isToolModifier(e));
	const base = plain.length > 0 || entries.length === 0 ? [...plain] : [...DEFAULT_TOOL_NAMES];
	for (const entry of entries) {
		if (!isToolModifier(entry)) continue;
		const name = entry.slice(1);
		const index = base.indexOf(name);
		if (entry.startsWith('+') && index === -1 && name) base.push(name);
		else if (entry.startsWith('-') && index !== -1) base.splice(index, 1);
	}
	return base;
}

interface ToolRangeConfig {
	/** 显式报名 tool-range 实验（默认 false = 只观测不限制）。 */
	enableToolRange: boolean;
}

export default function toolsExtension(pi: ExtensionAPI) {
	/** 本次应用是否要复位到默认工具选择（preset 清除 / 恢复会话时置位）。 */
	let resetPending = false;
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
	 * - overlay 为 null → pi 自身的活动集（本扩展不持有基础层）
	 */
	function effectiveTools(): string[] {
		const names = toolNames();
		if (presetOverlay !== null) {
			const overlay = new Set(presetOverlay);
			return names.filter((n) => overlay.has(n));
		}
		// 无 overlay：以 pi 自身的活动集为准（本扩展不持有基础层）。
		return pi.getActiveTools().filter((n) => names.includes(n));
	}

	/**
	 * 默认工具选择：pi 的 `defaultTools`（含 `+name`/`-name` 修饰）解析结果 ∪ 非内置工具。
	 *
	 * pi 启动时「内建工具跟随 defaultTools，扩展注册的工具按注册即启用」，这里按同语义
	 * 复算，供 preset 清除 / 会话恢复时复位用（ADR-0065）。
	 */
	function defaultToolSelection(): string[] {
		const names = toolNames();
		const declared = pi.getSettings().defaultTools;
		const base = Array.isArray(declared)
			? resolveDeclaredDefaultTools(declared.filter((t) => typeof t === 'string'))
			: DEFAULT_TOOL_NAMES;
		const extensionTools = allTools
			.filter((t) => t.sourceInfo?.source !== 'builtin')
			.map((t) => t.name);
		const wanted = new Set([...base, ...extensionTools]);
		return names.filter((n) => wanted.has(n));
	}

	// Compute effective set and push to pi runtime
	/**
	 * 计算本次要推给 pi 的工具集；`null` = 不干预（保持 pi 现状）。
	 *
	 * - overlay 存在（preset 激活）→ 白名单 ∩ allTools（封闭集）
	 * - resetPending（preset 清除 / 恢复会话）→ 默认工具选择 - 实验注入
	 * - 仅有实验注入 → 当前活动集 - 注入
	 * - 否则 → null（尊重 pi 的装载清单，绝不从活动集反推）
	 */
	function targetSelection(): string[] | null {
		const names = toolNames();
		if (presetOverlay !== null) {
			const overlay = new Set(presetOverlay);
			return names.filter((n) => overlay.has(n));
		}
		if (resetPending) {
			return defaultToolSelection().filter((n) => !labInjectedDisabled.has(n));
		}
		if (labInjectedDisabled.size > 0) {
			const injected = labInjectedDisabled;
			return pi.getActiveTools().filter((n) => names.includes(n) && !injected.has(n));
		}
		return null;
	}

	// Compute effective set and push to pi runtime
	function applyTools(source: string) {
		// 每次重算前刷新工具清单（运行时可能新注册工具）
		allTools = pi.getAllTools();
		const target = targetSelection();
		if (target === null) {
			log.info('tools untouched', {
				source,
				reason: 'no overlay, no reset, no experiment injection',
				activeCount: pi.getActiveTools().length,
				total: allTools.length,
			});
			return;
		}
		pi.setActiveTools(target);
		resetPending = false;
		log.info('tools applied', {
			source,
			overlay: presetOverlay,
			experimentInjected: Array.from(labInjectedDisabled),
			effectiveCount: target.length,
			total: allTools.length,
			effective: target,
		});
		// 通知 preset 即时刷新偏离状态（用户手动改 tools 后「已偏离 tools」立即出现）
		(globalThis as { __presetDriftRefresh?: () => void }).__presetDriftRefresh?.();
	}

	/**
	 * session 恢复 / 树导航时对齐工具集（ADR-0065）。
	 *
	 * 判据只来自会话里已落痕的 preset 状态（`preset-state` entry 的最后一条）：
	 * - 有记录且 name 为空 → preset 曾激活后已清除 → 复位到默认工具选择
	 * - 有记录且 name 非空 → preset 仍激活 → 由 preset 重放 overlay（此处不干预）
	 * - 无任何记录 → 本会话未涉及 preset，**不干预** pi 的装载清单
	 */
	function syncToolsWithPresetState(ctx: ExtensionContext): void {
		allTools = pi.getAllTools();
		const last = ctx.sessionManager
			.getEntries()
			.filter((e) => e.type === 'custom' && e.customType === 'preset-state')
			.pop() as { data?: { name?: string | null } } | undefined;
		if (!last) {
			log.info('tools untouched', { source: 'restore', reason: 'no preset involvement' });
			return;
		}
		if (last.data?.name) return; // preset 仍激活，overlay 由 preset 侧施加
		resetPending = true;
		applyTools('preset-clear');
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
						const enabledNow = new Set(effectiveTools());
						const willEnable = !enabledNow.has(id);
						const nextTools = new Set(enabledNow);
						if (willEnable) nextTools.add(id);
						else nextTools.delete(id);

						if (guard) {
							const r = guard.canModify('tools', [...nextTools]);
							if (!r.allowed) {
								ctx.ui.notify(r.reason ?? 'tools 修改不被允许', 'error');
								return;
							}
						}

						if (willEnable) {
							// 用户在 core 臂下启用被实验禁用的工具 → 整体退出实验注入
							if (labInjectedDisabled.size > 0) {
								for (const tool of allTools) nextTools.add(tool.name);
								labInjectedDisabled.clear();
								log.info(
									'tool-range: user override — experiment injection exited',
									{
										tool: id,
									},
								);
							}
						} else {
							labInjectedDisabled.delete(id);
						}

						// 手改直接写 pi 的活动集（pi 自己记录装载清单），不再维护私有基础层
						const names = new Set(toolNames());
						const applied = [...nextTools].filter((n) => names.has(n));
						pi.setActiveTools(applied);
						log.info('tools applied', {
							source: 'manual',
							effectiveCount: applied.length,
							total: allTools.length,
							effective: applied,
						});
						(
							globalThis as { __presetDriftRefresh?: () => void }
						).__presetDriftRefresh?.();

						const toggled = items.find((i) => i.id === id);
						if (toggled) {
							toggled.label = `${willEnable ? '• ' : '  '}${id}`;
						}
						tui.requestRender();
					},
					() => {
						// Log final state on confirm (Esc)
						const { enabled, total } = getToolCounts();
						log.info('tools config closed', {
							enabled,
							total,
							active: pi.getActiveTools(),
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
	 * 不在有效活动集内的已知工具一律拦截（preset 封闭集 / 用户手改）。
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
	// 默认只观测不限制；仅显式报名（config.json enableToolRange=true）后按其臂收紧活动集。
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

	/**
	 * 实验分流（仅显式报名时）。
	 * 未报名：只观测，不改变活动集（ADR-0050 决策 3 / B2）。
	 * 返回是否实际收紧了活动集。
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
			const coreNames = new Set(resolveCoreToolNames(allNames));
			labInjectedDisabled = new Set(allNames.filter((n) => !coreNames.has(n)));
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
		log.info(
			'tool-range assigned arm=%s effective=%d injected=%d',
			armId,
			effectiveTools().length,
			labInjectedDisabled.size,
		);
		return true;
	}

	// 会话恢复 / 树导航：对齐 preset 状态与工具集（ADR-0065），随后（仅报名时）跑实验
	pi.on('session_start', async (_event, ctx) => {
		syncToolsWithPresetState(ctx);
		initToolRangeExperiment(ctx);
		await assignToolRangeArm(ctx);
	});

	pi.on('session_tree', async (_event, ctx) => {
		syncToolsWithPresetState(ctx);
	});
	// 动态注册遮蔽：preset overlay 生效时，每次请求前重算（封闭集遮蔽运行时新注册的工具）。
	// 无 overlay 时不干预：pi 的活动集由用户/注册方自管（org off-duty 收回自有工具不应被覆盖）。
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
		 * 设置 preset 叠加层（封闭集白名单）。不写任何长期工具状态。
		 */
		setOverlay(toolNames: string[]) {
			allTools = pi.getAllTools();
			presetOverlay = [...toolNames];
			applyTools('preset-overlay');
		},
		/**
		 * 撤回 preset 叠加层（切换 / 清除预设）：
		 * 活动集复位到**默认工具选择**（pi 的 defaultTools 解析 ∪ 非内置工具）。
		 */
		clearOverlay() {
			presetOverlay = null;
			resetPending = true;
			applyTools('preset-clear');
		},
		/** 当前有效活动集（供测试/调试观测）。 */
		getEffective(): string[] {
			return effectiveTools();
		},
		/** 撤回 tool-range 注入的限制（preset 激活时实验退避）。 */
		clearExperimentInjection() {
			if (labInjectedDisabled.size === 0) return;
			labInjectedDisabled = new Set();
			applyTools('experiment-backoff');
		},
		/**
		 * 兼容旧 API：把活动集直接设为给定列表（等价于有人在 `/tools` 里逐项改）。
		 * 新代码请用 setOverlay/clearOverlay。
		 */
		replaceTools(names: string[]) {
			allTools = pi.getAllTools();
			const all = new Set(toolNames());
			const wanted = names.filter((n) => all.has(n));
			pi.setActiveTools(wanted);
			log.info('tools applied', {
				source: 'replace',
				effectiveCount: wanted.length,
				total: allTools.length,
				effective: wanted,
			});
			(globalThis as { __presetDriftRefresh?: () => void }).__presetDriftRefresh?.();
		},
	};
}
