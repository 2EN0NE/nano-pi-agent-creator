# ADR-0070: /org 看板的「所属组织」区分、tab 排序，与跨进程变更感知

- 状态：**已接受**（2026-10-28 grilling 收敛；D1–D12 全部定案，实施项见 `.scratch/org-own-org-and-presence-refresh/issues/`）
- 相关组件：`extensions/auto/org`（`board.ts` 看板、`index.ts` 命令面与状态栏、`presence.ts` 巡检、`orgstore.ts` 注册表）
- 术语：见 [`CONTEXT.md`](../../CONTEXT.md)「多 agent 框架」节的 **所属组织（own orgs）**
- 延伸：修订 ADR-0039（看板交互与身份）的 org tab 部分；修订 ADR-0043 `D3`（状态栏 `z` 的计数口径，见 D12）；承接 ADR-0040 D4/D5（感知四态与「感知与动作分离」）
- 相关：ADR-0065（工具权威）、ADR-0066（`systemPromptOptions` 与 prompt cache）、ADR-0067（0.85→1.4 变更面）、ADR-0068 D8（`ctx.mode === 'tui'` 判据）

## 背景

三处用户报告的缺陷，先各自取证。

### ① 「所属组织优先」这条逻辑从未实现

`board.ts:328` 的 `meOrgPref()` 实现是 `return this.orgNames[0] ?? ''` —— 即「字面序第一个 org」，没有任何「所属」判断。唯一调用点 `board.ts:310` 因此永远落在字母序第一个组织上。同源的首组织假设另有两处：`index.ts:1075`（看板只收到 `me.orgs[0].member.name`）、`index.ts:471`（状态栏只统计 `me.orgs[0]` 的在岗数）。

结论：**这不是「排序策略要改」，而是「能力不存在」**。

### ② 刷新是纯轮询，且只覆盖当前 org

| 触发                                              | 周期                     | 覆盖范围                                                                                    |
| ------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------- |
| 看板巡检 `startPresencePolling`（`board.ts:516`） | 4s（`PRESENCE_POLL_MS`） | **仅当前 org** 的 `inspectMembers`（读 `runtime/*.json` + socket 探活 ≤1.2s，并发）         |
| 同上拍内                                          | 4s                       | `refreshSlots`／`reloadLedger`（tasks 指纹比对）／`refreshActivity`（每成员一次 RPC，串行） |
| 状态栏 `startStatusTimer`（`index.ts:514`）       | 4s                       | 仅当前会话的 `me.orgs[0]`                                                                   |
| 按键／切 org／自己执行动作                        | 即时                     | 当前 org                                                                                    |

全仓无 `fs.watch`、无跨进程事件、无 socket 推送；**非当前 org 的成员在岗状况完全不被探测**（org tab 行只有名字，没有在岗数字）。

### ③ org 有三处语义仍按 1.4 之前的写法

ADR-0067 只核对过「org 的 `before_agent_start` 无 `event.prompt` 依赖」。剩余三处：

1. `index.ts:876` 静态简报返回 `{ systemPrompt: event.systemPrompt + briefing }` —— 1.4 语义下等价于 `forceSystemPrompt`（整段钉死），丢掉 section diff 与 prompt cache（ADR-0066）。
2. `index.ts:1074` 用 `process.stdout.isTTY` 当「能开 TUI 面板」的判据；1.4 的官方判据是 `ctx.mode === 'tui'`（ADR-0068 D8：RPC 下 `hasUI` 为真但 `custom` 是空实现）。
3. `capability.ts:61` 用 `setActiveTools()` 缩减活动集，与 ADR-0065「限制权只有 preset 与三个子工具」冲突；1.4 的 `defaultActive: false` 是官方另一条路。

## 决策

### D1 「所属组织」的判据 = 打开看板的 cwd 在注册表里的精确匹配（集合）

```text
所属组织(cwd) = { org | ∃m ∈ org.members, realDir(m.dir) === realDir(cwd) }
```

依据（均已实测）：

- 一个 org 内 `dir → 成员` 是 **1:1**：`joinOrg`（`orgstore.ts:303`）对同目录同名同角色幂等返回，同名不同目录抛错，写入前 `filter(m => m.name !== name || realDir(m.dir) !== dir)` 去重。
- `member.dir` 写入时已 `realDir()` 归一，精确匹配不存在软链/相对路径误判。
- **跨 org 不唯一**：`joinOrg` 只读目标 org、无跨 org 守卫；`findOrgsForDir`（`orgstore.ts:203`）本身就返回数组；CONTEXT.md「子领域 agent」也明写「可同时加入多个 org」。故「所属」天然是**集合**，且可为空集。

