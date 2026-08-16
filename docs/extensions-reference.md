<!-- 自动生成，请勿手改：运行 `npx tsx scripts/extract-extension-docs.ts` 重新生成 -->

# Extensions Reference

> 本文件由 `scripts/extract-extension-docs.ts` 静态扫描扩展注册代码自动生成。
> 快捷键体系（leader-key 子键分发）见 [docs/adr/0015-shortcut-hub-architecture.md](adr/0015-shortcut-hub-architecture.md)。

## accuracy/ — 更精准强大信息获取与操作工具

### edit

路径: `extensions/accuracy/edit/index.ts`

**工具**

- `edit` — Edit a file by replacing exact text. The oldText must match exactly (including whitespace). Use this for precise, surgical edits. Supports a `multi` parameter for batch edits across one or more files, and a `patch` parameter for Codex-style patches.

### todos

路径: `extensions/accuracy/todos/index.ts`

**命令**

- `/todos` — Manage todos - interactive panel with Session/Project/Global/Settings tabs

### tool-registration

路径: `extensions/accuracy/todos/tool-registration.ts`

**工具**

- `todo` — Manage file-based todos in … (list, list-all, get, create, update, append, delete, claim, release). Title is the short summary; body is long-form markdown notes (update replaces, append adds). Todo ids are shown as TODO-<hex>; id parameters accept TODO-<hex> or the raw hex filename. Claim tasks before working on them to avoid conflicts, and close them when complete.

### truncated-tool

路径: `extensions/accuracy/truncated-tool.ts`

**工具**

- `rg` — Search file contents using ripgrep. Output is truncated to … lines or … (whichever is hit first). If truncated, full output is saved to a temp file.

## auto/ — 自动化

### cloud-sessions

路径: `extensions/auto/cloud-sessions/src/index.ts`

**命令**

- `/cloud-sessions` — TUI panel for cloud sessions: sync, configure backend, view status, and edit settings

### continue

路径: `extensions/auto/continue.ts`

**快捷键**

- `c` （子键） — Send "continue" when the agent is stopped
- `shift+alt+enter` （降级键） — Send "continue" when the agent is stopped

### git-merge-and-resolve

路径: `extensions/auto/git-merge-and-resolve/index.ts`

**命令**

- `/git-merge-and-resolve` — Open Git Merge and Resolve control panel

### loop

路径: `extensions/auto/loop.ts`

**命令**

- `/loop` — Start a follow-up loop until a breakout condition is met

**工具**

- `signal_loop_success` — Stop the active loop when the breakout condition is satisfied. Only call this tool when explicitly instructed to do so by the user, tool or system prompt.

### no-sleep

路径: `extensions/auto/no-sleep.ts`

**命令**

- `/no-sleep` — Show or change macOS sleep-prevention status

## context/ — 上下文组装

### custom-compaction

路径: `extensions/context/custom-compaction/index.ts`

**命令**

- `/custom-compaction-setting` — Open custom compaction settings panel
- `/custom-compact` — Trigger compaction manually. Usage: /custom-compact [profile-name]. Without a profile name, pick one via selector (Tab for supplementary instructions).

### goal

路径: `extensions/context/goal.ts`

**命令**

- `/goal` — Set or view the goal for a long-running task

**工具**

- `get_goal` — Get the current goal for this thread, including status, budgets, token and elapsed-time usage, and remaining token budget.
- `create_goal` — Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks. Set token_budget only when an explicit token budget is requested. Fails if an unfinished goal exists; if the previous goal is complete, it is replaced.
- `update_goal` — Update the existing goal. Use this tool only to mark the goal achieved or genuinely blocked. Set status to complete only when the objective has actually been achieved and no required work remains. Set status to blocked only when the same blocking condition has repeated for at least three consecutive goal turns and the agent is at an impasse. Do not mark a goal complete merely because its budget is nearly exhausted or because you are stopping work.

### resources-tree

路径: `extensions/context/resources-tree/index.ts`

**快捷键**

- `r` （子键） — Toggle resource tree panel expand/collapse
- `ctrl+shift+z` （降级键） — Toggle resource tree panel expand/collapse

**命令**

- `/resource-tree` — Open resource tree settings panel

### smart-context

路径: `extensions/context/smart-context/src/index.ts`

**命令**

- `/smart-context-toggle` — Enable or disable smart-context model routing
- `/smart-context` — Show smart-context compression stats and current profile
- `/smart-context-profile` — List or switch smart-context profiles (balanced, fast, quality, or custom). Usage: /smart-context-profile → list profiles
  /smart-context-profile balanced → switch to 'balanced'

**工具**

- `recover_context` — Recover the full original content of a message that was compressed/summarized in the conversation context. Pass the id shown in a recover_context("id") hint.

## meta/ — 元插件

### _widget-wrangler

路径: `extensions/meta/_widget-wrangler/src/index.ts`

**快捷键**

- `w` （子键） — 打开小组件管理面板

**命令**

- `/wrangle` — 管理所有小组件和底部状态栏的显示/隐藏

**Flags**

