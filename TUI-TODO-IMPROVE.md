# TUI 规范改进 TODO

> 生成时间：2026-08-17 · 扫描范围：`extensions/` 下 49 个含 UI 的 `.ts` 文件
> 规范依据：[`docs/tui-interaction-patterns.md`](docs/tui-interaction-patterns.md)、[`docs/tui-design-principles.md`](docs/tui-design-principles.md)、[`docs/adr/0020-tui-interaction-model.md`](docs/adr/0020-tui-interaction-model.md)

## 豁免说明（非违规）

| 文件                                                                            | 内容        | 豁免理由                                             |
| ------------------------------------------------------------------------------- | ----------- | ---------------------------------------------------- |
| `meta/pi-logger/appenders/console-appender.ts`                                  | ANSI 颜色码 | 日志基础设施，非 TUI 组件渲染                        |
| `auto/pi-tmux-status/index.ts`                                                  | 🟢🟡🔴      | tmux status bar 内容，非 Pi TUI 渲染（需确认）       |
| `meta/pi-logger/lifecycle-capture.ts`、`accuracy/todos/tool-registration.ts` 等 | ✓✗⚠         | 日志/工具描述文本，非 TUI render（建议统一，非强制） |

---

## P0 — 硬编码颜色（违反「禁止硬编码颜色」§5.3）

> 一律改用 `theme.fg/bg('accent'|'success'|'warning'|'error'|'dim'|'muted'|...)`。

- [ ] **`tui/answer.ts`** — `cyan/green/yellow` 私有方法 + `selectedBg` 硬编码 `\x1b[36m/32m/33m/44m`（L211-216, L229）。此文件被文档引为对齐标杆，须优先修，否则新手照抄会传播违规。
- [ ] **`tui/quit.ts`** — `ansiFg`（256 色 `\x1b[38;5;..m`）+ `ansiBold`（L319-320）。
- [ ] **`tui/session-breakdown.ts`** — RGB ANSI `\x1b[48;2/38;2` + dim/bold（L278-290）。
- [ ] **`context/custom-compaction/settings-ui.ts`** — 6 种硬编码色（cyan/green/yellow/red/bright-black，L67-73）。
- [ ] **`auto/pi-rate-limiter/index.ts`** — `green/yellow/red` 硬编码 ANSI（L182-185，需确认是否 TUI render）。
- [ ] **`auto/control/index.ts`** — `theme.fg()` 内嵌 `\x1b[1m...\x1b[22m` bold（L598），应拆为 `theme.bold()`。

## P0 — Emoji/图标（违反「无 Emoji/图标」铁律）

> 纯文本替代：`OK/BLOCK` 代 ✅❌、`>` 代选中、`[x]`/`[ ]` 代 ☑☐、`[Stats]` 代 📋。

- [ ] **`meta/prompt-editor.ts`**（最严重）— `📋📎📄🔧📏🎯📅`（L300-306）+ `✓✗`（L337）+ `▶`（L339）。
- [ ] **`tui/btw.ts`** — `⚙✗✓❌`（L409, L467）。
- [ ] **`tui/files/ui.ts`** — 复选框 `☑☐`（L33），改用 `[x]`/`[ ]`。
- [ ] **`tui/questionnaire.ts`** — `✓✎`（L206-814）+ `■□`（L642）。
- [ ] **`auto/control/index.ts`** — `✗✓`（L1563-1653）。
- [ ] **`meta/selector/index.ts`** — `✎`（L32, L210）。
- [ ] **`meta/skills.ts`** — `⚙⚠` + `●○`（L150-295）。
- [ ] **`security/permission-gate/index.ts`** — `⚠✓`（L400-472）。
- [ ] **`tui/session-tree-label/index.ts`** — `✓`（L157）。
- [ ] **`meta/pi-session-tree/ui/panel.ts`** — 选中标记 `●`（L725, L731）。
- [ ] **`tui/answer.ts`** — `●○`（L413-417）。

## P0 — 选中标记用 `→`（应改 `>`）

> 规范：`>` 表示选中，`→` 属 Unicode 图标。

- [ ] **`meta/pi-session-tree/ui/panel.ts`** — `→` 选中标记（L49, L692）。
- [ ] **`meta/pi-shortcuts/core/dispatcher.ts`** — `→`（L5）。

## P0 — 交互结构：导航+操作拍平（强制 master-detail）

- [ ] **`meta/pi-lab/ui/panel.ts`** — 21 个 `SelectList`（= 每实验内嵌「统计/设置/重置」3 项 × 7 实验），导航与操作拍平。**重构为 master-detail 两级导航**：一级只列实验（每实验一行，1 个 SelectList + 滚动上限），`Enter` 进入二级（统计/设置/重置 用 Tab 切换）。同时修复焦点 bug（`activeSelectListIndex` 恒 0）。

## P1 — 列表缺滚动上限

> 规范：列表项数 × 行高 > 终端高度时，必须 `scrollOffset` 切片渲染。

- [ ] **`tui/files/ui.ts`** — 7 个 SelectList，文件选择列表无滚动上限，文件多时撑高。
- [ ] **`meta/pi-lab/ui/panel.ts`** — 与上条重构一并加滚动上限（参考 `pi-session-tree/ui/panel.ts` 的 `scrollOffset`）。

## P1 — 健壮性复核（truncateToWidth / visibleWidth）

> 手绘 `render()` 每行须 `truncateToWidth` 兜底；对齐只用 `visibleWidth`。以下为「手绘 render 但 truncateToWidth 为 0」的疑似缺口，需逐文件复核：

- [ ] **`auto/control/index.ts`**（1929L，trunc=0，需复核 render 各行）
- [ ] **`meta/preset.ts`**（502L，trunc=0）
- [ ] **`meta/skills.ts`**（404L，trunc=2，偏低）
- [ ] **`meta/tools.ts`**（481L，trunc=0）
- [ ] **`auto/notify.ts`**（107L，trunc=0）
- [ ] **`context/resources-tree/header.ts`**（59L，trunc=0）
- [ ] **`tui/DEMO:catch-the-fox/src/fox-widget.ts`** — `.length` 参与对齐计算（LENALIGN，需改 `visibleWidth`）

## P2 — 非 TUI 文本建议统一（低优先）

> 非强制：notify() 消息、工具描述、日志中的 ⚠✓✗ 建议也改为纯文本，避免跨环境字体缺字显示方块。

- [ ] `auto/cloud-sessions/src/project-match.ts`（⚠）、`context/custom-compaction/`（⚠×3）、`security/permission-gate/records.ts`（⚠）、`meta/pi-lab/core/definition-diff.ts`（✅）、`meta/pi-lab/core/manager.ts`（✓）

---

## 建议执行顺序

1. **P0 硬编码颜色 + Emoji**（纯机械替换，风险低，先清干净）
2. **P0 选中标记 → → `>`**（同上）
3. **P0 pi-lab master-detail 重构**（唯一结构性改动，需配 headless snapshot 测试）
4. **P1 滚动上限**（files/ui.ts）
5. **P1 健壮性复核**（逐个确认后补 `truncateToWidth`）
6. **P2 非 TUI 文本**（顺手清）

> 注：每一项落地后均需过 headless snapshot 测试（见 `docs/tui-headless-testing.md`），P0 结构性改动需补 e2e TUI 用例。
