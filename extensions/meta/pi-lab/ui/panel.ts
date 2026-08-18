/**
 * /lab 命令的 TUI 面板
 *
 * 两级导航（master-detail）：
 *
 *   一级（实验列表，1 个 SelectList + 滚动视口）:
 *     ┌── pi-lab ──────────────────────────────┐
 *       [分桶] [汇总]
 *      ────────────────────────────────────────
 *      → edit:edit-strategy    精确匹配 vs 模糊行匹配
 *        custom-compaction:prompt-strategy  ...
 *      ────────────────────────────────────────
 *       Tab/⇧Tab 切标签 · ↑↓ 导航 · ⏎ 进入 · esc 关闭
 *     └───────────────────────────────────────┘
 *
 *   二级（实验操作，操作条 Tab 切换）:
 *     ┌── pi-lab · custom-compaction:prompt-strategy ──┐
 *       [统计] [设置] [重置]
 *      ────────────────────────────────────────────────
 *       （统计图表 / 设置表单 / 重置确认）
 *      ────────────────────────────────────────────────
 *       Tab/⇧Tab 切操作 · esc 返回
 *     └───────────────────────────────────────────────┘
 *
 * 键盘约定：
 *   一级：Tab/Shift+Tab — 切换 分桶 / 汇总；↑↓ — 导航；⏎ — 进入实验；Esc — 关闭
 *   二级：Tab/Shift+Tab — 切换 统计 / 设置 / 重置；←→ — 统计页切指标；Esc — 返回一级
 *
 * 设计要点（修复旧版平铺菜单的 3 个病根）：
 *   1. 操作不重复渲染：统计/设置/重置从每个实验内嵌的 SelectList 收敛为二级操作条（撑高消失）
 *   2. 焦点管理：每屏只有 1 个 SelectList（一级列表 / 设置臂 / 重置确认），焦点可流转（旧版 N 个
 *      SelectList 且 activeSelectListIndex 恒 0 导致焦点卡死在第一个实验的 bug 消失）
 *   3. 导航/操作分层：一级选实验（导航），二级对当前实验操作（master-detail）
 *   4. 一级列表带滚动视口上限（MAX_VISIBLE_EXPERIMENTS），实验数超过时滚动不撑高
 */

import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import {
	Container,
	parseKey,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
} from '@earendil-works/pi-tui';
import type { ExperimentManager } from '../core/experiment-manager.js';
import type { ExperimentOperation, MetricDef, PanelTab, PanelView, QueryResult } from '../types.js';

// 胜出高亮的最小样本量护栏：极小样本（如 n=1 vs n=0）胜率可达 100%，
// 过早高亮为「显著胜出」会误导结论
const MIN_WINNER_SAMPLES = 10;

// 一级列表最大可视行数（滚动视口上限）：实验数超过时 SelectList 内部滚动，面板不撑高
const MAX_VISIBLE_EXPERIMENTS = 8;

// 二级统计页内容最大可视行数：指标/模型/arm 多时内容超长，滚动视口防止撑爆终端高度
const MAX_CONTENT_LINES = 10;

