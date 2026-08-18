/**
 * Settings panel UI component (answer-style bordered box).
 *
 * 纯渲染 + 键盘导航组件，无 Pi 依赖（可 headless 测试）。
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
	active: boolean;
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
	profiles: ProfileView[];
	lab: { active: boolean; experiments: LabExperimentView[] };
}

export type SettingsUIAction =
	| { type: 'close' }
	| { type: 'edit-profile'; profileId: string }
	| { type: 'edit-field'; profileId: string; fieldKey: string }
	| { type: 'add-profile' };

// ── ANSI 颜色辅助（answer 同款） ───────────────────────────────

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const gray = (s: string) => `\x1b[90m${s}\x1b[0m`;

// ── 组件 ────────────────────────────────────────────────────────

export class SettingsComponent implements Component {
	private data: SettingsPanelData;
	private mode: 'main' | 'fields';
	private profileId: string | null;
	private selectedIndex: number = 0;
	private onDone: (action: SettingsUIAction) => void;

	// 渲染缓存
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		data: SettingsPanelData,
		onDone: (action: SettingsUIAction) => void,
		mode: 'main' | 'fields' = 'main',
		profileId: string | null = null,
	) {
		this.data = data;
		this.onDone = onDone;
		this.mode = mode;
		this.profileId = profileId;
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
		const boxWidth = Math.min(width - 4, 100);
		const contentWidth = boxWidth - 4;

		const horizontalLine = (count: number) => '─'.repeat(Math.max(0, count));
		const boxLine = (content: string): string => {
			// 内部兜底截断：调用方遗漏时也不会超出 box 宽度（TUI 铁律）
			const safe = truncateToWidth(content, Math.max(0, contentWidth));
			const len = visibleWidth(safe);
			const rightPad = Math.max(0, boxWidth - len - 2);
			return dim('│') + safe + ' '.repeat(rightPad) + dim('│');
		};
		const emptyBoxLine = (): string =>
			dim('│') + ' '.repeat(Math.max(0, boxWidth - 2)) + dim('│');
		const padToWidth = (line: string): string => {
			const len = visibleWidth(line);
			return line + ' '.repeat(Math.max(0, width - len));
		};

		// ── 标题（固定文案，第 0 行） ──
		// 顶边框嵌入插件名：╭── custom-compaction ───...╮
		const boxTitle = 'custom-compaction';
		const titleInner = `── ${boxTitle} `;
		// 窄终端下截断标题，保证标题行总宽 ≤ boxWidth（含 ╭╮ 边框 2 字符），
		// 避免固定长度标题在窄视口溢出（TUI 铁律：每行 truncateToWidth 兜底）
		const maxTitleInner = Math.max(0, boxWidth - 2);
		const safeTitleInner =
			titleInner.length > maxTitleInner
				? titleInner.slice(0, Math.max(2, maxTitleInner))
				: titleInner;
		lines.push(
			padToWidth(
				truncateToWidth(
					dim('╭' + safeTitleInner) +
						dim(horizontalLine(Math.max(0, boxWidth - 2 - safeTitleInner.length))) +
						dim('╮'),
					width,
				),
			),
		);
		lines.push(
			padToWidth(
				boxLine(bold(cyan(this.mode === 'main' ? ' Custom Compaction 设置' : ' 字段编辑'))),
			),
		);
		lines.push(padToWidth(dim('├' + horizontalLine(boxWidth - 2) + '┤')));

		if (this.mode === 'main') {
			this.renderMain(lines, boxLine, emptyBoxLine, contentWidth);
		} else {
			this.renderFields(lines, boxLine, emptyBoxLine, contentWidth);
		}

		lines.push(padToWidth(dim('╰' + horizontalLine(boxWidth - 2) + '╯')));
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
		lines.push(boxLine(truncateToWidth(`  ${data.modelLine}`, contentWidth)));
		lines.push(emptyBoxLine());

		// Profile 列表
		const header = gray(' [Profile 列表]');
		lines.push(boxLine(truncateToWidth(header, contentWidth)));

		const MAX_PROFILES = 6;
		const shown = data.profiles.slice(0, MAX_PROFILES);
		for (let i = 0; i < shown.length; i++) {
			const p = shown[i];
			const isSel = i === this.selectedIndex;
			const marker = isSel ? cyan('>') : ' ';
			const activeMark = p.active ? green('*') : ' ';
			const name = isSel ? bold(p.name) : p.name;
			const desc = p.description ? dim(`  ${p.description}`) : '';
			const row = `${marker} ${activeMark} ${name}${desc}`;
			lines.push(boxLine(truncateToWidth(row, contentWidth)));
		}
		if (data.profiles.length > MAX_PROFILES) {
			lines.push(boxLine(dim(`  ... 共 ${data.profiles.length} 个 profile`)));
		}
		lines.push(emptyBoxLine());

		// 实验状态区
		lines.push(boxLine(truncateToWidth(gray(' [实验状态]'), contentWidth)));
		if (!data.lab.active) {
			lines.push(boxLine(dim('   pi-lab 未接入（实验不可用）')));
		} else if (data.lab.experiments.length === 0) {
			lines.push(boxLine(dim('   实验未注册')));
		} else {
			for (const exp of data.lab.experiments) {
				const arm = exp.currentArm === '(未压缩)' ? yellow(exp.currentArm) : exp.currentArm;
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
		lines.push(boxLine(dim('   ↑↓ 选择  Enter 编辑  n 新增  Esc 关闭')));
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
			lines.push(boxLine(red('   未找到 profile')));
			lines.push(boxLine(dim('   Esc 返回')));
			return;
		}

		lines.push(
			boxLine(truncateToWidth(`  ${bold(p.name)} ${dim(p.description)}`, contentWidth)),
		);
		lines.push(emptyBoxLine());

		const fields = p.fields;
		const MAX_FIELDS = 12;
		const shown = fields.slice(0, MAX_FIELDS);
		for (let i = 0; i < shown.length; i++) {
			const f = shown[i];
			const isSel = i === this.selectedIndex;
			const marker = isSel ? cyan('>') : ' ';
			const label = f.label.padEnd(18);
			const value = f.value ? dim(f.value) : '';
			const row = `${marker} ${label} ${value}`;
			lines.push(boxLine(truncateToWidth(row, contentWidth)));
		}
		if (fields.length > MAX_FIELDS) {
			lines.push(boxLine(dim(`  ... 共 ${fields.length} 个字段`)));
		}
		lines.push(emptyBoxLine());
		lines.push(boxLine(dim('   ↑↓ 选择字段  Enter 编辑  Esc 返回')));
	}
}
