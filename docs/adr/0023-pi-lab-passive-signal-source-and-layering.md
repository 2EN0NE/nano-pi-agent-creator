# pi-lab 被动信号源与信号分层架构

pi-lab 之前只有插件手动埋点（record / 日志 / TAG）三条信号通道，数据源窄、实验少。本次增强引入**内建被动信号源**——订阅 pi-logger `log` 总线，把 pi 原生执行事件与会话树行为自动投影为实验信号，免消费方埋点。信号分两层：**生命周期信号**（push，pi 原生执行事件的投影，pi-lab 内建适配）与**行为信号**（pull，会话树推断，pi-session-tree 出基础原语、插件出领域语义）。被动信号按 **turn 级归因**（共享观测 + `turnId` 观测键）。A/B 臂统一为「**能力变体**」（工具集切或参数切），扩展启停排除；引入 **AA 自检**（假臂对照 + SRM）。通用过程指标（`tool_error_rate` / `tool_latency_ms` / `turn_token_usage`）**自动注入**所有实验（免声明），以 `tool_` / `turn_` 前缀命名隔离，避免与插件自声明 metric 撞名。

## 考虑过的选项

- **独立插件 vs 内建**：曾考虑把被动信号源做成独立 meta 插件，经 `registerIngestionSource` 接入。否决——pi-lab 已订阅 `log` 总线（为 `[pi-lab-signal]`），独立插件会二次订阅同一总线、重复 fan-out 逻辑；信号源 pi-logger 是本仓库自维护，schema 漂移已由它吸收，隔离理由消失。
- **广播信号层 vs 点对点**：曾考虑中间层自己 emit 一套标准信号供多组件订阅。否决——多组件订阅能力已由 pi-logger `log` 总线本身提供，再造广播层是重复造轮子（YAGNI）。
- **行为信号内建 pi-lab vs 插件自实现**：曾考虑 pi-lab 内建回退/纠正检测。否决——「回退=不满意」是领域语义，各插件含义不同；正确分层是 pi-session-tree 出**基础原语**（`isDescendant`/`detectDiverge`），插件用原语自实现领域信号并注册。
- **扩展开关 vs 能力变体**：曾讨论「装了 vs 没装」作为臂。否决——装/卸扩展是环境级变更、非会话内变体（pi 无运行时禁用扩展 API），无法 `select()`；A/B 臂应定义为会话内可切的**能力变体**。

## 后果

- 过程指标（isError / duration / usage）免埋点，任何插件注册的工具都自动可测。
- 通用指标（token）属 turn 级共享观测，允许多活跃实验重复归因，靠 `metadata.turnId` 供未来去重。
- AA 自检补上 pi-lab「只有 AB 没有 AA」的可信度缺口（贝叶斯下为后验校准）。
