# pi-tui：doRender 的 fullRender 机制与自定义组件高度铁律

> 从 `AGENTS.md`「开发Pi插件一些补充信息」#13 移出（该节有 200 行上限）。
> **适用范围：`tuiMode: "regular"`（内联渲染器）。** pi 自 1.0.0 起 `tuiMode` 默认是 `"fullscreen"`
> （pi CHANGELOG `## [1.0.0]`：「Changed the default TUI mode to fullscreen」），
> 走的是另一套渲染器（`TuiAltScreen`：layout root + 固定输入 dock + 应用自管滚动），下面这套
> `firstChanged`/`fullRender` 语义**不适用**。按 fullscreen 看代码时不要照搬本文件结论
> （实测结论见 [ADR-0067](../adr/0067-pi-0.85-to-1.4-change-surface-and-compat.md) 的「fullscreen 实测」节）。

## 机制

`doRender()` 的 diff：`firstChanged` 从渲染树行 0 逐行对比 `previousLines`/`newLines`；
**`firstChanged < prevViewportTop` → `fullRender(true)`**（`\x1b[2J\x1b[H\x1b[3J` 清屏 + 清 scrollback +
整树重绘，依赖 `\x1b[?2026h` 同步输出原子性）。

## 铁律 1：总高 ≤ 视口高度

任何替换 `editorContainer` 的自定义组件，**总高必须 ≤ 终端视口高度（rows）**。否则组件顶部
（树行/光标行）落在视口上方，滚动时 `firstChanged < viewportTop` 恒触发 fullRender →
同步输出失效链路（tmux / SSH / Windows Terminal）上表现为**重影/错位**。

## 铁律 2：header 不得放动态内容

渲染树**第 0 行（header）不得放随光标/滚动变化的动态内容**（当前节点 ID、计数等）——
第 0 行一变，`firstChanged = 0 < viewportTop`（总高略超视口即触发）就 fullRender 重影。
动态状态信息应放**底部 footer**（最后一行的 firstChanged 被树内更靠前的光标行变化「掩盖」，
不触发 fullRender）。

**例外**：显式上下文切换（如公司/数据源切换，org 看板标题 `── org:<公司名> ──` 随 Tab 切公司更新）
允许第 0 行变更——切换时内容区整体换数据本就接近全量重绘，不引入滚动重影；同一上下文内仍须恒定。

## 参考实现与观测工具

- **参考原生 `/tree`**（`pi-mono` 的 `tree-selector.js`）：`maxVisibleLines = floor(terminalHeight / 2)`
  自适应 + 选中行居中（`startIndex = selected - floor(maxVisibleLines / 2)`），组件总高 ≤ 视口 → 滚动纯 diff。
- **观测工具**：`PI_TUI_DEBUG=1` → diff 渲染日志 `/tmp/tui/render-*.log`（含完整 newLines JSON）；
  `PI_DEBUG_REDRAW=1` → fullRender 原因记录到 `~/.pi/agent/pi-debug.log`。

## e2e 盲区

固定 80 列 + 短树（< pageSize 行）时**滚动路径零覆盖**——滚动类 bug 必须用长树用例
（mock-llm 的 `MOCK_LLM_REPEAT` 发多条消息造 50+ 稳定节点树）。

## 附带结论

扩展运行时 `setInterval` / `setTimeout` 回调**正常触发**（2026-09-10 实测，见
[ADR-0040](../adr/0040-agent-lifecycle-presence-and-active-wake.md) F1；旧结论「运行时根本不触发」已作废）。
定时器可直接用于后台轮询；但 `/reload` 会令旧实例的定时器失效、必须重建（见 AGENTS.md #8）。
