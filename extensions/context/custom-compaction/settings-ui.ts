/**
 * Settings panel UI component (answer-style bordered box).
 *
 * 纯渲染 + 键盘导航组件，无 Pi 运行时依赖（仅 type 引用 Theme，可 headless 测试）。
 * 交互契约：
 *  - 主面板（main）：profile 列表 + 实验状态区。↑↓ 选择 profile，Enter 进入字段编辑，Esc 关闭。
 *  - 字段面板（fields）：选中 profile 的字段列表。↑↓ 选择字段，Enter 返回「编辑该字段」动作，
 *    编辑本身由调用方用原生对话框（ctx.ui.input/select/editor）完成。
 *
 * 遵守 TUI 铁律：
 *  - 第 0 行（标题）固定文案，动态内容置于下方（避免 firstChanged=0 触发 fullRender）
 *  - 组件总高固定（不滚动；profile 超出时截断并显示省略提示）
 *  - 每行 truncateToWidth 兜底 + visibleWidth 补空格对齐
 *  - 不使用 emoji/Unicode 图标
 */

import {
	matchesKey,
	Key,
	truncateToWidth,
	visibleWidth,
	type Component,
} from '@earendil-works/pi-tui';
import { bottomBorder, makeThemeColors, topBorder } from '../../../src/tui/helpers.js';
import type { Theme } from '@earendil-works/pi-coding-agent';

/** 配置层（纯字面量联合，保持渲染组件无 config 依赖） */
type ScopeLabel = 'user' | 'session' | 'project';

// ── 数据契约 ────────────────────────────────────────────────────

export interface ProfileFieldView {
	key: string;
	label: string;
	value: string;
}

export interface ProfileView {
	id: string;
	name: string;
	/** 是否在启用集内（Space 勾选启用） */
	enabled: boolean;
	description: string;
	fields: ProfileFieldView[];
}

export interface LabExperimentView {
	key: string;
	name: string;
	currentArm: string;
	totalCalls: number;
}

export interface SettingsPanelData {
	configLabel: string;
	activePath: string;
	saveScope: ScopeLabel;
	modelLine: string;
	/** 触发粒度中文标签（如「Agent 轮」） */
	triggerGranularityLabel: string;
	/** 路由规则的中文描述列表（有序） */
	routingRules: string[];
	profiles: ProfileView[];
	lab: { active: boolean; experiments: LabExperimentView[] };
}

export type SettingsUIAction =
	| { type: 'close' }
	| { type: 'edit-profile'; profileId: string }
	| { type: 'edit-field'; profileId: string; fieldKey: string }
	| { type: 'add-profile' }
	| { type: 'toggle-enable'; profileId: string }
	| { type: 'toggle-granularity' }
	| { type: 'manage-rules' };

// ── ANSI 颜色辅助（answer 同款） ───────────────────────────────

// ── 组件 ────────────────────────────────────────────────────────

export class SettingsComponent implements Component {
	private data: SettingsPanelData;
	private mode: 'main' | 'fields';
	private profileId: string | null;
	private selectedIndex: number = 0;
	private onDone: (action: SettingsUIAction) => void;

	// 颜色（由 theme 注入，禁用硬编码 ANSI，见 ADR-0023）
	private dim!: (s: string) => string;
	private bold!: (s: string) => string;
	private cyan!: (s: string) => string;
	private green!: (s: string) => string;
	private yellow!: (s: string) => string;
	private red!: (s: string) => string;
	private gray!: (s: string) => string;

