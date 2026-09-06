/**
 * custom-rename — TUI 配置面板
 *
 * /auto-rename 打开：设置列表（SettingsList）展示并修改 4 项配置
 *   1. 自动重命名开关     — 开/关 循环切换
 *   2. 重命名模型         — submenu SelectList（列出 modelRegistry 可用模型）
 *   3. 标题最大长度       — submenu Editor（数字输入，直接回车确认）
 *   4. Thinking 级别      — submenu SelectList（枚举值）
 *
 * RenameSettingsPanel 是纯组件（数据/操作经 RenameSettingsDeps 注入），
 * 可用 headless snapshot 测试（TuiMainScreen + MockTerminal）。
 */
import type { Theme } from '@earendil-works/pi-coding-agent';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import { createLogger } from '@zenone/pi-logger';
import {
	Editor,
	SelectList,
	SettingsList,
	truncateToWidth,
	type Component,
	type SelectItem,
	type SettingItem,
} from '@earendil-works/pi-tui';
import type { TUI } from '@earendil-works/pi-tui';
import { topBorder } from '../../../../src/tui/helpers.js';
import {
	loadFileRenameConfig,
	loadRenameConfig,
	normalizeRenameConfig,
	saveRenameConfig,
	type RenameSessionConfig,
} from './pure.js';

const log = createLogger('custom-rename-ui');

// ──────────────────────── 依赖注入（headless 测试边界） ────────────────────────

export interface RenameSettingsDeps {
	/** 读当前配置（每次渲染/操作前调用，保证最新）。 */
	getConfig(): RenameSessionConfig;
	/** 可选模型 spec 列表（provider/id）。 */
	getModelSpecs(): string[];
	/** 应用变更（保存后返回是否成功）。 */
	applyPatch(patch: Partial<RenameSessionConfig>): boolean;
	/** 通知（info/warning/error）。 */
	notify(message: string, type?: 'info' | 'warning' | 'error'): void;
	/** 关闭面板。 */
	onClose(): void;
}

const ENABLED_VALUES = ['开', '关'] as const;
const THINKING_LEVEL_VALUES: ReadonlyArray<ModelThinkingLevel> = [
	'off',
	'minimal',
	'low',
	'medium',
	'high',
	'xhigh',
	'max',
];

function modelRefOf(cfg: RenameSessionConfig): string {
	return cfg.model.type === 'ref' && cfg.model.ref ? cfg.model.ref : '';
}

/** id → config patch（纯函数，可单测）。 */
export function configPatchFor(id: string, newValue: string): Partial<RenameSessionConfig> | null {
	switch (id) {
		case 'enabled':
			return { enabled: newValue === '开' };
		case 'model':
			return { model: { type: 'ref', ref: newValue } };
		case 'thinkingLevel':
			return { thinkingLevel: newValue as ModelThinkingLevel };
		case 'maxTitleLength': {
			const n = Number(newValue);
			return Number.isInteger(n) && n > 0 ? { maxTitleLength: n } : null;
		}
		default:
			return null;
	}
}

// ──────────────────────── 面板组件 ────────────────────────

