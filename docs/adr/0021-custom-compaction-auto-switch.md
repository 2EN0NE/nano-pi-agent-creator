# ADR-0021: custom-compaction 自动切换 profile（接口设计）+ 移除运行时实验覆盖

**状态**: 已接受
**日期**: 2026-08

## 背景

`custom-compaction` 此前经 pi-lab 注册了 3 个「改行为」实验（mechanism / prompt / threshold），在 `agent_end` 与压缩执行时用 `selectArms()` + `applyLabOverrides()` 把实验臂**运行时覆盖**到 profile 的 trigger/mechanism/prompt 上。由此产生「显示 ≠ 运作」的割裂：用户在设置面板看到阈值 20%，但实际生效的是 pi-lab 阈值实验臂（60/70/80%）。用户设置 20% 却迟迟不触发压缩，根因即此。

## 问题

1. **显示/感知/运作不一致**：面板与状态栏显示的是配置值，实际运作的是实验臂覆盖值，用户无法感知自己被覆盖。
2. **架构方向错误**：pi-lab 应是纯数据收集器（收满意度/指标），却被用作「实验设计者」去改变插件行为；插件自己消费 `select()` 的臂去覆盖自身配置。

## 决策

### 1. 实验臂 = profile，移除运行时覆盖

删除 `applyLabOverrides` 的覆盖逻辑与 `selectArms` 选臂路径。**不同的实验变体即不同的 profile**——profile 本身就是 trigger/mechanism/prompt 的完整载体，用户看到的 profile、状态栏显示的 profile id、实际生效的 profile 是同一个实体。行为完全由 profile 配置决定，pi-lab 零介入。

### 2. pi-lab 退化为纯数据收集

只注册 **1 个**实验 `profile-satisfaction`，臂 = 当前 config 的 profile id（`initExperiments` 在 `session_start` 时以 profiles 列表注册）。只 `record` 不 `select`：

- `record` 的 `armId` = 生效 profile.id；
- 过程指标（latency_ms / saved_tokens / summary_length）与满意度（回退 / 重压）都归因到 profile；
- pi-lab 的职责收敛为一句：**「统计哪个 profile 用户更满意」**。

### 3. 自动切换 profile 归属插件自身（本次仅接口设计）

「是否自动切换 profile」是 custom-compaction 自己的决策能力，由插件根据信号自行判断，本次只做接口设计、不实现（decider 不写逻辑、不接线）。接口骨架在 `extensions/context/custom-compaction/switch.ts`。

### 4. 接口签名

| 接口/类型              | 职责                                  | 语义                                                                    |
| ---------------------- | ------------------------------------- | ----------------------------------------------------------------------- |
| `SwitchSignalProvider` | 信号源（弱依赖）                      | `id` + `sample(ctx): Promise<SignalSample \| null>`，缺失返回 null 降级 |
| `SignalSample`         | 信号样本                              | 任意载荷 `{ [k]: unknown }`，由 decider 解释                            |
| `ProfileSwitchDecider` | 决策器（可替换）                      | `decide(ctx, signals): Promise<SwitchDecision \| null>`，null = 不切换  |
| `SwitchDecision`       | 切换决策                              | `{ toProfileId, reason }`，reason 用于 UI 通知/日志                     |
| `ProfileSource`        | 生效 profile 来源（运行时，不持久化） | `'manual' \| 'matchModel' \| 'auto'`                                    |
| `AutoSwitchConfig`     | 自动切换开关                          | `{ enabled: boolean }`，分层 session > project > user，默认全关         |

### 5. 首批信号源（本次不实现）

- `lab-stats`：pi-lab 的 profile 满意度统计；
- `session-complexity`：pi-session-tree 的会话复杂度（`analyzeComplexity()`）。

两者都走 `SwitchSignalProvider` 弱依赖接口，缺失时 `sample` 返回 null 自然降级。

### 6. 触发时机与优先级

- **触发时机**：`agent_end` 时、**「判断是否触发压缩」之前**评估（切换结果会改变用哪个 profile 判断压缩）。
- **优先级**：用户手动激活（`ProfileSource = 'manual'`）锁定，decider 不得覆盖；只有 `matchModel` / `auto` 来源的 profile 才允许被自动切换。

### 7. 会话复杂度分析（本次已实现）

pi-session-tree 新增 `analyzeComplexity(): ComplexityReport`，确定性结构复杂度（零 LLM、绝对复杂度，不引入历史 z-score）：

| 维度                | low(0) | medium(1) | high(2) |
| ------------------- | ------ | --------- | ------- |
| `branchPoints`      | 0      | 1–2       | ≥3      |
| `maxDepth`          | <10    | 10–30     | ≥30     |
| `compactionCount`   | 0      | 1         | ≥2      |
| `toolTypeCount`     | ≤2     | 3–5       | ≥6      |
| `userQuestionCount` | <5     | 5–15      | ≥15     |
| `turnsPerQuestion`  | <2     | 2–5       | ≥5      |

综合等级 = **最高维等级**（`low` / `medium` / `high`），阈值集中在 `index.ts` 的 `COMPLEXITY_THRESHOLDS` 常量、可调。左闭右开：`<med → low, <high → medium, else high`。

## 后果

- 移除覆盖后，用户设置的阈值就是实际触发阈值；面板/状态栏显示值 == 生效值。
- pi-lab 从「实验设计者」降级为「profile 满意度统计器」；插件回到「只给 pi-lab 数据」的干净架构。
- `profile-satisfaction` 的 arms 在 `session_start` 注册时快照为当时的 profile 列表；会话中途新增的 profile 需下次 `session_start`（或 `/reload`）重新注册后才会被 stats 纳入。
- 自动切换的接口面已完整（信号源 + 决策器 + 来源标记 + 分层开关），但 decider 逻辑、provider 实现、`agent_end` 接线均为**未实现**，属后续工作。
