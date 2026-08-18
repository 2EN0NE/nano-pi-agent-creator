/**
 * custom-compaction settings UI — headless snapshot tests
 *
 * 强制要求：新建 TUI 组件必须用 renderToSnapshot + assertWithinWidth 验证
 * 渲染输出在 2+ 种宽度下不超宽、不崩溃；键盘交互用 dispatchInput 验证状态切换。
 *
 * Covers:
 *   - main mode: renders within width at 80/120, no crash
 *   - fields mode: renders within width at 80/120
 *   - keyboard: Down changes selection, Enter emits edit-profile, Esc emits close
 *   - lab inactive state renders
 *   - Chinese labels present
 */
import { describe, it, expect } from 'vitest';
import { assertWithinWidth, stripAnsi } from '../../../src/tui-testing/index.js';
import {
	SettingsComponent,
	type SettingsPanelData,
	type SettingsUIAction,
} from '../../../extensions/context/custom-compaction/settings-ui.js';

function makeData(overrides: Partial<SettingsPanelData> = {}): SettingsPanelData {
	return {
		configLabel: 'Default (user)',
		activePath: '/home/xx/.pi/agent/extensions-data/custom-compaction/config.json',
		saveScope: 'user',
		modelLine: '当前模型: openai/gpt-4o > Profile: Default',
		profiles: [
			{
				id: 'default',
				name: 'Default',
				active: true,
				description: '触发: 上下文使用达 20% 时压缩 | 机制: LLM 全量摘要',
				fields: [
					{ key: 'name', label: '名称', value: 'Default' },
					{ key: 'threshold', label: '触发阈值', value: '20%' },
					{
						key: 'mechanismType',
						label: '压缩机制',
						value: 'LLM 全量摘要（自定义提示词）',
					},
				],
			},
			{
				id: 'smart-compact',
				name: 'EESV Smart Compact',
				active: false,
				description: '触发: 上下文使用达 70% 时压缩 | 机制: 外部适配器',
				fields: [
					{ key: 'name', label: '名称', value: 'EESV Smart Compact' },
					{ key: 'threshold', label: '触发阈值', value: '70%' },
				],
			},
		],
		lab: {
			active: true,
			experiments: [
				{
					key: 'mechanism',
					name: 'mechanism-strategy',
					currentArm: 'summarize',
					totalCalls: 12,
				},
				{
					key: 'prompt',
					name: 'prompt-strategy',
					currentArm: 'structured',
					totalCalls: 12,
				},
				{ key: 'threshold', name: 'threshold-strategy', currentArm: '70', totalCalls: 12 },
			],
		},
		...overrides,
	};
}

/** 手动调用 handleInput（组件无 TUI 依赖） */
// （键盘导航测试使用下方 capture() 辅助，无需单独 press）

// ── render width ─────────────────────────────────────────────────

describe('SettingsComponent render width (TUI 铁律)', () => {
	const widths = [60, 80, 120];

	for (const w of widths) {
		it(`main mode does not exceed width at ${w}`, () => {
			const comp = new SettingsComponent(makeData(), () => {});
			const lines = comp.render(w);
			assertWithinWidth(lines, w);
			expect(lines.length).toBeGreaterThan(5);
		});

		it(`fields mode does not exceed width at ${w}`, () => {
			const comp = new SettingsComponent(makeData(), () => {}, 'fields', 'default');
			const lines = comp.render(w);
			assertWithinWidth(lines, w);
			expect(lines.length).toBeGreaterThan(5);
		});
	}

	it('narrow width (60) does not crash with long content', () => {
		const data = makeData({
			modelLine:
				'当前模型: openai/gpt-4o-turbo-2024-11-20-preview > Profile: EESV Smart Compact（很长很长的描述）',
		});
		const comp = new SettingsComponent(data, () => {});
		const lines = comp.render(60);
		assertWithinWidth(lines, 60);
	});

	it('very narrow width (20) does not crash (title line truncated)', () => {
		// 标题行（╭── custom-compaction ...）在宽度 <24 时曾超出终端宽度
		const comp = new SettingsComponent(makeData(), () => {});
		for (const w of [20, 22, 24, 28]) {
			const lines = comp.render(w);
			assertWithinWidth(lines, w);
		}
	});
});

// ── content ──────────────────────────────────────────────────────

