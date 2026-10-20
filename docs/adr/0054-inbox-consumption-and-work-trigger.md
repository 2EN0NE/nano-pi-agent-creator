# ADR-0054: 收件箱消化闭环与「有活即动」触发

- 状态：**已接受**（2026-09-14）：人类确认 `D3`「上线即触发」的 LLM 成本取舍、裁定 `D6`「不做」（理由见 `D6`）。落地票见文末「落地票」与 `.scratch/org-inbox-priority/issues/`
- 相关组件：`extensions/auto/org`（`index.ts` 上岗注册与通知、`dispatch.ts` 投递与收件箱、`briefing.ts` 动态简报）、`extensions/auto/control`（`send` 的投递与触发）
- 延伸：**补齐** ADR-0040 `D1`/`D2` 的「inbox 兜底」半句（当时只承诺"任务不丢"，未定义"何时被消化"）；沿用 ADR-0039 §F「在线投递三态分类」、ADR-0045（自主闭环的验证面）、ADR-0047（不静默）、ADR-0052/0053（可观测与人工干预）
- 术语：见 `CONTEXT.md`（多 agent 框架节：在岗 / 睡眠 / 收件箱兜底 / 在岗简报）。**本文新增**：投递（delivery）与触发（trigger）的区分，见 `D1`

## 背景

### 事实 1：投递与触发是两条独立的路，且只有一条能自动触发

| 接收方状态                              | 走哪条路                              | 会触发一轮？   | 内容可见性                    | 来源                                            |
| --------------------------------------- | ------------------------------------- | -------------- | ----------------------------- | ----------------------------------------------- |
| 在岗 + socket 就绪                      | control `send`（`triggerTurn: true`） | 是（立即）     | 完整                          | `control/index.ts:800-806`                      |
| 在岗但正在跑                            | 同上，模式固定 `follow_up`            | 排队等本轮跑完 | 完整                          | `dispatch.ts:247`                               |
| 睡眠（进程不在）                        | 落 `inbox/`（任务不丢）               | **否**         | 要等下次 `session_start` 补投 | `dispatch.ts:239-275`                           |
| **启动窗口**（进程已起、socket 未就绪） | 落 `inbox/`                           | **否**         | **只剩计数**                  | 同左，且 `takeInbox` 只在 `index.ts:560` 调一次 |
| `send` 回报超时                         | 不落 inbox，返回 `uncertain`          | —              | 如实展示（人工决定是否重派）  | `dispatch.ts:256-260`（ADR-0039 §F）            |

### 事实 2：收件箱只有一个消化者，且只在上线那一刻出现

- `takeInbox`（读 + 删）全仓**只有一处调用**：上岗注册（`index.ts:560`）；
- 此后**再无任何路径**消化 `inbox/`：`drainInbox` 仅被动态简报用于**取计数**（`briefing.ts:121`，peek 不删）；presence 定时器（`index.ts:479`）不碰 inbox，也没有任何轮询/自愈；
- ⇒ 上线之后落进 `inbox/` 的消息**没有消化者**，只会以 `inbox N` 的形式出现在简报里（`briefing.ts:124-126`）——**内容不可见，也不会触发**。

### 事实 3：上岗时的两条通知都明确"不触发"

`index.ts:562-569`（inbox 补投）与 `index.ts:585-592`（启动提醒）都用 `{ triggerTurn: false }`：内容进了上下文，**但没有任何东西让它跑起来**。

### 事实 4：pi 的队列是"进程内、轮次内"的，跨进程没有队列

`sendCustomMessage` 的四分支（本地权威：`dist/core/agent-session.js:1099-1132`；文档 `docs/extensions.md:1432-1437`）：

- `deliverAs: 'nextTurn'` → 挂起等待下一次用户输入（**不触发**）；
- 正在跑 + `steer`（默认）→ 当前工具调用结束后、下一次 LLM 调用前插入；
- 正在跑 + `followUp` → 等它把当前轮跑完；
- **空闲 + `triggerTurn: true`** → `_runAgentPrompt(...)` **立即起一轮**。

⇒ 「队列」只存在于**活着的进程**里；跨进程的**唯一**持久队列就是文件 `inbox/`。因此"投递可靠"与"能被处理"之间隔着一个**必须由接收方主动完成的动作**（上线时的消化 + 触发）。当前实现只做了前半，且只做了一次。

