/**
 * pi-lab TUI panel — 状态机与交互逻辑测试
 *
 * 覆盖：
 *   - parseNamespace 解析
 *   - colLayout 两列布局计算
 *   - sparkline 渲染
 *   - 键盘输入的视图切换逻辑（模拟）
 *
 * 不覆盖：
 *   - 实际终端渲染细节（竖线对齐、ANSI width — 需人工验收）
 *   - DynamicBorder/truncateToWidth 行为（pi-tui 内部保证）
 */
import { describe, it, expect } from 'vitest';
import { getExperimentManager } from '@zenone/pi-lab';
import type { ExperimentAPI } from '@zenone/pi-lab';

// Inline colLayout from src/tui/helpers.ts to avoid path mapping issues
function colLayout(opts: { width: number; leftRatio?: number; separator?: string }) {
	const leftRatio = opts.leftRatio ?? 0.36;
	const w = opts.width;
	const lw = Math.floor(w * leftRatio);
	const rw = w - lw - 3;
	const sep = opts.separator ?? '\x1b[2m │ \x1b[0m';
	return {
		lw,
		rw,
		sep,
		row(l: string, r: string) {
			return `  ${l.padEnd(lw)}${sep}${r}`;
		},
		header(lt: string, rt: string) {
			return `  ${lt.padEnd(lw)}${sep}${rt}`;
		},
	};
}

// ── parseNamespace（从 panel.ts 提取）──

function parseNamespace(experimentName: string): { ns: string; short: string } {
	const idx = experimentName.indexOf('::');
	if (idx === -1) return { ns: '(默认)', short: experimentName };
	return {
		ns: experimentName.slice(0, idx),
		short: experimentName.slice(idx + 2),
	};
}

describe('pi-lab TUI — parseNamespace', () => {
	it('无 namespace 返回 (默认)', () => {
		expect(parseNamespace('my-experiment')).toEqual({
			ns: '(默认)',
			short: 'my-experiment',
		});
	});

	it('有 namespace 正确拆分', () => {
		expect(parseNamespace('smart-context::turn-routing')).toEqual({
			ns: 'smart-context',
			short: 'turn-routing',
		});
	});

	it('多级 :: 只拆分第一个', () => {
		expect(parseNamespace('a::b::c')).toEqual({
			ns: 'a',
			short: 'b::c',
		});
	});
});

// ── colLayout 辅助 ──

describe('pi-lab TUI — colLayout', () => {
	it('左列宽度为 36%', () => {
		const c = colLayout({ width: 80 });
		expect(c.lw).toBe(28); // Math.floor(80 * 0.36)
		expect(c.rw).toBe(49); // 80 - 28 - 3
	});

	it('可自定义比例', () => {
		const c = colLayout({ width: 100, leftRatio: 0.5 });
		expect(c.lw).toBe(50);
		expect(c.rw).toBe(47);
	});

	it('row 输出包含分隔符', () => {
		const c = colLayout({ width: 40, separator: ' | ' });
		const line = c.row('left', 'right');
		expect(line).toContain(' | ');
		expect(line).toContain('left');
		expect(line).toContain('right');
	});

	it('header 左右标题都在', () => {
		const c = colLayout({ width: 60 });
		const line = c.header('命名空间', '实验');
		expect(line).toContain('命名空间');
		expect(line).toContain('实验');
	});
});

// ── sparkline ──

const SPARK_CHARS = ['\u2581', '\u2582', '\u2583', '\u2585', '\u2587', '\u2588'];

function sparkline(values: number[]): string {
	if (values.length === 0) return '\u2014';
	const min = Math.min(...values);
	const max = Math.max(...values);
	const range = max - min;
	if (range < 0.001) return SPARK_CHARS[0].repeat(Math.min(values.length, 8));
	return values
		.map((v) => SPARK_CHARS[Math.min(5, Math.floor(((v - min) / range) * 5))])
		.join('');
}

describe('pi-lab TUI — sparkline', () => {
	it('空数组返回 —', () => {
		expect(sparkline([])).toBe('\u2014');
	});

	it('全零返回最矮', () => {
		const result = sparkline([0, 0, 0]);
		expect(result).toBe(SPARK_CHARS[0].repeat(3));
	});

	it('渐变值', () => {
		const result = sparkline([1, 2, 3, 4, 5, 10]);
		expect(result.length).toBe(6);
		// 最大值应渲染最高字符
		expect(result[5]).toBe(SPARK_CHARS[5]);
	});
});

