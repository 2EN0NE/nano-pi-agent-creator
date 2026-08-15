# pi-lab 多信号入口与信号适配器

**状态**: accepted

信号不止来自 `record()` API 同步直报，还有两个异步入口：会话树 TAG（插件主动打标 / pi-session-tree 规则自动打标）和 pi-log 结构化日志。三者统一转成 Event（问题 4 的 JSONL 事件流）。

Metric 定义因此扩展为「对哪个源、哪个字段、何种聚合」的声明式聚合，而非只是 id/type/direction。TAG 与日志两个标准 adapter 内建在 pi-lab；同时开放 `registerIngestionSource(name, extractor)` 扩展点，消费方/未来信号源可自行注册。

数据流：TAG 入口走 pi-session-tree 接口为主（meta 内 pi-lab 依赖 pi-session-tree/pi-logger，config/log 更底层），直接读会话文件作为 pi-session-tree 缺失时的兜底。

## 实施决策（arm 归因）

原 label 约定 `metricId:value` 在实施中发现缺口：异步信号（TAG/日志）无法由 pi-lab 推断 arm，信号无法归因到实验臂。故扩展为三段式，armId 显式携带：

- **TAG label**：`<armId>:<metricId>:<value>`（如 `row-script:match_success:1`）
- **日志行**：`[pi-lab-signal] arm=<armId> metric=<metricId> value=<value> [ctx=<ctxKey>]`

**armId 归因是 extractor 的职责**：extractor 产出带 armId 的事件，`ingest()` 时按实验臂校验（过滤陌生 arm，避免同名 arm 跨实验串扰）。

**ctxKey 缺省 global**：TAG 节点不直接携带 model 信息，运行时接线（`turn_end` 采集）暂以 `'global'` 作为 ctxKey，完整 model 提取留待后续。

## 遗留

- 日志 adapter 的运行时接线（读 pi-logger 文件 appender 输出）尚未接上，仅注册 `logExtractor` 信号源供后续 ingest 调用。
- 信号路由依赖「遍历实验 + armId 校验」；若两个实验存在同名 arm 与同名 metric，TAG 信号会同时写入两者（已知限制）。
