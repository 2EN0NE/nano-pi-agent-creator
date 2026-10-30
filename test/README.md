# Test Infrastructure

本仓库采用双层测试架构：**Vitest 单元/组件测试** + **bash 集成 e2e 测试**。

## 目录结构

```
test/
├── vitest/                              # Layer 1: 单元 + 组件测试（headless / mock）
│   ├── extensions/                       # 每个扩展的 vitest 测试
│   │   ├── pi-logger.test.ts
│   │   ├── pi-session-tree-*.test.ts
│   │   └── ...
│   ├── helpers/
│   │   ├── sandbox.ts                    # 沙箱管理 + pi 执行
│   │   └── tui-runner.ts                 # node-pty TUI runner
│   └── experiments/                     # POC 测试（非正式）
│
├── e2e/                                 # Layer 2: 集成 e2e 测试（真实 Pi，仅 mock LLM）
│   ├── extensions/                       # 每个扩展的 bash 测试
│   │   ├── pi-logger/
│   │   │   ├── smoke.test.sh            # print 模式
│   │   │   ├── tui-expect.smoke.test.sh # TUI 模式（expect，推荐）
│   │   │   └── tui-integration.test.exp # TUI 模式（独立 expect 脚本）
│   │   └── ...
│   ├── skills/                           # 每个技能的 bash 测试
│   │   └── e2e-test/
│   │       └── smoke.test.sh
│   ├── helpers/
│   │   ├── mock-llm.ts                   # Mock LLM 扩展（唯一允许的 mock）
│   │   ├── tui-functions.sh             # TUI 测试辅助函数
│   │   └── tui-layout-helper.ts
│   └── scripts/
│       └── run-e2e.sh                    # 主 e2e 运行器
│
├── results/                              # 测试结果输出（gitignored）
│   └── <timestamp>/
│       ├── summary.md                    # 全局汇总
│       └── extensions/<name>/summary.md  # 模块级汇总
│
└── README.md                             # 本文件
```

## 分层设计

```
test/vitest/  — 单元 + 组件测试（headless）
    Mock:  MockTerminal, 内存 sessionManager, 手造 annotate, mock keybindings
    目标:  快速验证逻辑正确性（渲染布局、API 生命周期、handleInput 调用）
    时长:  <30s，每次 commit 运行
    约束:  不测 Pi runtime 行为（pi.appendEntry / pi.setLabel / 真实 key dispatch）

test/e2e/     — 集成端到端测试（真实 Pi 进程）
    Mock:  仅 LLM API（mock-llm）
    目标:  验证扩展在真实 Pi 进程中的行为
    时长:  **硬预算 ≤5min/插件**（默认 300s，超预算判失败），CI + 提交前手动运行
    约束:  每个测试只 mock 大模型服务商，其他 Pi API 均走真实路径
```

> **铁律**：`test/e2e/` 下的所有测试，如果 mock 了 LLM 以外的任何 Pi API（sessionManager、annotate、keybinding），视为不合规。

详见 ADR：[`docs/adr/0004-tui-e2e-layered-testing.md`](../docs/adr/0004-tui-e2e-layered-testing.md)。

## 耗时预算与过程日志（必读）

**单插件 e2e 总耗时硬预算 300s，超出即判失败**——要么用例挂起/等待异常，要么用例冗余需精简。
完整规范见 [`docs/e2e-performance.md`](../docs/e2e-performance.md)。

