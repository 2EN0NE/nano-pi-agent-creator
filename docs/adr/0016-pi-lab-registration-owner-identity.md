# ADR-0016: pi-lab 注册身份模型与三语义裁决

**状态**: 已接受
**日期**: 2026-08
**背景**: grilling session + domain-modeling 输出

## 问题

1. **假冲突告警**：消费方（edit）在每次 `session_start` 都注册同名实验，而 `ExperimentManager` 是进程级单例、跨 session 持久。`/new` 不重载模块但会再次触发注册，导致「自己覆盖自己」的假冲突告警（`实验 "edit-strategy" 被覆盖: 弱依赖 (bridge) → 弱依赖 (bridge)`）。

2. **无法区分「幂等重注册」与「异插件撞名」**：旧的 source（import/bridge）优先级裁决只有耦合强度一个维度，无法识别「同一个插件跨 session 重复注册」与「两个不同插件注册同名实验」。后者是真实场景——用户级插件（`~/.pi/agent/`）与项目级插件（`.pi/`）可能各注册同名实验，需要可靠的身份识别才能正确裁决。

3. **演进副作用未被感知**：同插件升级改定义（arms/metrics/strategy 变化）会改变采集口径，历史数据与新定义口径不一致，需要让用户感知副作用。

## 决策

### 1. 显式 owner 身份（必填）

`ExperimentDef` 增加必填 `owner: string`。pi-lab 以 `(owner, name)` 二元组识别逻辑实验身份，**不解释 owner 的命名/层级语义**（是否用插件名、是否编码 user/project 级别，均由消费方自行决定）——保持 pi-lab「纯基础设施、不做决策」的定位。

### 2. 三语义裁决

| 已有               | 结果                                            |
| ------------------ | ----------------------------------------------- |
| 无                 | 全新注册，返回新 API                            |
| 同 owner，定义未变 | 幂等重声明，静默返回已存在 API                  |
| 同 owner，定义演进 | 原地更新定义 + warn（含副作用），返回同一实验   |
| 异 owner           | 硬冲突（error + UI 通知），阻断并返回 undefined |

返回值矩阵：全新→新 API；幂等→已存在 API；演进→同一 API；异 owner→`undefined`（消费方判空降级）。

### 3. 定义变化判定范围（definitionDiff）

只比较影响 select/record/stats/query 结果的「口径」字段：

| 字段                                                    | 是否参与 |
| ------------------------------------------------------- | -------- |
| arms（id 集合 + weight）                                | ✅       |
| metrics（id 集合 + type/direction/isGuardrail/derived） | ✅       |
| strategy                                                | ✅       |
| contextKey 为 string                                    | ✅       |
| arm label / metric description（仅展示）                | ❌       |
| contextKey 为 function（每次新建闭包）                  | ⏭️ 跳过  |

### 4. 演进采用原地更新（updateDef），不重建 storage

`record()` 数据在内存缓冲、`session_shutdown` 才落盘。若演进时 `new Experiment` 重建 storage，会丢失未落盘的内存事件。故在 `Experiment` 上新增 `updateDef(strategy, arms, metrics, contextKey)` 原地更新口径字段，仅失效 `forceArmId` 与 query 缓存，保留内存事件与 JSONL 数据。

### 5. 废弃 source 优先级

`registerStrongExperiment` / `registerWeakExperiment` 双轨 API **保留**，但 source 仅表接入方式（import 直接依赖包 vs bridge 经 globalThis 桥接），不再参与冲突裁决。冲突裁决完全由 `(owner, name)` 身份判定。

## 理由

- **撞名是配置错误，不是竞争**：两个不同 owner 声称自己是同一实验的主人，几乎必然是配置错误。fail loud（error + 阻断）比静默「赢家通吃」安全——后者会让 A 插件的事件静默写进 B 插件的 JSONL，数据被污染且无法追溯。
- **显式 owner 是幂等/演进/真冲突三语义的地基**：名字本身不是身份，显式声明才可靠。
- **原地更新避免数据丢失**：append-only JSONL + 内存缓冲的语义一致性，演进不破坏已采集数据。

## 影响

- 所有消费方须显式声明 `owner`（当前唯一消费方 edit 已补 `owner: 'edit'`）。
- register API 返回值可能为 `undefined`，消费方须判空降级（edit 已实现）。
- **ADR-0003 的双轨 API 保留，但 source 优先级裁决被本 ADR 取代**。
- 演进时只 warn 不自动 reset（reset 是破坏性操作，交由用户在 `/lab` 面板显式决定）；`forceArmId` 跨 session 丢失仍维持现状（session 级 UI 状态）。
