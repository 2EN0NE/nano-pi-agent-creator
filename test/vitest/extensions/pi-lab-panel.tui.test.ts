/**
 * pi-lab panel — Headless TUI snapshot tests
 *
 * Verifies (per 项目「TUI 测试强制要求」):
 *   - detail 视图渲染结论（胜出概率 / credible interval / guardrail 告警）不崩溃、不超宽
 *   - 胜出臂阈值高亮（winProbability ≥ 0.95）
 *   - → 键 metric 切换
 *   - 无数据时显示 No data collected yet
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { showPanel } from '../../../extensions/meta/pi-lab/ui/panel.js';
import { ExperimentManager } from '../../../extensions/meta/pi-lab/core/experiment-manager.js';
import { stripAnsi, assertWithinWidth } from '../../../src/tui-testing/index.js';

// ── HOME 隔离（Experiment 写 JSONL 到 extensions-data/pi-lab）──

const ORIGINAL_HOME = process.env.HOME;
let tmpHome: string;

function setupTempHome(): void {
	tmpHome = resolve(tmpdir(), `pi-lab-panel-test-${randomUUID()}`);
	mkdirSync(resolve(tmpHome, '.pi', 'agent', 'extensions-data', 'pi-lab'), {
		recursive: true,
	});
	process.env.HOME = tmpHome;
}

function cleanupTempHome(): void {
	process.env.HOME = ORIGINAL_HOME;
	try {
		rmSync(tmpHome, { recursive: true, force: true });
	} catch {
		// ignore
	}
}

// ── Mock theme / keybindings ──

function mockTheme(accentColor = ''): any {
	return {
		fg: (_color: string, text: string) => text,
		bg: (_c: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		underline: (text: string) => text,
		inverse: (text: string) => text,
		strikethrough: (text: string) => text,
		getFgAnsi: () => accentColor,
		getBgAnsi: () => '',
		getColorMode: () => 'truecolor' as const,
	};
}

// ── 挂载面板：mock ctx.ui.custom 捕获组件 ──

function mountPanel(
	manager: ExperimentManager,
	theme?: any,
): {
	render: (width: number) => string[];
	handleInput: (data: string) => void;
} {
	let component: any = null;
	const tui = { requestRender: () => {} } as any;
	const ctx = {
		mode: 'tui',
		ui: {
			custom: (cb: any) => {
				component = cb(
					tui,
					theme ?? mockTheme(),
					{ matches: () => false, getDefinition: () => undefined },
					() => {},
				);
				return Promise.resolve(undefined);
			},
			notify: () => {},
		},
	} as any;
	void showPanel(ctx, manager);
	return component;
}

// ── 测试辅助 ──

function renderText(component: { render: (w: number) => string[] }, width = 80): string {
	return component.render(width).map(stripAnsi).join('\n');
}

/** 进入二级 stats 视图：⏎ 选中一级列表的实验（二级默认操作=统计） */
function enterDetail(component: {
	render: (w: number) => string[];
	handleInput: (d: string) => void;
}) {
	component.render(80); // 首次 render 触发 rebuild → 填充一级列表
	component.handleInput('\r'); // ⏎ 选中第一个实验 → 进入二级
}

// ── Tests ──

