# Changelog

All notable changes to mitsupi are documented here.

## v0.3.0 (2026-10-20)

### 破坏性变更与语义调整

- preset 的 tools / skills / instructions 改为叠加层（overlay）：激活即硬约束，清除预设即撤回；无预设时不施加任何限制。激活期间 `/tools`、`/skills`、`/prompt` 的写操作一律拒绝并告警；声明 `tools` 时为封闭集，运行时新注册的工具视为不可用；`/reload` 不再复活已清除的预设（ADR-0049/0050）。
- `pi-rewind` 取代 `git-checkpoint`：自动 checkpoint + 自主回滚，存储路径迁移；原 `git-checkpoint` 扩展及其 e2e 移除（ADR-0038）。
- 运行基座连续提升：pi 家族三包（`pi-ai` / `pi-coding-agent` / `pi-tui`）1.2.0 → 1.3.0，均为零兼容修复；e2e 与 vitest 的基座来源改为以 lock 为唯一来源并留痕（ADR-0063）。

### 新增：多 agent 框架（org）

- 目录绑定多 agent 框架：具名 org（create / join / 回归三选一 / leave / delete 归档）、任务 → 子任务 → 参与者状态机（终态铁律、返工轮次、期望时间继承）、派发（负责人单方 + 非负责人握手）、TUI 看板。
- 在岗协作框架：`/control` 握手上岗与回落、派活闭环（dispatch → claim/report → review/accept/reject）、活动可见性、在岗干预、收件箱消化、成员串行执行与队列上限、唤醒授权（`autoWake` 门禁 + `org_wake` 工具 + `/org wake`）（ADR-0038~0055）。

### 新增扩展

- `message-time`：对话流每条消息注记三段式时间（今日 `[HH:MM:SS]` / 同年 `[MM-DD HH:MM:SS]` / 跨年 `[YYYY-MM-DD HH:MM:SS]`）；纯 markdown transformer 实现，零配置常开。

### 功能增强

- `permission-gate`：提升建议机制（tier 门禁 → 面板建议行 → 一级选择器 → 二级确认卡片 → 采纳/撤销，ADR-0058~0060）；信任范围改为多根列表，每根可挂「仅限本会话创建」出处条件；新增路径出处账本（字面路径 / 命令内变量绑定 / 跨命令变量，mtime 兜底仅限临时区）；`ctrl+shift+O` 展开命令全貌并支持 ↑↓ 滚动；审计 decision 拆分为 `blocked-no-ui` / `deny-legacy`。
- `worktree`：本地优先基点解析（显式参数 → 组声明 → 本地同名 ref → 当前 HEAD，不猜远端，ADR-0061）；Worktree 组批量合并与同步（按花名册顺序逐个 squash、fail-fast 可续跑、脏成员双重拒绝，ADR-0062）；面板一级列表分 Groups / Worktrees 两段。
- `bench`：新增前置检查模块与臂注册表 + 先导门（ADR-0056/0057）。
- `custom-rename`：模型 ref 留空改为「跟随当前模型」，非法 ref 仍 fail-fast。
- `custom-compaction`：默认自动继续文案改为压缩打断恢复提示。
- `pi-logger`：自带默认 / 用户级 / 项目级三层配置分离；file appender 改同步写（进程被杀不丢尾行）；无 EventBus 时直接落盘并缓冲，总线建立后补投（消除启动期与退出期日志丢失）。
- `sync`：墓碑清单清理下架扩展残留，修复内嵌后同名命令重复注册；配置重置仅「删除」进候选并在删除前备份；新增 `--profile <name> --ext <name>` 单插件白名单同步。

### 工程与 CI

- 新增仓库级配置锚点阻塞门禁 `lint:config:anchor`：白名单内的仓库级配置消费者必须显式锚仓库根（`git-common-dir` 派生），纳入 CI 与 pre-push。
- e2e 耗时治理：插件级 300s 硬预算门禁（超预算判失败）+ 固定 sleep 改条件等待 + TUI 就绪改「读到输出静默」；实测 pi-session-tree 805→137s、preset 633→219s、worktree 466→173s、sync-tool 465→34s、pi-lab 366→140s。
- e2e 结果统计改为文件驱动（修池化并行下 total=0 与退出码恒 0 的假绿）；新增 `--exclude` 排除清单，主矩阵分片改按模块名确定性 hash 分桶，CI 设 `E2E_BUDGET_STRICT=1`；permission-gate smoke 恢复为阻塞 job。
- e2e 配置隔离改为前置 guard（注入 `PI_CODING_AGENT_DIR`），取代「删除-恢复」式隔离，修复中断时用户插件配置整批丢失；环境哨兵改为文件内容哈希 + 目录 + 符号链接口径。
- e2e 与 vitest TUI 用例的运行基座统一取 lock（`node_modules/.bin/pi`）并打印留痕；本仓库工作树迁移到 Worktree 组管理，收敛 ADR-0062 残留。

