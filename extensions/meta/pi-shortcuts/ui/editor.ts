/**
 * 快捷键编辑面板 — /shortcuts 的可编辑视图。
 *
 * 两个 Tab（Tab 键切换）：
 *   - 全局：前缀键等固定设置
 *   - 快捷键：动态插件快捷键列表（改子键）
 * 交互（列表态）：↑↓ 导航（快捷键 Tab）· Enter 编辑选中项 · l 切换作用域 · Esc 退出
 *   Ctrl+Shift+O 折叠/展开选中项描述
 * 交互（编辑态）：文本输入新键（空格分隔），Enter 确认（冲突校验），Esc 取消。
 * 改子键立即生效（registry.setRemap）+ 持久化；改前缀键持久化后提示重启生效。
 *
 * 遵守 docs/tui-design-principles.md：
 *   - 无 emoji、上下边框（pi-lab 风格 ┌── 标题 ──┐ / └──┘，无左右竖线）
 *   - Tab 导航（Tab 键切换，当前标签 bold+accent 高亮）
 *   - 选项解释统一放底部（description 不进行内）
 *   - 颜色用主题色（accent/dim/muted/warning），默认 text
 *   - 每行 truncateToWidth 兜底 + 最小高度填充防抖动
 */

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
	Container,
	Spacer,
	Text,
	Input,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from '@earendil-works/pi-tui';
import type { ConfigStore } from '@zenone/pi-config';
import {
	groupByPlugin,
	type ShortcutRegistry,
	type RemapRule,
	type ShortcutEntry,
} from '../core/registry.js';
import type { ShortcutsConfig } from '../config.js';

type EditorMode = 'list' | 'edit-key' | 'edit-prefix';
type SaveScope = 'user' | 'project';
type EditorTab = 'global' | 'shortcuts';

