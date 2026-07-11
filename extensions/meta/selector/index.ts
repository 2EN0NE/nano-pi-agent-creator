/**
 * @zenone/pi-selector — 共享选择器
 *
 * 为 Pi 扩展提供统一的选择对话框，支持：
 * - 键盘导航（↑↓）、确认（Enter）、取消（Esc）
 * - Tab 补充信息：选中选项后按 Tab，在底部一行输入额外信息给大模型
 *
 * ── 使用示例 ──
 *
 *   import { showSelect, showConfirm } from "@zenone/pi-selector";
 *
 *   // 基本选择（单选）
 *   const result = await showSelect(ctx, "选择颜色", [
 *     { value: "r", label: "红色", description: "热情、活力" },
 *     { value: "g", label: "绿色", description: "自然、平静" },
 *   ]);
 *   // result = { value: "r", label: "红色" } 或 null（Esc）
 *
 *   // 带 Tab 补充信息
 *   const result = await showSelect(ctx, "选择颜色", [
 *     { value: "r", label: "红色" },
 *     { value: "g", label: "绿色" },
 *   ]);
 *   // 选中「红色」→ 按 Tab → 底部出现一行输入框
 *   // 输入"特别强调热情感" → Enter
 *   // result = { value: "r", label: "红色", supplement: "特别强调热情感" }
 *
 *   // 允许自定义输入（allowOther）
 *   const result = await showSelect(ctx, "选择颜色", [
 *     { value: "r", label: "红色" },
 *   ], { allowOther: true });
 *   // 列表中多一行「✎ 输入补充信息...」，选中后进入补充输入
 *
 *   // 确认对话框
 *   const ok = await showConfirm(ctx, "确认删除?", "此操作不可撤销");
 *   // ok = true / false
 *
 * ── 交互方式 ──
 *
 *   选择模式（默认）：
 *     ↑↓ 导航     Enter 确认    Tab 补充输入  Esc 取消
 *
 *   补充模式（按 Tab 后）：
 *     Enter 确认提交    Esc 取消返回选择    Backspace 退格
 *     直接键入文字输入
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

// ============================================================
// 类型定义
// ============================================================

export interface SelectOption<T = string> {
	value: T;
	label: string;
	description?: string;
}

export interface SelectResult<T = string> {
	value: T;
	label: string;
	supplement?: string;
}

export interface SelectOptions {
	/** 是否允许用户输入补充信息（默认 false） */
	allowOther?: boolean;
	/** 补充信息的占位符文本 */
	otherPlaceholder?: string;
	/** 额外详细信息（在标题和选项之间显示），支持多行文本 */
	detail?: string;
}

// ============================================================
// 选择器状态
// ============================================================

interface SelectorState {
	selectedIndex: number;
	inputMode: boolean;
	inputText: string;
	detailExpanded: boolean;
}

// ============================================================
// showSelect — 选择器对话框
// ============================================================

/**
 * 显示一个可导航的选择器。支持 Tab 打开补充输入框。
 */
