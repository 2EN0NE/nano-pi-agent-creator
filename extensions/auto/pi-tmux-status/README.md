# pi-tmux-status

让 Pi 主动通知 tmux 更新窗格边框颜色，实时反映运行状态。

## 颜色映射

| 状态 | 边框颜色 | 触发条件 | 说明 |
|------|---------|----------|------|
| 🟢 等待输入 | **绿色** `colour82` | `agent_settled` + 无对话框 | Pi 停在提示符，等待你输入 |
| 🟡 执行中 | **黄色** `colour226` | `turn_start` | Pi 正在生成回复或调用工具 |
| 🔴 选择中 | **红色** `colour196` | `__piTmuxDialogState.isSelecting=true` | 有选择/确认对话框正在等待你操作 |

## 工作原理

Pi 的 Extension API 提供精确的生命周期事件，扩展直接调用 `tmux` 命令修改边框颜色。

```
用户输入
  ↓
turn_start ──→ 边框变 🟡 黄（执行中）
  ↓
Pi 正在运作...
  ↓                    ┌── 有选择对话框 → 边框变 🔴 红 ← 通过 globalThis 检测
agent_settled ────────┤
  ↓                    └── 无对话框 → 边框变 🟢 绿（等待输入）
等待用户输入
```

对话框检测通过 `globalThis.__piTmuxDialogState` 实现，由 `meta/selector.ts` 在显示/关闭对话框时设置。`pi-tmux-status` 每 500ms 检查一次该状态。这样即使是自定义 dialog 也能同步变红。

- **零轮询进程**：不检查 CPU、不解析日志
- **边框仅影响边线**：`set -w pane-active-border-style`，不修改 pane 内文本颜色
- **无文件 I/O**：通过 `globalThis` 跨扩展通信

## 安装

### 方式一：同步到本地 Pi（推荐）

```bash
npx tsx scripts/sync-to-local-pi.ts --ext pi-tmux-status --target ~/.pi/agent
```

### 方式二：手动放置

将 `pi-tmux-status/` 整个目录复制到 Pi 的扩展目录：

```bash
cp -r extensions/auto/pi-tmux-status ~/.pi/agent/extensions/auto/
```

然后重启 Pi 或执行 `/reload`。

## Tmux 配置要求

本扩展**必须在 tmux 中运行**才能生效。扩展启动时会检测 `$TMUX` 环境变量，不在 tmux 中会自动跳过。

### 最小配置（必须）

在你的 `~/.tmux.conf` 中确保有以下设置：

```tmux
# 启用窗格标题栏（边框顶部显示状态文本）
set -g pane-border-status top

# 窗格标题格式（显示 AI 状态 + 当前命令）
set -g pane-border-format '#( ~/.local/bin/tmux-pane-title #{pane_id}) | #{pane_current_command} | #P '

# 边框颜色基础值（Pi 扩展会在运行时动态覆盖）
set -g pane-active-border-style fg=colour82,bold
```

### 完整推荐配置

参见同目录下的 [`tmux-recommended.conf`](tmux-recommended.conf)，包含：

- 窗格状态可视化（必选）
- 扩展键支持（Pi 推荐）
- AI 工作区快捷键（可选）
- 基础优化项

你可以：

- **直接复制**整个文件内容到 `~/.tmux.conf`
- **选择性复制**你需要的段落（每段都有注释标注是否可选）

## 卸载

1. 从 `~/.pi/agent/extensions/auto/` 删除 `pi-tmux-status/` 目录
2. 执行 `/reload` 或重启 Pi
3. （可选）从 `~/.tmux.conf` 移除对应的边框配置

## 与 Claude 共存

本扩展仅控制 **Pi** 的边框颜色。如果你同时在 tmux 中使用 Claude，Claude 的边框颜色由以下机制控制：

- **Claude hooks**：通过 `~/.claude/settings.json` 的 `hooks` 配置，在 `UserPromptSubmit` / `PreToolUse` 事件中调用 tmux 命令
- **轮询备份**：`tmux-ai-style-monitor.sh` 作为兜底方案，通过检测进程 CPU 来估计 Claude 状态

两种方案互不冲突，可同时使用。
