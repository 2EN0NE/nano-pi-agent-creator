# 调研：coding agent 的 git worktree 支持能力与 pi-worktree 覆盖度差距

> 调研日期：2026-08-17
> 调研目标：评估主流 coding agent（Claude Code / Codex / Gemini CLI）的 worktree 支持能力，对照本项目 `extensions/meta/worktree`（pi-worktree v2）与 `@quintinshaw/pi-dynamic-workflows` 的隔离能力，产出"bash 零门槛 worktree 开发闭环"的差距清单。
> 结论性质：一级来源为主（官方文档/官方仓库/官方 issue），社区文章辅助。

---

## 1. 主流 coding agent 的 worktree 支持能力

### 1.1 Claude Code —— 目前最完整的一等公民支持

Claude Code v2.1.49+ 提供 `--worktree`（`-w`）flag，v2.1.154+ 配合 dynamic workflows（官方文档：code.claude.com/docs/en/worktrees；CLI reference；Anthropic 官方博客 introducing-dynamic-workflows）：

| 能力                | 机制                                                                                                                       | 来源                                            |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 一键创建+进入       | `claude --worktree <name>`，位置 `.claude/worktrees/<name>/`（仓库根下），分支 `worktree-<name>`                           | code.claude.com/docs/en/worktrees               |
| 创建基点            | 默认从 `origin/HEAD`（远端默认分支）分支；可配 `worktree.baseRef: "head"` 从当前 HEAD                                      | code.claude.com/docs/en/worktrees               |
| 从 PR 创建          | `claude --worktree #<pr>` 或 PR/MR URL → fetch 该 PR 分支并建 worktree                                                     | code.claude.com/docs/en/cli-reference           |
| tmux 集成           | `claude -w <name> --tmux`（iTerm2 原生 pane / classic tmux）                                                               | code.claude.com/docs/en/cli-reference           |
| gitignored 文件带入 | `.worktreeinclude` 文件：列出需要复制进新 worktree 的 gitignored 文件（如 .env）                                           | code.claude.com/docs/en/claude-directory        |
| 子 agent 隔离       | subagent `isolation: "worktree"`——子 agent 也跑在独立 worktree                                                             | code.claude.com/docs/en/worktrees（hooks 一节） |
| agent 自主创建      | `EnterWorktree` 工具：agent 在会话中自己创建/进入 worktree                                                                 | code.claude.com/docs/en/worktrees               |
| 自动清理            | `WorktreeCreate` / `WorktreeRemove` hooks——会话退出、子 agent 完成、后台 session 删除时触发，可自定义（含非 git VCS 钩子） | code.claude.com/docs/en/hooks                   |
| 会话独立性          | 每个 worktree 独立 session；交互运行要求 workspace trust                                                                   | code.claude.com/docs/en/worktrees               |

社区佐证：Tim Schipper 文章（tim-schipper.nl）"三个终端 `claude --worktree`，10 秒后三个 agent 并行互不干扰"；James Anglin（jamesanglin.com）确认 `.claude/worktrees/feature-auth/` + `worktree-feature-auth` 分支。有早期 bug issue（#27044）但已修复，CLI reference 已补齐文档（#27022 resolved）。

**Claude Code 没有内置的"合并回主分支"命令**——worktree 干完活后 merge/push 仍需手动 git 或走 PR。

### 1.2 OpenAI Codex —— CLI 缺失，App 层有

| 能力              | 状态                                                                                                                                                                            | 来源                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| CLI worktree flag | **没有**。`codex --worktree` 处于 feature request：openai/codex#12862（2026-02-26 创建，open），#13120/#8570/#13356 均为 duplicate 并 closed。社区已有 fork 实现（#13120 提及） | github.com/openai/codex/issues/12862            |
| 沙箱隔离          | 独立机制：OS 级沙箱（workspace-write 等）+ approval policy，限制文件系统访问/网络，与 worktree 无关                                                                             | developers.openai.com/codex/concepts/sandboxing |
| App 层 worktrees  | ChatGPT 桌面 app：多 chat 并行、scheduled tasks 跑在后台 worktree、Handoff 可在 Local/Worktree 间迁移 chat                                                                      | developers.openai.com/codex/app/worktrees       |
| 清理问题          | 官方 troubleshooting 承认"scheduled tasks 会创建大量 worktree，需定期 archive 清理"；也有 `.worktreeinclude` 类似机制（gitignored 文件带入）                                    | developers.openai.com/codex/app/troubleshooting |

