/**
 * permission-gate — 阻断确认树（ADR-0030）
 *
 * 危险命令拦截窗口：两层命令树（根 = 完整命令，叶子 = 拆解的子命令）。
 * 树节点前颜色小点提示风险（critical→红 / warning→黄 / info→强调 / 无风险→白）。
 * 放行/拒绝是整条命令的会话级语义，不改写命令；叶子详情页展示风险判断到最小粒度。
 *
 * 键位：↑↓ 导航 · ←→ 叶子详情进出 · alt+←→ 折叠 · a 添加为策略 · enter 放行 · esc 拒绝。
 */

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { parseKey, truncateToWidth } from '@earendil-works/pi-tui';
import { topBorder } from '../../../src/tui/helpers.js';
import type { DangerTier } from './config.js';
import { parseBashCommand } from './bash-parser.js';
import type { TierHit } from './tiering.js';

export interface ConfirmTreeLeaf {
	cmd: string;
	tier: DangerTier | null;
	reasons: string[];
	/** 结构化命中明细（弹窗详情逐条展示；缺失时回退 reasons 单行） */
	hits?: TierHit[];
}

export type ConfirmTreeDecision = 'allow' | 'deny';

/** 持久化层级（对齐 approval-store / manual-strategies 的 scope） */
export type StrategyScope = 'session' | 'project' | 'user';

/** 主题窄化（对齐 TwoTabPanel 的 PanelTheme 语义色子集） */
export interface ConfirmTreeTheme {
	fg: (c: string, t: string) => string;
	bold: (s: string) => string;
}

/** 危险等级 → 中文说明（详情页） */
const TIER_CN: Record<DangerTier, string> = {
	critical: 'critical（危险）',
	warning: 'warning（警告）',
	info: 'info（提示）',
};

/** 命中理由 → 中文说明（详情页） */
const REASON_CN: Record<string, string> = {
	credential: '敏感凭证',
	'system-dir-write': '系统目录写入',
	'system-dir-read': '系统目录读取',
	destructive: '破坏性命令',
	'permission-related': '权限相关',
	pattern: '匹配拦截模式',
	graduated: '已放行策略',
	manual: '手动策略',
};

/** 内置命中来源标签（口径甲：按规则层区分内置清单 vs 拦截模式） */
const BUILTIN_KIND_CN: Record<string, string> = {
	destructive: '危险命令',
	'permission-related': '权限命令',
	credential: '敏感凭证',
	'system-dir-write': '系统目录写入',
	'system-dir-read': '系统目录读取',
};

/** 命中来源标签：[内置·xx] 或 [拦截模式] */
function hitSourceLabel(hit: TierHit): string {
	if (hit.source === 'pattern') return '[拦截模式]';
	const kind = BUILTIN_KIND_CN[hit.reason] ?? REASON_CN[hit.reason] ?? hit.reason;
	return `[内置·${kind}]`;
}

/** 持久化层级 → 中文说明（级别选择子视图） */
const SCOPE_CN: Record<StrategyScope, string> = {
	session: '会话（本次对话结束失效）',
	project: '项目（当前项目持久）',
	user: '用户（全局持久）',
};

/** 颜色小点：风险等级 → theme 色名 */
export function confirmDotColor(tier: DangerTier | null): 'error' | 'warning' | 'accent' | 'text' {
	if (tier === 'critical') return 'error';
	if (tier === 'warning') return 'warning';
	if (tier === 'info') return 'accent';
	return 'text';
}

/** 危险等级短标签（纯文本单宽） */
export function confirmTierLabel(tier: DangerTier | null): string {
	if (!tier) return '';
	const short: Record<DangerTier, string> = {
		critical: 'crit',
		warning: 'warn',
		info: 'info',
	};
	return `[${short[tier]}]`;
}

/** 清理命令文本中的控制字符/换行，避免渲染错位 */
export function sanitizeCommand(s: string): string {
	return s.replace(/\r?\n/g, ' ').replace(/\t/g, ' ').trim();
}

/**
 * 阻断确认树组件（headless 可测）。
 * render(width) 返回行数组；handleInput(data) 处理键位，决策时调用 onDone。
 */
