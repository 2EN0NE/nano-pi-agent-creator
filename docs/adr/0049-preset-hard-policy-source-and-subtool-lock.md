# ADR-0049: preset 作为 tools/skills/instructions 的硬约束策略源，子工具激活即锁死

- 状态：已接受（2026-09-13）
- 相关组件：`extensions/meta/preset`（`index.ts` / `tools.ts` / `skills.ts` / `prompt-editor.ts`）、`extensions/auto/org`（动态注册工具的代表方）
- 修订：取代 ADR-0035 的「默认不锁定、偏离仅提示」默认语义（激活即锁定）；ADR-0031/0032/0033 的字段三态与三级来源仍然有效
- 术语：见 `CONTEXT.md`「preset 预设」节（preset 策略源 / 子工具 / 无 preset 状态 / 基础层 / 约束叠加层 / 活动工具集）

## 背景

preset 一直自称是 tools/skills/instructions 的配置入口，但实现上它与这三个子工具**各持一份状态、互相覆盖**，由此在真实 UAT 中炸出事故：org 在岗时动态注册 9 个工具，`preset`（经 `tools.ts` 的 `replaceTools` 快照整体覆盖 `pi.setActiveTools()`）把它们静默移除，agent 反复 `Tool org_wake not found`。

排查（见 `handoff-preset-tool-gating.md`）确认三条未成文的基础条件从未被满足，也从未写进任何 ADR：

1. **控制一致**：`/tools` 显示的可用状态必须 == preset 的控制状态（用户视此为 preset 立身的基础）。
2. **无 preset = 无约束**：未激活任何 preset 时，不应存在任何工具/技能/指令限制（当前 `(none)` 仍留约束）。
3. **权威归属**：活动工具集（`pi.getActiveTools()` / `setActiveTools()`）有三个写者——pi 自身（`registerTool` 自动并入）、preset（自有快照覆盖）、org（增量注册）——没有任何仲裁规则，互相覆盖。

现状代码中的具体缺口（审计编号，供后续修复与测试）：

- **N1** `(none)` 无快照时落到 `DEFAULT_CLEAR_TOOLS`（仅 4 个工具）—— `index.ts:571-573`。
- **N2** `(none)` 完全不处理 skills，技能白名单残留 —— `index.ts:557-580`。
- **N3** `/reload` 复活已清除的 preset（`restoredActiveName ?? 旧 preset-state entry`）—— `index.ts:1323`。
- **N4** 恢复激活 preset 时只重放 tools、不重放 skills —— `index.ts:1343`。
- **N5** `reapplyRestrictions` 把动态注册工具自动并入，与 preset 白名单相冲 —— `tools.ts:425-458`。
- **N6** `tools.ts` 的 `tool-range` 实验 `core` 臂直接写 `disabledTools` 全集，构成第三个写者 —— `tools.ts:601-612`。
- **N7** `externalOverride` 标志跨事件残留，`session_tree` 语义混乱 —— `tools.ts:73,148-163,678`。
- **N8** skills 有 `config.json`（跨会话）+ session entry 两个来源，preset 只写一个 —— `skills.ts:106-136`。

## 决策

### 1. preset 是唯一策略声明者，子工具状态与它强一致（R1）

preset 在 tools / skills / instructions 三个维度上是唯一的策略声明者；`/tools`、`/skills`、`/prompt` 是它的执行臂（子工具），**不得形成与 preset 冲突的策略**。三者展示/生效的状态必须时刻等于 preset 的控制状态。

### 2. 无 preset（none）= 不施加任何限制（R2）

未激活任何 preset 时，preset 不施加任何限制：工具全量启用、技能不限制、无 preset instructions。清除预设与一切恢复路径（`/reload`、`session_tree`、分支恢复）**不得复活**此前的约束。

### 3. tools 白名单是封闭集（R3）

preset 激活且声明了 `tools` 时，白名单为**封闭集**：运行时新注册的工具（org / MCP 等）一律视为禁用，`/tools` 视图同样显示为**不可用**。要启用某工具，必须写进该 preset 的 `tools`（或不写 `tools` 字段 = 该维度不限制）。preset 未声明 `tools`（`undefined`）时该维度不约束，工具状态由基础层决定。

### 4. preset 激活期间子工具锁死，写操作拒绝并告警（R4）

preset 激活期间，`/tools`、`/skills`、`/prompt` 的写操作（开关、编辑 override）**一律拒绝并告警**；读视图仍可用。要改配置只能通过 `/preset` 编辑/切换，或先清除预设。

### 5. preset 约束是叠加层（overlay），清除即撤回；非激活时子工具自由

preset 的约束是叠加在**基础层**之上的策略层，不写入基础层：

- **基础层** = `/tools`、`/skills`、`/prompt` 各自维护的状态，默认「工具全量启用 / 技能全部可见 / 无附加指令」。
- preset 激活 → 在基础层之上叠加约束（决策 1–4）；preset 清除 → **仅撤回 overlay**，基础层原样保留（不强制重置为全量，也不恢复进入 preset 前的快照）。
- **非激活状态（`(none)`）下三轴不锁定，用户可自由修改**——此时修改维护的是基础层；用户对 `/tools` / `/skills` 的手动偏好属于基础层，清除 preset 后保留。
- 由此删除 `DEFAULT_CLEAR_TOOLS` 兜底与「清除时恢复到 `originalState` 快照」的融合写法（`index.ts:571-573`）；preset 的任何路径都**不得**把自身约束写进基础层状态（`tools-config` / `skills-config` / 各 `config.json`）。

## 与 ADR-0035 的关系

