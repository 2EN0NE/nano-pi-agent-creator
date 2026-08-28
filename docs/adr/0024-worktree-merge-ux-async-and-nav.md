# ADR-0024: worktree merge 异步化与结果导航面板

worktree merge 有三层 UX 缺陷：执行期间 `execMerge`/`execRebaseFF` 全程 `spawnSync` 同步阻塞，合并前的 `notify`「合并中…」来不及渲染就被堵死（TUI raw mode 下 Ctrl+C 是 0x03 字节、Pi 未注册 SIGINT，阻塞期间按键被缓冲，无法中断，只能强杀进程留 stash/checkout/MERGE_HEAD 中间状态）；成功后弹只读「Next steps」清单，`[1] npm run typecheck` 误似可交互菜单、硬编码 npm 未做工程语言绑定、与 husky hook 冗余，且 `git add + git commit` 是误导（merge `--no-ff` 已产生 commit）；冲突面板 `[L]`/`[A]` 按钮的返回值被忽略、是死按钮，squash 冲突已回滚却仍弹冲突面板。

本次重构：① 异步化 + `setStatus` 进行中提示 + 120s 超时；② 成功后中文两选项导航面板（切换到 target / 回到主菜单），命令触发则 notify 一句；③ 冲突面板中文化 + 修复死按钮 + 新增「让 Agent 修复」（内嵌 `resolving-merge-conflicts` 提示词经 `pi.sendUserMessage` 发出）；④ squash / rebase-ff 冲突回滚 notify 引导同步（二者冲突后均已回滚，无冲突状态可解决）；⑤ 非冲突失败中文提示 + 回主菜单；⑥ `runGit` 结果带 `timedOut` 字段区分超时与 spawn error。

## 考虑过的选项

- **进行中反馈 A（采用）**：`spawnSync` → `spawn`+Promise 异步化，执行前 `setStatus('pi-worktree', '合并中…')`，git 命令带超时，`try/finally` 清除状态。唯一能根治「卡住无反馈」的路径。
- **进行中反馈 B（否决）**：不异步化、仅加 `setStatus`。同步阻塞下 `setStatus` 与 `notify` 一样在下一事件循环 tick 才渲染，照样来不及显示，等于没解决。
- **进行中反馈 C（否决）**：只改确认文案「合并可能需数十秒」。零真实反馈，且上述阻塞期间无法优雅中断，卡住只能强杀留残局。

- **成功面板 A（采用）**：两选项导航面板（「切换到 <target>」→ `handleUse`，「回到主菜单」→ `handlePanel`），Esc 关闭停留。复用既有面板语义、补齐「面板戛然而止」断点。
- **成功面板 B（否决）**：保留 Next steps 清单。typecheck/test/format 与 husky hook 冗余；`git add + git commit` 误导；`[1]` 编号误似可交互。
- **成功面板 C（否决）**：动态检测包管理器 + 读 package.json 再显示验证命令。仍与 hook 冗余、复杂度上升，且真实下一步只是 `git push`。

- **冲突修复 A（采用）**：面板中文化 + 修死按钮（返回值接 `handleShell`/`handleAbort`）+ 4 选项 +「让 Agent 修复」经风险确认后 `pi.sendUserMessage(内嵌提示词, {deliverAs:'followUp'})`。提示词内嵌而非调用技能，避免 worktree 插件与独立技能耦合。
- **冲突修复 B（否决）**：只修死按钮、不中文化、不加 Agent 辅助。未满足「让 agent 解决冲突」诉求。
- **冲突修复 C（否决）**：运行时调用 `resolving-merge-conflicts` 技能。技能不一定存在于用户环境，且把 worktree 插件与技能生命周期耦合。

- **squash / rebase-ff 冲突 A（采用）**：二者冲突后工作区均已回滚（squash `reset --hard`；rebase-ff `rebase --abort` + 恢复主仓库），无冲突状态可解决，故不弹冲突面板，改 notify「先 /worktree rebase 同步再 merge」。若弹面板让 Agent `rebase --continue` 会因无进行中 rebase 直接失败。
- **squash / rebase-ff 冲突 B（否决）**：继续弹冲突面板。工作区已回滚、无冲突可「resolve 不 abort」，纯误导。

## 后果

- 异步化 + 超时消除 TUI 阻塞；`git pull` 网络卡住可反馈、120s 超时自动中止回滚，不再无限等待。
- `fromPanel` 判定引入「命令 vs 面板」两条交互路径，`handleMerge` 所有调用点需显式传参（`handlePanel`/`handleOperationsSubmenu` 传 true，dispatch 命令传 false）。
- 内嵌提示词与技能原文解耦：技能更新时需手动同步（接受的权衡，换取无运行时耦合）。
- squash / rebase-ff 冲突语义澄清为「回滚 + 引导同步」，与 merge 冲突的「解决」路线分离（rebase-ff 冲突虽名为 rebase，但 `execRebaseFF` 已 `rebase --abort` 回滚，无进行中 rebase 可 continue）。
- `runGit`（spawn+Promise+超时）成为 merge 流程的 git 执行原语，`GitRunResult.timedOut` 区分超时（true）与 spawn error（false）两类 `status=null` 情形，后续命令可复用。

## 迁移说明

`worktree` 从 `user-install` profile 移出，改由 `project` profile（`extensions: '*'`）同步到项目级 `.pi/extensions/worktree/`。sync 工具默认**不删除**目标中任何文件，因此此前同步到用户全局目录 `~/.pi/agent/extensions/worktree/` 的旧副本不会自动移除，会导致 `registerCommand('worktree')` 重复注册（Pi 启动报错）。

**清理步骤（二选一）：**

```bash
# 方案 A：手动删除全局旧副本
rm -rf ~/.pi/agent/extensions/worktree

# 方案 B：对 user-install profile 显式 purge（仅清理该 profile 目标中不属于本次同步的资源）
npx tsx scripts/sync-to-local-pi.ts --profile user-install --purge
```

> `--purge` 会删除目标目录中所有不在 profile 声明里的资源，使用前务必确认 `~/.pi/agent/` 下无其他未声明的自定义资源。
