# pi-worktree v2：硬约束切换器

## 设计目标

从"prompt 软约束"改为"cwd 硬约束"——模型无法绕过，工具层根目录即为 worktree。

## 机制核心

切换 worktree = `ctx.switchSession()` 切到 cwd 为 worktree 的会话文件。Pi runtime 用新 cwd 重建，bash/read/write/edit 全部以 worktree 为执行根，不再注入任何 prompt DIRECTIVE。

## 路径体系

| 身份            | 路径                                                       | 推导方式                                      |
| --------------- | ---------------------------------------------------------- | --------------------------------------------- |
| main checkout   | `/path/to/<repo>/`                                         | 默认当前 cwd                                  |
| worktree 目录   | `/path/to/<repo>-worktrees/<name>/`                        | `<repo> 的父目录/<repo 名>-worktrees/<name>/` |
| worktree `.git` | 文件，内容 `gitdir: /path/to/<repo>/.git/worktrees/<name>` | `git worktree add` 自动处理                   |

任意 cwd 推导主仓库：`git rev-parse --path-format=absolute --git-common-dir` → main 的 `.git` → `dirname()` → 主仓库根。

枚举 worktree：在主仓库 `git worktree list --porcelain` 列所有路径。

## 活跃 worktree 推导

单一事实来源 = `ctx.cwd`：

```
cwd 是否是 <worktreeRoot>/<name>/ 的子路径？
  ├─ 是 → 活跃 worktree = <name>（从路径提取）
  └─ 否 → 活跃 = "main"（正常仓库根目录）
```

不再需要 `state.ts` 的 activeWorktree 持久化。`state.ts` 瘦身为偏好配置（widget 可见、上次 node_modules 策略）。

## 会话存储策略

所有会话统一存放在 **main 仓库的 session 目录**中：

```
~/.pi/agent/sessions/<encoded-main-repo-path>/
├── <sessionId-a>.jsonl    ← main checkout 的会话
├── <sessionId-b>.jsonl    ← main checkout 的会话
└── <sessionId-c>.jsonl    ← worktree (Aries-Hamal) 的会话
```

worktree 的会话创建通过 `SessionManager.create(worktreeCwd, mainSessionDir)` 实现——header cwd 写 worktree 路径、磁盘文件存在 main 的 session 目录。

效果：

- `ctx.switchSession()` 切换到 worktree 会话 → cwd 变成 worktree 路径
- 删除 worktree 目录后，这些会话文件仍在 main 的 `/resume` 列表里可查
- Pi 自带 cwd 缺失兜底（`MissingSessionCwdError` → 提示后继续使用当前 cwd）
- 删除逻辑绝不触碰 `~/.pi/agent/sessions/`

项目信任：worktree cwd 在 repo 外，首次切入触发 `project_trust`。本插件（user 级，trust 前已加载）监听该事件，对 `git worktree list` 验证过的路径自动批准，无感切换。

## 文件级设计

### 新增文件

| 文件             | 职责                                                                                                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/session.ts` | 会话切换层。`switchTo(repoRoot, target)`：`create`/`forkFrom` + `ctx.switchSession()` 的封装。`resolveSessionDir(repoRoot)`：取 main 会话目录。                                     |
| `lib/paths.ts`   | 纯函数路径推导。`getRepoRoot(cwd)`、`getWorktreesDir(repoRoot)`、`getWorktreePath(repoRoot, name)`、`isWorktreeCwd(cwd, repoRoot)`、`getNameFromCwd(cwd, repoRoot)`。单元测试主力。 |

### 保留/重写文件

| 文件              | 变化                                                                                                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`        | 删 `before_agent_start`（DIRECTIVE 注入）。删 4 个工具（get_worktree_paths/create/stop/attach/detach）。注册新命令处理器。注册 `project_trust` 自动批准。注册 widget。 |
| `lib/handlers.ts` | 按新语义重写。`handleCreate`/`handleUse`/`handleDelete`/`handleList`/`handleMerge`/`handleClean`/`handleShell`。stop/mode/attach/detach 全删。                         |
| `lib/ui.ts`       | 主面板重写为切换器。force 删除弹窗。切换时会话策略询问。创建时 node_modules 策略选择。                                                                                 |
| `lib/worktree.ts` | `createWorktree`/`removeWorktree`/`deleteWorktreeBranch` 改用外部路径 + 路径断言守卫。`getExistingWorktrees` 从 `git worktree list --porcelain` 读取。                 |
| `lib/git.ts`      | 删 hub 发现 + 缓存。改单 repo 定位 + 状态采集（dirty/merged/ahead/behind）。                                                                                           |
| `lib/setup.ts`    | 加 nodeModules 三策略（symlink / cp-al / install）处理函数。`.env*` symlink 保留。                                                                                     |
| `state.ts`        | 缩为偏好：widgetHidden、lastNodeModulesStrategy。存 `~/.pi/agent/extensions-data/pi-worktree/prefs.json`                                                               |
| `types.ts`        | 精简类型定义。删 SetupConfig(background 等未用字段)、WorktreeState。                                                                                                   |
| `stars.ts`        | 不变。                                                                                                                                                                 |

