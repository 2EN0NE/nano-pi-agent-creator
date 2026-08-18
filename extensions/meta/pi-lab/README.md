# @zenone/pi-lab — 实验框架（Experiment / A/B Testing）

> 一个不绑定具体场景的多臂实验框架：**分配臂 → 收集反馈 → 出分析结论**。
> 它不做「切换决策」——切换归消费方（如 smart-context），它只做「结论的镜子」。

---

## 快速上手（30 秒看懂怎么用）

一个实验的完整生命周期只有四步：

```typescript
// ① 注册实验（必须在 session_start 中，消除加载顺序竞险）
pi.on('session_start', async (_event, ctx) => {
	const mgr = (globalThis as any).__labApi?.getExperimentManager?.();
	if (!mgr) return; // pi-lab 不可用 → 静默降级

	const exp = mgr.registerWeakExperiment({
		owner: 'edit', // 注册方身份 key（必填）——同 owner 同 name 视为同一逻辑实验
		name: 'edit-strategy',
		// 分组键 = 模型（分析/展示按此分层，控制模型效应混杂）
		contextKey: (ctx) => `${ctx.model?.provider}:${ctx.model?.id}`,
		// 分流键 = 会话（stable-hash 的分流单元，跨模型分布的稳定单元）。
		// ⚠️ 缺省会回退 contextKey=模型 → 臂与模型绑定（confounding），
		// 同一模型内无法对比两臂。务必显式声明会话级 assignKey。
		assignKey: (ctx) => ctx.sessionManager?.getSessionId?.() ?? 'unknown-session',
		arms: [
			{ id: 'classic', label: '精确匹配' },
			{ id: 'row-script', label: '模糊匹配' },
		],
		metrics: [{ id: 'match_success', type: 'binary', direction: 'maximize' }],
	});
	// 异 owner 撞名被阻断时返回 undefined → 判空降级
	labSelect = exp ? (ctx) => exp.select(ctx) : undefined; // 保存 select 引用供后续用
});

// ② 每次执行时选臂（返回 armId）
const armId = await labSelect(ctx);

// ③ 上报信号（三种方式，见下节「信号入口」）
log.info(`[pi-lab-signal] arm=${armId} metric=match_success value=1 ctx=${ctxKey}`);

// ④ 打开 /lab 面板看结论（胜出概率 / 可信区间 / 护栏告警）
```

打开 `/lab` 面板即可看到每个实验的贝叶斯分析结论。

---

## 信号入口：三种上报方式怎么选

pi-lab 支持三种上报 metric 的方式，各有适用场景：

| 入口                | 用法                                                       | 适用场景                                                                    | 用户感知 |
| ------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------- | -------- |
| **`record()` 直报** | `exp.record(armId, { metrics: {...} }, ctx)`               | 消费方需即时读取统计反馈、或需要 `metadata` 关联调试信息                    | 无感知   |
| **会话树 TAG**      | 用户在会话中打标签 `armId:metricId:value`                  | **用户显式反馈**——类似 Web 实验里「用户反馈采纳信号」，用户主动打标表达偏好 | 显式参与 |
| **pi-logger 日志**  | `log.info('[pi-lab-signal] arm=... metric=... value=...')` | **静默自动上报**——工具执行结果等无需用户感知的信号（如 edit 工具）          | 无感知   |

### 三种方式详解

**① record() 直报（同步 API）**

```typescript
await exp.record('classic', { metrics: { match_success: 1, latency_ms: 42 } }, ctx);
```

最直接，但要求消费方持有 `ExperimentAPI` 引用（`select` 本来就要持有）。

**② 会话树 TAG（用户显式反馈）**

用户在会话里给节点打标签，格式 `armId:metricId:value`（如 `row-script:helpful:1`）。
pi-lab 在 `turn_end` 时从会话树自动采集。

适合：需要用户**主动表达反馈**的场景（如「这个策略好不好用」），类似 Web 实验的用户反馈按钮。
**smart-context 这类涉及用户体验的选择，适合用会话树。**

**③ pi-logger 日志（静默自动上报）**

```typescript
log.info(
	`[pi-lab-signal] arm=${armId} metric=match_success value=${success ? 1 : 0} ctx=${ctxKey}`,
);
```

