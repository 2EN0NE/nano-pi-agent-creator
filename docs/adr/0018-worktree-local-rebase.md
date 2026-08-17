# ADR-0018: worktree 变基的执行目录约束（Worktree-Local Rebase）

- 状态：已接受（2026-08-17）
- 相关组件：`extensions/meta/worktree`（pi-worktree v2）

## 背景

`/worktree rebase <name>` 的原始实现在**主仓库根目录**执行
`git rebase origin/<onto> <sourceBranch>`，试图"无需 checkout 该分支"直接变基。
实验验证（/tmp 沙箱）该调用必现失败：

```
$ git rebase main wt/Aries-Hamal
fatal: 'wt/Aries-Hamal' is already used by worktree at '.../demo-worktrees/Aries-Hamal'
exit=128
```

根因：git 禁止 rebase 一个正被其他 worktree checkout 的分支（更新该分支需改写
其工作树）。这是 git 的硬约束，不是可配置项。

## 决策

1. **变基一律在持有目标分支的 worktree 目录内执行**（该目录的 HEAD 即该分支，
   git 允许）。`rebase` 与 `rebase-ff` 均遵循此约束——与 `git-merge-and-resolve`
   扩展（在当前分支所在目录内 rebase）一致。
2. **命令语义区分**：
    - `/worktree rebase <name>` —— 只变基**不合并**：把 worktree 分支变基到
      origin/main 最新，用户自行检查/测试后再决定收尾。同步手段。
    - `/worktree rebase-ff` —— 变基后自动 fast-forward 合并到 main。收尾手段。
3. **continue/abort 增强**：由于 rebase 冲突状态存在于发起目录，`/worktree
continue|abort` 不再固定跑主仓库根——自动遍历受管 worktrees，探测哪个目录
   `rebase-merge`/`rebase-apply` 状态存在，在**该目录**内执行
   `git rebase --continue/--abort`。main 根发起的 merge 冲突仍在 main 根处理。

## 权衡

| 方案                                        | 语义                                                                                | 结论     |
| ------------------------------------------- | ----------------------------------------------------------------------------------- | -------- |
| A. worktree 内执行 + 只变基不合并（本决策） | 保持 "rebase=同步、merge=收尾" 区分，对齐社区习惯；配合 continue/abort 探测 UX 不变 | **采纳** |
| B. 删除 plain rebase，只留 rebase-ff        | 简单，但用户失去"只同步不合并"能力                                                  | 拒绝     |
| C. rebase 合并进 rebase-ff（alias）         | 简单，但两个命令语义冗余                                                            | 拒绝     |

对比 Claude Code：官方无内置合并命令（社区手动 `git merge`，留 merge commit），
本决策的 rebase-ff 提供更自动、更线性的收尾，不落后于行业。

## 后果

- **正向**：plain rebase 可用；rebase 冲突后的 continue/abort 在正确目录执行；
  与 rebase-ff 的既有行为一致（e2e 已验证 rebase-ff）。
- **负向/注意**：
    - rebase 前需检查 worktree 无未提交修改（git 会拒绝，需先提示用户提交/stash）
    - continue/abort 探测遍历受管 worktrees，数量多时有少量 git 调用开销
    - 冲突面板 [L] 打开 worktree 终端的手动路径仍保留，作为兜底
- **测试**：vitest 补 plain rebase 成功/冲突用例（当前 operations.test.ts 无
  覆盖）；e2e 补 rebase → continue 闭环用例。
