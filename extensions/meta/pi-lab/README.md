# @zenone/pi-lab — 实验框架 (Experiment / A/B Testing Framework)

## 设计缘起

本框架从 edit 工具的实现策略对比需求出发，抽象为通用的多臂老虎机实验框架。
框架本身不绑定任何具体场景，只提供：**分配臂 → 收集反馈 → 更新策略状态** 三件事。

未来可复用于模型切换策略选择、compaction 策略选择等场景。

## 核心设计决策（2025-07 讨论记录）

### 架构分层

```
@zenone/pi-lab (meta 元插件)
  │  registerExperiment({ name, arms, strategy })
  │  select(name, ctx) → armId
  │  record(name, armId, outcome)
  ▼
消费方插件（edit / model-switcher 等）
  │  注册实验 → 每次 execute 时 select → 按结果执行 → record
```

### 关键决策清单

| #   | 决策              | 结论                                                                          | 理由                                                 |
| --- | ----------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------- |
| 1   | 架构分层          | 框架层 (@zenone/pi-lab) + 消费层 (edit 等)                                    | 分离关注点，复用决策引擎                             |
| 2   | AB 连接方式       | **配置注册式** — 消费方注册 arm + 执行函数，框架只路由                        | 框架中立，不侵入业务语义                             |
| 3   | 工具切换方式      | **单工具内部 dispatch** — 不碰 `setActiveTools`                               | 避免与 tools.ts / preset.ts 冲突                     |
| 4   | 与 tools.ts 关系  | 实验模块不碰工具切换 API                                                      | tools.ts 的 tool_call handler 有硬阻断，冲突不可调和 |
| 5   | 与 preset.ts 关系 | **独立**，不依赖 preset                                                       | preset 是用户主动选择，实验是数据驱动，两层正交      |
| 6   | select 调用时机   | **每次 execute 都选**（Thompson Sampling 每步独立采样）                       | 收敛速度快；Pi 的 tool call 之间无会话内相关         |
| 7   | Arm 函数签名      | `() => Promise<unknown>` — 通过闭包捕获依赖                                   | 框架零类型依赖，消费方最灵活                         |
| 8   | Outcome 维度      | **多维**：success, firstAttempt, latencyMs, errorType, cost, contextFootprint | 覆盖业界 LLM 可观测性 5 层信号                       |
| 9   | 贝叶斯更新信号    | 仅用 `success`（binary）做 Beta-Bernoulli 更新                                | 保持数学单纯，其他维度存 metadata                    |
| 10  | 存储模型          | 每个实验一个 JSON 文件，`extensions-data/pi-lab/<experiment>.json`            | 无锁竞争，易查看，易删除                             |
| 11  | 写入策略          | 内存增量更新 + debounced 写盘 (2s) + shutdown flush                           | 平衡 I/O 与数据安全                                  |
| 12  | /experiment 面板  | TUI 面板：当前 session / 全局 双 tab；子视图含参数设置、统计、重置            | 参考 pi-plugins-manager 风格，无左右竖线边框         |
| 13  | 重置安全          | 面板只提示 "高风险操作，手动删除 xxx 文件夹下的数据"                          | 不提供一键清空按钮                                   |
| 14  | 状态栏            | `                                                                             | lab:off`(dim) /`                                     | lab:collecting`(无着色) /` | lab:switched`(高亮) | 用户随时感知实验状态 |

### Outcome 接口设计（参考 Langfuse / LangSmith / Arize Phoenix）

```
Tier 1: 核心 — success (驱动贝叶斯更新)
Tier 2: 质量 — firstAttempt, latencyMs, errorType
Tier 3: 成本 — totalTokens, costUsd (预留)
Tier 4: 上下文影响 — contextFootprintBytes, compactionTriggered (Pi 特有)
Tier 5: 调试 — errorMessage, metadata (不入 bandit 数学)
```

### 存储格式示例

```json
// ~/.pi/agent/extensions-data/pi-lab/edit-matching.json
{
	"version": 1,
	"strategy": "thompson-sampling",
	"arms": ["classic", "row-script"],
	"models": {
		"anthropic:claude-sonnet-4-5": {
			"classic": {
				"alpha": 42,
				"beta": 3,
				"firstAttempts": 38,
				"totalCalls": 45,
				"totalLatencyMs": 12500
			},
			"row-script": {
				"alpha": 18,
				"beta": 7,
				"firstAttempts": 10,
				"totalCalls": 25,
				"totalLatencyMs": 14200
			}
		}
	}
}
```

### 实验框架与 preset/tools 的协作边界

```
preset.ts          ─── 用户主动选择工具集
                         │
tools.ts           ─── 用户/工具管理工具的启用/禁用
                         │  (tool_call handler 硬阻断)
                         ▼
pi.setActiveTools() ─── Pi 运行时
                         │
edit 工具内部       ─── pi-lab.select('edit-strategy')
                         │  返回 arm ID，edit 内部 dispatch
                         ▼
classicImpl() / rowScriptImpl()
```

**pi-lab 不碰任何 setActiveTools / \__toolsApi 调用。** 它只回答一个问题：这次用哪个策略？

---

## 消费方接入指南

### 接入方式