### 修复

- `tui-testing` 的 `dispatchInput` 兼容 pi-tui 0.85 的 `handleTerminalInput`。
- `org` vitest 用例的 `ORG_ROOT` 兜底改为指向临时目录，修复测试写入真实 `~/.pi/org`。
- `permission-gate` 分析面板 vitest 时间炸弹；mock 助手类型对齐 `pi-ai/compat` 入口。
- pre-push 门禁：e2e 运行基座路径改为绝对解析（husky 注入的相对 `node_modules/.bin` 曾让 guard 在所有沙箱里 ENOENT，导致每个模块 e2e 全红）；嵌套调用不再把父级 guard shim 当成真实 pi（`e2e-test` 技能自测曾因此无限递归空转），guard 增加自指快速失败；已删除的模块不再被选入 pre-push e2e。
- `ci-watch` 的 TUI 用例改为按字节偏移断言条目顺序：pi-tui 以光标定位重绘、同一帧条目可能落在同一条物理行，行号比较会假失败。

## v0.2.0 (2026-09-06)

### 安全门禁（permission-gate）

- 危险命令分级阻断门禁落地：按危险等级分级确认，历史/分析支持会话-项目-用户三级溯源（ADR-0025/0027）。
- critical 级命令放行与手动策略跨 `/reload` 保留，30 天过期清理（ADR-0033）。
- 豁免 `/dev/null` 等无害设备文件，收窄块设备写拦截。
- 阻断确认树多行命令压平渲染，限制叶子窗口。
- 命中原因解释体系（ADR-0025/0030 补充）：多命中明细逐条陈列（每条带来源标记与解释文案）；内置解释文案 `notes.ts`（dangerCommands 15 条 / permissionCommands 22 条 / 默认拦截模式 8 条）；`sudo rm -rf /etc` 等提权前缀读写语义落到真实命令，不再误判为读取系统目录。
- 命令清单对象化（`CommandEntry{command, note}`、`PatternEntry.note`）+ 危险/权限命令与路径空间三个设置页（增删 + 备注编辑）。

### preset（预设 / 模式）

- 吸收 mode-switcher，升级三级来源（内置/用户/项目）与 master-detail 面板（ADR-0031/0032）。
- 迁移为文件夹插件，支持 skills 白名单与 SettingsList 多选编辑。
- 四维度单选 + 锁定守卫 + `/mode` 命令 + 会话持久化（ADR-0034/0035）；锁定守卫在 turn 边界兜底回滚并修复 footer 按键提示。

### 上下文与压缩

- `custom-compaction` 支持隐形 continue，修复状态栏刷新时机；`selectBestProfile` 优先 activeProfileId 使手动激活真正生效；引入触发选择范式（启用集 + 触发集 + 路由规则择一，ADR-0036）。
- `smart-context` 压缩时保留 assistant 的 toolCall 块，避免 tool/tool_calls 失配导致的 400。

### 新增扩展

- `offline`：pi 插件体系离线打包 / 恢复迁移工具。
- `bench`：插件离线配对基准评测体系（ADR-0026/0028）。
- `custom-rename`：会话自动命名（自动标题 + `/auto-rename` 面板）。
- `bash-timeout`：为内置 bash 工具注入默认 300s 超时兜底（ADR-0025）。
- `widget-wrangler`：status 缺 `|` 前缀时中间人自动补齐。

### 工程与架构

- `sync`：profile 架构调整（meta→auto、12 个扩展升为 user-install、演示插件 DEMO 前缀）；新增受管资产剪枝、配置重置与形态冲突清理（ADR-0037）；纯库包内部模块不再被误判为扩展。
- `worktree`：本地优先合并策略与失败面板，fetch 诊断异步化；clone/fork 会话改写源 cwd 路径并迁移为全局插件；修复「合并中」状态不消失。
- `pi-state`：会话状态跨 `/reload` 持久化与 30 天过期清理（ADR-0033）。
- `pi-lab`：接入 smart-context / tools / preset / mode 实验。
- `review`：合并 review 与 test-analysis 为 profile 驱动的目录插件（ADR-0025），跨会话记住最近 profile。
- `questionnaire`：支持多选，修复取消后 400。
- `quit`：金额对齐内置 footer 口径，新增分支费用分析。
- 新增 observability（观察分析）第八分类，迁移 session-analytics（ADR-0029/0030）。

### 修复

- `ci-watch`：修复会话替换崩溃与自动监控误报旧 run。
- `pi-session-tree`：递归遍历改迭代，修复长会话树栈溢出。
- `questionnaire`：多选「输入其他」后清空勾选集合，避免回访残留复选框。
- `whimsical`：颜色改为 default / warning / error 三档高对比。

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
