/**
 * preset PresetPanelComponent — headless snapshot tests
 *
 * 验证（ADR-0023 纯横线 + ADR-0031 master-detail）：
 *   纯横线边框（无 ┌┐└┘│）、2+ 宽度下不超宽、
 *   master-detail 两级导航（→/Enter 详情 / ← 返回 / Space 选用取消 / Esc 关闭）、
 *   详情页 5 字段展示（未配置显式「未设置」）、长 instructions 滚动不超宽。
 */
import { describe, it, expect } from 'vitest';
import {
	MockTerminal,
	TuiMainScreen,
	assertWithinWidth,
	stripAnsi,
} from '../../../src/tui-testing/index.js';
import {
	PresetPanelComponent,
	type PresetPanelActions,
	type PresetPanelItem,
} from '../../../extensions/meta/preset/index.js';

function mockTheme(): any {
	return {
		fg: (_c: string, text: string) => text,
		bg: (_c: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		underline: (text: string) => text,
		inverse: (text: string) => text,
	};
}

function makeItems(): PresetPanelItem[] {
	return [
		{
			name: 'plan',
			preset: {
				provider: 'anthropic',
				model: 'claude-sonnet-4-5',
				thinkingLevel: 'high',
				tools: ['read', 'bash'],
				instructions: '你是规划专家。',
			},
			scope: 'user',
			isActive: true,
		},
		{
			name: 'implement',
			preset: { provider: 'anthropic', model: 'claude-sonnet-4-5', thinkingLevel: 'medium' },
			scope: 'project',
			isActive: false,
		},
		{ name: 'minimal', preset: {}, scope: 'session', isActive: false },
		{ name: '(none)', preset: null, scope: undefined, isActive: false },
	];
}

function makePanel(items: PresetPanelItem[] = makeItems()) {
	const tui = new TuiMainScreen(new MockTerminal(80, 24));
	let result: string | null | undefined;
	const comp = new PresetPanelComponent(items, tui as any, mockTheme() as any, (r) => {
		// onDone 的 r 含 EditInstructionsRequest（关面板转 editor 的请求信号），
		// 本测试只关心 string（选中名）/ null（取消），其余信号映射为 undefined。
		result = typeof r === 'string' || r === null ? r : undefined;
	});
	return { comp, getResult: () => result };
}

function makeActions(overrides: Partial<PresetPanelActions> = {}): PresetPanelActions {
	return {
		addSessionPreset: () => null,
		deleteSessionPreset: async () => false,
		getItems: () => makeItems(),
		promptName: async () => null,
		notify: () => {},
		editField: async () => null,
		copyToSession: () => null,
		promoteToProject: async () => false,
		toggleLock: () => false,
		...overrides,
	};
}

describe('PresetPanelComponent', () => {
	it('纯横线边框：无竖线、无角字符，含标题', () => {
		const { comp } = makePanel();
		const text = comp.render(80).map(stripAnsi).join('\n');
		expect(text).not.toContain('│');
		expect(text).not.toContain('┌');
		expect(text).not.toContain('┐');
		expect(text).not.toContain('└');
		expect(text).not.toContain('┘');
		expect(text).toContain('── 选择预设');
	});

	it('2+ 宽度下渲染不超宽', () => {
		for (const w of [80, 60, 40]) {
			const { comp } = makePanel();
			assertWithinWidth(comp.render(w), w);
		}
	});

	it('列表默认选中当前激活项（active 标记）', () => {
		const { comp } = makePanel();
		const text = comp.render(80).map(stripAnsi).join('\n');
		expect(text).toContain('> [全局] plan (active)');
	});

	it('来源标记渲染：行首 [会话]/[项目]/[全局]', () => {
		const { comp } = makePanel();
		const text = comp.render(80).map(stripAnsi).join('\n');
		expect(text).toContain('[会话] minimal');
		expect(text).toContain('[项目] implement');
		expect(text).toContain('[全局] plan');
	});

	it('footer 两行：来源图例 + 操作键，均不超宽', () => {
		const { comp } = makePanel();
		const text = comp.render(80).map(stripAnsi).join('\n');
		expect(text).toContain('[会话] 临时 · [项目] [全局] 文件级（改配置文件）');
		expect(text).toContain('n 新建 · d 删除 · Esc 关闭');
		for (const w of [80, 60]) assertWithinWidth(comp.render(w), w);
	});

	it('→ 进入详情：展示全部字段', () => {
		const { comp } = makePanel();
		comp.handleInput('\u001b[C'); // →
		const text = comp.render(80).map(stripAnsi).join('\n');
		expect(text).toContain('── 预设详情: plan');
		expect(text).toContain('anthropic');
		expect(text).toContain('claude-sonnet-4-5');
		expect(text).toContain('high');
		expect(text).toContain('read, bash');
		expect(text).toContain('你是规划专家。');
	});

	it('详情页未配置字段显示「未设置」', () => {
		const { comp } = makePanel();
		comp.handleInput('\u001b[B'); // ↓ implement
		comp.handleInput('\u001b[B'); // ↓ minimal
		comp.handleInput('\u001b[C'); // → 详情
		const text = comp.render(80).map(stripAnsi).join('\n');
		expect(text).toContain('── 预设详情: minimal');
		expect(text).toContain('未设置');
	});

	it('← 返回列表；Enter 进详情、Space 取消已激活项', () => {
		const { comp, getResult } = makePanel();
		comp.handleInput('\u001b[C'); // → 详情
		comp.handleInput('\u001b[D'); // ← 返回列表
		const text = comp.render(80).map(stripAnsi).join('\n');
		expect(text).toContain('── 选择预设');

		comp.handleInput('\r'); // Enter 进详情（不再是选用）
		const detailText = comp.render(80).map(stripAnsi).join('\n');
		expect(detailText).toContain('预设详情');

		comp.handleInput('\u001b[D'); // ← 返回列表
		comp.handleInput(' '); // Space 对已激活的 plan → 取消选中
		expect(getResult()).toBe('(none)');
	});

	it('Space 激活未激活项', () => {
		const { comp, getResult } = makePanel();
		comp.handleInput('\u001b[B'); // ↓ implement（未激活）
		comp.handleInput(' '); // Space 激活 implement
		expect(getResult()).toBe('implement');
	});

	it('Esc 关闭返回 null', () => {
		const { comp, getResult } = makePanel();
		comp.handleInput('\x1b'); // Esc
		expect(getResult()).toBe(null);
	});

	it('(none) 项详情展示清除说明', () => {
		const { comp } = makePanel();
		comp.handleInput('\u001b[B'); // ↓
		comp.handleInput('\u001b[B'); // ↓
		comp.handleInput('\u001b[B'); // ↓ (none)
		comp.handleInput('\u001b[C'); // → 详情
		const text = comp.render(80).map(stripAnsi).join('\n');
		expect(text).toContain('── 预设详情: (none)');
		expect(text).toContain('清除活动预设');
	});

	it('长 instructions 滚动后仍不超宽、不崩溃', () => {
		const longInstructions = Array.from(
			{ length: 30 },
			(_, i) => `第 ${i + 1} 行指令内容`,
		).join('\n');
		const items = makeItems();
		items[0] = {
			name: 'plan',
			preset: { provider: 'x', model: 'y', instructions: longInstructions },
			isActive: true,
		};
		const { comp } = makePanel(items);
		comp.handleInput('\u001b[C'); // → 详情
		assertWithinWidth(comp.render(60), 60);

		for (let i = 0; i < 20; i++) {
			comp.handleInput('\u001b[B'); // ↓ 滚动
			assertWithinWidth(comp.render(60), 60);
		}
	});

	it('列表 >10 项时带滚动视口，选中项始终可见', () => {
		const items: PresetPanelItem[] = Array.from({ length: 14 }, (_, i) => ({
			name: `preset-${i + 1}`,
			preset: { provider: 'x', model: `m${i}` },
			isActive: i === 0,
		}));
		items.push({ name: '(none)', preset: null, isActive: false });
		const { comp } = makePanel(items);

		// 初始：仅渲染视口内前 10 项，含滚动提示
		const first = comp.render(80).map(stripAnsi).join('\n');
		expect(first).toContain('preset-1');
		expect(first).not.toContain('preset-11'); // 超出视口
		expect(first).toContain('↑↓ 滚动');
		assertWithinWidth(comp.render(80), 80);

		// 连续 ↓ 到底部：选中项（(none)）仍可见，顶部项滚出视口
		for (let i = 0; i < items.length - 1; i++) comp.handleInput('\u001b[B');
		const last = comp.render(80).map(stripAnsi).join('\n');
		expect(last).toContain('> (none)');
		expect(last).toContain('preset-6'); // 视口第一项
		expect(last).not.toContain('preset-5'); // 顶部项已滚出视口
		assertWithinWidth(comp.render(80), 80);
	});
});

describe('PresetPanelComponent 会话级增删（Ticket 03）', () => {
	function makePanelWithActions(items: PresetPanelItem[], actions: PresetPanelActions) {
		const tui = new TuiMainScreen(new MockTerminal(80, 24));
		const comp = new PresetPanelComponent(
			items,
			tui as never,
			mockTheme() as never,
			() => {},
			0,
			actions,
		);
		return comp;
	}

	function tick(): Promise<void> {
		return new Promise((r) => setTimeout(r, 0));
	}

	it('n 新建：输入名称 → addSessionPreset → 刷新并选中', async () => {
		const items = makeItems();
		let added: string | null = null;
		let refreshed = 0;
		const nextItems = [...items];
		nextItems.splice(nextItems.length - 1, 0, {
			name: 'debug',
			preset: {},
			scope: 'session',
			isActive: false,
		});
		const actions = makeActions({
			addSessionPreset: (name) => {
				added = name;
				return null;
			},
			getItems: () => {
				refreshed++;
				return nextItems;
			},
			promptName: async () => 'debug',
		});
		const comp = makePanelWithActions(items, actions);
		comp.handleInput('n');
		await tick();
		expect(added).toBe('debug');
		expect(refreshed).toBe(1);
		const text = comp.render(80).map(stripAnsi).join('\n');
		expect(text).toContain('> [会话] debug');
	});

	it('n 重名冲突：notify 错误，不刷新', async () => {
		const items = makeItems();
		let notified = '';
		const actions = makeActions({
			addSessionPreset: () => '已存在同名 preset：plan',
			getItems: () => items,
			promptName: async () => 'plan',
			notify: (msg) => {
				notified = msg;
			},
		});
		const comp = makePanelWithActions(items, actions);
		comp.handleInput('n');
		await tick();
		expect(notified).toContain('已存在同名');
	});

	it('d 删除会话级：确认 → deleteSessionPreset → 刷新', async () => {
		const items = makeItems();
		let deleted: string | null = null;
		let refreshed = 0;
		const actions = makeActions({
			deleteSessionPreset: async (name) => {
				deleted = name;
				return true;
			},
			getItems: () => {
				refreshed++;
				return items.filter((it) => it.name !== 'minimal');
			},
		});
		const comp = makePanelWithActions(items, actions);
		comp.handleInput('\u001b[B'); // ↓ implement
		comp.handleInput('\u001b[B'); // ↓ minimal（会话级）
		comp.handleInput('d');
		await tick();
		expect(deleted).toBe('minimal');
		expect(refreshed).toBe(1);
	});

	it('d 不删文件级：选中文件级 preset 按 d 不触发删除', async () => {
		const items = makeItems();
		let deleted = false;
		const actions = makeActions({
			deleteSessionPreset: async () => {
				deleted = true;
				return true;
			},
			getItems: () => items,
		});
		const comp = makePanelWithActions(items, actions);
		// 默认选中 plan（文件级 user），按 d 不应触发删除
		comp.handleInput('d');
		await tick();
		expect(deleted).toBe(false);
	});
});

describe('PresetPanelComponent 字段编辑（Ticket 04）', () => {
	function makePanelWithActions(items: PresetPanelItem[], actions: PresetPanelActions) {
		const tui = new TuiMainScreen(new MockTerminal(80, 24));
		const comp = new PresetPanelComponent(
			items,
			tui as never,
			mockTheme() as never,
			() => {},
			0,
			actions,
		);
		return comp;
	}

	function tick(): Promise<void> {
		return new Promise((r) => setTimeout(r, 0));
	}

	// 选中 minimal（会话级，index 2）并进入详情 + 编辑模式
	function enterEdit(comp: PresetPanelComponent): void {
		comp.handleInput('\u001b[B'); // ↓ implement
		comp.handleInput('\u001b[B'); // ↓ minimal（会话级）
		comp.handleInput('\u001b[C'); // → 详情
		comp.handleInput('e'); // → 编辑
	}

	it('e 键（会话级）进入编辑模式，渲染字段列表', () => {
		const items = makeItems();
		const comp = makePanelWithActions(items, makeActions());
		enterEdit(comp);
		const text = comp.render(80).map(stripAnsi).join('\n');
		expect(text).toContain('── 编辑预设: minimal');
		expect(text).toContain('> Name');
		expect(text).toContain('Model');
		expect(text).toContain('↑↓ 选字段 · Enter 编辑 · Esc 返回详情');
		assertWithinWidth(comp.render(60), 60);
	});

	it('e 键（文件级）不进入编辑模式', () => {
		const items = makeItems();
		const comp = makePanelWithActions(items, makeActions());
		comp.handleInput('\u001b[C'); // → 详情（plan，文件级 user）
		comp.handleInput('e');
		const text = comp.render(80).map(stripAnsi).join('\n');
		expect(text).toContain('── 预设详情: plan');
		expect(text).not.toContain('── 编辑预设');
	});

	it('Enter 编辑字段 → editField 调用并更新 items', async () => {
		const items = makeItems();
		let edited: { name: string; field: string } | null = null;
		const actions = makeActions({
			editField: async (name, field, current) => {
				edited = { name, field };
				return { preset: { ...current, thinkingLevel: 'low' } };
			},
		});
		const comp = makePanelWithActions(items, actions);
		enterEdit(comp);
		comp.handleInput('\r'); // Enter 编辑第一个字段（name）
		await tick();
		expect(edited).toEqual({ name: 'minimal', field: 'name' });
		expect(items[2].preset?.thinkingLevel).toBe('low');
	});

	it('edit 模式 ↑↓ 导航字段，Esc 返回详情', () => {
		const items = makeItems();
		const comp = makePanelWithActions(items, makeActions());
		enterEdit(comp);
		comp.handleInput('\u001b[B'); // ↓ 到 model
		const text = comp.render(80).map(stripAnsi).join('\n');
		expect(text).toContain('> Model');
		comp.handleInput('\x1b'); // Esc 返回详情
		const detailText = comp.render(80).map(stripAnsi).join('\n');
		expect(detailText).toContain('── 预设详情: minimal');
	});
});

describe('PresetPanelComponent 复制与提升（Ticket 05）', () => {
	function makePanelWithActions(items: PresetPanelItem[], actions: PresetPanelActions) {
		const tui = new TuiMainScreen(new MockTerminal(80, 24));
		const comp = new PresetPanelComponent(
			items,
			tui as never,
			mockTheme() as never,
			() => {},
			0,
			actions,
		);
		return comp;
	}

	function tick(): Promise<void> {
		return new Promise((r) => setTimeout(r, 0));
	}

	it('文件级 e → copyToSession → 复制为「原名-复制」并进编辑', () => {
		const items = makeItems();
		let copied: string | null = null;
		const nextItems = [...items];
		nextItems.splice(nextItems.length - 1, 0, {
			name: 'plan-复制',
			preset: { ...items[0].preset },
			scope: 'session',
			isActive: false,
		});
		const actions = makeActions({
			copyToSession: (name) => {
				copied = name;
				return `${name}-复制`;
			},
			getItems: () => nextItems,
		});
		const comp = makePanelWithActions(items, actions);
		comp.handleInput('\u001b[C'); // → 详情（plan，文件级 user）
		comp.handleInput('e'); // 复制为临时
		expect(copied).toBe('plan');
		const text = comp.render(80).map(stripAnsi).join('\n');
		expect(text).toContain('── 编辑预设: plan-复制');
	});

	it('会话级 s → promoteToProject 调用并刷新', async () => {
		const items = makeItems();
		let promoted: string | null = null;
		let refreshed = 0;
		const actions = makeActions({
			promoteToProject: async (name) => {
				promoted = name;
				return true;
			},
			getItems: () => {
				refreshed++;
				return items.filter((it) => it.name !== 'minimal');
			},
		});
		const comp = makePanelWithActions(items, actions);
		comp.handleInput('\u001b[B'); // ↓ implement
		comp.handleInput('\u001b[B'); // ↓ minimal（会话级）
		comp.handleInput('\u001b[C'); // → 详情
		comp.handleInput('s'); // 提升
		await tick();
		expect(promoted).toBe('minimal');
		expect(refreshed).toBe(1);
	});

	it('文件级 s 不触发提升', async () => {
		const items = makeItems();
		let promoted = false;
		const actions = makeActions({
			promoteToProject: async () => {
				promoted = true;
				return true;
			},
		});
		const comp = makePanelWithActions(items, actions);
		comp.handleInput('\u001b[C'); // → 详情（plan，文件级 user）
		comp.handleInput('s');
		await tick();
		expect(promoted).toBe(false);
	});
});