### 删除

- `lib/setup.ts` 的 `autoInstall`（被 nodeModules 策略替代）、`runRepoSetup` 的 background 分支
- `state.ts` 的 activeWorktree/activeWorktreePaths/worktreeMode/clearActiveWorktree/addWorktreePath 等——全部从 cwd 推导
- `.pi/worktree-sessions/` 状态文件不再读写

## 命令体系

### 保留的命令

| 命令                                   | 行为变化                                                |
| -------------------------------------- | ------------------------------------------------------- |
| `/worktree`（无参数）                  | 打开切换器面板（不再是功能菜单，而是列表+操作）         |
| `create [--name <n>] [--branch <b>]`   | 交互模式（TUI）时弹 node_modules 策略选择。路径变外部。 |
| `use <name>`                           | 切到 worktree 或 main。TUI 下按 Enter 等同于 use。      |
| `delete <name>`                        | 强制删除保护二级确认。                                  |
| `list`                                 | 从 `git worktree list` 读取。                           |
| `merge --source <name> [--target <b>]` | 不变。                                                  |
| `clean`                                | 不变。                                                  |
| `shell`                                | 不变。                                                  |
| `widget [on\|off]`                     | 不变。                                                  |

### 删除的命令

| 命令                       | 原因                                            |
| -------------------------- | ----------------------------------------------- |
| `stop`                     | 不再需要——切回 main = `use main`。              |
| `mode [on\|off]`           | 不再有"软约束模式"，worktree 模式始终是硬约束。 |
| 未写明的 `attach`/`detach` | hub 模式删除后无用。                            |

## TUI 交互流程

### 切换器面板（`/worktree` 无参数）

```
 pi-worktree                          cwd: Aries-Hamal
──────────────────────────────────────────────
  Name            Branch        Status        Repo
 ──────────────────────────────────────────────
  main            main          clean
 > Aries-Hamal    wt/Ar...      dirty(3)      ↑2
   Leo-Denebola   wt/Le...      clean         merged
──────────────────────────────────────────────
 [Enter] 切换  [f] fork切换  [c] 新建  [d] 删除
 [m] 合并  [s] shell  [q] 退出
```

- 每行显示：名称、分支、dirty 状态（文件数）、ahead 数
- `>` 标记当前 cwd 所在
- `[legacy]` 标记 `.worktrees/` 内——实际不会出现（无 legacy）
- **Enter** → 选了 main 或非当前 worktree → 弹询问框：`[恢复最近会话] / [新开会话] / [取消]`（即你选的"每次询问"）
- **f** → fork 当前对话带过去，不额外询问
- **c** → 自动生成/输入名称 → 弹 node_modules 策略选择器（上次选择高亮）→ 创建 → 立即切入
- **d** → 删除流程
- **m** → merge 当前 worktree 到 main

### 删除流程

```
1. 选择 worktree（若从面板则已选）→ TUI 确认："确定删除 [name]？"
   ├─ 确认 → git worktree remove <路径>（不带 force）
   │   ├─ git 成功 → 询问分支处理：
   │   │   ├─ 分支已合并 → 自动删本地/远程分支
   │   │   └─ 分支未合并 → 弹框："分支有未合并提交"
   │   │       [d] 仍删除分支  [k] 保留分支  [c] 取消
   │   └─ git 拒绝(dirty/untracked) → 二级弹窗：
   │       ╔═══ Force delete "[name]"? ═══╗
   │       ║  Git 拒绝：有未提交/未跟踪文件 ║
   │       ║  <dirty 文件预览，最多 8 行>  ║
   │       ║                               ║
   │       ║  [f] Force remove             ║
   │       ║      丢弃所有未提交/未跟踪改动 ║
   │       ║      仅在确认不需要时使用      ║
   │       ║  [c] 取消                      ║
   │       ╚═══════════════════════════════╝
   │       → 确认才加 --force
   └─ 取消 → 返回
```

### 安全守卫（一并实现）

1. **删除路径断言**：`removeWorktree` 前置断言——目标 path 必须以 `<worktreesRoot>/` 为前缀且不是 main 根。不符合则抛异常不执行。
2. **自删除保护**：若当前 cwd 在被删 worktree 内 → 先 switchSession 切回 main，再执行删除。
3. **会话文件保护**：删除逻辑绝不触碰 `~/.pi/agent/sessions/`。

## 创建自动化（vibecoding 细节）

### node_modules 策略（每次 TUI 询问）

用户在新建时从选择器选一个，选择器记住上次选择为默认高亮：

| 策略      | 实现                                           | 适用场景                  |
| --------- | ---------------------------------------------- | ------------------------- |
| `symlink` | `ln -sf ../../node_modules <wt>/node_modules`  | 纯依赖不跨 branch 变化    |
| `copy`    | `cp -al <main>/node_modules <wt>/node_modules` | pnpm/yarn 的 symlink 农场 |
| `install` | `(cd <wt> && npm install)`                     | 各 branch 依赖不同        |
| `none`    | 什么都不做                                     | node 项目以外的场景       |