export class ConfirmTree {
	private cursor = 0;
	private collapsed = false;
	private detailLeaf = -1;
	private scopeSelect = false;
	private scopeCursor = 0;
	private scrollOffset = 0;

	private readonly leafCount: number;
	private readonly maxIndex: number;
	private readonly maxVisibleLeaves: number;
	private readonly scopeOptions: StrategyScope[];

	constructor(
		private readonly fullCommand: string,
		private readonly leaves: ConfirmTreeLeaf[],
		private readonly tui: {
			requestRender: () => void;
			terminal?: { rows?: number; columns?: number };
		},
		private readonly theme: ConfirmTreeTheme,
		private readonly onDone: (r: ConfirmTreeDecision | null) => void,
		defaultScope: StrategyScope = 'session',
		private readonly onAddStrategy?: (leaf: ConfirmTreeLeaf, scope: StrategyScope) => void,
	) {
		this.leafCount = leaves.length;
		this.maxIndex = leaves.length;
		// 叶子可视窗口：面板总高必须 ≤ 视口，否则提示行（enter 放行 / esc 拒绝）被顶出屏幕。
		// overhead = 标题(1) + 根(1) + 滚动指示(1) + 空行(1) + 提示行(1) = 5
		const rows = this.tui.terminal?.rows || 24;
		this.maxVisibleLeaves = Math.max(3, rows - 5);
		// 级别选项：默认沉淀级别置顶，再按 会话>项目>用户 补齐（默认项不重复）
		const order: StrategyScope[] = ['session', 'project', 'user'];
		this.scopeOptions = [defaultScope, ...order.filter((s) => s !== defaultScope)];
	}

	private finish(r: ConfirmTreeDecision | null): void {
		this.onDone(r);
	}

	/** 保证光标（根或当前叶子）落在可视窗口内，滚动 offset 随之调整。 */
	private ensureCursorVisible(): void {
		if (this.cursor === 0 || this.leafCount === 0) {
			this.scrollOffset = 0;
			return;
		}
		const leafIdx = this.cursor - 1;
		if (leafIdx < this.scrollOffset) {
			this.scrollOffset = leafIdx;
		} else if (leafIdx >= this.scrollOffset + this.maxVisibleLeaves) {
			this.scrollOffset = leafIdx - this.maxVisibleLeaves + 1;
		}
	}