### 事实 5：一次真实 UAT（2026-09-14）

人类把一个任务改派给睡眠成员 `chief`（任务历史 `human_forced_reassign@09-14T07:57`，落 inbox）；随后在看板按 `w` 唤醒它——成员进程确实起来了，**任务却始终停在 `chief: 待领取`**：唤醒只带来了"不触发"的补投通知。

## 决策

### D1 术语与责任划分：投递 ≠ 触发

- **投递（delivery）** = 把消息放到权威落点（在线送达是**优化路径**，`inbox/` 是**权威路径**）；
- **触发（trigger）** = 让接收方**开始一轮**去处理它；
- 本 ADR 要求：**一旦投递被接受，就必须最终发生触发**；且这个保证由**接收方**承担（投递方不跨进程去"启动"别人——保持 ADR-0048 的授权面不变）。

### D2 权威落点唯一：`inbox/`

沿用 ADR-0039 §F 的三态与「`uncertain` 不落 inbox」的取舍；**不引入第二套持久队列**（避免双写与顺序歧义）。

### D3 上线即触发（有待办才触发）

成员上线（`session_start` / 上岗）时，若**存在可执行内容**（inbox 非空，或存在未决握手）→ 以 `triggerTurn: true` 注入并起一轮；**无可执行内容则维持现状（不触发）**。

- 可行性：`deliverAs` 默认 `steer`（`agent-session.js:1116`），空闲时走 `_runAgentPrompt`（`agent-session.js:1120-1122`）⇒ 语法与语义都成立；启动期时序需 e2e 实测（见「验证」）。
- **成本**：每次上线**最多**多一轮 LLM 调用，且仅在有活时（**人类已确认接受**，2026-09-14）。

### D4 在岗自愈：在岗 + 空闲 + inbox 非空 ⇒ 触发

启动窗口或运行期落进 `inbox/` 的消息，必须在成员**下一次处于「在岗且空闲」时**被触发处理（presence 轮询或轮次边界检查）。

- **防抖**：同一批消息只触发一次（幂等键 = 消息 id 集合或"已消化水位"），避免巡检把同一件事反复喂给模型。
- **监听策略（抄 `pi-subagents-1`）**：文件监听抽象为策略——macOS 用原生 `fs.watch`（更快、更省电），其他平台回退轮询；**轮询始终保留为兜底**（watch 事件可能丢）。参考：`src/shared/watch-strategy.ts`（策略枚举 `runner-control-inbox` / `child-steering-inbox`，`darwin` 之外一律轮询）。
- **占用回收必须保守（抄 `pi-subagents-1`）**：「在跑」的占用只能**在证明已死**时回收（PID 存活校验 + 失败状态证据），时间阈值仅作兜底；不得"超时就当死了"——否则会把活着的成员判死、重复派活。参考：`src/runs/background/active-async-capacity.ts`（`abandonedSlotReleaseAfterMs` 默认 20min、钳位 5min–24h、可禁用；且要求 `status.state === 'failed'`）与 `stale-run-reconciler.ts`（PID 存活）。

### D5 内容必须可见（不能只暴露计数）

动态简报把 inbox 从"仅计数"升级为"**计数 + 内容清单**"；**peek 不删**，删除只在**成功注入上下文之后**发生（保证「至少一次可发现」）。

- 理由：计数可见而内容不可见 = agent 知道"有事"却不知道该干什么，只能靠猜或**自己发明路径**（开脚本读内部文件）——与 ADR-0048 记录的失败模式同源。

### D6 成员自查入口：**不做**（人类裁定，2026-09-14）

曾考虑新增只读工具 `org_inbox`（列出自己收件箱的内容）。**裁定不做**：

- `D5` 落地后「计数可见、内容不可见」的问题已被解决（每轮简报都带内容清单），该工具与之高度重叠；
- 简洁优先：不为"可能用到"发明工具（AGENTS.md「不做未被要求的功能」）；生态参考实现也没有同类工具；
- 重新考虑的触发条件：若实测发现"成员在**同一轮内**落过 inbox 而它自己意识不到（例如长时间在岗且简报被截断）"，再作为 `D5` 的兜底补上。