| 关注点             | 怎么用                                                                                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 预算覆盖           | `E2E_EXT_BUDGET_SEC=600` 或 `--ext-budget 600`；`0` = 禁用（仅排障）                                                                                |
| 插件级例外         | `test/e2e/budget-overrides.conf`（`type/name=秒`，须写理由）；临商用 `E2E_EXT_BUDGET_OVERRIDES`                                                     |
| 排除模块           | `--exclude worktree,permission-gate`（全量/shard 模式跳过；已有专用 CI job 覆盖的模块用它去重）                                                     |
| CI 分片            | `--shard N/8`：按**模块名 hash** 分桶，**不维护硬编码模块清单**（新增模块必然落在某个 shard）；CI 上 `E2E_BUDGET_STRICT=1`，超预算**不降级**为 WARN |
| 看耗时             | `summary.md` → `## Time Budget`；`summary.json` → `cases[].duration_seconds`、模块 `duration_seconds`                                               |
| 超时定位           | 用例 TUI 日志里最后一条 `[tui-stage]`（`expect-start` / `pi-ready-raw` / `pi-ready` / `commands-done`）                                             |
| 合并用例的步骤轨迹 | `STEP_BEGIN` / `STEP_OK` / `FAIL_MARKER step=<id> reason=<...>`                                                                                     |
| 结果统计           | 文件驱动 `.results/<type>__<name>.tsv` → 主流程 `aggregate_results()`（**不得**依赖跨子 shell 内存变量）                                            |

> **两条最容易踩的坑**（都表现为"每用例白等几十秒"，已修）：
> ① 就绪检测不要依赖状态栏正则（`expect <file>` 路径不匹配 → 白等 `timeout_seconds`）；
> ② 收尾前要关覆盖层（`ESC`），否则 `/quit` 被吞 → 白等收尾超时。

## 使用方法

### Vitest 测试（Layer 1）

```bash
npm test                 # 运行一次
npm run test:watch       # 监听模式
npm run test:ci          # CI 模式（JUnit XML）
```

### bash e2e 测试（Layer 2）

```bash
# 运行指定模块
bash test/e2e/scripts/run-e2e.sh --ext pi-logger
bash test/e2e/scripts/run-e2e.sh --skill e2e-test

# TUI 模式测试
bash test/e2e/scripts/run-e2e.sh --ext quit --tui

# CI 模式（自动注入 mock-llm，无需 API Key）
CI=true bash test/e2e/scripts/run-e2e.sh --ext pi-logger
```

### 查看结果

```bash
LATEST=$(ls -1t test/results/ | head -1)
cat test/results/$LATEST/summary.md
cat test/results/$LATEST/extensions/pi-logger/summary.md
```

运行基座的留痕位置（ADR-0063；**只留痕、不作阻塞断言**）：

| 看哪儿                 | 内容                                                          |
| ---------------------- | ------------------------------------------------------------- |
| `summary.json`         | `pi_version`（本轮实际跑的 pi 版本）、`pi_path`（二进制路径） |
| e2e runner 启动横幅    | `pi runtime base: <版本> (<路径>)`                            |
| vitest TUI 用例 stdout | `[pi-bin] <路径> → <版本>`（`resolvePiBin()` 的解析结果）     |

基座来源：`npm ci` 装出的 lock 版本（`scripts/setup-ci.sh` 以它为唯一来源全局安装；
`PIPELINE=<版本>` 仅为**显式覆盖开关**）。vitest 侧默认优先 `<repo>/node_modules/.bin/pi`，
`PI_BIN` 仍是最优先级——想刻意用全局新版跑一次就设 `PI_BIN="$(command -v pi)"`。

## Mock 边界

### Layer 1 (vitest) 允许的 mock

- `MockTerminal` / `InteractiveMockTerminal`（替代真实终端）
- 内存版 sessionManager / annotate
- mock keybindings / theme
- mock LLM（`registerFauxProvider()`）

### Layer 2 (e2e) 允许的 mock

- **仅 LLM**：`test/e2e/helpers/mock-llm.ts` 提供的 `mock-llm` 扩展

### CI 模式

`CI=true` 时自动注入 mock-llm（无需 API Key），并启用**阻塞式**判定：

- **耗时预算**：CI 各 e2e job 设 `E2E_BUDGET_STRICT=1` —— 超过插件预算**判失败**，不因机器负载降级为 WARN。
- **分片矩阵**：`ci.yml` 的 `e2e` job 跑 `--shard N/8 --exclude worktree,permission-gate,org`；被排除的三个模块各有专用 job
  （`e2e-worktree` / `e2e-permission-gate-smoke` / `e2e-org`+`e2e-org-tui`），**改分片策略时不得引入硬编码模块清单**（否则新模块会静默无覆盖）。
