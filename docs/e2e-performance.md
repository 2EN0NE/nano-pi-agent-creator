# e2e 性能与过程日志规范

> 适用范围：`test/e2e/`（bash/expect 集成测试）与 `test/scripts/*`、`test/e2e/helpers/*`。
> 配套：`test/README.md`（如何跑）、`docs/adr/0004-tui-e2e-layered-testing.md`（分层）。

## 1. 耗时预算：单插件 ≤ 5 分钟（硬门禁）

**约定**：一个插件的 e2e **总耗时**（该插件所有测试文件耗时之和）不得超过 **300s**。
超预算即**判失败**（runner 退出码非零，CI / pre-push / agent 都会被拦下）：

- 要么用例**挂起或等待异常**（应定位并修用例，不是放宽预算）；
- 要么用例**冗余**（重复覆盖 / 重前置重复支付），应精简或合并。

| 项         | 值                                                                        |
| ---------- | ------------------------------------------------------------------------- |
| 默认预算   | `300` 秒                                                                  |
| 覆盖       | `E2E_EXT_BUDGET_SEC=600 bash test/e2e/scripts/run-e2e.sh ...`             |
| 单独设置   | `bash test/e2e/scripts/run-e2e.sh --ext-budget 600 --ext foo`             |
| 禁用       | `E2E_EXT_BUDGET_SEC=0`（仅用于临时排障，不应用于日常验证）                |
| 单文件兜底 | 默认与预算同值：超时 worker 会被杀并在 `.budget-timeouts/` **留痕判失败** |

**在哪里看**：

- `test/results/<ts>/summary.md` → `## Time Budget` 节（每插件 Total / Verdict）
- `test/results/<ts>/summary.json` → `budget_seconds`、`budget_failures`
- `test/results/<ts>/<type>/<name>/summary.json` → `duration_seconds`（插件总耗时）、`budget_exceeded`
- 每个用例的耗时：模块 `summary.md` 表格 `Duration` 列、`summary.json` 的 `cases[].duration_seconds`，以及控制台 `→ PASS (12s)`

## 2. 耗时结构：先量再改

**实测数据（本地，2026-09）**：

| 阶段                    | 实测               | 说明                                                   |
| ----------------------- | ------------------ | ------------------------------------------------------ |
| pi 进程 init + 扩展加载 | **约 0.4s**        | `PI_TIMING=1` 内置计时（CLI 220ms + 扩展 200ms）       |
| TUI 就绪（修复前）      | **= timeout 参数** | 每用例白等 15s/45s（见 §2.1）                          |
| TUI 就绪（修复后）      | 3s + 1s 渲染余量   | 固定等待 + 崩溃探测                                    |
| 用例内等待              | 取决于用例         | 应使用 `wait_for` / `drain` 轮询到条件，而非长 `sleep` |
| 收尾（修复前）          | **= timeout 参数** | 覆盖层吞掉 `/quit` → 白等 8-30s（见 §2.2）             |
| 收尾（修复后）          | ≤ 8s（固定上限）   | 先 ESC 关覆盖层再 `/quit`                              |

> 结论：**TUI e2e 的耗时大头是"白等"，不是 pi 冷启动，也不是 jiti 编译。**
> 优化顺序：① 消除白等 → ② 合并同前置用例减少进程启动次数 → ③ 再谈其它。

### 2.1 就绪检测：不要依赖状态栏正则

**踩坑记录**：`tui_expect_test` 曾用
`expect { -re {\(auto\)|0\.0%/0} ... }` 判定 TUI 就绪。实测在 `expect <脚本文件>` 路径下
**该正则不会及时匹配**，每个用例都白等到 `timeout_seconds`：

| 用例 timeout 参数 | 实测 `[tui-stage] pi-ready-raw` |
| ----------------- | ------------------------------- |
| 15s               | +15s                            |
| 45s               | +45s                            |

而 `PI_TIMING=1` 显示 pi 自身 init 仅 0.4s —— 即**等待纯粹是浪费**。

