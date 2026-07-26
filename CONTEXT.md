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

## Cloud Sessions

| 术语                 | 定义                                                                                                                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ConflictResolver** | 纯决策引擎，接收本地/远端文件的 `FileState` 对，返回 `Resolution`。不执行任何文件操作。                                                                                                                  |
| **Resolution**       | ConflictResolver 的输出。`action`: `push_local` / `pull_remote` / `skip` / `merge`，带可选的 `mergedContent` 和 `reason`。                                                                               |
| **MtimeResolver**    | ConflictResolver 的默认实现。基于 hash 和 mtime 差异做 4 路决策。构造时可配 `toleranceMs` 和 `tieBreaker`。                                                                                              |
| **Merger**           | 负责生成合并后内容。`merge(localPath, remotePath) → Promise<string>`。延迟读文件，仅在需要 merge 时调用。                                                                                                |
| **ProjectMatcher**   | 从同步镜像中查找同一项目的其他机器目录、复制匹配会话到当前 cwd 目录的策略接口。`match(config: ProjectMatchConfig, machineId: string, sessionsRoot: string, mirrorRoot: string) → Promise<MergeResult>`。 |
| **Sync**             | 同步编排器，内部 `syncFiles()` + `applyProjectMatch()` 分别走 ConflictResolver 和 ProjectMatcher，最终一次 `provider.push()` 提交。                                                                      |