describe('pi-lab panel — headless snapshot', () => {
	let manager: ExperimentManager;

	beforeEach(() => {
		setupTempHome();
		manager = new ExperimentManager();
	});

	afterEach(() => {
		cleanupTempHome();
	});

	it('menu 视图渲染实验名，进入 detail 后展示预估成功率与真实范围且不超宽', async () => {
		const exp = manager.registerExperiment({
			owner: 'test',
			name: 'panel-test',
			contextKey: () => 'global',
			arms: [
				{ id: 'a', label: 'A' },
				{ id: 'b', label: 'B' },
			],
			metrics: [{ id: 'success', type: 'binary', direction: 'maximize' }],
		});
		for (let i = 0; i < 10; i++) await exp!.record('a', { metrics: { success: 1 } });
		for (let i = 0; i < 10; i++) await exp!.record('b', { metrics: { success: 0 } });

		const panel = mountPanel(manager);

		// 初始 menu 视图：实验名带 owner 前缀（插件名:实验名）
		const menuText = renderText(panel);
		expect(menuText).toContain('test:panel-test');
		expect(menuText).toContain('A vs B');

		// 进入 detail
		enterDetail(panel);
		const detailLines = panel.render(80);
		assertWithinWidth(detailLines, 80);

		const detailText = detailLines.map(stripAnsi).join('\n');
		expect(detailText).toContain('指标: success');
		expect(detailText).toContain('预估成功率');
		expect(detailText).toContain('真实约');
	});

	it('切换到 guardrail metric 显示告警', async () => {
		const exp = manager.registerExperiment({
			owner: 'test',
			name: 'guardrail-test',
			contextKey: () => 'global',
			arms: [
				{ id: 'a', label: 'A' },
				{ id: 'b', label: 'B' },
			],
			metrics: [
				{ id: 'success', type: 'binary', direction: 'maximize' },
				{ id: 'error_rate', type: 'binary', direction: 'minimize', isGuardrail: true },
			],
		});
		for (let i = 0; i < 10; i++) {
			await exp!.record('a', { metrics: { success: 1, error_rate: 0 } });
		}
		for (let i = 0; i < 10; i++) {
			await exp!.record('b', { metrics: { success: 0, error_rate: 1 } });
		}

		const panel = mountPanel(manager);
		enterDetail(panel);
		panel.handleInput('\x1b[C'); // → 切到 error_rate
		const text = renderText(panel);
		expect(text).toContain('指标: error_rate');
		expect(text).toContain('护栏');
	});

	it('胜出臂结论高亮（winProbability ≥ 0.95 解读结论用 accent 色）', async () => {
		const exp = manager.registerExperiment({
			owner: 'test',
			name: 'highlight-test',
			contextKey: () => 'global',
			arms: [
				{ id: 'a', label: 'A' },
				{ id: 'b', label: 'B' },
			],
			metrics: [{ id: 'success', type: 'binary', direction: 'maximize' }],
		});
		for (let i = 0; i < 10; i++) await exp!.record('a', { metrics: { success: 1 } });
		for (let i = 0; i < 10; i++) await exp!.record('b', { metrics: { success: 0 } });

		// accent 色用 ANSI 区分：fg('accent', ...) 返回带 ANSI 的文本
		const accentTheme = mockTheme();
		accentTheme.fg = (color: string, text: string) =>
			color === 'accent' ? `\x1b[33m${text}\x1b[0m` : text;
		const panel = mountPanel(manager, accentTheme);
		enterDetail(panel);

		const lines = panel.render(80);
		const raw = lines.join('\n');
		// 解读区块的「明显更优」结论行带 accent ANSI
		expect(raw).toContain('\x1b[33m');
		expect(raw).toContain('明显更优');
	});

	it('→ 键切换 metric', async () => {
		manager.registerExperiment({
			owner: 'test',
			name: 'metric-switch',
			contextKey: () => 'global',
			arms: [{ id: 'a', label: 'A' }],
			metrics: [
				{ id: 'success', type: 'binary', direction: 'maximize' },
				{ id: 'latency_ms', type: 'continuous', direction: 'minimize' },
			],
		});

		const panel = mountPanel(manager);
		enterDetail(panel);
		expect(renderText(panel)).toContain('指标: success');

		panel.handleInput('\x1b[C'); // → 键
		expect(renderText(panel)).toContain('指标: latency_ms');
	});

	it('← 键反向循环切换 metric（首指标 ← 到末指标）', () => {
		manager.registerExperiment({
			owner: 'test',
			name: 'metric-switch-back',
			contextKey: () => 'global',
			arms: [{ id: 'a', label: 'A' }],
			metrics: [
				{ id: 'success', type: 'binary', direction: 'maximize' },
				{ id: 'latency_ms', type: 'continuous', direction: 'minimize' },
				{ id: 'cost', type: 'continuous', direction: 'minimize' },
			],
		});

		const panel = mountPanel(manager);
		enterDetail(panel);
		expect(renderText(panel)).toContain('指标: success');

		panel.handleInput('\x1b[D'); // ← 键：反向循环到最后一个指标
		expect(renderText(panel)).toContain('指标: cost');

		panel.handleInput('\x1b[D'); // 再 ←：到倒数第二个
		expect(renderText(panel)).toContain('指标: latency_ms');

		panel.handleInput('\x1b[D'); // 再 ←：回到第一个（循环）
		expect(renderText(panel)).toContain('指标: success');
	});

	it('无数据时显示 No data collected yet', async () => {
		manager.registerExperiment({
			owner: 'test',
			name: 'empty-test',
			contextKey: () => 'global',
			arms: [{ id: 'a', label: 'A' }],
			metrics: [{ id: 'success', type: 'binary', direction: 'maximize' }],
		});

		const panel = mountPanel(manager);
		enterDetail(panel); // session tab 默认
		expect(renderText(panel)).toContain('尚未采集到数据');
	});

	it('面板有纯横线上下边框且不超宽', async () => {
		manager.registerExperiment({
			owner: 'test',
			name: 'border-test',
			contextKey: () => 'global',
			arms: [{ id: 'a', label: 'A' }],
			metrics: [{ id: 'success', type: 'binary', direction: 'maximize' }],
		});

		const panel = mountPanel(manager);
		const lines = panel.render(80).map(stripAnsi);
		assertWithinWidth(lines, 80);

		expect(lines[0].startsWith('──')).toBe(true);
		expect(lines[0]).not.toContain('┌');
		expect(lines[0]).not.toContain('┐');
		// 尾部可能是 MIN_TOTAL_LINES 高度填充的空行，取最后一个非空行验证底边框
		const lastContent = [...lines].reverse().find((l) => l.trim().length > 0) ?? '';
		expect(lastContent).not.toContain('└');
		expect(lastContent).not.toContain('┘');
		// 底边框为纯横线
		expect(lastContent.trim().replace(/─/g, '')).toBe('');
	});

	it('视图切换时渲染高度不小于最小高度（防抖动）', async () => {
		manager.registerExperiment({
			owner: 'test',
			name: 'min-height-test',
			contextKey: () => 'global',
			arms: [{ id: 'a', label: 'A' }],
			metrics: [{ id: 'success', type: 'binary', direction: 'maximize' }],
		});

		const panel = mountPanel(manager);
		// menu 视图
		const menuLines = panel.render(80).map(stripAnsi);
		expect(menuLines.length).toBeGreaterThanOrEqual(12);

		// detail 视图（数据更少，仍应填充到最小高度）
		enterDetail(panel);
		const detailLines = panel.render(80).map(stripAnsi);
		expect(detailLines.length).toBeGreaterThanOrEqual(12);
	});

	// ── 设置/重置交互（键盘驱动）──

	/** 进入二级操作页第 operationIndex 个操作：⏎ 进入实验（默认统计），Tab operationIndex 次切操作 */
	function enterMenuItem(
		component: { render: (w: number) => string[]; handleInput: (d: string) => void },
		operationIndex: number,
	) {
		component.render(80);
		component.handleInput('\r'); // ⏎ 进入二级（默认 统计）
		for (let i = 0; i < operationIndex; i++) component.handleInput('\t'); // Tab 切操作
	}

	it('设置视图选择实验臂后 forceArm 生效', () => {
		manager.registerExperiment({
			owner: 'test',
			name: 'settings-force-arm',
			contextKey: () => 'global',
			arms: [
				{ id: 'a', label: 'A' },
				{ id: 'b', label: 'B' },
			],
			metrics: [{ id: 'success', type: 'binary', direction: 'maximize' }],
		});

		const panel = mountPanel(manager);
		enterMenuItem(panel, 1); // 进入「设置」

		// 设置视图 SelectList 首项为 (自动)，↓ 一次到 arm 'a'，⏎ 确认
		panel.handleInput('\x1b[B');
		panel.handleInput('\r');

		const info = manager.getExperimentRaw('settings-force-arm')!.getInfo();
		expect(info.forceArmId).toBe('a');
		// 回菜单后显示强制臂标记
		expect(renderText(panel)).toContain('[强制:a]');
	});

	it('设置视图选择 (自动) 清除 forceArm', () => {
		const exp = manager.registerExperiment({
			owner: 'test',
			name: 'settings-force-auto',
			contextKey: () => 'global',
			arms: [{ id: 'a', label: 'A' }],
			metrics: [{ id: 'success', type: 'binary', direction: 'maximize' }],
		});
		exp!.forceArm('a');

		const panel = mountPanel(manager);
		enterMenuItem(panel, 1); // 设置
		panel.handleInput('\r'); // 首项 (自动) 直接确认

		expect(manager.getExperimentRaw('settings-force-auto')!.getInfo().forceArmId).toBeNull();
	});

	it('重置确认后清空全部数据', async () => {
		const exp = manager.registerExperiment({
			owner: 'test',
			name: 'reset-confirm',
			contextKey: () => 'global',
			arms: [{ id: 'a', label: 'A' }],
			metrics: [{ id: 'success', type: 'binary', direction: 'maximize' }],
		});
		await exp!.record('a', { metrics: { success: 1 } });
		expect((await exp!.stats()).a.totalCalls).toBe(1);

		const panel = mountPanel(manager);
		enterMenuItem(panel, 2); // 重置

		// 确认视图 SelectList 首项为「取消」，↓ 到「确认清空全部数据」，⏎
		panel.handleInput('\x1b[B');
		panel.handleInput('\r');

		// reset 是异步写盘，等待完成
		await vi.waitFor(() => {
			expect(manager.getExperimentRaw('reset-confirm')!.getEvents()).toHaveLength(0);
		});
	});

	it('重置取消不改变数据', async () => {
		const exp = manager.registerExperiment({
			owner: 'test',
			name: 'reset-cancel',
			contextKey: () => 'global',
			arms: [{ id: 'a', label: 'A' }],
			metrics: [{ id: 'success', type: 'binary', direction: 'maximize' }],
		});
		await exp!.record('a', { metrics: { success: 1 } });

		const panel = mountPanel(manager);
		enterMenuItem(panel, 2); // 重置
		panel.handleInput('\r'); // 首项「取消」直接确认

		// 回到菜单，数据保留
		expect(renderText(panel)).toContain('reset-cancel');
		expect(manager.getExperimentRaw('reset-cancel')!.getEvents()).toHaveLength(1);
	});

	it('重置写盘失败时显示错误而非静默成功', async () => {
		const exp = manager.registerExperiment({
			owner: 'test',
			name: 'reset-fail',
			contextKey: () => 'global',
			arms: [{ id: 'a', label: 'A' }],
			metrics: [{ id: 'success', type: 'binary', direction: 'maximize' }],
		});
		await exp!.record('a', { metrics: { success: 1 } });

		// 让 reset 写盘失败
		const raw = manager.getExperimentRaw('reset-fail')!;
		vi.spyOn(raw, 'reset').mockRejectedValue(new Error('disk full'));

		const panel = mountPanel(manager);
		enterMenuItem(panel, 2); // 重置
		panel.handleInput('\x1b[B'); // ↓ 到「确认清空全部数据」
		panel.handleInput('\r');

		await vi.waitFor(() => {
			expect(renderText(panel)).toContain('重置失败: disk full');
		});
	});

	// ── master-detail 两级导航（新增） ──

	it('一级列表 ↑↓ 焦点可流转：选中不同实验进入二级，标题为插件名:实验名', () => {
		for (const n of ['exp-a', 'exp-b', 'exp-c']) {
			manager.registerExperiment({
				owner: 'test',
				name: n,
				contextKey: () => 'global',
				arms: [{ id: 'a', label: 'A' }],
				metrics: [{ id: 'success', type: 'binary', direction: 'maximize' }],
			});
		}

		const panel = mountPanel(manager);
		panel.render(80);
		// 焦点从第一个流转到第三个（旧版 N 个 SelectList 焦点卡死的 bug 回归测试）
		panel.handleInput('\x1b[B');
		panel.handleInput('\x1b[B');
		panel.handleInput('\r'); // ⏎ 进入第三个实验

		const text = renderText(panel);
		expect(text).toContain('pi-lab · test:exp-c');
		expect(text).toContain('[统计]');
		expect(text).toContain('[设置]');
		expect(text).toContain('[重置]');
	});

	it('一级列表超过 MAX_VISIBLE 实验时滚动视口不撑高，且选中行动态跟随（居中滚动）', () => {
		for (let i = 0; i < 12; i++) {
			manager.registerExperiment({
				owner: 'test',
				name: `exp-${i}`,
				contextKey: () => 'global',
				arms: [{ id: 'a', label: 'A' }],
				metrics: [{ id: 'success', type: 'binary', direction: 'maximize' }],
			});
		}

		const panel = mountPanel(manager);
		const lines = panel.render(80).map(stripAnsi);
		assertWithinWidth(lines, 80);

		// 12 个实验只显示 MAX_VISIBLE(8) 行（SelectList 内部滚动），面板不随实验数撑高
		const visibleRows = lines.filter((l) => l.includes('test:exp-')).length;
		expect(visibleRows).toBeLessThanOrEqual(8);
		// 初始视口显示前 8 个 + 滚动指示
		expect(lines.join('\n')).toContain('test:exp-0');
		expect(lines.join('\n')).toContain('(1/12)');

		// 动态滚动：↓ 9 次选中第 10 个实验（exp-9），视口跟随（居中滚动）且不撑高
		for (let i = 0; i < 9; i++) panel.handleInput('\x1b[B');
		const scrolled = panel.render(80).map(stripAnsi);
		assertWithinWidth(scrolled, 80);
		expect(scrolled.join('\n')).toContain('test:exp-9');
		expect(scrolled.join('\n')).toContain('(10/12)');
		expect(scrolled.filter((l) => l.includes('test:exp-')).length).toBeLessThanOrEqual(8);

		// 滚动后选中的实验可正常进入二级（标题正确）
		panel.handleInput('\r');
		expect(renderText(panel)).toContain('pi-lab · test:exp-9');
	});

	it('二级操作条 Tab 循环切换：统计→设置→重置→统计', () => {
		manager.registerExperiment({
			owner: 'test',
			name: 'op-switch',
			contextKey: () => 'global',
			arms: [{ id: 'a', label: 'A' }],
			metrics: [{ id: 'success', type: 'binary', direction: 'maximize' }],
		});

		const panel = mountPanel(manager);
		enterDetail(panel); // 二级默认 统计
		expect(renderText(panel)).toContain('[统计]');

		panel.handleInput('\t'); // → 设置
		expect(renderText(panel)).toContain('强制臂:');

		panel.handleInput('\t'); // → 重置
		expect(renderText(panel)).toContain('确认清空全部数据');

		panel.handleInput('\t'); // → 统计（循环）
		expect(renderText(panel)).toContain('指标: success');

		// Shift+Tab 反向
		panel.handleInput('\x1b[Z');
		expect(renderText(panel)).toContain('确认清空全部数据');
	});

	it('二级统计页内容超长时滚动视口不撑高，↑↓ 滚动内容', async () => {
		// 多模型 × 多 arm：按模型分组时内容行数远超 MAX_CONTENT_LINES
		const exp = manager.registerExperiment({
			owner: 'test',
			name: 'scroll-detail',
			contextKey: (c: any) => c?.model?.id ?? 'global',
			arms: [
				{ id: 'a', label: 'A' },
				{ id: 'b', label: 'B' },
			],
			metrics: [
				{ id: 'success', type: 'binary', direction: 'maximize' },
				{ id: 'latency_ms', type: 'continuous', direction: 'minimize' },
			],
		})!;
		for (let m = 0; m < 5; m++) {
			for (const arm of ['a', 'b'] as const) {
				await exp.record(
					arm,
					{ metrics: { success: 1, latency_ms: 10 } },
					{ model: { id: `model-${m}` } },
				);
			}
		}

		const panel = mountPanel(manager);
		enterDetail(panel); // 二级 stats（默认「按模型」分组 → 5 个模型块）

		// 内容超长：出现滚动指示，且总行数有上限（不撑爆终端）
		const lines = panel.render(80).map(stripAnsi);
		assertWithinWidth(lines, 80);
		const text = lines.join('\n');
		expect(text).toContain('↑↓ 滚动');
		// 固定部分（边框/标题/操作条/分隔线/帮助）≈ 7 行 + 内容视口 10 + 滚动指示 1
		expect(lines.length).toBeLessThanOrEqual(20);

		// ↓ 滚动后内容变化（视口向下移动）
		panel.handleInput('\x1b[B');
		const scrolledText = renderText(panel);
		expect(scrolledText).not.toBe(text);
		// 滚动指示位置更新（不再从第 1 行开始）
		expect(scrolledText).toMatch(/\(\d+-\d+\/\d+\)/);

		// ←→ 切指标：切到 latency_ms，且 contentScroll 重置回顶部
		panel.handleInput('\x1b[C');
		const afterMetricSwitch = renderText(panel);
		expect(afterMetricSwitch).toContain('指标: latency_ms');
		expect(afterMetricSwitch).toMatch(/\(1-\d+\/\d+\)/);
	});
});
