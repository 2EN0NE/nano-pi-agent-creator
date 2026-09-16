pi-worktree
===========

Pi 扩展：基于 git worktree 的隔离开发工作流管理。

核心定位：**本地优先**。pi-worktree 主要服务本地隔离开发——把互不干扰的任务放到独立工作区并行推进，或在实验性改动不污染主干的情况下试错。**worktree 内容默认不推送到远端**，所有远端副作用（push、PR 创建、远程分支管理）由用户自己兜底。

设计原则
--------

1. **本地优先（Local-First）**：插件的一切推荐均基于「worktree 主要用于本地开发」这一前提。合并、变基、清理都是纯本地 git 操作，插件不自动 push、不强推、不在命令中隐含远端副作用。
2. **远端归人（Remote by Human）**：push / PR / 远程分支管理属用户决策域。插件只提供只读的同步差距提示（本地/远端落后几个提交）和手动「拉取最新」选项，由用户决定何时与远端同步。
3. **只读诊断、不隐式联网**：落后/领先提示**只读本地已有的 remote-tracking ref**（`origin/<branch>`），对比本地与远端的差距；**不隐式 `fetch`**——远端引用可能略陈旧，这是「不把网络变成操作中途的可失败点」的代价。要刷新差距请用户显式发起：`git fetch`，或面板里的「拉取最新」。**无远端 / 远端分支不存在 / 网络不可用时静默隐藏提示，绝不报错**。（`getRemoteAheadBehind({ fetch: true })` 仅由显式请求触发。）
4. **本地优先的基点解析（ADR-0061）**：创建/变基/合并的「目标分支」不再默认为 `origin/<b>`，而是按**解析链**求本地 ref——① 显式 `--from/--target/--onto` → ② 组声明的 `baseRef` → ③ 仓库默认分支（`origin/HEAD` 只读推导）的**本地同名 ref** → ④ 当前 HEAD → ⑤ 全失败则报错要求显式指定（**绝不猜**）。任何操作路径都不隐式 fetch；远端只作只读提示，且需显式请求才刷新。

Worktree 组（多分支批量）
------------------------

一个**显式声明的固定花名册**（组 = 成员名列表 + 组目标分支 + 合并策略 + env 策略），把「多个固定 worktree 分支并行开发 → 一键批量合并回集成分支」这套流程自动化。三条动作**互相独立**：

- **组创建**：只补建尚无 worktree 的成员（已有的一律不动），基点取**本地**目标分支，env 策略一次应用到全批。
- **组合并**：按花名册顺序逐成员「变基到目标分支 → 合入 → 提交」——**每个成员 = 目标分支 1 个提交**（相对目标分支已无领先提交的成员会被**跳过**，故重跑同一条命令天然幂等）；**fail-fast**：某成员失败即停止，已完成的保留在目标分支上，失败成员停在冲突态，解决后**重跑同一条命令即可续完剩余**（绝不跳过失败成员继续）。
- **组同步**：把成员对齐到目标分支（**非破坏性**，不丢未合入提交）。

**收尾对齐分两阶段**：① 每个成员合入成功后**立即**对齐到「当时」的目标分支（防止下一轮变基重放已 squash 的内容而出现假冲突），当前会话所在成员跳过；② 整批完成后**再问一次**是否把本轮已合入成员统一对齐到最终目标分支（各成员基线版本本就不同）。

**组只在仓库级生效**：声明写在 `<repoRoot>/.pi/extensions-data/pi-worktree/config.json`（`repoRoot` 从 `--git-common-dir` 推导，不是会话 cwd）。用户级同名字段会被**忽略并告警**，不静默生效。

**两个守卫**：**目标检出处于 merge 进行中 → 拒绝执行**；**脏成员不参与合并**（面板灰显禁选 + 执行层拒绝；插件自己 symlink 进来的 `.pi`/`.env*` 已登记进本地 exclude，**不会被算作脏**，见下节）。主检出的**未提交改动不作为拒绝理由**——`execMerge` 内部会 `stash push` → 合并 → `stash pop`，实测已暂存的在途改动不会被卷进 squash 提交（回归保护见 `test/vitest/extensions/worktree-group-ops.test.ts` 的「已暂存改动不会被卷进 squash 提交」用例）。

**过程日志（可观测）**：批量动作**逐成员**输出 `STEP_BEGIN` / `STEP_OK` / `FAIL_MARKER` 到 `.pi/logs/pi-worktree_*.log`（`FAIL_MARKER` 带 `member=<名>` 与单行 `reason=<原因>`），失败时可直接 grep 出卡在哪位成员、耗时多少。e2e 对这两类日志有**硬断言**（`test/e2e/extensions/worktree/tui-expect.smoke.test.sh` 的组用例）。

声明示例：

