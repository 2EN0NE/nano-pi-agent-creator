# pi-rewind 存储与回滚模型

**决策**：pi-rewind 的 checkpoint 存**独立 bare repo**（每个会话一个，`~/.pi/agent/rewind/checkpoints/<sessionId>/`，work tree 指向项目目录），回滚用 **`safeCheckout`**（dirty guard + safety commit + 失败自动 rollback），**不写用户真实 git 仓库的 refs、不做 `git reset --hard`**。基于 oh-my-pi 的 `@ayulab/pi-checkpoint` 引擎（GPL-3.0），单包内联进 `extensions/auto/pi-rewind/engine/`。

**为什么**：候选的 standalone pi-rewind（arpagon，MIT）把 checkpoint 写成用户真实仓库的 `refs/pi-checkpoints/*`，回滚时 `git reset --hard <headSha>`——会移动用户真实分支 HEAD、可能抹掉用户自己的 commit，且要求 cwd 必须是 git 仓库。独立 bare repo 完全隔离：回滚只改工作区文件，不动用户 git 历史；非 git 目录也能用（自建 bare repo + 额外解析 `.gitignore`）。

## 考虑过的选项

- **standalone 方案（写用户 repo refs + reset --hard）**——否决：污染用户 git、破坏性回滚（抹用户 commit）、依赖 cwd 是 git repo。
- **独立 bare repo + safeCheckout（采用）**：隔离 + 安全（dirty guard 挡未快照变更、safety commit 兜底、失败自动 rollback）。storage 按 session 文件路径寻址，是跨包/跨插件互操作的 seam。

## 后果

- 存储路径 `~/.pi/agent/rewind/checkpoints/<sid>/`。有会话文件时按 session 文件名寻址；无会话文件的 ephemeral 运行（`--no-session`）按 cwd 哈希寻址（`ephemeral-<sha1(cwd) 前16位>`），避免不同项目共用同一 bare repo/index。
- 体积保护三 knob（`maxFileMB` / `skipBinary` / `includeUntracked`）在 stage 阶段跳过超大/二进制/untracked 文件；**跳过的文件回滚时也不恢复/清理**（未纳入快照）。
- 时间维度清理用 `retentionDays` + storage manifest 的 `updatedAt` + `purgeSessionCheckpointStorage`（见 ADR-0039）。

## 范围边界：快照/回滚只覆盖会话 cwd

**决策**：bare repo 的 work tree = 会话绑定的 `ctx.cwd`（pi 启动/会话工作目录）。快照拾取（`git add -A -- .`，`engine/repo-manager.ts`）与回滚写文件（`git reset --hard` + `git clean -fd`）**都只在 work tree 内发生**。

由此推出（不写用户真实 git refs 之外的**第二层边界承诺**）：

1. **cwd 之外的文件不可记录、不可回滚**——`/tmp`、`~/其它项目`、`../`、绝对路径写入的文件不进 checkpoint、不产生 diff；rewind 也不触碰它们。git 对 work tree 外的 pathspec 直接拒绝。
2. **cwd 内的嵌套 git 子仓库**被自动整目录排除（`findNestedGitRepoExcludes`），其内容不进快照。
3. **符号链接指向 cwd 外**——git 只存链接本身，不跟踪目标内容；经 symlink 修改的 cwd 外真实文件不可见。
4. **dirty guard 只感知 cwd 内**：`safeCheckout` 的干净检查基于 work tree 内 `stageAll + diffAgainst`。cwd 外的未保存改动既不会阻止回滚，也不会被误伤。
5. **exclude / 体积保护跳过项**（node_modules、dist、超大/二进制等）回滚时不恢复、不清理（与「后果」一致）。

**推论**：本项目的「自主回滚安全网」覆盖范围 = **会话 cwd 目录内、未被排除的普通文件**。希望有记录/可回滚的产物必须放在 cwd 内；项目内临时目录（如 `/tmp/`、`/temp/`、`.scratch/`）应加入 `.gitignore`——pi-rewind 在真实 git 仓库内 `git add` 尊重 `.gitignore`，忽略项不进 untracked 快照，避免快照噪声与 git 状态污染（仓库内约定见 AGENTS.md「临时产物与 pi-rewind 可记录性」）。
