# observability 首批迁移边界与改名

`observability/` 首批仅迁入原 `tui/session-breakdown`（改名 `session-analytics`）；`meta/`（pi-logger、pi-config、pi-lab、pi-session-tree）、`verification/`（ci-watch、test-analysis、review）及其余 tui 观测面板（whimsical、recap、session-tree-label）暂不迁。

- **状态**：accepted
- **改名 `breakdown` → `analytics`**：`breakdown` 仅覆盖「按维度分解」（model/cwd/dow/tod 明细表），漏掉作为主视觉的「时间趋势日历」（7/30/90 天热力图）；`analytics` 同时覆盖趋势 + 分布。它是 observability 家族首个面板，确立 `<scope>-analytics` 命名约定，供后续 tool/plugin/skill-analytics 沿用。改名与迁移同一动作执行，零额外机会成本。
- **暂缓迁移**：whimsical/recap/session-tree-label 仍以交互呈现/会话体验为主要定位，待 observability 跑通一个样板后再评估二次迁移；`verification/` 组件一等目的是具体工程任务（CI 监控、测试覆盖、代码审查），非「观测 pi 自身」，不迁。
- **后果**：`/session-breakdown` → `/session-analytics`（命令、logger、customType）；e2e 目录、sync-profiles.yaml、check-tui-compliance.ts 的 `EXEMPT_FILES` 同步更新；历史引用（CHANGELOG、ADR-0023、tui-design-principles、TUI-TODO-IMPROVE）保留旧名。
