/**
 * /lab 命令的 TUI 面板
 *
 * 布局（无左右竖线边框）:
 *
 *   [当前会话]  全局
 *   ──────────────────────────────
 *   Edit Strategy
 *   ├─ 统计
 *   ├─ 设置
 *   └─ 重置
 *   ──────────────────────────────
 *   Tab/⇧Tab 切标签 · ↑↓ 导航 · ⏎ 确认 · esc 关闭
 *
 * 键盘约定：
 *   Tab / Shift+Tab  — 切换 当前会话 / 全局 标签
 *   ↑↓               — 在菜单行之间导航（由 SelectList 管理）
 *   ⏎                — 选择当前项
 *   Esc              — 关闭面板
 */

import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import {
	Container,
	parseKey,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
} from '@earendil-works/pi-tui';
import type { ExperimentManager } from '../core/experiment-manager.js';
import type { MetricDef, PanelTab, PanelView, QueryResult } from '../types.js';

// 胜出高亮的最小样本量护栏：极小样本（如 n=1 vs n=0）胜率可达 100%，
// 过早高亮为「显著胜出」会误导结论
const MIN_WINNER_SAMPLES = 10;

export function showPanel(ctx: ExtensionCommandContext, manager: ExperimentManager): Promise<void> {
	return ctx.ui.custom<void>((tui, theme, _kb, done) => {
		let currentTab: PanelTab = 'session';
		let currentView: PanelView = { kind: 'menu' };
		let dismissed = false;
		let currentWidth = 80; // fallback width（首次 render 时被真实宽度覆盖）
		let needsFirstRebuild = true;
		let metricIndex = 0;

		const safeDone = () => {
			if (dismissed) return;
			dismissed = true;
			done(undefined);
		};

		const container = new Container();

		// ── SelectList 管理 ──
		let activeSelectLists: SelectList[] = [];
		let activeSelectListIndex = 0;

		// ── 主题辅助 ──

		const accent = (s: string) => theme.fg('accent', s);
		const dim = (s: string) => theme.fg('dim', s);
		const muted = (s: string) => theme.fg('muted', s);
		const bold = (s: string) => theme.bold(s);

		// ── Tab Bar ──

		function renderTabBar() {
			// 事件无 sessionId 维度，「session」实为按上下文键（模型）分组展示，
			// 「global」为跨上下文汇总——标签如实命名，避免误导为「当前会话」。
			const tabs = [
				{ key: 'session' as PanelTab, label: '按模型' },
				{ key: 'global' as PanelTab, label: '汇总' },
			];
			const parts = tabs.map((tab) => {
				const isActive = currentTab === tab.key;
				return isActive ? accent(bold(`  ${tab.label}  `)) : dim(`  ${tab.label}  `);
			});
			// 顶部边框 ┌── pi-lab ──┐：插件名居中于边框线，名字用 dim 弱化（代替改字号）
			const topName = ' pi-lab ';
			const topFill = Math.max(0, currentWidth - 2 - 2 - topName.length);
			container.addChild(
				new Text(
					accent('\u250c\u2500\u2500') +
						dim(topName) +
						accent('\u2500'.repeat(topFill) + '\u2510'),
					0,
					0,
				),
			);
			container.addChild(new Text(parts.join(''), 0, 0));
			// 中间分隔线：左右各缩进 1 字符，与 ┌┐ 框的横线对齐
			container.addChild(
				new Text(accent(' ' + '\u2500'.repeat(Math.max(0, currentWidth - 2)) + ' '), 0, 0),
			);
		}

		// ── 菜单视图 ──

		function renderMenu() {
			activeSelectLists = [];
			activeSelectListIndex = 0;

			const experiments = manager.getAllExperiments();

			if (experiments.length === 0) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(muted('  暂无已注册实验。'), 0, 0));
				container.addChild(new Text(dim('  通过 lab.registerExperiment() 注册实验'), 0, 0));
				return;
			}

			for (const { name, info } of experiments) {
				const armLabels = info.arms.map((a: any) => a.label ?? a.id).join(' vs ');
				const statusBadge = info.forceArmId
					? accent(` [强制:${info.forceArmId}]`)
					: dim(` (${info.strategy})`);

				container.addChild(new Spacer(1));
				container.addChild(new Text(`  ${accent(bold(name))}${statusBadge}`, 0, 0));
				container.addChild(new Text(`    ${dim(armLabels)}`, 0, 0));

				// 操作菜单
				const menuItems: SelectItem[] = [
					{
						value: 'stats',
						label: '统计',
						description: '查看各模型/实验臂的统计',
					},
					{
						value: 'settings',
						label: '设置',
						description: '配置强制臂、分流策略',
					},
					{
						value: 'reset',
						label: '重置',
						description: '清空实验数据',
					},
				];

				const list = new SelectList(menuItems, 3, {
					selectedPrefix: (s: string) => accent('> ' + s),
					selectedText: (s: string) => accent(s),
					description: (s: string) => dim(s),
					scrollInfo: (s: string) => dim(s),
					noMatch: (s: string) => muted(s),
				});

				list.onSelect = (item) => {
					const view = item.value;
					if (view === 'stats') {
						currentView = {
							kind: 'experiment-detail',
							experimentName: name,
							tab: currentTab,
						};
					} else if (view === 'settings') {
						currentView = { kind: 'settings', experimentName: name };
					} else if (view === 'reset') {
						currentView = {
							kind: 'confirm-reset',
							experimentName: name,
							tab: currentTab,
						};
					}
					rebuild();
					tui.requestRender();
				};
				list.onCancel = () => safeDone();

				activeSelectLists.push(list);
				container.addChild(list);
			}
		}

		// ── 统计详情视图 ──

		function renderArmAnalysis(
			metricDef: MetricDef,
			result: QueryResult,
			armLabel: Map<string, string>,
		) {
			const isRate = metricDef.type === 'binary';
			for (const arm of result.arms) {
				const label = armLabel.get(arm.armId) ?? arm.armId;
				if (arm.n === 0) {
					container.addChild(new Text(`    ${label}: ${muted('暂无数据')}`, 0, 0));
					continue;
				}
				if (isRate) {
					const pct = (arm.mean * 100).toFixed(1);
					const low = Math.max(0, arm.credibleInterval.low * 100).toFixed(0);
					const high = Math.min(100, arm.credibleInterval.high * 100).toFixed(0);
					container.addChild(
						new Text(
							`    ${label}: 预估成功率 ${pct}%（${arm.n} 次）真实约 ${low}%~${high}%`,
							0,
							0,
						),
					);
				} else {
					container.addChild(
						new Text(`    ${label}: 均值 ${arm.mean.toFixed(1)}（${arm.n} 次）`, 0, 0),
					);
				}
			}
			for (const alert of result.guardrailAlert) {
				const label = armLabel.get(alert.armId) ?? alert.armId;
				container.addChild(
					new Text(
						`    ${theme.fg('error', `护栏: ${label} 更差 ${(alert.pWorse * 100).toFixed(0)}%`)}`,
						0,
						0,
					),
				);
			}
		}

		/**
		 * 自动解读：把贝叶斯术语翻译成通俗结论，避免 AB 测试专业性困扰用户。
		 * 只陈述「事实 + 可操作建议」，不下无数据支撑的判断。
		 */
		function renderInsight(result: QueryResult, armLabel: Map<string, string>): void {
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
				hints.push('稳定分流会把同一模型固定分到一侧，换不同模型编辑即可让另一侧分到流量');
				if (currentTab === 'session') {
					hints.push('想看整体对比，按 Tab 切到「汇总」');
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
				container.addChild(new Text(`  ${accent('· ' + c)}`, 0, 0));
			}
			for (const h of hints) {
				container.addChild(new Text(`  ${dim('· ' + h)}`, 0, 0));
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

			container.addChild(new Spacer(1));
			container.addChild(
				new Text(`  ${accent(bold(experimentName))} ${dim(info.strategy)}`, 0, 0),
			);

			if (info.loadWarning) {
				// 历史数据整体读取失败：显式提示而非静默空态
				container.addChild(
					new Text(
						`  ${theme.fg('error', '历史数据加载失败: ' + info.loadWarning)}`,
						0,
						0,
					),
				);
			}

			if (info.forceArmId) {
				container.addChild(new Text(`  ${accent(`>> 强制: ${info.forceArmId}`)}`, 0, 0));
			}

			container.addChild(new Text(`  ${dim(`指标: ${metricDef.id}  [< > 切换]`)}`, 0, 0));
			if (metricDef.description) {
				container.addChild(new Text(`  ${dim(metricDef.description)}`, 0, 0));
			}

			container.addChild(new Spacer(1));

			if (currentTab === 'global') {
				const result = exp.query(metricDef.id);
				renderArmAnalysis(metricDef, result, armLabel);
				renderInsight(result, armLabel);
			} else {
				const ctxKeys = exp.getContextKeys();
				if (ctxKeys.length === 0) {
					container.addChild(new Text(muted('  尚未采集到数据。'), 0, 0));
				}
				for (const ctxKey of ctxKeys) {
					container.addChild(new Text(`  ${accent(ctxKey)}`, 0, 0));
					// 用 queryByCtxKey 按已解析 ctxKey 过滤，避免函数型 contextKey 二次解析
					const result = exp.queryByCtxKey(metricDef.id, ctxKey);
					renderArmAnalysis(metricDef, result, armLabel);
					renderInsight(result, armLabel);
				}
			}
		}

		// ── 设置视图 ──

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
				currentView = { kind: 'menu' };
				rebuild();
				tui.requestRender();
			};
			list.onCancel = () => {
				currentView = { kind: 'menu' };
				rebuild();
				tui.requestRender();
			};
			activeSelectLists = [list];
			activeSelectListIndex = 0;
			container.addChild(list);
		}

		// ── 重置确认视图 ──

		function renderConfirmReset(experimentName: string) {
			const exp = manager.getExperimentRaw(experimentName);
			if (!exp) {
				container.addChild(new Text(dim('  Experiment not found'), 0, 0));
				return;
			}

			container.addChild(new Spacer(1));
			container.addChild(
				new Text(`  ${theme.fg('error', bold('重置: ' + experimentName))}`, 0, 0),
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
							currentView = { kind: 'menu' };
							rebuild();
							tui.requestRender();
						})
						.catch((err: unknown) => {
							// 写盘失败：显示错误而非跳回菜单，避免静默假成功
							const msg = err instanceof Error ? err.message : String(err);
							container.clear();
							renderTabBar();
							container.addChild(new Spacer(1));
							container.addChild(
								new Text(`  ${theme.fg('error', '重置失败: ' + msg)}`, 0, 0),
							);
							renderHelpBar();
							tui.requestRender();
						});
				} else {
					currentView = { kind: 'menu' };
					rebuild();
					tui.requestRender();
				}
			};
			list.onCancel = () => {
				currentView = { kind: 'menu' };
				rebuild();
				tui.requestRender();
			};
			activeSelectLists = [list];
			activeSelectListIndex = 0;
			container.addChild(list);
		}

		// ── 底部帮助栏 ──

		function renderHelpBar() {
			// 中间分隔线：左右各缩进 1 字符，与 └┘ 框的横线对齐
			container.addChild(
				new Text(accent(' ' + '\u2500'.repeat(Math.max(0, currentWidth - 2)) + ' '), 0, 0),
			);
			container.addChild(
				new Text(
					dim(
						currentView.kind === 'menu'
							? '  Tab/\u21E7Tab 切标签 \u00B7 \u2191\u2193 导航 \u00B7 \u23CE 确认 \u00B7 esc 关闭'
							: '  esc 返回',
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
			renderTabBar();

			switch (currentView.kind) {
				case 'menu':
					renderMenu();
					break;
				case 'experiment-detail':
					renderDetail(currentView.experimentName);
					break;
				case 'settings':
					renderSettings(currentView.experimentName);
					break;
				case 'confirm-reset':
					renderConfirmReset(currentView.experimentName);
					break;
			}

			renderHelpBar();
		}

		// ── 输入处理 ──

		function handleInput(data: string) {
			// 用 parseKey 解析按键：兼容 Kitty 键盘协议（按键以 CSI-u 多字节序列到达，
			// 直接比 raw 字节 '\t'/'\\x1b' 会全部失效，表现为「按键无响应」）。
			const key = parseKey(data) ?? data;

			// Tab → 切换 Current Session / Global 标签
			if (key === 'tab') {
				currentTab = currentTab === 'session' ? 'global' : 'session';
				if (currentView.kind === 'menu' || currentView.kind === 'experiment-list') {
					currentView = { kind: 'menu' };
				} else if ('tab' in currentView && currentView.tab !== currentTab) {
					currentView = { ...currentView, tab: currentTab };
				}
				rebuild();
				tui.requestRender();
				return;
			}

			// Shift+Tab → 反向切换
			if (key === 'shift+tab') {
				currentTab = currentTab === 'session' ? 'global' : 'session';
				if (currentView.kind === 'menu' || currentView.kind === 'experiment-list') {
					currentView = { kind: 'menu' };
				}
				rebuild();
				tui.requestRender();
				return;
			}

			// Esc → 上一级：menu 视图关闭，其他视图（detail/settings/confirm-reset）回到 menu
			if (key === 'escape') {
				if (currentView.kind === 'menu') {
					safeDone();
				} else {
					currentView = { kind: 'menu' };
					rebuild();
					tui.requestRender();
				}
				return;
			}

			// 有 SelectList 的视图（menu/settings/confirm-reset）：委派键盘输入
			if (
				currentView.kind === 'menu' ||
				currentView.kind === 'settings' ||
				currentView.kind === 'confirm-reset'
			) {
				if (activeSelectLists.length > 0) {
					activeSelectLists[activeSelectListIndex % activeSelectLists.length].handleInput(
						data,
					);
					tui.requestRender();
				}
				return;
			}

			// detail 视图：→ 切换指标（返回上一级用 esc）
			if (key === 'right') {
				metricIndex++;
				rebuild();
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