- `widget-wrangler-key` — 打开小组件管理面板的快捷键 (如 ctrl+shift+g, alt+w)。空值禁用快捷键。

### commands

路径: `extensions/meta/commands.ts`

**命令**

- `/commands` — List available slash commands

### control

路径: `extensions/meta/control/index.ts`

**命令**

- `/control-sessions` — 列出可控制的会话（通过 session-control socket）

**工具**

- `send_to_session` — 通过控制 socket 与另一个运行中的 pi 会话交互。

操作（Actions）：

- send: 发送消息（默认）。需要 'message' 参数。
- get_message: 获取最近一条 assistant 消息。
- get_summary: 获取自上次用户输入以来的活动摘要（由 LLM 生成）。
- clear: 将会话回滚到初始状态。

目标选择：

- sessionId: 会话的 UUID。
- sessionName: 会话名称（由 /name 命令设置的别名）。

等待行为（仅适用于 action=send）：

- wait_until=turn_end: 等待 AI 回复完成后，返回最后一条 assistant 消息。
- wait_until=message_processed: 消息入队后立即返回，不等待 AI 处理。

CLI 桥接（用于 shell 脚本/后台任务）：

- 当前会话 ID 可通过环境变量 $PI_SESSION_ID 获取（启用 --session-control 后自动设置）。
- 需要当前会话 ID 时直接用 $PI_SESSION_ID，无需调用 list_sessions。
- 目标会话必须已启用 --session-control 运行。
- 一次性启动发送可通过以下扩展标志完成：
  --session-control
  --control-session <session-name|session-id>
  --send-session-message <text>
  --send-session-mode <steer|follow_up>（可选，默认: steer）
  --send-session-wait <turn_end|message_processed>（可选）
  --send-session-include-sender-info（可选，高级，默认关闭）
- 启动发送默认是单向的（不包含 sender_info），避免短生命周期 'pi -p' 发送者会话试图回复。
- 如果脚本需要响应，使用 --send-session-wait turn_end 并在 stdout 读取结果。
- 示例脚本（单向）：
  pi -p --session-control --control-session "$PI_SESSION_ID" --send-session-message "后台任务完成" --send-session-mode follow_up --send-session-wait message_processed
- 示例请求/响应：
  pi -p --session-control --control-session "$PI_SESSION_ID" --send-session-message "现在几点？" --send-session-wait turn_end

注意：如果要求目标会话通过 sender_info 回复，不要使用 wait_until；等待会导致重复响应。

消息会自动附带发送者信息以便回复。如果希望目标会话回复，指示目标会话通过 send_to_session 工具直接回复发送者（不要轮询 get_message）。

- `list_sessions` — 列出暴露控制 socket 的活跃会话（可附带会话名称）。仅用于发现；在 shell/bash 中获取当前会话 ID 请使用 $PI_SESSION_ID。

### mode-switcher

路径: `extensions/meta/mode-switcher.ts`

**快捷键**

- `m` （子键） — Select prompt mode
- `ctrl+shift+m` （降级键） — Select prompt mode
- `ctrl+space` （降级键） — Cycle prompt mode

**命令**

- `/mode` — Select prompt mode

### pi-config

路径: `extensions/meta/pi-config/index.ts`

**命令**

- `/config` — 查看插件配置文件状态。用法：/config [插件名]

### pi-lab

路径: `extensions/meta/pi-lab/index.ts`

**命令**

- `/lab` — 管理pi插件相关的实验

### pi-logger

路径: `extensions/meta/pi-logger/index.ts`

**命令**

- `/log` — Control the pi-logger system (config, level, tail, path, set-output)

**Flags**

- `log-level` — Set default log level (trace, debug, info, warn, error, off)

### pi-rate-limiter

路径: `extensions/meta/pi-rate-limiter/index.ts`

**命令**

- `/rate-limit` — 配置大模型调用频率限制器
- `/rate-limit-retry` — 连续 429 限流后创建分支会话重试

### pi-session-tree

路径: `extensions/meta/pi-session-tree/index.ts`

**命令**

- `/tree-stats` — Show session tree structure metrics
- `/custom-session-tree` — Open session tree inspector TUI panel

**工具**

- `session_tree_resolve` — Resolve a session tree expression (like "@~3:user" or "m1..@") to node info. Returns the node id, type, role, and summary.
- `session_tree_query` — Resolve a range expression (like "@~3:user..@" or "m1..@") and return the nodes plus a structured analysis (counts, user questions, tool calls, compactions, branch points).

### pi-shortcuts

路径: `extensions/meta/pi-shortcuts/index.ts`

**命令**

- `/shortcuts` — 列出所有扩展快捷键

### preset

路径: `extensions/meta/preset.ts`

**快捷键**

- `p` （子键） — Cycle presets
- `ctrl+shift+u` （降级键） — Cycle presets

**命令**

- `/preset` — Switch preset configuration

**Flags**

- `preset` — Preset configuration to use

### prompt-editor

路径: `extensions/meta/prompt-editor.ts`

**快捷键**

- `e` （子键） — Open prompt assembly panel
- `ctrl+shift+p` （降级键） — Open prompt assembly panel