export function showEditor(
	ctx: ExtensionContext,
	registry: ShortcutRegistry,
	configStore: ConfigStore<ShortcutsConfig>,
	onChanged: () => void,
): Promise<void> {
	return ctx.ui.custom<void>((tui, theme, _kb, done) => {
		const container = new Container();

		let mode: EditorMode = 'list';
		let currentTab: EditorTab = 'global';
		let selectedIndex = 0; // 快捷键 Tab 里 entries 的索引
		let scope: SaveScope = 'user';
		let message = '';
		let input: Input | null = null;
		let expanded = false; // Ctrl+Shift+O 折叠/展开描述
		let width = 80; // fallback，首次 render 被真实宽度覆盖
		let needsFirstRebuild = true;

		const dim = (s: string) => theme.fg('dim', s);
		const accent = (s: string) => theme.fg('accent', s);
		const muted = (s: string) => theme.fg('muted', s);
		const bold = (s: string) => theme.bold(s);

		function currentConfig(): ShortcutsConfig {
			return configStore.get();
		}

		/** 把「name 插件 from 默认子键」改到 to；to 等于 from 时删除规则（恢复默认）。 */
		function updateRemap(
			remap: RemapRule[],
			name: string,
			from: string[],
			to: string[],
		): RemapRule[] {
			const idx = remap.findIndex(
				(r) => r.name === name && r.from.join('+') === from.join('+'),
			);
			if (to.join('+') === from.join('+')) {
				return remap.filter((_, i) => i !== idx); // 恢复默认
			}
			if (idx >= 0) {
				const next = [...remap];
				next[idx] = { name, from, to };
				return next;
			}
			return [...remap, { name, from, to }];
		}

		function parseKeys(text: string): string[] {
			return text
				.trim()
				.split(/\s+/)
				.filter(Boolean)
				.map((k) => k.toLowerCase());
		}

		// ── 边框（pi-lab 风格：无左右竖线）──

		function renderTopBorder(title: string): void {
			const topName = ` ${title} `;
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

		// ── Tab 栏（Tab 键切换，当前 bold+accent）──

		function renderTabBar(): void {
			const tabs: { key: EditorTab; label: string }[] = [
				{ key: 'global', label: '全局' },
				{ key: 'shortcuts', label: '快捷键' },
			];
			const parts = tabs.map((tab) => {
				const isActive = currentTab === tab.key;
				return isActive ? accent(bold(`  ${tab.label}  `)) : dim(`  ${tab.label}  `);
			});
			container.addChild(new Text(parts.join(''), 0, 0));
		}

		/** 底部解释区：默认折叠，超宽截断，Ctrl+Shift+O 展开。 */
		function renderDescription(text: string): string {
			const indent = '  ';
			const contentWidth = Math.max(1, width - 4);
			if (!expanded && visibleWidth(text) > contentWidth) {
				const maxFold = Math.max(1, contentWidth - 3); // 留 '...'
				let truncated = '';
				let tw = 0;
				for (const ch of text) {
					const cw = visibleWidth(ch);
					if (tw + cw > maxFold) break;
					truncated += ch;
					tw += cw;
				}
				return dim(`${indent}${truncated}... (Ctrl+Shift+O 展开)`);
			}
			return dim(`${indent}${truncateToWidth(text, contentWidth)}`);
		}

		// ── 全局 Tab：前缀键（固定设置）──

		function buildGlobal(): void {
			const cfg = currentConfig();
			container.addChild(
				new Text(accent(`  > 前缀键  ${cfg.prefixKey || '(已禁用)'}`), 0, 0),
			);
			container.addChild(new Text(dim(`  作用域: ${scope}`), 0, 0));
		}

		// ── 快捷键 Tab：动态插件快捷键列表 ──

		function computeNameColWidth(entries: ShortcutEntry[]): number {
			let maxW = 0;
			for (const entry of entries) {
				maxW = Math.max(maxW, visibleWidth(entry.name));
			}
			return maxW + 2; // +2 容纳 "> " 光标
		}

		function computeKeysColWidth(entries: ShortcutEntry[]): number {
			let maxW = 0;
			for (const entry of entries) {
				maxW = Math.max(maxW, visibleWidth(entry.keys.join(' ')));
			}
			return maxW;
		}

		function renderEntry(
			entry: ShortcutEntry,
			index: number,
			nameColWidth: number,
			keysColWidth: number,
			isFirst: boolean,
			isLast: boolean,
		): string {
			const isSelected = index === selectedIndex;
			const cursor = isSelected ? '> ' : '  ';
			// 插件名只显示在第一行；后续同插件功能用竖线串起来（│ 延续，└ 结束）
			let nameContent: string;
			if (isFirst) nameContent = entry.name;
			else if (isLast) nameContent = '└';
			else nameContent = '│';
			const nameCol = cursor + nameContent;
			const namePad = ' '.repeat(Math.max(0, nameColWidth - visibleWidth(nameCol)));
			const keysCol = entry.keys.join(' ');
			const keysPad = ' '.repeat(Math.max(0, keysColWidth - visibleWidth(keysCol)));
			const desc = entry.description || '';
			if (isSelected) {
				return truncateToWidth(
					accent(`  ${nameCol}${namePad}  ${keysCol}${keysPad}  ${desc}`),
					width,
				);
			}
			return truncateToWidth(
				`  ${dim(nameCol)}${namePad}  ${muted(keysCol)}${keysPad}  ${muted(desc)}`,
				width,
			);
		}

		function buildShortcuts(): void {
			const entries = registry.getEntries();
			if (entries.length === 0) {
				container.addChild(new Text(dim('  暂无注册的扩展快捷键'), 0, 0));
				return;
			}
			const nameColWidth = computeNameColWidth(entries);
			const keysColWidth = computeKeysColWidth(entries);
			const groups = groupByPlugin(entries);
			let index = 0;
			for (const group of groups) {
				for (let j = 0; j < group.entries.length; j++) {
					const isFirst = j === 0;
					const isLast = j === group.entries.length - 1;
					container.addChild(
						new Text(
							renderEntry(
								group.entries[j],
								index,
								nameColWidth,
								keysColWidth,
								isFirst,
								isLast,
							),
							0,
							0,
						),
					);
					index++;
				}
			}
		}

		// ── 列表态底部（解释区 + message + 帮助栏）──

		function buildListFooter(): void {
			if (currentTab === 'global') {
				container.addChild(
					new Text(renderDescription('前缀键：按此前缀后输入子键触发功能'), 0, 0),
				);
			} else {
				const entries = registry.getEntries();
				const selected = entries[selectedIndex];
				container.addChild(
					new Text(
						renderDescription(selected ? selected.description : '暂无注册的扩展快捷键'),
						0,
						0,
					),
				);
			}
			container.addChild(new Spacer(1));

			if (message) {
				container.addChild(
					new Text(theme.fg('warning', truncateToWidth(`  ${message}`, width)), 0, 0),
				);
				container.addChild(new Spacer(1));
			}

			const help =
				currentTab === 'global'
					? '  Enter 编辑前缀键 · l 作用域 · Tab 切标签 · Esc 退出'
					: '  ↑↓ 导航 · Enter 编辑 · l 作用域 · Tab 切标签 · Esc 退出';
			container.addChild(new Text(dim(help), 0, 0));
		}

		// ── 编辑视图 ──

		function buildEdit(): void {
			const isPrefix = mode === 'edit-prefix';
			const cfg = currentConfig();
			const target = isPrefix
				? `前缀键（当前: ${cfg.prefixKey || '(已禁用)'}）`
				: (() => {
						const entry = registry.getEntries()[selectedIndex];
						return entry ? `${entry.name} [${entry.keys.join(' ')}]` : '';
					})();

			container.addChild(new Text(dim(`  ${target}`), 0, 0));
			container.addChild(new Spacer(1));
			container.addChild(new Text(dim('  输入新键（空格分隔，如 x o）'), 0, 0));
			container.addChild(input!);
			container.addChild(new Spacer(1));

			if (message) {
				container.addChild(
					new Text(theme.fg('warning', truncateToWidth(`  ${message}`, width)), 0, 0),
				);
				container.addChild(new Spacer(1));
			}

			container.addChild(new Text(dim('  Enter 确认 · Esc 取消'), 0, 0));
		}

		function rebuild(): void {
			container.clear();
			if (mode === 'list') {
				renderTopBorder('快捷键设置');
				renderTabBar();
				renderDivider();
				if (currentTab === 'global') buildGlobal();
				else buildShortcuts();
				renderDivider();
				buildListFooter();
				renderBottomBorder();
			} else {
				renderTopBorder(mode === 'edit-prefix' ? '改前缀键' : '改子键');
				buildEdit();
				renderBottomBorder();
			}
		}

		// ── 编辑回调 ──

		function confirmEditKey(value: string): void {
			const to = parseKeys(value);
			if (to.length === 0) {
				message = '键不能为空，重试';
				return;
			}
			const rawEntry = registry.getRawEntries()[selectedIndex];
			if (!rawEntry) {
				message = '选中项已失效';
				mode = 'list';
				input = null;
				rebuild();
				tui.requestRender();
				return;
			}
			const cfg = currentConfig();
			const newRemap = updateRemap(cfg.remap, rawEntry.name, rawEntry.keys, to);
			const result = registry.setRemap(newRemap); // 校验冲突
			if (!result.ok) {
				message = `冲突：与 ${result.conflict?.name} ${result.conflict?.keys.join(' ')} 冲突`;
				return; // 保持编辑模式，让用户重试
			}
			const ok = configStore.save({ ...cfg, remap: newRemap }, scope);
			message = ok ? `已保存到 ${scope} 层` : '保存失败';
			mode = 'list';
			input = null;
			expanded = false;
			onChanged();
			rebuild();
			tui.requestRender();
		}

		function confirmEditPrefix(value: string): void {
			const key = value.trim();
			if (!key) {
				message = '前缀键不能为空，重试';
				return;
			}
			const cfg = currentConfig();
			const ok = configStore.save({ ...cfg, prefixKey: key }, scope);
			message = ok ? `前缀键已保存到 ${scope} 层（重启生效）` : '保存失败';
			mode = 'list';
			input = null;
			expanded = false;
			onChanged();
			rebuild();
			tui.requestRender();
		}

		function startEditKey(): void {
			const entry = registry.getEntries()[selectedIndex];
			if (!entry) return;
			mode = 'edit-key';
			message = '';
			input = new Input();
			input.setValue(entry.keys.join(' '));
			input.onSubmit = confirmEditKey;
			input.onEscape = () => {
				mode = 'list';
				input = null;
				message = '';
				rebuild();
				tui.requestRender();
			};
			rebuild();
			tui.requestRender();
		}

		function startEditPrefix(): void {
			mode = 'edit-prefix';
			message = '';
			input = new Input();
			input.setValue(currentConfig().prefixKey);
			input.onSubmit = confirmEditPrefix;
			input.onEscape = () => {
				mode = 'list';
				input = null;
				message = '';
				rebuild();
				tui.requestRender();
			};
			rebuild();
			tui.requestRender();
		}

		// ── 输入处理 ──

		function handleInput(data: string): void {
			// 编辑态：委派给 Input（Enter→onSubmit，Esc→onEscape）
			if (mode !== 'list') {
				input?.handleInput(data);
				return;
			}

			// Tab → 切换 全局/快捷键 标签
			if (data === '\t') {
				currentTab = currentTab === 'global' ? 'shortcuts' : 'global';
				selectedIndex = 0;
				expanded = false;
				rebuild();
				tui.requestRender();
				return;
			}

			if (matchesKey(data, Key.escape) || data === '\x1b' || data === 'q') {
				done(undefined);
				return;
			}

			if (data === 'l') {
				scope = scope === 'user' ? 'project' : 'user';
				message = '';
				rebuild();
				tui.requestRender();
				return;
			}

			if (currentTab === 'global') {
				if (matchesKey(data, Key.enter)) {
					startEditPrefix();
				}
				return;
			}

			// 快捷键 Tab
			if (matchesKey(data, Key.up) || data === '\x1b[A') {
				const n = registry.getEntries().length;
				selectedIndex = n === 0 ? 0 : (selectedIndex - 1 + n) % n;
				expanded = false; // 切换焦点自动折叠
				rebuild();
				tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.down) || data === '\x1b[B') {
				const n = registry.getEntries().length;
				selectedIndex = n === 0 ? 0 : (selectedIndex + 1) % n;
				expanded = false;
				rebuild();
				tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.enter)) {
				startEditKey();
				return;
			}
			if (matchesKey(data, Key.ctrlShift('o'))) {
				expanded = !expanded;
				rebuild();
				tui.requestRender();
				return;
			}
		}

		// ── 最小高度：防列表/编辑切换时面板高度抖动 ──
		const MIN_TOTAL_LINES = 12;

		return {
			render(w: number): string[] {
				width = w;
				if (needsFirstRebuild) {
					needsFirstRebuild = false;
					rebuild();
				}
				const rendered = container.render(w);
				if (rendered.length >= MIN_TOTAL_LINES) return rendered;
				// 复制后追加透明空行，避免污染 Container 内部缓存
				const lines = [...rendered];
				for (let i = lines.length; i < MIN_TOTAL_LINES; i++) {
					lines.push('');
				}
				return lines;
			},
			invalidate() {
				container.invalidate();
			},
			handleInput,
		};
	});
}
