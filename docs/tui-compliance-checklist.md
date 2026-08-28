# TUI 规范合规检查清单（落地版）

> **状态**：待执行。
> **检查粒度**：插件 → TUI 出口（一个插件可能有多个出口）。
> **修复策略**：全部修复，出口能统一交互的统一交互（含 `ctx.ui.select` 平台 frame 绕过）。
> **验收**：1 级 headless snapshot + 2 级 e2e 自动保障，3 级人工 UAT 由用户统一执行。

---

## 0. 范围与原则

**范围**：`extensions/` 下所有有 TUI 出口的插件（含命令、快捷键、事件处理器、`ctx.ui.*` 调用、`setWidget`/`setStatus`）。

**原则**：

1. **逐插件读代码**，不靠 grep 判定——grep 无结果 ≠ 合规（教训：pi-rate-limiter 匿名 class 标题漏网）。
2. **检查粒度 = 出口**，不按插件一刀切——一个插件可能同时有 `ctx.ui.select`（平台）和 `ctx.ui.custom`（插件自定义）。
3. **验证到实际渲染**，三层验收缺一不可（见第七步）。

---

## 1. 检查流程（每插件，按顺序）

### 第一步：TUI 出口盘点

盘出该插件所有触发 UI 的地方，每个出口记一条：

- [ ] 命令（`registerCommand` → overlay/select/input）
- [ ] 快捷键（`registerShortcut` → overlay）
- [ ] 事件处理器（`session_start`/`turn_start` → `setWidget`/`setStatus`）
- [ ] 平台内置调用（`ctx.ui.select` / `ctx.ui.input` / `ctx.ui.confirm`）
- [ ] 自定义 overlay（`ctx.ui.custom`）

> 出口数 = 后续逐条检查的记录条数。

### 第二步：视觉规范检查（每个自定义 overlay）

**边框范式**

- [ ] 顶边框 `── 英文名 ──` **嵌名**，**标题用插件英文名**（如 `── Rate Limiter ──`，不用中文名 / 不带「设置」等后缀），从第 3 格起
- [ ] 底边框纯横线
- [ ] 无方角/圆角（`┌┐└┘╭╮╰╯`）
- [ ] 无左右竖线（`│`，树形 gutter 豁免）
- [ ] 内部分隔线左右各缩进 1 格

**字符与颜色**

- [ ] 无双宽 emoji/图标（`✓✗⭐📋✅❌` 等）；单宽箭头 `↑↓←→` 仅导航提示
- [ ] 颜色先用默认（`theme.fg('text')`），状态才用 `accent/success/warning/error`；无硬编码 ANSI

**宽度安全**

- [ ] 每行 `truncateToWidth` 兜底
- [ ] 对齐/截断只用 `visibleWidth`，不用 `.length`

**状态与缓存**

- [ ] 选中状态保持（操作后不重置选中索引）
- [ ] 缓存行 `cachedLines + cachedWidth` + `invalidate()`

**布局**

- [ ] 选项解释统一放面板底部（不在每行内显示）
- [ ] 最小高度填充（防内容切换高度抖动）
- [ ] 长内容按宽度动态截断 + `Ctrl+Shift+O` 折叠展开

### 第三步：交互模式检查（每个 overlay，三轴模型）

- [ ] 入口选对：`setStatus` / `setWidget` / `custom(overlay)` / `setHeader·Footer`（慎用）
- [ ] 交互模式四选一：只读 / 导航选择 / 表单编辑 / 确认菜单
- [ ] 导航选择 → **强制 master-detail 两级**（一级列表 → 二级详情/操作）
- [ ] 一级列表**必带滚动上限**（`scrollOffset` 切片，不无限撑高）
- [ ] 反模式：无「导航+操作拍平（每项内嵌 SelectList）」

### 第四步：键盘交互

- [ ] 通用按键映射正确（`↑↓` 导航 / `Enter` 确认 / `Esc` 关闭 / `Tab` 切标签 / `/` 过滤 / `Ctrl+Shift+O` 折叠）
- [ ] 快捷键用 `registerShortcut` + `matchesKey`，前缀 `alt+插件首字母`，多功能用二级组合，不占太多键

### 第五步：wrangle 接入

- [ ] 持久化 widget/status 走 `ctx.ui.setWidget`/`setStatus`（key 唯一、在事件处理器里调、不在模块顶层）

