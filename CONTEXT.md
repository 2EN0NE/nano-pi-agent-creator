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

## 路由策略设计

| 术语                                   | 定义                                                                                                                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Signal Dimension / 信号维度**        | 策略可用的四类输入信号：D1 当前 turn（prompt 长度/复杂度、LLM 分类、上下文使用）、D2 会话树（分支/回滚/压缩/工具统计/重试）、D3 工程体系（文档完善度、扩展数量）、D4 会话进度（commit 数、label 数）。 |
| **Upgrade Propensity / 升级倾向**      | 策略对"从 flash 升级到 pro"的态度——conservative 需要多重信号同时触发才升，aggressive 任一信号即可升。                                                                                                  |
| **Project Doc Score / 工程文档分**     | D3 综合评分（0-100）：基于 AGENTS.md 存在/大小、README.md 存在/大小、自定义 preset 存在。高分项目信任 flash，低分项目倾向 pro。                                                                        |
| **User Engagement Score / 用户投入度** | D4 综合评分（0-100）：基于 commitCount + labelCount。高投入意味着用户在认真推进，从侧面反证当前模型选择有效。                                                                                          |
| **Strategy Registry / 策略注册表**     | smart-context 内部维护的策略→arm 映射。AB 实验的 arm 各自绑定到一个 RoutingStrategy 实现。新增策略只需注册，不修改路由框架。                                                                           |
| **RoutingStrategy / 路由策略接口**     | `decide(prompt, ctx, signals) → PickDecision` — 统一的策略函数签名，所有策略（classifier、tree-escalation、pure-signals、conservative、project-first）实现此接口。                                     |

## smart-context 模型路由

| 术语                                     | 定义                                                                                                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Routing Strategy / 路由策略**          | 决定何时切换到哪个模型的一整套逻辑。当前唯一的策略是 classifier（LLM 分类器）。未来新增 heuristic（基于树结构指标）、hybrid（分类器+树指标混合）等。         |
| **Complexity Classifier / 复杂度分类器** | 当前策略的核心组件——用一个廉价 LLM（flash）看最近对话历史，判断任务复杂度（trivial/simple/medium/complex），然后路由到对应模型。                             |
| **Model Profile / 模型配置**             | 一个命名的模型映射方案（balanced/fast/quality/custom），定义了每个复杂度等级使用什么模型。                                                                   |
| **Route Decision / 路由决策**            | 每次 `before_agent_start` 产生的一次模型选择结果，包含目标 model、原因（classifier/largeContext）、元数据。                                                  |
| **Turn Outcome / 轮次反馈**              | 一个 turn 结束后对该 turn 路由决策的评价：用户是否回滚/重试了该 turn 的结果 + 该 turn 的 edit 是否保留到最终 commit。二元 success 驱动 pi-lab 的贝叶斯更新。 |

## pi-lab 与 smart-context 集成

| 术语                                   | 定义                                                                                                                                                                          |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Namespace / 命名空间**               | `ExperimentDef.namespace` 字段，弱依赖消费方传入自身的包名（如 `"smart-context"`），pi-lab 内部自动加前缀变为 `"smart-context::routing-strategy"`，避免与强依赖同名实验冲突。 |
| **Flat Arm / 展平臂**                  | 将策略类型 × 策略参数的所有组合展平为一个一维 arm 列表。简化 pi-lab 的实验设计，避免嵌套实验的复杂度。                                                                        |
| **Turn-Level Experiment / 轮次级实验** | 每次 agent turn 触发一次 arm 选择和 outcome 记录，而非 session 级。                                                                                                           |
| **Delayed Outcome / 延迟反馈**         | outcome 中的 commit 部分无法在当前 turn 结束时立即判定，需要延迟到用户 commit 或 session 结束时补录。                                                                         |

## Cloud Sessions

| 术语                 | 定义                                                                                                                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ConflictResolver** | 纯决策引擎，接收本地/远端文件的 `FileState` 对，返回 `Resolution`。不执行任何文件操作。                                                                                                                  |
| **Resolution**       | ConflictResolver 的输出。`action`: `push_local` / `pull_remote` / `skip` / `merge`，带可选的 `mergedContent` 和 `reason`。                                                                               |
| **MtimeResolver**    | ConflictResolver 的默认实现。基于 hash 和 mtime 差异做 4 路决策。构造时可配 `toleranceMs` 和 `tieBreaker`。                                                                                              |
| **Merger**           | 负责生成合并后内容。`merge(localPath, remotePath) → Promise<string>`。延迟读文件，仅在需要 merge 时调用。                                                                                                |
| **ProjectMatcher**   | 从同步镜像中查找同一项目的其他机器目录、复制匹配会话到当前 cwd 目录的策略接口。`match(config: ProjectMatchConfig, machineId: string, sessionsRoot: string, mirrorRoot: string) → Promise<MergeResult>`。 |
| **Sync**             | 同步编排器，内部 `syncFiles()` + `applyProjectMatch()` 分别走 ConflictResolver 和 ProjectMatcher，最终一次 `provider.push()` 提交。                                                                      |