pi-lab 通过订阅 pi-logger 事件实时采集（无需轮询文件、无重复）。
适合：工具执行结果等**静默自动上报**的信号。
**edit 这类工具内部策略对比，适合用日志（用户无感知）。**

> ⚠️ 日志行格式必须匹配：`[pi-lab-signal] arm=<armId> metric=<metricId> value=<value> [ctx=<ctxKey>]`
> 其中 `ctx` 可选（缺省 `global`），`value` 为数字。

---

## 指标定义

### 基础指标

```typescript
metrics: [
	{
		id: 'match_success',
		type: 'binary',
		direction: 'maximize',
		description: '精确匹配是否命中（1=命中，0=未命中）',
	}, // 是/否
	{
		id: 'latency_ms',
		type: 'continuous',
		direction: 'minimize',
		description: '编辑耗时（毫秒，越低越好）',
	}, // 数值
	{ id: 'tool_calls', type: 'count', direction: 'maximize' }, // 计数
	{ id: 'error_rate', type: 'binary', direction: 'minimize', isGuardrail: true }, // 护栏：只告警不选赢家
];
```

- `type`：`binary` / `continuous` / `count`，对应 Beta / 正态 / Poisson-Gamma 贝叶斯后验
- `direction`：`maximize`（越大越好）/ `minimize`（越小越好）
- `isGuardrail`：护栏指标，不参与选赢家，只在 arm 显著更差时告警
- `description`（可选）：人话描述，`/lab` 面板统计视图在指标 id 下方展示，帮助理解指标含义（派生指标同样适用）

### 派生指标（声明式复合）

复合评分是消费方的领域逻辑，pi-lab 提供两个原语而非硬编码，**在 `query()` 时按声明投影计算**（改权重可回溯重算历史）：

```typescript
metrics: [
	{ id: 'first_attempt', type: 'binary', direction: 'maximize' },
	{ id: 'latency_ms', type: 'continuous', direction: 'minimize' },
	{
		id: 'quality_score',
		type: 'continuous',
		direction: 'maximize',
		derived: {
			kind: 'weighted-sum', // 加权和
			components: [
				{ metricId: 'first_attempt', weight: 0.8 },
				{ metricId: 'latency_ms', weight: 0.2 },
			],
		},
	},
	{
		id: 'any_error',
		type: 'binary',
		direction: 'minimize',
		derived: { kind: 'any-fail', components: [{ metricId: 'e1' }, { metricId: 'e2' }] }, // 任一失败
	},
];
```

- `weighted-sum`：`Σ(weight × 源metric值)`，源值仍由消费方 `record()` 直报
- `any-fail`：任一源 metric ≥ 0.5 视为 fail（1），否则 0

---

## 分配策略

| 策略                  | 说明                                                                  | 何时用                             |
| --------------------- | --------------------------------------------------------------------- | ---------------------------------- |
| `stable-hash`（默认） | 稳定哈希分桶，同一 **assignKey（分流键）** 恒定分到同一 arm，默认等权 | 固定分流 + 事后统计检验（AB 测试） |

> bandit（thompson-sampling / epsilon-greedy）已拆除——在线优化与 AB 测试目标相反
> （自适应倾斜流量破坏统计有效性），未来若需引入，应作为独立「模式」正交拆分。

```typescript
registerWeakExperiment({
 owner: 'edit', // 必填
 name: 'edit-strategy',
 contextKey: ...,          // 分组键（分析分层，通常=模型）
 assignKey: ...,           // 分流键（稳定单元，通常=会话；缺省回退 contextKey）
 arms: [{ id: 'classic', label: '...', weight: 1 }, { id: 'row-script', label: '...', weight: 1 }],
 ...
})
```

> `weight` 控制 arm 间流量比例（stable-hash 分桶时生效）。

---

## 消费方接入（强弱依赖 + 两条铁律）

| 方式                 | API                                                     | 耦合       |
| -------------------- | ------------------------------------------------------- | ---------- |
| **弱依赖（方案 A）** | `globalThis.__labApi` 桥接，不 import 包                | 低         |
| **强依赖（方案 B）** | `import { getExperimentManager } from '@zenone/pi-lab'` | 引入包依赖 |

### 两条铁律

1. **注册必须在 `session_start` 中**——禁止在模块工厂函数顶层注册（消除加载顺序竞险，确保 `__labApi` 就绪）。
2. **消费方必须自行降级**——pi-lab 不阻塞消费方启动；`__labApi` 缺失时用兜底行为（如 edit 回退 classic）。

