# 领域词汇表

## observability（可观测性）扩展分类

第 8 个扩展顶层分类（`extensions/observability/`），归集以「观测/分析 pi 自身（插件、工具、skill、会话）的运行与效果」为核心目的的插件。

**observability / 可观测性**：
对 pi 自身的插件、工具、skill、会话进行采集 → 存储 → 分析 → 展示的横切能力（含运行遥测、静态清单、有效性评估三类）。
_避免_：telemetry（遥测，仅指采集一环）、monitoring（监控，偏告警）

_边界_：`meta/` 基础设施（pi-logger、pi-config、pi-lab、pi-session-tree 等）不迁移，保持最底层约束；首批仅迁入 `session-analytics`（原 `tui/session-breakdown`，见 ADR-0030）。

## pi-lab 实验框架

| 术语                                        | 定义                                                                                                                                                                                                                                    |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Experiment / 实验**                       | 一个 A/B 测试实例，包含多个臂（arm）、分配策略（strategy）和反馈记录（outcome recording）                                                                                                                                               |
| **Arm / 臂**                                | 实验中的一种变体方案（如 `classic` 精确匹配 vs `row-script` 模糊行匹配）                                                                                                                                                                |
| **Allocation Strategy / 分配策略**          | 选择臂的算法。默认稳定哈希分桶（哈希空间按 arm 权重切分，默认等权）；bandit（Thompson Sampling / Epsilon-Greedy）为 opt-in 在线优化模式                                                                                                 |
| **Stable Hash Bucketing / 稳定哈希分桶**    | 分配策略之一：用稳定哈希（用户/会话 ID）决定 arm，保证同一主体跨试次稳定落在同一 arm，避免实验内漂移                                                                                                                                    |
| **Outcome / 反馈信号**                      | 一次实验试次的执行结果，为 `{ armId, metrics: { metricId: number }, metadata? }`；不设固定字段，测什么由实验声明的 metric 决定                                                                                                          |
| **Consumer / 消费方**                       | 通过 pi-lab API 注册实验并在自身逻辑中调用 select/record 的插件（如 edit）                                                                                                                                                              |
| **GlobalThis Bridge / globalThis 桥接**     | pi-lab 通过 `globalThis.__labApi` 暴露 API，消费方通过鸭子类型访问，不依赖模块导入的解耦模式                                                                                                                                            |
| **Deferred Registration / 延迟注册**        | 消费方不在模块初始化时注册实验，而是推迟到 `session_start` 或首次 execute 的时序安全点再进行                                                                                                                                            |
| **Degradation / 降级**                      | 当 pi-lab 不可用时，消费方静默回退到无实验模式的兜底行为                                                                                                                                                                                |
| **Load-Order Hazard / 加载顺序竞险**        | 消费方在模块初始化时同步检查全局桥接，但 pi-lab 尚未加载导致注册错失的时序问题                                                                                                                                                          |
| **Registration Owner / 注册方身份**         | 实验注册时由消费方显式声明的身份 key（`ExperimentDef.owner: string`）。pi-lab 仅以 `(owner, name)` 二元组判定两个注册是否属于同一逻辑实验，不解释 owner 的命名/层级语义（是否用插件名、是否编码 user/project 级别，均由消费方自行决定） |
| **Owner Conflict / 异主冲突**               | 两个不同 owner 声明同一实验名的硬冲突。撞名是配置错误而非竞争：后声明者被阻断，不覆盖已有实验                                                                                                                                           |
| **Definition Evolution / 定义演进**         | 同 owner 重声明时采集口径（实验臂、指标、分配策略、上下文键）发生变化。原地更新定义并告警「历史数据口径不一致」的副作用                                                                                                                 |
| **Idempotent Re-registration / 幂等重注册** | 同 owner 且口径未变的重声明（如跨会话重复注册）。静默复用已存在实验，不产生任何事件                                                                                                                                                     |

### pi-lab 职责边界（2025 年确认）

pi-lab 是**纯基础设施**——提供测量、存储、统计分析。**不做决策。**

| API        | 职责   | 说明                                                                                                                  |
| ---------- | ------ | --------------------------------------------------------------------------------------------------------------------- |
| `select()` | 分配   | 按实验注册时声明的分配策略返回 armId。默认稳定哈希分桶（按 arm 权重切分，默认等权）；不做自动选臂（bandit 为 opt-in） |
| `record()` | 写入   | 接收结构化多指标 outcome，append 到 JSONL 时序事件流。插件决定报什么值                                                |
| `query()`  | 分析   | 返回各 arm 在某 metric 上的贝叶斯后验结论（均值、credible interval、胜出概率、guardrail 告警）。插件决定用不用        |
| `info()`   | 元数据 | 返回实验配置、arms、metrics 定义                                                                                      |

**决策归属**：smart-context（或其他消费方）根据 `query()` 返回的分析结论，自己判断是否切换 arm、什么时候切换、按哪个指标判断。pi-lab 不替插件做决策。

### 实验方法论（2026-02 确认）

| 术语                              | 定义                                                                                                                                                                               |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A/A Self-check / AA 自检**      | 验证分流/测量/模型无偏的内置能力：假臂对照（两臂指向同一实现，跑一段看胜出概率是否 ~50/50）+ SRM 检查（实际两臂样本量是否偏离 1:1）。贝叶斯形式为后验校准（AA 后验应收敛到无差异） |
| **Capability Variant / 能力变体** | A/B 实验臂的一般形态——能力的参数/策略变体（工具集切 or 参数切），区别于「扩展开关」（装/卸扩展是环境级变更、非会话内变体，排除在 pi-lab 之外）                                     |

### 实验形态分类学（2026-08 确认）

把「能力变体」进一步按**实验形态**与**臂来源**两个正交维度细分，回答「这个维度该用 select 还是 record、臂从哪里来」。

