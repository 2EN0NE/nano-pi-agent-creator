/**
 * custom-rename ui — TUI 设置面板 headless snapshot + 键盘交互测试。
 *
 * 强制要求（AGENTS.md）：新建 TUI 组件必须用 renderToSnapshot + assertWithinWidth
 * 在 2+ 宽度下验证不超宽不崩溃；键盘交互验证状态切换。
 *
 * 输入注入：直接调 (panel as any).handleInput(data)（与 pi-session-tree keyboard
 * 测试同款模式，绕开 TuiMainScreen 的私有输入链）。
 *
 * Covers:
 *   - configPatchFor 纯函数（id/value → patch）
 *   - 主列表渲染：80/120 宽不超宽、4 项 label + 当前值
 *   - 键盘：enabled 循环触发 applyPatch；model/thinking 项 Enter 打开 submenu；
 *     submenu Esc 返回；长度输入非法值提示不保存
 */
import { describe, expect, it, vi } from 'vitest';
import {
	MockTerminal,
	TuiMainScreen,
	renderToSnapshot,
	stripAnsi,
	assertWithinWidth,
	makeMockTheme,
} from '../../../src/tui-testing/index.js';
import {
	RenameSettingsPanel,
	configPatchFor,
	type RenameSettingsDeps,
} from '../../../extensions/tui/custom-rename/src/ui.js';
import type { RenameSessionConfig } from '../../../extensions/tui/custom-rename/src/pure.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPanel = any;

// ── 夹具 ──

function makeConfig(overrides: Partial<RenameSessionConfig> = {}): RenameSessionConfig {
	return {
		enabled: true,
		model: { type: 'ref', ref: 'deepseek/deepseek-chat' },
		maxTitleLength: 50,
		thinkingLevel: 'off',
		...overrides,
	};
}

const MODEL_SPECS = ['deepseek/deepseek-chat', 'anthropic/claude-sonnet-4-5', 'stub/stub-model'];

interface Ctx {
	/** 直接向面板注入按键（≡ SettingsList.handleInput）。 */
	press: (data: string) => void;
	cfg: RenameSessionConfig;
	applyPatch: ReturnType<typeof vi.fn>;
	notify: ReturnType<typeof vi.fn>;
	onClose: ReturnType<typeof vi.fn>;
	snapshot: () => string[];
}

function mount(overrides: Partial<RenameSessionConfig> = {}): Ctx {
	const term = new MockTerminal(80, 24);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const tui = new TuiMainScreen(term) as any;
	const cfg = makeConfig(overrides);
	const applyPatch = vi.fn((patch: Partial<RenameSessionConfig>) => {
		Object.assign(cfg, patch);
		return true;
	});
	const notify = vi.fn();
	const onClose = vi.fn();
	const deps: RenameSettingsDeps = {
		getConfig: () => cfg,
		getModelSpecs: () => MODEL_SPECS,
		applyPatch,
		notify,
		onClose,
	};
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const panel: AnyPanel = new RenameSettingsPanel(tui as never, makeMockTheme(), deps) as any;
	tui.addChild(panel);
	tui.setFocus(panel);
	return {
		press: (data: string) => panel.handleInput(data),
		cfg,
		applyPatch,
		notify,
		onClose,
		snapshot: () => stripAnsi(renderToSnapshot(tui).join('\n')).split('\n'),
	};
}

// ── configPatchFor 纯函数 ──

describe('configPatchFor', () => {
	it('enabled 开/关 → enabled 布尔', () => {
		expect(configPatchFor('enabled', '开')).toEqual({ enabled: true });
		expect(configPatchFor('enabled', '关')).toEqual({ enabled: false });
	});

	it('model → ref patch', () => {
		expect(configPatchFor('model', 'anthropic/claude-sonnet-4-5')).toEqual({
			model: { type: 'ref', ref: 'anthropic/claude-sonnet-4-5' },
		});
	});

	it('thinkingLevel → 级别字符串', () => {
		expect(configPatchFor('thinkingLevel', 'high')).toEqual({ thinkingLevel: 'high' });
	});

	it('maxTitleLength 正整数 → 数字；非法 → null', () => {
		expect(configPatchFor('maxTitleLength', '80')).toEqual({ maxTitleLength: 80 });
		expect(configPatchFor('maxTitleLength', 'abc')).toBeNull();
		expect(configPatchFor('maxTitleLength', '0')).toBeNull();
		expect(configPatchFor('maxTitleLength', '-5')).toBeNull();
	});

	it('未知 id → null', () => {
		expect(configPatchFor('unknown', 'x')).toBeNull();
	});
});

// ── 主列表渲染 ──

describe('RenameSettingsPanel render', () => {
	it('80/120 宽不超宽、不崩溃', () => {
		for (const width of [80, 120]) {
			const { snapshot } = mount();
			assertWithinWidth(snapshot(), width);
		}
	});

	it('显示 4 个配置项 + 当前值', () => {
		const { snapshot } = mount();
		const text = snapshot().join('\n');
		expect(text).toContain('auto-rename 设置');
		expect(text).toContain('自动重命名');
		expect(text).toContain('开');
		expect(text).toContain('重命名模型');
		expect(text).toContain('deepseek/deepseek-chat');
		expect(text).toContain('标题最大长度');
		expect(text).toContain('50');
		expect(text).toContain('Thinking 级别');
		expect(text).toContain('off');
	});

	it('未配置模型显示 (未配置)', () => {
		const { snapshot } = mount({ model: { type: 'ref', ref: '' } });
		expect(snapshot().join('\n')).toContain('(未配置)');
	});
});