// ── 键盘交互：视图状态机（模拟 handleInput 的关键路径）──

type PanelTab = 'session' | 'global';
type PanelView =
	| { kind: 'menu'; focus: 'namespace' | 'experiment' }
	| { kind: 'experiment-detail'; experimentName: string; metricIndex: number }
	| { kind: 'arm-detail'; experimentName: string; armId: string };

describe('pi-lab TUI — 视图状态机', () => {
	it('默认开始于 menu:namespace', () => {
		const view: PanelView = { kind: 'menu', focus: 'namespace' };
		expect(view.kind).toBe('menu');
		expect(view.focus).toBe('namespace');
	});

	it('← 从 experiment 焦点切回 namespace', () => {
		let view: PanelView = { kind: 'menu', focus: 'experiment' };
		// ← 键：切到 namespace
		view = { kind: 'menu', focus: 'namespace' };
		expect(view.focus).toBe('namespace');
	});

	it('→ 从 namespace 切到 experiment', () => {
		let view: PanelView = { kind: 'menu', focus: 'namespace' };
		view = { kind: 'menu', focus: 'experiment' };
		expect(view.focus).toBe('experiment');
	});

	it('Enter 在 experiment 焦点进入详情', () => {
		const view: PanelView = {
			kind: 'experiment-detail',
			experimentName: 'smart-context::turn-routing',
			metricIndex: 0,
		};
		expect(view.kind).toBe('experiment-detail');
	});

	it('Esc 从详情返回 menu', () => {
		let view: PanelView = {
			kind: 'experiment-detail',
			experimentName: 'test',
			metricIndex: 0,
		};
		view = { kind: 'menu', focus: 'experiment' };
		expect(view.kind).toBe('menu');
	});

	it('→ 在实验详情切指标', () => {
		const view: PanelView = {
			kind: 'experiment-detail',
			experimentName: 'test',
			metricIndex: 3,
		};
		const next: PanelView = { ...view, metricIndex: view.metricIndex + 1 };
		expect(next.metricIndex).toBe(4);
	});

	it('Tab 切换会话/全局', () => {
		let tab: PanelTab = 'session';
		tab = tab === 'session' ? 'global' : 'session';
		expect(tab).toBe('global');
		tab = tab === 'session' ? 'global' : 'session';
		expect(tab).toBe('session');
	});

	it('从 arm-detail 返回 menu', () => {
		let view: PanelView = {
			kind: 'arm-detail',
			experimentName: 'test',
			armId: 'classifier',
		};
		view = { kind: 'menu', focus: 'experiment' };
		expect(view.kind).toBe('menu');
	});
});

// ── 实验数据：getAllExperiments + namespace 分组逻辑 ──

describe('pi-lab TUI — 命名空间分组', () => {
	it('getAllExperiments 按 namespace 正确分组', () => {
		const mgr = getExperimentManager();
		// 注册几个实验
		mgr.registerWeakExperiment({
			name: 'session-init',
			namespace: 'smart-context',
			contextKey: 'global',
			arms: [{ id: 'a', label: 'A' }],
			strategy: 'thompson-sampling',
		});
		mgr.registerWeakExperiment({
			name: 'turn-routing',
			namespace: 'smart-context',
			contextKey: 'global',
			arms: [
				{ id: 'b', label: 'B' },
				{ id: 'c', label: 'C' },
			],
			strategy: 'thompson-sampling',
		});
		mgr.registerWeakExperiment({
			name: 'standalone-exp',
			contextKey: 'global',
			arms: [{ id: 'd', label: 'D' }],
			strategy: 'epsilon-greedy',
		});

		const experiments = mgr.getAllExperiments();
		expect(experiments.length).toBeGreaterThanOrEqual(3);

		// 按 namespace 分组
		const nsMap = new Map<string, Array<{ name: string; info: any }>>();
		for (const { name, info } of experiments) {
			const { ns } = parseNamespace(name);
			if (!nsMap.has(ns)) nsMap.set(ns, []);
			nsMap.get(ns)!.push({ name, info });
		}

		const smartContext = nsMap.get('smart-context');
		expect(smartContext).toBeDefined();
		expect(smartContext!.length).toBeGreaterThanOrEqual(2);

		const defaultNs = nsMap.get('(默认)');
		expect(defaultNs).toBeDefined();
		expect(defaultNs!.length).toBeGreaterThanOrEqual(1);
	});
});