| 术语                                             | 定义                                                                                                                                                                                                        |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Experiment Form / 实验形态**                   | A/B 实验的干预方式二分类：select 型（框架随机分流、比客观指标）vs record 型（用户主动选、只统计满意度）。                                                                                                   |
| **Select-type Experiment / select 型（分流型）** | 随机分流比客观指标的实验形态。`select()` 随机（stable-hash）分臂，`record()` 报客观指标（如 `match_success`、`saved_tokens`）。适合「用户对该维度无明确偏好、可安全随机分流」的场景。                       |
| **Record-type Experiment / record 型（记录型）** | 用户主动选配置、pi-lab 只统计满意度不干预选择的实验形态。注册臂 = 用户可选配置项，只 `record()` 不 `select()`。适合「用户有明确偏好」的场景（用户主动选 preset/mode 即明确意图，pi-lab 不该替用户随机切）。 |
| **Arm Source / 臂来源**                          | A/B 臂从哪来：代码实现变体（同一逻辑的不同实现）vs 配置状态变体（配置载体插件的配置状态本身当臂）。                                                                                                         |
| **Implementation Variant / 代码实现变体**        | 臂 = 同一能力的多种代码实现（edit 的 `classic` 精确匹配 vs `row-script` 模糊行匹配）。                                                                                                                      |
| **Configuration State Variant / 配置状态变体**   | 臂 = 配置载体插件的配置状态本身（preset id / mode id / 工具范围档位），无需另写实现代码。                                                                                                                   |
| **Form Selection Criterion / 形态选择判据**      | 用户对该维度有无明确偏好 → 有偏好走 record（不干预）、无偏好走 select（可随机分流）。                                                                                                                       |

**P0/P1 插件到形态的映射**：

| 插件              | 实验名                 | 形态   | 臂来源               | 臂                        |
| ----------------- | ---------------------- | ------ | -------------------- | ------------------------- |
| edit              | edit-strategy          | select | 代码实现变体         | `classic` / `row-script`  |
| custom-compaction | profile-satisfaction   | record | 配置状态变体         | profile id                |
| smart-context     | compression-aggression | select | 配置状态变体（参数） | `balanced` / `aggressive` |
| tools             | tool-range             | select | 配置状态变体         | `core` / `full`           |
| preset            | preset-usage           | record | 配置状态变体         | preset id                 |

### Metric 定义

| 术语                          | 定义                                                                                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Metric / 观测指标**         | 插件在注册实验时声明的测量维度，含 id、type、direction（maximize/minimize）及信号来源与聚合方式（对哪个源、哪个字段、何种聚合）           |
| **Metric Type**               | `binary`（是/否）、`continuous`（数值）、`count`（次数）                                                                                  |
| **Guardrail Metric**          | 非目标指标的副作用监测指标（如工具报错率），确保实验不损害基础体验                                                                        |
| **Composite Score**           | 多个原始 metric 加权合成的单一标量，用于程序自动决策时判断 arm 优劣。属消费方领域逻辑，不是 pi-lab 基础设施                               |
| **Derived Metric / 派生指标** | 由原始 metric 经声明式聚合（如 weighted-sum / any-fail）计算出的指标；权重声明在实验配置（注册时默认 + 用户可覆盖），`query()` 时投影计算 |
| **Outcome Recording**         | 每轮记录 `{ armId, metrics: { metricId: number, ... }, metadata?: {...} }`                                                                |

### 信号采集

| 术语                                   | 定义                                                                                                                                                                                                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ingestion Source / 信号入口**        | 产生实验事件的四条通道：① `record()` API 同步直报；② 会话树 TAG（插件主动打标 / 规则自动打标，经 pi-session-tree 接口读取，直接读会话文件兜底）；③ pi-log 结构化日志解析（`[pi-lab-signal]` 行）；④ 被动信号源（订阅 pi-logger `log` 总线，免消费方埋点） |
| **Signal Adapter / 信号适配器**        | 把各信号入口的原始格式（label 字符串、日志行、lifecycle 事件）解析成统一 Event 的解析器。TAG、日志、lifecycle 三个标准 adapter 内建，另开放 `registerIngestionSource(name, extractor)` 扩展点                                                             |
| **Passive Signal Source / 被动信号源** | pi-lab 内建信号源的**总称**，下辖两类：生命周期信号（push）与行为信号（pull）。形态为点对点（采集 → ingest），不对外广播——多组件订阅能力由 pi-logger `log` 总线本身承担                                                                                   |
| **Lifecycle Signal / 生命周期信号**    | 被动信号源之一。pi 原生执行事件（tool/message/turn/agent/session，统称 lifecycle）的投影（isError、duration、usage），**push 语义**（事件发生即 emit）。由 pi-logger 结构化（`__lifecycle__` details），pi-lab 内建适配器采集；通用、无实验语义           |
| **Behavioral Signal / 行为信号**       | 被动信号源之一。从会话树结构与用户行为推断的指标（回退、纠正、重复修改），**pull 语义**（turn_end 主动检测）。由 pi-session-tree 出基础原语、各插件实现领域语义                                                                                           |

### 信号归因

| 术语                                     | 定义                                                                                                                   |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Turn-level Attribution / turn 级归因** | 被动信号按 turn 聚合，归因到该 turn 内活跃实验的活跃臂（实验 `select` 时登记，`turn_end` flush）                       |
| **Shared Observation / 共享观测**        | token 等全局指标属 turn 级观测，被多个活跃实验共享（允许跨实验重复归因），以 `metadata.turnId` 作观测键供未来去重/聚合 |

### 存储

| 术语                          | 定义                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Event Stream / 时序事件流** | append-only JSONL 文件（每实验一个），每行一条 outcome 事件 `{ ts, armId, ctxKey, metrics, metadata }` |
| **Context Key / 上下文键**    | 事件上的普通字段（非存储分桶键），如 model 标识；`query()` 时可任意按此维度聚合                        |
| **Projection / 投影**         | `query()` 时从事件流动态计算聚合视图（后验参数、均值、胜出概率），而非读预先物化的计数                 |

### 统计分析

| 术语                                | 定义                                                                                                                    |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Bayesian Posterior / 贝叶斯后验** | 用共轭先验（binary→Beta、continuous→Normal-Gamma、count→Poisson-Gamma）对 metric 数据做推断，结论形态为概率而非 p-value |
| **Win Probability / 胜出概率**      | `P(arm i 在所有臂中表现最好)`，由后验分布蒙特卡洛采样估算，供消费方做切换判断                                           |
| **Credible Interval / 可信区间**    | 贝叶斯后验的区间估计（如 95% HDI）；不同于频率学派的置信区间                                                            |
| **Guardrail Alert / 护栏告警**      | guardrail metric 显著恶化（如 P(恶化)>0.95）时触发的告警，不参与选赢家，只做副作用监测                                  |

### Outcome 信号评分模型

| 信号               | 类型       | 评分                 | 时序         |
| ------------------ | ---------- | -------------------- | ------------ |
| 回退到之前节点     | binary     | →1（坏）             | 异步（事后） |
| detectRetry        | binary     | →1（坏）             | 异步         |
| fork 分支          | binary     | →1（坏）             | 异步         |
| 纠偏（同分支修正） | count      | →0.5（坏）           | 异步         |
| 继续 1-2次         | continuous | +1（好）             | 异步         |
| 继续 3-5次         | continuous | 0（中性）            | 异步         |
| 继续 >5次          | continuous | →1（坏，模型太啰嗦） | 异步         |
| 工具报错率 > 10%   | binary     | →1（坏）             | 同步（本轮） |

