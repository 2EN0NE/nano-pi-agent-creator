# 领域词汇表

## pi-lab 实验框架

| 术语                                           | 定义                                                                                         |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **Experiment / 实验**                          | 一个 A/B 测试实例，包含多个臂（arm）、决策策略（strategy）和反馈记录（outcome recording）    |
| **Arm / 臂**                                   | 实验中的一种变体方案（如 `classic` 精确匹配 vs `row-script` 模糊行匹配）                     |
| **Strategy / 决策策略**                        | 选择臂的算法（Thompson Sampling / Epsilon-Greedy）                                           |
| **Outcome / 反馈信号**                         | 一次实验试次的执行结果，分层设计：Tier 1 success → 驱动贝叶斯更新；Tier 2-5 存入 metadata    |
| **Consumer / 消费方**                          | 通过 pi-lab API 注册实验并在自身逻辑中调用 select/record 的插件（如 edit）                   |
| **GlobalThis Bridge / globalThis 桥接**        | pi-lab 通过 `globalThis.__labApi` 暴露 API，消费方通过鸭子类型访问，不依赖模块导入的解耦模式 |
| **Deferred Registration / 延迟注册**           | 消费方不在模块初始化时注册实验，而是推迟到 `session_start` 或首次 execute 的时序安全点再进行 |
| **Degradation / 降级**                         | 当 pi-lab 不可用时，消费方静默回退到无实验模式的兜底行为                                     |
| **Load-Order Hazard / 加载顺序竞险**           | 消费方在模块初始化时同步检查全局桥接，但 pi-lab 尚未加载导致注册错失的时序问题               |
| **Fatal Registration Conflict / 致命注册冲突** | 两个实验同时注册同名实验，或被强制选择了冲突的策略时发生的竞争                               |

### pi-lab 职责边界（2025 年确认）

pi-lab 是**纯基础设施**——提供测量、存储、统计分析。**不做决策。**

| API        | 职责   | 说明                                                                                  |
| ---------- | ------ | ------------------------------------------------------------------------------------- |
| `select()` | 分配   | 按实验注册时声明的分配策略（均匀随机、分层等）返回 armId。不做 Thompson Sampling 选臂 |
| `record()` | 写入   | 接收结构化多指标 outcome，写入时序。插件决定报什么值                                  |
| `query()`  | 分析   | 返回各 arm 在某 metric 上的均值、置信区间、胜出概率。插件决定用不用                   |
| `info()`   | 元数据 | 返回实验配置、arms、metrics 定义                                                      |

**决策归属**：smart-context（或其他消费方）根据 `query()` 返回的分析结论，自己判断是否切换 arm、什么时候切换、按哪个指标判断。pi-lab 不替插件做决策。

### Metric 定义

| 术语                  | 定义                                                                        |
| --------------------- | --------------------------------------------------------------------------- |
| **Metric / 观测指标** | 插件在注册实验时声明的测量维度，含 id、type、direction（maximize/minimize） |
| **Metric Type**       | `binary`（是/否）、`continuous`（数值）、`count`（次数）                    |
| **Guardrail Metric**  | 非目标指标的副作用监测指标（如工具报错率），确保实验不损害基础体验          |
| **Composite Score**   | 多个信号的加权综合评分 →1 到 +1，作为 Thompson Sampling 的单值 reward       |
| **Outcome Recording** | 每轮记录 `{ armId, metrics: { metricId: number, ... }, metadata?: {...} }`  |

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

## TUI 设计

| 术语                          | 定义                                                                                                                                                             |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Smart Context Panel**       | `/smart-context` 命令打开的 TUI 面板，含 3 个 Tab（决策、状态、配置）。状态 Tab 下设信号/分析二级子 Tab。详见 `docs/adr/0006-smart-context-pi-lab-tui-design.md` |
| **pi-lab Panel**              | `/lab` 命令打开的 TUI 面板，两列命名空间分组设计，支持实验详情和 arm 详情（两级下钻）。                                                                          |
| **Session Tree Panel**        | `/session-tree` 命令打开的 TUI 面板，含 4 个 Tab（标注、窗口、路径、快照），覆盖 pi-session-tree 的 19 个 API。                                                  |
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