结论：Codex CLI 的 worktree 支持在主流工具里**最落后**（CLI 未落地），隔离主要靠沙箱 + App 层。

### 1.3 Gemini CLI —— experimental 支持

| 能力          | 机制                                                                                                             | 来源                                                     |
| ------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 一键创建+进入 | `gemini --worktree <name>`（`-w`），目录 `.gemini/worktrees/<name>/`，分支同名；无名字时随机生成                 | geminicli.com/docs/cli/git-worktrees                     |
| 启用门槛      | experimental，需 `/settings` 或 settings.json `experimental.worktrees: true`                                     | 同上                                                     |
| 退出行为      | **不自动删除**：退出时保留 worktree/未提交修改，并显示清理指令；用户手动 `git worktree remove` + `git branch -D` | 同上                                                     |
| resume        | `cd .gemini/worktrees/<name> && gemini --resume <session_id>`                                                    | 同上                                                     |
| 沙箱          | 独立机制：macOS Seatbelt / Docker 沙箱，与 worktree 正交                                                         | google-gemini.github.io/gemini-cli/docs/cli/sandbox.html |

### 1.4 Aider 及其他

- **Aider**：无原生 worktree 支持（feature request #16 长期 open）；git 集成深（auto-commit），在 worktree/detached HEAD 下 commit 会报错（agentbrisk 文章佐证）。
- **Cursor 等 IDE agent**：worktree 需求在 Codex issue #8570 中被引用（"just like how it works in Cursor"），说明 Cursor 生态已支持，但无公开官方文档级的机制。

### 1.5 社区最佳实践（worktree-per-task 模式）

| 实践                                                                                                                   | 来源                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 每个任务/agent 一个 worktree，git 层隔离是"先于沙箱"的正确原语                                                         | watchfire.io/blog/2026-05-18-isolated-worktrees-per-task                             |
| one worktree per agent + one branch per task + AGENTS.md/CLAUDE.md 用 symlink 共享 + 合并走 PR + 破坏性 git 命令需人审 | davidloor.com/en/blog/how-to-keep-multiple-coding-agents-from-overwriting-each-other |
| 工作区污染（脏文件/测试串扰）是并行 agent 的最大痛点，worktree 解决文件系统级碰撞                                      | nx.dev/blog/git-worktrees-ai-agents；tonyreviewsthings.com/git-worktrees-for-agents  |

---

## 2. 本地调研：@quintinshaw/pi-dynamic-workflows 的 worktree 隔离

（v3.6.0，`~/.pi/agent/npm/node_modules/@quintinshaw/pi-dynamic-workflows/`）

### 2.1 实现机制（源码级）

- 入口：`agent(prompt, { isolation: "worktree" })` → `src/workflow.ts` 中 `createWorktree(baseCwd, name)`
- 实现（`src/worktree.ts`）：
    - 路径：`<repoRoot>/.pi/worktrees/<slug>/`（**仓库内**），分支 `pi/wf/<slug>`，创建基点 `HEAD`
    - 命名确定性：`<runId>-<callIndex>-<label>` slug 化（≤32 字符），保证 resume 的 cache key 稳定
    - 生命周期：agent 调用前创建，`finally` 兜底 `removeWorktree`（`git worktree remove --force` + `git branch -D`），**超时/abort 也清理**
    - **不自动合并**——worktree 路径暴露给调用方检查
    - 失败降级：非 git 仓库或创建失败 → 静默在共享树运行（仅日志 `isolation ignored`）
- 使用场景：并行子 agent 免冲突编辑（audit/review/refactor fan-out）

### 2.2 与 pi-worktree 对比

