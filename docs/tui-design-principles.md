<!-- markdownlint-disable MD010 MD007 --><!-- 项目 prettier useTabs:true + 列表缩进约定，与 markdownlint 默认冲突；禁用 no-hard-tabs / ul-indent -->

# Pi 扩展 TUI 设计规范

本文档系统梳理了 nano-pi-agent-creator 仓库中现有 TUI 扩展的 UI 设计模式与最佳实践，供后续 TUI 开发参考。

> 目录
>
> 1. [核心原则](#1-核心原则)
> 2. [状态栏 Widget 设计](#2-状态栏-widget-设计)
> 3. [交互覆盖层面板设计](#3-交互覆盖层面板设计)
> 4. [列表与选择器](#4-列表与选择器)
> 5. [颜色使用规范](#5-颜色使用规范)
> 6. [键盘交互规范](#6-键盘交互规范)
> 7. [边框与布局](#7-边框与布局)
> 8. [TUI 集成测试](#8-tui-集成测试)
> 9. [参考实现](#9-参考实现)

---

## 1. 核心原则

1. **字符白名单** — 禁止双宽 emoji/图标（✓✗⭐📋☑☐✎⚙❌ 等，宽度随终端变化），改用纯文本标记（`OK`/`FAIL`/`[x]`/`[ ]`/`>`）。单宽箭头（`↑↓←→`）仅用于键盘导航提示时允许，宽度恒为 1 无崩溃风险。详见 ADR-0023。
2. **颜色先用默认** — 显示默认为普通色（`theme.fg('text', ...)`），仅在需要用户关注的特殊状态才切换为主题色（`warn`、`error`、`success`、`accent`）。禁止硬编码颜色（如 `\x1b[31m` 红色）。
3. **纯横线边框** — 所有 TUI 覆盖层用上下纯横线边框（顶边框 `── 插件名 ──...`、底边框纯横线），废除方角（`┌┐└┘`）、圆角（`╭╮╰╯`）与左右竖线（`│`）。用 `theme.fg('accent', ...)` 或 `theme.fg('borderMuted', ...)` 着色。详见 ADR-0023。
4. **`truncateToWidth` 安全网** — 每个 `render()` 返回的每一行都必须用 `truncateToWidth(line, width)` 包裹，防止溢出终端宽度。
5. **选中状态保持** — 用户操作后不要重置选中索引回第一项；删除/过滤等变更后，应将选中索引调整为合法值（`selectedIndex = Math.max(0, Math.min(selectedIndex, list.length - 1))`）。
6. **缓存行** — 用 `cachedLines` + `cachedWidth` 缓存渲染结果，减少重复计算。通过 `invalidate()` 清除缓存。
7. **必须接入 wrangle** — 所有持久化 widget/status 必须通过 `ctx.ui.setWidget()` 或 `ctx.ui.setStatus()` 设置，确保自动接入 widget-wrangler 管理体系。详见 [2.3 Widget 管理](#23-widget-管理)。

---

## 2. 状态栏 Widget 设计

### 2.1 格式约定

使用 `ctx.ui.setStatus(key, text)` 注册状态栏 widget，格式为：

```
| plugin_prefix:status_text
```

- **前缀用插件英文缩写**，例如 `gate`（permission-gate）、`sessions`（cloud-sessions）
- 前缀后接冒号和状态文本
- 状态变化时更新，无状态时传 `undefined` 清除

### 2.2 参考实现

**permission-gate**（`index.ts:updateWidgetStatus`）：

- Widget key: `'permission-gate'`
- 格式: `| gate:on(3[5])` / `| gate:off` / `| gate:on Dynamic(2)`
- 状态变化时通过 `ctx.ui.setStatus()` 更新
- 无 widget 需求时置空字符串

**cloud-sessions**（现有实现）：

- Widget key: `'cloud-sessions'`（在扩展中作为常量 `STATUS_KEY`）
- 格式: `| sessions: syncing (git)` / `| sessions: git up to date` / `| sessions: not configured`

**sandbox**（`index.ts:session_start`）：

- Widget key: `'sandbox'`
- 格式: `|sandbox: N domains, M write paths`

### 2.3 Widget 管理（widget-wrangler）

通过 [widget-wrangler](../extensions/meta/_widget-wrangler/) 统一管理所有 widget 和 status 的显示/隐藏，支持快捷键 `ctrl+shift+g` 打开管理面板。

**工作原理：**

- widget-wrangler 劫持共享的 `ctx.ui.setWidget()` 和 `ctx.ui.setStatus()` 方法
- 所有通过这两个 API 调用的 widget/status 自动注册到 wrangle 管理面板
- 用户在 `/wrangle` 面板中可逐个切换显示/隐藏，选择会全局持久化
- 通过 `ctx.ui.custom()` 创建的交互式覆盖层不在 wrangle 管理范围内（正常设计）

**接入要求（所有带 UI 的扩展必须遵守）：**

1. **持久化 widget 使用 `ctx.ui.setWidget(key, content)`** — 传入唯一 key（如扩展名）和渲染函数
2. **状态栏文本使用 `ctx.ui.setStatus(key, text)`** — key 应为扩展专属（避免与其他扩展冲突）
3. **禁止绕过 API** — 不允许直接操作 TUI 内部对象来渲染持久化 UI
4. **不在模块工厂中调用** — `setWidget`/`setStatus` 必须在事件处理器中调用（`session_start`、`turn_start` 等），不能放在扩展模块工厂函数的顶层执行
5. **key 命名约定** — widget key 使用扩展名或功能名（如 `'catch-the-fox'`、`'review'`），status key 同样使用扩展前缀（如 `'permission-gate'`、`'pi-logger'`）

**动态 widget 的特殊处理：**

- 在 `session_start` 中首次设置 widget 后，应在后续事件（如 `turn_end`、`agent_start`）中重新设置以更新内容
- widget-wrangler 通过这些重新设置维持对 widget 的跟踪
- 如果 widget 只设置一次且永不更新，需确保 wrangle 的补丁已在设置前安装（当前通过 `_widget-wrangler` 目录名确保最先加载）

**检查清单（新增 UI 插件时）：**

- [ ] 所有持久化 UI 是否都通过 `ctx.ui.setWidget()` / `ctx.ui.setStatus()` 设置？
- [ ] Widget/Status key 是否唯一（不会与其他扩展冲突）？
- [ ] 是否在事件处理器中调用（而非模块顶层）？
- [ ] 在 `/wrangle` 面板中能否看到该 widget/status？
- [ ] 通过 `/wrangle` 切换显示/隐藏是否生效？

---

## 3. 交互覆盖层面板设计

### 3.1 面板结构

每个 TUI 覆盖层面板遵循以下结构：

```
── Title ────────────────────────
    Tab 1 [Tab 2]                 ← Tab 导航（如有）
 ─────────────────────────────
    > option 1                    ← 选中项用 > 前缀
      option 2
 ─────────────────────────────
    Help text and shortcuts       ← 底部操作提示
────────────────────────────────
```

### 3.2 选项解释统一放在面板底部

**选项的解释文字（hint/description）统一放在面板下方**，不要在每个选项行内显示。

**反模式（避免）❌：**

```
── Panel ───────────────────────────
    > option 1                        ← 每行不同高度，render 需要逐行计算
       This is a long description
      option 2                        ← 选中切换时行数变化，面板高度抖动
       Another description
────────────────────────────────────
```

**正确做法 ✅：**

```
── Panel ───────────────────────────
    > option 1                        ← 所有选项行高一致，render 稳定
      option 2
      [ Save ]  [ Cancel ]
 ──────────────────────────────────
    Description: This is a long ...   ← 底部统一解释区域
    ↑↓ navigate · Enter select
────────────────────────────────────
```

理由：

- 每行高度一致，`render()` 可预先计算总行数，无需逐行重新布局
- 选中切换时面板高度稳定，不抖动
- 纯横线边框无需右侧对齐计算，消除了「右边框错位」整类 bug

### 3.3 长内容处理：动态宽度与折叠

所有 TUI 面板中涉及长文本显示的地方，必须：

1. **获取当前面板宽度**：`render(width)` 中的 `width` 参数即是当前可用宽度
2. **按宽度重新计算截断或换行**：每帧渲染时根据 `width` 值重新计算显示内容
3. **折叠展开统一用 `Ctrl+Shift+O`**：长内容默认折叠，按 `Ctrl+Shift+O` 展开/收起

```typescript
// ✅ 正确：每帧根据 width 重新计算显示长度
function render(width: number): string[] {
	const contentWidth = width - 4; // 减去边框占位
	let display: string;
	if (visibleWidth(longText) > contentWidth) {
		// 按宽度逐字截断，保证不超
		let truncated = '';
		let tw = 0;
		for (const ch of longText) {
			const cw = visibleWidth(ch);
			if (tw + cw >= contentWidth - 1) break;
			truncated += ch;
			tw += cw;
		}
		display = truncated + '...';
	} else {
		display = longText;
	}
}
```

**不要** 在渲染外部预计算固定宽度——每次 `render()` 调用时 `width` 都可能变化（终端 resize 等）。

### 3.4 参考实现：permission-gate TwoTabPanel

**[`two-tab-panel.ts`](../extensions/security/permission-gate/two-tab-panel.ts)** — Strategies & History 双 Tab 面板。

关键设计：

- **Tab 切换**：用 `Tab` 键切换标签，当前标签用 `th.bold()` 高亮
- **选中标记**：`>` 前缀标记当前选中行（用 `theme.fg('accent', ...)`）
- **过滤**：按 `/` 进入过滤模式，按 `Esc` / `Backspace` 退出
- **展开详情**：`Ctrl+Shift+O` 展开/收起选中项的详细信息
- **删除**：在 Strategies Tab 按 `x` 删除策略
- **滚动**：`selectedIndex` 循环导航（到末尾回到开头）
- **最小高度填充**：保证 overlay 不会因内容行数变化而高度不稳
- **状态保持**：删除操作后重新计算选中索引防止越界

### 3.5 参考实现：files/ui.ts — Action Selector

**[`ui.ts`](../extensions/tui/files/ui.ts)** — 使用 `Container` + `TitleBar`(顶边框) + `SelectList` 构建 TUI（底边框用 `DynamicBorder` 纯横线）。

关键模式：

```typescript
const container = new Container();
container.addChild(
 new TitleBar('Choose action', (str) => theme.fg('accent', theme.bold(str))),
);

const selectList = new SelectList(items, items.length, { ...theme... });
selectList.onSelect = (item) => done(item.value);
selectList.onCancel = () => done(null);

return { render, invalidate, handleInput };
```

### 3.6 参考实现：cloud-sessions 配置面板（新）

**[`cloud-sessions/src/index.ts`](../extensions/auto/cloud-sessions/src/index.ts)** — 表单式配置面板。

关键模式：

- 使用 `ctx.ui.custom()` 直接构建
- 字段聚焦用 `>` 前缀
- 编辑状态用 `theme.bg('selectedBg', display)` 高亮输入区
- `↑↓` 导航、`Enter` 编辑/切换、`Esc` 返回/取消

---

## 4. 列表与选择器

### 4.1 选中状态保持原则

**关键要求：列表选项控制完后，不要忘记选项状态**（避免改变选项状态后选择项跳回第一项）。

```typescript
// 删除后调整选中索引
if (this.selectedIndex >= this.currentList.length) {
	this.selectedIndex = Math.max(0, this.currentList.length - 1);
}
```

### 4.2 SelectList 使用

Pi TUI 内置 `SelectList` 组件（pi-tui 包），支持：

- 模糊搜索 (`enableSearch: true`)
- 上下导航
- 选中回调

主题接口：

```typescript
{
    selectedPrefix: (text) => theme.fg('accent', text),
    selectedText: (text) => theme.fg('accent', text),
    description: (text) => theme.fg('muted', text),
    scrollInfo: (text) => theme.fg('dim', text),
    noMatch: (text) => theme.fg('warning', text),
}
```

---

## 5. 颜色使用规范

### 5.1 默认色

- 普通文本：`theme.fg('text', ...)`
- 次要/禁用：`theme.fg('dim', ...)` / `theme.fg('muted', ...)`
- 边框/分割线：`theme.fg('borderMuted', ...)`

### 5.2 状态色（仅在需要用户关注时使用）

- 强调/选中：`theme.fg('accent', ...)` / `theme.bg('selectedBg', ...)`
- 成功：`theme.fg('success', ...)`
- 警告：`theme.fg('warning', ...)`（仅当达到/超过阈值等需关注的情况）
- 错误：`theme.fg('error', ...)`
- 标题：`theme.bold(...)` + `theme.fg('accent', ...)`

### 5.3 禁止

- ❌ 禁止硬编码颜色（如 `\x1b[31m` 或直接 `'red'`）
- ❌ 禁止自定义 `foreground`/`background` 色值
- ❌ 禁止使用 emoji 着色（因其宽度不确定）

---

## 6. 键盘交互规范

### 6.1 通用按键

| 按键           | 功能                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------- |
| `↑` / `↓`      | 上下导航选项                                                                                      |
| `Enter`        | 确认/选中/进入编辑                                                                                |
| `Esc`          | 取消/关闭/返回                                                                                    |
| `Tab`          | 切换标签页（面板中）                                                                              |
| `/`            | 进入过滤模式                                                                                      |
| `Ctrl+Shift+O` | **通用：折叠/展开长文本内容。** 所有 TUI 面板中的长文字、详细信息，统一使用此快捷键控制展开与收起 |
| `Backspace`    | 过滤时删除字符 / 编辑时退格                                                                       |

### 6.2 `Ctrl+Shift+O` 折叠展开规范

所有 TUI 面板中涉及**长文本详情展示**的地方，统一使用 `Ctrl+Shift+O` 控制折叠/展开：

```typescript
if (matchesKey(data, Key.ctrlShift('o'))) {
	this.expanded = !this.expanded;
	this.invalidate();
	tui.requestRender();
	return;
}
```

- 默认状态为**折叠**（只显示摘要或标题）
- 按 `Ctrl+Shift+O` 切换为**展开**（显示完整详情）
- 再按一次恢复折叠
- 切换焦点到其他项时**自动折叠**（`this.expanded = false`）

### 6.3 快捷键绑定

使用 `pi.registerShortcut(key, handler)` 注册全局快捷键，不使用硬编码键值。

推荐快捷键前缀：`alt+<插件首字母>`（如 `alt+s` → sessions）。

按键检测使用 `matchesKey(data, Key.xxx)` 而非原始字符比较，以支持跨平台键绑定一致性。

---

## 7. 边框与布局

### 7.1 边框图案（纯横线范式，ADR-0023）

所有 TUI 覆盖层统一为**上下纯横线边框**，废除方角（`┌┐└┘`）、圆角（`╭╮╰╯`）与左右竖线（`│`）：

```
── 插件名 ──────────────────   顶边框：`── ` + 插件名 + ` ` + 横线填满（名字从第 3 格起）
    > 选中项                    内容（无左右竖线）
      普通项
 ───────────────────────────   内部分隔线：左右各缩进 1 格
    ↑↓ navigate · Enter         footer
────────────────────────────   底边框：纯横线填满
```

代码模式：

```ts
topBorder = '── ' + 插件名 + ' ' + '─'.repeat(填满);
separator = ' ' + '─'.repeat(填满 - 2) + ' '; // 左右各缩进 1 格，与顶边框形成层次
bottomBorder = '─'.repeat(填满);
```

**理由**：去掉竖线 = 去掉 `rightPad` 对齐计算 = 消除一整类「右边框错位」bug；去掉角 = 方角/圆角之争自然消失；内部分隔线缩进 1 格使「面板边界」与「内容分隔」视觉可区分（纯横线若不缩进会与顶/底边框糊在一起）。

**竖线保留例外**：树形 gutter 竖线（如 pi-session-tree 树节点缩进的 `│`）是树结构本体，**保留**；只改「边框盒」的竖线，不改「树形缩进」的竖线。SelectList 等 pi-tui 内置组件内部的竖线由组件管理，不在此列。

### 7.2 顶边框：TitleBar（标题嵌入边框）

Container 型面板的顶边框用 `TitleBar`（`src/tui/helpers.ts`），把标题嵌入顶边框 `── 标题 ──...`，替代旧范式「`DynamicBorder`(纯横线) + `Text`(独立标题)」：

```typescript
import { TitleBar } from '../src/tui/helpers.js';
container.addChild(
	new TitleBar('Permission Gate Control Panel', (s) => theme.fg('accent', theme.bold(s))),
);
```

**底边框/分隔线**仍可用 Pi 内置 `DynamicBorder`（渲染纯横线，符合 ADR-0023 底边框范式），或用 `bottomBorder(width)` 返回纯横线字符串。顶边框一律嵌名（`TitleBar` 或 `topBorder`），不得再用「纯横线 + 独立标题」旧范式。

### 7.3 最小高度填充

在 overlay render 中，填充到最小高度行数，防止切换内容时 overlay 高度变化导致渲染溢出：

```typescript
const MIN_TOTAL_LINES = 21; // header + maxVisible + scroll + footer
const padCount = Math.max(0, MIN_TOTAL_LINES - lines.length);
for (let i = 0; i < padCount; i++) {
	lines.push(''); // 透明填充行
}
```

### 7.4 公共 TUI 辅助模块（建议参考，非强制）

项目提供 `src/tui/helpers.ts` 供 TUI 面板**参考**，包含：

| 导出                              | 用途                                                    |
| --------------------------------- | ------------------------------------------------------- |
| `colLayout(opts)`                 | 两列布局描述（列宽计算 + 行渲染）                       |
| `divider(width, fn)`              | accent 色全宽分隔线                                     |
| `dimDivider(width, fn)`           | dim 色全宽分隔线                                        |
| `checkAlignment(lines, sep, tol)` | 离线对齐检测（测试用）                                  |
| `makeThemeColors(theme)`          | 7 个语义色包装器（dim/bold/cyan/green/yellow/red/gray） |
| `TitleBar` (class)                | 标题边框组件（Container 子组件，标题嵌入顶边框）        |
| `topBorder(title, width)`         | 左对齐标题横线（`── name ──...`）                       |
| `bottomBorder(width)`             | 纯横线（底边框/分隔线通用）                             |

`makeThemeColors`、`topBorder`、`bottomBorder` 是纯横线迁移后从多处重复提取的共享接线：

- **`makeThemeColors(theme)`** — 语义色映射（`dim→dim`、`cyan→accent`、`green→success`、`yellow→warning`、`red→error`、`gray→muted`）收敛到一处。`answer.ts` 的 `QnAComponent` 与 `settings-ui.ts` 的 `SettingsComponent` 构造函数用 `Object.assign(this, makeThemeColors(theme))` 注入。
- **`topBorder(title, width)`** — 左对齐标题横线（`title + '─'.repeat(width - visibleWidth(title))`），含超宽截断 + 下界保护。answer/btw/quit/settings-ui 的顶边框统一走此函数。
- **`bottomBorder(width)`** — 纯横线（`'─'.repeat(Math.max(0, width))`）。底边框、分隔线、无名字顶边框通用。

> 三者均以 `visibleWidth` 计算宽度，禁止混用 `.length`（含宽字符会错位）。

详细 API 文档与使用示例见 [`docs/tui-helpers.md`](tui-helpers.md)。

> ⚠️ **本模块为「建议参考」，非强制。** 使用前需评估：
>
> - `colLayout` 已改用 `visibleWidth` 补空格（`padVisible`），支持含 ANSI 转义的左列对齐。
> - `colLayout` 的默认分隔符已改为纯文本 `' │ '`（ADR-0023 后不再硬编码 ANSI）。
> - `divider` / `dimDivider` 实现相同，颜色完全由传入的 `fn` 决定，名字仅作语义提示。
>
> 面板若左列带主题色或需要严格对齐，优先自行用 `visibleWidth` 实现，不必强行套用本模块。

### 7.5 纯横线面板的内容行写法

纯横线范式（§7.1）下，内容行没有左右竖线、没有 rightPad 对齐计算，唯一要保证的是**不超宽**。核心技巧：

**1. 内容行统一走 `row()` 辅助函数** —— 缩进 + `truncateToWidth` 兜底：

```typescript
const row = (content: string): string => indent + truncateToWidth(content, W);
```

**2. 长文本先 `wrapTextWithAnsi` 换行再 `row()`** —— 从根上保证不超宽：

```typescript
const wrapped = wrapTextWithAnsi(questionText, contentWidth);
for (const line of wrapped) lines.push(row(line));
```

**3. 嵌套子组件输出加 `truncateToWidth` 兜底** —— 子组件 `render()` 某行超宽时截断，不顶穿：

```typescript
const editorLines = editor.render(contentWidth).map((l) => truncateToWidth(l, W));
```

**4. 每行宽度口径只用 `visibleWidth`** —— 对齐/截断计算禁止混用 `.length`（含宽字符会错位）。

**适用场景：** 所有纯横线覆盖层（answer、quit、btw、custom-compaction、pi-lab、pi-shortcuts、todos 等均已迁移）。

**特殊场景：**

1. **左右分栏 / 两端对齐**（如 `session-breakdown.ts` 的 `left + 空格 + right`）：需要 justify 型算法，分别算左右可见宽度、中间补空格。
2. **多列表格**（如 `quit.ts` 的 modelUsage 表）：需要 column 布局，用 `visibleWidth` 算列宽。
3. **滚动 / 视口裁剪**：滚动窗自行做高度裁剪（`scrollOffset` 切片），每行仍需 `truncateToWidth` 兜底。
4. **内容含 tab / emoji / 组合字符**：`visibleWidth` 可能少算，须额外 `truncateToWidth` 兜底（见第 1 章字符白名单）。

---

## 8. TUI 集成测试

### 8.1 测试框架

使用 `test/e2e/scripts/run-e2e.sh` 的 `--tui` 模式，通过 PTY（`script` 命令）捕获 TUI 输出。

### 8.2 测试文件命名

```
test/e2e/extensions/<name>/tui-expect.smoke.test.sh
```

### 8.3 测试 API

在 `test/e2e/helpers/tui-functions.sh` 中定义：

```bash
# 启动测试
tui_run_pi_test "<ext_list>" "<input>" <timeout_seconds>

# 断言
tui_assert_contains "keyword" "description"
tui_assert_matches "pattern" "description"
tui_assert_exit_code <code>

# 清理
tui_cleanup

# 标记需要人工审查
mark_for_review "检查 xxx 渲染"
```

### 8.4 测试示例

参考 [`test/e2e/extensions/permission-gate/tui-expect.smoke.test.sh`](../test/e2e/extensions/permission-gate/tui-expect.smoke.test.sh)：

- 验证扩展加载（不 crash）
- 验证 widget 内容出现
- 验证启动资源列表
- 验证日志被正确捕获
- 对 overlay 渲染内容使用 `[REVIEW]` 标记人工检查

### 8.5 注意事项

- TUI overlay 内容（控制面板、策略面板等）通过 PTY 捕获的 stream 无法可靠提取（overlay 使用光标定位绘制），因此只验证：
    - 扩展加载信号（启动输出中出现）
    - 状态栏 widget（视口快照中出现）
    - 日志文件（pi-logger 捕获）
- 灰度 `[REVIEW]` 需要手动验证 overlay 渲染效果
- **避免触发 LLM 调用**（不要发 `hi`/`hello`），直接发命令即可

### 8.6 边框与超宽测试要点

纯横线范式（§7.1）下，TUI 测试重点从「右侧竖线对齐」转为「不超宽 + 边框结构正确」。常见问题：

1. **ANSI 转义序列宽度污染**：`theme.fg()` 生成的 ANSI 序列本身不可见，但 `String.length` 会计入。必须使用 `visibleWidth()` 而非 `String.length` 计算字符宽度。
2. **动态内容变化导致超宽**：展开详情、切换标签、内容截断等操作后，行内容宽度变化可能超视口。测试应验证展开前后每行不超宽。
3. **选中/非选中行不同着色**：不同颜色标记（`theme.fg('accent', ...)` vs `theme.fg('dim', ...)`）的 ANSI 序列长度不同，宽度计算必须基于**纯文本宽度**。

**测试工具：** headless snapshot（`renderToSnapshot` + `assertWithinWidth`，见 ADR-0023 三层验收）做机器断言；`[REVIEW]` 标记做人工视觉确认。

**测试验证方法：**

```bash
# headless：2+ 宽度下渲染不超宽（vitest）
assertWithinWidth(lines, 80);

# e2e：验证无方角/竖线残留 + [REVIEW] 人工确认纯横线边框
test_it "renders pure-horizontal borders [REVIEW]" <<'TEST'
  tui_run_pi_test "my-ext" "/command" 15
  local temp_file="$TUI_TEST_HOME/stripped.txt"
  strip_ansi < "$TUI_OUTPUT_FILE" > "$temp_file"
  if ! grep -q '┌\|┐\|└\|┘\|│' "$temp_file"; then echo "PASS: no box corners/bars"; fi
  tui_cleanup
  mark_for_review "检查纯横线边框（── 插件名 / 分隔线缩进 1 格）是否完整"
TEST
```

> 边框视觉的精确保证需手动 `[REVIEW]`，PTY 捕获可能因终端宽度模拟不完全精确。

### 8.7 长内容与动态宽度测试

测试**长内容截断**和**展开/收起**场景时必须验证：

- 默认折叠状态下不超视口宽度
- `Ctrl+Shift+O` 展开后不超视口宽度
- 再次折叠回到折叠状态后不超视口宽度
- 面板宽度变化（终端 resize）后重新计算正确

```bash
test_it "long content truncation and expand [REVIEW]" <<'TEST'
  tui_run_pi_test "my-ext" "/command" 15
  tui_assert_contains "..." "Long content should show truncation indicator"
  tui_cleanup
  mark_for_review "Ctrl+Shift+O 展开不超框，再按恢复折叠"
TEST
```

---

## 9. 参考实现

| 文件                                                   | 类型              | 核心模式                                                  |
| ------------------------------------------------------ | ----------------- | --------------------------------------------------------- |
| `extensions/security/permission-gate/two-tab-panel.ts` | 双 Tab 覆盖层面板 | 边框、Tab 导航、过滤、展开详情、删除操作、选中保持        |
| `extensions/security/permission-gate/index.ts`         | Widget + 命令入口 | 状态栏 widget、命令注册、TUI overlay 入口                 |
| `extensions/tui/files/ui.ts`                           | 选择器面板        | Container + TitleBar + SelectList 组件化                  |
| `extensions/meta/_widget-wrangler/src/index.ts`        | Widget 管理       | 劫持 setWidget/setStatus 实现 toggle                      |
| `extensions/tui/quit.ts`                               | 简单 TUI          | 基础命令注册                                              |
| `extensions/auto/cloud-sessions/src/index.ts`          | 表单配置面板      | ctx.ui.custom() 表单编辑、字段聚焦、输入验证              |
| `extensions/tui/btw.ts`                                | 侧边会话覆盖层    | 自定义 Focusable Container 组件                           |
| `src/tui/helpers.ts`                                   | 公共工具          | TitleBar / topBorder / bottomBorder / colLayout / divider |
| `docs/tui-helpers.md`                                  | 文档              | 公共 TUI 辅助模块 API 说明与示例                          |
