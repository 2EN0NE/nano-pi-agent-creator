# pi-session-tree 窄终端滚动叠印/堆积 — 已知问题（pi 渲染缺陷）

> 状态：**KNOWN PI ISSUE**（扩展侧无解，需 pi 侧修复或等 pi 升级）
> 复现环境：`test/e2e/extensions/pi-session-tree/tui-expect.smoke.test.sh` 009 用例（工具活跃 + 91 列 + 滚动）

## 现象

91×23 窄终端（或用户日常 91×? 终端），**agent 活跃时**（工具执行/消息追加中）打开面板按向下箭头滚动，chat 区内容（如 bash 工具输出）与树行**叠印在同一物理行**，节点向上堆积占满屏幕。

用户截图：bash 工具行 + read 内容叠印。

## 根因（e2e 实证）

1. chat 区工具执行产生**动态多行输出**（`$ cat ...`、`cat: ... No such file`、`Command exited`、`Took 4.6s` 等逐行追加）
2. 这些输出位于渲染树**视口上方**（chat 区在面板上方）→ `firstChanged < viewportTop`
3. pi 的 diff 判定为 **fullRender(true)**（清屏 + 整树重绘）——e2e 检测到滚动后 header（`会话树`）重现 = fullRender 标记
4. fullRender 依赖 `\x1b[?2026h`/`\x1b[?2026l` 同步输出（terminal 同步模式）；**失效终端**（不支持/慢处理）下中间帧可见 → 叠印/堆积
5. 同一同步输出块内出现 `cat: ▼ [bash] cat: ... No`、`such ▼ [bash]`——**pi 实际把 chat 输出与树行写到同一物理行**（行定位错位）

**触发条件**：chat 区活跃更新（渲染树视口上方变化）。chat 静止（agent idle）时滚动为纯 diff（header 不重现），无叠印。

## 扩展侧方案验证（实测结论）

| 方案                                                       | 实测                       | 结论                                                         |
| ---------------------------------------------------------- | -------------------------- | ------------------------------------------------------------ |
| 1. overlay 模式（`ctx.ui.custom(..., { overlay: true })`） | TREE=1 依旧 + 叠印依旧     | **不解决**（overlay 只改面板合成方式，渲染树/chat 更新不变） |
| 2. wrap 防护（truncateToWidth 等）                         | 树行/chat 行均 ≤91 不 wrap | **不适用**（非 wrap 问题）                                   |
| pageSize 自适应（面板总高 ≤ 视口）                         | chat 静止时滚动 TREE=0     | **有效但只覆盖 chat 静止场景**（008 用例验证）               |

pi 已是最新版（0.84.1），ctx.ui 无 hideChat/freeze/pause API——扩展侧无法冻结 chat 渲染。

## 建议

- **用户侧缓解**：agent 空闲（`agent_settled`）后再操作面板滚动；chat 静止时滚动正常
- **根治**：pi 侧修复（diff/fullRender 对"视口上方变化"的行定位，或同步输出兜底）——需报 pi issue
- **回归**：009 用例为诊断复现（不阻塞），若 pi 修复后 `ACTIVE_TREE_HEADER`/`GHOST_LINES` 应降为 0

## 相关代码位置

- 面板渲染：`extensions/meta/pi-session-tree/ui/panel.ts`（pageSize 自适应在 100-107 行）
- 复现 e2e：`test/e2e/extensions/pi-session-tree/tui-expect.smoke.test.sh` 009
- pi 渲染机制：`~/.pi/node_modules/@earendil-works/pi-coding-agent/dist/...`（doRender/fullRender）