| 维度          | pi-dynamic-workflows                                                                                                                         | 我们的 pi-worktree                            |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 定位          | 一次性并行 agent 编辑隔离                                                                                                                    | 持久开发环境管理                              |
| worktree 位置 | 仓库内 `.pi/worktrees/`                                                                                                                      | 仓库外 `<repo>-worktrees/`                    |
| 分支命名      | `pi/wf/<slug>`（确定性）                                                                                                                     | `wt/<星座-恒星>`（可读）                      |
| 创建基点      | HEAD                                                                                                                                         | origin/main（有远端时）                       |
| 生命周期      | 用完即删（finally 兜底）                                                                                                                     | 用户管理（create/delete/clean）               |
| 结果合并      | **无**，暴露路径                                                                                                                             | **有**：merge/squash/rebase-ff                |
| 会话隔离      | 子 agent 天然独立 session                                                                                                                    | ctx.switchSession() 切 cwd+会话               |
| 上游同步      | 无                                                                                                                                           | 部分（rebase-ff；git-merge-and-resolve 互补） |
| TUI           | workflow 面板（进度）                                                                                                                        | worktree 管理面板 + 子菜单                    |
| 风险          | 仓库内路径：未 ignore `.pi/` 的仓库会污染 git status（本项目已 ignore `.pi/`，实验确认无污染）；workflow 硬中断（kill -9）残留 worktree/分支 | 仓库外路径无污染问题                          |

**结论**：二者互补。pi-dynamic-workflows 解决"并行 agent 同时编辑同一仓库的免冲突"，pi-worktree 解决"人/agent 的工作区生命周期管理"。但前者的隔离**没有收尾合并**——研究/审查完的分支要用户手动处理，恰好是 pi-worktree merge/delete 命令的目标场景。README 亦承认设计参考 Anthropic dynamic workflows（README.md 末段）。

---

## 3. bash 层 worktree 操作流程 vs pi-worktree 覆盖度

| #   | bash 操作（用户日常）                          | 插件命令                                                | 状态                                                   |
| --- | ---------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------ |
| 1   | `git worktree add -b <b> <path>`（创建）       | `create`（自动恒星名/从 origin/main/已有分支 fallback） | ✅                                                     |
| 2   | `cd <path>`（进入）                            | `use`（切 cwd + 会话）/ `shell`（tmux/Warp）            | ✅                                                     |
| 3   | `git worktree list`（列表）                    | `list` / TUI 面板（dirty/ahead 显示）                   | ✅（ahead 语义反向 bug，见 P1-1）                      |
| 4   | `git worktree remove [--force]`（删除）        | `delete`（含 force 确认、分支删除询问、远程分支删除）   | ✅（删当前 worktree 丢会话历史，见 P1-2）              |
| 5   | `git merge` / `merge --squash`（合并）         | `merge`（三种策略）                                     | ✅                                                     |
| 6   | `git rebase`（变基）                           | `rebase` / `rebase-ff`                                  | ⚠️ `rebase` 必现失败（P0-1，实验复现）；`rebase-ff` ✅ |
| 7   | `merge --continue/--abort`（冲突处理）         | `continue` / `abort` / `status` / 冲突面板              | ✅                                                     |
| 8   | 已合并批量清理                                 | `clean [--dry-run]`                                     | ✅                                                     |
| 9   | **`git worktree prune`（元数据清理）**         | —                                                       | ❌ 缺口                                                |
| 10  | **worktree 分支同步上游（fetch+rebase/pull）** | —（rebase-ff 隐含；git-merge-and-resolve 每轮自动）     | ❌ 无独立命令                                          |
| 11  | **push 到远端**                                | —（post-merge guide 仅提示）                            | ❌ 缺口                                                |
| 12  | `git worktree lock/unlock`（防误删）           | —                                                       | ❌ 低优先级                                            |
| 13  | `git worktree move`                            | —                                                       | ❌ 很低                                                |
| 14  | 从 PR 创建 worktree                            | —                                                       | ❌ Claude Code 有（#PR）                               |

---

## 4. 结论与建议

### 4.1 行业定位

- 我们的 pi-worktree **不是落后于行业**：在"合并/收尾一体化（三种策略）、TUI 管理面板、会话级切换、仓库外安全位置"四个维度**领先** Claude Code / Gemini / Codex（它们都只有 CLI flag + 手动 git 合并）。
- 差距集中在：**PR 创建、自动清理、分支同步、push 集成** 四个点，以及内部 bug（P0-1/P1-1/P1-2/P1-3）。