综合：`composite_score = Σ signals` → >0 success, <0 failure, =0 neutral

## bench 评测体系（离线配对基准）

移植自 pi-fabric 的 DeepSWE 风格 paired benchmark，为「某个插件是否带来可量化的边际价值」提供离线评测。与 pi-lab 互补：pi-lab 管会话内变体，bench 管环境级装/卸扩展（见 ADR-0026）。

| 术语                                         | 定义                                                                                                                                                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **离线配对基准（Offline Paired Benchmark）** | 固定任务 + 固定模型下，对比「无插件 vs 有插件」两个配置臂的边际价值。_避免_：基准测试（benchmark 泛指）、离线 A/B                                                                                                  |
| **评测单元（Cell）**                         | 一次 `(task, config, rep)` 三元组的独立运行，产出 `result.json`。                                                                                                                                                  |
| **任务（Task）**                             | 一个真实 repo 改动任务的完整定义 = 三件套。_避免_：场景、用例                                                                                                                                                      |
| **任务三件套（Task Trio）**                  | `task.json`（repo URL + base_ref + 超时）+ `prompt.txt`（给 agent 的原始提示）+ `verify.sh`（验收探针）。                                                                                                          |
| **配置臂（Config Arm）**                     | 一次对比中的一个环境配置：`无插件` vs `有插件`（单插件 + 其 meta 依赖链）。_避免_：config 组、实验臂（那是 pi-lab 术语）                                                                                           |
| **验收探针（Verify Probe）**                 | `verify.sh`，从任务验收标准机械推导，输出 `reward_binary` / `reward_partial`。                                                                                                                                     |
| **边际价值（Marginal Value）**               | 有插件 vs 无插件在同一 task 上的度量 delta（解决率 / token / 成本 / 耗时 / 行为）。插件有效性的唯一口径。_避免_：绝对达标、功能正确性                                                                              |
| **插件触发生效（plugin_triggered）**         | 独立指标，标记「有插件」臂里目标插件是否被实际调用。未触发的 cell 不混入边际价值 delta，单列触发率。                                                                                                               |
| **冒烟门槛（Smoke Gate）**                   | 案例入库前的双向检查：无/有两臂各跑一次，任一维度出现可观测 delta 才入库；`verify.sh` 必须能正常执行产出 reward。                                                                                                  |
| **评测模型（Bench Model）**                  | 冒烟用 mock-llm（不烧钱、验证 verify.sh 双向判定）；真实**强制显式** `--model <provider>/<model-id>`（无默认值，preflight 校验存在于 models-store）。成本从 session jsonl 的 `usage.cost` 读取，不 hardcode 费率。 |
| **运行标识（Run ID）**                       | 一次矩阵评测的唯一标识，形如 `run-YYYYMMDD-HHMMSS`，即 `bench/results/<run-id>/` 目录名。启动与结束都显式打印，报告/进度/日志都挂在它下面。                                                                        |
| **后台评测运行（Background Bench Run）**     | 长耗时 bench 的运行模式：`nohup` 后台启动，用户通过「问进度」触发查询与反馈，而非同步阻塞等结果。                                                                                                                  |
| **进度查询（Progress Query）**               | 通过 `bench-status.sh <run-id>` 读 `progress.json` + `run.log` 回答「跑到哪了 / 还剩多少 / 哪些失败」。                                                                                                            |
| **进度文件（progress.json）**                | `results/<run-id>/progress.json`，结构化记录总量/已完成/失败 + 每个 cell 的 `pending                                                                                                                               | running | done | failed | skipped`状态与阶段（`clone | agent | metrics | verify`）。 |
| **运行日志（run.log）**                      | `run-matrix.sh` 自身 stdout+stderr 全量 tee 到 `results/<run-id>/run.log`，后台跑也能留档审计。                                                                                                                    |
| **断点续跑（Resume）**                       | `--resume <run-id>`：跳过已完成 cell（`result.json` 含 `reward_binary`），中断/残缺 cell 重跑；配置不一致拒绝续跑。语义对齐上游 Harbor `job resume`（见 ADR-0031）。                                               |

## pi-session-tree 会话树查询服务

| 术语                                | 定义                                                                                                                                                                        |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Session Tree / 会话树**           | Pi 的 `SessionManager` 以 append-only tree 结构管理会话历史——每个 entry 有 id/parentId/timestamp，支持分支、回滚。pi-session-tree 封装此原始树为可查询的接口。              |
| **SessionTreeNode / 会话树节点**    | pi-session-tree 的自有抽象，封装 Pi 原生 SessionEntry 并附加计算字段（depth, branchIndex），隔离 Pi 版本变化。                                                              |
| **Tree Query Service / 树查询服务** | pi-session-tree 的核心定位——提供 8 类查询（节点、路径、结构、聚合、内容、窗口、标注、快照），不包含业务决策逻辑。                                                           |
| **Path / 路径**                     | 从根节点到某个节点的链（祖先链）。核心查询包括 pathToLeaf()、pathBetween()、distance()、LCA()。                                                                             |
| **Branch / 分支**                   | 当用户从某个 entry 回滚并发送新 prompt 时，该 entry 获得多个子节点形成分支。branchCount() 统计分叉点数。                                                                    |
| **Tree Complexity / 会话复杂度**    | 基于 branchCount × maxDepth × compactionCount 的加权综合指标，供应用层判断是否需要切换复杂模型。                                                                            |
| **Annotation / 标注**               | pi-session-tree 通过 `Pi.appendEntry()` 将计算结果（如复杂度分、上下文快照）以 CustomEntry 写回会话树，跨 `/reload` 持久化。                                                |
| **Snapshot / 快照**                 | 轻量快照（leafId + entry 计数），供 diff() 检测自上次查询以来的增量变化。                                                                                                   |
| **Primitive / 基础原语**            | pi-session-tree 提供的稳定、通用、无实验语义的会话树结构查询（`isDescendant`/`detectDiverge`/`pathToLeaf`/`analyzeComplexity`）。只回答「树结构客观是什么」，不解释实验含义 |
| **Domain Signal / 领域信号**        | 各插件用基础原语自实现、带实验语义的信号检测（如 `detectRollback = detectDiverge(anchor) → satisfaction=0`）。归插件所有，pi-session-tree 不提供                            |

### pi-session-tree TUI 渲染层