export class RenameSettingsPanel implements Component {
	private mainSettings: SettingsList | null = null;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private deps: RenameSettingsDeps,
	) {}

	handleInput(data: string): void {
		if (!this.mainSettings) this.buildMain();
		this.mainSettings?.handleInput(data);
	}

	render(width: number): string[] {
		if (!this.mainSettings) this.buildMain();
		const lines: string[] = [];
		lines.push(
			truncateToWidth(
				this.theme.fg('accent', this.theme.bold(topBorder('── auto-rename 设置 ', width))),
				width,
			),
		);
		lines.push(...(this.mainSettings?.render(width) ?? []));
		return lines;
	}

	invalidate(): void {
		this.mainSettings = null;
	}

	// ── 主列表 ──

	private buildMain(): void {
		const cfg = this.deps.getConfig();
		const items: SettingItem[] = [
			{
				id: 'enabled',
				label: '自动重命名',
				currentValue: cfg.enabled ? '开' : '关',
				values: [...ENABLED_VALUES],
			},
			{
				id: 'model',
				label: '重命名模型',
				currentValue: modelRefOf(cfg) || '(未配置)',
				submenu: (_cur: string, done: (v?: string) => void) => this.buildModelSubmenu(done),
			},
			{
				id: 'maxTitleLength',
				label: '标题最大长度',
				currentValue: String(cfg.maxTitleLength),
				submenu: (cur: string, done: (v?: string) => void) =>
					this.buildLengthSubmenu(cur, done),
			},
			{
				id: 'thinkingLevel',
				label: 'Thinking 级别',
				currentValue: cfg.thinkingLevel,
				submenu: (_cur: string, done: (v?: string) => void) =>
					this.buildThinkingSubmenu(done),
			},
		];

		this.mainSettings = new SettingsList(
			items,
			10,
			this.settingsTheme(),
			(id, newValue) => this.applyChange(id, newValue),
			() => this.deps.onClose(),
		);
	}

	private applyChange(id: string, newValue: string): void {
		// 开开关前置校验：必须先有「可用」的重命名模型（ref 已配置且在可用模型列表中）。
		// SettingsList 的循环切换会先改 currentValue 再回调（onChange 无法阻止），
		// 校验失败必须 updateValue 回滚 UI，否则屏幕显示「开」但未落盘。
		if (id === 'enabled' && newValue === '开' && !this.canEnable()) {
			this.mainSettings?.updateValue('enabled', '关');
			return;
		}
		const patch = configPatchFor(id, newValue);
		if (!patch) {
			this.deps.notify('标题长度须为正整数', 'warning');
			return;
		}
		if (this.deps.applyPatch(patch)) {
			log.info(`setting changed ${id}=${newValue}`);
		} else {
			this.deps.notify('保存失败', 'error');
		}
	}

	/** 校验「自动重命名」能否开启：模型 ref 已配置且可用（否则 notify 提示原因）。 */
	private canEnable(): boolean {
		const ref = modelRefOf(this.deps.getConfig());
		if (!ref) {
			this.deps.notify('请先配置重命名模型（回车「重命名模型」选择）', 'warning');
			return false;
		}
		if (!this.deps.getModelSpecs().includes(ref)) {
			this.deps.notify(`模型 ${ref} 不可用，请先在「重命名模型」中重新选择`, 'warning');
			return false;
		}
		return true;
	}

	// ── 二级 submenu ──

	/** 模型列表（SelectList），Enter 选值 → done(spec)，Esc → done()。 */
	private buildModelSubmenu(done: (v?: string) => void): Component {
		const current = modelRefOf(this.deps.getConfig());
		const specs = this.deps.getModelSpecs();
		const items: SelectItem[] = specs.map((spec) => ({
			value: spec,
			label: spec,
			description: spec === current ? '当前' : '可选模型',
		}));
		return this.buildSelectSubmenu('选择重命名模型', items, done);
	}

	/** thinking 级别列表（SelectList）。 */
	private buildThinkingSubmenu(done: (v?: string) => void): Component {
		const current = this.deps.getConfig().thinkingLevel;
		const items: SelectItem[] = THINKING_LEVEL_VALUES.map((level) => ({
			value: level,
			label: level,
			description: levelDescription(level, level === current),
		}));
		return this.buildSelectSubmenu('选择 Thinking 级别', items, done);
	}

	/** 通用 SelectList submenu：标题行 + 列表；Esc/取消 → done() 不保存。 */
	private buildSelectSubmenu(
		title: string,
		items: SelectItem[],
		done: (v?: string) => void,
	): Component {
		const list = new SelectList(items, Math.min(items.length, 10), this.selectTheme());
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done();
		return this.wrapWithTitle(title, list);
	}

	/** 长度输入（Editor）：数字回车确认 → done(text)；Esc → done()。非法输入提示不关闭。 */
	private buildLengthSubmenu(current: string, done: (v?: string) => void): Component {
		const editor = new Editor(this.tui, {
			borderColor: (s: string) => this.theme.fg('accent', s),
			selectList: this.selectTheme(),
		});
		editor.setText(current);
		editor.onSubmit = (text: string) => {
			const trimmed = text.trim();
			if (trimmed === '' || !Number.isInteger(Number(trimmed)) || Number(trimmed) <= 0) {
				this.deps.notify('标题长度须为正整数', 'warning');
				return;
			}
			done(trimmed);
		};
		return {
			render: (width: number) => {
				const hint = this.theme.fg('dim', '输入数字后回车确认 · Esc 取消');
				return [truncateToWidth(hint, width), '', ...editor.render(width)];
			},
			invalidate() {
				editor.invalidate();
			},
			handleInput(data: string) {
				if (data === '\x1b' || data === 'Escape') {
					done();
					return;
				}
				editor.handleInput(data);
			},
		};
	}

	// ── 布局/主题辅助 ──

	/** 标题行 + child：用于 submenu（返回纯 Component 对象）。 */
	private wrapWithTitle(title: string, child: Component): Component {
		return {
			render: (width: number) => {
				const lines: string[] = [];
				lines.push(truncateToWidth(this.theme.fg('dim', title), width));
				lines.push('');
				lines.push(...child.render(width));
				return lines;
			},
			invalidate: () => child.invalidate(),
			handleInput: (data: string) => child.handleInput?.(data),
		};
	}

	private selectTheme() {
		const theme = this.theme;
		return {
			selectedPrefix: (text: string) => theme.fg('accent', text),
			selectedText: (text: string) => theme.fg('accent', text),
			description: (text: string) => theme.fg('muted', text),
			scrollInfo: (text: string) => theme.fg('dim', text),
			noMatch: (text: string) => theme.fg('warning', text),
		};
	}

	/** SettingsList 主题（自建，无全局 theme 依赖，headless 可测；hint 已中文化）。 */
	private settingsTheme() {
		const theme = this.theme;
		return {
			label: (text: string, selected: boolean) =>
				selected ? theme.fg('accent', text) : text,
			value: (text: string, selected: boolean) =>
				selected ? theme.fg('accent', text) : theme.fg('muted', text),
			description: (text: string) => theme.fg('dim', text),
			cursor: theme.fg('accent', '> '),
			hint: () => theme.fg('dim', '回车/空格 修改 · Esc 退出'),
		};
	}
}