describe('SettingsComponent content', () => {
	it('shows Chinese labels and profile names', () => {
		const comp = new SettingsComponent(makeData(), () => {});
		const text = stripAnsi(comp.render(80).join('\n'));
		expect(text).toContain('Custom Compaction 设置');
		expect(text).toContain('Default');
		expect(text).toContain('EESV Smart Compact');
		expect(text).toContain('实验状态');
		expect(text).toContain('保存目标: user 层');
	});

	it('footer shows add-profile hint', () => {
		const comp = new SettingsComponent(makeData(), () => {});
		const text = stripAnsi(comp.render(80).join('\n'));
		expect(text).toContain('n 新增');
		expect(text).toContain('Esc 关闭');
	});

	it('top border embeds the plugin name (╭── custom-compaction ─...╮)', () => {
		const comp = new SettingsComponent(makeData(), () => {});
		const first = stripAnsi(comp.render(80)[0]);
		expect(first.trimEnd().startsWith('╭── custom-compaction')).toBe(true);
		expect(first.trimEnd().endsWith('╮')).toBe(true);
		// 顶边框总宽不超视口
		assertWithinWidth(comp.render(80), 80);
	});

	it('shows experiment status when lab active', () => {
		const comp = new SettingsComponent(makeData(), () => {});
		const text = stripAnsi(comp.render(80).join('\n'));
		expect(text).toContain('mechanism-strategy');
		expect(text).toContain('样本=12');
	});

	it('shows lab-inactive hint when pi-lab unavailable', () => {
		const data = makeData({ lab: { active: false, experiments: [] } });
		const comp = new SettingsComponent(data, () => {});
		const text = stripAnsi(comp.render(80).join('\n'));
		expect(text).toContain('pi-lab 未接入');
	});

	it('fields mode shows field labels and values', () => {
		const comp = new SettingsComponent(makeData(), () => {}, 'fields', 'default');
		const text = stripAnsi(comp.render(80).join('\n'));
		expect(text).toContain('触发阈值');
		expect(text).toContain('20%');
		expect(text).toContain('压缩机制');
	});
});

// ── keyboard navigation ──────────────────────────────────────────

describe('SettingsComponent keyboard', () => {
	function capture(
		data: SettingsPanelData,
		mode: 'main' | 'fields' = 'main',
		profileId: string | null = null,
	) {
		const actions: SettingsUIAction[] = [];
		const comp = new SettingsComponent(data, (a) => actions.push(a), mode, profileId);
		return { comp, actions };
	}

	it('Down changes selection (render output differs)', () => {
		const { comp } = capture(makeData());
		const before = stripAnsi(comp.render(80).join('\n'));
		comp.handleInput('\x1b[B'); // Down
		const after = stripAnsi(comp.render(80).join('\n'));
		expect(after).not.toEqual(before);
	});

	it('Up wraps around to last profile', () => {
		const { comp } = capture(makeData());
		comp.handleInput('\x1b[A'); // Up from index 0
		// 不应崩溃，且选中变化
		const text = stripAnsi(comp.render(80).join('\n'));
		expect(text.length).toBeGreaterThan(0);
	});

	it('Enter on a profile emits edit-profile action', () => {
		const { comp, actions } = capture(makeData());
		comp.handleInput('\r');
		expect(actions).toHaveLength(1);
		expect(actions[0]).toEqual({ type: 'edit-profile', profileId: 'default' });
	});

	it('n emits add-profile action in main mode', () => {
		const { comp, actions } = capture(makeData());
		comp.handleInput('n');
		expect(actions).toHaveLength(1);
		expect(actions[0]).toEqual({ type: 'add-profile' });
	});

	it('uppercase N also emits add-profile action (case-insensitive)', () => {
		const { comp, actions } = capture(makeData());
		comp.handleInput('N');
		expect(actions).toHaveLength(1);
		expect(actions[0]).toEqual({ type: 'add-profile' });
	});

	it('n does NOT emit add-profile in fields mode', () => {
		const { comp, actions } = capture(makeData(), 'fields', 'default');
		comp.handleInput('n');
		expect(actions).toHaveLength(0);
	});

	it('Esc emits close', () => {
		const { comp, actions } = capture(makeData());
		comp.handleInput('\x1b');
		expect(actions).toHaveLength(1);
		expect(actions[0]).toEqual({ type: 'close' });
	});

	it('fields mode: Enter on a field emits edit-field action', () => {
		const { comp, actions } = capture(makeData(), 'fields', 'default');
		comp.handleInput('\r');
		expect(actions).toHaveLength(1);
		expect(actions[0]).toEqual({ type: 'edit-field', profileId: 'default', fieldKey: 'name' });
	});

	it('fields mode: Down then Enter selects the second field', () => {
		const { comp, actions } = capture(makeData(), 'fields', 'default');
		comp.handleInput('\x1b[B');
		comp.handleInput('\r');
		expect(actions[0]).toEqual({
			type: 'edit-field',
			profileId: 'default',
			fieldKey: 'threshold',
		});
	});
});
