# 领域词汇表

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

| 术语                            | 定义                                                                                                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Ingestion Source / 信号入口** | 产生实验事件的三条通道：① `record()` API 同步直报；② 会话树 TAG（插件主动打标 / 规则自动打标，经 pi-session-tree 接口读取，直接读会话文件兜底）；③ pi-log 结构化日志解析 |
| **Signal Adapter / 信号适配器** | 把各信号入口的原始格式（label 字符串、日志行）解析成统一 Event 的解析器。TAG 与日志两个标准 adapter 内建，另开放 `registerIngestionSource(name, extractor)` 扩展点       |

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

## pi-session-tree 会话树查询服务

| 术语                                | 定义                                                                                                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Session Tree / 会话树**           | Pi 的 `SessionManager` 以 append-only tree 结构管理会话历史——每个 entry 有 id/parentId/timestamp，支持分支、回滚。pi-session-tree 封装此原始树为可查询的接口。 |
| **SessionTreeNode / 会话树节点**    | pi-session-tree 的自有抽象，封装 Pi 原生 SessionEntry 并附加计算字段（depth, branchIndex），隔离 Pi 版本变化。                                                 |
| **Tree Query Service / 树查询服务** | pi-session-tree 的核心定位——提供 8 类查询（节点、路径、结构、聚合、内容、窗口、标注、快照），不包含业务决策逻辑。                                              |
| **Path / 路径**                     | 从根节点到某个节点的链（祖先链）。核心查询包括 pathToLeaf()、pathBetween()、distance()、LCA()。                                                                |
| **Branch / 分支**                   | 当用户从某个 entry 回滚并发送新 prompt 时，该 entry 获得多个子节点形成分支。branchCount() 统计分叉点数。                                                       |
| **Tree Complexity / 会话复杂度**    | 基于 branchCount × maxDepth × compactionCount 的加权综合指标，供应用层判断是否需要切换复杂模型。                                                               |
| **Annotation / 标注**               | pi-session-tree 通过 `Pi.appendEntry()` 将计算结果（如复杂度分、上下文快照）以 CustomEntry 写回会话树，跨 `/reload` 持久化。                                   |
| **Snapshot / 快照**                 | 轻量快照（leafId + entry 计数），供 diff() 检测自上次查询以来的增量变化。                                                                                      |

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