**排除的两个候选**（记录理由，避免以后重开）：

- 不用「本进程在岗注册的 org」（`runtime/<name>.json` 存在）：它随 `/org off` 消失，而「我属于哪个组织」是目录级事实，不该因暂时离岗而改变。
- 不用「上次停留的 org」（偏好记忆）：让人为走动覆盖目录事实，与「目录绑定」的领域模型冲突。

`resolveSelf()`（`index.ts:344`）每次命令都在算这个集合，只是从未传给看板——修复面是**把它传进去**，不是新造判据。

### D2 多个所属：全部算所属，排在最前，不 dim，组内按「最近派活」倒序

不引入「更属于哪一家」的关系——成员记录里没有这种关系，`joinedAt` 只是登记时间，用它排序会让「所属」退化成有时间维度的软概念。

### D3 零所属：全部 dim

人在任意目录（如仓库根）打开 `/org` 时，没有任何一家是「他的」，整排 tab 一律 dim。
**订正（与 D6 四态表对齐）**：**当前正在看的那家始终取 accent + bold**（即使它不属于我）——D6 的
「所属/非所属 × 当前/不在看」四态表优先于本条的字面「一律 dim」，否则零所属时会连「我在看哪家」
的指示一起压掉（实现与 `org.board-own.test.ts` 的「无所属：整排 dim + 一行尾注」用例均按此）。

> 已知副作用，渲染层必须一并解决：此时没有「亮的」tab 作参照，dim 容易被读成「这些组织都不可用/无权限」。解法见 D6。

### D4 排序键 = `max(task.createdAt)`；不落库

- 「派活」= `dispatch.ts:173` 的 `createTaskWithId(...)`，任务的 `createdAt` **就是派活时刻**（`task.ts:80`）。
- `org.json.updatedAt` **不可用**：`dispatchTask` 只 `readOrg`（`dispatch.ts:119`）从不 `writeOrg`，派活不碰 org.json；它只反映成员/设置变更。
- 取值方式（三选一，取方案 a）：**(a) 打开面板时并发 `listTasks(org)` 每个 org 算一次，之后当前 org 的键从内存快照（`snap.tasks`）直接读，非当前 org 保持打开时的值**。
    - 否决 (b) 落库 `org.json.lastDispatchAt`：每次派活多一次 org.json 读改写，而 `writeOrg` **无并发锁**（`orgstore.ts:131` 注释自认），`refreshMemberManifest` 已在写它，再叠加派活写会明显加剧跨进程丢更新。
    - 否决 (c) 每次巡检全量重算：当前 org 本来每 4s 就 `listTasks` 一次，N 家即 N 倍开销。
- 代价与可接受性：陈旧窗口只影响「非当前 org 之间的相对次序」，而人看的是当前 org，误判代价 ≈ 0。同刻并列按 org 名字母序兜底。

### D5 重排必须按 org 名重定位 `orgIdx`（安全线，不是偏好）

`orgIdx` 是数组下标，Tab 循环靠它。若面板开着时另一进程往 org B 派活导致 B 跳到最前，当前正在看的 org 下标平移 → **屏幕突然换成另一家 org**。这与 `board.ts:816` 已记录的「账本重载要按 task id 跟住光标」是同一类事故（同类问题的既有实现可复用 `remapSelectionById` 的思路）。

**规则：任何 org 列表重排之后，都用「当前 org 名」重新求 `orgIdx`，不得沿用旧下标。**

### D6 视觉区分 = 颜色（muted/dim）+ 分段 + 语义尾注

两轴（所属 / 当前）压在同一枚 chip 上，四态都要可分：

|            | 当前正在看的  | 不在看 |
| ---------- | ------------- | ------ |
| **所属**   | accent + bold | muted  |
| **非所属** | accent + bold | dim    |