### D7 投递幂等标识

每条 inbox 记录带稳定 id（现有文件名 `msg-<时间戳>-<随机后缀>` 可作初版），**注入时把该 id 带进消息体**，使"重复注入 / 重试投递"可被识别。

- 现状：`inboxHasMessage` 按**内容**去重（`dispatch.ts:269`）——重试文案加了"上次说明"就不同，无法去重；
- **不做** exactly-once 承诺：账本状态机才是终局防线（重复 claim 已被拒，`index.ts:1245`）。

### D8 可观测（验证的前提）

上线消化、触发、自愈、防抖跳过**都要留痕**（logger `org`），字段至少含：`org` / `member` / 消息条数 / 是否触发 / 原因（无内容 / 防抖命中）。

### D9 送达责任归属（抄 `pi-subagents-1`）

投递**谁负责送**必须显式建模，覆盖会话轮转与 `/reload` 场景：

- 参考实现用 `completionOwnerId` + 「可认领前驱会话列表」（上限 8）来保证**同一份结果只由一个会话投递**（`src/runs/background/result-delivery-ownership.ts`）；
- org 对应问题：成员进程 `/reload`、会话轮转、看板与 chief 同时想投递 → 现有实现没有"谁拥有这次投递"的概念，存在**双投**（重复指令）与**漏投**（都以为对方会送）两种风险；
- 决策：**投递动作带归属标记**（谁发起、针对哪个 session/轮次），归属不匹配时不投递并留痕；会话轮转时显式交接（抄其"认领前驱"语义）。

### D10 完成侧去重 / 批量 / 重放（抄 `pi-subagents-1`）

`D7` 只覆盖了**投递侧**；**回来的一侧**（交付、完成、失败通知）同样需要：

- 参考实现把三者拆成独立设施：`completion-dedupe.ts`（去重）、`completion-batcher.ts`（批量，避免一次注入 N 条打断成员）、`completion-replay.ts`（重放，供重启/重连后补齐）；
- org 对应风险：同一份交付被处理两次 ≈ **重复验收**（账本有状态机保护，但会浪费一轮 LLM 并可能触发误判）；
- 决策：完成类事件也带**稳定 id**，接收侧按 id 去重，并支持"批量注入一次"与"重放未消费的"。

### D11 注入成功才删除（顺序不可颠倒）

当前实现是 `takeInbox`（**读 + 删**）→ 再 `pi.sendMessage(...)`（`index.ts:560-569`）：**删除发生在注入之前**，一旦注入失败（异常、会话不可用），消息就永久消失。

- 参考实现相反：处理成功后才 `unlink`，写结果失败则**保留请求待重试**（`fanout-child.ts:120-128` 的 `pendingResults` + 只在成功后删除）；
- 决策：改为**先注入成功、再删除**（等价于 peek → inject → ack）；删除失败只导致重复注入（由 `D7` 幂等吸收），不允许出现"删了但没送到"。

## 后果

- 补齐 ADR-0040「自动唤醒闭环」缺的另一半：**唤醒 = 有人接管待办**，而不是"通知已送达"。
- 消除两类静默滞留：① 睡眠后被唤醒；② 启动窗口期落 inbox。
- 成本：每次上线若有待办即多一轮 LLM 调用（可接受，且仅在有活时）。
- 风险：多 org 成员可能连续触发多轮（`index.ts:559-571` 逐 org 循环）——需实测 pi 是合并为"一轮 + N 次 steer"还是 N 轮；若为 N 轮，`D3` 必须先聚合再**单次**注入。
- 与 autoWake 叠加**不会**双触发：在线投递成功时 inbox 为空（`D3` 不触发）；落 inbox 时在线投递未发生 ⇒ 恰好一轮。
- 按 `D9`–`D11` 抄齐后，投递侧与完成侧**两侧**都有幂等与归属，`/reload`、会话轮转、进程重启不再产生双投/漏投/丢消息。
- 代价：多了三类持久标记（归属、完成 id、占用租约），需要与 ADR-0055 的"执行槽 / 排队上限"共用同一套回收与巡检逻辑，避免两套巡检打架。

## 验证

