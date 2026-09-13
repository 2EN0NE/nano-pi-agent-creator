# ADR-0046: org 上岗自决（与 control 只保留必要条件关系）

- 状态：**已落地**（2026-09-12；D1–D5 全部落地，单测 + 真实 TUI e2e 覆盖）
- 相关组件：`extensions/auto/org`（`index.ts` / `onduty.ts` / `board.ts` / `capability.ts`）、`extensions/auto/control`（`switch.ts` / `index.ts`）
- 延伸：**修订 ADR-0043 `D1`（在岗入口）与 `D4`（门控面随判据更新）**；细化 ADR-0041 `D2`
- 姊妹决策：ADR-0047（告知通道分层）
- 术语：见 `CONTEXT.md`（多 agent 框架节：在岗 / 可上岗 / 在岗入口 / 在岗判据）

## 背景

1. **control 反向决定了 org 是否在岗**（耦合越界）。control 的 `refreshServer` 广播 `control:socket {enabled}`，org 订阅后**直接** `enabled ? goOnDuty() : goOffDuty()`（`org/index.ts:435`）→ `/control on` 等价于上岗、`/control off` 等价于离岗。control 本应只回答「本进程能不能收发会话消息」，不该替 org 决定「我要不要作为组织成员上岗」。
2. **必要条件被当成充要条件**。「socket 可连」是上岗的**必要条件**（没有它就收不到成员消息），但不是**充分条件**——是否上岗是 org 自身的产品决策。
3. **可发现性告知污染上下文**。未在岗时 org 用 `pi.sendMessage({customType:'org-off-duty', display:true})` 发卡片，而 pi 的 `convertToLlm` 把 `role:"custom"` 一律转成 **`role:"user"`**（`display` 只影响 TUI 渲染，不影响是否进上下文）→ 这条告知变成每次请求里的一条 user 消息，与人类真实输入混在同一条通道上（处理见 ADR-0047）。

## 决策

### D1 上岗的唯一入口是 org 自己：`/org on` / `/org off`

org 不再跟随 `control:socket` 自动收放岗。`control:socket` 的语义收敛为**广播物理真相**（socket 可连否），org 侧只据此刷新「可上岗性」，上岗动作必须由 `/org on` 显式发起。

### D2 三态：可上岗性 × 上岗意愿

| 态                   | 条件                 | 状态栏（`\|` 前缀规范，纯文本）        |
| -------------------- | -------------------- | -------------------------------------- |
| **不可上岗**         | socket 不可连        | `\|org: 未连接（/control on）` dim     |
| **可上岗**（待上岗） | socket 可连 ∧ 未上岗 | `\|org: 待上岗（/org on）` dim         |
| **在岗**             | socket 可连 ∧ 已上岗 | `\|org: x/y/z成员`（ADR-0043 D3 不变） |

**必要条件丢失**（在岗中 `/control off`）→ org **强制回落**到「不可上岗」（工具/简报/状态栏计数全收），留 `log.warn` 痕。

### D3 入口暴露面：命令 (a) + 看板两处 (b)

- **(a) 命令**：`/org on` / `/org off`（与 `/control on|off` 形式对称，语义不同）。
- **(b) 看板**（`/org` 面板，2026-09-12 定，取「①+③」）：
    - **① 设置视角加一行**「上岗状态：未上岗 / 在岗（可上岗）」+ `Enter` 切换——与既有的「自动唤醒」「组织背景」等同构，可发现。
    - **③ 常驻按键 `o`**：底部图例显 `o 上岗` / `o 离岗`（不可上岗时不显示该项），0 步直达；与既有 `r`/`w`/`s`/`d`/`m` 风格一致。
    - 两者**共用同一个 `toggleDuty()`**，仅多一处键位分支。
- 仅「可上岗」时允许上岗；不可上岗时给出原因（`未连接，先 /control on`），不静默失败。
- 被拒绝的替代：**新增第 4 个视角 tab**——单个开关占用一个视角层，过重（与 `docs/tui-interaction-patterns.md` 的"不膨胀一级结构"相悖）。

