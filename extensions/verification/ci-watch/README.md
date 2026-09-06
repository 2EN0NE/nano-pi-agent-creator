# @zenone/pi-ci-watch

监控 GitHub PR **或分支**的 CI 状态并自动修复失败。缩短 CI 与编码 Agent 之间的反馈循环。

## 安装

```bash
pi install npm:@zenone/pi-ci-watch
```

或者在 `.pi/settings.json` 中：

```json
{
	"packages": ["npm:@zenone/pi-ci-watch"]
}
```

## 用法

### 命令

| 命令                         | 描述                                 |
| ---------------------------- | ------------------------------------ |
| `/ci-watch`                  | 打开 TUI 交互面板，选择监控/配置选项 |
| `/ci-watch <PR编号\|分支名>` | 直接监控指定 PR 或分支的 CI          |

### TUI 面板功能

无参数运行 `/ci-watch` 时，打开交互面板，提供以下选项（**监控分支**为第一项，日常主力）：

- **监控分支** — 输入分支名（默认当前分支）后开始监控
- **监控 PR** — 输入 PR 编号后开始监控
- **自动模式：开/关** — 切换每次 git push 后自动监控 CI
- **轮询配置** — 显示轮询配置（`Ctrl+O` 展开详细配置项）
    - 最小值 / 最大值 / 步长三个字段可单独编辑

面板底部显示当前状态（空闲 / 监控中...）和操作提示。

### 自动监控

启动时自动检测 `gh` CLI。如果已安装，自动模式默认开启；如果未安装，自动模式关闭并提示安装。

开启后，扩展会检测 `git push` 输出并自动开始监控：

- 有 PR → PR 模式（轮询 `gh pr checks`）
- 无 PR（如直接推 main）→ 分支模式（等待并轮询 `gh run list --branch`）

**等待本次 push 触发的新 run**：push 后 GitHub 创建/索引 workflow run 有 5~30 秒延迟。自动监控会记录本次 push 的 commit SHA，轮询直到出现 `headSha` 匹配的新 run 再判断状态——不会误读上一次 push 的旧 run 结果。分支无历史 run（新分支首次 push）同样会等待而非跳过。

tag push（`* [new tag]`）不会触发分支监控。

自动监控下，CI 通过时通知；失败时调用修复；错误/超时通知用户。

### CI 修复循环

当 CI 失败时：

1. 扩展获取失败日志（最后 100 行）
2. 调用 LLM（通过 `ci_watch` 工具）
3. 修复代码 → **本地验证（类型检查、e2e 测试、格式化）** → 提交 → 推送
4. 重复直到 CI 通过（最多 3 次尝试）

### 检测规则

- 纯数字输入（如 `12`）→ PR 模式
- 包含字母/斜线的输入（如 `main`、`feature/foo`）→ 分支模式

### 轮询配置

默认：30 秒最小值、60 秒最大值、15 秒步长。间隔从最小值增长到最大值，然后重置。

可在 TUI 面板中通过 `Ctrl+O` 展开配置后编辑。

配置文件（`~/.pi/agent/extensions-data/ci-watch/config.json`）额外支持：

- `autoMaxWaitMs` — 自动监控最长等待时间（默认 `600000`，即 10 分钟）。

### 工作原理

**PR 模式：** 使用智能间隔（30 秒 → 45 秒 → 60 秒 → 30 秒……）轮询 `gh pr checks`；push 后 check run 尚未注册时视为 pending（不误报通过）。
**分支模式：** 使用 `gh run list --branch` 直接查询分支的 CI run；提供本次 push 的 commit SHA 时等待该 run 出现后再判断。

### 生命周期安全

监控是长任务（最长 15 分钟），扩展会在会话替换/重载（`/reload`、`newSession`、`fork`、`switchSession`）时自动中止在途轮询，避免使用已失效的 ctx 导致 Pi 崩溃。

## 要求

- 已安装并认证 `gh` CLI（v2.12.0+；分支模式使用 `gh run list --branch` 服务端过滤，旧版本会报错并被当作"分支无 run"处理）
- 启用了 GitHub Actions CI 的仓库