| 术语                                 | 定义                                                                                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| **会话当前节点（Leaf / 叶子）**      | 会话树的活跃叶子节点（`getLeafId()` 返回）。`@`/`@~N`/`@^`/`@^^type` 表达式的解析锚点，不随面板光标移动。                              |
| **光标节点（Cursor Node）**          | 面板当前高亮选中的节点。footer 显示其 ID；`+N`/`-N` 跳转的解析基准。与「会话当前节点」是不同概念，在筛选视图下二者常不一致。           |
| **筛选视图（Filter View）**          | `filterMode ≠ default` 时的节点过滤视图（no-tools / user-only / labeled-only / all）。过滤改变可见节点集合，是「割裂」的来源。         |
| **割裂（Cursor-Target Divergence）** | 筛选/搜索视图下，「光标节点」与「@~ 所选节点」不一致的现象。footer 以「筛选视图(光标≠@~所选)」提示，而非改变 @ 锚点（详见 ADR-0007）。 |

## TUI 设计

| 术语                          | 定义                                                                                                                                                             |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Smart Context Panel**       | `/smart-context` 命令打开的 TUI 面板，含 3 个 Tab（决策、状态、配置）。状态 Tab 下设信号/分析二级子 Tab。详见 `docs/adr/0006-smart-context-pi-lab-tui-design.md` |
| **pi-lab Panel**              | `/lab` 命令打开的 TUI 面板，展示分析结论（胜出概率、credible interval、guardrail 告警），阈值高亮显著胜出 arm；只展示不推荐，切换决策归消费方/用户               |
| **Session Tree Panel**        | `/session-tree` 命令打开的 TUI 面板，单树视图展示会话树，支持节点跳转（`@` 表达式）、范围标记统计、标签标注、视图过滤。                                          |
| **图例（Legend）**            | 按 `L` 键弹出的浮层，显示策略缩写→全名映射。数据从 StrategyRegistry 动态渲染。                                                                                   |
| **Arm 锁定（Arm Lock）**      | 在 smart-context 配置 Tab 中，用户固定选择某个 arm（如 classifer），绕过 pi-lab 的自动分配。与 Profile 绑定。                                                    |
| **指标切换（Metric Switch）** | `◀ metric ▶` 通过 `← →` 键切换分析的指标维度（composite_score / tool_error_rate / bounce_rate 等）。用于 smart-context 分析子 Tab 和 pi-lab 实验详情。           |
| **二级子 Tab**                | 在一级 Tab 内嵌的子导航栏，用细线与一级 Tab 分开。smart-context 状态 Tab 的信號/分析各为一个二级子 Tab。                                                         |

### 交互模式

| 术语                                | 定义                                                                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **三轴模型（Three-Axis Model）**    | TUI 设计的正交分类框架：入口（UI 挂载位置）× 交互模式 × 实现策略，取代按场景一维列表。详见 `docs/adr/0020-tui-interaction-model.md`。 |
| **交互模式（Interaction Pattern）** | TUI overlay 的交互形态，四类：只读展示、导航选择、表单编辑、确认菜单。                                                                |
| **master-detail 导航**              | 导航选择类 overlay 的强制两级结构：一级列表选中 → 二级详情/操作；一级列表必带滚动上限。                                               |
| **滚动视口（Scroll Viewport）**     | 列表类 overlay 的最大可视行数 + 滚动切片，防止内容随数据量线性撑高。                                                                  |
| **实现策略（Rendering Strategy）**  | 渲染方式：手绘字符串（render 拼行）vs 组件化（Container 组件树）。正交于入口与交互模式。                                              |
| **Focusable**                       | 横切能力（`focused: boolean` + `CURSOR_MARKER` 硬件光标定位），手绘与组件化均可选加，非分类维度。                                     |

## Cloud Sessions

| 术语                 | 定义                                                                                                                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ConflictResolver** | 纯决策引擎，接收本地/远端文件的 `FileState` 对，返回 `Resolution`。不执行任何文件操作。                                                                                                                  |
| **Resolution**       | ConflictResolver 的输出。`action`: `push_local` / `pull_remote` / `skip` / `merge`，带可选的 `mergedContent` 和 `reason`。                                                                               |
| **MtimeResolver**    | ConflictResolver 的默认实现。基于 hash 和 mtime 差异做 4 路决策。构造时可配 `toleranceMs` 和 `tieBreaker`。                                                                                              |
| **Merger**           | 负责生成合并后内容。`merge(localPath, remotePath) → Promise<string>`。延迟读文件，仅在需要 merge 时调用。                                                                                                |
| **ProjectMatcher**   | 从同步镜像中查找同一项目的其他机器目录、复制匹配会话到当前 cwd 目录的策略接口。`match(config: ProjectMatchConfig, machineId: string, sessionsRoot: string, mirrorRoot: string) → Promise<MergeResult>`。 |
| **Sync**             | 同步编排器，内部 `syncFiles()` + `applyProjectMatch()` 分别走 ConflictResolver 和 ProjectMatcher，最终一次 `provider.push()` 提交。                                                                      |

## 快捷键体系

| 术语                                     | 定义                                                                                                                                                              |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **键域（Key Domain / Key Namespace）**   | 一组共享修饰键组合、归属同一方的快捷键集合空间。pi 原生键域与扩展键域各自独立，互不进入。                                                                         |
| **保留键（Reserved Key）**               | pi 原生独占、扩展不得占用的键。pi 通过 `restrictOverride` 强制扩展让位。                                                                                          |
| **扩展专属键域（Extension Key Domain）** | pi 承诺不进入、归扩展使用的键空间。扩展在此键域内自由分配，是「未来不冲突」的隔离边界。                                                                           |
| **Leader-key 前缀模式**                  | 扩展共用一个保留前缀键，后续子键在自有子键域内使用的两段式触发方式（参照 tmux `Ctrl-b` / Vim `<leader>`）。                                                       |
| **前缀键（Prefix Key）**                 | 扩展快捷键体系的两段式触发键（约定 `ctrl+shift+space`，`alt+.` 备用），按下后进入子键监听状态。                                                                   |
| **子键（Sub Key）**                      | 前缀键之后按下的键，标识具体扩展功能。子键在扩展专属子键域内分配，与 pi 原生键域隔离。                                                                            |
| **快捷面板（Shortcut Palette）**         | 按下前缀键后弹出的 TUI 面板，列出所有已注册快捷键及说明；用户按子键执行并自动关闭。可配置开关。                                                                   |
| **回退注册（Fallback Registration）**    | 消费方插件在快捷键中心不可用（未安装/报错）时，回退到自身默认快捷键注册的降级行为。                                                                               |
| **降级键（Fallback Key）**               | 回退注册时消费方写的完整快捷键（如 `ctrl+shift+o`）。与子键成对出现在接入代码块中，是抽取脚本的扫描源之一。                                                       |
| **接入代码块（Registration Block）**     | 消费方接入快捷键中心的统一模板：`hub.register({ name, subKey, description })` + `else pi.registerShortcut('<fallbackKey>')`。元信息即代码，抽取脚本按此形态扫描。 |
| **快捷键中心（Shortcut Hub）**           | meta 目录下的基础设施插件，集中持有前缀键注册、子键注册表、子键分发（静默/面板两模式）与冲突裁决。                                                                |

