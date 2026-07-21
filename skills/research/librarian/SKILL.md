---
name: librarian
description: '在 ~/.cache/checkouts/<host>/<org>/<repo> 下缓存和刷新远程 git 仓库，以便后续引用可以复用本地副本。当用户指向远程 git 仓库作为参考，或通过其他方式遇到远程 git 仓库时使用此技能。'
---

当用户指向远程 git 仓库（GitHub/GitLab/Bitbucket URL、`git@...` 或 `owner/repo` 简写）时使用此技能。

目标是维护一个可复用的本地检出，其具有：

- **稳定性**（路径可预测）
- **实时性**（定期 fetch + 安全时快速向前合并）
- **高效性**（使用 `--filter=blob:none` 部分克隆，无需重复完整克隆）

## 缓存位置

仓库存储在：

`~/.cache/checkouts/<host>/<org>/<repo>`

示例：

`github.com/mitsuhiko/minijinja` → `~/.cache/checkouts/github.com/mitsuhiko/minijinja`

## Command

```bash
bash checkout.sh <repo> --path-only
```

Examples:

```bash
bash checkout.sh mitsuhiko/minijinja --path-only
bash checkout.sh github.com/mitsuhiko/minijinja --path-only
bash checkout.sh https://github.com/mitsuhiko/minijinja --path-only
```

该脚本会：

1. 将仓库引用解析为 host/org/repo。
2. 如果缺少则克隆。
3. 如果存在则复用现有检出。
4. 过期时从 `origin` 获取（默认间隔：300 秒）。
5. 如果检出是干净的且有上游，则尝试快速向前合并。

## 更新策略

- 默认行为是**限流刷新**（每 5 分钟一次），避免不必要的网络请求。
- 强制立即刷新：

```bash
bash checkout.sh <repo> --force-update --path-only
```

## 推荐工作流

1. 通过 `checkout.sh --path-only` 解析仓库路径。
2. 使用该路径进行搜索、读取和分析。
3. 后续再次引用相同仓库时，重新调用 `checkout.sh`；它会找到并更新缓存的检出。

## 如果需要编辑

建议不要在共享缓存中直接编辑。从缓存的检出一个创建独立 worktree 或拷贝副本，用于特定任务的修改。

## 注意事项

- `owner/repo` 默认指向 `github.com`。
