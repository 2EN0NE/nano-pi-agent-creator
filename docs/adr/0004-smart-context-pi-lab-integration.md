# ADR-0004: smart-context 接入 pi-lab 实验框架设计

**状态**: 提议中  
**日期**: 2025-07  
**背景**: grilling session（16 轮追问）+ domain-modeling 输出 + 全局审查

## 问题

smart-context 当前只有一种路由策略（LLM 分类器），缺乏对不同策略的 AB 测试能力。需要接入 pi-lab 实验框架，支持：

1. 同一策略内不同模型参数组合的对比
2. 不同路由策略（分类器 vs 基于信号的自发式 vs 混合）的对比
3. 基于会话回滚/分叉/上下文使用等复杂信号的策略实验

## 决策

### 1. 四层架构

```
smart-context （context/ — 路由引擎 + pi-lab 消费方）
    ↓ select/record
@zenone/pi-lab （meta/ — 实验框架层）
    ↓ 查询树信息
@zenone/pi-session-tree （meta/ — 会话树查询服务）
    ↓ 读取原始树
Pi SessionManager （Layer 0 — 原生数据层）
```

- **pi-session-tree**：独立包，会话树查询服务。提供 8 类查询接口（节点、路径、结构、聚合、内容、窗口、标注、快照），封装 Pi 原生 SessionManager 的裸树结构。
- **smart-context**：作为 pi-lab 的弱依赖消费方（方案 A，globalThis 桥接），在 `session_start` 中注册实验。pi-lab 不可用时降级为固定 classifier 策略并显式通知用户。
- **pi-lab**：新增 `namespace` 字段支持弱依赖命名空间隔离，`ExperimentDef.namespace` 自动作为前缀加在实验名前。

### 2. pi-lab 强弱依赖选择指南

pi-lab README 中记录以下指南：

**强依赖（import）适用：** 插件的核心功能本身就是实验驱动的，没有实验功能无意义。

**弱依赖（globalThis 桥接）适用：** 实验是对现有功能的增强/优化，插件有合理的兜底行为。

### 3. 命名空间机制

pi-lab 的 `ExperimentDef` 新增 `namespace` 字段：

```typescript
interface ExperimentDef {
	name: string;
	namespace?: string; // 弱依赖消费方传入，内部变为 "namespace::name"
	arms: ArmDef[];
	strategy: BanditStrategy;
}
```

`registerWeakExperiment({ name: 'routing-strategy', namespace: 'smart-context' })` → 内部注册为 `smart-context::routing-strategy`，与强依赖同名实验不冲突。

### 4. 臂设计：展平而非嵌套

将「策略类型 × 策略参数」展平为一个一维 arm 列表，不引入嵌套实验。

```
arms = [
  "classifier-balanced",     // 分类器策略 + balanced 参数
  "classifier-fast",         // 分类器策略 + fast 参数
  "classifier-quality",      // 分类器策略 + quality 参数
  "heuristic-rollback",      // 启发式策略 v1 — 回滚信号
  "heuristic-context",       // 启发式策略 v2 — 上下文信号
  "hybrid-v1",              // 混合策略 v1
]
```

**理由**：pi-lab 的 Thompson Sampling 在臂数 < 20 时效果良好，展平不会导致收敛过慢。避免引入嵌套实验的复杂 API 变更。

### 5. 实验粒度：Turn 级别

每次 `before_agent_start` 触发 arm 选择，每个 turn 结束时记录 outcome。

| 粒度        | 适用场景               | 不适用理由                                   |
| ----------- | ---------------------- | -------------------------------------------- |
| tool-call   | 单工具内部策略选择     | smart-context 的决策影响整个 turn            |
| **turn** ✅ | smart-context 路由决策 | 每次路由决策一次 arm，outcome 与决策直接对应 |
| session     | 全会话固定策略         | 无法捕捉同 session 内不同任务的表现差异      |