export async function showSelect<T = string>(
	ctx: ExtensionContext,
	title: string,
	options: SelectOption<T>[],
	opts?: SelectOptions,
): Promise<SelectResult<T> | null> {
	if (!ctx.hasUI) return null;
	if (options.length === 0) return null;

	const allowOther = opts?.allowOther ?? false;

	return ctx.ui.custom<SelectResult<T> | null>((tui, theme, _kb, done) => {
		// ---- 状态 ----
		let state: SelectorState = {
			selectedIndex: 0,
			inputMode: false,
			inputText: "",
			detailExpanded: false,
		};

		// ---- 设置 dialog 状态 ----
		_isSelecting = true;

		// ============================================================
		// 渲染函数 — 选项和补充输入框始终在同一界面
		// ============================================================
		function render(width: number): string[] {
			const lines: string[] = [];
			const add = (s: string) => lines.push(truncateToWidth(s, width));

			// ---- 顶部分隔线 ----
			add(theme.fg("accent", "─".repeat(width)));

			// ---- 标题 ----
			add(theme.fg("text", theme.bold(` ${title}`)));
			add("");

			// ---- 详细信息（detail）----
			if (opts?.detail) {
				const detailLines = opts.detail.split("\n");
				const maxCollapsed = 6;
				const isLong = detailLines.length > maxCollapsed;
				const showLines =
					state.detailExpanded || !isLong
						? detailLines
						: detailLines.slice(0, maxCollapsed);

				// 缩进显示
				for (const dl of showLines) {
					add(theme.fg("muted", ` │ ${truncateToWidth(dl, width - 4)}`));
				}
				if (isLong) {
					const hint = state.detailExpanded
						? "  ... (Ctrl+O 收起)"
						: `  ... (Ctrl+O 展开全文, 共 ${detailLines.length} 行)`;
					add(theme.fg("dim", hint));
				}
				add("");
			}

			// ---- 选项列表 ----
			for (let i = 0; i < options.length; i++) {
				const opt = options[i];
				const isSelected = i === state.selectedIndex;
				const prefix = isSelected ? theme.fg("accent", " › ") : "   ";
				const color = isSelected ? "accent" : "text";
				add(prefix + theme.fg(color, opt.label));
				if (opt.description) {
					add(
						`     ${theme.fg("muted", truncateToWidth(opt.description, width - 6))}`,
					);
				}
			}

			// ---- allowOther 选项 ----
			if (allowOther) {
				const isOther = state.selectedIndex === options.length;
				const prefix = isOther ? theme.fg("accent", " › ") : "   ";
				const color = isOther ? "accent" : "muted";
				add(prefix + theme.fg(color, "✎ 自定义输入..."));
			}

			// ---- 底部：补充输入框 或 导航提示 ----
			add(""); // 空行分隔

			if (state.inputMode) {
				// === 补充输入模式：一行输入框 ===
				const placeholder =
					opts?.otherPlaceholder ?? " 输入额外信息给大模型...";
				const isEmpty = !state.inputText;
				const cursor = isEmpty ? "" : " "; // 光标位置后跟空格
				const inputLine =
					theme.fg("dim", " ┊ ") +
					(isEmpty
						? theme.fg("dim", placeholder)
						: theme.fg("text", state.inputText + cursor));
				add(inputLine);
				add("");
				// 底部快捷键提示（浅色）
				add(theme.fg("dim", " Enter 确认  ·  Esc 取消补充"));
			} else {
				// === 选择模式：底部快捷键提示（浅色） ===
				const detailLines_len = opts?.detail
					? opts.detail.split("\n").length
					: 0;
				const isLongDetail = detailLines_len > 6;
				let hint = " ↑↓ 选择  ·  Enter 确认";
				if (isLongDetail) {
					hint += state.detailExpanded
						? "  ·  Ctrl+O 收起"
						: "  ·  Ctrl+O 展开";
				}
				hint += "  ·  Tab 补充  ·  Esc 取消";
				add(theme.fg("dim", hint));
			}

			// ---- 底部分隔线 ----
			add(theme.fg("accent", "─".repeat(width)));

			return lines;
		}

		// ============================================================
		// 输入处理
		// ============================================================
		function handleInput(data: string): void {
			const totalItems = allowOther ? options.length + 1 : options.length;

			if (state.inputMode) {
				// ---- 补充输入模式 ----
				if (matchesKey(data, Key.enter)) {
					// 提交当前选择的选项 + 补充信息
					const selIdx =
						state.selectedIndex < options.length ? state.selectedIndex : -1;
					if (selIdx >= 0) {
						const opt = options[selIdx];
						done({
							value: opt.value,
							label: opt.label,
							supplement: state.inputText.trim() || undefined,
						});
					} else {
						done({
							value: state.inputText.trim() || ("(user wrote)" as any),
							label: state.inputText.trim() || "(user wrote)",
							supplement: state.inputText.trim() || undefined,
						});
					}
				} else if (matchesKey(data, Key.escape)) {
					// 取消补充，回到选择模式
					state = { ...state, inputMode: false, inputText: "" };
					tui.requestRender();
				} else if (matchesKey(data, Key.backspace)) {
					state = { ...state, inputText: state.inputText.slice(0, -1) };
					tui.requestRender();
				} else if (data.length === 1 && data.charCodeAt(0) >= 32) {
					state = { ...state, inputText: state.inputText + data };
					tui.requestRender();
				}
				return;
			}

			// ---- 选择模式 ----

			// Tab → 进入补充输入模式
			if (matchesKey(data, Key.tab)) {
				state = { ...state, inputMode: true, inputText: "" };
				tui.requestRender();
				return;
			}

			// 导航
			if (matchesKey(data, Key.up)) {
				state = {
					...state,
					selectedIndex: Math.max(0, state.selectedIndex - 1),
				};
				tui.requestRender();
				return;
			}

			if (matchesKey(data, Key.down)) {
				state = {
					...state,
					selectedIndex: Math.min(totalItems - 1, state.selectedIndex + 1),
				};
				tui.requestRender();
				return;
			}

			// Ctrl+O 展开/收起详细信息（类似代码折叠的快捷键）
			if (matchesKey(data, Key.ctrl("o")) && opts?.detail) {
				const detailLines = opts.detail.split("\n");
				if (detailLines.length > 6) {
					state = { ...state, detailExpanded: !state.detailExpanded };
					tui.requestRender();
					return;
				}
			}

			// Enter → 确认选择
			if (matchesKey(data, Key.enter)) {
				const selIdx = state.selectedIndex;
				if (selIdx < options.length) {
					const opt = options[selIdx];
					done({ value: opt.value, label: opt.label });
				} else if (allowOther) {
					// "自定义输入" 选项：进入补充输入模式
					state = { ...state, inputMode: true, inputText: "" };
					tui.requestRender();
				}
				return;
			}

			// Esc → 取消
			if (matchesKey(data, Key.escape)) {
				done(null);
			}
		}

		// ============================================================
		// 返回组件
		// ============================================================
		return {
			render,
			invalidate() {
				/* no cache */
			},
			handleInput,
			dispose() {
				_isSelecting = false;
			},
		};
	});
}

// ============================================================
// 状态管理（模块级别，供其他扩展通过 import 访问）
// ============================================================
let _isSelecting = false;

/** 当前是否有选择对话框正在显示 */
export function isSelecting(): boolean {
	return _isSelecting;
}

// ============================================================
// showConfirm — 确认对话框
// ============================================================

/**
 * 显示一个简单的确认对话框（是/否），可配合 Tab 补充理由。
 * @param _message 作为 detail 显示在选项上方。
 */
export async function showConfirm(
	ctx: ExtensionContext,
	title: string,
	_message: string,
): Promise<boolean> {
	if (!ctx.hasUI) return false;

	const result = await showSelect(
		ctx,
		title,
		[
			{ value: false, label: "否" },
			{ value: true, label: "是" },
		],
		{ detail: _message },
	);

	return result?.value === true;
}

// ============================================================
// Pi 扩展入口 — 仅用于注册
// ============================================================
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (_pi: ExtensionAPI) {
	// 本扩展还作为 Pi 的自动发现入口，功能通过 @zenone/pi-selector 的 import 提供
}