## custom-compaction（压缩实验）

| 术语                                   | 定义                                                                                                                                                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **分层最小写入（Layer-Scoped Write）** | 配置写操作只更新目标层（session/project/user）原始文件中的差异字段，绝不把合并后的全量快照写回单层文件。防止项目级/会话级配置被固化为用户级快照（跨项目污染）。                                                                 |
| **活跃层（Active Scope）**             | 当前生效的配置层（session > project > user；无配置文件时映射为 user）。settings panel 编辑时保存到该层，与面板显示一致。                                                                                                        |
| **回退信号（Rollback Signal）**        | 用户将会话树当前节点回退到压缩摘要节点之前的行为，视为对压缩结果不满意的负信号。pi 无原生事件，靠压缩时记录摘要节点位置、turn_end 对比检测。                                                                                    |
| **重压信号（Recompact Signal）**       | 压缩后用户手动再次 `/custom-compact`，视为对上次压缩不满意的负信号。custom-compaction 内部直接可感知。                                                                                                                          |
| **打标信号（Tag Signal）**             | 用户在会话树节点打 GOOD/BAD 等自然语言标签。pi-lab 默认只解析 `<armId>:<metricId>:<value>` 三字段，自然语言标签需由 custom-compaction 注册自定义 SignalExtractor 做归因翻译。                                                   |
| **归因（Attribution）**                | 把发生在压缩之后的用户行为信号（回退/重压/打标）关联到最近一次压缩所使用的实验臂。pi-lab 设计哲学：armId 归因是消费方 extractor 的职责，pi-lab 只负责存储与统计。                                                               |
| **过程指标（Process Metric）**         | 压缩过程中直接可测的 guardrail 指标：压缩耗时（latency_ms）、token 节省量（saved_tokens）、摘要长度（summary_length）。可作为质量代理，但无法测真实摘要质量。                                                                   |
| **维度实验（Dimension Experiment）**   | 用户要对比的三个独立维度——机制（summarize vs smart-compact adapter）、压缩 prompt 变体、触发阈值。各自注册为独立实验（name 不同），避免臂集混入同一实验。                                                                       |
| **触发条件（Trigger Condition）**      | 每个 profile 各自持有的一份「信号源 + 阈值 + 方向」判定规则，判断该 profile 是否满足触发。**per-profile、多维**：信号源可扩展（context_percent / fixed / reserve / 工具调用次数等），不再只是单一 context 阈值。                |
| **触发粒度（Trigger Granularity）**    | 触发条件评估的频率档位，决定「多久检查一次是否触发」。三档：**user turn**（用户发言提交时）/ **agent turn**（一轮 agent 结束，**默认**）/ **工具处理粒度**（每次工具调用完成）。越细越能及时捕获 context 暴涨，但评估开销越大。 |
| **启用集（Enabled Set）**              | 用户在 settings 面板用 Space 勾选的、参与自动压缩触发评估的 profile 集合。**第一道闸**：列表只是展示，未启用的 profile（含实验项）完全不参与评估；只有被启用的 profile 才会评估其触发条件。                                     |
| **选择算法（Selection Algorithm）**    | 从**触发集**中择一的判定逻辑。形态为**有序路由规则 + 阈值 tiebreak + 兜底默认**（非排序字段）：先按有序路由规则匹配环境，命中后候选仍 >1 时按触发阈值排序取一，无规则命中走兜底。                                               |
| **触发集（Triggered Set）**            | 启用集内满足各自触发条件的 profile 子集，是选择算法的候选范围（= 启用集 ∩ 触发）。**第二道闸**：未满足触发条件的 profile 即使启用，也不进入选择。                                                                               |
| **路由规则（Routing Rule）**           | 选择算法的第一层：形如「当 [环境条件] 满足 → 指定 profile」，规则有序、首条命中生效。环境条件维度目前为：模型（matchModel 降级为其中一条「模型→profile」规则）、复杂度等级（level 三档）。                                      |

### custom-compaction 实验决策（2026-08 确认）

| 决策点               | 结论                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **实验并行性**       | 三个维度实验（机制 / prompt / 阈值）**并行**注册运行。用 pi-lab `select()`/`record()` 直报：每次压缩对各实验独立 `select` 选臂，反馈信号对各实验独立 `record`（armId 即当时 select 结果，存于「最近压缩记录」），消除并行归因混淆。机制实验需 smart_compact adapter 声明 `handlesCompaction: true` 才注册（当前 collaboration 模式无真实机制差异，跳过）。未激活实验的维度（mechanism/prompt 为 null）不覆盖 profile 原配置。 |
| **反馈信号优先级**   | **回退信号最有用**（用户不满时通常回退输入其他 prompt 而非重新压缩）。重压信号保留为补充。打标信号（GOOD/BAD）入口由 pi-session-tree 提供，custom-compaction 只消费。                                                                                                                                                                                                                                                         |
| **实验定位**         | 实事求是收集真实数据（stable-hash 稳定分配），不做 forceArm 固定臂、不讲究初期数据好看。分析时能解释原因即可。                                                                                                                                                                                                                                                                                                                |
| **实验状态展示**     | settings panel 显示实验状态（活跃实验、当前臂、样本量）。                                                                                                                                                                                                                                                                                                                                                                     |
| **自动打标 UI 提醒** | pi-session-tree 自动打标（如不满话语正则规则命中）时，`setStatus` 提示「pi-session-tree 根据 [规则] 打标 [标签]」。tag-engine 已支持 `on:user_message` + `contentPattern`，缺的只是提醒。                                                                                                                                                                                                                                     |

## pi-worktree 隔离开发