### D4 启动策略：跟随启动 flag 建的 socket → 自动上岗；运行中人工切换不自动

保留启动便利（`--session-control` 本身已是「我要干活」的明确意图）；**运行中**的 `/control on` 不触发自动上岗（否则又变回「control 驱动 org」）。

**区分机制（B5，2026-09-12 定）**：control 广播 socket 状态时**如实附带自身来源**——本次启用是「跟随启动 flag」（`runtimeOverride === null`）还是「运行中人工干预」（`runtimeOverride === 'on'`）。org **只对「跟随启动 flag」那一次自动上岗**；由人工 `/control on` 建立的 socket 只让 org 进入「可上岗」，上岗仍需 `/org on`。

理由：该字段只是 control 对自己状态的陈述，不含 org 的任何知识（低耦合方向不变），且与扩展加载顺序无关。

**被拒绝的替代**：

- **B1**（只在 `session_start` 探测那一次自动上岗）：control 的 socket 可能晚于 org 的 `session_start` 建成 → 行为取决于加载顺序，违反 ADR-0043 落地记录 3「不依赖顺序」。
- **B5'**（org 自行判断「是否已发生过用户输入」来定义启动阶段）：省一个字段、control 保持完全通用，但引入模糊的时间概念（启动后立刻 `/control on`、其他扩展触发的输入等边界），易生边界 bug。

### D5 离岗 / 不可上岗的告知只走状态栏

删除 `org-off-duty` 卡片（不再 `sendMessage`），改为 D2 的状态栏常驻提示；面向人的告知一律不得走 `pi.sendMessage`（见 ADR-0047）。

## 落地记录（2026-09-12，待定项已收敛）

1. **来源字段落地方式（B5）**：`control/switch.ts` 导出纯函数 `socketOrigin(override)`（`null → 'startup'`，否则 `'runtime'`），`refreshServer` 广播时附上；org 侧 `decideDutyAction()` 据此决定是否自动上岗，缺字段按 `'runtime'` 保守处理（记 `log.warn`）。
2. **org 侧判定的纯函数 seam**（`org/onduty.ts`）：`dutyState` / `offDutyStatusText` / `decideDutyAction` / `onDutyRefusal`。副作用留在 `index.ts`，判定全部可单测（三条铁律：运行中不自动上岗、启动意图自动上岗、必要条件丢失强制回落）。
3. **入口落地**：`/org on|off`（命令）+ 看板设置行「上岗状态」+ 常驻 `o` 键（共用 `setDuty()`）；不可上岗时给出路（`ui.notify` / 命令回复），不静默。
4. **告知改造**：删除 `org-off-duty` 卡片与 `announceOffDuty()`；未在岗改由 `renderDutyStatus()` 写三态状态栏（ADR-0047 D1 的首个落地案例）。
5. **验证**：vitest 新增 ~25 例（`control.switch` 的 `socketOrigin`、`org.onduty` 的四组判定、`org.board` 的看板入口）；org 模块真实 e2e 16/16 通过——其中三条新 TUI 用例覆盖「`/control on` 不自动上岗」「`/org on` 才上岗」「`/control off` 强制回落」，断言取**运行期状态栏文本**（事后查在岗注册无效：`session_shutdown` 会 `clearRuntime`）。
6. **测试基建顺带修复**：TUI 沙箱 HOME 原用仓库长路径，导致 unix socket 超 macOS ~104 字符上限而 `listen EINVAL`（`/control on` 建不出 socket）；`tui-functions.sh` 增加 `TUI_SANDBOX_ROOT` 短根覆盖（默认行为不变）。

## 后果

- **正向**：control 与 org 的耦合收敛为「必要条件提供者 ← 消费者」单向关系；未在岗不再污染 LLM 上下文；`/control` 的语义回到「会话控制 socket 开关」。
- **负向**：新增一个状态（可上岗/待上岗）与一个用户动作（`/org on`）；术语、看板、测试需同步。
- **注意**：`CONTEXT.md` 需新增术语「可上岗」并修订「在岗入口」「在岗判据」「在岗 / 存活 / 忙碌」。