- **分段**：所属段在前、非所属段在后，两段之间插一个 dim 的 `│`（`check-tui-compliance.ts:274` 只报成对 `┌┐└┘`，孤立 `│` 属树形 connector 豁免）。所属为空时**不画分隔符**——「整排没有分界」本身就是「没有所属段」的信号。
- **尾注**：所属集合为空时，追加 dim 尾注 `本目录未加入任何组织`；**单 org 时也显示该尾注**（现状 `board.ts:650` 在 `orgNames.length <= 1` 时完全不渲染 tab 行，单 org 且非我所属时人零提示）。
- 当前 tab 仍取 accent+bold（比非所属的 dim 更亮），**不构成歧义**——标题行 `── org:<名>`（`board.ts:622`）已独立指明当前 org。

**为什么不只靠颜色**：D3 决定 N=0 时整排 dim，此时 dim 失去对比项；叠加单色终端与色盲，颜色必须有一个不依赖它的结构性信号（分段）与语义化解释（尾注）。

**成本实测（「信息过多」的回应）**：

| 场景             | 现状             | 本决策             | 增量                                |
| ---------------- | ---------------- | ------------------ | ----------------------------------- |
| 多 org，所属非空 | `[甲] [乙] [丙]` | `[甲] │ [乙] [丙]` | +1 字符（分隔符，两侧复用现有空格） |
| 多 org，所属为空 | 同上             | 同上 + 尾注        | +1 行（仅此场景）                   |
| 单 org，所属非空 | 无 tab 行        | 同                 | 0                                   |
| 单 org，所属为空 | 无 tab 行        | 尾注 1 行          | +1 行（现状为盲）                   |

### D7 感知覆盖：当前 org 走权威判据，其余 org 走廉价判据（pid 存活）

用户诉求是「**其他组织**成员上线，TUI 里无法马上知道」。今天非当前 org 压根不被探测（不是慢，是没有），所以覆盖面必须先定。

三条已实测的事实决定了方案形状：

1. **探活不是 `connect()`，是一次完整 RPC 往返**：`isSocketAlive`（`util.ts:214`）发 `{type:'ping'}` 等回包，1.2s 超时；`control` 侧对 `ping` 回 `success:false "Unsupported command: ping"`（`control/index.ts:812`），而 `rpcCall` 收到**任何** response 即 resolve —— 它实际测的是「这个 socket 有人应答」，符合设计意图，但成本是跨进程 JSON 往返。
2. **探测在成员侧无写副作用**：`handleCommand` 每回包调 `syncAlias`，但 alias 未变时立即 return（`control/index.ts:412`）→ 不违反 ADR-0040 D4 的「感知不写副作用」。
3. **推送取代不了轮询**：成员被 SIGKILL 时 `clearRuntime` 跑不到 → `runtime/<名>.json` **残留**且**无任何 fs 事件**。「进程死没死」只有 socket 探活能答。

决策：

| 范围         | 判据                                                                               | 理由                                                                                         |
| ------------ | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **当前 org** | 权威：`inspectMembers`（runtime + RPC 探活，四态齐全）                             | 人正在看的必须精确                                                                           |
| **其余 org** | 廉价：`runtime` 记录存在 ∧ `isPidAlive(pid)`（signal-0，零 IPC），只求「在岗计数」 | `isPidAlive`（`presence.ts:156`）已存在；非当前 org 只需要回答"有几个人在岗"，不需要四态精度 |

**接受的精度损失**：该判据偏乐观——「进程在但 socket 已断」（未开 `--session-control`、或 control 服务挂了）在非当前 org 上会算作在岗。切过去时立刻回到权威判据（`loadCurrentOrg` 会重探），误差自愈。

**边界（不单独决策，随本项一并定）**：`sweepStaleRuntime`（删除残留 runtime）**仍只作用于当前 org**——它是写操作，扩到人没在看的组织属于越界（感知与动作分离，ADR-0040 D4）。

### D8 tab 上的在岗计数 = 单格盲文点阵（上限 8，超出显示 `⣿+`）

只编码**在线人数**，不显示分母（决策来源：分母的用途是判断"是否全员"，而那在切过去后的成员视角里已有四态表达，不值得为它占宽）。

编码（`U+2800` 起，**列优先**填充：dot1→2→3→7 左列自上而下，再 dot4→5→6→8 右列）：

| 在线数 | 0   | 1   | 2   | 3   | 4   | 5   | 6   | 7   | 8   | >8   |
| ------ | --- | --- | --- | --- | --- | --- | --- | --- | --- | ---- |
| 字形   | `⠀` | `⠁` | `⠃` | `⠇` | `⡇` | `⡏` | `⡟` | `⡿` | `⣿` | `⣿+` |