	// 渲染缓存
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		data: SettingsPanelData,
		onDone: (action: SettingsUIAction) => void,
		theme: Theme,
		mode: 'main' | 'fields' = 'main',
		profileId: string | null = null,
	) {
		this.data = data;
		this.onDone = onDone;
		this.mode = mode;
		this.profileId = profileId;

		Object.assign(this, makeThemeColors(theme));
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	handleInput(input: string): void {
		if (matchesKey(input, Key.escape) || matchesKey(input, Key.ctrl('c'))) {
			// Esc / Ctrl+C
			this.onDone({ type: 'close' });
			return;
		}
		if (matchesKey(input, Key.up)) {
			// Up
			this.navigate(-1);
			return;
		}
		if (matchesKey(input, Key.down)) {
			// Down
			this.navigate(1);
			return;
		}
		if (this.mode === 'main' && input.toLowerCase() === 'n') {
			// n — 新增 profile（字段面板不响应，避免与字段编辑冲突）
			this.onDone({ type: 'add-profile' });
			return;
		}
		if (this.mode === 'main' && input === ' ') {
			// Space — 切换启用/停用（加入/移出启用集）
			const p = this.data.profiles[this.selectedIndex];
			if (p) this.onDone({ type: 'toggle-enable', profileId: p.id });
			return;
		}
		if (this.mode === 'main' && input.toLowerCase() === 'g') {
			// g — 循环切换触发粒度（user_turn / agent_turn / tool）
			this.onDone({ type: 'toggle-granularity' });
			return;
		}
		if (this.mode === 'main' && input.toLowerCase() === 'r') {
			// r — 管理路由规则（模型/复杂度 → profile）
			this.onDone({ type: 'manage-rules' });
			return;
		}
		if (matchesKey(input, Key.enter)) {
			// Enter
			if (this.mode === 'main') {
				const p = this.data.profiles[this.selectedIndex];
				if (p) this.onDone({ type: 'edit-profile', profileId: p.id });
			} else {
				const p = this.data.profiles.find((x) => x.id === this.profileId);
				const f = p?.fields[this.selectedIndex];
				if (f && p) {
					this.onDone({ type: 'edit-field', profileId: p.id, fieldKey: f.key });
				} else if (p) {
					this.onDone({ type: 'edit-profile', profileId: p.id });
				}
			}
			return;
		}
	}

	private navigate(delta: number): void {
		const count =
			this.mode === 'main'
				? this.data.profiles.length
				: (this.data.profiles.find((x) => x.id === this.profileId)?.fields.length ?? 0);
		if (count === 0) return;
		this.selectedIndex = (this.selectedIndex + delta + count) % count;
		this.invalidate();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const lines: string[] = [];
		// 完全填满终端宽度（对齐 custom-session-tree 的「跟随渲染管线宽度」策略）：
		// 去掉固定 100 列上限；width-4 保留 -4 边距约定，Math.max 仅防止极窄时出现负数。
		const boxWidth = Math.max(0, width - 4);
		const contentWidth = boxWidth - 4;

		const boxLine = (content: string): string => {
			// 纯横线范式（ADR-0023）：无竖线，truncate 兜底
			return truncateToWidth(content, Math.max(0, boxWidth));
		};
		const emptyBoxLine = (): string => '';
		const padToWidth = (line: string): string => {
			const len = visibleWidth(line);
			return line + ' '.repeat(Math.max(0, width - len));
		};

		// ── 顶边框（固定文案，第 0 行）：纯横线 + 插件名（ADR-0023）──
		lines.push(
			padToWidth(
				truncateToWidth(this.dim(topBorder('── custom-compaction ', boxWidth)), width),
			),
		);
		lines.push(
			padToWidth(
				boxLine(
					this.bold(
						this.cyan(this.mode === 'main' ? ' Custom Compaction 设置' : ' 字段编辑'),
					),
				),
			),
		);
		lines.push(padToWidth(this.dim(' ' + bottomBorder(boxWidth - 2) + ' ')));

		if (this.mode === 'main') {
			this.renderMain(lines, boxLine, emptyBoxLine, contentWidth);
		} else {
			this.renderFields(lines, boxLine, emptyBoxLine, contentWidth);
		}

		lines.push(padToWidth(this.dim(bottomBorder(boxWidth))));
		this.cachedLines = lines;
		this.cachedWidth = width;
		return lines;
	}

	// ── 主面板 ────────────────────────────────────────────────

	private renderMain(
		lines: string[],
		boxLine: (s: string) => string,
		emptyBoxLine: () => string,
		contentWidth: number,
	): void {
		const { data } = this;

		// 配置信息（动态内容 → 放标题下方，不影响第 0 行）
		lines.push(boxLine(truncateToWidth(`  配置: ${data.configLabel}`, contentWidth)));
		lines.push(boxLine(truncateToWidth(`  保存目标: ${data.saveScope} 层`, contentWidth)));
		lines.push(
			boxLine(truncateToWidth(`  触发粒度: ${data.triggerGranularityLabel}`, contentWidth)),
		);
		lines.push(boxLine(truncateToWidth(`  ${data.modelLine}`, contentWidth)));
		lines.push(emptyBoxLine());

		// Profile 列表
		const header = this.gray(' [Profile 列表]');
		lines.push(boxLine(truncateToWidth(header, contentWidth)));

		const MAX_PROFILES = 6;
		const shown = data.profiles.slice(0, MAX_PROFILES);
		for (let i = 0; i < shown.length; i++) {
			const p = shown[i];
			const isSel = i === this.selectedIndex;
			const marker = isSel ? this.cyan('>') : ' ';
			const enabledMark = p.enabled ? this.green('[x]') : this.dim('[ ]');
			const name = isSel ? this.bold(p.name) : p.name;
			const desc = p.description ? this.dim(`  ${p.description}`) : '';
			const row = `${marker} ${enabledMark} ${name}${desc}`;
			lines.push(boxLine(truncateToWidth(row, contentWidth)));
		}
		if (data.profiles.length > MAX_PROFILES) {
			lines.push(boxLine(this.dim(`  ... 共 ${data.profiles.length} 个 profile`)));
		}
		lines.push(emptyBoxLine());

		// 路由规则
		lines.push(boxLine(truncateToWidth(this.gray(' [路由规则]'), contentWidth)));
		if (data.routingRules.length === 0) {
			lines.push(boxLine(this.dim('   (无规则)')));
		} else {
			for (const r of data.routingRules) {
				lines.push(boxLine(truncateToWidth(`   ${r}`, contentWidth)));
			}
		}
		lines.push(emptyBoxLine());

		// 实验状态区
		lines.push(boxLine(truncateToWidth(this.gray(' [实验状态]'), contentWidth)));
		if (!data.lab.active) {
			lines.push(boxLine(this.dim('   pi-lab 未接入（实验不可用）')));
		} else if (data.lab.experiments.length === 0) {
			lines.push(boxLine(this.dim('   实验未注册')));
		} else {
			for (const exp of data.lab.experiments) {
				const arm =
					exp.currentArm === '(未压缩)' ? this.yellow(exp.currentArm) : exp.currentArm;
				lines.push(
					boxLine(
						truncateToWidth(
							`   ${exp.name}: 臂=${arm}  样本=${exp.totalCalls}`,
							contentWidth,
						),
					),
				);
			}
		}
		lines.push(emptyBoxLine());

		// 操作提示
		lines.push(
			boxLine(
				this.dim('   ↑↓ 选择  Space 启用  Enter 编辑  n 新增  r 规则  g 粒度  Esc 关闭'),
			),
		);
	}

	// ── 字段面板 ──────────────────────────────────────────────

	private renderFields(
		lines: string[],
		boxLine: (s: string) => string,
		emptyBoxLine: () => string,
		contentWidth: number,
	): void {
		const p = this.data.profiles.find((x) => x.id === this.profileId);
		if (!p) {
			lines.push(boxLine(this.red('   未找到 profile')));
			lines.push(boxLine(this.dim('   Esc 返回')));
			return;
		}

		lines.push(
			boxLine(
				truncateToWidth(`  ${this.bold(p.name)} ${this.dim(p.description)}`, contentWidth),
			),
		);
		lines.push(emptyBoxLine());

		const fields = p.fields;
		const MAX_FIELDS = 12;
		const shown = fields.slice(0, MAX_FIELDS);
		for (let i = 0; i < shown.length; i++) {
			const f = shown[i];
			const isSel = i === this.selectedIndex;
			const marker = isSel ? this.cyan('>') : ' ';
			const label = f.label + ' '.repeat(Math.max(0, 18 - visibleWidth(f.label)));
			const value = f.value ? this.dim(f.value) : '';
			const row = `${marker} ${label} ${value}`;
			lines.push(boxLine(truncateToWidth(row, contentWidth)));
		}
		if (fields.length > MAX_FIELDS) {
			lines.push(boxLine(this.dim(`  ... 共 ${fields.length} 个字段`)));
		}
		lines.push(emptyBoxLine());
		lines.push(boxLine(this.dim('   ↑↓ 选择字段  Enter 编辑  Esc 返回')));
	}
}