**现行做法**（`tui-functions.sh`）：**读到「输出静默」为止**（`expect -re {.+} {exp_continue}` + 1s
timeout 判静默，上限 20s），随后做一次 eof 崩溃探测（判 126），再 `sleep 1` 首帧余量。实测就绪仅 **+1s**。

> ⚠️ **不要用裸 `sleep` 替代**：裸 sleep 只等待而不**读走**启动输出，残余输出会与用例随后发送的按键
> 交错，实测导致首条命令的 `Enter` 丢失（`/preset plan` 与下一条 `/tools` 合并成 `plan/tools`，
> 报 `未知预设 "plan/tools"`）。"读到静默"既快又能避免该竞态。

### 2.2 收尾：覆盖层会吞掉 `/quit`

面板/选择器/批准卡片打开时，`/quit` 被覆盖层当成输入 → pi 不退出 → 白等到收尾超时
（`exit=124` 被 runner 接受，所以**不报错但纯浪费**）。

**现行做法（两段式收尾）**：① 先直接 `/quit`，8s 内没退再走 ② —— 连发 3 次 `ESC`（每次间隔
0.6s）关覆盖层后重试 `/quit`（再给 10s）。既保证常见路径最快（pi 正常退出约 3s），又能兜住覆盖层场景。

> ⚠️ **ESC 与按键之间必须留间隔**：`ESC` 紧贴 `/` 会被转义序列吞掉，使 `/quit` 退化成普通文本
> `quit` 提交 → pi 不退出（实测踩坑：`pi-session-tree` consolidated 用例从 exit=0 变 exit=124）。

> 用例作者注意：**结束前自己关掉覆盖层**（`send "\033"`）仍然是好习惯——runner 的兜底只保证
> 不白等，但显式关闭能让收尾更快、日志更干净。

## 3. 过程日志规范（超时也能定位）

**目标**：任何一次超时/被 kill，都能从产物直接看到**卡在哪一步、等了多久**。

### 3.1 阶段计时（TUI 用例，自动）

`tui_expect_test` 在 expect 脚本里注入 `stage` proc，自动输出到用例 TUI 日志
（`cases/<NNN>-tui-output.log`）：

```text
[tui-stage] expect-start: +0s (cumulative 0s)
[tui-stage] pi-ready-raw: +3s (cumulative 3s)     ← pi 启动 + TUI 起来
[tui-stage] pi-ready: +1s (cumulative 4s)         ← 首帧渲染余量
[tui-stage] commands-done: +12s (cumulative 16s)  ← 用例交互完成
```

- 超时时：**最后一条 `[tui-stage]` 即卡点阶段**。`pi-ready-raw` 大 → 启动/环境问题；
  `commands-done` 大 → 用例内等待需优化或条件永不满足。
- 用例内可自行插入细粒度打点：在 expect 命令里写 `stage "after-open-panel"` 等。

### 3.2 合并用例的步骤轨迹

多个交互合并进一个 pi 进程时（见 §4），必须输出可定位轨迹：

```tcl
step_begin "03-jump" "g jump @~3:user"
step_ok "03-jump" "g jump @~3:user"
# 失败统一走： fail "03-jump" "reason"  → 输出 FAIL_MARKER step=03-jump reason=...
```

排查入口：`grep "FAIL_MARKER\|STEP_BEGIN" cases/<NNN>-tui-output.log`。

### 3.3 用例级耗时

runner 为每个用例记录耗时并输出：

- 控制台：`→ PASS (12s)`；模块尾：`⏱ Duration: 143s (… )`
- `summary.md`：`| # | Case Name | Status | Duration | Evidence |`
- `summary.json`：`cases[].duration_seconds`、模块 `duration_seconds`

**看耗时大户**：按 `summary.json` 的 `cases[].duration_seconds` 排序。

### 3.4 结果统计必须文件驱动（防假绿）

**踩坑记录**：串行路径一度把 `run_test_file` 放进子 shell 做超时保护，导致
`TOTAL_*` / `MODULE_RESULTS` 内存变量丢失 → 全局 `summary.json` 变成 `total: 0, modules: []`
且退出码恒 0（**用例全失败也假绿**）。

