/**
 * two-tab-panel 设置 tab — headless 测试（ADR-0030）
 *
 * 验证：设置 tab 渲染、Tab 循环 6 个、开关切换、沉淀级别二级页、阈值调整。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
	TwoTabPanel,
	type PanelTheme,
} from '../../../extensions/security/permission-gate/two-tab-panel';
import { getDefaultConfig } from '../../../extensions/security/permission-gate/config';
import { resetRulesStore } from '../../../extensions/security/permission-gate/approval-store';
import { resetManualStrategiesStore } from '../../../extensions/security/permission-gate/manual-strategies';
import { stripAnsi } from '../../../src/tui-testing/index.js';

let tmpDir: string;
let tmpHome: string;
let tmpCwd: string;
const origHome = process.env.HOME;

// matchesKey 期望原始按键序列（非语义字符串）
const ENTER = '\r';
const DOWN = '\x1b[B';
const RIGHT = '\x1b[C';
const LEFT = '\x1b[D';
const TAB = '\t';

function mockTheme(): PanelTheme {
	return { fg: (_c: string, t: string) => t, bold: (s: string) => s };
}

beforeEach(() => {
	tmpDir = join(tmpdir(), `two-tab-settings-${randomBytes(4).toString('hex')}`);
	tmpHome = join(tmpDir, 'home');
	tmpCwd = join(tmpDir, 'cwd');
	mkdirSync(tmpHome, { recursive: true });
	mkdirSync(tmpCwd, { recursive: true });
	process.env.HOME = tmpHome;
	resetRulesStore({ homeDir: tmpHome, cwd: tmpCwd });
	resetManualStrategiesStore({ homeDir: tmpHome, cwd: tmpCwd });
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
	process.env.HOME = origHome;
});

function setup() {
	const config = getDefaultConfig();
	let changed = 0;
	const panel = new TwoTabPanel({
		tui: { requestRender: () => {} },
		theme: mockTheme(),
		onClose: () => {},
		ctx: {
			cwd: tmpCwd,
			ui: { input: async () => undefined },
		} as never,
		config,
		onConfigChanged: () => {
			changed++;
		},
	});
	return { panel, config, getChanged: () => changed };
}

/** 切到指定 tab（Tab 循环） */
function gotoLayer(panel: TwoTabPanel, target: string): void {
	const order = ['session', 'project', 'user', 'history', 'analytics', 'settings'];
	const idx = order.indexOf(target);
	for (let i = 0; i < idx; i++) panel.handleInput(TAB);
}

describe('设置 tab 渲染', () => {
	it('Tab 循环 6 个一级 tab，含设置', () => {
		const { panel } = setup();
		gotoLayer(panel, 'settings');
		const out = panel.render(80).map(stripAnsi).join('\n');
		expect(out).toContain('[设置]');
		expect(out).toContain('权限门');
		expect(out).toContain('动态策略');
		expect(out).toContain('组件');
	});

	it('设置 tab 渲染开关行 + 配置列表', () => {
		const { panel } = setup();
		gotoLayer(panel, 'settings');
		const out = panel.render(80).map(stripAnsi).join('\n');
		expect(out).toContain('[X] 权限门');
		expect(out).toContain('[X] 动态策略');
		expect(out).toContain('[X] 组件');
		expect(out).toContain('默认沉淀级别');
		expect(out).toContain('拦截模式');
		expect(out).toContain('阈值');
		expect(out).toContain('组件详情');
	});
});

describe('设置 tab 交互', () => {
	it('enter 切换权限门开关并触发 onConfigChanged', () => {
		const { panel, config, getChanged } = setup();
		gotoLayer(panel, 'settings');
		expect(config.enabled).toBe(true);
		panel.handleInput(ENTER); // cursor 0 = 权限门
		expect(config.enabled).toBe(false);
		expect(getChanged()).toBe(1);
	});

	it('↓ 到动态策略，enter 切换', () => {
		const { panel, config } = setup();
		gotoLayer(panel, 'settings');
		panel.handleInput(DOWN); // cursor 1 = 动态策略
		panel.handleInput(ENTER);
		expect(config.dynamicPolicyEnabled).toBe(false);
	});

	it('沉淀级别二级页：enter 进入 → ↓ 选项目 → enter 确认', () => {
		const { panel, config } = setup();
		gotoLayer(panel, 'settings');
		// cursor 3 = 默认沉淀级别
		panel.handleInput(DOWN);
		panel.handleInput(DOWN);
		panel.handleInput(DOWN);
		panel.handleInput(ENTER); // 进入二级页
		const detail = panel.render(80).map(stripAnsi).join('\n');
		expect(detail).toContain('本次对话结束失效');

		panel.handleInput(DOWN); // 选「项目」
		panel.handleInput(ENTER); // 确认
		expect(config.defaultPersistenceScope).toBe('project');
		// 返回一级
		const back = panel.render(80).map(stripAnsi).join('\n');
		expect(back).not.toContain('本次对话结束失效');
	});

	it('阈值二级页：←→ 调整数值', () => {
		const { panel, config } = setup();
		gotoLayer(panel, 'settings');
		// cursor 5 = 阈值
		for (let i = 0; i < 5; i++) panel.handleInput(DOWN);
		panel.handleInput(ENTER); // 进入二级页
		const before = config.dynamicPolicy.thresholds.sameCommand;
		panel.handleInput(RIGHT); // 同命令 +1
		expect(config.dynamicPolicy.thresholds.sameCommand).toBe(before + 1);
		panel.handleInput(LEFT); // 同命令 -1
		expect(config.dynamicPolicy.thresholds.sameCommand).toBe(before);
	});
});