// ── 键盘交互 ──

describe('RenameSettingsPanel keyboard', () => {
	it('enabled 项 Enter 循环切换 → applyPatch({enabled})', () => {
		const { applyPatch, press } = mount(); // enabled: true → currentValue '开'
		press('\r'); // Enter on 自动重命名（第 0 项）
		expect(applyPatch).toHaveBeenCalledWith({ enabled: false });
	});

	it('未配置模型（ref 空）时开开关 → 提示 + UI 回滚（仍显示关）+ 不保存', () => {
		const { applyPatch, notify, press, snapshot } = mount({
			enabled: false,
			model: { type: 'ref', ref: '' },
		});
		press('\r'); // 关 → 开：应被拦截
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining('请先配置重命名模型'),
			'warning',
		);
		expect(applyPatch).not.toHaveBeenCalled();
		// UI 回滚：enabled 行仍显示「关」
		const text = snapshot().join('\n');
		expect(text).toContain('关');
	});

	it('模型不可用（不在可用列表）时开开关 → 提示 + UI 回滚 + 不保存', () => {
		const { applyPatch, notify, press } = mount({
			enabled: false,
			model: { type: 'ref', ref: 'nope/nope-model' },
		});
		press('\r'); // 关 → 开：模型不可用应被拦截
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining('nope/nope-model 不可用'),
			'warning',
		);
		expect(applyPatch).not.toHaveBeenCalled();
	});

	it('模型已配置且可用时关 → 开 → 正常保存', () => {
		const { applyPatch, notify, press } = mount({
			enabled: false, // 默认 model: deepseek/deepseek-chat ∈ MODEL_SPECS
		});
		press('\r'); // 关 → 开：放行
		expect(applyPatch).toHaveBeenCalledWith({ enabled: true });
		expect(notify).not.toHaveBeenCalled();
	});

	it('model 项 Enter → submenu 渲染模型列表', () => {
		const { snapshot, press } = mount();
		press('\x1b[B'); // down → 重命名模型
		press('\r'); // Enter → submenu
		const text = snapshot().join('\n');
		expect(text).toContain('选择重命名模型');
		for (const spec of MODEL_SPECS) expect(text).toContain(spec);
	});

	it('model submenu 选择 → applyPatch({model}) 且关回主列表', () => {
		const { applyPatch, snapshot, press } = mount();
		press('\x1b[B'); // down → model
		press('\r'); // open submenu
		press('\x1b[B'); // down → anthropic
		press('\r'); // select
		expect(applyPatch).toHaveBeenCalledWith({
			model: { type: 'ref', ref: 'anthropic/claude-sonnet-4-5' },
		});
		// 回到主列表（不再显示 submenu 标题）
		const text = snapshot().join('\n');
		expect(text).not.toContain('选择重命名模型');
	});

	it('model submenu Esc → 取消不保存，回主列表', () => {
		const { applyPatch, snapshot, press } = mount();
		press('\x1b[B'); // down → model
		press('\r'); // open submenu
		press('\x1b'); // Esc
		expect(applyPatch).not.toHaveBeenCalled();
		expect(snapshot().join('\n')).not.toContain('选择重命名模型');
	});

	it('thinking 项 Enter → submenu 渲染 7 级别', () => {
		const { snapshot, press } = mount();
		press('\x1b[B'); // → model
		press('\x1b[B'); // → length
		press('\x1b[B'); // → thinking
		press('\r'); // open submenu
		const text = snapshot().join('\n');
		expect(text).toContain('选择 Thinking 级别');
		for (const level of ['off', 'minimal', 'low', 'medium', 'high']) {
			expect(text).toContain(level);
		}
	});

	it('长度输入合法数字 → applyPatch({maxTitleLength})', () => {
		const { applyPatch, press } = mount();
		press('\x1b[B'); // → model
		press('\x1b[B'); // → maxTitleLength
		press('\r'); // open Editor（预填 50）
		press('\x7f'); // backspace 清 '0'
		press('\x7f'); // backspace 清 '5'
		for (const ch of '30') press(ch); // type "30"
		press('\r'); // submit
		expect(applyPatch).toHaveBeenCalledWith({ maxTitleLength: 30 });
	});

	it('长度输入非法 → notify warning 不保存', () => {
		const { applyPatch, notify, press } = mount();
		press('\x1b[B'); // → model
		press('\x1b[B'); // → maxTitleLength
		press('\r'); // open Editor
		press('x');
		press('\r'); // submit
		expect(applyPatch).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith('标题长度须为正整数', 'warning');
	});

	it('Esc 关闭面板 → onClose', () => {
		const { onClose, press } = mount();
		press('\x1b');
		expect(onClose).toHaveBeenCalled();
	});
});