ADR-0035 引入 `Preset.locked` 字段与 `l` 键，语义是「默认不锁定，锁定才拒绝偏离；未锁定仅 widget 提示」。本决策将「激活即锁定」设为默认且唯一语义，因此：

- `locked` 字段与详情面板 `l` 键**失去意义**，应删除（数据模型同步清理）。
- `detectDrift` / 状态栏「已偏离」提示**不再是常规路径**：激活期间子工具写操作被前置拒绝，理论上不应产生偏离；`turn_start` 兜底回滚被降级为「防御第三方绕过入口直接改状态」的最后一道防线。
- `model` / `thinking` 维度不属子工具锁（`/model` 是 pi 内置命令，preset 无法前置拦截），维持「事件回滚 + turn 兜底」不变。

## 权衡

| 议题               | 方案                                       | 结论                                                          |
| ------------------ | ------------------------------------------ | ------------------------------------------------------------- |
| 动态注册工具       | A. 硬约束，封闭集（本决策）                | 采纳：preset 是最终裁判，自洽性最高                           |
|                    | B. 白名单 = 激活时刻封闭集，之后动态并入   | 拒绝：白名单不再是封闭集，与决策 1/2 冲突                     |
|                    | C. 静态工具硬约束 + 动态工具豁免通道       | 拒绝：引入"两类工具"，`/tools`「全开」语义要重定义            |
| 激活期子工具写操作 | A. 写操作回写 preset 字段（子工具=编辑器） | 拒绝：用户明确要"锁死"，且文件级预设回写会放大写入面          |
|                    | B. 只读 + 拒绝写 + 告警（本决策）          | 采纳：读视图一致、写入口收敛到 `/preset`                      |
|                    | C. 保留偏离 + `locked`                     | 拒绝：等于没约束，即当前出问题的状态                          |
| `(none)` 恢复语义  | A. 撤回 overlay，基础层原样保留（本决策）  | 采纳：preset 零限制在语义上成立，保住 `/tools` 独立工具定位   |
|                    | B. 强制全量重置                            | 拒绝：抹掉用户基础层偏好，且无法区分"用户偏好"与"preset 遗留" |

## 后果

**正向**：preset 的定位（最终裁判）与三个子工具的行为首次自洽；`(none)` 语义明确；多写者互相覆盖的根因被点名为"约束叠加层不得污染基础层"，后续修复有明确契约。

**负向 / 代价（必须接受）**：

- org 在**带 `tools` 的 preset**（如 `plan` / `raw`）下会**彻底不可用**，这是预期行为而非 bug；需要 org 的 preset 必须把 org 工具写进 `tools`，或不写 `tools` 字段。
- `tools.ts` 的既有机制（`applyTools()` 整体覆盖、`replaceTools()` 快照、`autoEnableNewTool`）与 `tool-range` 实验的 `disabledTools` 注入，都要按"约束是 overlay、不污染基础层"重做；这是一次触及全局状态的改造。
- ADR-0035 的 `locked` 字段删除属数据模型变更，需处理已落盘 config.json 的兼容。

### 实现契约（必须满足，供 e2e 断言）

1. 激活带 `tools` 的 preset 后，`/tools` 视图 == preset 白名单；动态注册的工具显示为不可用。白名单是 preset **声明名**的封闭集——声明了但尚未注册的工具现在不生效，一旦运行时注册即按声明启用（不得因「当前不可注册」把非空白名单降级为「不限制」）。
2. 清除 preset 后，工具/技能/指令回到无限制；不残留任何受限集。
3. `/reload`、`session_tree`、分支恢复后，已清除的 preset **不复活**，被清除的约束**不复活**。`session_tree` 等恢复路径**不得**把 overlay 的排除集反写进基础层。
4. 激活期间对 `/tools`、`/skills`、`/prompt` 的写操作被拒绝并给出告警（`/prompt` 的锁作用于 preset 所辖的 `preset_instructions` 组件；技能描述、上下文文件等非 preset 维度组件不属此锁）。
5. 上述四条必须有**语义级 e2e**（不止"无报错/退出码"）；`test/e2e/extensions/preset/` 现有用例不满足。

### 已知例外与限制（pi 机制，不属于 preset 可控制范围）

以下两点由 pi 运行时机制决定，明确列为**例外**，不要求 preset / 三个子工具做到完全一致：

1. **skills 控制与 `/skill:xxx` 不保证一致**。`/skills`（含 preset 的 skills overlay）控制技能的可见/可调用状态，但 pi 的技能命令展开路径不完全受扩展 enabled 状态约束，用户仍可能经 `/skill:xxx` 触达被控制为「禁用」的技能。因此**不要求** `/skills` 的控制内容与用户经 `/skill:xxx` 实际可达的内容一致（`skills.ts` 的 `input` 拦截是尽力而为的加固，不是一致性保证）。
2. **动态工具遮罩对当轮 system prompt 可能滞后一轮**。`tools.ts` 在 `before_agent_start` 内用封闭集遮蔽运行时新注册的工具，但 pi 的该事件在各扩展间共享**事件开始时的快照**；本扩展在事件内改变活动集不会同步到后续扩展基于旧快照重建的 system prompt。当其它扩展（如 `prompt-editor`）在同一事件返回修改后的 system prompt 时，被遮罩工具的描述可能在该轮提示中残留一次，下一轮收敛。工具**调用**层面不滞后（`tool_call` 始终拦截）。

## 后续（本文范围外）

- 活动工具集的**写者与限制权归属**（其它扩展/实验能否限制、`tool-range` 的处置）见 **ADR-0050**。
