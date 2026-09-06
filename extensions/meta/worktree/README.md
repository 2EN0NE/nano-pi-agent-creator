pi-worktree
===========

Pi 扩展：基于 git worktree 的隔离开发工作流管理。

核心定位：**本地优先**。pi-worktree 主要服务本地隔离开发——把互不干扰的任务放到独立工作区并行推进，或在实验性改动不污染主干的情况下试错。**worktree 内容默认不推送到远端**，所有远端副作用（push、PR 创建、远程分支管理）由用户自己兜底。

设计原则
--------

1. **本地优先（Local-First）**：插件的一切推荐均基于「worktree 主要用于本地开发」这一前提。合并、变基、清理都是纯本地 git 操作，插件不自动 push、不强推、不在命令中隐含远端副作用。
2. **远端归人（Remote by Human）**：push / PR / 远程分支管理属用户决策域。插件只提供只读的同步差距提示（本地/远端落后几个提交）和手动「拉取最新」选项，由用户决定何时与远端同步。
3. **只读诊断**：插件可自由做只读远端探测（`git fetch origin <branch>` 仅更新 remote-tracking ref，不动本地分支/工作区），对比本地与远端的落后程度，但**无远端或网络不可用时静默隐藏提示，绝不报错**。

合并（merge）语义
-----------------

- **纯本地合并**：`/worktree merge --source <n> [--target b]` 执行 `checkout target → merge source → checkout 回原分支`，**不自动拉取远端**。
- **合并前**：确认面板显示「本地 target 落后远端 N 提交」（只读 fetch 诊断、无远端不显示、失败静默）。
- **合并成功后**：面板提示同步差距 + 非首位的「拉取最新」选项，方便用户在 push 前决定是否先同步。
- **失败面板**：非冲突失败（checkout 失败、工作区脏等）弹出处理面板：原因分类 + 可执行建议，选项依次为「让 Agent 处理」/「重试合并」/「打开终端手动处理」/「拉取最新后重试（非首位）」/「关闭」。
- **让 Agent 处理**：以三段式 prompt 委托 agent——① 合并建议原则（本地优先、保留双方意图、完成后跑检查、不执行不 push）② 当前准确情况（失败命令、错误详情、分支拓扑、本地/远端落后差距）③ 任务（给出建议的操作命令步骤）。agent 只做参谋，命令由用户执行。参照 review 插件的 RUBRIC + 动态信息组合模式。
- **push 提示**：合并成功后插件只提示"已合并到 target，可 push"，不执行 push。

> 详细交互设计见 AGENTS.md 与 `skills/worktree/SKILL.md`。

快速参考
--------

```bash
/worktree create [--name <n>]            # 创建 worktree（分支 wt/<name>）
/worktree use <name>                     # 会话切换到 worktree cwd
/worktree sync <name>                    # 同步到上游最新（= rebase 别名，本地操作）
/worktree merge --source <n> [--target b] [--strategy merge|squash|rebase-ff]
/worktree clean [--dry-run]              # 清理已合并 worktree
/worktree delete <name>                  # 单个删除
```