- **本地对齐**：pre-push 只跑变更模块；若变更的是 `test/e2e/scripts/*` 或 `test/e2e/helpers/*`（影响所有模块），
  额外跑 `--shard 0/8` 当金丝雀（全量交给 CI）。

### 压缩/继续类集成链路必须用 TUI 模式验证

`ctx.compact()` 是 fire-and-forget：`--no-session` 下 pi 处理完 prompt 立即退出，
摘要→onComplete 异步链来不及完成，只能验证「触发信号」而无法确定性验证
压缩完成 + auto-continue。验证「压缩成功 → 后续动作（如 auto-continue）→ 新 turn」
这类链路，必须用 `pi -a`（TUI 交互模式，pi 不退出）。

同时注意：Pi 的 `prepareCompaction` 以 `keepRecentTokens=20000` 从后往前累积找
切分点，单条超长 user 消息会把切分点顶到第一条消息（报 "Nothing to compact"）。
需多条 user 消息（每条 <20000 tokens，累积 >20000）才能让切分点落在中间。

完整用例参考 `test/e2e/extensions/custom-compaction/tui-expect.smoke.test.sh`
的「invisible continue full chain」。

## 编写测试

### Vitest 测试

```typescript
import { describe, it, expect } from 'vitest';
import {
	MockTerminal,
	renderToSnapshot,
	dispatchInput,
	stripAnsi,
	assertWithinWidth,
} from '../../src/tui-testing/index.js';
import { TUI } from '@earendil-works/pi-tui';

describe('MyPanel TUI', () => {
	it('不超宽', () => {
		const tui = new TUI(new MockTerminal(80, 24));
		tui.addChild(new MyPanel());
		const snapshot = renderToSnapshot(tui, 80, 24);
		assertWithinWidth(snapshot, 80);
	});
});
```

### bash e2e 测试

```bash
test_describe "my-extension"

test_it "loads without errors" <<'TEST'
  run_pi_and_check \
    --extensions "pi-logger,my-ext" \
    --prompt "hi" \
    --expect-no-error
TEST
```

## Git Ident 注入约定

测试沙箱里的 `git commit` / `rebase` / `merge` 需要明确的 user 身份。统一约定：**只用环境变量无条件覆盖**，禁止在测试里写 `git config user.name/email`（local 或 global）。

**根因**：e2e 测试给 pi 进程隔离 HOME（`HOME="$isolated_home"`），`git config --global` 写在真实 `~/.gitconfig` 里、对隔离 HOME 的进程不可见 → `empty ident`。而 `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` / `GIT_COMMITTER_NAME` / `GIT_COMMITTER_EMAIL` 这四个环境变量优先级高于 git config、且不依赖 HOME，能穿透隔离，对 bash 脚本、node 进程、被隔离 HOME 的 pi 进程统一生效。

**两个注入点**：

| 层          | 注入点                           | 方式                                                                    |
| ----------- | -------------------------------- | ----------------------------------------------------------------------- |
| e2e（bash） | `test/e2e/scripts/run-e2e.sh`    | 顶层 `export GIT_*`（无条件覆盖）                                       |
| vitest      | `test/vitest/setup/git-ident.ts` | `process.env.GIT_* = ...`（经 `vitest.config.ts` 的 `setupFiles` 加载） |

**统一身份值**：`CI Bot <ci@nano-pi-agent-creator.invalid>`（`.invalid` 是 RFC 2606 保留域名，声明非真实邮箱）。

**写测试时**：直接 `git commit`，不要 `git config user.*`，也不要给 `execSync`/`spawnSync` 传 `env: {...GIT_*...}`——环境变量已由注入点统一提供。

## TUI 模式测试

所有 TUI e2e 测试统一使用 **expect** 作为 PTY 后端。