- **位置**：名字**后**（`[ 甲 ⠇ ]`）。
- **`0` 用 `U+2800` 空白盲符显式占位**：宽度恒为 1、点位与同行其他 chip 对齐。D7 保证每家都会被探测（非当前 org 走廉价判据、永不失手），所以 `0` 是确定值，不会与"未探测"混淆。
- **`>8` 封顶为 `⣿+`**：单 org 成员数超过 8 在设计上已不合理（`memberQueueCap` 默认 3，README 的唤醒/巡检文案全按个位数写），不值得为它引入更长编码。
- **点阵走独立色**：有在线 → `muted`，无在线 → `dim`。**不吃** chip 的所属 dim——D6 把非所属整枚 chip 压暗，而盲文点比汉字更容易糊成一团；点阵表达的是「在岗」这条正交轴（D6 管名字，点阵管在岗）。
- **不编码忙碌**：原始诉求只问「上线」；忙碌在切过去后由成员视角的四态圆点表达。`accent` 已被 D6 占给「当前 tab」，也不能再让它编码忙碌。

**可行性实测**：`U+2800`–`U+28FF` 全部 `visibleWidth = 1`（含空白盲符）；`check-tui-compliance.ts:48` 的 `EMOJI_RE = /[\p{Extended_Pictographic}\u2713\u2717]/gu` 不含盲文 → 门禁通过。

**宽度**（名字 2 字）：`[ 甲 ]` = 5 → 盲文 `[ 甲 ⠇ ]` = 8 → 数字形态 `[ 甲 2/5 ]` = 9。盲文**比数字省 1 字符/家**，宽度担忧因此反转。

**被否决的两种「以此类推」读法**（记录理由，避免以后重开）：

- **R2 base-8 数位**（`9` → `⣿⠁`、`16` → `⣿⣿`、`20` → `⣿⣿⡇`）：精确、有界（n≤8 一格，9–64 两格），是「更多以此类推」的字面实现。否决理由 = 单 org 成员数设计上 ≤8，精度无收益。
- **R3 字面加符号**（`9` → `⣿+`、`12` → `⣿++++`、`16` → `⣿++++++++`）：宽度线性爆炸（12 人占 12 字符），会把 tab 行撑爆。

### D9 静态简报的 `forceSystemPrompt` 写法：**不改，只登记**

`index.ts:878` 返回 `{ systemPrompt: event.systemPrompt + '\n\n' + staticBriefing }`，1.4 下等价于设 `forceSystemPrompt`（`runner.js:1147`）。**决策 = 保持现状**，理由是实测下来的危害只有成本、没有正确性：见下。

**正确认识这个危害（第一版记录曾说过头，此处为订正）**：

- 它**不**破坏别的插件的 section：`_preparePromptAndToolLoadout` 的注释明写 forced prompt 不影响 transcript，sections 照样 diff 并持久化。
- 真实机制是 `_installAgentForcedPromptProjection`（`agent-session.js:1366`）在请求前把所有 system 消息塌成一个 head：
  `return [head, ...transformed.filter(m => m.role !== 'system')]`。
  于是 1.4 的「中段改系统提示 = 追加 section patch、保住已缓存前缀」这条优化**对全进程失效**。
- 具体到 org：`/org on`／`/org off` 会 `setActiveTools` 改工具集 → 工具段与规则段都变 → 有 force 时 head 整段变化 → provider 缓存从第一个 token 起失效；无 force 时只是追加一个小 patch，原前缀仍命中。
- **量化**：一个成员会话里 `/org on`、`/org off`、preset 切换各一两次，每次是一次全量系统提示重读（本仓系统提示含 AGENTS.md project context，量级数万 token）。**没有正确性问题，只有成本与延迟。**

**现状实测**：`secret-firewall` 在 `user-install`、`enabled = true`（`src/index.ts:9`）、每轮返回 `systemPrompt`（`:147/:150`）→ 该优化在本机当前对**所有**插件都是死的。全仓共 6 处同写法：`auto/org/index.ts:878`、`context/goal.ts:626`、`context/claude-rules.ts:79`、`security/secret-firewall/src/index.ts:150`、`context/resources-tree/index.ts:130`、`context/DEMO:prompt-customizer.ts:107`。

**为什么决定不改**：只改 org 拿不到任何收益（secret-firewall 仍压着）；要兑现得 6 处一起迁，而那是跨插件重构，与 ADR-0067 决策 7（「D 类候选一律不主动实施」）和 AGENTS.md 精准修改原则都冲突。用户判断此项"不会有体验上差异"，故**登记为已知、不在本轮实施**。