| 术语                                     | 定义                                                                                                                                                                                                        |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Worktree / 工作区**                    | git worktree 创建的独立工作目录：共享同一仓库历史与远端，各自持有独立分支与文件状态（git 原生概念）                                                                                                         |
| **Main Checkout / 主仓库**               | 仓库的主工作树（默认 clone 目录），不归属任何 worktree。插件以 `ctx.cwd` 是否在受管 worktree 目录下区分身份                                                                                                 |
| **Managed Worktree / 受管工作区**        | 位于 `<repo>-worktrees/<name>/`（仓库外）且由 pi-worktree 插件管理的工作区；名称来自黄道恒星名池（如 `Aries-Hamal`），分支 `wt/<name>`                                                                      |
| **Session Switch / 会话切换**            | 通过 `ctx.switchSession()` 将 Pi 会话替换到目标 cwd 的会话文件，使工具层根目录（bash/read/write/edit）变为 worktree 路径的硬约束机制                                                                        |
| **Worktree-Local Rebase / 工作区内变基** | git 约束：不能 rebase 一个正被其他 worktree checkout 的分支，因此变基必须在持有该分支的 worktree 目录内执行。plain `rebase` 与 `rebase-ff` 均遵循此约束                                                     |
| **Merge Strategy / 收尾合并策略**        | worktree 分支合回主分支的三种方式：`merge`（保留拓扑的 merge commit）、`squash`（压成单提交、线性）、`rebase-ff`（先工作区内变基再 fast-forward，线性无 merge commit）                                      |
| **Rebase-FF / 变基快进**                 | 收尾合并策略之一：在 worktree 目录内把分支变基到 origin/main，再在主仓库 fast-forward 合并——保证主干历史完全线性干净                                                                                        |
| **受管目录外 / Unmanaged**               | 不在 `<repo>-worktrees/` 下的 git worktree（如 pi-dynamic-workflows 的 `.pi/worktrees/`、手动 add 的），插件不识别、不管理                                                                                  |
| **Worktree Skill / worktree 技能**       | 面向 agent（模型）而非终端用户的 worktree 工作流编排指南：教 agent 何时启用 worktree 隔离开发、如何按 create→开发→sync/rebase→merge→clean 生命周期编排，并内置安全护栏（不做远端操作、警惕 print 模式删除） |
| **Local Merge / 本地合并**               | merge 流程纯本地执行（checkout target → merge source → checkout 回原分支），不自动同步远端；需要最新内容时用户通过面板手动拉取（2026-08 确认，替代自动 pull）                                               |
| **Local-First / 本地优先原则**           | pi-worktree 主要服务本地隔离开发：worktree 内容默认不推送到远端，所有远端副作用（push/PR/远程分支管理）由用户兜底；插件推荐均基于此原则（2026-08 确认）                                                     |
| **Merge Failure Panel / 合并失败面板**   | 非冲突合并失败（如 checkout 失败、工作区脏）时弹出的处理面板：展示原因分类与可执行建议，选项含「让 Agent 处理」/「拉取最新（非首位可选）」/重试/打开 shell/关闭（2026-08 确认）                             |
| **Agent Delegation / Agent 委托**        | 失败面板「让 Agent 处理」选项：以「合并建议原则 + 当前准确情况 + 任务」三段式 prompt 委托 agent，只输出建议命令步骤，不执行、不 push（2026-08 确认，参照 review 插件 RUBRIC 模式）                          |

### pi-worktree 职责边界（2026-08-17 确认）

pi-worktree 是**本地 git 工作区生命周期管理**工具。**不做远端操作。**

| 操作域              | 归属     | 说明                                                                                                                 |
| ------------------- | -------- | -------------------------------------------------------------------------------------------------------------------- |
| 创建/删除/列表/切换 | 插件     | `create`/`delete`/`list`/`use`/`shell` 等本地工作区管理                                                              |
| 同步与合并          | 插件     | `sync`(=rebase 别名)/`rebase`/`rebase-ff`/`merge`/`squash`/`continue`/`abort`/`clean`/`prune`——均为本地 git 仓库操作 |
| 会话管理            | 插件     | `ctx.switchSession()` 切换 cwd 与会话历史                                                                            |
| **push / 远端发布** | **用户** | 合并成功后插件只提示，不执行 `git push`（认证/权限/远端策略属用户决策域）                                            |

**决策归属**：远端发布（push、PR 创建、远程分支管理）由用户自己完成。插件不自动推、不强推，不在命令中隐含远端副作用。

## review 审查方案（profile）

| 术语                                  | 定义                                                                                                                                                                       |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **审查方案 / Profile**                | review 扩展中一组绑定「提示词 + 判定结束条件」的审查模式（如代码审查、测试覆盖分析）。`/review` 下先选审查方案，再选审查目标（staged/uncommitted/branch/commit/PR/folder） |
| **判定结束条件 / Verdict Rule**       | 循环修复中解析模型输出、判断「是否仍有阻塞发现项 → 是否继续下一轮」的声明式规则。由结论词、发现章节标题、发现行识别规则构成                                                |
| **Profile 注册表 / Profile Registry** | 列出可用审查方案及其资源文件（提示词、判定规则）位置的轻量配置，`config.json` 职责                                                                                         |

## Skill 打包与分发

| 术语                          | 定义                                                                                                                                                           |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Embedded Skill / 内嵌技能** | 放置在扩展目录 `skills/` 子目录下、由扩展根 `package.json` 的 `pi.skills` 字段声明、随扩展一起同步分发的 agent 技能（区别于独立存放在 `skills/` 顶层的技能）。 |
| **pi manifest**               | 扩展根 `package.json` 中的 `pi` 字段，声明扩展入口（`pi.extensions`）与内嵌技能（`pi.skills`），为将来 npm 包化分发做准备。                                    |

## bash 工具干预

Pi 有两条路径干预内置 bash 工具，单个扩展须二选一。两条路径可共存（tool_call 钩子注入不与 sandbox 的 operations 替换冲突）；真正互斥的是同用 operations 替换的多个扩展之间：

| 术语                                        | 定义                                                                                                                                         |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tool Call Hook / tool_call 钩子注入**     | 在 `tool_call` 事件里 mutate `input`（改 `command`、注入 `timeout`）而不替换工具。与 sandbox 的 operations 替换共存。uv、bash-timeout 采用。 |
| **Operations 替换**                         | 用 `createBashTool()` 的 `operations` 参数整体接管 bash 执行（exec/spawn）。sandbox 采用，属"重"路径，会与其他扩展冲突。                     |
| **默认超时兜底 / Default Timeout Fallback** | bash-timeout 的语义：仅当 agent 未显式指定 `timeout` 时注入默认值（**兜底**），而非**封顶**（上限）；agent 显式传值一律尊重。                |

## todos 待办插件

### 核心术语