	render(width: number): string[] {
		const th = this.theme;

		// 级别选择子视图（a 键触发）
		if (this.scopeSelect) {
			return this.renderScopeSelect(width);
		}

		const lines: string[] = [];
		const add = (s: string) => lines.push(truncateToWidth(s, width));

		add(th.fg('error', topBorder('── Permission Gate · DANGER ', width)));

		// ── 根节点 ──
		const rootPrefix = this.cursor === 0 && this.detailLeaf < 0 ? '> ' : '  ';
		add(
			truncateToWidth(rootPrefix + th.fg('accent', sanitizeCommand(this.fullCommand)), width),
		);

		// ── 叶子（展开时）──
		if (this.detailLeaf < 0) {
			if (this.collapsed) {
				add(truncateToWidth('  ' + th.fg('dim', `+ ${this.leafCount} 条子命令`), width));
			} else {
				this.ensureCursorVisible();
				const start = this.scrollOffset;
				const end = Math.min(start + this.maxVisibleLeaves, this.leafCount);
				for (let i = start; i < end; i++) {
					const leaf = this.leaves[i];
					const isLast = i === this.leafCount - 1;
					const connector = isLast ? '└─ ' : '├─ ';
					const selPrefix = this.cursor === i + 1 ? '> ' : '  ';
					const dot = th.fg(confirmDotColor(leaf.tier), '●');
					const label = confirmTierLabel(leaf.tier);
					const cmdText = sanitizeCommand(leaf.cmd);
					add(
						truncateToWidth(
							selPrefix + connector + dot + ' ' + cmdText + '  ' + label,
							width,
						),
					);
				}
				if (this.leafCount > this.maxVisibleLeaves) {
					add(th.fg('dim', `  (${start + 1}-${end}/${this.leafCount} 子命令，↑↓ 滚动)`));
				}
			}
		}

		// ── 详情页 ──
		if (this.detailLeaf >= 0) {
			const leaf = this.leaves[this.detailLeaf];
			add('');
			add('  ' + th.fg('text', th.bold('子命令详情')));
			add('  ' + th.fg('text', `命令: ${sanitizeCommand(leaf.cmd)}`));
			const tierText = leaf.tier ? TIER_CN[leaf.tier] : '无风险';
			add('  ' + th.fg(confirmDotColor(leaf.tier), `等级: ${tierText}`));

			// 命中明细：优先逐条（结构化 hits），否则回退旧扁平 reasons
			if (leaf.hits && leaf.hits.length > 0) {
				add('  ' + th.fg('text', '命中:'));
				for (const hit of leaf.hits) {
					const label = hitSourceLabel(hit);
					const explain = sanitizeCommand(hit.explain);
					add(
						'    ' +
							th.fg(confirmDotColor(hit.tier), label) +
							' ' +
							th.fg('text', explain),
					);
				}
			} else if (leaf.reasons.length > 0) {
				const reasons = leaf.reasons.map((r) => REASON_CN[r] ?? r).join(', ');
				add('  ' + th.fg('text', `命中: ${reasons}`));
			} else {
				add('  ' + th.fg('text', '命中: N/A'));
			}

			// 解析该子命令，展示工具/路径/重定向（最小粒度风险判断）
			const parsed = parseBashCommand(leaf.cmd);
			if (parsed.ok && parsed.commands.length > 0) {
				const c = parsed.commands[0];
				if (c.commandName) add('  ' + th.fg('text', `工具: ${c.commandName}`));
				if (c.pathArguments.length > 0) {
					add('  ' + th.fg('text', `路径: ${c.pathArguments.join(', ')}`));
				}
				if (c.redirects.length > 0) {
					const rd = c.redirects
						.map((r) => `${r.target}(${r.direction === 'write' ? '写' : '读'})`)
						.join(', ');
					add('  ' + th.fg('text', `重定向: ${rd}`));
				}
			}
		}

		add('');
		if (this.detailLeaf >= 0) {
			add(th.fg('dim', '  ← 返回  enter 放行  esc 拒绝'));
		} else {
			add(
				th.fg('dim', '  ↑↓ 导航  ←→ 详情  alt+←→ 折叠  a 添加为策略  enter 放行  esc 拒绝'),
			);
		}

		return lines;
	}

	handleInput(data: string): void {
		// parseKey 归一化：真实原始序列（\r、\x1b[B…）与语义字符串（enter、down…）都可用
		const key = parseKey(data) ?? data;

		// 级别选择子视图：↑↓ 选级别、enter 确认、esc 取消
		if (this.scopeSelect) {
			if (key === 'up') {
				this.scopeCursor =
					(this.scopeCursor - 1 + this.scopeOptions.length) % this.scopeOptions.length;
				this.tui.requestRender();
				return;
			}
			if (key === 'down') {
				this.scopeCursor = (this.scopeCursor + 1) % this.scopeOptions.length;
				this.tui.requestRender();
				return;
			}
			if (key === 'enter' || key === 'return') {
				const scope = this.scopeOptions[this.scopeCursor];
				const leaf = this.cursor > 0 ? this.leaves[this.cursor - 1] : this.leaves[0];
				this.scopeSelect = false;
				this.onAddStrategy?.(leaf, scope);
				this.tui.requestRender();
				return;
			}
			if (key === 'escape' || key === 'esc') {
				this.scopeSelect = false;
				this.tui.requestRender();
				return;
			}
			return;
		}

		// enter 放行 / esc 拒绝（全局，任何模式）
		if (key === 'enter' || key === 'return') {
			this.finish('allow');
			return;
		}
		if (key === 'escape' || key === 'esc') {
			this.finish('deny');
			return;
		}

		// 详情模式：←→ 退出详情
		if (this.detailLeaf >= 0) {
			if (key === 'left' || key === 'right') {
				this.detailLeaf = -1;
				this.tui.requestRender();
			}
			return;
		}

		// a：叶子添加为策略（需 onAddStrategy 回调）
		if (key === 'a' && this.cursor > 0 && !this.collapsed && this.onAddStrategy) {
			this.scopeSelect = true;
			this.scopeCursor = 0;
			this.tui.requestRender();
			return;
		}

		// alt+←→ 折叠/展开
		if (key === 'alt+left') {
			this.collapsed = true;
			if (this.cursor > 0) this.cursor = 0;
			this.tui.requestRender();
			return;
		}
		if (key === 'alt+right') {
			this.collapsed = false;
			this.tui.requestRender();
			return;
		}

		// →：叶子详情进入
		if (key === 'right') {
			if (this.cursor > 0 && !this.collapsed) {
				this.detailLeaf = this.cursor - 1;
				this.tui.requestRender();
			}
			return;
		}

		// ↑↓ 导航（展开时）
		if (key === 'up' || key === 'down') {
			if (this.collapsed || this.leafCount === 0) return;
			const dir = key === 'up' ? -1 : 1;
			this.cursor = (this.cursor + dir + (this.maxIndex + 1)) % (this.maxIndex + 1);
			this.tui.requestRender();
			return;
		}
	}