### 4.2 达成"bash 零门槛闭环"需补齐的清单（按优先级）

**P0（先修 bug，闭环的洞）：**

1. 修复 `rebase` 必现失败（P0-1）——改为在 worktree 目录内执行 rebase（参考 git-merge-and-resolve 的合法模式），或直接引导用户用 rebase-ff
2. 修复删除当前 worktree 时 main 会话历史丢失（P1-2）——`handleDelete` 复用 `findExistingSession` 恢复真实会话而非 `createSession` 覆盖

**P1（行业标准能力）：** 3. 新增 `sync` 子命令：worktree 分支同步上游（fetch origin + rebase/pull worktree 内），对齐 Claude Code/Gemini 的日常同步场景 4. 新增 `push` 集成：merge/rebase-ff 成功后询问是否 `git push origin <target>`（当前仅 guide 提示）5. 修复 TUI 面板 ahead 语义反向（P1-1）与 `hasClonedSession` 参数错位（P1-3）

**P2（锦上添花）：** 6. 新增 `prune` 命令（`git worktree prune` + 清理无主 session 目录提示）7. `lock/unlock` 命令（防误删）8. `create --pr <number>` 从 PR 创建 worktree（对齐 Claude Code `--worktree #PR`）9. 与 pi-dynamic-workflows 打通：workflow 隔离的 worktree 分支（`pi/wf/*`）出现在 `/worktree` 面板中，可直接 merge/clean（形成"并行研究 → 一键收尾"闭环）

### 4.3 建议的验证方式

- 每个补齐项按本项目规范：vitest 单元测试（`test/vitest/extensions/worktree*.test.ts`）+ e2e（`test/e2e/extensions/worktree/smoke.test.sh`、`tui-expect.smoke.test.sh`，仅 mock LLM）
- P0 修复需补：plain rebase 用例（当前 operations.test.ts 无覆盖）、delete 会话恢复用例

---

## 5. 来源列表

**官方文档/官方仓库：**

- Claude Code worktrees: <https://code.claude.com/docs/en/worktrees>
- Claude Code CLI reference（--worktree/--tmux/#PR）: <https://code.claude.com/docs/en/cli-reference>
- Claude Code .claude 目录（.worktreeinclude）: <https://code.claude.com/docs/en/claude-directory>
- Claude Code hooks（WorktreeCreate/Remove）: <https://code.claude.com/docs/en/hooks>
- Claude Code dynamic workflows: <https://claude.com/blog/introducing-dynamic-workflows-in-claude-code> ；code.claude.com/docs/en/workflows
- Codex sandboxing: <https://developers.openai.com/codex/concepts/sandboxing>
- Codex App worktrees: <https://developers.openai.com/codex/app/worktrees>
- Codex App troubleshooting（worktree 堆积）: <https://developers.openai.com/codex/app/troubleshooting>
- Gemini CLI git worktrees (experimental): <https://geminicli.com/docs/cli/git-worktrees/>
- Gemini CLI sandboxing: <https://google-gemini.github.io/gemini-cli/docs/cli/sandbox.html>
- Aider git integration: <https://aider.chat/docs/git.html> ；worktree feature request: <https://github.com/paul-gauthier/aider/issues/16>

**GitHub issues：**

- openai/codex#12862（--worktree/--tmux，open）：<https://github.com/openai/codex/issues/12862>
- openai/codex#13120、#8570、#13356（parallel agents 需求，duplicate）
- anthropics/claude-code#27022（文档补齐，resolved）、#27044（-w 不生效 bug，已修复）、#27590（/add-git /clean-git 多 repo worktree 感知）

**社区实践：**

- Watchfire "Why we run every task in its own git worktree": <https://watchfire.io/blog/2026-05-18-isolated-worktrees-per-task>
- David Loor "How to keep multiple coding agents from overwriting each other": <https://davidloor.com/en/blog/how-to-keep-multiple-coding-agents-from-overwriting-each-other>
- Tim Schipper "Git worktrees for parallel coding agents": <https://tim-schipper.nl/en/blog/git-worktrees-parallel-coding-agents>
- Nx blog "How Git Worktrees Changed My AI Agent Workflow": <https://nx.dev/blog/git-worktrees-ai-agents>
