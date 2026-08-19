---
name: worktree
description: 使用 git worktree 进行隔离开发。当用户要求隔离/并行开发多个任务、实验性改动、或在不污染当前工作区的前提下尝试某方案时使用。提供 create→开发→sync/rebase→merge→clean 的完整生命周期编排与安全护栏。
---

# worktree 隔离开发

pi-worktree 把 git worktree 变成**硬约束隔离开发**工具：切换 worktree = 切换会话 cwd 到该 worktree 目录，bash/read/write/edit 全部以 worktree 为执行根。用于把互不干扰的任务放到独立工作区并行推进，或在实验性改动不污染 main 的情况下试错。

## 何时使用

- 用户要求"隔离开发某特性/任务"、"开个独立工作区"、"并行做多个任务"
- 用户想在不污染当前工作区的情况下做实验性/探索性改动
- 用户明确提到 worktree，或要求"另起一个分支环境"工作

**不要**在以下场景用：用户只是普通地在一个分支上改代码（直接在当前 cwd 用 git 即可）。

## 核心概念

- **worktree 位置**：`<repo>-worktrees/<name>/`（仓库外，与主仓库同级）。任意 cwd 都能推导主仓库。
- **命名**：`/worktree create --name <n>` 可指定名字；缺省时自动从黄道恒星名池分配（如 `Aries-Hamal`）。分支固定为 `wt/<name>`，与路径名统一。
- **硬约束切换**：`/worktree use <name>` 通过会话切换把 cwd 变成 worktree 路径，无 prompt 软约束，模型无法绕过。

## 生命周期编排（标准流程）

1. **创建**：`/worktree create [--name <n>]` —— 指定 `--name` 时用指定名（分支 `wt/<n>`），缺省则自动分配恒星名；创建后立即切入新 worktree（TUI 会询问 node_modules 策略与会话策略）。
2. **开发**：cwd 已是 worktree，正常改代码、跑测试。
3. **同步**：把 worktree 分支同步到上游最新：`/worktree sync <name>`（= rebase 别名，worktree-local，见护栏 5）。
4. **合并回 main**：`/worktree merge --source <name> [--strategy <merge|squash|rebase-ff>]`。
5. **清理**：已合并的用 `/worktree clean [--dry-run]`；单个删除用 `/worktree delete <name>`。

## 命令速查

| 命令                                                       | 用途                                     |
| ---------------------------------------------------------- | ---------------------------------------- |
| `/worktree`                                                | 打开交互切换面板（TUI）                  |
| `/worktree create [--name n]`                              | 创建 worktree（缺省则自动分配恒星名）    |
| `/worktree use <name>` / `use main`                        | 切换到 worktree 或切回主仓库             |
| `/worktree list`                                           | 列出所有 worktree                        |
| `/worktree delete <name>`                                  | 删除 worktree                            |
| `/worktree merge --source <n> [--target b] [--strategy s]` | 合并 worktree 分支到 target（默认 main） |
| `/worktree rebase --source <n> [--target b]`               | 把 worktree 分支变基到 target            |
| `/worktree sync <n>`                                       | rebase 别名：同步分支到上游最新          |
| `/worktree continue` / `abort` / `status`                  | 处理进行中的 merge/rebase 冲突           |
| `/worktree clean [--dry-run]`                              | 删除已合并的 worktree                    |
| `/worktree prune [--dry-run]`                              | 清理 git 元数据中已不存在的目录记录      |
| `/worktree shell`                                          | 在 worktree 目录打开终端                 |
| `/worktree widget <on\|off>`                               | 切换状态栏 widget 显示                   |

## 合并策略（merge --strategy）

| 策略            | 效果                                                            |
| --------------- | --------------------------------------------------------------- |
| `merge`（默认） | 保留分支拓扑，产生 merge commit                                 |
| `squash`        | 压成单提交，线性历史                                            |
| `rebase-ff`     | worktree 内先变基再 fast-forward，主干完全线性、无 merge commit |

冲突时留在目标分支，解决后 `/worktree continue`，放弃则 `/worktree abort`。

## 安全护栏（必须遵守）

1. **不做远端操作**（ADR-0019）：插件不 push、不建 PR。合并成功后提示用户自行 `git push`。agent 也不要代劳 push。
2. **print 模式删除陷阱（高危）**：非 TUI 模式下 `/worktree delete <name>` 的确认弹窗自动通过——若 worktree 有未提交/未跟踪改动，会**静默 --force 强删并丢弃改动，无任何提示**。因此 print 模式下删除前必须先 `git -C <worktree 路径> status --porcelain` 确认干净，或明确警告用户有未提交改动。
3. **仅删除本地分支**：删除已合并的 worktree 会自动删除本地分支 `wt/<name>`，但**不会触碰远端**（对齐护栏 1 的"不 push"）。若远端存在 `origin/wt/<name>`，需用户自行 `git push origin --delete` 清理。
4. **会话文件不自动清理**：删除 worktree 后，其会话文件仍留在 `~/.pi/agent/sessions/`（便于 `/resume` 找回），需用户手动清理，agent 不必代删。
5. **worktree-local rebase**：git 禁止 rebase 一个正被其他 worktree checkout 的分支，变基必须在持有该分支的 worktree 目录内执行。插件已处理此约束，agent 不要从主仓库对 worktree 分支执行 rebase。