### 注册身份与冲突裁决

pi-lab 以 `(owner, name)` 二元组识别逻辑实验身份，注册裁决三分支：

| 场景                       | 结果                                                           |
| -------------------------- | -------------------------------------------------------------- |
| 全新注册                   | 返回新 API                                                     |
| 同 owner 同 name，口径未变 | 幂等重声明，静默复用已存在实验                                 |
| 同 owner 同 name，口径变化 | 原地更新定义 + `warn` 告警（含历史数据口径不一致的副作用说明） |
| 异 owner 同 name           | 硬冲突（`error` + UI 通知），阻断后注册者并返回 `undefined`    |

- `owner` 为必填字段，消费方自行决定其命名/层级语义（插件名、或编码 user/project 级别）。
- 撞名是配置错误而非竞争——后注册者被阻断，请改实验名或统一 owner。

---

## /lab 面板使用教程

命令 `/lab` 打开实验面板。**面板是「看结论」的地方**——实验由消费方插件（如 edit）自动注册，数据在后台累积。

### 面板结构

两级导航（master-detail）：一级选实验，二级对当前实验操作。

**一级（实验列表，1 个 SelectList + 滚动视口）：**

```
┌── pi-lab ────────────────────┐
  分桶    汇总                ← Tab 栏（Tab 键切换）
 ───────────────────────────────
→ edit:edit-strategy  精确匹配 vs 模糊行匹配 (stable-hash)   ← 插件名:实验名 + arm 摘要
  custom-compaction:prompt-strategy  结构化 vs 叙事 (stable-hash)
 ───────────────────────────────
  Tab/⇧Tab 切标签 · ↑↓ 导航 · ⏎ 进入 · esc 关闭
└──────────────────────────────┘
```

- 每行显示 `插件名:实验名`（owner 区分实验归属插件；如 `edit:edit-strategy`、`custom-compaction:prompt-strategy`）
- 实验数超过 8 个时列表内部滚动，不撑高面板

**二级（实验操作，操作条 Tab 切换）：**

```
┌── pi-lab · edit:edit-strategy ──┐
  [统计] [设置] [重置]            ← Tab/⇧Tab 切换操作
 ─────────────────────────────────
  （统计图表 / 设置表单 / 重置确认）
 ─────────────────────────────────
  Tab/⇧Tab 切操作 · ←→ 切指标 · ↑↓ 滚动 · esc 返回
└────────────────────────────────┘
```

### 三个操作

| 操作     | 用途                     | 里面看什么                              |
| -------- | ------------------------ | --------------------------------------- |
| **统计** | 看贝叶斯分析结论         | 每个 arm 的后验均值、可信区间、胜出概率 |
| **设置** | 强制固定某 arm（调试用） | 选 arm 或「(自动)」                     |
| **重置** | 清空实验数据             | 取消 / 确认清空                         |

### 统计视图怎么读

面板已经帮你把贝叶斯术语「翻译」成人话。进入「统计」页后：

```
  edit-strategy stable-hash
  指标: match_success  [< > 切换]
  精确匹配是否命中（1=命中，0=未命中）     ← 指标描述（声明时写 description）

  cli-proxy-api:deepseek-v4-pro          ← 「分桶」tab：按 contextKey 分桶
    模糊行匹配: 预估成功率 96.1%（74 次）真实约 92%~100%
    精确匹配: 暂无数据
  · 精确匹配 暂无样本，两策略暂时无法对比    ← 自动解读（人话结论）
  · 分流按会话稳定：同一模型的不同会话会分到不同臂，多开几个会话即可让另一侧分到流量
  · 想看整体对比，esc 返回一级后 Tab 切「汇总」再进入
```

三行数据怎么读：

| 展示               | 含义                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| `预估成功率 96.1%` | 贝叶斯估计的成功率。**不是简单准确率**，已含「1 成功 + 1 失败」的平滑，避免小样本时虚假的 100% |
| `（74 次）`        | 样本量。判断结论可不可靠的关键——样本越少越要谨慎                                               |
| `真实约 92%~100%`  | 95% 可信区间：真实成功率大概落在这个范围                                                       |

底部 `·` 开头的**自动解读**是重点，它直接用人话告诉你：

