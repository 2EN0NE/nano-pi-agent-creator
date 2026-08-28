# Changelog

All notable changes to mitsupi are documented here.

## Unreleased

## v0.1.0

首个独立版本——在继承自上游 [agent-stuff](https://github.com/mitsuhiko/agent-stuff) 1.6.0 的基础上，完成 251 个提交的体系化重构，建立四根支柱：Extension 架构分层、统一日志体系、实验框架、TUI 视觉与交互规范。

### 总体设计：四根支柱

#### 1. Extension 架构分层

`extensions/` 不再平铺，按核心功能重组为 7 个分类目录：

| 目录            | 分类                   | 说明                                      |
| --------------- | ---------------------- | ----------------------------------------- |
| `tui/`          | 交互界面               | 命令面板、选择器、编辑器等交互式 UI       |
| `context/`      | 上下文组装             | 修改/增强/组装 system prompt 与会话上下文 |
| `security/`     | 审计与安全             | 安全保护、权限控制、危险操作拦截          |
| `auto/`         | 自动化                 | 无需或少量交互的自动执行插件              |
| `accuracy/`     | 更精准的信息与操作工具 | 增强或替换内置工具                        |
| `verification/` | 验证与评估             | 代码审查、质量评估                        |
| `meta/`         | 元插件                 | 最基础层服务，供其他层依赖                |

- **分层依赖单向化**：`meta/` 层（pi-logger、pi-config、pi-rate-limiter 等）是基础设施，其他层通过 npm 包引用依赖；`meta/` 内部不反向依赖其他分类。
- **内嵌技能（ADR-0022）**：扩展可自带 `skills/<name>/SKILL.md`，随 sync 同步——「技能跟着插件走」。
- **配置标准化（`@zenone/pi-config`）**：所有扩展配置走统一双层路径（用户级 `~/.pi/agent/extensions-data/<name>/config.json`、项目级 `<cwd>/.pi/extensions-data/<name>/config.json`），内置深合并、原子写入、缓存。

#### 2. 统一日志体系（pi-logger）

- `createLogger(name)` API：每个扩展拿到自己的 logger，禁止裸 `console.*`。
- 按插件分文件输出到 `.pi/logs/<name>_*.log`，配置文件 `pi-logger.json` 按 logger 控制级别。
- 自动捕获所有扩展（含 npm 安装）的生命周期日志。

#### 3. 实验框架（pi-lab）

`meta/pi-lab/` 是贝叶斯 A/B 测试框架，用数据回答「哪个 prompt / 模型 / 策略更好」。

- **双轨注册 API**：强依赖（`registerStrongExperiment`）或弱依赖（`registerWeakExperiment`，`globalThis.__labApi` 桥接，pi-lab 缺失时自然降级）。
- **注册时机铁律**：必须在 `session_start` 事件中注册，消除加载顺序竞险。
- **已接入消费方**：`edit`、`smart-context`（5 种模型路由策略）、`custom-compaction`（压缩策略 A/B）。

#### 4. TUI 视觉与交互规范

- **字符白名单（ADR-0023）**：禁双宽 emoji 与 Unicode 图标，放行单宽箭头，杜绝渲染超宽崩溃。
- **纯横线边框范式**：顶边框 `── 插件名` + 内容行缩进 + `truncateToWidth` 兜底，对齐只用 `visibleWidth`。
- **三轴正交交互模式**：先选入口，再定模式（只读/导航/表单/确认），导航强制 master-detail 两级 + 滚动上限。
- **Headless 测试强制化**：新增 `src/tui-testing/` 框架（`renderToSnapshot` / `assertWithinWidth` / `dispatchInput`）。
- 全量中文化文案。

### 工程体系

- **双层测试**：`test/vitest/` 单元 + 组件测试（mock 全部 Pi API，<30s）；`test/e2e/` 集成测试（真实 Pi 进程，仅 mock LLM）。当前覆盖 64 文件 / 1155 用例。
- **CI 与 Git Hooks**：CI 为绝对标准（Prettier / TypeScript / ESLint / Vitest / E2E / Semgrep / TUI 全阻塞），Config 合规门禁暂为 WARN（列出违规但不阻塞，待基础组件与插件解耦后收紧）；本地 husky 分层对齐。
- **Sync 工具**：双 Profile 架构（`user-install` 全局 vs `project` 项目级），支持内联测试目标、本地依赖解析、内嵌技能打包。

### 新增与重构的扩展

**新扩展：**

- `worktree`（auto/）—— git worktree 隔离开发全生命周期（本地 rebase、sync/prune、merge 冲突面板）。
- `permission-gate`（security/）—— 危险 bash 命令确认门禁。
- `pi-session-tree`（meta/）—— 会话树 TUI 面板、标签规则引擎与 range 分析。
- `pi-shortcuts`（meta/）—— leader-key 快捷键中心。
- `cloud-sessions`（tui/）—— 云端会话同步与冲突解决。
- `ci-watch`（meta/）—— PR/分支 CI 状态监控。
- `sandbox`（security/）—— OS 级沙箱执行 bash。
- `select` 元组件、`resources-tree`（context/）、`secret-firewall`（security/）、`tmux-status`、`recap`、`goal`、`questionnaire`、`session-tree-label`、`rate-limiter` 等。

**重构与增强：**

- `todos` —— 三层 scope（session/project/global）、状态分离（done/close）、句子级完成检测。
- `custom-compaction` —— 模型感知 profile 自动切换、会话复杂度分析与压缩实验接入。
- `sync` —— 内嵌技能打包（ADR-0022）、双目标同步、stale 依赖修复。
- `files`、`review`、`control` 等 —— 全中文化 + 规范化。

**主题：** 新增 Tokyo Night、dayowl 浅色主题。

**依赖：** 升级 `@earendil-works/*` 至 0.84.1 并适配新扩展契约。

### 架构决策（ADR）

21 篇 ADR 记录关键设计决策，位于 [`docs/adr/`](docs/adr/)：

- ADR-0006 ~ 0014：smart-context 与 pi-lab 实验框架
- ADR-0015：shortcut hub 架构
- ADR-0017、0021：custom-compaction 分层写入与自动切换
- ADR-0018、0019、0024：worktree 本地 rebase、本地边界、merge UX
- ADR-0020：TUI 交互模型（三轴正交）
- ADR-0022：内嵌技能打包
- ADR-0023：TUI 视觉规范补全

### 文档

- [`README.md`](README.md) —— 快速开始、目录说明、测试与 CI
- [`docs/tui-design-principles.md`](docs/tui-design-principles.md) —— TUI 设计规范
- [`docs/tui-interaction-patterns.md`](docs/tui-interaction-patterns.md) —— 交互模式规范
- [`docs/tui-headless-testing.md`](docs/tui-headless-testing.md) —— headless snapshot 测试
- [`docs/sync-tool.md`](docs/sync-tool.md) —— 同步工具
- [`AGENTS.md`](AGENTS.md) —— 工程规范与 Pi 插件开发补充知识

## 上游历史（agent-stuff 1.x）

以下版本继承自上游 agent-stuff 仓库，保留作为历史记录。

## 1.6.0

- Added a redesigned `btw` extension with side chat markdown rendering, tool visibility, deferred session creation, and main-context improvements.
- Added a `/split-fork` Ghostty fork command for opening split sessions.
- Added email-based multi-account authentication to the `google-workspace` skill.
- Added left/right arrow key paging in the todo detail overlay. (#15)
- Added a shared custom instructions toggle to review workflows.
- Updated extensions for the new command and API-key APIs, including namespaced keybindings and `sourceInfo` support.
- Improved the `multi-edit` extension with sequential same-file ordering, redundant-edit skipping, and clearer patch-mode diff output.
- Fixed the `web-browser` skill and session-control refresh behavior after forks. (#16)
- Fixed `intercepted-commands/python` and `intercepted-commands/python3` to avoid recursive `uv` spawn loops by resolving a uv-managed non-shim interpreter for `uv run --python`.

## 1.5.0

- Added a `multi-edit` extension that replaces `edit` with support for batched `multi` edits and Codex-style `patch` payloads.
- Added preflight validation before mutating files for both `multi` edits and `patch` operations in `multi-edit`.
- Added `/session-breakdown` views for cwd, day-of-week, and time-of-day breakdowns.
- Added `pi-share` support for `pi.dev` URLs and `#session_id` inputs.
- Improved day rendering in `/session-breakdown`.
- Fixed PDF handling in the `summarize` skill.
- Hardened `uv` command handling by blocking pip/poetry bypasses.
- Fixed `web-browser` startup behavior to avoid killing user Chrome instances.
- Updated README extension docs to include `pi-extensions/multi-edit.ts`.

## 1.4.0

- Added a prompt editor extension for managing prompt modes (create, rename, delete, and edit), with persistence and detection fixes.
- Added a loop-fixing mode to `/review` with improved blocking-aware detection, plus branch/commit filtering and related review flow improvements. (#10)
- Added new skills for native web search, cached repository checkout (`librarian`), Google Workspace, and Apple Mail.
- Added a CLI interface for session control and gated control tool registration behind `--session-control`.
- Added the `go-to-bed` late-night safety guard and improved auto-disable behavior.
- Improved `/files` labels by appending git status information.
- Improved `uv` command handling by blocking `py_compile` and suggesting AST-based syntax checks.

## 1.3.0

- Added `/session-breakdown` command with interactive TUI showing sessions, messages, tokens, and cost over the last 7/30/90 days with a GitHub-style contribution calendar.
- Added messages/tokens tracking and large-count abbreviations to `/session-breakdown`.
- Added progress reporting while analyzing sessions in `/session-breakdown`.
- Added folder snapshot review mode to `/review`.
- Improved review rubric with lessons from codex.
- Added a `summarize` skill for converting files/URLs to Markdown via `markitdown`.

## 1.2.0

- Updated pi-extensions to use the new `ToolDefinition.execute` parameter order.
- Fixed notify extension notifications to render plain Markdown.

## 1.1.1

- Removed the deprecated `qna` extension.
- Added `uv` extension and skill for uv integration.

## 1.1.0

- Added project review guidelines and preserved review state across navigation.
- Added the `/diff` command to the unified file browser and merged diff/file workflows.
- Added new skills for commits, changelog updates, and frontend design.
- Expanded the whimsical "thinking" messages.
- Added prompts directory configuration support for Pi.
- Fixed reveal shortcut conflicts and improved the PR review editor flow.

## 1.0.5

- Fixed the release CI pipeline for the published package.

## 1.0.4

- Added the session control extension with socket rendering, output retrieval, and copy-todo text actions.
- Added support for session names and custom message types in session control.
- Improved control socket rendering and reconnection handling.
- Added control extension documentation.

## 1.0.3

- Added todo assignments and validation for todo identifiers.
- Added copy-to-clipboard workflows for todos and improved update UX.
- Switched answer tooling to prefer Codex mini and refined prompt refinement.
- Documented todos and refreshed README guidance.

## 1.0.2

- Introduced the todo manager extension (list/list-all, update, delete, and garbage collection).
- Added TODO-prefixed identifiers and refined the todo action menu behavior.
- Improved todo rendering and the refinement workflow ordering.
- Added support for append-only updates without requiring a body.
- Removed the unused codex-tuning extension.

## 1.0.1

- Added core extensions: /answer (Q&A), /review, /files, /reveal, /loop, and cwd history.
- Added skills for Sentry, GitHub, web browsing, tmux, ghidra, pi-share, and Austrian transit APIs.
- Added Pi themes including Night Owl and additional styling.
- Added and refined the commit extension and review workflow.
- Improved packaging and initial repository setup.