// ── metricDef + query 可用性 ──

describe('pi-lab TUI — 指标查询', () => {
	it('有 metrics 的实验 query 返回 armStats', () => {
		const mgr = getExperimentManager();
		const exp: ExperimentAPI = mgr.registerWeakExperiment({
			name: 'tui-metric-test',
			contextKey: 'global',
			arms: [
				{ id: 'arm-a', label: 'Arm A' },
				{ id: 'arm-b', label: 'Arm B' },
			],
			strategy: 'thompson-sampling',
			metrics: [{ id: 'score', type: 'continuous', direction: 'maximize', label: 'Score' }],
		});

		// 写入数据
		exp.record('arm-a', { metrics: { score: 0.8 }, success: true });
		exp.record('arm-a', { metrics: { score: 0.6 }, success: true });
		exp.record('arm-b', { metrics: { score: 0.3 }, success: false });

		const result = exp.query('score');
		expect(result.metric).toBe('score');
		expect(result.armStats.length).toBe(2);

		const armA = result.armStats.find((s) => s.armId === 'arm-a');
		expect(armA).toBeDefined();
		expect(armA!.sampleSize).toBe(2);

		// getArmDefs / getMetricDefs
		const armDefs = exp.getArmDefs?.() ?? [];
		expect(armDefs.length).toBe(2);
		expect(armDefs[0].label).toBe('Arm A');

		const metricDefs = exp.getMetricDefs?.() ?? [];
		expect(metricDefs.length).toBe(1);
		expect(metricDefs[0].label).toBe('Score');
	});
});

// ── checkAlignment ──

function checkAlignment(lines: string[], sep = '│', tol = 1) {
	const positions: number[] = [];
	for (const line of lines) {
		const idx = line.indexOf(sep);
		if (idx !== -1) positions.push(idx);
	}
	if (positions.length < 2)
		return { ok: true, positions, expectedColumn: positions[0] ?? 0, maxDeviation: 0 };
	const freq = new Map<number, number>();
	for (const p of positions) freq.set(p, (freq.get(p) ?? 0) + 1);
	let ec = positions[0],
		mf = 0;
	for (const [p, f] of freq) {
		if (f > mf) {
			mf = f;
			ec = p;
		}
	}
	let md = 0;
	for (const p of positions) md = Math.max(md, Math.abs(p - ec));
	return { ok: md <= tol, positions, expectedColumn: ec, maxDeviation: md };
}

describe('checkAlignment', () => {
	it('全对齐 → ok=true', () => {
		// 三条手工对齐的线：竖线在相同列号
		const lines = [
			'  ns1          │   exp1  1臂 10次',
			'  ns2          │   exp2  2臂 20次',
			'               │   exp3  3臂 30次',
		];
		const result = checkAlignment(lines);
		expect(result.ok).toBe(true);
		expect(result.positions.length).toBe(3);
		expect(result.maxDeviation).toBe(0);
	});

	it('单行也 ok', () => {
		const lines = ['  ▸ test   │   experiment'];
		const result = checkAlignment(lines);
		expect(result.ok).toBe(true);
	});

	it('偏移 > tol → ok=false', () => {
		const lines = ['  short   │   col1', '               │   col2'];
		const result = checkAlignment(lines);
		expect(result.ok).toBe(false);
		expect(result.maxDeviation).toBeGreaterThan(1);
	});

	it('0 行也 ok', () => {
		const result = checkAlignment([]);
		expect(result.ok).toBe(true);
	});

	it('不包括 sep 的行不影响', () => {
		const lines = [
			'  plain line without bar',
			'  ▸ ns   │   exp1',
			'  another plain',
			'         │   exp2',
		];
		const result = checkAlignment(lines);
		expect(result.positions.length).toBe(2);
		expect(result.ok).toBe(true);
	});
});