describe('拦截模式二级页', () => {
	it('拦截模式列表渲染 + enter 进操作页 + esc 返回', () => {
		const { panel, config } = setup();
		gotoLayer(panel, 'settings');
		// cursor 4 = 拦截模式
		for (let i = 0; i < 4; i++) panel.handleInput(DOWN);
		panel.handleInput(ENTER); // 进入拦截模式列表
		const list = panel.render(80).map(stripAnsi).join('\n');
		expect(list).toContain('拦截模式');
		expect(list).toContain(config.patterns[0].pattern);

		panel.handleInput(ENTER); // 进操作页
		const ops = panel.render(80).map(stripAnsi).join('\n');
		expect(ops).toContain('编辑正则');
		expect(ops).toContain('编辑备注');
		expect(ops).toContain('修改级别');
		expect(ops).toContain('删除');

		panel.handleInput('\x1b'); // esc 返回列表
		const back = panel.render(80).map(stripAnsi).join('\n');
		expect(back).not.toContain('编辑正则');

		panel.handleInput('\x1b'); // esc 返回设置列表
		const settings = panel.render(80).map(stripAnsi).join('\n');
		expect(settings).toContain('权限门');
	});
});

describe('新增清单页（危险命令 / 权限命令 / 路径空间）', () => {
	it('设置一级列表含三个新配置项', () => {
		const { panel } = setup();
		gotoLayer(panel, 'settings');
		const out = panel.render(80).map(stripAnsi).join('\n');
		expect(out).toContain('危险命令清单');
		expect(out).toContain('权限命令清单');
		expect(out).toContain('路径空间');
	});

	it('危险命令清单二级页渲染内置命令 + 备注', () => {
		const { panel, config } = setup();
		gotoLayer(panel, 'settings');
		// cursor 8 = 危险命令清单（3 开关 + 8 配置）
		for (let i = 0; i < 8; i++) panel.handleInput(DOWN);
		panel.handleInput(ENTER);
		const out = panel.render(80).map(stripAnsi).join('\n');
		expect(out).toContain('危险命令清单');
		expect(out).toContain('dd');
		expect(out).toContain(config.dangerCommands[0].command);
		expect(out).toContain('覆写磁盘'); // 内置 note
	});

	it('权限命令清单二级页渲染 + 进操作页', () => {
		const { panel } = setup();
		gotoLayer(panel, 'settings');
		// cursor 9 = 权限命令清单
		for (let i = 0; i < 9; i++) panel.handleInput(DOWN);
		panel.handleInput(ENTER);
		const list = panel.render(80).map(stripAnsi).join('\n');
		expect(list).toContain('权限命令清单');
		expect(list).toContain('sudo');

		panel.handleInput(ENTER); // 进操作页
		const ops = panel.render(80).map(stripAnsi).join('\n');
		expect(ops).toContain('编辑命令名');
		expect(ops).toContain('编辑备注');
		expect(ops).toContain('删除');
	});

	it('路径空间二级页渲染 + ←→ 切换组', () => {
		const { panel } = setup();
		gotoLayer(panel, 'settings');
		// cursor 10 = 路径空间
		for (let i = 0; i < 10; i++) panel.handleInput(DOWN);
		panel.handleInput(ENTER);
		const system = panel.render(80).map(stripAnsi).join('\n');
		expect(system).toContain('[系统目录]');
		expect(system).toContain('/etc');

		panel.handleInput(RIGHT); // 切到敏感凭证
		const cred = panel.render(80).map(stripAnsi).join('\n');
		expect(cred).toContain('[敏感凭证]');
		expect(cred).toContain('~/.ssh');
	});
});
