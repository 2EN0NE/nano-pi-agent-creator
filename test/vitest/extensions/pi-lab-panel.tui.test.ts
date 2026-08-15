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

/** 进入 detail 视图：先 render 触发 rebuild，再 ⏎ 选中第一项 Stats */
function enterDetail(component: {
	render: (w: number) => string[];
	handleInput: (d: string) => void;
}) {
	component.render(80); // 首次 render 触发 rebuild → 填充 activeSelectLists
	component.handleInput('\r'); // ⏎ 选中 Stats
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
		for (let i = 0; i < 10; i++) await exp.record('a', { metrics: { success: 1 } });
		for (let i = 0; i < 10; i++) await exp.record('b', { metrics: { success: 0 } });

		const panel = mountPanel(manager);

		// 初始 menu 视图
		const menuText = renderText(panel);
		expect(menuText).toContain('panel-test');
		expect(menuText).toContain('统计');

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
			await exp.record('a', { metrics: { success: 1, error_rate: 0 } });
		}
		for (let i = 0; i < 10; i++) {
			await exp.record('b', { metrics: { success: 0, error_rate: 1 } });
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
		for (let i = 0; i < 10; i++) await exp.record('a', { metrics: { success: 1 } });
		for (let i = 0; i < 10; i++) await exp.record('b', { metrics: { success: 0 } });

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

	it('面板有上下边框 ┌─┐└┘ 且不超宽', async () => {
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

		expect(lines[0].startsWith('┌')).toBe(true);
		expect(lines[0].endsWith('┐')).toBe(true);
		expect(lines[lines.length - 1].startsWith('└')).toBe(true);
		expect(lines[lines.length - 1].endsWith('┘')).toBe(true);
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

	/** 进入菜单第 index 项（0=统计 1=设置 2=重置）：render 触发 rebuild，↓ index 次，⏎ 确认 */
	function enterMenuItem(
		component: { render: (w: number) => string[]; handleInput: (d: string) => void },
		index: number,
	) {
		component.render(80);
		for (let i = 0; i < index; i++) component.handleInput('\x1b[B'); // ↓
		component.handleInput('\r'); // ⏎
	}

	it('设置视图选择实验臂后 forceArm 生效', () => {
		const exp = manager.registerExperiment({
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
		exp.forceArm('a');

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
		await exp.record('a', { metrics: { success: 1 } });
		expect((await exp.stats()).a.totalCalls).toBe(1);

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
		await exp.record('a', { metrics: { success: 1 } });

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
		await exp.record('a', { metrics: { success: 1 } });

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
});
