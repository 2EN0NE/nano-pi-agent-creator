# ADR-0036: custom-compaction 触发与选择范式升级——启用集 + per-profile 触发 + 路由规则

- 状态：已接受（2026-09）
- 相关组件：`extensions/context/custom-compaction`（`config.ts`、`trigger.ts`、`index.ts`、`settings-ui.ts`、`settings-panel.ts`、`status.ts`、`switch.ts`）
- 延伸：ADR-0021（auto-switch 骨架）、ADR-0023（TUI 视觉规范）、ADR-0035（preset 单选交互范式）
- 术语：见 `CONTEXT.md`（启用集 / 触发集 / 触发条件 / 触发粒度 / 选择算法 / 路由规则）

## 背景

custom-compaction 此前是「**单一 active profile**」模型：`config.activeProfileId` 存一个活跃
profile，`getEffectiveProfile(modelSpec)` 用 `matchModel` 做模型感知覆盖（最具体匹配优先），
回退到 active profile。这个模型无法表达用户的真实诉求——「**多个 profile 并存，按会话环境
（当前模型、会话复杂度）在触发时择优执行一个**」。

具体痛点：

1. 一个 profile 只能被二选一「激活」，无法「武装多个候选、触发时按优先级择一」；
2. 「何时压缩」（触发条件）与「选谁压缩」（选择）耦合在一起，触发条件只有单一 context 阈值；
3. 用户有大量实验 profile，但只能有一个生效，实验与日常配置互相挤占；
4. widget 分子（context 用量）只在离散事件刷新，与 pi 原生 footer 的实时百分比脱节。

## 决策

### 1. 范式：启用集 → per-profile 触发条件 → 触发集 → 路由规则择一

把「单一 active profile」替换为四段式决策链（术语定义见 CONTEXT.md）：

```text
启用集（Space 勾选，第一道闸）
  → per-profile 触发条件评估（触发粒度控制频率）
  → 触发集（启用 ∩ 满足触发，第二道闸）
  → 选择算法（路由规则 → 阈值 tiebreak → 兜底）择一执行
```

- **启用集（Enabled Set）**：用户在 settings 面板一级列表用 `Space` 勾选「启用/停用」。
  列表只是展示，未启用的 profile（含实验项）**完全不参与**触发评估。取代旧的
  `activeProfileId` 的「参与」语义。
- **触发条件（per-profile、多维）**：每个 profile 各自持有「信号源 + 阈值 + 方向」判定规则，
  不再只是单一 context 阈值。信号源架构上可扩展（`context_percent` / `fixed` / `reserve` /
  工具调用次数等）；首个落地信号源仍是 context 三类，工具次数为已规划扩展点。
- **触发粒度**：触发评估频率三档——`user turn`（用户发言提交）/ `agent turn`（一轮 agent 结束，
  **默认**）/ `工具处理粒度`（每次工具调用完成）。越细越能及时捕获 context 暴涨，评估开销越大。
- **选择算法**：从触发集中择一，三层形态（**非**排序字段）：
    1. **路由规则（有序）**：`当 [环境条件] 满足 → 指定 profile`，规则有序、首条命中生效。
       环境条件维度目前为：模型（matchModel 降级为「模型→profile」规则）、复杂度等级
       （`level` 三档 low/medium/high，来自 pi-session-tree；6 维指标留作扩展）。
    2. **阈值 tiebreak**：命中后候选仍 >1 时，按触发阈值排序取一（正序/倒序）。
    3. **兜底**：无规则命中 → tiebreak（阈值排序取一）。

### 2. matchModel 降级为路由规则的一个条件维度

不再保留独立的「模型硬过滤层」。原 `getEffectiveProfile` 的 matchModel 最具体匹配优先逻辑，
改为「模型→profile」路由规则（有序规则表里的一条）。两层职责统一为：路由规则回答「当前环境下
谁合适」，tiebreak 回答「合适者里谁最优」。

### 3. widget 分子刷新：事件驱动，对齐 pi 原生 footer

- `ctx.getContextUsage()` 是实时计算（无缓存），根因是 `updateStatus()` 调用时机太稀疏。
- 改为监听 `message_end`（对 user / assistant / toolResult 三类消息都触发，即每次工具调用完成
  都触发一次）刷新 widget；流式 `message_update` **不**刷新（逐 token 刷会高频触发 TUI 重绘，
  且流式中分子本就是近似估算，收益低）。
- 不用定时器（扩展运行时 `setInterval/setTimeout` 回调不执行）。

### 4. 触发粒度与 widget 刷新的关系

widget 刷新（`message_end`）是**展示层**的、始终最细；触发粒度是**评估层**的、用户可配。
两者独立：触发粒度决定「多久评估一次是否压缩」，widget 刷新只保证「分子数值看得见、跟得上」。

## 默认决策（收尾，随本文一并确认）

1. **新 profile 默认停用**：创建后需手动 `Space` 启用才参与评估。理由：用户有大量实验
   profile，默认停用避免实验项意外挤占日常压缩。
2. **启用集不得为空**：`Space` 全关时**提醒**（强制至少一个启用），而非静默禁用自动压缩。
   理由：自动压缩是安全网，静默禁用会让用户在不知情时失去压缩保护。
3. **旧配置迁移**：迁移默认开启 `default` profile（`createDefaultConfig` 保证其始终存在），
   保证启用集非空；`activeProfileId` 不再迁移。`matchModel` 迁移为一条「模型→profile」路由
   规则。迁移幂等，不重复生成。

## 后果

**正面**：能表达「按模型/复杂度择优 + 多实验 profile 并存只启用少数」的真实场景；触发与选择
解耦，两者各自可独立扩展（新增信号源、新增路由条件维度）；widget 数值与 pi 原生对齐。

**负面/代价**：settings 面板交互与配置 schema 需改造（Space 勾选、路由规则编辑器、触发粒度
选择器）；评估逻辑从「单 profile 判触发」变为「对启用集逐 profile 评估 + 路由」，触发评估开销
随启用集大小与触发粒度线性增长（工具处理粒度下每工具调用评估一次）。

**迁移风险**：旧 `activeProfileId`/`matchModel` 语义 → 新模型的映射需保证幂等与向后兼容；
`switch.ts` 的 `ProfileSource`（manual/matchModel/auto）骨架与「路由规则」的关系需在实现时
对齐或废弃。