1. **e2e（核心）**：睡眠成员名下有 inbox 待办 → 唤醒 → 断言任务**从 `invited` 变 `claimed`**（不只是"有通知"），且日志出现"上线补投 + 触发"。
2. **e2e（启动窗口）**：在"进程已起、socket 未就绪"的窗口内投递 → 断言消息**在其下一轮被看到内容并被处理**（而不是只剩计数）。
3. **e2e（不白烧）**：无待办时上线 → 断言**没有**新增 LLM 轮（用 mock-llm 的调用计数）。
4. **单测**：消息 id 幂等（重复注入不再触发第二次）；简报内容化（peek 不删）。

## 参考

- **pi 本地权威**：`dist/core/agent-session.js:1099-1132`（`sendCustomMessage` 四分支）、`docs/extensions.md:1432-1437`（`deliverAs` / `triggerTurn` 语义）。
- **本仓既有决策**：ADR-0039 §F（投递三态）、ADR-0040 `D1`/`D2`（唤醒与 inbox 兜底）、ADR-0043（在岗判定）、ADR-0044（消息来源头）、ADR-0045（自主闭环验证）、ADR-0047（不静默 / 面人通道）、ADR-0048（autoWake 门禁与授权面）。
- **生态既有实现（本文多处 "抄" 的来源，均已逐行读过）**：checkout 见 ADR-0038 记录的外参目录 `/Users/jojo/Projects/Development/Agent/pi-plugins/temp/subagents/pi-subagents-1/`
    - `src/extension/fanout-child.ts:77-138`——跨进程 `controlInbox` 目录 + 轮询 + `requestId` 去重（`seen`/`inFlight`）+ 成功后 `unlink`、失败保留重试；
    - `src/shared/watch-strategy.ts:1-15`——监听策略（darwin 原生 watch / 其他平台轮询）；
    - `src/runs/background/active-async-capacity.ts:74,87,141`——执行槽容量：`used/limit` 满了**抛错拒收**、租约（`reservationToken`/`generation`）、僵尸槽回收阈值与保守回收条件；
    - `src/runs/background/result-delivery-ownership.ts:1-40`——送达归属（`completionOwnerId` + 认领前驱会话，上限 8）；
    - `src/runs/background/completion-dedupe.ts` / `completion-batcher.ts` / `completion-replay.ts`——完成侧去重 / 批量 / 重放；
    - `src/runs/background/auto-drain.ts:9,22-30`——自动排空（`hasOutstandingWork` + 30min 超时）——反证 `D4` 自愈是这类框架的标配；
    - `src/runs/background/stale-run-reconciler.ts`——PID 存活 + 陈旧回收。
- **外部权威**：
    - **Erlang/OTP 并发模型**（进程邮箱 + 显式接收；"从不接收的进程只是堆积消息"是公认反模式）：_Concurrent Programming — Erlang System Documentation_，<https://www.erlang.org/doc/system/conc_prog.html> （已核验可达，2026-09-14）；
    - **at-least-once 投递**（行业默认语义：不承诺 exactly-once，而由接收侧幂等兜底）：_Amazon SQS at-least-once delivery_，<https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/standard-queues-at-least-once-delivery.html> （已核验）；
    - **去重标识**：_Using the message deduplication ID in Amazon SQS_，<https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/using-messagededuplicationid-property.html> （已核验）；
    - 通用实践（**未**逐条核验页面内容）：Stripe 的 `Idempotency-Key`（重试安全）、Google SRE 的"事故分级 + 明确升级路径"。

## 落地票（`.scratch/org-inbox-priority/issues/`）

| 票                                           | 对应决策     | 阻塞者 |
| -------------------------------------------- | ------------ | ------ |
| 01 上线即触发（含 `D11` 注入成功才删）       | `D3` / `D11` | 无     |
| 02 在岗自愈触发 + 防抖                       | `D4`         | 01     |
| 03 动态简报内容化                            | `D5`         | 无     |
| 04 inbox 幂等标识                            | `D7`         | 无     |
| 05 完成侧去重 / 批量 / 重放                  | `D10`        | 无     |
| 06 送达责任归属                              | `D9`         | 无     |
| 07 执行槽与占用租约（与 ADR-0055 `D2` 共用） | `D2` / `D8`  | 无     |

> `D6` 不做，故无对应票。