| 术语                            | 中文         | 定义                                                                                                                         |
| ------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| **Todo / 待办**                 | 待办         | 基于文件的轻量任务：front matter（标题/标签/状态/分配）+ markdown 正文，存储在 `.pi/todos/`（项目）或 `~/.pi/todos/`（全局） |
| **Status / 状态**               | 状态         | 三种：`open` 待办（未完成、进行中）、`done` 已完成、`close` 已关闭（软删除，从列表隐藏）                                     |
| **Scope / 作用域**              | 作用域       | 待办的归属目录：`session` 会话（当前会话分配的）、`project` 项目、`global` 全局                                              |
| **Assignment / 分配**           | 分配         | 待办是否已分配给某会话（`assigned_to_session` 字段）。认领（claim）后待办绑定当前会话，释放（release）后解除绑定             |
| **Claim / 认领**                | 认领         | 把待办分配给当前会话，处理前先认领以避免冲突                                                                                 |
| **Release / 释放**              | 释放         | 解除待办的会话分配，恢复为未分配状态                                                                                         |
| **Sort Field / 排序字段**       | 排序字段     | `created-at` 创建时间、`title` 标题——待办列表的排序维度                                                                      |
| **Sort Direction / 排序方向**   | 排序方向     | `asc` 升序、`desc` 降序                                                                                                      |
| **Compact View / 紧凑列表视图** | 紧凑列表视图 | 面板显示模式：`是`（紧凑/摘要）vs `否`（详情）。对应 `widgetDisplay` 的 summary/details                                      |
| **Widget Display / 组件显示**   | 组件显示     | 状态栏组件（widget）的展示样式：`summary` 摘要、`details` 详情                                                               |

### 术语中文化映射（所有插件统一）

代码中存储/比较始终用**英文值**（schema、配置、文件内容），仅在**展示层**通过 `storage.ts` 的映射函数转为中文。其他插件涉及同义概念时应复用同一中文词，不得另译。

| 英文               | 中文                   | 说明                                                               |
| ------------------ | ---------------------- | ------------------------------------------------------------------ |
| Cancel / Cancelled | 取消 / 已取消          | 所有交互的取消动作                                                 |
| Session            | 会话                   | pi 会话                                                            |
| Resume             | 恢复                   | 恢复会话/线程/目标                                                 |
| Enabled / Disabled | 已启用 / 已禁用        | 开关状态                                                           |
| Ready              | 就绪                   | 待命状态                                                           |
| Save / Saved       | 保存 / 已保存          | 持久化                                                             |
| Delete             | 删除                   | 删除动作                                                           |
| Confirm            | 确认                   | 确认对话框                                                         |
| Submit             | 提交                   | 提交答案/表单                                                      |
| Widget             | 组件                   | 状态栏小组件（widget）                                             |
| Profile            | 配置 / 预设 / 审查方案 | smart-context 用「配置」，preset 用「预设」，review 用「审查方案」 |
| Strategy           | 策略                   | 合并/同步策略                                                      |
| Notifications      | 通知                   | 通知开关                                                           |
| Compaction         | 压缩                   | 上下文压缩（custom-compaction）                                    |
| Goal               | 目标                   | 长期任务目标                                                       |
| Loop               | 循环                   | 循环执行                                                           |
| Fork               | 分叉                   | 会话分叉（split-fork / worktree fork）                             |
| Recap              | 回顾                   | 会话进度总结                                                       |
| Search             | 搜索                   | 过滤/查找                                                          |
| Next / Prev        | 下一个 / 上一个        | 导航                                                               |
| Run / Running      | 运行 / 运行中          | 执行状态                                                           |

**保留英文（不翻译）的技术标识**：

- 命令名（`/goal` `/review` `/fox` 等）与工具名（`get_goal` `edit` `rg` 等）——API 标识符
- 参数名（`multi` `patch` `oldText` `token_budget` 等）——schema 键
- git 术语（`worktree` `rebase` `squash` `merge commit` `stash` `caffeinate` 等）
- 插件名（`smart-context` `pi-logger` `cloud-sessions` 等）
- 状态/枚举值（`open/done/close`、`trace/debug/info/warn/error/off`、`pass/fail` 等）
- 日志输出（`log.info/error` 写文件，开发者排查用，保留英文）

## permission-gate 权限门禁

