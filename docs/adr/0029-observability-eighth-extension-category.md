# observability 作为第 8 个扩展顶层分类

`extensions/` 新增第 8 个顶层分类 `observability/`（物理目录），归集以「观测/分析 pi 自身（插件、工具、skill、会话）为核心目的」的插件。`meta/` 中的基础设施（pi-logger、pi-config、pi-lab、pi-session-tree 等）不迁移，维持「最底层不被其他类别依赖」的约束。

- **状态**：accepted
- **考虑过的选项**：激进全量迁移——否决，破坏 meta 铁律且 pi-logger/pi-config 被强制留 meta 会导致体系分裂；`meta/observability` 子目录——否决，观测组件含 TUI/验证呈现，放 meta 违反「meta 避免依赖其他类别」；不建物理目录、仅用 docs + sync-profiles 表达横切视图——否决，观测能力已足够独立、足够大，且是 wt/observability 分支的持续建设重点；只放新组件、现有组件不动——否决，现有 tui/ 下的观测面板会继续散落。
- **后果**：AGENTS.md 的 7 分类表需同步为 8 分类；非 meta 组件的具体迁移边界另立 ADR 记录。
