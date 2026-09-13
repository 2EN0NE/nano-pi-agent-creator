# ADR-0050: 活动工具集的写者与限制权归属

- 状态：已接受（2026-09-13）
- 相关组件：`extensions/meta/preset`（`tools.ts` / `skills.ts`）、`extensions/meta/pi-lab`、所有可能调用 `pi.setActiveTools()` 的扩展（如 `extensions/auto/org`）
- 延伸：ADR-0049（preset 是硬约束策略源，约束是 overlay）、ADR-0043（org 在岗门控要求 org 碰 `setActiveTools`）
- 术语：见 `CONTEXT.md`「preset 预设」节（基础层 / 约束叠加层 / 活动工具集）

## 背景

活动工具集（`pi.getActiveTools()` / `setActiveTools()`）长期有**三个写者**且无仲裁：

1. **pi 自身**：`registerTool` 让新注册工具自动进入活动集（这是"启用"，不是"限制"）。
2. **preset**：经 `tools.ts` 的 `replaceTools()` 用自有快照**整体覆盖**活动集。
3. **第三方扩展 / 实验**：`org` 增量注册（ADR-0043 D4 要求）、`tools.ts` 内嵌的 `tool-range` 实验在 `core` 臂把非基础工具写进 `disabledTools`。

三者互相覆盖，正是 org 事故（`Tool org_wake not found`）的根因。ADR-0049 已把 preset 收为"叠加层"，本 ADR 补齐剩余归属问题：**谁有权限制活动工具集**。

用户确立的规则：**限制权只属于 preset 与其三个子工具（`/tools`、`/skills`、`/prompt`）；实验只能记录，不能限制。**

## 决策

### 1. 限制权是二元的，没有第三个来源

对活动工具集的"限制"（把某工具排除出可用集）只有两个合法来源：

- **preset**（激活期间）——通过 overlay 施加（ADR-0049 决策 5）。
- **三个子工具**（非激活期间）——用户经由 `/tools`（同理 `/skills`、`/prompt`）的手动设置，属**基础层**。

### 2. 其它扩展与实验不得施加限制

- 任何扩展**不得**用 `pi.setActiveTools()` / 写 `disabledTools` 去**缩减**活动工具集；只能观测/记录。
- **动态注册不算限制**：`pi.registerTool()` 让工具进入活动集是 pi 的基础"启用"行为，合法；它在 preset 封闭集激活期间由 preset overlay 遮罩为不可用（ADR-0049 决策 3），而不是被注册方"限制"。
- 若某扩展确实需要"减少可用工具"（如新形态的门控），必须表达为 preset（或子工具的用户设置），不得自建第三通道。

### 3. `tool-range` 实验按 B2 收敛

`tool-range` 由 `tools.ts` 自持（`owner: 'tools'`，pi-lab 只选臂与记录，`grep` 确认 pi-lab 不碰 `setActiveTools`），因此属于"工具自己提供的实验"，落入 B2：

- **默认只记录/观测，不产生任何工具限制**（取消当前"无用户配置即自动按 sessionId 分流并注入 core 臂"的行为）。
- 仅当用户**显式报名**该实验（`extensions-data/tools/config.json` 的 `enableToolRange: true`）后，`tools.ts` 才把臂结果**当作用户自己的选择**写进**基础层**。
- preset 激活期间实验一律退避（preset 是上级策略源）。

### 4. 有效活动集 = 基础层 ∩ preset overlay

overlay 存在（preset 激活）时，有效活动集是基础层与 overlay 白名单的交集；overlay 不存在时即基础层本身。这取代 `replaceTools()` 的"快照整体覆盖"语义。

### 5. 每个限制来源必须可区分、可见

`/tools` 面板须能标注每个被禁用工具的来源（`用户禁用` / `preset 限制` / 实验），使"谁在限制"可观测。当前 `labInjectedDisabled` 的标注思路保留，但来源集合按本决策重定义。

### 6. 注册方管理自有工具的边界

注册方（如 `org`）对自己注册的工具可执行"放出 / 收回"（on-duty / off-duty），这**不属于**"限制他人工具"，无需走 preset / 子工具通道。边界如下：

- 无 preset overlay 时，`tools.ts` **不干预**基础层（不在 `before_agent_start` 全量重算），注册方的收回不被覆盖。
- preset overlay 生效时，一切动态注册工具按 ADR-0049 决策 3 统一被遮蔽——注册方的收放不改变该结果。
- 注册方**不得**用 `setActiveTools()` 缩减**非自有**工具；那属违规（见决策 2）。

## 权衡

| 议题           | 方案                                           | 结论                                        |
| -------------- | ---------------------------------------------- | ------------------------------------------- |
| 实验限制       | A. 统一伪装成临时会话级 preset                 | 拒绝：用户反对"实验借 preset 身份仍能限制"  |
|                | B1. 实验完全不能限制（只能观测）               | 部分拒绝：会废掉 `tool-range` 的 A/B 能力   |
|                | B2. 默认不限制，显式报名后作为用户选择写基础层 | 采纳：用户显式同意才限制                    |
| 第三方扩展限制 | 允许各自 `setActiveTools()`                    | 拒绝：多写者互相覆盖（本 ADR 要消灭的根因） |
|                | 只能通过 preset/子工具间接表达                 | 采纳                                        |

## 后果

**正向**：活动工具集首次有唯一的限制来源归属；`org` 之类动态注册方只需 `registerTool`，不再与 preset 抢写；`tool-range` 不再静默改变用户环境。

**负向 / 代价**：

- `tool-range` 的自动分流被取消，实验样本依赖用户主动报名，采集变慢/样本量下降。
- `tools.ts` 的 `reapplyRestrictions()`、`autoEnableNewTool()`、`externalOverride`、`labInjectedDisabled` 需大幅重构或删除。
- 需要新的 e2e 断言"第三方扩展无法限制活动集"（可用测试辅助扩展注册工具，验证其注册行为，而非限制行为）。

## 实现契约（供 e2e 断言）

1. 无 preset 时，任何扩展注册工具都不会**减少**活动工具集。
2. preset 激活时，动态注册工具被 overlay 遮罩（`/tools` 显示不可用、`tool_call` 被拒）。
3. `tool-range` 未报名时，活动工具集不因实验而变化。
4. overlay 撤回后，活动工具集 == 基础层。