消费方插件按与 pi-lab 的耦合强度分两种方式接入：

| 方式                 | API                                                                                         | 耦合         | package.json 依赖                         | 优先级 |
| -------------------- | ------------------------------------------------------------------------------------------- | ------------ | ----------------------------------------- | ------ |
| **弱依赖（方案 A）** | `registerWeakExperiment()` — 通过 `globalThis.__labApi` 桥接                                | 不引入包依赖 | 不需要                                    | 低     |
| **强依赖（方案 B）** | `registerStrongExperiment()` — 直接 `import { getExperimentManager } from '@zenone/pi-lab'` | 引入包依赖   | `"@zenone/pi-lab": "file:../meta/pi-lab"` | 高     |

### 两条铁律

#### ① 注册必须在 `session_start` 中

**禁止在模块工厂函数中注册实验。** 必须推迟到 `session_start` 事件处理器中。

原因：

- 消除加载顺序竞险（`edit` → `pi-lab` 的字母序问题）
- 确保所有扩展已加载，`globalThis.__labApi` 已就绪
- 确保证册时有 `ctx` 可用，冲突时可推送 UI 通知

```typescript
// ✅ 正确：方案 A（弱依赖）— 在 session_start 中注册
pi.on('session_start', async (_event, ctx) => {
  const lab = (globalThis as any).__labApi?.getExperimentManager?.();
  if (!lab) {
    log.warn('pi-lab not available — running without experiment');
    return;
  }
  const exp = lab.registerWeakExperiment({
    name: 'edit-strategy',
    contextKey: (ctx) => `${ctx.model?.provider ?? 'unknown'}:${ctx.model?.id ?? 'unknown'}`,
    arms: [
      { id: 'classic', label: 'Exact text matching' },
      { id: 'row-script', label: 'Fuzzy line matching' },
    ],
    strategy: 'thompson-sampling',
  });
  // 保存 select/record 引用供后续 tool execute 使用
  labSelect = () => exp.select();
  labRecord = (armId, outcome) => exp.record(armId, outcome);
});

// ✅ 正确：方案 B（强依赖）— 在 session_start 中注册
import { getExperimentManager } from '@zenone/pi-lab';

export default function (pi: ExtensionAPI) {
  let labSelect: (() => Promise<string>) | undefined;
  let labRecord: ((armId: string, outcome: any) => Promise<void>) | undefined;

  pi.on('session_start', async (_event, ctx) => {
    const mgr = getExperimentManager();
    const exp = mgr.registerStrongExperiment({
      name: 'edit-strategy',
      arms: [...],
      strategy: 'thompson-sampling',
    });
    labSelect = () => exp.select();
    labRecord = (armId, outcome) => exp.record(armId, outcome);
    ctx.ui.notify('edit-strategy experiment active', 'info');
  });
}
```

#### ② 消费方必须自行处理降级

pi-lab **不阻塞**消费方的启动。如果 pi-lab 不可用（未安装/加载失败），消费方必须自己提供兜底行为。

| 反馈级别 | 行为                               | 适用场景                                       |
| -------- | ---------------------------------- | ---------------------------------------------- |
| `silent` | 静默降级，无提示                   | 有完善兜底方案的插件（如 edit 回退到 classic） |
| `warn`   | pi-logger 日志 + 如有 UI 则 notify | 有降级但希望用户知情                           |
| `block`  | 不允许使用（当前不实现）           | 预留                                           |

### 冲突裁决

同名实验冲突时按以下规则处理：

| 已有注册 | 新来注册 | 结果                                          |
| -------- | -------- | --------------------------------------------- |
| 强（B）  | 弱（A）  | 阻断 A — 静默丢弃 + 日志 + UI 通知            |
| 弱（A）  | 强（B）  | 覆盖 A — 强实验接管 + 日志 + UI 通知          |
| 同级     | 同级     | 后注册覆盖先注册（last-wins）+ 日志 + UI 通知 |

冲突时框架自动记录 pi-logger `warn` 日志，并在有 `ctx` 的上下文中通过 `ctx.ui.notify()` 推送通知到 TUI。

### API 入口

| API                             | 用途                        | 说明                       |
| ------------------------------- | --------------------------- | -------------------------- |
| `getExperimentManager()`        | 获取 ExperimentManager 单例 | 方案 B 通过 import 使用    |
| `registerStrongExperiment(def)` | 注册强依赖实验              | 优先级高，不会被弱依赖覆盖 |
| `registerWeakExperiment(def)`   | 注册弱依赖实验              | 优先级低，可能被强依赖覆盖 |
| `select(name, ctx?)`            | 选择臂                      | 返回 armId                 |
| `record(name, armId, outcome)`  | 记录反馈                    | 更新贝叶斯统计             |
| `forceArm(name, armId)`         | 强制固定臂                  | 调试用                     |
| `getExperiment(name)`           | 获取实验 API                | 用于查看统计               |

### 完整设计文档

详细的设计决策、冲突裁决原理、pi-lab 与 preset/tools 的协作边界见：

- `docs/adr/0003-pi-lab-extension-registration-mechanism.md` — 注册机制 ADR
- `CONTEXT.md` — 领域词汇表
