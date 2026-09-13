# ADR-0043: 在岗入口、在岗判据与状态栏

- 状态：**已接受**（2026-09-11；D1–D4 **已落地**，单测 + 门控面 e2e 覆盖）
- ⚠️ **部分被修订**（2026-09-12，ADR-0046）：`D1`（在岗入口）不再是 `/control on|off`——上岗改为 org 自决 `/org on`，control 只提供必要条件（socket）；`D4` 的「门控面随判据更新」仍有效，但驱动方向由 control 单向改为 org 消费广播自决。
- 相关组件：`extensions/auto/control`（socket / flag）、`extensions/auto/org`（`onduty.ts` / `index.ts` / `board.ts`）
- 延伸：**修订 ADR-0041 `D1`（在岗判据）与 `D2`（门控面）**；向 `CONTEXT.md` 补术语（在岗入口 / 在岗判据）
- 术语：见 `CONTEXT.md`（多 agent 框架节：在岗 / 在岗入口 / 在岗判据 / 可感知状态）

## 背景

1. **在岗没有 TUI 入口**。control 在 `session_start` 读 `pi.getFlag('session-control')` 决定建不建 socket（`control/index.ts` `refreshServer`），而 pi 的扩展 API **没有 `setFlag`**（只有 `getFlag`）→ 已开着的 pi 无法热切换；看板 `w` 唤醒对本目录返回 `skipped:'self'`（一目录 = 一员工），也救不了本进程。
2. **勘误：org 的在岗判定实际是 argv 字符串匹配**。`getFlag` 按扩展隔离（`loader.js` `getFlag`：`if (!extension.flags.has(name)) return undefined`），`session-control` 是 control 注册的 → org 里 `pi.getFlag('session-control')` **恒为 `undefined`**（真机 probe 验证：factory 与 session_start 都返回 `undefined`）。所以 `onduty.ts` 的 `getFlag` 分支是死代码，**「在岗」并不等于「socket 真的建成了」**——与 ADR-0041 `D1`「getFlag 在 session_start 内可靠」相悖。
3. **人工 UAT 暴露可发现性缺失**：在未在岗的普通 pi 里，agent 完全看不到 org 能力，也没有任何提示（人类无从知道自己"没在岗"、更不知如何进入）。

## 决策

### D1 在岗入口：control 提供运行时开关

control 增加运行时开关（TUI 命令），允许本进程在「建 socket / 不建」之间**热切换**。org 侧配套实现 org 能力的**收 / 放**——当前只有 `ensureOrgTools()` 的"放"，没有收回路径。

### D2 在岗判据：以「可收发成员消息」的物理真相为准

在岗 = runtime 记录存在 **且** 其 `socketPath` 可连。flag / argv **只表示「启动时请求建 socket」**，不作判据。**修订 ADR-0041 `D1`**。

### D3 状态栏：`|org: x/y/z成员`

`ctx.ui.setStatus('org', text)`（底部状态栏，格式约定见 `docs/tui-design-principles.md §2.1`）：

| 量  | 含义                        | 配色            |
| --- | --------------------------- | --------------- |
| `x` | **在岗且忙**（`busy=true`） | 主题**亮色**    |
| `y` | **在岗**数量                | 正常色          |
| `z` | **本 org 注册成员数**       | **暗色**（dim） |

`y`/`x` 需轮询（socket 生死无事件），由**在岗进程**内的只读定时器得出（守 ADR-0040 `D4`「感知不写副作用」）。

### D4 门控面随判据更新

在岗判据变更后，工具 / 技能 / 在岗简报 / 状态栏的收放**一律以 socket 为准**；离岗时需有**收回**路径（不只是 session_start 时的注册）。此条细化 ADR-0041 `D2`。

## 落地记录（2026-09-11，待定项已收敛）

1. **多 org 状态栏**：取**当前 org（`self.orgs[0]`）**单段显示 `|org: x/y/z成员`。理由：一个成员目录通常只属一个 org；
   多 org 的并排排布（`org:1/2/3 · org2:0/1/1`）留待有真实需求再做。
2. **能力收回手段**（已查源码 + 实测）：
    - **工具 ✅ 可运行时收回**：`pi.setActiveTools(names)` → `setActiveToolsByName` 同时更新 `agent.state.tools`
      **并重建系统提示**（`_rebuildSystemPrompt`），因此工具列表与提示里的说明一起收放。落点为 `org/capability.ts`。
    - **技能 ❌ 不能运行时撤回**：`resources_discover` 只在 startup/reload 触发，且 `extendResources` 是**追加**语义。
      故技能收回**退化为 `/reload`**（简报里已保留 `SKILLS_RELOAD_HINT` 告知用户）。
    - 附带核实：`pi.registerTool()` 内部会调 `runtime.refreshTools()` → **新注册工具自动进入活动集**，
      所以「放」无需显式 setActiveTools，「收」才需要。
3. **D2 时序**：`session_start` 时 control 的 socket **可能尚未建好**（取决于扩展加载顺序）。因此**不依赖顺序**：
   org 在 `session_start` 主动探测 socket，**并在扩展工厂期就订阅** control 的 `control:socket` 事件
   （工厂执行早于任何 `session_start`）→ 两种加载顺序都成立。
4. **勘误确认**：`getFlag` 按扩展隔离（`loader.js`：`if (!extension.flags.has(name)) return undefined`）已由源码确证，
   旧的 argv 匹配确为权宜之计，现由 socket 真相取代。

## 后果

- **正向**：人能在界面里直接看到「在岗/忙/注册」并控制切换；`getFlag` 死代码与 ADR-0041 的偏差被消除。
- **负向**：control 与 org 都要新增「能力收 / 放」路径，状态机复杂度上升。
- **注意**：D2 落地后，`presence.ts` 的 `pidAlive` 语义（「进程在但 socket 不可连」）与 ADR-0040 `B3`/`D6` 的「陈旧 runtime」表述需一并复核。
