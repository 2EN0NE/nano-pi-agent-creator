# TUI 交互模式规范

本文档是 `docs/tui-design-principles.md`（视觉/布局规范）的姊妹篇，回答一个它没回答的问题：**面对一个 UI 任务，开发者该把界面设计成什么结构？**

> 目录
>
> 1. [三轴模型](#1-三轴模型)
> 2. [轴 A：入口（UI 挂载位置）](#2-轴-a入口ui-挂载位置)
> 3. [轴 B：交互模式（交互规范）](#3-轴-b交互模式交互规范)
> 4. [轴 C：实现策略（渲染方式）](#4-轴-c实现策略渲染方式)
> 5. [决策表](#5-决策表)
> 6. [反模式清单](#6-反模式清单)
> 7. [新 UI 任务的检查清单](#7-新-ui-任务的检查清单)

---

## 1. 三轴模型

TUI 设计按**三个正交维度**组织，取代「按场景一维分类」：

```
轴 A 入口（UI 挂在哪）      轴 B 交互模式（交互规范）    轴 C 实现策略（代码结构）
├─ setStatus    状态栏单行   ├─ 只读展示                ├─ 手绘字符串
├─ setWidget    常驻面板     ├─ 导航选择（列表/树/多选） ├─ 组件化(Container)
├─ custom       覆盖层       ├─ 表单编辑（字段/验证）
└─ setHeader/Footer 替换    └─ 确认菜单（一次性选择）
```

**关键澄清**：「custom 手绘」和「Focusable 组件」不是同一层级的对比，这是常见误解：

| 概念          | 层级         | 说明                                                                                   |
| ------------- | ------------ | -------------------------------------------------------------------------------------- |
| `custom()`    | 轴 A（入口） | 所有覆盖层都走这个入口，`overlay: true/false` 决定浮层还是主视图                       |
| `Focusable`   | 横切能力     | 仅 `focused: boolean` + 输出 `CURSOR_MARKER` 定位硬件光标（IME）。手绘和组件化都能选加 |
| 手绘 / 组件化 | 轴 C（实现） | 真正的渲染方式分叉                                                                     |

**先选入口，再定交互模式，最后选实现策略**——三者正交，顺序不能乱。

---

## 2. 轴 A：入口（UI 挂载位置）

入口决定 UI 的**生命周期和显示位置**，是硬边界，必须分开。

```ts
// 状态栏单行文本，setStatus(key, text | undefined)
ctx.ui.setStatus('my-plugin', 'syncing'); // → | my-plugin: syncing

// 常驻面板（编辑器上/下），接受字符串数组 或 返回 Component 的工厂
ctx.ui.setWidget('my-widget', (tui, theme) => new MyWidgetComponent(/* ... */));

// 覆盖层（带焦点），overlay: true 浮层 / false 主视图
await ctx.ui.custom<T>(
	(tui, theme, keybindings, done) => {
		// 返回 Component（手绘或组件化），调用 done(result) 关闭
		return new MyPanel(/* ... */);
	},
	{ overlay: true },
);

// 替换内置 header/footer（很少用，慎用）
ctx.ui.setFooter((tui, theme, footerData) => new MyFooter(/* ... */));
```

| 入口                | 生命周期         | 适用                                   | 交互强度           |
| ------------------- | ---------------- | -------------------------------------- | ------------------ |
| `setStatus`         | 常驻             | 单行状态指示                           | 无                 |
| `setWidget`         | 常驻             | 持续可见的小面板（进度、待办、资源树） | 低（可聚焦，可选） |
| `custom`（overlay） | 临时（Esc 关闭） | 列表选择、配置、确认、详情             | 高（必聚焦）       |
| `setHeader/Footer`  | 常驻（替换内置） | 极少用，非必要不碰                     | 视情况             |

---

## 3. 轴 B：交互模式（交互规范）

这是现有代码最缺的一环——过去 UI 只求「能用不出错」，没考虑过交互该长什么样。四种交互模式各有约定：

### 3.1 只读展示

无焦点交互，纯信息展示。用于统计详情、结果面板。

- 键盘：仅 `Esc` 关闭
- 内容过长用 `Ctrl+Shift+O` 折叠（见 `tui-design-principles.md` §6.2）
- 参考：pi-lab 统计详情视图

### 3.2 导航选择 【强制 master-detail】

**强制两级导航**：一级列表（选中 → 二级详情/操作）。**一级列表必带滚动上限**。

- 键盘：`↑↓` 移动 · `Enter` 进入二级 · `Esc` 返回/关闭 · `/` 过滤
- 一级列表：每项**一行**，最多一个 `SelectList`，用滚动视口限制高度
- 二级：该选中项的详情或操作（Tab 切换操作类别）

**滚动视口约定**：列表项数 × 行高 > 终端高度时，必须用 `scrollOffset` 切片渲染可视窗口，而非让 overlay 无限撑高。参考 `extensions/meta/pi-session-tree/ui/panel.ts`。

**反例（pi-lab 面板，真实缺陷）**：把「选实验」和「选操作」拍平——每实验内嵌一个 3 项 SelectList，导致：

1. 高度随实验数线性膨胀（N × 6 行）
2. 焦点管理失效（`activeSelectListIndex` 恒 0，`Tab` 被标签切换占用，后面的实验永远选不到）

正确结构是：一级只列实验（每实验一行），`Enter` 进入二级（统计/设置/重置 用 Tab 切换）。

### 3.3 表单编辑

字段级聚焦、编辑、验证。用于配置面板。

- 键盘：`↑↓` 切字段 · `Enter` 进入编辑 · `Esc` 取消 · `Tab` 切字段
- 字段聚焦用 `>` 前缀，编辑态用 `theme.bg('selectedBg', ...)` 高亮
- 参考：`extensions/auto/cloud-sessions/src/index.ts`

### 3.4 确认菜单

一次性选择（确认/取消），用于危险操作。

- 键盘：`↑↓` 切换 · `Enter` 确认 · `Esc` 取消
- 确认项用 `theme.fg('error', ...)` 强调后果
- 参考：todos 的 delete-confirm、pi-lab 的 reset-confirm

---

## 4. 轴 C：实现策略（渲染方式）

两种渲染方式都能实现任意交互模式，选择取决于**布局复杂度**：

| 策略   | 写法                                              | diff 渲染            | 适用                            |
| ------ | ------------------------------------------------- | -------------------- | ------------------------------- |
| 组件化 | `Container` + `SelectList`/`Text`/`DynamicBorder` | 有（Container 管理） | 规则列表、选择器、Tab 面板      |
| 手绘   | `render(width): string[]` 拼字符串                | 无（全量重绘）       | 不规则/复杂布局（问答、多区域） |

**选择拐点**：

- 能用 `SelectList` 表达的选择 → **组件化**（省事，diff 渲染，焦点自动管理）
- 布局不规则、多区域嵌套、需要精确控制每行 → **手绘**（answer.ts 的 QnA 布局）
- **无论哪种**：每行 `truncateToWidth` 兜底、对齐只用 `visibleWidth`（见 `tui-design-principles.md` §1/§7.5）

**Focusable 何时加**：只有当组件内需要**硬件光标定位**（输入框、IME 候选框）时才实现 `focused: boolean` + 输出 `CURSOR_MARKER`。纯选择/展示组件不需要。

---

## 5. 决策表

| 入口             | 交互模式    | 推荐实现                      | 参考                            |
| ---------------- | ----------- | ----------------------------- | ------------------------------- |
| `setStatus`      | 只读        | 字符串                        | permission-gate `gate:on(3[5])` |
| `setWidget`      | 只读/低交互 | 组件化                        | catch-the-fox、todos widget     |
| `custom` overlay | 导航选择    | 组件化 + master-detail + 滚动 | pi-session-tree、files/ui.ts    |
| `custom` overlay | 表单编辑    | 手绘 或 Editor 组件           | cloud-sessions                  |
| `custom` overlay | 确认菜单    | 组件化（SelectList 2-3 项）   | todos delete-confirm            |
| `custom` overlay | 复杂布局    | 手绘                          | answer.ts QnA、btw.ts           |

---

## 6. 反模式清单

| 反模式                                 | 后果                | 正确做法                |
| -------------------------------------- | ------------------- | ----------------------- |
| 导航 + 操作拍平（每项内嵌 SelectList） | 高度膨胀 + 焦点失效 | master-detail 两级      |
| 列表无滚动上限                         | 数据多时撑爆终端    | `scrollOffset` 滚动视口 |
| 硬编码颜色（`\x1b[36m`）               | 主题失效、维护难    | `theme.fg/accent/...`   |
| emoji/图标（`❌⚙✓`）                   | 宽度错位、崩溃      | 纯文本 `OK/BLOCK`       |
| 对齐用 `.length`                       | 中文/宽字符错位     | `visibleWidth`          |
| 缺 `truncateToWidth`                   | 超宽崩溃            | 每行包裹                |

> 注：answer.ts（硬编码 `\x1b[36m`）、btw.ts（`❌`）是历史遗留违规，**不可作为模板**，仅参考其布局思路。

---

## 7. 新 UI 任务的检查清单

按顺序对号入座，每步有明确答案后再动手：

1. **入口**：这是状态栏（setStatus）？常驻面板（setWidget）？还是临时覆盖层（custom）？
2. **交互模式**：只读 / 导航选择 / 表单编辑 / 确认菜单，四选一。
3. **导航选择** → 是否 master-detail 两级？一级列表是否带滚动上限？
4. **实现策略**：规则选择 → 组件化；不规则复杂布局 → 手绘。
5. **视觉规范**：无 emoji、theme 颜色、每行 `truncateToWidth`、对齐 `visibleWidth`（见 `tui-design-principles.md`）。
6. **测试**：headless snapshot 2+ 宽度 + 按键状态切换（见 `tui-headless-testing.md`）。

---

相关文档：

- 视觉/布局规范：`docs/tui-design-principles.md`
- headless 测试：`docs/tui-headless-testing.md`
- 分类决策：`docs/adr/0020-tui-interaction-model.md`