**命令**

- `/prompt` — Inspect and control prompt assembly

### skills

路径: `extensions/meta/skills.ts`

**命令**

- `/skills` — Enable/disable skills

### tools

路径: `extensions/meta/tools.ts`

**命令**

- `/tools` — Enable/disable tools

### worktree

路径: `extensions/meta/worktree/index.ts`

**命令**

- `/worktree` — Manage git worktrees. Use /worktree for interactive panel.

## security/ — 审计与安全

### permission-gate

路径: `extensions/security/permission-gate/index.ts`

**命令**

- `/permission-gate` — Open Permission Gate control panel

**Flags**

- `no-permission-gate` — Disable permission gate entirely

### sandbox

路径: `extensions/security/sandbox/index.ts`

**命令**

- `/sandbox` — Show sandbox configuration

**Flags**

- `no-sandbox` — Disable OS-level sandboxing for bash commands

### secret-firewall

路径: `extensions/security/secret-firewall/src/index.ts`

**命令**

- `/secret-firewall` — Show secret-firewall status (protected secrets, redaction count)
- `/secret-firewall-toggle` — Enable or disable secret-firewall redaction
- `/secret-firewall-rescan` — Re-scan environment and .env files for secrets

## tui/ — 交互界面

### answer

路径: `extensions/tui/answer.ts`

**快捷键**

- `a` （子键） — Extract and answer questions
- `ctrl+.` （降级键） — Extract and answer questions

**命令**

- `/answer` — Extract questions from last assistant message into interactive Q&A

### btw

路径: `extensions/tui/btw.ts`

**命令**

- `/btw` — Open a simple BTW side-chat popover. `/btw <text>` asks immediately, `/btw` opens the side thread.

### catch-the-fox

路径: `extensions/tui/catch-the-fox/src/index.ts`

**命令**

- `/fox` — 控制狐狸: /fox <sleep|sniff|dig|run|jump|caught|error|sad|hide|show|scale <0.1-1>>

**Flags**

- `fox-reduced-motion` — 保持狐狸静止，不播放连续动画
- `fox-scale` — 缩放狐狸的像素图 (0.5=半大小, 1=原尺寸)

### files

路径: `extensions/tui/files/index.ts`

**快捷键**

- `f` `o` （子键） — 浏览会话中引用的文件
- `f` `r` （子键） — 在 Finder 中显示最近引用的文件
- `f` `q` （子键） — Quick Look 最近引用的文件
- `ctrl+shift+o` （降级键） — 浏览会话中引用的文件
- `ctrl+shift+f` （降级键） — 在 Finder 中显示最近引用的文件
- `ctrl+shift+r` （降级键） — Quick Look 最近引用的文件

**命令**

- `/files` — 浏览文件（含 git 状态和会话引用），支持 reveal/open/edit/diff/quicklook
- `/diff` — 打开文件选择器，选中 tracked 文件后直接打开 diff 视图
- `/changes` — 列出本次会话所有被记录的文件变更。/changes cls 清空记录。

### qna

路径: `extensions/tui/qna.ts`

**命令**

- `/qna` — Extract questions from last assistant message into editor

### questionnaire

路径: `extensions/tui/questionnaire.ts`

**工具**

- `questionnaire` — Ask the user one or more questions. For single questions, shows a simple option list. For multiple questions, shows a tab-based interface with navigation between questions and a submit review step.

### recap

路径: `extensions/tui/recap/src/index.ts`

**命令**

- `/recap` — Summarize where you left off in this session

### session-breakdown

路径: `extensions/tui/session-breakdown.ts`

**命令**

- `/session-breakdown` — Interactive breakdown of last 7/30/90 days of ~/.pi session usage (sessions/messages/tokens + cost by model)

### session-tree-label

路径: `extensions/tui/session-tree-label/index.ts`

**快捷键**

- `l` （子键） — 标签模式: …

**命令**

- `/label` — 标记节点: /label <…|status|reload>

### split-fork

路径: `extensions/tui/split-fork.ts`

**命令**

- `/split-fork` — Fork this session into a new pi process in a right-hand Ghostty split. Usage: /split-fork [optional prompt]

## verification/ — 验证与评估

### ci-watch

路径: `extensions/verification/ci-watch/src/index.ts`

**命令**

- `/ci-watch` — 监控 CI。用法：/ci-watch <PR编号|分支名> 或 /ci-watch（打开交互面板）

**工具**

- `ci_watch` — 监控 GitHub PR 或分支的 CI 状态，等待完成并报告结果。如果 CI 失败，返回失败日志供修复。支持 PR 编号（如 12）或分支名（如 main）。

### review

路径: `extensions/verification/review.ts`

**命令**

- `/review` — Review code changes (PR, uncommitted, branch, commit, or folder)
- `/end-review` — Complete review and return to original position

### test-analysis

路径: `extensions/verification/test-analysis.ts`

**命令**

- `/test-analysis` — Analyze test coverage and quality (staged, uncommitted, branch, commit, or folder)
- `/end-analysis` — Complete test analysis and return to original position