### 6. Outcome 定义：二元 success

```
success = (turn 未被回滚/重试) AND (turn 的 edit 保留到最终 commit)
```

**判断时机**：延迟反馈（delayed outcome）。在 `turn_end` 记录 pending outcome，后续 commit 检测或 session 结束时补录。

### 7. 会话树查询服务：@zenone/pi-session-tree

独立包放在 `extensions/meta/pi-session-tree/`。

#### 设计决策

| #   | 决策       | 结论                                                                                 |
| --- | ---------- | ------------------------------------------------------------------------------------ |
| 1   | 模块定位   | 纯查询层 + 持久化标注（写 CustomEntry），不做事件增量缓存                            |
| 2   | 查询范围   | 8 类全覆盖：节点、路径、结构、聚合、内容、窗口、标注、快照                           |
| 3   | API 形态   | 类实例 `createSessionTree(sessionManager, pi)`，封装 snapshot 状态和 annotation 写入 |
| 4   | Entry 类型 | 自有 TreeNode 抽象，隔离 Pi 版本，可附加 depth/branchIndex                           |
| 5   | 快照       | 轻量：leafId + entry 数量，diff 返回增量概述                                         |
| 6   | 标注       | 调用方自由命名 customType，模块不强制前缀                                            |

#### 8 类查询接口

| 类别    | 查询                                                                                                          | 说明                       |
| ------- | ------------------------------------------------------------------------------------------------------------- | -------------------------- |
| A. 节点 | `findByType(type)`, `findByLabel(label)`, `findAncestor(id, type)`                                            | 按类型/标签/祖先关系找节点 |
| B. 路径 | `pathToLeaf()`, `pathBetween(from,to)`, `distance(from,to)`, `LCA(id1,id2)`, `entriesBetween(from,to)`        | 路径遍历和分析             |
| C. 结构 | `branchCount()`, `maxDepth()`, `pathLength()`, `treeComplexity()`                                             | 整树统计指标               |
| D. 聚合 | `countByType(path, type)`, `toolCallDistribution(path)`, `compactionHistory(path)`, `entryTypeTimeline(path)` | 路径上的类型/工具分布      |
| E. 内容 | `extractUserMessages(path)`, `detectKeywords(path, kw)`, `extractLabels()`                                    | 文本提取和关键词匹配       |
| F. 窗口 | `lastN(n)`, `entriesSinceLastCompaction()`                                                                    | 最近/范围内查询            |
| G. 标注 | `annotate(entryId, customType, data)`, `getAnnotations(customType)`                                           | 读写 CustomEntry           |
| H. 快照 | `snapshot()`, `diff(prevSnapshot)`                                                                            | 增量变化检测               |

#### 三层定位

|               | Layer 0 (Pi)    | Layer 1 (pi-session-tree)                              | Layer 2 (应用)           |
| ------------- | --------------- | ------------------------------------------------------ | ------------------------ |
| 返回          | 原始 entry 对象 | 统计数字、筛选列表、路径切片                           | 布尔决策、摘要文本、UI   |
| 懂 entry type | 否              | 是                                                     | 是（业务语义）           |
| 有算法        | 否              | 是（LCA、路径距离、复杂度）                            | 是（加权打分、策略路由） |
| 例子          | `getTree()`     | `getBranches()` / `pathBetween()` / `treeComplexity()` | "这是复杂会话 → 切 pro"  |

### 8. MVP 路径

### 9. 拆分为两个实验

- `smart-context::session-init`：session 启动时选择 arm，检测子任务（parentSession）决定使用简单还是复杂模型
- `smart-context::turn-routing`：每个 turn 的 `before_agent_start` 选择 arm，决定该 turn 的路由策略

### 10. Turn 级 outcome 匹配：标注 + pending queue