### 环境文件

`.env*` 保持默认 symlink（`setup.ts` 现有行为），不需每次询问。

### runRepoSetup

现有 `.pi/worktree-setup/<repo>.sh` 机制保留。创建时若存在则执行。background 选项删除。

## 测试设计（TDD）

作为设计的规范，测试先行。按三层设计：

### 第一层：Vitest 单元测试 — 纯函数

**目标文件：`test/vitest/extensions/worktree.test.ts`**

测试纯逻辑函数，无需 pi runtime，不建沙箱。

```typescript
describe('paths — getRepoRoot', () => {
	it('returns parent of shared git dir', () => {
		/* 模拟 git 输出 */
	});
	it('returns null when not in a git repo', () => {
		/* ... */
	});
});

describe('paths — getWorktreesDir', () => {
	it('returns <repo>父目录/<repo名>-worktrees/', () => {
		/* ... */
	});
});

describe('paths — isWorktreeCwd / getNameFromCwd', () => {
	it('detects worktree cwd and extracts name', () => {
		/* ... */
	});
	it('returns false for main cwd', () => {
		/* ... */
	});
});

describe('paths — delete path safety assert', () => {
	it('allows path inside worktrees dir', () => {
		/* ... */
	});
	it('rejects path pointing to main repo root', () => {
		/* ... */
	});
	it('rejects path outside worktrees dir', () => {
		/* ... */
	});
});

describe('worktree — getManagedWorktrees (from git worktree list)', () => {
	it('parses porcelain output', () => {
		/* mock execSync */
	});
	it('filters out main checkout', () => {
		/* ... */
	});
	it('filters out non-managed worktrees (outside our dir)', () => {
		/* ... */
	});
});

describe('session — resolveSessionDir', () => {
	it('returns main git repo default session dir', () => {
		/* ... */
	});
});

describe('session — sessionKeyForWorktree', () => {
	it('produces deterministic key from repo root + name', () => {
		/* ... */
	});
});
```

### 第二层：Vitest 集成测试 — 沙箱 pi runtime

**目标文件：`test/vitest/extensions/worktree.smoke.test.ts`**

使用现有的 sandbox helper 创建临时 git 仓库 + mock-llm + pi 进程运行。

```typescript
describe('worktree extension — smoke', () => {
	let sandbox: string;
	let mainDir: string;
	beforeAll(() => {
		/* git init + sandbox */
	});
	afterAll(() => {
		/* cleanup */
	});

	it('loads without crash', async () => {
		const r = await runPi(sandbox, {
			prompt: 'call the worktree list tool',
		});
		expect(r.exitCode).toBe(0);
	});

	it('create worktree and verify directory exists', async () => {
		// 调 /worktree create → 验证上面产生 worktree 目录和 git worktree list 包含它
	});

	it('delete worktree removes directory', async () => {
		// 创建 → 删除 → 验证目录消失
	});

	it('force delete when dirty shows confirmation', async () => {
		// 创建 → 在 worktree 里改文件 → 删除（dirty）→
		// skip: 确认弹窗在 print 模式下自动确定，验证 force 标志传递
	});
});
```

### 第三层：E2E bash 测试

**目标文件：`test/extensions/worktree/smoke.test.sh`**

测试 `run_pi_and_check` 无法覆盖的流程（true 会话切换、cwd 变化）。

```bash
# 测试场景 1：创建 → use → 验证 cwd 实质变化
#   使用 mock-llm，通过工具 verify cwd（在 worktree 中 pi 的 cwd 等于 worktree 路径）
#   验证：创建后 enter(use) → 代理报告的 cwd 包含 worktree 名称

# 测试场景 2：切回 main
#   从 worktree use main → 验证 cwd 回到 main 目录

# 测试场景 3：删除当前所在 worktree（自动切回 main 再删）
#   创建 → use → 删除（触发自动切 main）→ 验证 cwd = main

# 测试场景 4：force delete dirty worktree
#   创建 → 在 worktree 里 touch 新文件 → 删除拒绝 → force 确认 → 删除成功

# 测试场景 5：会话文件位置验证
#   创建 → use → 记录 session 文件位置 → 验证它在 main session 目录下
```

### TUI 测试

**目标文件：`test/extensions/worktree/tui.smoke.test.sh`**

现有 TUI 测试框架：

```bash
# 场景 1：切换器面板渲染
#  /worktree → 验证列表包含 main + 各 worktree

# 场景 2：切换询问框
#  选中 worktree → Enter → 验证弹出恢复/新建选择

# 场景 3：创建时 node_modules 策略选择器
#  /worktree create → 验证出现 symlink/copy/install/none 选择
```

---

_本方案是对应于以下决策的实现版本：单 repo、repo 外 worktree、切换/创建时 TUI 询问、无 legacy 兼容。_
