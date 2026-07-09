# Agent Stuff

> 这个仓库是我在不同项目里复用的 Pi 代理资源集合。

## 🚀 快速开始

要在本地 Pi 代理中使用这些扩展、技能和主题，请按以下步骤操作：

### 1. 安装依赖

```bash
# 在工程根目录执行
npm install
```

这会安装所有必需的依赖，包括通过 `file:` 协议引用的本地包 `@zenone/pi-logger`。

> ⚠️ `@zenone/pi-logger` 是一个本地 npm 包（位于 `extensions/pi-logger/`），**不发布到 npm registry**。
> `npm install` 会通过 `file:extensions/pi-logger` 将其软链接到 `node_modules/@zenone/pi-logger`，
> 供 Pi 的 jiti 加载器解析使用。

### 2. 配置同步 Profile

编辑 [`scripts/sync-profiles.yaml`](scripts/sync-profiles.yaml)，按需调整 Profile：

```yaml
profiles:
  user-install:
    description: "安装所有资源到用户全局 Pi 代理目录"
    target: "~/.pi/agent"          # 目标目录
    extensions: "*"                 # 同步全部扩展
    skills: "*"                     # 同步全部技能
    themes: "*"                     # 同步全部主题
    prompts: ["*"]                  # 同步全部命令提示
    exclude:
      extensions: ["sandbox"]       # 排除某些扩展（如需要手动 npm install 的）
```

你也可以创建多个 Profile 用于不同场景（开发测试、生产安装等）。

### 3. 同步到本地 Pi 代理

```bash
# 默认同步到项目目录（.pi/），供 Pi 自动发现所有扩展、技能和主题
npx tsx scripts/sync-to-local-pi.ts

# 也可指定 Profile
npx tsx scripts/sync-to-local-pi.ts --profile user-install
```

### 4. 启动 Pi

同步完成后，启动 Pi 即可自动发现这些扩展、技能和主题：

```bash
pi
```

## 📦 同步脚本

详细用法、配置文件参考、内联模式、增量同步机制、npm install 处理等请参见 [docs/sync-tool.md](docs/sync-tool.md)。

### 快速参考

```bash
# 查看帮助
npx tsx scripts/sync-to-local-pi.ts --help

# 同步到项目目录（默认 Profile）
npx tsx scripts/sync-to-local-pi.ts

# 同步到用户全局目录（供 Pi 自动发现）
npx tsx scripts/sync-to-local-pi.ts --profile user-install

# 开发时快速测试（内联模式，无需编辑配置文件）
npx tsx scripts/sync-to-local-pi.ts --ext sandbox --target ./.pi/test
```

## 本地依赖解析

当扩展通过 `file:` 协议引用本地包（如 `@zenone/pi-logger`）时，同步脚本会自动处理依赖解析。详见 [docs/sync-tool.md](docs/sync-tool.md#本地依赖处理)。

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
* [`modern-dark.json`](themes/modern-dark.json) - Modern Dark theme.