```jsonc
// <repoRoot>/.pi/extensions-data/pi-worktree/config.json
{
	"groups": {
		"fta": {
			"baseRef": "dev", // 缺省走基点解析链
			"members": ["bugfix", "context", "security"],
			"mergeStrategy": "squash", // N 成员 = N 提交
			"env": { "nodeModules": "copy" }, // cp -al：省盘 + 本地包解析到本 worktree
		},
	},
}
```

合并（merge）语义
-----------------

- **纯本地合并**：`/worktree merge --source <n> [--target b]` 执行 `checkout target → merge source → checkout 回原分支`，**不自动拉取远端**。
- **合并前**：确认面板显示「本地 target 落后远端 N 提交」（基于**已有** remote-tracking ref 计算、**不联网**；无远端不显示、失败静默。要看最新差距请先自行 `git fetch`，或用面板的「拉取最新」）。
- **合并成功后**：面板提示同步差距 + 非首位的「拉取最新」选项，方便用户在 push 前决定是否先同步。
- **失败面板**：非冲突失败（checkout 失败、工作区脏等）弹出处理面板：原因分类 + 可执行建议，选项依次为「让 Agent 处理」/「重试合并」/「打开终端手动处理」/「拉取最新后重试（非首位）」/「关闭」。
- **让 Agent 处理**：以三段式 prompt 委托 agent——① 合并建议原则（本地优先、保留双方意图、完成后跑检查、不执行不 push）② 当前准确情况（失败命令、错误详情、分支拓扑、本地/远端落后差距）③ 任务（给出建议的操作命令步骤）。agent 只做参谋，命令由用户执行。参照 review 插件的 RUBRIC + 动态信息组合模式。
- **push 提示**：合并成功后插件只提示"已合并到 target，可 push"，不执行 push。

> 详细交互设计见 AGENTS.md 与 `skills/worktree/SKILL.md`。

Worktree 环境设置（symlink 与本地 exclude）
------------------------------------------

创建 worktree 时按 env 策略 symlink `.pi` / `.env*` 等（`symlinkTargetIds` 默认 `['husky','pi','node_modules']`）。
这些目标是**符号链接**，而 `.gitignore` 里常见的 `.pi/`（带尾斜杠）只匹配目录、**匹配不到符号链接**——
于是成员里会出现 `?? .pi` → `getDirtyCount > 0` → 成员被判为「脏」→ 组的合并/同步在候选层被锁死。

因此插件在**创建 symlink 之后**会把路径登记到**仓库本地 exclude**（`.git/info/exclude`，未跟踪、只影响本地）：

- 已被现有规则忽略的路径**不登记**（`.gitignore` 写对时不留冗余条目）
- 重复调用**幂等**，不重复写入
- 只影响 git 的「未跟踪」判定，**不改 `.gitignore`**（不产生仓库文件改动）

> 实现：`lib/setup.ts` 的 `ensureLocalExclude()`；回归保护：`test/vitest/extensions/worktree.operations.test.ts`
> 的「插件 symlink 的本地 exclude」套件（分别锁定 `.pi/` 修复与「不产生冗余条目」）。

快速参考
--------

```bash
/worktree create [--name <n>]            # 创建 worktree（分支 wt/<name>）
/worktree use <name>                     # 会话切换到 worktree cwd
/worktree sync <name>                    # 同步到上游最新（= rebase 别名，本地操作）
/worktree merge --source <n> [--target b] [--strategy merge|squash|rebase-ff]
/worktree clean [--dry-run]              # 清理已合并 worktree
/worktree delete <name>                  # 单个删除

/worktree group list                     # 列出所有组（成员状态 + 目标分支）
/worktree group create <组>              # 只补建缺失成员
/worktree group merge  <组>              # 批量合并（按花名册顺序，fail-fast 可续跑）
/worktree group sync   <组>              # 全组对齐到目标分支（非破坏性）
/worktree group new                      # 建组向导（TUI；= 面板里按 G）
/worktree group edit <组> / delete <组>  # 改组 / 删除组声明

# 组动作可显式收窄范围（缺省 = 全部未锁定候选）
/worktree group merge <组> --members a,b
```

> **TUI 是主入口**：`/worktree` 面板一级列表分 `Groups` 段（在上）与 `Worktrees` 段；Enter 进组菜单（合并/创建/同步/编辑/删除），`G` 直接开建组向导；执行前有候选**多选确认面板**（脏/无提交/不存在的成员灰显禁选）。不改动任何全局快捷键。

日志与排查
----------

组动作会写 `info` 级过程日志（`group action start` / `group action done` / `group saved` / `aligned member to base` 等），落盘位置由 pi-logger 配置决定（appender `path: ./.pi/logs` 是**相对于 pi 进程 cwd**；在 TUI e2e 沙箱里即 `<测试仓库>/.pi/logs/pi-worktree_<日期>.log`）。

> 注意：pi-logger 的 FILE appender 在**进程退出时**刷盘；进程被强杀或未走完退出流程时，最后几行可能缺失。
> �；进程被强杀或未走完退出流程时，最后几行可能缺失。
