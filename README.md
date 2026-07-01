# Agent Stuff

这个仓库是我在不同项目里复用的 Pi 代理资源集合。当前工程只供本人本地使用，不做 npm 发布。

如果你要把当前的命令、扩展、技能和主题同步到本地 Pi 代理目录，直接运行：

```bash
./scripts/sync-to-local-pi.sh
```

默认会把资源同步到当前项目的 .pi/agents。若需要改成同步到用户目录 ~/.pi/agents，可以这样执行：

```bash
./scripts/sync-to-local-pi.sh --target user
```

如果想同时同步到两个位置，也可以用：

```bash
./scripts/sync-to-local-pi.sh --target both
```

脚本会把 [commands](commands)、[extensions](extensions)、[skills](skills) 和 [themes](themes) 同步到目标位置。

## 目录说明

### Skills

所有技能都在 [skills](skills) 目录中：

* [`/apple-mail`](skills/apple-mail) - 查看和搜索 Apple Mail 本地存储中的邮件，并提取附件。
* [`/commit`](skills/commit) - 使用简洁的 Conventional Commits 风格创建 git 提交。
* [`/frontend-design`](skills/frontend-design) - 设计并实现有特色的前端界面。
* [`/github`](skills/github) - 通过 gh CLI 与 GitHub 交互（Issue、PR、Run、API）。
* [`/librarian`](skills/librarian) - 缓存并刷新 ~/.cache/checkouts 下的远程 Git 仓库。
* [`/mermaid`](skills/mermaid) - 使用 Mermaid CLI 创建和校验 Mermaid 图表。
* [`/native-web-search`](skills/native-web-search) - 触发本机网页搜索，并生成简洁总结与来源链接。
* [`/sentry`](skills/sentry) - 获取并分析 Sentry 的问题、事件、事务和日志。
* [`/summarize`](skills/summarize) - 通过 uvx markitdown 将文件/URL 转为 Markdown，并生成摘要。
* [`/tmux`](skills/tmux) - 通过按键与 pane 输出抓取来驱动 tmux 会话。
* [`/update-changelog`](skills/update-changelog) - 根据用户可见的改动更新仓库变更日志。
* [`/uv`](skills/uv) - 使用 uv 管理 Python 依赖并执行脚本。
* [`/web-browser`](skills/web-browser) - 通过 Chrome/Chromium CDP 实现浏览器自动化。

### Pi Coding Agent Extensions

Pi Coding Agent 的扩展在 [extensions](extensions) 目录中：

* [`answer.ts`](extensions/answer.ts) - 逐个回答问题的交互式 TUI。
* [`btw.ts`](extensions/btw.ts) - 一个简易的 `/btw` 侧边聊天弹窗，可在关闭时把摘要回注入主会话。
* [`control.ts`](extensions/control.ts) - 会话控制辅助工具（列出可控会话等）。
* [`files.ts`](extensions/files.ts) - 统一的文件浏览器，整合 git 状态、会话引用、 reveal/open/edit/diff 等操作。
* [`split-fork.ts`](extensions/split-fork.ts) - `/split-fork` 命令，可把当前会话分叉到右侧 Ghostty 分屏中的新 pi 进程。
* [`go-to-bed.ts`](extensions/go-to-bed.ts) - 深夜安全保护，超过午夜后会要求显式确认。
* [`goal.ts`](extensions/goal.ts) - 可选的 `/goal` 模式，支持长期目标持久化、状态控制和模型工具。
* [`loop.ts`](extensions/loop.ts) - 快速迭代编码的提示循环，支持可选自动继续。
* [`multi-edit.ts`](extensions/multi-edit.ts) - 用批量 `multi` 编辑替换内置 `edit` 工具，并支持 Codex 风格的 `patch` 及预检验。
* [`notify.ts`](extensions/notify.ts) - 代理任务结束后发送桌面原生通知。
* [`prompt-editor.ts`](extensions/prompt-editor.ts) - 编辑器内的提示词模式选择器，支持持久化、历史记录、配置和快捷键。
* [`review.ts`](extensions/review.ts) - 代码评审命令，支持工作区、PR 风格 diff、提交、定制指令与可选修复循环。
* [`session-breakdown.ts`](extensions/session-breakdown.ts) - 7/30/90 天会话与花费分析的 TUI，带用量图表。
* [`todos.ts`](extensions/todos.ts) - 基于文件存储的 todo 管理扩展，提供 TUI。
* [`trust-github-repos.ts`](extensions/trust-github-repos.ts) - 自动记住 `earendil-works` 或 `mitsuhiko` 下 GitHub 检出的信任状态。
* [`uv.ts`](extensions/uv.ts) - 面向 uv 的 Python 工作流辅助工具。
* [`whimsical.ts`](extensions/whimsical.ts) - 用随机的 whimsical 句子替换默认思考提示。

### Pi Coding Agent Themes

主题文件在 [themes](themes) 目录中：

* [`nightowl.json`](themes/nightowl.json) - Night Owl-inspired theme.

### 本地同步脚本

目前的本地同步入口在 [scripts/sync-to-local-pi.sh](scripts/sync-to-local-pi.sh)。

如果只想先做一次预检查，可以运行：

```bash
./scripts/sync-to-local-pi.sh --dry-run
```

## 拦截命令

Command wrappers live in [`intercepted-commands`](intercepted-commands):

* [`pip`](intercepted-commands/pip)
* [`pip3`](intercepted-commands/pip3)
* [`poetry`](intercepted-commands/poetry)
* [`python`](intercepted-commands/python)
* [`python3`](intercepted-commands/python3)

## 本地依赖：@zenone/pi-logger

`@zenone/pi-logger` 是一个本地 npm 包（来自 `extensions/pi-logger/`），不发布到 npm registry。所有扩展通过 `import { createLogger } from "@zenone/pi-logger"` 使用日志功能。

在新电脑上 clone 工程后需要执行：

```bash
# 安装所有依赖（会自动安装 @zenone/pi-logger）
npm install
```

这会将 `extensions/pi-logger/` 通过 `file:` 协议软链接到 `node_modules/@zenone/pi-logger`，供 pi 的 jiti 加载器解析。