每次 `select()` 后通过 `pi-session-tree.annotate()` 将 armId 写入当前 turn 的 entry（持久化，跨 /reload 安全）。同时在内存中维护 `Map<turnIndex, PendingOutcome>` 追踪延迟 record。commit/回滚检测触发后从 queue 取出匹配的 outcome 并 record。

### 11. 重试检测：BM25 + LLM 两级

pi-session-tree 提供 `detectRetry(fromEntry, toEntry)` 能力：

- 第一级：BM25 分词比对。score > 高阈值 → 直接判定为重试
- 第二级：BM25 低于阈值 → 调用 LLM 做语义相似度判断
- 模型可配置：默认为当前会话使用的模型，通过 TUI 面板可选其他可用模型，配置持久化跨会话生效

### 12. pi-session-tree 双重形态

pi-session-tree 同时作为：

- **纯库**：`createSessionTree(sessionManager, pi)` 供其他插件 import
- **Pi 扩展**：提供 `/tree-stats` 调试命令 + TUI 面板展示查询结果

### 13. MVP 路径

**Phase 1**：`@zenone/pi-session-tree` 模块

- 创建包结构（package.json, tsconfig, index.ts）
- 实现 8 类查询接口 + TreeNode 类型抽象 + BM25 重试检测 + TUI 面板
- 编写 Vitest 单元测试
- 编写 pi-lab 强弱依赖指南到 pi-lab README
- 同步到 project profile，端到端验证

**Phase 2**：pi-lab namespace 支持

- ExperimentDef 新增 `namespace` 字段
- registerWeakExperiment 内部自动加前缀
- 更新 pi-lab README

**Phase 3**：smart-context 接入 pi-lab

- smart-context 通过 globalThis 桥接弱依赖 pi-lab
- 注册两个实验（session-init + turn-routing）
- 实现标注 + pending queue 的 outcome 匹配机制
- 将当前 classifier 策略作为第一个 arm

**Phase 4**：新策略 arm + 端到端 AB

- 实现 heuristic 策略（基于 pi-session-tree 的树结构指标）
- 展平为多个 arm，加入实验
- AB 测试运行

## 理由

- **展平臂** 避免 pi-lab 核心 API 的复杂度膨胀，且臂数在可接受范围
- **Turn 级别** 是 smart-context 的自然粒度，路由决策和 outcome 直接对应
- **三层分离** Layer 1 查树 + Layer 2 做业务决策，关注点清晰，各层可独立测试
- **自有类型** 隔离 Pi 版本，附加 depth/branchIndex 等计算字段
- **延迟反馈** 是 turn 级 outcome 的必然代价，commit 只能在事后判定
- **弱依赖 + namespace** smart-context 有合理兜底，用户显式感知 pi-lab 缺位，命名空间避免冲突

## 其他方案考虑

- **嵌套实验**：被否决，pi-lab 核心复杂度增加过大，展平足以满足当前臂数需求
- **Session 级实验**：被否决，反馈周期太长，收敛慢
- **事件缓存**：被否决，MVP 树规模下每次现算足够，缓存引入不必要的复杂度
- **透传 Pi 类型**：被否决，调用方需了解 Pi 内部结构，且无法附加 depth 等计算字段
- **强依赖 pi-lab**：被否决，smart-context 有合理的兜底行为，弱依赖 + 显式警告更合适

## 影响

- 需新建 `extensions/meta/pi-session-tree/`（库 + 扩展 + TUI + BM25 + 重试 LLM）
- pi-lab `ExperimentDef` 需新增 `namespace` 字段
- pi-lab README 需新增强弱依赖选择指南
- smart-context 路由逻辑须改造为「策略注册表」模式
- smart-context 需注册两个实验（session-init + turn-routing）
- smart-context 需实现标注 + pending queue 的 outcome 匹配
- smart-context 路由决策分两级：session_init → 默认模型，before_agent_start → turn 级覆盖
- `turn_end` 中 record outcome（延迟补录）
- sync-profiles.yaml 需新增 pi-session-tree