**现行约定**：每个测试文件把计数 **append 到文件**
`test/results/<ts>/.results/<type>__<name>.tsv`（append 单行，子 shell / 并行安全），
主流程 `aggregate_results()` 在主 shell 统一汇总。任何新增"结果统计"都**不得依赖跨子 shell 的内存变量**。

## 4. 并行化与依赖关系

### 4.1 现状

- **模块级并行**：runner 池化（`--pool N`，默认 CPU×2，上限 CPU×4）按
  `(type, module, test_file)` 任务并行，同一 shard 内互不相关。
- **模块内串行**：单插件（`--ext foo`）按文件顺序串行执行（便于读数与排障）。

### 4.2 单插件内的优化优先级

1. **同前置 → 合并到单进程**（收益最大）。多个交互都依赖相同重前置（如构造 20 条消息的长树）
   时，合并进一个 `tui_expect_test`，共享一次前置，用 §3.2 的 step 轨迹定位失败。
   参考：`test/e2e/extensions/pi-session-tree/tui-expect.smoke.test.sh`
   的 `consolidated long-tree panel interactions`。
2. **互不依赖 → 拆成独立文件**，可被池化调度并行（注意 §4.3 约束）。
3. **长等待 → 条件轮询**：用 `wait_for {标记}` / `drain` 代替 `sleep 20`；确认性等待必须
   有超时并判失败（不要静默继续）。

### 4.3 并行化约束（必须遵守）

- **HOME / cwd 隔离**：每个 `tui_expect_test` 自建沙箱（`$TUI_SANDBOX_ROOT/<slug>`，HOME 指向
  `$test_home/home`），因此**测试文件级并行是安全的**。
- **禁止跨测试文件共享可变状态**：`$HOME/.pi/agent/extensions-data/*/config.json`、
  固定路径的临时文件、固定端口等都会被并发执行污染。
- **mock-llm**：CI 模式自动注入；并发下各自进程独立，无需额外处理。
- **同模块多文件**在池化下可能并行：写结果必须走 append（§3.4），不要"读-改-写"共享文件。

## 5. 超预算排查清单

1. `summary.md` → `Time Budget` 找超标插件；看 `cases[].duration_seconds` 找大户。
2. 打开该用例的 `cases/<NNN>-tui-output.log`，看**最后一条 `[tui-stage]`**：
    - 停在 `expect-start` / `pi-ready-raw` → 启动/环境（沙箱构建、pi 崩溃、`exit=126`）。
    - 停在 `commands-done` 之前 → 用例内等待；检查 `wait_for` 条件是否永不满足。
    - `commands-done` 之后很慢 → 覆盖层未关（收尾白等）；用例结束前补 `send "\033"`。
3. 用 `--case <子串>` 单跑该用例，配合 `PI_TIMING=1`（pi 内部阶段）与 `PI_TUI_DEBUG=1`（渲染帧）。
4. 修完后重跑模块，确认 `summary.json.duration_seconds ≤ 300` 且 `budget_exceeded=false`。

## 6. 已交付的关键改动（供回溯）

| 改动                                                      | 位置                       | 效果                                      |
| --------------------------------------------------------- | -------------------------- | ----------------------------------------- |
| 就绪检测改「读到输出静默」+ eof 崩溃探测                  | `helpers/tui-functions.sh` | 每 TUI 用例省 11-41s，且避免按键/输出交错 |
| 收尾两段式（先 `/quit`，未退再 ESC+重试）                 | `helpers/tui-functions.sh` | 每 TUI 用例省 7-22s，且不误伤 exit=0 断言 |
| 阶段计时 `[tui-stage]`                                    | `helpers/tui-functions.sh` | 超时可定位卡点                            |
| 用例级耗时 + 插件级预算 + `settle_budget()` 门禁          | `scripts/run-e2e.sh`       | 超标判失败 + Time Budget 报告             |
| 结果统计文件驱动 `.results/*.tsv` + `aggregate_results()` | `scripts/run-e2e.sh`       | 修假绿（子 shell 丢变量）                 |
| worker 超时留痕 `.budget-timeouts/`                       | `scripts/run-e2e.sh`       | 被 kill 的模块不再静默消失                |
