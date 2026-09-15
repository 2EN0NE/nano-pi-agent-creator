# pi-rewind

自动 checkpoint + 自主回滚扩展（`/rewind` `/checkpoint`），取代已删除的 `git-checkpoint`。

> 移植自 oh-my-pi 的 `@ayulab/pi-rewind` + `@ayulab/pi-checkpoint`（GPL-3.0）；引擎内联本包 `engine/`。设计见 `docs/adr/0038`（存储与回滚模型）、`docs/adr/0039`（架构分层与跨插件边界）。

## 能力

| 能力            | 说明                                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 自动 checkpoint | `checkpointTrigger` 三态：`message`（每条用户消息）、`event`（仅 fork/clone/tree 导航前打快照）、`off`                                                       |
| `/rewind`       | 列出历史 checkpoint，选目标后按恢复模式回滚（对话 + 代码）                                                                                                   |
| `/checkpoint`   | 存储管理 UI：查看各会话 checkpoint 存储、手动删除（当前会话受 active 保护）                                                                                  |
| 安全回滚        | `safeCheckout`：dirty guard + safety commit + 失败自动 rollback；**不写用户真实 git refs**                                                                   |
| 存储            | 每会话一个独立 bare repo（`~/.pi/agent/rewind/checkpoints/<sid>/`），元数据以 `pi-checkpoint` custom entry 写入会话树                                        |
| retention GC    | `retentionDays` 按 storage manifest `updatedAt` 清理过期存储（0 = 永不清理）                                                                                 |
| 体积保护        | `maxFileMB` / `skipBinary` / `includeUntracked` 三 knob，stage 时跳过超大/二进制/untracked 文件                                                              |
| 跨插件抑制      | `globalThis.__piRewind.suppressTreeRestore(sessionId)` / `clearSuppressTreeRestore(sessionId)`，供其它插件（如 review 开审查分支）跳过下一次树导航的文件回滚 |

## 配置

双层路径（项目级覆盖用户级），由 `@zenone/pi-config` 读写：

- 用户级：`~/.pi/agent/extensions-data/pi-rewind/config.json`
- 项目级：`<cwd>/.pi/extensions-data/pi-rewind/config.json`

```jsonc
{
	"enabled": true,
	"checkpointTrigger": "message", // message | event | off
	"restoreOnTree": "ask", // /tree 导航恢复策略：never | ask | always
	"restoreOnFork": "ask", // /fork 恢复策略
	"restoreOnClone": "never", // fork 的 "at" 位（clone）恢复策略
	"restoreOnResume": false, // resume/启动选中旧会话时是否回滚文件
	"retentionDays": 30, // 0 = 永不清理
	"maxFileMB": 25, // 0 = 不设限
	"skipBinary": true,
	"includeUntracked": true,
	"exclude": [], // 追加排除路径
	"include": [], // 以 ! 重新包含
}
```

## 范围边界（重要）

快照与回滚**只覆盖会话 cwd（pi 启动/会话工作目录）内、且未被排除的普通文件**：

- **cwd 之外不可记录、不可回滚**：`/tmp`、`~` 其它项目、`../`、绝对路径写入的文件不产生 checkpoint，`/rewind` 也不触碰它们。
- cwd 内嵌套 git 子仓库自动排除；符号链接只存链接本身，不跟踪 cwd 外目标内容。
- exclude / 体积保护跳过项回滚时不恢复、不清理。

**使用约定**：希望有记录 / 可回滚的产物一律放在会话 cwd 内；确需项目内临时目录（如 `tmp/`、`/tmp`、`/temp`）请加入 `.gitignore`，pi-rewind 在真实 git 仓库内尊重 `.gitignore`，忽略项不进 untracked 快照。

## 开发

- 分层：`engine/`（纯 git 库，零 Pi 依赖，可单测）→ `commands/` + `auto-checkpoint.ts` + `index-helpers.ts`（编排与决策纯函数）→ `index.ts`（Pi 生命周期接线）。
- 测试：`test/vitest/extensions/pi-rewind*.test.ts`（纯函数 + 真实 git 集成 + TUI headless）；e2e 见 `test/e2e/extensions/pi-rewind/smoke.test.sh`。