| 术语                                                     | 定义                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **危险分级（Danger Tiering）**                           | 按三个正交语义轴对命中黑名单的操作分级，决定它能否被"动态频次自适应放行"自动放行：①副作用（读 vs 写）②权限相关（是否触碰权限变更）③路径空间（目标路径是否落在敏感/核心区域）。产生副作用的操作至少 info 级以上；副作用+权限相关、或路径落在 Linux 核心区域 → critical。          |
| **副作用（side effect）**                                | 操作对系统产生变更（写/删除/修改），区别于纯读。是分级的第一判据：有副作用至少 info 级以上，无副作用（纯读）为最低档。                                                                                                                                                           |
| **权限相关（permission-related）**                       | 操作涉及权限/身份变更（chmod/chown/sudo/su/setfacl/usermod/mount 等）。副作用+权限相关 → critical；`sudo` 一律 critical，不解析其后续命令（提权即最高警戒）。                                                                                                                    |
| **危险命令（destructive command）**                      | 本身具破坏性/影响系统运行的命令（dd/mkfs/fdisk/parted/wipefs/shred/iptables/nftables/shutdown/reboot 等）。命令字面匹配 → 一律 critical。                                                                                                                                        |
| **路径空间（path surface）**                             | 操作目标路径所在区域，分两层判定：①**系统目录层**（/etc /usr /boot /lib /sbin /bin /sys /proc /dev）——写 = critical、读 = warning；②**敏感凭证层**（~/.ssh ~/.aws ~/.kube ~/.gnupg、项目内 `.env` `*.pem` `*.key` `id_rsa`）——读 = 写 = critical（读凭证即信息泄露）。           |
| **fail-closed**                                          | 不可判定（解析失败/异常/无法确认意图）时，默认拒绝或询问，而非放行。                                                                                                                                                                                                             |
| **动态频次自适应放行（graduated auto-approval）**        | 同一命令/工具/文件夹达到确认次数阈值后，后续同类操作自动放行的机制。放行规则的持久化层级受危险等级限制（见下）。                                                                                                                                                                 |
| **放行规则持久化层级（approval-rule persistence tier）** | 自适应放行规则可沉淀的最高层级，由危险等级决定：critical → 会话级（会话结束失效）；warning → 项目级；info → 用户级。危险等级越高，信任越不持久。该映射关系展示在策略面板底部提示。                                                                                               |
| **手动创建策略（manual rule creation）**                 | 用户在阻断确认框中对某条子命令按 `a` 显式「添加为策略」，跳过算法计数累积，直接创建一条放行规则（一步流程：`a` → 级别选择 → 创建）。匹配粒度默认精确命令级，工具/目录扩展在策略面板操作。与算法沉淀（graduated）相互独立，两套机制并存，判定时手动策略优先。                     |
| **手动策略（manual strategy）**                          | 手动创建策略产生的显式规则，独立存储（区别于 graduated 的计数）。用户拍板的信任：不受阈值调整影响、面板行标记 `手动`（graduated 行 `自动`，不带方括号）、删除/调级独立操作。会话结束时其会话级条目随会话清除。                                                                   |
| **默认沉淀级别（default persistence scope）**            | 手动创建策略时的初始持久化层级，默认会话级（会话结束失效），用户可在设置中修改。仅作为手动创建策略的默认选项；算法沉淀仍按 tier→scope 映射（critical→会话 / warning→项目 / info→用户）自动决定层级。                                                                             |
| **动态频次自适应放行默认开启（graduated default-on）**   | `dynamicPolicyEnabled` 默认 true——同一命令确认达阈值后自动放行（无感），解决"反复确认同一命令"痛点。graduated 仍按 tier→scope 映射决定持久化层级；手动策略（用户拍板）与其并存。                                                                                                 |
| **阻断确认树（blocking confirmation tree）**             | 危险命令拦截窗口的展示形态：命令树（根 = 完整命令，叶子 = 拆解的子命令，两层树，可折叠），节点前用不同颜色小点提示风险（参考 custom-tree 样式）。仅作展示与细粒度管理入口，不影响放行语义。                                                                                      |
| **整命令放行语义（whole-command approval semantics）**   | 拦截窗口的放行/拒绝作用于整条命令：放行 = 原命令不改写直接执行；拒绝 = 整条不执行。不做部分执行/命令改写（改写后 LLM 原本想做的操作已变，无意义）。放行决策是会话级语义。叶子级「添加为策略/加入拦截规则」是粒度更细的管理操作，与本次放行决策相互独立。                         |
| **请求/控制 ID（request/control ID）**                   | 每次命令执行（工具调用）生成的唯一标识，贯穿审计回溯与外部确认：被拦截（ask）的记录其 ID 供外部通道凭 ID 确认；放行的记录其 ID 仅用于审计。                                                                                                                                      |
| **外部确认通道（external confirmation channel）**        | permission-gate 暴露的通道无关程序化确认接口（`globalThis.__permissionGateApi`：`onPendingRequest` + `confirm` + `listPending`）。任何插件（如 wechatbot）可订阅待确认请求并程序化确认，等效于人工 TUI 选择。permission-gate 阻塞行为不因外部通道而变，超时/作废由通道自身控制。 |
| **审计日志（audit log）**                                | 每次命令执行（全部工具调用）的完整记录（ID、时间、工具、命令、级别、决策、命中维度），JSONL 按天分片存储，默认保留半年、滚动清理。是审计回溯与"回检拦截强度"的数据源，也是未来智能自适应算法的语料。放行规则与配置**永久保留**，不受半年限制。                                   |

## preset 预设

| 术语                                      | 定义                                                                                                                                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **preset 三级来源（preset scope）**       | preset 定义的三个作用域：会话级（TUI 会话内临时添加，仅存内存，会话结束失效）、项目级（项目本地配置文件）、全局级（用户级配置文件，跨项目）。面板每行头部以 `[会话]` `[项目]` `[全局]` 标记来源。 |
| **会话级 preset（session-scope preset）** | 仅在当前会话内存中存在的 preset，只能通过 TUI 面板添加，不做文件持久化，会话结束失效。                                                                                                            |
| **项目级 preset（project-scope preset）** | 定义在 `<cwd>/.pi/extensions-data/preset/config.json`，仅当前项目可见，只能通过配置文件修改。                                                                                                     |
| **全局级 preset（global-scope preset）**  | 定义在 `~/.pi/agent/extensions-data/preset/config.json`，跨项目可见，只能通过配置文件修改。                                                                                                       |
| **提升（promote）**                       | 会话级 preset 调好后，通过 TUI 的 `s` 键写入项目级 config.json 并移除会话级同名条目，实现「临时试验 → 项目固化」的转正。全局级不提供 TUI 提升入口，用户自行拷贝项目级配置文件到用户级。           |
| **复制为临时（copy-to-session）**         | 文件级 preset（项目/全局）在面板按 `e` 复制为会话级副本，命名 `原名-复制`（重名递增 `-复制2`），副本完整继承原字段并可继续编辑，原文件级不变。                                                    |

## 本地同步（sync 工具）

| 术语                                | 定义                                                                                                                                                                                                                                            |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **同步 profile（sync profile）**    | `scripts/sync-profiles.yaml` 中定义的一组「资源清单 + 目标目录」，描述把哪些 assets 同步到哪里（如 `user-install` → `~/.pi/agent`、`project` → `./.pi`）。_避免_ 与 review profile / custom-compaction profile 混淆（三者是不同域的同名概念）。 |
| **受管资产（Managed Asset）**       | 目标目录中、名字能在本仓库源清单（`extensions/`、`skills/`、`themes/`、`prompts/`）按名匹配到的资产。sync 默认删除谓词的作用对象。_避免_：自有资产、仓库资产。                                                                                  |
| **第三方资产（Third-party Asset）** | 目标目录中名字不在源清单里的资产（如 herdr 安装的集成）。sync 默认永不删除，仅 `--purge` 才清。                                                                                                                                                 |
| **有效集合（Effective Set）**       | 一个 profile 实际要同步的资产名集合 = include（`*` 或显式清单）减去 exclude。删除判定用「不在有效集合」而非「不在 include」。                                                                                                                   |
| **严格剪枝（Strict Prune）**        | sync 默认删除谓词：受管资产 且 不在当前 profile 有效集合 且 不在保护名单 → 删除。区别于 `--purge`（连第三方也删）。                                                                                                                             |
| **形态冲突（Form Conflict）**       | 目标里名字 ∈ 源清单、但形态与源不一致的残留（源是目录扩展、目标残留同名单文件 `.ts`，或反向）。也按受管资产删除，且不受 purge/inline 决策影响。典型：`review` 重构为目录后残留旧 `review.ts` → pi 加载两次 → `review:1`/`review:2` 重名。       |
| **保护名单（Protected External）**  | `PROTECTED_EXTERNAL`，第三方集成名清单（如 `herdr-agent-state`），删除判定时跳过，避免误删用户手动安装的集成。                                                                                                                                  |