**若以后要重开此项**，最小可行组合 = `org` + `secret-firewall` 各改一行（org 改用 `systemPromptOptions.sections['org-briefing']`——名称合法，`/^[a-z][a-z0-9_-]*$/` 允许连字符，渲染位置在 `cwd` 之后即今天的位置；`secret-firewall` 同理），验收方式 = 同一会话内看 `/org off` 前后的 token 用量。

### D10 `isTTY` → `ctx.mode === 'tui'`（终端专用组件的唯一判据）

`index.ts:1074` 用 `process.stdout.isTTY` 决定能否开看板面板。实测四种组合：

| 场景                              | `isTTY`        | 实际发生                                                                                                                                                   |
| --------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TUI                               | true           | 正常开面板                                                                                                                                                 |
| RPC（管道 stdout）                | false          | 回落 `respond(HELP)` —— **意外正确**                                                                                                                       |
| print（`pi -p "/org"`，终端里跑） | **true**       | 调 `ctx.ui.custom`，而该模式 `uiContext = noOpUIContext`、`custom: async () => undefined`（`runner.js:132/147`）→ **面板不开、HELP 也不打印 = 静默无输出** |
| `--mode json`                     | 视 stdout 而定 | 同上                                                                                                                                                       |

**决策：改用 `ctx.mode === 'tui'`。** 现状是「用错的判据碰巧得出大致对的结论」，唯一漏的是 print/json + TTY 组合；ADR-0068 D8 已把 `ctx.mode === 'tui'` 定为终端专用组件的判据（RPC 下 `hasUI` 为真但 `custom` 是空实现，正是这个坑）。非 tui 模式退化为 `respond(HELP)` 文本。

### D11 `setActiveTools` 缩减活动集：登记为 ADR-0065 的**已知例外**，不改代码

`capability.ts:61` 在 `/org off` 时把 org 工具移出活动集。按 ADR-0065 字面（「其它扩展不得用 `setActiveTools` 缩减活动集」），org 是全仓**唯一**实际违规者（实测：只有 `meta/preset` 与 `auto/org` 调它；`accuracy/edit/index.ts:11` 明确写着"不碰"）。

**为什么不改**：

- `defaultActive: false` **替代不了**它——pi 没有 `unregisterTool`，撤回工具的唯一手段就是 `setActiveTools`；`defaultActive` 只影响"注册那一刻是否自动激活"，而 org 本来只在在岗时才注册（`/org on` 时甚至无需调 `setActiveTools`，见 `capability.ts` 头注释）。
- org 缩的是**自己的**工具，不是别人的 → 属**自门控**，与 ADR-0065 要禁止的"限制他人工具"不同型。

**登记要求**：在 ADR-0065 的例外清单里写明本条，并注明「org 与 preset 封闭集叠加时是否真冲突」需单独实测后才能降低这条例外的级别（不在本轮实施）。

### D12 状态栏 `|org: x/y/z成员` 的计数口径改为「所属并集」（**修订 ADR-0043 `D3`**）

背景①已把 `index.ts:471`「状态栏只统计 `me.orgs[0]`」列为同源的「首组织假设」缺陷。决策：

- **口径**：`x`（在岗且忙）/`y`（在岗）/`z`（成员数）一律按**本目录所属全部 org 的成员并集**统计，并按**成员名去重**——同一目录在各 org 里名字相同（名字来自 manifest 或目录 basename，与 org 无关），故同名即同一名成员；同名不同人会被并成一条（罕见，只影响计数展示）。
- **冲突取最活跃**：同一成员在某家残留 `sleeping` runtime、在另一家已上岗时，取最活跃的那条（`presence.ts` 的 `mergePresenceStates`），否则旧残留会把已上岗的统计拉低。
- **仍是单段显示**，不做「org:1/2/3 · org2:0/1/1」并排（ADR-0043 落地记录 #1 对并排的判断不变）。
- **因此修订 ADR-0043 `D3`**：`z` 不再是「**本 org** 注册成员数」，而是「**所属并集去重后的成员数**」；单 org 场景下两者相等，故对多数用户无可见差异。

## 结论：本 ADR 不引入任何推送机制