function levelDescription(level: ModelThinkingLevel, isCurrent: boolean): string {
	const base: Record<ModelThinkingLevel, string> = {
		off: '不传 reasoning',
		minimal: '最低思考',
		low: '低思考',
		medium: '中等思考',
		high: '高思考',
		xhigh: '极高思考',
		max: '最大思考',
	};
	const text = base[level] ?? level;
	return isCurrent ? `${text}（当前）` : text;
}

// ──────────────────────── 挂载入口 ────────────────────────

/** 从 modelRegistry 收集可用模型 spec（去重）。与 llm.resolveRenameModel 同口径：
 * 仅保留已配置凭证（hasConfiguredAuth）的模型——面板里列出的必须运行时真能解析，
 * 避免「选了却跑不动」的误导。 */
function availableModelSpecs(ctx: ExtensionContext): string[] {
	const seen = new Set<string>();
	const specs: string[] = [];
	for (const m of ctx.modelRegistry.getAvailable()) {
		if (!ctx.modelRegistry.hasConfiguredAuth(m)) continue;
		const spec = `${m.provider}/${m.id}`;
		if (!seen.has(spec)) {
			seen.add(spec);
			specs.push(spec);
		}
	}
	return specs;
}

/** 打开 TUI 配置面板（/auto-rename 无参数入口）。 */
export function openRenameSettings(ctx: ExtensionContext): void {
	void ctx.ui.custom<boolean>((tui, theme, _kb, done) => {
		return new RenameSettingsPanel(tui, theme, {
			getConfig: () => loadRenameConfig(),
			getModelSpecs: () => availableModelSpecs(ctx),
			applyPatch: (patch) => {
				// 以文件层配置（不含 env 覆盖）为合并基准落盘：避免把 PI_RENAME_*
				// 环境变量临时值固化进用户级 config.json（env 撤销后配置漂移残留）。
				const result = saveRenameConfig(
					normalizeRenameConfig({ ...loadFileRenameConfig(), ...patch }),
				);
				return result.success;
			},
			notify: (message, type) => ctx.ui.notify(message, type),
			onClose: () => done(true),
		});
	});
}
