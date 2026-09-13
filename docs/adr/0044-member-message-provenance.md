# ADR-0044: 成员消息溯源

- 状态：**已接受**（2026-09-11；D1–D5 **已落地**，单测 + 契约测试防漂移）
- 相关组件：`extensions/auto/org`（`dispatch.ts` `deliverMessage` / `index.ts` / `briefing.ts`）、`extensions/auto/control`（消息注入 + renderer + `<sender_info>`）
- 延伸：落实 ADR-0042 `D2`（静态简报承载来源约定）；向 `CONTEXT.md` 补术语（成员消息 / 发送者头）
- 术语：见 `CONTEXT.md`（多 agent 框架节：成员消息 / 发送者头 / 成员指令）

## 背景

1. **成员消息与人类输入在模型层不可区分**。成员消息经 control 以 `customType:'session-message'` 注入（`control/index.ts` `send` 分支）；`convertToLlm` 把 `custom` 一律压成 `{role:'user', content:原文}`（`pi-coding-agent/dist/core/messages.js`），**`customType` 不进上下文**。→ 模型只能靠正文内容判断来源。
2. **发送者目前只零散写在正文**，不统一、不可机器解析：`buildTaskMessage` 有「由 X 派发」、`buildHandshakeMessage` 有「X 想请你…」，但 board 改派写「人类将任务…」（不说谁）、approve 通知不带来源。
3. **control 已有 `<sender_info>` 机制**（`SENDER_INFO_PATTERN` / `parseSenderInfo` / `stripSenderInfo` / `formatSenderInfo` + `renderSessionMessage` 渲染 `from <sender>`），但 org 走的是 rpc `send`，**不携带**该头。
4. **需求**：成员消息在 TUI 上应呈现为 `[成员名]:` 样式的卡片，且模型知道来源；人和 agent 需要能区分「成员消息」与「人类操作者」。

## 决策

### D1 形态：保持 custom message（方案 C1）

**不**改为真 `sendUserMessage`。理由：成员消息在模型层的可见性已等价于用户文本（`custom → role:user`）；改成真 user message 只会让「人 vs 成员」更难分，并引入 `/` 命令解析、人类轮次语义占位等副作用。TUI 侧继续走自定义卡片（区别于人类用户消息）。

### D2 发送者头：`deliverMessage` 层统一注入

由 `deliverMessage` 统一注入**机器可解析**的发送者头，复用 control 的 `<sender_info>{...}</sender_info>` 约定；**sender 取 org 成员名**（不使用 session 名）。

### D3 显示层：渲染为 `[成员名]:`

TUI 渲染层把发送者头渲染为人读的 `[成员名]:`（卡片头），正文不重复显示机器格式。

### D4 约定落点：系统提示静态块

在**系统提示**静态块（ADR-0042 `D2` 的 `before_agent_start`）中声明：「带发送者头的消息来自 org 成员 agent，不是人类操作者；需要回复用 `/org …` 或成员间消息」。静态 → 会话内恒定 → **不破坏 prompt cache**。

### D5 权限：本轮不做

不做「成员消息 vs 人类消息」的权限不等；本轮只做**标注 + 归因**。信任边界（成员可伪造发送者头，如正文写 `[boss]: …`）留待后续单独决策。

## 落地记录（2026-09-11，待定项已收敛）

1. **字段**：`SenderInfo` **新增 `member` 字段**，与 `sessionId`/`sessionName` **并存**（向后兼容既有解析）。
    - 注入侧（org）：`<sender_info>{"member":"<成员名>"}</sender_info>`（`org/sender.ts`），由 `deliverMessage` **统一注入**；
      **人类操作者发起的投递不注入**（看板改派 / 人工验收通知）→ 人类消息与成员消息据此可分。
    - 解析/呈现侧（control）：`control/sender-info.ts` 抽出为独立模块（原为 index.ts 内联），`senderLabel()` 优先
      `member` → 渲染 `[成员名]:`；无 `member` 时回落 `from <session>`；两者皆无 → 不加标签。
    - 两处各自本地实现（避免 org 加载期硬依赖 control），由 `org.sender.test.ts` 的**契约测试**防格式漂移。
2. **伪造风险**：本轮按 D5 **不做**，留待 security 层单独决策（正文仍可伪造 `[boss]:`，头只是声明）。
3. **历史消息兼容**：无头的消息 `parseSenderInfo` 返回 `null` → `senderLabel` 返回 `null` → 渲染不加标签（已实现并测试）。

## 后果

- **正向**：成员消息有稳定来源，agent 可归因、可回复；TUI 卡片能显式标出「谁在跟我说话」。
- **负向**：`<sender_info>` 只是**声明**，不构成防伪造；正文与头两处可能不一致（需约定以头为准）。
- **注意**：约定进系统提示后，**该静态块内容变化会破坏 prompt cache**，故发送者格式一旦定稿应保持稳定。
