/**
 * /experiment 命令的 TUI 面板
 *
 * 布局（无左右竖线边框）:
 *
 *   [Current Session]  Global
 *   ──────────────────────────────
 *   Edit Strategy
 *   ├─ Stats             42 calls
 *   ├─ Settings
 *   └─ Reset
 *   ──────────────────────────────
 *   Tab/⇧Tab · ↑↓ · ⏎ enter · esc close
 *
 * 键盘约定：
 *   Tab / Shift+Tab  — 切换 Current Session / Global 标签
 *   ↑↓               — 在菜单行之间导航（由 SelectList 管理）
 *   ⏎                — 选择当前项
 *   Esc              — 关闭面板
 */

import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { Container, type SelectItem, SelectList, Spacer, Text } from '@earendil-works/pi-tui';
import type { ExperimentManager } from '../core/experiment-manager.js';
import type { PanelTab, PanelView } from '../types.js';

export function showPanel(ctx: ExtensionCommandContext, manager: ExperimentManager): Promise<void> {
	return ctx.ui.custom<void>((tui, theme, _kb, done) => {
		let currentTab: PanelTab = 'session';
		let currentView: PanelView = { kind: 'menu' };
		let dismissed = false;
		let currentWidth = 80; // fallback width（首次 render 时被真实宽度覆盖）
		let needsFirstRebuild = true;

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
			const tabs = [
				{ key: 'session' as PanelTab, label: 'Current Session' },
				{ key: 'global' as PanelTab, label: 'Global' },
			];
			const parts = tabs.map((tab) => {
				const isActive = currentTab === tab.key;
				return isActive ? accent(bold(`  ${tab.label}  `)) : dim(`  ${tab.label}  `);
			});
			container.addChild(new Text(parts.join(''), 0, 0));
			container.addChild(new Text(accent('\u2500'.repeat(currentWidth)), 0, 0));
		}

		// ── 菜单视图 ──

		function renderMenu() {
			activeSelectLists = [];
			activeSelectListIndex = 0;

			const experiments = manager.getAllExperiments();

			if (experiments.length === 0) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(muted('  No experiments registered.'), 0, 0));
				container.addChild(
					new Text(dim('  Register experiments via lab.registerExperiment()'), 0, 0),
				);
				return;
			}

			for (const { name, info } of experiments) {
				const armLabels = info.arms.map((a: any) => a.label ?? a.id).join(' vs ');
				const statusBadge = info.forceArmId
					? accent(` [forced:${info.forceArmId}]`)
					: dim(` (${info.strategy})`);

				container.addChild(new Spacer(1));
				container.addChild(new Text(`  ${accent(bold(name))}${statusBadge}`, 0, 0));
				container.addChild(new Text(`    ${dim(armLabels)}`, 0, 0));

				// 操作菜单
				const menuItems: SelectItem[] = [
					{
						value: 'stats',
						label: 'Stats',
						description: 'View statistics per model/arm',
					},
					{
						value: 'settings',
						label: 'Settings',
						description: 'Configure force-arm, strategy',
					},
					{
						value: 'reset',
						label: 'Reset',
						description: 'Clear experiment data',
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

		function renderDetail(experimentName: string) {
			const exp = manager.getExperimentRaw(experimentName);
			if (!exp) {
				container.addChild(new Text(dim('  Experiment not found'), 0, 0));
				return;
			}

			const info = exp.getInfo();
			const contextKeys = exp.getContextKeys();

			container.addChild(new Spacer(1));
			container.addChild(
				new Text(`  ${accent(bold(experimentName))} ${dim(info.strategy)}`, 0, 0),
			);

			if (info.forceArmId) {
				container.addChild(new Text(`  ${accent(`>> forced: ${info.forceArmId}`)}`, 0, 0));
			}

			container.addChild(new Spacer(1));

			if (contextKeys.length === 0) {
				container.addChild(new Text(muted('  No data collected yet.'), 0, 0));
			} else {
				for (const ctxKey of contextKeys) {
					const states = exp.getArmStates(ctxKey);
					const totalCalls = Array.from(states.values()).reduce(
						(sum, s) => sum + s.totalCalls,
						0,
					);

					container.addChild(
						new Text(`  ${accent(ctxKey)} ${dim(`(${totalCalls} calls)`)}`, 0, 0),
					);

					for (const [armId, state] of states) {
						const rate =
							state.totalCalls > 0
								? ((state.alpha / (state.alpha + state.beta)) * 100).toFixed(1)
								: '-';
						const firstPct =
							state.totalCalls > 0
								? ((state.firstAttempts / state.totalCalls) * 100).toFixed(1)
								: '-';
						const avgLatency =
							state.totalCalls > 0
								? (state.totalLatencyMs / state.totalCalls).toFixed(0)
								: '-';

						container.addChild(
							new Text(
								`    ${armId}: ${state.alpha + state.beta - 2} calls, ${rate}% sr, ${firstPct}% 1st, ${avgLatency}ms avg`,
								0,
								0,
							),
						);
					}
				}
			}

			container.addChild(new Spacer(1));
			container.addChild(new Text(dim('  [\u2190] Back to menu'), 0, 0));
		}

		// ── 设置视图 ──

		function renderSettings(experimentName: string) {
			const exp = manager.getExperimentRaw(experimentName);
			if (!exp) {
				container.addChild(new Text(dim('  Experiment not found'), 0, 0));
				return;
			}

			container.addChild(new Spacer(1));

			// Show current force-arm status
			const info = exp.getInfo();
			const currentLabel = info.forceArmId === null ? '(auto)' : info.forceArmId;

			container.addChild(new Text(`  ${dim('Force arm:')} ${accent(currentLabel)}`, 0, 0));

			container.addChild(new Spacer(1));
			container.addChild(new Text(dim('  Use the API to change settings:'), 0, 0));
			container.addChild(
				new Text(
					dim("  lab.experiment('") +
						accent(experimentName) +
						dim("').forceArm('classic')"),
					0,
					0,
				),
			);

			container.addChild(new Spacer(1));
			container.addChild(new Text(dim('  [\u2190] Back to menu'), 0, 0));
		}

		// ── 重置确认视图 ──

		function renderConfirmReset(experimentName: string) {
			container.addChild(new Spacer(1));
			container.addChild(
				new Text(`  ${theme.fg('error', bold('Reset: ' + experimentName))}`, 0, 0),
			);
			container.addChild(new Spacer(1));
			container.addChild(new Text(muted('  This is a high-risk operation.'), 0, 0));
			container.addChild(
				new Text(dim('  If you are sure you know what you are doing,'), 0, 0),
			);
			container.addChild(new Text(dim('  please manually delete the data file(s):'), 0, 0));
			container.addChild(new Spacer(1));
			container.addChild(
				new Text(
					`  ${dim('~/.pi/agent/extensions-data/pi-lab/')}${accent(experimentName + '.json')}`,
					0,
					0,
				),
			);
			container.addChild(new Spacer(1));
			container.addChild(new Text(dim('  [\u2190] Back to menu'), 0, 0));
		}

		// ── 底部帮助栏 ──

		function renderHelpBar() {
			container.addChild(new Text(accent('\u2500'.repeat(currentWidth)), 0, 0));
			container.addChild(
				new Text(
					dim(
						currentView.kind === 'menu'
							? '  Tab/\u21E7Tab \u00B7 \u2191\u2193 \u00B7 \u23CE enter \u00B7 esc close'
							: '  [\u2190] Back \u00B7 esc close',
					),
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
			// Tab → 切换 Current Session / Global 标签
			if (data === '\t') {
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
			if (data === '\u001b[Z') {
				currentTab = currentTab === 'session' ? 'global' : 'session';
				if (currentView.kind === 'menu' || currentView.kind === 'experiment-list') {
					currentView = { kind: 'menu' };
				}
				rebuild();
				tui.requestRender();
				return;
			}

			// Esc → 关闭
			if (data === '\x1b') {
				safeDone();
				return;
			}

			// 在菜单视图中：将键盘输入委派给当前活跃的 SelectList
			if (currentView.kind === 'menu') {
				if (activeSelectLists.length > 0) {
					activeSelectLists[activeSelectListIndex % activeSelectLists.length].handleInput(
						data,
					);
					tui.requestRender();
				}
				return;
			}

			// 非菜单视图：← 返回菜单
			if (data === '\x1b[D' || data === '\b') {
				currentView = { kind: 'menu' };
				rebuild();
				tui.requestRender();
			}
		}

		// 不要在 render(width) 前调用 rebuild()，否则初始分割线宽度是 80
		needsFirstRebuild = true;

		return {
			render(width: number) {
				currentWidth = width;
				if (needsFirstRebuild) {
					needsFirstRebuild = false;
					rebuild();
				}
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput,
		};
	});
}
