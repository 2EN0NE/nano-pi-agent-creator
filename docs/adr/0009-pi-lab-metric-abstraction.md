# pi-lab Metric 抽象：声明式多指标 + 派生指标查询时投影

**状态**: accepted

原 `Outcome` 是固定字段（`success`/`firstAttempt`/`latencyMs`），其余 7 个预留字段被 `record()` 静默丢弃，且无指标声明概念。我们决定引入一等公民 Metric 抽象：注册实验时声明 `metrics`（id/type/direction），`record()` 改为接收 `{ metrics: Record<metricId, number> }`，框架按 `direction` 归一化方向后统计。

复合评分（composite）不是 pi-lab 的基础设施职责，而是消费方的领域逻辑。pi-lab 提供声明式 Derived Metric 原语（`weighted-sum` / `any-fail`），权重放在实验配置（消费方注册时声明默认 + 用户可在 `extensions-data` 配置文件覆盖），而非每次 `record()` 参数传入；派生指标在 `query()` 时按当前配置投影计算，以便改权重后可回溯重算历史。

## 考虑过的选项

- **框架内置固定 composite 加权**：被否决——权重是主观业务决策，硬编码进框架会让 pi-lab 承担业务语义。
- **消费方一律自己算 composite 当普通 metric 上报**：作为兜底保留（选项 A），但会让每个消费方重复造轮子。
- **声明式派生 metric + 权重放配置 + 查询时投影**：采纳。
