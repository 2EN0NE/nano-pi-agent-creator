# ADR-0005: smart-context 路由策略设计

**状态**: 提议中
**日期**: 2025-07
**背景**: grilling session + 策略设计追问

## 问题

smart-context 的 AB 实验需要多个**在相同输入下会产生不同决策**的策略。如果策略之间差异不大（如仅阈值不同），AB 对比无意义。

## 决策

### 1. 策略决策空间

每个策略在三轴上差异化：

| 轴       | 含义                    | 示例                                         |
| -------- | ----------------------- | -------------------------------------------- |
| 信号维度 | 使用 D1-D4 中哪些维度   | classifier 只用 D1，pure-signals 用 D2+D3+D4 |
| LLM 依赖 | 是否需要 LLM 调用       | classifier 需要，pure-signals 不需要         |
| 升级倾向 | 多容易从 flash 升到 pro | conservative 门槛高，aggressive 门槛低       |

### 2. 四维信号体系

| 维度          | 信号                                                                                        | 来源                  |
| ------------- | ------------------------------------------------------------------------------------------- | --------------------- |
| D1. 当前 turn | promptLength, promptComplexity（代码块数/文件引用数）, LLM 分类结果, contextUsage           | smart-context 直接采  |
| D2. 会话树    | branchCount, checkpointCount, compactionCount, toolDistribution, toolErrorRate, isRetry     | pi-session-tree       |
| D3. 工程体系  | agentsMdExists/Size, readmeMdExists/Size, extensionCount, hasCustomPreset → projectDocScore | 读文件系统            |
| D4. 会话进度  | commitCount, labelCount → userEngagementScore                                               | pi-session-tree + git |

### 3. 五个策略

#### A. classifier（基准臂）

- 信号维度：D1
- LLM 依赖：是（flash 分类 prompt+上下文）
- 升级倾向：中性（遵循 profile 配置的复杂度→模型映射）

**决策规则**：

```
complexity = LLM.classify(prompt, recentContext)
model = profile.routing[complexity]
```

**假设**：LLM 理解任务语义，对大部分场景足够。

#### B. tree-escalation（树信号升级）

- 信号维度：D1 + D2
- LLM 依赖：是（以 LLM 分类为底）
- 升级倾向：只升级不降级

**决策规则**：

```
complexity = LLM.classify(prompt, recentContext)
if branchCount >= 3 → complexity = max(complexity, nextLevel)
if checkpointCount >= 3 AND complexity == simple → complexity = medium
if compactionCount >= 2 → complexity = max(complexity, medium)
if isRetry AND branchCount >= 2 → complexity = medium
model = profile.routing[complexity]
```

**假设**：LLM 判断任务本身够好，但树信号能补充"对话过程中的困难"信号。

#### C. pure-signals（纯信号，无 LLM）

- 信号维度：D2 + D3 + D4
- LLM 依赖：否
- 升级倾向：中性

**决策规则**（加权打分）：

```
score = 0
score += branchCount * 15         // 每分支 +15
score += checkpointCount * 10     // 每 checkpoint +10
score += compactionCount * 20     // 每 compaction +20
score += toolErrorRate * 25       // 工具失败率加权
score += isRetry ? 30 : 0         // 重试 +30
score -= projectDocScore * 0.3    // 好文档 -0~30
score -= userEngagementScore * 0.2 // 高投入 -0~20

complexity = score < 20 → simple; < 50 → medium; ≥ 50 → complex
model = profile.routing[complexity]
```

**假设**：不看 prompt 内容也能通过结构和工程信号做出正确路由。零 LLM 开销。

#### D. conservative（保守升级）

- 信号维度：D1-D4
- LLM 依赖：是
- 升级倾向：保守（高门槛才升）

**决策规则**：

```
complexity = LLM.classify(prompt, recentContext)
// 仅当 LLM 和≥2个树信号同时触发才升级
upgradeTriggers = 0
if branchCount >= 4 → upgradeTriggers++
if checkpointCount >= 3 → upgradeTriggers++
if compactionCount >= 2 → upgradeTriggers++
if isRetry → upgradeTriggers++
if contextPercent > 80% → upgradeTriggers++
if upgradeTriggers >= 2 → complexity = max(complexity, nextLevel)
model = profile.routing[complexity]
```

**假设**：flash 对大多数任务已经足够。只有"多重信号同时报警"才值得升级。

#### E. project-first（工程优先）

- 信号维度：D1-D4，D3 权重最高
- LLM 依赖：是
- 升级倾向：由工程体系决定基线

**决策规则**：

```
// 工程体系决定基线复杂度
if projectDocScore < 20 → baselineComplexity = medium   // 文档稀疏→偏向 pro
elif projectDocScore < 50 → baselineComplexity = simple
else → baselineComplexity = trivial                        // 文档完善→信任 flash

// LLM 分类在此基础上只能升级
complexity = max(LLM.classify(prompt, recentContext), baselineComplexity)

// 树信号兜底升级
if branchCount >= 5 → complexity = complex
if isRetry → complexity = max(complexity, medium)

model = profile.routing[complexity]
```

**假设**：工程文档完善程度是"这个项目是否需要强大模型"的最佳预测器。好文档项目简单模型即可，差文档项目从一开始就需要 pro 来补偿上下文缺失。

### 4. 策略对比矩阵

|               | classifier | tree-escalation | pure-signals | conservative | project-first  |
| ------------- | ---------- | --------------- | ------------ | ------------ | -------------- |
| 用 LLM        | 是         | 是              | **否**       | 是           | 是             |
| 用树信号      | 否         | 是              | 是           | 是           | 是             |
| 用工程信号    | 否         | 否              | 是           | 是           | **核心**       |
| 用进度信号    | 否         | 否              | 是           | 是           | 否             |
| 升 pro 容易度 | 中         | 中高            | 中           | **低**       | **取决于工程** |
| 核心假设      | LLM 够了   | 树信号补盲      | 结构也能路由 | flash 够用   | 工程文档是锚   |

### 5. 策略注册表接口

```typescript
interface RoutingStrategy {
	name: string;
	decide(
		prompt: string,
		ctx: ExtensionContext,
		signals: SessionSignals,
	): Promise<PickDecision | null>;
}

// SessionSignals 由各维度聚合
interface SessionSignals {
	// D1: turn-local
	promptLength: number;
	promptComplexity: { codeBlocks: number; fileRefs: number };
	contextUsage: ContextUsage;

	// D2: session tree (from pi-session-tree)
	branchCount: number;
	checkpointCount: number;
	compactionCount: number;
	toolDistribution: Record<string, number>;
	toolErrorRate: number;
	isRetry: boolean;

	// D3: project profile
	projectDocScore: number; // 0-100
	agentsMdSize: number;
	readmeMdSize: number;
	extensionCount: number;

	// D4: session progress
	commitCount: number;
	labelCount: number;
	userEngagementScore: number; // 0-100
}
```

## 理由

- **5 个策略覆盖决策空间对角**：LLM/无LLM、纯/混合、保守/激进、工程感知/任务感知
- **每个策略有明确的实验假设**，AB 测试结果有解释性
- **策略注册表接口**使新增策略只需实现一个函数，不需要改路由框架
- **信号聚合为 SessionSignals** 统一了所有策略的输入，避免各自采信号

## 影响

- smart-context 需新增 `strategies/` 目录，每个策略一个文件
- 路由逻辑从"hardcoded classifier"改为"策略注册表 + arm dispatch"
- AB 实验的 arm 映射到具体策略实例
- ADR-0004 的 T6/T7 需包含策略注册表实现