- 谁明显更优（两臂都有足够数据时才下结论，用强调色）
- 两臂无显著差距（继续观察）
- 样本还少（结论仅供参考）
- **单臂无数据时**：解释「分流按会话稳定，同一模型不同会话分到不同臂」，并提示多开会话、或切「汇总」

多个 metric 时按 `←`/`→` 循环切换。

### 分桶 vs 汇总（关键）

| Tab      | 含义                           | 什么时候看                   |
| -------- | ------------------------------ | ---------------------------- |
| **分桶** | 按 contextKey 分组展示         | 想知道「特定桶下哪个策略好」 |
| **全局** | 所有 contextKey **合并**看整体 | 想知道「整体哪个策略好」     |

edit 的 contextKey 是 `provider:model`，所以「分桶」里每个模型一块，如：

```
  anthropic:claude-sonnet-4-5
    classic: 95.0  ... 胜率=98%
```

### 完整使用流程

1. 用 edit 工具编辑几次文件（触发选臂 + 日志上报）
2. 输入 `/lab` 打开面板
3. 看到 `edit:edit-strategy` 实验 → `⏎` 进入（默认统计页）
4. 看 classic vs row-script 的胜率
5. 想按桶看 → `Tab` 切「分桶」
6. `Esc` 关闭

### 键盘速查

| 按键           | 作用                        |
| -------------- | --------------------------- |
| `Tab` / `⇧Tab` | 切换 分桶 ↔ 汇总            |
| `↑` / `↓`      | 菜单/列表上下移动           |
| `⏎`            | 选中当前项                  |
| `←` / `→`      | 统计视图切换 metric（循环） |
| `Esc`          | 关闭面板                    |

### 常见困惑

- **看不到实验**：实验由消费方（如 edit）在 `session_start` 注册。若消费方插件没加载，面板是空的。
- **看到实验但「暂无数据」**：还没累积数据。先实际用 edit 编辑几次，再回来看。
- **数据在哪个 tab**：edit 的数据按 model 分桶，「分桶」tab 每个 contextKey 一块；「汇总」是合并视图。
- **状态栏**：`|lab:关闭/采集中/已切换` 随时反映实验状态（强制固定 arm 后显示「已切换」）。

---

## API 参考

| API                                                             | 用途                                                            |
| --------------------------------------------------------------- | --------------------------------------------------------------- |
| `registerStrongExperiment(def)` / `registerWeakExperiment(def)` | 注册实验，返回 `ExperimentAPI`（异 owner 撞名返回 `undefined`） |
| `ExperimentAPI.select(ctx)`                                     | 选臂，返回 armId                                                |
| `ExperimentAPI.record(armId, outcome, ctx)`                     | 直报信号（同步）                                                |
| `ExperimentAPI.stats(ctx?)`                                     | 聚合统计（sum/count）                                           |
| `ExperimentAPI.query(metricId, ctx?)`                           | 贝叶斯后验分析结论                                              |
| `ExperimentAPI.forceArm(armId)`                                 | 强制固定臂（调试）                                              |
| `ExperimentAPI.reset()`                                         | 清空数据                                                        |
| `registerIngestionSource(name, extractor)`                      | 注册自定义信号源（扩展点）                                      |

---

## 存储

每实验一个 JSONL 文件（`extensions-data/pi-lab/<experiment>.jsonl`），append-only 事件流，每行一条 outcome 事件。聚合/分析在 `query()` 时从事件流投影计算，可回溯重算、可分段。

## 完整设计文档

- `docs/adr/0003-pi-lab-extension-registration-mechanism.md` — 注册机制
- `docs/adr/0016-pi-lab-registration-owner-identity.md` — 注册身份模型与三语义裁决
- `docs/adr/0008-pi-lab-measurement-analysis-positioning.md` — 测量/分析定位（AB 测试）
- `docs/adr/0009-pi-lab-metric-abstraction.md` — 指标抽象 + 派生指标
- `docs/adr/0010-pi-lab-bayesian-inference.md` — 贝叶斯后验
- `docs/adr/0011-pi-lab-jsonl-event-stream.md` — JSONL 事件流
- `docs/adr/0012-pi-lab-ingestion-sources.md` — 信号入口（TAG/日志）
- `docs/adr/0013-pi-lab-traffic-allocation.md` — 流量分配
- `docs/adr/0014-pi-lab-panel-conclusion-display.md` — 面板结论展示