> **本地排障：`posix_spawnp failed`**（vitest TUI 用例全红，连 `/bin/echo` 都 spawn 不了）＝ `node-pty` 的
> `prebuilds/<platform>-<arch>/spawn-helper` 丢了可执行位（`npm ci` / `npm i` 解包后常见）。修复：
> `chmod +x node_modules/node-pty/prebuilds/$(node -p "process.platform+'-'+process.arch")/spawn-helper`，
> 或 `npm rebuild node-pty`。**与被测 pi 版本无关**（CI 由 `scripts/setup-ci.sh` 的 rebuild 步骤兜住）。

### 两种测试模式

| 模式 | 函数              | 适用场景                          | 文件                       |
| ---- | ----------------- | --------------------------------- | -------------------------- |
| bash | `tui_expect_test` | expect 驱动 bash 测试（推荐）     | `tui-expect.smoke.test.sh` |
| 独立 | 独立 `.exp` 脚本  | 复杂交互（多轮 expect/send 闭环） | `tui-integration.test.exp` |

> **`tui_run_pi_test` 已废弃**：原 script+heredoc 函数保留但不再用于新测试。所有 TUI 测试已迁移至 expect。

### bash 测试（tui_expect_test）

```bash
test_it "loads in TUI mode without crash" <<'TEST'
  tui_expect_test "pi-logger,my-ext" '
    send "/command\r"
    sleep 3
  ' 15
  if [[ "$TUI_EXIT_CODE" -eq 0 ]]; then
    echo "PASS"
  fi
  tui_assert_contains "expected text"
  tui_cleanup
TEST
```

### 交互测试（tui_expect_test）

```bash
test_it "opens panel and responds to keys" <<'TEST'
  tui_expect_test "pi-logger,my-ext" '
    send "/command\r"
    sleep 1
    expect -re {Panel Title} { }
    send "m"
    sleep 0.3
    expect -re {Marked} { }
    send "\033"
  ' 15
  tui_cleanup
TEST
```

### 集中式长树测试（重前置场景）

当多个交互都依赖**相同的重前置**（如构造 20 条消息的长会话树，每个进程都要重发一遍），
应合并到**单个 pi 进程**，共享一次前置构造，避免重复支付固定等待。

参考实现：`test/e2e/extensions/pi-session-tree/tui-expect.smoke.test.sh` 的
`consolidated long-tree panel interactions` 用例（8 个交互合并，~85s，替代原 8×~30s）。

**失败定位约定**（合并用例内必须遵守）：

```tcl
proc fail {step reason} { puts "FAIL_MARKER step=$step reason=$reason"; exit 1 }
proc step_begin {id name} { puts "STEP_BEGIN $id $name" }
proc step_ok   {id name} { puts "STEP_OK   $id $name" }
```

- 每个交互前后输出 `STEP_BEGIN <id> <名称>` / `STEP_OK <id> <名称>`
- 断言失败统一走 `fail <id> <原因>`（输出 `FAIL_MARKER step=<id> reason=<原因>` 后退出）
- bash 层 `TUI_EXIT_CODE != 0` 时 grep `FAIL_MARKER` + 末尾可见输出，直接定位失败步骤

**日志搜集位置**（每次运行自动持久化到 `test/results/<ts>/extensions/<name>/cases/`）：

| 日志            | 路径                   | 内容                                          |
| --------------- | ---------------------- | --------------------------------------------- |
| expect 完整输出 | `<NNN>-tui-output.log` | 全部 PTY 输出 + STEP/FAIL_MARKER 轨迹         |
| pi-logger 日志  | `<NNN>-logs/`          | 扩展自身 error/warn（按插件分文件）           |
| pi-tui 渲染诊断 | `render-*.log`         | `PI_TUI_DEBUG=1` 时的 diff 渲染帧（重影排查） |

## 结果解读

- **PASS** — 自动化断言通过
- **FAIL** — 自动化断言失败
- **[REVIEW]** — 需 AI 人工衡量（如渲染效果、超宽检测等）

`[REVIEW]` 数量 ≤20 时由 AI 逐条衡量，>20 时建议用户手动比对。