	/** 级别选择子视图渲染 */
	private renderScopeSelect(width: number): string[] {
		const th = this.theme;
		const lines: string[] = [];
		const add = (s: string) => lines.push(truncateToWidth(s, width));

		add(th.fg('accent', topBorder('── Permission Gate · 添加为策略 ', width)));
		const leaf = this.cursor > 0 ? this.leaves[this.cursor - 1] : this.leaves[0];
		add(truncateToWidth('  ' + th.fg('text', `命令: ${sanitizeCommand(leaf.cmd)}`), width));
		add('');
		add('  ' + th.fg('text', th.bold('选择持久化层级：')));
		for (let i = 0; i < this.scopeOptions.length; i++) {
			const scope = this.scopeOptions[i];
			const isSel = i === this.scopeCursor;
			const prefix = isSel ? '> ' : '  ';
			const label = SCOPE_CN[scope];
			add(
				truncateToWidth(
					prefix + (isSel ? th.fg('accent', label) : th.fg('text', label)),
					width,
				),
			);
		}
		add('');
		add(th.fg('dim', '  ↑↓ 选择  enter 确认  esc 取消'));
		return lines;
	}
}

/**
 * 展示阻断确认树，等待用户放行/拒绝整条命令。
 * 返回 null 表示被外部通道先确认（AbortController 触发）。
 */
export async function showConfirmTree(
	ctx: ExtensionContext,
	fullCommand: string,
	leaves: ConfirmTreeLeaf[],
	opts?: {
		signal?: AbortSignal;
		defaultScope?: StrategyScope;
		onAddStrategy?: (leaf: ConfirmTreeLeaf, scope: StrategyScope) => void;
	},
): Promise<ConfirmTreeDecision | null> {
	if (!ctx.hasUI) return null;

	return ctx.ui.custom<ConfirmTreeDecision | null>((tui, theme, _kb, done) => {
		let settled = false;
		const finish = (r: ConfirmTreeDecision | null) => {
			if (settled) return;
			settled = true;
			done(r);
		};
		const onAbort = () => finish(null);
		if (opts?.signal) {
			if (opts.signal.aborted) onAbort();
			else opts.signal.addEventListener('abort', onAbort, { once: true });
		}

		// SAFETY: ctx.ui.custom 的 theme 是 pi-tui 完整 Theme，此处窄化为语义色子集
		// ConfirmTreeTheme（Theme 的 fg/bold 是 ConfirmTreeTheme 的超集），无运行时转换。
		const th = theme as unknown as ConfirmTreeTheme;
		const component = new ConfirmTree(
			fullCommand,
			leaves,
			tui,
			th,
			finish,
			opts?.defaultScope,
			opts?.onAddStrategy,
		);

		return {
			render: (w: number) => component.render(w),
			invalidate: () => {},
			handleInput: (data: string) => component.handleInput(data),
		};
	});
}