原始诉求含「是否要有通知机制让别的 pi 上线时刷新感知」。**决策 = 不引入 `fs.watch`／跨进程事件／socket 推送**，理由由 D7 直接推出：

1. 真正的缺口不是延迟，而是**覆盖面**——非当前 org 此前完全不被探测。D7 用「廉价 pid 判据」把覆盖面补到全部 org，且成本几乎为零。
2. 推送**取代不了**轮询：SIGKILL 后 runtime 文件残留且无任何 fs 事件，「进程死没死」只有 socket 探活能答（D7 事实 1/3）。
3. 于是 `fs.watch` 的全部收益 = 把当前 org 的感知延迟从 ≤4s 降到 ~0.1s，代价是多一条失败模式（监听目录不存在、原子写产生的 rename 抖动、macOS/Linux 行为差异、降级分支）。按「简洁优先」，不值。

保留 4s 巡检（`PRESENCE_POLL_MS`）作为唯一时间源。若以后实测「4s 太钝」成为真实痛点，再单独评估。

## 实施状态（2026-10-28）

| 项                                   | 状态                     | 落点                                                                                                                                                                                                                                               |
| ------------------------------------ | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1–D5 所属判定 / 排序 / 重排跟名     | **已实施**               | 新增纯函数模块 `orgtabs.ts`（`orderOrgTabs` / `remapOrgIdxByName`）；看板持有 `ownOrgs` + `lastDispatchAt`，命令层把 `me.orgs` 的 org 名传进去（旧 `meOrgPref()` 已删除）；排序键由 `task.ts` 的 `lastDispatchAt()`（= `max(task.createdAt)`）提供 |
| D6–D8 视觉 / 分段 / 尾注 / 盲文点阵  | **已实施**               | `orgChip()` 三段着色（名字段 / 点阵 / 括号），点阵独立取色；分隔符与尾注在 `render()` 的 tab 行                                                                                                                                                    |
| D7 覆盖面（当前权威 / 其余廉价）     | **已实施**               | `presence.ts` 新增 `countOnlineByPid()`；看板 `refreshOnlineCounts()` 每拍跟随巡检刷新；`sweepStaleRuntime` 仍只作用于当前 org                                                                                                                     |
| D9 静态简报 `forceSystemPrompt` 写法 | **未实施（登记为已知）** | 见 D9「为什么决定不改」                                                                                                                                                                                                                            |
| D10 `ctx.mode === 'tui'`             | **已实施**               | `/org` 无参分支的判据已从 `process.stdout.isTTY` 改为运行时模式；非 tui 回落文本帮助                                                                                                                                                               |
| D11 `setActiveTools` 自门控例外      | **未改代码（登记）**     | 例外条目已写入 ADR-0065「已知限制」                                                                                                                                                                                                                |
| D12 状态栏按所属并集计数             | **已实施**               | `index.ts` 的 `refreshStatus()` 用 `presence.ts` 的 `mergePresenceStates()` 合并全部所属组织（按成员名去重、冲突取最活跃）后再 `countOrgStatus()`                                                                                                  |
| 不引入推送机制                       | **已实施（= 不做）**     | 巡检仍是 4s 唯一时间源                                                                                                                                                                                                                             |

**实施中发现的补强**：`非所属段只按名字母序` 意味着**别家派活不会让 tab 跳动**——比 D2/D4 起草时假设的"非当前 org 顺序可能陈旧"更稳，因此 `r` 手动刷新也顺带重算全部排序键（否则人会觉得 `r` 没生效）。**所属集合则随面板内的新建/改名/加入/删除/踢退自己各自重算**——它们都改变了「本目录属于谁」这条目录事实；外部进程改注册表不在覆盖范围，重开面板即恢复。tab 上的在岗点阵也在这四处动作后立刻重算（否则当前 org 换了而点阵停在上一次的旧值，最长等一拍 4s）。

**测试**：`test/vitest/extensions/org.orgtabs.test.ts`（纯函数穷举）、`org.board-own.test.ts`（看板级：落点 / 排序 / 重排跟名 / 四态配色 / 分段 / 尾注 / 点阵 / 双判据 / 面板内新建与改名后所属即时刷新）、`org.presence.test.ts`（`mergePresenceStates` 多所属合并、`countOnlineByPid` 的「读不到必须抛」契约）、`org.board.test.ts`（既有 65 例回归，chip 断言改为形状正则）、e2e TUI `所属组织排最前 + 分段符 + 盲文在岗点数`。
