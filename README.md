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

> ⚠️ `@zenone/pi-logger` 是一个本地 npm 包（位于 `extensions/meta/pi-logger/`），**不发布到 npm registry**。
> `npm install` 会通过 `file:extensions/meta/pi-logger` 将其软链接到 `node_modules/@zenone/pi-logger`，
> 供 Pi 的 jiti 加载器解析使用。

### 2. 配置同步 Profile

编辑 [`scripts/sync-profiles.yaml`](scripts/sync-profiles.yaml)，按需调整 Profile：

```yaml
profiles:
    user-install:
        description: '安装所有资源到用户全局 Pi 代理目录'
        target: '~/.pi/agent' # 目标目录
        extensions: '*' # 同步全部扩展
        skills: '*' # 同步全部技能
        themes: '*' # 同步全部主题
        prompts: ['*'] # 同步全部命令提示
        exclude:
            extensions: ['sandbox'] # 排除某些扩展（如需要手动 npm install 的）
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

- [`/apple-mail`](skills/apple-mail) - 查看和搜索 Apple Mail 本地存储中的邮件，并提取附件。
- [`/commit`](skills/commit) - 使用简洁的 Conventional Commits 风格创建 git 提交。
- [`/frontend-design`](skills/frontend-design) - 设计并实现有特色的前端界面。
- [`/github`](skills/github) - 通过 gh CLI 与 GitHub 交互（Issue、PR、Run、API）。
- [`/librarian`](skills/librarian) - 缓存并刷新 ~/.cache/checkouts 下的远程 Git 仓库。
- [`/mermaid`](skills/mermaid) - 使用 Mermaid CLI 创建和校验 Mermaid 图表。
- [`/native-web-search`](skills/native-web-search) - 触发本机网页搜索，并生成简洁总结与来源链接。
- [`/sentry`](skills/sentry) - 获取并分析 Sentry 的问题、事件、事务和日志。
- [`/summarize`](skills/summarize) - 通过 uvx markitdown 将文件/URL 转为 Markdown，并生成摘要。
- [`/tmux`](skills/tmux) - 通过按键与 pane 输出抓取来驱动 tmux 会话。
- [`/update-changelog`](skills/update-changelog) - 根据用户可见的改动更新仓库变更日志。
- [`/uv`](skills/uv) - 使用 uv 管理 Python 依赖并执行脚本。
- [`/web-browser`](skills/web-browser) - 通过 Chrome/Chromium CDP 实现浏览器自动化。

### Pi Coding Agent Extensions

Pi Coding Agent 的扩展在 [extensions](extensions) 目录中，按功能分类存放：

#### 🖥️ [tui/](extensions/tui) — 交互界面

| 扩展                                                          | 说明                                                             |
| ------------------------------------------------------------- | ---------------------------------------------------------------- |
| [`answer.ts`](extensions/tui/answer.ts)                       | 逐个回答问题的交互式 TUI                                         |
| [`btw.ts`](extensions/tui/btw.ts)                             | 简易的 `/btw` 侧边聊天弹窗，关闭时可把摘要回注入主会话           |
| [`files.ts`](extensions/tui/files.ts)                         | 统一的文件浏览器，整合 git 状态、会话引用、reveal/open/edit/diff |
| [`qna.ts`](extensions/tui/qna.ts)                             | Q&A 提取，将问题加载到编辑器填写                                 |
| [`questionnaire.ts`](extensions/tui/questionnaire.ts)         | 问卷工具，支持单选/多标签页                                      |
| [`session-breakdown.ts`](extensions/tui/session-breakdown.ts) | 7/30/90 天会话与花费分析 TUI，带用量图表                         |
| [`split-fork.ts`](extensions/tui/split-fork.ts)               | `/split-fork` 命令，分叉到 Ghostty 分屏新 pi 进程                |
| [`whimsical.ts`](extensions/tui/whimsical.ts)                 | 用随机的 whimsical 句子替换默认思考提示                          |

#### 🧩 [context/](extensions/context) — 上下文组装

| 扩展                                                                              | 说明                                                                                   |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| [`claude-rules.ts`](extensions/context/claude-rules.ts)                           | 扫描 `.claude/rules/` 注入 system prompt                                               |
| [`custom-compaction/`](extensions/context/custom-compaction/)                     | 自定义 compaction（触发时机 + 压缩机制双维度、adapter 插件体系、/custom-compact 命令） |
| [`goal.ts`](extensions/context/goal.ts)                                           | 可选的 `/goal` 模式，支持长期目标持久化、状态控制                                      |
| [`input-transform-streaming.ts`](extensions/context/input-transform-streaming.ts) | 流式输入转换，在 user input 到达模型前处理                                             |
| [`prompt-customizer.ts`](extensions/context/prompt-customizer.ts)                 | 根据活跃工具和技能自定义 system prompt                                                 |
| [`mode-switcher.ts`](extensions/meta/mode-switcher.ts)                            | 一键切换模型预设，支持持久化/快捷键                                                    |
| [`prompt-editor.ts`](extensions/meta/prompt-editor.ts)                            | 检查和控制 Pi 发送给模型的 prompt 组装过程，支持组件启用/禁用和内容编辑                |
| [`resources-tree/`](extensions/context/resources-tree/)                           | 资源树扫描，在 system header 中展示可用资源                                            |

#### 🔒 [security/](extensions/security) — 审计与安全

| 扩展                                                                   | 说明                                              |
| ---------------------------------------------------------------------- | ------------------------------------------------- |
| [`confirm-destructive.ts`](extensions/security/confirm-destructive.ts) | 破坏性操作前确认（clear/switch/branch）           |
| [`dirty-repo-guard.ts`](extensions/security/dirty-repo-guard.ts)       | 有未提交变更时阻止会话切换                        |
| [`permission-gate.ts`](extensions/security/permission-gate.ts)         | 危险 bash 命令前确认（rm -rf / sudo / chmod 777） |
| [`protected-paths.ts`](extensions/security/protected-paths.ts)         | 阻止 write/edit 到敏感路径（.env / .git/）        |
| [`project-trust.ts`](extensions/security/project-trust.ts)             | 项目信任机制                                      |
| [`trust-github-repos.ts`](extensions/security/trust-github-repos.ts)   | 自动记住受信 GitHub 所有者的检出信任状态          |
| [`sandbox/`](extensions/security/sandbox/)                             | OS 级沙箱执行 bash（sandbox-exec / bubblewrap）   |

#### ⚙️ [auto/](extensions/auto) — 自动化

| 扩展                                                                   | 说明                                     |
| ---------------------------------------------------------------------- | ---------------------------------------- |
| [`auto-stage-on-exit.ts`](extensions/auto/auto-stage-on-exit.ts)       | 退出时自动暂存变更文件                   |
| [`file-trigger.ts`](extensions/auto/file-trigger.ts)                   | 文件触发器，外部系统可通过写入文件发消息 |
| [`git-checkpoint.ts`](extensions/auto/git-checkpoint.ts)               | 每轮对话创建 git stash checkpoint        |
| [`git-merge-and-resolve.ts`](extensions/auto/git-merge-and-resolve.ts) | 自动合并上游跟踪分支，冲突时引导解决     |
| [`go-to-bed.ts`](extensions/auto/go-to-bed.ts)                         | 深夜安全保护，超过午夜后要求显式确认     |
| [`loop.ts`](extensions/auto/loop.ts)                                   | 快速迭代编码的提示循环，支持可选自动继续 |
| [`no-sleep.ts`](extensions/auto/no-sleep.ts)                           | 防止 macOS 在 agent 运行时休眠           |
| [`notify.ts`](extensions/auto/notify.ts)                               | 代理任务结束后发送桌面原生通知           |

#### 🎯 [accuracy/](extensions/accuracy) — 更精准强大信息获取与操作工具

| 扩展                                                               | 说明                                                       |
| ------------------------------------------------------------------ | ---------------------------------------------------------- |
| [`control.ts`](extensions/accuracy/control.ts)                     | 会话控制辅助工具（列出可控会话、跨会话通信）               |
| [`multi-edit.ts`](extensions/accuracy/multi-edit.ts)               | 替换内置 edit，支持批量 multi 和 Codex 风格 patch 及预检验 |
| [`structured-output.ts`](extensions/accuracy/structured-output.ts) | 结构化输出工具，支持 terminate: true                       |
| [`todos.ts`](extensions/accuracy/todos.ts)                         | 基于文件存储的 todo 管理扩展                               |
| [`truncated-tool.ts`](extensions/accuracy/truncated-tool.ts)       | 工具输出截断示例（rg 包装器）                              |
| [`uv.ts`](extensions/accuracy/uv.ts)                               | 面向 uv 的 Python 工作流辅助工具                           |

#### ✅ [verification/](extensions/verification) — 验证与评估

| 扩展                                             | 说明                                                   |
| ------------------------------------------------ | ------------------------------------------------------ |
| [`review.ts`](extensions/verification/review.ts) | 代码评审命令，支持工作区、PR 风格 diff、提交、定制指令 |

#### 🔧 [meta/](extensions/meta) — 元插件

| 扩展                                                   | 说明                                                           |
| ------------------------------------------------------ | -------------------------------------------------------------- |
| [`commands.ts`](extensions/meta/commands.ts)           | `/commands` 列出所有可用命令                                   |
| [`preset.ts`](extensions/meta/preset.ts)               | 预设配置管理（model/tools/instructions），支持 CLI/命令/快捷键 |
| [`skills.ts`](extensions/meta/skills.ts)               | `/skills` 交互式启停技能，持久化配置                           |
| [`tools.ts`](extensions/meta/tools.ts)                 | `/tools` 交互式启停工具，支持 MCP 延迟注册                     |
| [`pi-logger/`](extensions/meta/pi-logger/)             | 统一日志基础设施，所有扩展通过 `createLogger()` 接入           |
| [`pi-rate-limiter/`](extensions/meta/pi-rate-limiter/) | 速率限制基础设施，主动节流 + 自动恢复                          |

### Pi Coding Agent Themes

主题文件在 [themes](themes) 目录中：

- [`nightowl.json`](themes/nightowl.json) - Night Owl-inspired theme.
- [`modern-dark.json`](themes/modern-dark.json) - Modern Dark theme.
