/**
 * 快捷面板 — 按下前缀键后弹出的 TUI 面板，列出所有已注册快捷键及说明。
 *
 * 交互：按子键（可多级）触发对应 handler 并关闭；Esc/Enter 关闭；
 * 条目超过一屏时 Tab 向后翻页、Shift+Tab 向前翻页（高度自适应终端）。
 * 遵守 docs/tui-design-principles.md：无 emoji、上下边框（无左右竖线）、
 * 每行 truncateToWidth 兜底。列表项为「prefixKey keys — 说明」参考卡片，
 * description 是主要内容（单行截断），非选择器故不适用「解释放底部」规则。
 */

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Container, Spacer, Text, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { parseKey } from '@earendil-works/pi-tui';
import { groupByPlugin, type ShortcutRegistry, type ShortcutEntry } from '../core/registry.js';

export function showPalette(
	ctx: ExtensionContext,
	registry: ShortcutRegistry,
	prefixKey: string,
): Promise<void> {
	return ctx.ui.custom<void>((tui, theme, _kb, done) => {
		const container = new Container();
		const pressed: string[] = [];

		const dim = (s: string) => theme.fg('dim', s);
		const accent = (s: string) => theme.fg('accent', s);
		const muted = (s: string) => theme.fg('muted', s);

		let width = 80;
		let needsFirstRebuild = true;
		let currentPage = 0;

		/** pressed 是 entry.keys 的严格前缀 → 该 entry 当前被激活（高亮）。 */
		function isActive(entryKeys: string[]): boolean {
			return entryKeys.every((k, i) => pressed[i] === k);
		}

		// ── 高度自适应分页 ──────────────────────────────
		// 面板固定开销（不含条目行）：顶边框(1) + divider(1) + spacer(1) + footer(1) + 底边框(1) = 5。
		// 参考 pi-session-tree 的 pageSize = rows - 8（overhead 7 + 1 余量）：
		// 面板总高必须 ≤ 终端视口高度，否则滚动时触发 fullRender → 重影。
		// palette 开销更小，留 1 行余量 → pageSize = rows - 6。
		const FIXED_OVERHEAD = 6;

		function pageSize(): number {
			return Math.max(3, (tui.terminal.rows || 24) - FIXED_OVERHEAD);
		}

		function totalPages(): number {
			return Math.max(1, Math.ceil(registry.getEntries().length / pageSize()));
		}

		function clampPage(): void {
			const total = totalPages();
			if (currentPage < 0) currentPage = 0;
			if (currentPage >= total) currentPage = total - 1;
		}

		function currentEntries() {
			const start = currentPage * pageSize();
			return registry.getEntries().slice(start, start + pageSize());
		}

		// ── 边框（无左右竖线）──

		function renderTopBorder(): void {
			const topName = ' 扩展快捷键 ';
			const topFill = Math.max(0, width - 2 - 2 - visibleWidth(topName));
			container.addChild(
				new Text(
					accent('\u250c\u2500\u2500') +
						dim(topName) +
						accent('\u2500'.repeat(topFill) + '\u2510'),
					0,
					0,
				),
			);
		}

		function renderDivider(): void {
			container.addChild(
				new Text(accent(' ' + '\u2500'.repeat(Math.max(0, width - 2)) + ' '), 0, 0),
			);
		}

		function renderBottomBorder(): void {
			container.addChild(
				new Text(
					accent('\u2514' + '\u2500'.repeat(Math.max(0, width - 2)) + '\u2518'),
					0,
					0,
				),
			);
		}

		function renderItem(
			entry: ShortcutEntry,
			active: boolean,
			isFirst: boolean,
			isLast: boolean,
		): string {
			const prefixWidth = visibleWidth(prefixKey) + 1; // "alt+. " 宽度（含空格）
			let label: string;
			if (isFirst) {
				label = `${prefixKey} ${entry.keys.join(' ')} — ${entry.description}`;
			} else {
				// 后续同插件功能：用竖线串在第一级子键位置（│ 延续，└ 结束）
				const branch = isLast ? '└' : '│';
				const indent = ' '.repeat(prefixWidth);
				const restKeys = entry.keys.slice(1).join(' ');
				label = `${indent}${branch} ${restKeys} — ${entry.description}`;
			}
			const line = active ? `  > ${label}` : `    ${label}`;
			return truncateToWidth(active ? accent(line) : muted(line), width);
		}

		function renderFooter(): string {
			const total = totalPages();
			if (total <= 1) {
				return truncateToWidth(dim('  按子键触发 · Esc 关闭'), width);
			}
			const nav = `  第 ${currentPage + 1}/${total} 页 · Tab 向后 · Shift+Tab 向前 · Enter/Esc 关闭`;
			return truncateToWidth(dim(nav), width);
		}

		function rebuild(): void {
			container.clear();
			renderTopBorder();

			const entries = registry.getEntries();
			if (entries.length === 0) {
				container.addChild(new Text(dim('  暂无注册的扩展快捷键'), 0, 0));
			} else {
				clampPage();
				const groups = groupByPlugin(currentEntries());
				for (const group of groups) {
					for (let j = 0; j < group.entries.length; j++) {
						const entry = group.entries[j];
						container.addChild(
							new Text(
								renderItem(
									entry,
									isActive(entry.keys),
									j === 0,
									j === group.entries.length - 1,
								),
								0,
								0,
							),
						);
					}
				}
			}

			renderDivider();
			container.addChild(new Spacer(1));
			container.addChild(new Text(renderFooter(), 0, 0));

			renderBottomBorder();
		}

		function handleInput(data: string): void {
			const key = (parseKey(data) ?? '').toLowerCase();
			if (!key) return;

			// 关闭：Esc / Ctrl+C / Enter
			if (key === 'escape' || key === 'ctrl+c' || key === 'enter') {
				done(undefined);
				return;
			}

			// 分页导航（仅多页时生效）
			const total = totalPages();
			if (total > 1) {
				if (key === 'tab') {
					currentPage = (currentPage + 1) % total;
					rebuild();
					tui.requestRender();
					return;
				}
				if (key === 'shift+tab') {
					currentPage = (currentPage - 1 + total) % total;
					rebuild();
					tui.requestRender();
					return;
				}
			}

			pressed.push(key);
			const result = registry.match(pressed);

			if (result.status === 'exact') {
				const handler: (ctx: any) => void | Promise<void> = result.entry.handler;
				void handler(ctx);
				done(undefined);
			} else if (result.status === 'none') {
				done(undefined);
			}
			// prefix：还有子键未按，保持面板并高亮
			rebuild();
			tui.requestRender();
		}

		return {
			render(w: number): string[] {
				width = w;
				if (needsFirstRebuild) {
					needsFirstRebuild = false;
					rebuild();
				}
				return container.render(w);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput,
		};
	});
}