export function showPanel(ctx: ExtensionCommandContext, manager: ExperimentManager): Promise<void> {
	return ctx.ui.custom<void>((tui, theme, _kb, done) => {
		let currentTab: PanelTab = 'bucket';
		let currentView: PanelView = { kind: 'menu', tab: 'bucket' };
		let dismissed = false;
		let currentWidth = 80; // fallback width（首次 render 时被真实宽度覆盖）
		let needsFirstRebuild = true;
		let metricIndex = 0;
		/** 二级统计页内容滚动偏移（指标/模型/arm 多时 ↑↓ 滚动） */
		let contentScroll = 0;

		const safeDone = () => {
			if (dismissed) return;
			dismissed = true;
			done(undefined);
		};

		const container = new Container();

		// ── SelectList 管理：每屏至多 1 个（一级列表 / 设置臂 / 重置确认）──
		let activeSelectList: SelectList | null = null;

		// ── 主题辅助 ──

		const accent = (s: string) => theme.fg('accent', s);
		const dim = (s: string) => theme.fg('dim', s);
		const muted = (s: string) => theme.fg('muted', s);
		const bold = (s: string) => theme.bold(s);

		// ── 实验显示名（owner:name，区分实验归属插件）──

		function displayName(name: string, owner: string | undefined): string {
			return owner ? `${owner}:${name}` : name;
		}

		// ── 顶部边框（标题写在边框线上）──

		function renderTopBorder(title: string) {
			// 标题过长（如 custom-compaction:profile-satisfaction）时截断，避免窄终端顶边框超宽
			const maxTitleWidth = Math.max(0, currentWidth - 6); // 预留 "┌──" + "  " + "┐"
			const safeTitle = truncateToWidth(title, maxTitleWidth, '');
			const topName = ` ${safeTitle} `;
			const topFill = Math.max(0, currentWidth - 4 - visibleWidth(topName));
			container.addChild(
				new Text(
					accent('\u250c\u2500\u2500') +
						dim(topName) +
						accent('\u2500'.repeat(topFill) + '\u2510'),
					0,
					0,
				),
			);
		}

		/** 中间分隔线：左右各缩进 1 字符，与 ┌┐ 框的横线对齐 */
		function renderDivider() {
			container.addChild(
				new Text(accent(' ' + '\u2500'.repeat(Math.max(0, currentWidth - 2)) + ' '), 0, 0),
			);
		}

		/** 横向标签/操作条（选中项 accent+bold，其余 dim） */
		function renderPills(
			items: Array<{ key: string; label: string }>,
			activeKey: string,
		): void {
			const parts = items.map((item) =>
				item.key === activeKey
					? accent(bold(`  ${item.label}  `))
					: dim(`  ${item.label}  `),
			);
			container.addChild(new Text(parts.join(''), 0, 0));
		}

		// ── 一级：实验列表 ──

		function renderMenu() {
			activeSelectList = null;

			const experiments = manager.getAllExperiments();

			if (experiments.length === 0) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(muted('  暂无已注册实验。'), 0, 0));
				container.addChild(new Text(dim('  通过 lab.registerExperiment() 注册实验'), 0, 0));
				return;
			}

			const items: SelectItem[] = experiments.map(({ name, owner, info }) => {
				const armLabels = info.arms.map((a: any) => a.label ?? a.id).join(' vs ');
				return {
					value: name,
					label: displayName(name, owner),
					description: `${info.forceArmId ? `[强制:${info.forceArmId}] ` : ''}${armLabels}`,
				};
			});

			const maxVisible = Math.min(items.length, MAX_VISIBLE_EXPERIMENTS);
			const list = new SelectList(
				items,
				maxVisible,
				{
					selectedPrefix: (s: string) => accent('> ' + s),
					selectedText: (s: string) => accent(s),
					description: (s: string) => dim(s),
					scrollInfo: (s: string) => dim(s),
					noMatch: (s: string) => muted(s),
				},
				// 主列放宽：owner:name（如 custom-compaction:prompt-strategy）默认 32 列会截断
				{ maxPrimaryColumnWidth: 40 },
			);

			list.onSelect = (item) => {
				// 进入二级：切换实验时重置指标索引与内容滚动偏移
				metricIndex = 0;
				contentScroll = 0;
				currentView = {
					kind: 'experiment-operations',
					experimentName: item.value,
					operation: 'stats',
					tab: currentTab,
				};
				rebuild();
				tui.requestRender();
			};
			list.onCancel = () => safeDone();

			activeSelectList = list;
			container.addChild(list);
		}

		// ── 统计详情 ──

		function renderArmAnalysis(
			lines: string[],
			metricDef: MetricDef,
			result: QueryResult,
			armLabel: Map<string, string>,
		) {
			const isRate = metricDef.type === 'binary';
			for (const arm of result.arms) {
				const label = armLabel.get(arm.armId) ?? arm.armId;
				if (arm.n === 0) {
					lines.push(`    ${label}: ${muted('暂无数据')}`);
					continue;
				}
				if (isRate) {
					const pct = (arm.mean * 100).toFixed(1);
					const low = Math.max(0, arm.credibleInterval.low * 100).toFixed(0);
					const high = Math.min(100, arm.credibleInterval.high * 100).toFixed(0);
					lines.push(
						`    ${label}: 预估成功率 ${pct}%（${arm.n} 次）真实约 ${low}%~${high}%`,
					);
				} else {
					lines.push(`    ${label}: 均值 ${arm.mean.toFixed(1)}（${arm.n} 次）`);
				}
			}
			for (const alert of result.guardrailAlert) {
				const label = armLabel.get(alert.armId) ?? alert.armId;
				lines.push(
					`    ${theme.fg('error', `护栏: ${label} 更差 ${(alert.pWorse * 100).toFixed(0)}%`)}`,
				);
			}
		}

		/**
		 * 自动解读：把贝叶斯术语翻译成通俗结论，避免 AB 测试专业性困扰用户。
		 * 只陈述「事实 + 可操作建议」，不下无数据支撑的判断。
		 */
		function renderInsight(
			lines: string[],
			result: QueryResult,
			armLabel: Map<string, string>,
		): void {
			const withData = result.arms.filter((a) => a.n > 0);
			const noData = result.arms.filter((a) => a.n === 0);
			const name = (id: string) => armLabel.get(id) ?? id;

			const conclusions: string[] = [];
			const hints: string[] = [];

			if (withData.length === 0) {
				hints.push('尚未采集到数据，先用 edit 工具编辑几次再回来看');
			} else if (withData.length === 1 && noData.length >= 1) {
				// 单臂有数据：无法对比，解释稳定分流
				hints.push(`${name(noData[0].armId)} 暂无样本，两策略暂时无法对比`);
				hints.push(
					'分流按会话稳定：同一模型的不同会话会分到不同臂，多开几个会话即可让另一侧分到流量',
				);
				if (currentTab === 'bucket') {
					hints.push('想看整体对比，esc 返回一级后 Tab 切「汇总」再进入');
				}
				if (withData[0].n < MIN_WINNER_SAMPLES) {
					hints.push(`当前仅 ${withData[0].n} 次样本，结论仅供参考`);
				}
			} else {
				const minN = Math.min(...withData.map((a) => a.n));
				if (minN < MIN_WINNER_SAMPLES) {
					hints.push(`样本还少（最少一侧仅 ${minN} 次），结论仅供参考`);
				}
				const winner = withData.find(
					(a) => a.winProbability >= 0.95 && a.n >= MIN_WINNER_SAMPLES,
				);
				if (winner) {
					conclusions.push(
						`${name(winner.armId)} 目前明显更优（把握 ${Math.round(winner.winProbability * 100)}%）`,
					);
				} else if (withData.every((a) => a.n >= MIN_WINNER_SAMPLES)) {
					hints.push('两策略目前无显著差距，继续观察');
				}
			}

			if (conclusions.length === 0 && hints.length === 0) return;
			for (const c of conclusions) {
				lines.push(`  ${accent('· ' + c)}`);
			}
			for (const h of hints) {
				lines.push(`  ${dim('· ' + h)}`);
			}
		}

		function renderDetail(experimentName: string) {
			const exp = manager.getExperimentRaw(experimentName);
			if (!exp) {
				container.addChild(new Text(dim('  实验不存在'), 0, 0));
				return;
			}

			const info = exp.getInfo();
			if (info.metrics.length === 0) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(muted('  未定义指标。'), 0, 0));
				return;
			}
			const metricDef = info.metrics[metricIndex % info.metrics.length];
			const armLabel = new Map<string, string>();
			for (const a of info.arms) {
				armLabel.set(a.id, a.label ?? a.id);
			}

			// 先收集全部内容行（含 ANSI），再按 contentScroll 切片渲染——指标/模型/arm
			// 多时内容超长，滚动视口防止撑爆终端高度（TUI 铁律：组件总高 ≤ 视口）
			const lines: string[] = [];

			lines.push('');
			lines.push(
				truncateToWidth(
					`  ${accent(bold(displayName(experimentName, manager.getOwner(experimentName))))}`,
					currentWidth,
					'',
				),
			);

			if (info.loadWarning) {
				// 历史数据整体读取失败：显式提示而非静默空态
				lines.push(`  ${theme.fg('error', '历史数据加载失败: ' + info.loadWarning)}`);
			}

			if (info.forceArmId) {
				lines.push(`  ${accent(`>> 强制: ${info.forceArmId}`)}`);
			}

			lines.push(`  ${dim(`指标: ${metricDef.id}  [< > 切换]`)}`);
			if (metricDef.description) {
				lines.push(`  ${dim(metricDef.description)}`);
			}

			lines.push('');

			if (currentTab === 'global') {
				const result = exp.query(metricDef.id);
				renderArmAnalysis(lines, metricDef, result, armLabel);
				renderInsight(lines, result, armLabel);
			} else {
				const ctxKeys = exp.getContextKeys();
				if (ctxKeys.length === 0) {
					lines.push(muted('  尚未采集到数据。'));
				}
				for (const ctxKey of ctxKeys) {
					lines.push(`  ${accent(ctxKey)}`);
					// 用 queryByCtxKey 按已解析 ctxKey 过滤，避免函数型 contextKey 二次解析
					const result = exp.queryByCtxKey(metricDef.id, ctxKey);
					renderArmAnalysis(lines, metricDef, result, armLabel);
					renderInsight(lines, result, armLabel);
				}
			}

			// 切片渲染（clamp 越界偏移；内容变化导致行数变少时自动纠正）
			const maxOffset = Math.max(0, lines.length - MAX_CONTENT_LINES);
			if (contentScroll > maxOffset) contentScroll = maxOffset;
			const visible = lines.slice(contentScroll, contentScroll + MAX_CONTENT_LINES);
			for (const line of visible) {
				container.addChild(new Text(line, 0, 0));
			}
			// 滚动指示（内容超长时提示可滚动）
			if (lines.length > MAX_CONTENT_LINES) {
				const end = Math.min(contentScroll + MAX_CONTENT_LINES, lines.length);
				container.addChild(
					new Text(
						dim(`  (${contentScroll + 1}-${end}/${lines.length}) \u2191\u2193 滚动`),
						0,
						0,
					),
				);
			}
		}

		// ── 设置（强制臂）──

		function renderSettings(experimentName: string) {
			const exp = manager.getExperimentRaw(experimentName);
			if (!exp) {
				container.addChild(new Text(dim('  实验不存在'), 0, 0));
				return;
			}

			container.addChild(new Spacer(1));

			const info = exp.getInfo();
			const currentLabel = info.forceArmId === null ? '(自动)' : info.forceArmId;
			container.addChild(new Text(`  ${dim('强制臂:')} ${accent(currentLabel)}`, 0, 0));
			container.addChild(new Spacer(1));

			const items: SelectItem[] = [
				{ value: '__auto__', label: '(自动)' },
				...info.arms.map((a) => ({ value: a.id, label: a.label ?? a.id })),
			];
			const list = new SelectList(items, items.length, {
				selectedPrefix: (s: string) => accent('> ' + s),
				selectedText: (s: string) => accent(s),
				description: (s: string) => dim(s),
				scrollInfo: (s: string) => dim(s),
				noMatch: (s: string) => muted(s),
			});
			list.onSelect = (item) => {
				const armId = item.value === '__auto__' ? null : item.value;
				// 走公开 API 的 forceArm（内部同步 setStatus('switched'/'collecting')），
				// 状态栏才能反映「已切换」；直接 exp.forceArm 只改 _forceArmId，状态栏不更新
				manager.getExperiment(experimentName)?.forceArm(armId);
				currentView = { kind: 'menu', tab: currentTab };
				rebuild();
				tui.requestRender();
			};
			list.onCancel = () => {
				currentView = { kind: 'menu', tab: currentTab };
				rebuild();
				tui.requestRender();
			};
			activeSelectList = list;
			container.addChild(list);
		}

		// ── 重置确认 ──

		function renderConfirmReset(experimentName: string) {
			const exp = manager.getExperimentRaw(experimentName);
			if (!exp) {
				container.addChild(new Text(dim('  Experiment not found'), 0, 0));
				return;
			}

			container.addChild(new Spacer(1));
			container.addChild(
				new Text(
					`  ${theme.fg('error', bold('重置: ' + displayName(experimentName, manager.getOwner(experimentName))))}`,
					0,
					0,
				),
			);
			container.addChild(new Spacer(1));

			const items: SelectItem[] = [
				{ value: 'cancel', label: '取消' },
				{ value: 'confirm', label: '确认清空全部数据' },
			];
			const list = new SelectList(items, items.length, {
				selectedPrefix: (s: string) => accent('> ' + s),
				selectedText: (s: string) => accent(s),
				description: (s: string) => dim(s),
				scrollInfo: (s: string) => dim(s),
				noMatch: (s: string) => muted(s),
			});
			list.onSelect = (item) => {
				if (item.value === 'confirm') {
					void exp
						.reset()
						.then(() => {
							currentView = { kind: 'menu', tab: currentTab };
							rebuild();
							tui.requestRender();
						})
						.catch((err: unknown) => {
							// 写盘失败：显示错误而非跳回菜单，避免静默假成功
							const msg = err instanceof Error ? err.message : String(err);
							container.clear();
							renderTopBorder('pi-lab');
							renderOperationBar();
							container.addChild(new Spacer(1));
							container.addChild(
								new Text(`  ${theme.fg('error', '重置失败: ' + msg)}`, 0, 0),
							);
							renderHelpBar();
							tui.requestRender();
						});
				} else {
					currentView = { kind: 'menu', tab: currentTab };
					rebuild();
					tui.requestRender();
				}
			};
			list.onCancel = () => {
				currentView = { kind: 'menu', tab: currentTab };
				rebuild();
				tui.requestRender();
			};
			activeSelectList = list;
			container.addChild(list);
		}

		// ── 二级：操作条 + 内容 ──

		function renderOperationBar() {
			const ops: Array<{ key: ExperimentOperation; label: string }> = [
				{ key: 'stats', label: '统计' },
				{ key: 'settings', label: '设置' },
				{ key: 'reset', label: '重置' },
			];
			const active =
				currentView.kind === 'experiment-operations' ? currentView.operation : 'stats';
			const parts = ops.map((o) =>
				o.key === active ? accent(bold(`[${o.label}]`)) : dim(`[${o.label}]`),
			);
			container.addChild(new Text('  ' + parts.join(' '), 0, 0));
		}

		function renderOperations() {
			activeSelectList = null;
			if (currentView.kind !== 'experiment-operations') return;
			const { experimentName, operation } = currentView;
			switch (operation) {
				case 'stats':
					renderDetail(experimentName);
					break;
				case 'settings':
					renderSettings(experimentName);
					break;
				case 'reset':
					renderConfirmReset(experimentName);
					break;
			}
		}

		// ── 底部帮助栏 ──

		function renderHelpBar() {
			// 中间分隔线：左右各缩进 1 字符，与 └┘ 框的横线对齐
			renderDivider();
			container.addChild(
				new Text(
					dim(
						currentView.kind === 'menu'
							? '  Tab/\u21E7Tab 切标签 \u00B7 \u2191\u2193 导航 \u00B7 \u23CE 进入 \u00B7 esc 关闭'
							: currentView.operation === 'stats'
								? '  Tab/\u21E7Tab 切操作 \u00B7 \u2190\u2192 切指标 \u00B7 \u2191\u2193 滚动 \u00B7 esc 返回'
								: '  Tab/\u21E7Tab 切操作 \u00B7 esc 返回',
					),
					0,
					0,
				),
			);
			// 底部边框 └─┘
			container.addChild(
				new Text(
					accent('\u2514' + '\u2500'.repeat(Math.max(0, currentWidth - 2)) + '\u2518'),
					0,
					0,
				),
			);
		}

		// ── 重建 ──

		function rebuild() {
			container.clear();

			if (currentView.kind === 'experiment-operations') {
				const exp = manager.getExperimentRaw(currentView.experimentName);
				const title = exp
					? `pi-lab \u00B7 ${displayName(exp.getInfo().name, manager.getOwner(currentView.experimentName))}`
					: 'pi-lab';
				renderTopBorder(title);
				renderOperationBar();
				renderDivider();
				renderOperations();
			} else {
				renderTopBorder('pi-lab');
				// 事件无 sessionId 维度，信号按 contextKey（消费方声明的分桶键）分组。
				// 「分桶」而非「按模型」：contextKey 是通用机制，消费方可按任意维度分桶
				// （模型/项目/语言…），不应把当前两个消费方都用模型分桶的事实写死进标签。
				renderPills(
					[
						{ key: 'bucket', label: '分桶' },
						{ key: 'global', label: '汇总' },
					],
					currentTab,
				);
				renderDivider();
				renderMenu();
			}

			renderHelpBar();
		}

		// ── 输入处理 ──

		function handleInput(data: string) {
			// 用 parseKey 解析按键：兼容 Kitty 键盘协议（按键以 CSI-u 多字节序列到达，
			// 直接比 raw 字节 '\t'/'\\x1b' 会全部失效，表现为「按键无响应」）。
			const key = parseKey(data) ?? data;

			// Esc → 上一级：一级关闭面板，二级返回一级
			if (key === 'escape') {
				if (currentView.kind === 'menu') {
					safeDone();
				} else {
					currentView = { kind: 'menu', tab: currentTab };
					rebuild();
					tui.requestRender();
				}
				return;
			}

			// Tab/Shift+Tab → 一级切「分桶/汇总」标签；二级切「统计/设置/重置」操作
			if (key === 'tab' || key === 'shift+tab') {
				if (currentView.kind === 'menu') {
					currentTab = currentTab === 'bucket' ? 'global' : 'bucket';
					currentView = { kind: 'menu', tab: currentTab };
				} else if (currentView.kind === 'experiment-operations') {
					const ops: ExperimentOperation[] = ['stats', 'settings', 'reset'];
					const idx = ops.indexOf(currentView.operation);
					const next =
						key === 'shift+tab'
							? (idx - 1 + ops.length) % ops.length
							: (idx + 1) % ops.length;
					currentView = { ...currentView, operation: ops[next] };
					// 切换操作时重置内容滚动偏移
					contentScroll = 0;
				}
				rebuild();
				tui.requestRender();
				return;
			}

			// 二级统计页：←/→ 循环切换指标；↑/↓ 滚动内容（返回一级用 esc）
			if (currentView.kind === 'experiment-operations' && currentView.operation === 'stats') {
				if (key === 'right' || key === 'left') {
					const exp = manager.getExperimentRaw(currentView.experimentName);
					const metricCount = exp?.getInfo().metrics.length ?? 0;
					if (metricCount > 0) {
						const delta = key === 'right' ? 1 : -1;
						// 双向循环（负索引安全：metrics[-1] 会是 undefined）
						metricIndex =
							(((metricIndex + delta) % metricCount) + metricCount) % metricCount;
						// 切换指标后内容回到顶部
						contentScroll = 0;
						rebuild();
						tui.requestRender();
					}
				} else if (key === 'down' || key === 'up') {
					// 内容滚动（上限在 renderDetail 里 clamp，这里只防负）
					contentScroll += key === 'down' ? 1 : -1;
					if (contentScroll < 0) contentScroll = 0;
					rebuild();
					tui.requestRender();
				}
				return;
			}

			// 其余（一级列表导航 / 设置臂 / 重置确认）：委派给当前唯一 SelectList
			if (activeSelectList) {
				activeSelectList.handleInput(data);
				tui.requestRender();
			}
		}

		// 不要在 render(width) 前调用 rebuild()，否则初始分割线宽度是 80
		needsFirstRebuild = true;

		// 最小高度：防止 menu/detail/settings 视图切换时面板高度抖动
		const MIN_TOTAL_LINES = 12;

		return {
			render(width: number) {
				currentWidth = width;
				if (needsFirstRebuild) {
					needsFirstRebuild = false;
					rebuild();
				}
				const rendered = container.render(width);
				if (rendered.length >= MIN_TOTAL_LINES) return rendered;
				// 复制后追加透明空行，避免污染 Container 内部缓存
				const lines = [...rendered];
				for (let i = lines.length; i < MIN_TOTAL_LINES; i++) {
					lines.push('');
				}
				return lines;
			},
			invalidate() {
				container.invalidate();
			},
			handleInput,
		};
	});
}
