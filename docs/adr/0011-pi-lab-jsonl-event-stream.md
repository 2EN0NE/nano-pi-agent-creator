# pi-lab 存储：append-only JSONL 时序事件流，替代聚合计数

**状态**: accepted

原 `ExperimentStorage` 只存聚合计数（alpha/beta/totalCalls 等），原始事件一旦写入即丢失，无法做趋势/分段分析，也无法回溯重算。我们决定改为 append-only 时序事件流：每实验一个 `.jsonl`，每行一条 outcome 事件（`{ ts, armId, ctxKey, metrics, metadata }`）。

聚合视图（后验参数、均值、胜出概率）在 `query()` 时从事件流投影计算。存储介质选 JSONL 而非 SQLite——Pi 会话事件量小（每次 tool call 几条，长期累积几千行），JSONL 简单、可审计、append 适配流式写入；SQLite 属过度设计。

`contextKey` 从存储分桶键降级为事件上的普通字段，`query()` 可任意按维度聚合。写盘从 `writeJsonAtomic` 整体重写改为 append + flush。

## 考虑过的选项

- **保留聚合计数**：被否决——丢原始事件，无法回溯重算、无法分段。
- **SQLite**：被否决（YAGNI）——Pi 事件量小，JSONL 足够。
- **JSONL append-only 事件流**：采纳。