### 第六步：结论与修复决策（每个出口）

| 结论        | 含义                       | 处理                                    |
| ----------- | -------------------------- | --------------------------------------- |
| ✅ 合规     | 全通过                     | 记录                                    |
| ⚠️ 不合规   | 插件层可修                 | 列修复点，修                            |
| 🔒 平台限制 | `ctx.ui.select` 内置 frame | **统一绕过**（见 §2.1），不留平台 frame |

### 第七步：验收（1、2 级自动，3 级人工）

- [ ] ① headless snapshot：`renderToSnapshot` + `assertWithinWidth` + `dispatchInput`（落在 `test/vitest/`）
- [ ] ② e2e 加载：`tui-expect.smoke.test.sh`（落在 `test/e2e/extensions/<name>/`，验证加载不崩、命令可触发、无方角/竖线残留）
- [ ] ③ 人工 REVIEW：`[REVIEW]` 标记，**用户统一 UAT**

---

## 2. 修复决策（全局，统一交互）

### 2.1 22 处 `ctx.ui.select` → 统一自定义 select

**目标**：所有 `ctx.ui.select` 出口统一绕过一个公共的 `selectPanel` 辅助函数，实现 `── 标题 ──` 嵌名 + 一致的键盘交互（`↑↓`/`Enter`/`Esc`/`/`）+ 滚动上限。

**实现**：在 `src/tui/helpers.ts` 新增 `selectPanel()`（`ctx.ui.custom` + `Container` + `TitleBar` + `SelectList`），接口对齐 `ctx.ui.select`（`(title, options, opts?) => Promise<string | undefined>`）。8 个插件（mode-switcher 6、custom-compaction 5、cloud-sessions 3、test-analysis 2、review 2、btw 2、commands 1、git-checkpoint 1）全部替换。

**独立 tsconfig 插件**（`_widget-wrangler`、`ci-watch`）如遇 `src/tui` 无法 import，内联等价实现，但**交互行为保持一致**。

### 2.2 标题统一英文名

所有顶边框标题用插件英文名（`── btw ──`、`── Rate Limiter ──`、`── Mode ──`），去掉中文名和后缀（「设置」「管理」等）。pi-rate-limiter 的「Rate Limiter 设置」→「Rate Limiter」。

### 2.3 交互模式统一

- 导航选择出口：统一 master-detail 两级 + `SelectList` + 滚动上限。
- 确认菜单出口：统一 `SelectList` 2-3 项 + `error` 色强调后果。
- 表单编辑出口：统一 `>` 聚焦前缀 + `theme.bg('selectedBg')` 高亮编辑态。

---

## 3. 验收标准

| 层                  | 手段                                                       | 验证内容                                  | 落地位置                               |
| ------------------- | ---------------------------------------------------------- | ----------------------------------------- | -------------------------------------- |
| ① headless snapshot | `renderToSnapshot` + `assertWithinWidth` + `dispatchInput` | 2+ 宽度不超宽、边框对齐、按键状态切换     | `test/vitest/extensions/*.tui.test.ts` |
| ② e2e 加载          | `tui-expect.smoke.test.sh`（PTY）                          | 扩展加载不崩、命令可触发、无方角/竖线残留 | `test/e2e/extensions/<name>/`          |
| ③ 人工 UAT          | `[REVIEW]` 标记                                            | 边框/颜色/交互最终视觉                    | 用户统一执行                           |

**门禁兜底**：`scripts/check-tui-compliance.ts`（emoji / 硬编码颜色 / `.length` 误用 / 方角边框）跑通即视为静态维度达标；但静态门禁**不能替代** ① ② 的渲染级验证。

---

## 4. 输出格式（每插件一份记录）

```
[插件名]
 出口1（/xxx 命令 → custom）: ✅ / ⚠️（修复点）/ 🔒（平台→已绕过）
 出口2（session_start → setStatus）: ...
 结论: 通过 / 需修复（清单）
 验收: ① headless ✅  ② e2e ✅  ③ 待人工 UAT
```

---

## 5. 检查顺序（待定，确认后填充）

按 `extensions/` 分类目录顺序逐个过：`accuracy/` → `auto/` → `context/` → `meta/` → `security/` → `tui/` → `verification/`。有 TUI 出口的插件清单见附录。

### 附录：待检查插件清单（有 TUI 出口）

<!-- 由第一步出口盘点动态生成，此处占位 -->
