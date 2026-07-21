---
name: tmux
description: '通过发送按键和抓取面板输出来远程控制 tmux 会话，用于交互式 CLI（python、gdb 等）。'
license: Vibecoded
---

# tmux 技能

使用 tmux 作为可编程终端复用器进行交互式工作。适用于 Linux 和 macOS 的原生 tmux；通过使用私有 socket 避免自定义配置的干扰。

## 快速开始（隔离 socket）

```bash
SOCKET_DIR=${TMPDIR:-/tmp}/claude-tmux-sockets  # 所有 agent socket 的公共目录
mkdir -p "$SOCKET_DIR"
SOCKET="$SOCKET_DIR/claude.sock"                # 保持 agent 会话与你的个人 tmux 分离
SESSION=claude-python                           # 类 slug 名称；避免空格
tmux -S "$SOCKET" new -d -s "$SESSION" -n shell
tmux -S "$SOCKET" send-keys -t "$SESSION":0.0 -- 'python3 -q' Enter
tmux -S "$SOCKET" capture-pane -p -J -t "$SESSION":0.0 -S -200  # 查看输出
tmux -S "$SOCKET" kill-session -t "$SESSION"                   # 清理
```

启动会话后，**始终**告知用户如何监控会话，提供一个可复制粘贴的命令：

```
要自行监控此会话：
  tmux -S "$SOCKET" attach -t claude-lldb

或者一次性捕获输出：
  tmux -S "$SOCKET" capture-pane -p -J -t claude-lldb:0.0 -S -200
```

这条消息必须在会话启动后立即打印，并在工具循环结束前再次打印。越早发送，用户越满意。

## Socket 约定

- Agent 必须将 tmux socket 放在 `CLAUDE_TMUX_SOCKET_DIR` 下（默认为 `${TMPDIR:-/tmp}/claude-tmux-sockets`），并使用 `tmux -S "$SOCKET"`，以便我们可以枚举/清理它们。先创建目录：`mkdir -p "$CLAUDE_TMUX_SOCKET_DIR"`。
- 默认 socket 路径（除非需要进一步隔离）：`SOCKET="$CLAUDE_TMUX_SOCKET_DIR/claude.sock"`。

## 定位面板与命名

- 目标格式：`{session}:{window}.{pane}`，省略时默认为 `:0.0`。名称保持简短（如 `claude-py`、`claude-gdb`）。
- 一致使用 `-S "$SOCKET"` 以保持在私有 socket 路径上。如果需要用户配置，去掉 `-f /dev/null`；否则 `-f /dev/null` 提供干净的配置。
- 检查：`tmux -S "$SOCKET" list-sessions`、`tmux -S "$SOCKET" list-panes -a`。

## 查找会话

- 列出活动 socket 上的会话及元数据：`./scripts/find-sessions.sh -S "$SOCKET"`；添加 `-q partial-name` 进行过滤。
- 扫描共享目录下的所有 socket：`./scripts/find-sessions.sh --all`（使用 `CLAUDE_TMUX_SOCKET_DIR` 或 `${TMPDIR:-/tmp}/claude-tmux-sockets`）。

## 安全发送输入

- 偏好逐字发送以避免 shell 分割：`tmux -L "$SOCKET" send-keys -t target -l -- "$cmd"`
- 组合内联命令时，使用单引号或 ANSI C 引用来避免展开：`tmux ... send-keys -t target -- $'python3 -m http.server 8000'`
- 发送控制键：`tmux ... send-keys -t target C-c`、`C-d`、`C-z`、`Escape` 等

## 查看输出

- 捕获最近的历史（合并行以避免换行伪影）：`tmux -L "$SOCKET" capture-pane -p -J -t target -S -200`
- 持续监控时，使用辅助脚本轮询（如下），而非 `tmux wait-for`（后者不监控面板输出）
- 也可以临时附加观察：`tmux -L "$SOCKET" attach -t "$SESSION"`；用 `Ctrl+b d` 分离
- 给用户说明时，**明确打印可复制粘贴的监控命令**以及操作说明，不要假设用户记得命令

## 启动进程

进程的一些特殊规则：

- 当被要求调试时，默认使用 lldb
- 启动 python 交互式 shell 时，始终设置 `PYTHON_BASIC_REPL=1` 环境变量。这非常重要，因为非基础控制台会干扰你的 send-keys。

## 同步 / 等待提示符

- 使用定时轮询避免与交互式工具的竞态条件。示例：发送代码前等待 Python 提示符：
    ```bash
    ./scripts/wait-for-text.sh -t "$SESSION":0.0 -p '^>>>' -T 15 -l 4000
    ```
- 对于长时间运行的命令，轮询完成文本（`"Type quit to exit"`、`"Program exited"` 等）后再继续

## 交互式工具配方

- **Python REPL**：`tmux ... send-keys -- 'python3 -q' Enter`；等待 `^>>>`；用 `-l` 发送代码；用 `C-c` 中断。始终使用 `PYTHON_BASIC_REPL`。
- **gdb**：`tmux ... send-keys -- 'gdb --quiet ./a.out' Enter`；禁用分页 `tmux ... send-keys -- 'set pagination off' Enter`；用 `C-c` 中断；执行 `bt`、`info locals` 等；通过 `quit` 退出然后确认 `y`。
- **其他 TTY 应用**（ipdb、psql、mysql、node、bash）：相同模式——启动程序，轮询其提示符，然后发送逐字文本和 Enter。

## 清理

- 完成后终止会话：`tmux -S "$SOCKET" kill-session -t "$SESSION"`
- 终止 socket 上的所有会话：`tmux -S "$SOCKET" list-sessions -F '#{session_name}' | xargs -r -n1 tmux -S "$SOCKET" kill-session -t`
- 移除私有 socket 上的所有内容：`tmux -S "$SOCKET" kill-server`

## 辅助工具：wait-for-text.sh

`./scripts/wait-for-text.sh` 轮询面板以匹配正则表达式（或固定字符串），带超时。适用于 Linux/macOS，需要 bash + tmux + grep。

```bash
./scripts/wait-for-text.sh -t session:0.0 -p 'pattern' [-F] [-T 20] [-i 0.5] [-l 2000]
```

- `-t`/`--target` 面板目标（必填）
- `-p`/`--pattern` 要匹配的正则表达式（必填）；加 `-F` 表示固定字符串
- `-T` 超时秒数（整数，默认 15）
- `-i` 轮询间隔秒数（默认 0.5）
- `-l` 从面板搜索的历史行数（整数，默认 1000）
- 首次匹配退出码 0，超时退出码 1。失败时将最后捕获的文本打印到 stderr 以辅助调试
