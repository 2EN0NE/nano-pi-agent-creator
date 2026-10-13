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

### 1.1 例外：仅限「真实工作量」且必须写明理由

个别插件确有多进程真实工作量（无法靠缩短等待达标），可在**配置文件**里显式列明例外：

```
# test/e2e/budget-overrides.conf
#   格式：`extensions/<名>` 或 `skills/<名>` = 秒数；`#` 起注释；环境变量优先
#   规则：能用「缩短等待 / 合并用例」解决的，**不许**加例外
extensions/org=600   # 25 smoke + 8 TUI 全要起真实 tmux 成员 + 真实 pi 进程
```

- 优先级：`E2E_EXT_BUDGET_OVERRIDES="type/name=秒"` > `budget-overrides.conf` > 默认 300s。
- 例外同时作用于 **worker 超时上限**（否则模块会在默认 300s 被杀，例外形同虚设）。
- 可见性：`summary.json` 记录 `budget_overrides`，Time Budget 表的 `Budget` 列显示**逐插件**预算。

> ⚠️ 例外是「已知且被审阅的偏差」，不是绿牌：若某插件因**挂起/冗余用例**超预算，
> 加到例外里只会掩盖问题，务必先用 §5 清单定位。

### 1.2 机器争用：超预算降级为 WARN（不阻塞）

绝对耗时**不是插件属性**，而是「插件 + 机器状态」的函数：实测同一批 `files` 用例，独占时
109s，机器上有 14 个并发 e2e（其它会话）时 462s（3-4 倍）。若门禁在争用时仍按硬失败判，
结果只会是把「机器忙」误报成「插件变慢」。

**机制**（runner 启动时探测一次，写进运行头与 `summary.json`）：

- **确定性信号**：运行注册表 `test/results/.active-runs/<pid>`——每轮 e2e 写入以自己 pid 命名的
  条目，用 `kill -0` 判存活（不用 `pgrep` 数进程：池化 worker 是子 shell、cmdline 相同，会被误计）；
  陈旧条目在同一次巡检里清除。
- **辅助信号**：`load / CPU ≥ 1.0`（负载均值有滞后，故只作补充）。
- 任一命中 → 记为争用，运行头打印 `⚠️ 机器争用: 另有 N 个 e2e 运行中；load/CPU=x`。

**判定差异**：

| 场景                                          | 超预算结果                                                                          |
| --------------------------------------------- | ----------------------------------------------------------------------------------- |
| 独占机器（无其它 e2e、load/CPU < 1）          | `FAIL [BUDGET]`，计入退出码（默认门禁行为）                                         |
| 机器争用中                                    | `WARN [BUDGET]`，**不计失败**；`summary.json` 记 `budget_warnings` + `contention{}` |
| 任意场景 + `E2E_BUDGET_STRICT=1`（CI 已启用） | 一律 `FAIL [BUDGET]`（CI 独占机 → 讨论争用无意义）                                  |

> CI 的三个 e2e job（分片矩阵 / `e2e-worktree` / `e2e-permission-gate-smoke`）均已设
> `E2E_BUDGET_STRICT=1`，因此**争用降级在 CI 上不生效**——超预算即红。
> 只降级**超预算**判定；`[TIMEOUT]`（worker 被 kill = 用例没跑完）在任何情况下都仍是失败。
> 争用时想看真实数字：等其它 e2e 结束再跑，或 `E2E_EXT_BUDGET_SEC=0` 只观察不判定。

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

### 2.3 等待期间必须持续读 PTY（否则 pi 死锁）

**症状**：TUI 用例跑到某个等待点后**整轮零输出**、耗满超时；产品侧日志停在一句 `exec START git …`（无 `close`）、
沙箱里留下未释放的 `‎.pi-checkpoint-lock`；同一个场景在 print 模式却 0.7s 通过。

**根因**：expect 脚本**停止读取 PTY**（轮询里只 `sleep` / `file exists` / `exec cat`），pi 的 TUI 写满 PTY 缓冲后
**同步阻塞在 write** → Node 事件循环冻结 → 工具调用不执行、子进程 `close` 事件不再处理、覆盖层不渲染 →
用例到点杀 pi（锁因此残留）。**不是 git/checkpoint 慢**——把同一现象栽给 `git init` 是误判（实测过）。

**规则**：任何"等状态"的循环，每轮都要把 PTY 读走：

```tcl
for {set i 0} {$i < 30} {incr i} {
  if {[file exists $marker]} { break }
  # -timeout 0 → 立即返回，不改变节奏；有输出就排空
  expect { -timeout 0 -re {.+} { exp_continue } timeout { } }
  sleep 1
}
```

- 硬等待里用 `-timeout 0`（零延迟）；`send` 连发之间同理（`pi-session-tree` 的 20 连发 + `sleep 8` 窗口
  ~18s，同型隐患）。
- **门禁**：`npm run lint:tui`（CI 已接入）会扫 `test/e2e/extensions/**/*.test.sh|*.exp`，命中
  `expect-poll-without-drain`（含 sleep 的循环体内无 `expect`/`read`/`drain`）即阻塞。

**排空必须"有界"**：`expect { -timeout 0 -re {.+} { exp_continue } timeout { } }` 单用是**无界**的——
只要 pi 在流式输出（`PI_TUI_DEBUG` / 工具执行 / agent 活跃）就永远 `exp_continue`，调用方循环永远推进不了。
实测：`pi-session-tree` case 003（91 列 ghosting 诊断，开 `PI_TUI_DEBUG=1`）因此单次排空不返回，
15 次滚动迭代连第 1 次都过不去 → 用例挂满 300s 被模块预算杀掉，表现为「用例全过、模块 301s、FAIL [BUDGET]」，
且**看上去像 runner/管道问题**（曾误判为「孤儿进程持有 `$( )` 管道」）。修后该模块 305s → **138s**（5/5 pass，对齐改动前 137s）。

两种有界写法（择一）：

| 写法                                                                | 边界                                | 代价                 |
| ------------------------------------------------------------------- | ----------------------------------- | -------------------- |
| `drain_pty 20`（harness 助手，`test/e2e/helpers/tui-functions.sh`） | 无输出立即返回 + 最多 20 块 `break` | 无                   |
| `expect { -timeout 2 -re {.+} { exp_continue } timeout { } }`       | 最长 2s                             | 静默 PTY 每轮白等 2s |

> 助手名为 `drain_pty`：门禁用 `\bdrain\b` 会漏判（下划线不是词边界），故取前缀匹配；规则 `unbounded-pty-drain` 专抓
> 「`-timeout 0` + `exp_continue` 且无 `break`」。

**排查「用例全过但模块超预算」的顺序**（本次踩弯路的教训）：① 先看 `test/results/<ts>/extensions/<mod>/cases/` 产物是否齐全
（缺 `00N-tui-output.log` = 第 N 条没跑完）；② 看文件声明的 `Cases: N` 与汇总条数是否一致（少一条 = 有一条挂死）；
③ 之后才怀疑 runner/管道。

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

#### 池化（pool）模式的三条铁律

pool 下同一插件的多个测试文件由**不同 worker 并行**执行，以下三点不遵守就会出现
「报告与实跑不一致」或「预算门禁失效」：

1. **用例行不能读-改-写共享文件**：每个测试文件只写自己的专属文件
   `test/results/<ts>/.cases/<type>__<name>__<file>.tsv`（文件名唯一 → 无竞争）；
   主流程结束前 `finalize_module_summaries()` 用完整集合重写模块 `summary.md/json`。
   （踩坑：早期共写一份累积文件，org 实跑 31 个用例报告只剩 24 个。）
2. **被杀的 worker 也要计入耗时**：worker 超时被 kill 时必须同时
   `record_module_timeout`（判 FAIL）**和** `record_module_duration`（累计耗时），
   否则插件总耗时被低报。（踩坑：org 的 tui 文件被杀，模块却报 230s < 300s → 预算门禁形同通过。）
3. **计数三方必须一致**：模块 `summary.md/json`（用例行）与全局 `summary.json`
   （`.results` 计数）必须能对上。任何"不算用例行、只把计数加一"的失败
   （如环境哨兵）都会造成两边不一致 → 必须落成**显式用例行**。

**环境哨兵（`real_env_hash`）与并行会话**：哨兵校验的是**真实** `$HOME/.pi`（org 树 +
`extensions-data` 内容哈希）在**整轮 e2e 前后**未变。判定已收敛到**运行级单次检查**（模块级只报 WARN）：

- 变动时输出 `test/results/<ts>/env-sentinel.log`，内含 **diff 出的变动路径清单**（不再只给哈希），
  并写入全局 `summary.json` 的 `env_sentinel_failed`。
- 严重级别：默认 `warn`（本机常同时开着交互 pi 会话，其 org/插件写入会触发；硬失败会让整轮
  永远红、盖住真信号）；CI 无并发会话 → 用 `E2E_ENV_SENTINEL=strict` 恢复阻塞（已在 `ci.yml` 生效）。
- 为何不改模块级硬失败：池化并发 + 并行会话下模块级归因不可靠（实测一次全量 44 个文件同时报 FAIL）。

**pi 配置根 guard（ADR-0045 D6 修订，2026-09-16）**：`extensions-data` 的口径从「路径集合」
改为**内容哈希**——旧口径是为了回避「run-e2e 自身的 config 删除/恢复也在写它」造成的误报；
现在 runner **不再写真实 `~/.pi`**（见下），误报源只剩宿主交互会话，而旧口径对
「改写某个已存在 config.json 的内容」是瞎的。

防止用例写真实配置的机制也由「删除 + 恢复」改为**隔离**：run-e2e.sh 把一个 `pi` shim
（`helpers/pi-home-guard.sh`）前置到 PATH，对「HOME 仍是真实 home（或为空）」的调用注入
`PI_CODING_AGENT_DIR=<每测试文件一个的隔离 agent 目录>`；已自行隔离 HOME（或已显式设
`PI_CODING_AGENT_DIR`）的调用原样透传。真实 pi 路径与真实 home 除环境变量外**另落盘**到
`<guard_root>/real-pi`、`real-home`——这一步是必须的：pi 也会在**不继承 runner 环境**的进程里
被拉起（org 经 tmux 唤醒成员时，session 取的是 tmux server 的环境快照，拿不到 `E2E_*`）。
因此**忘记隔离 HOME 的新用例不会伤到 pi 内核的用户配置**（sessions / models / auth /
settings）；但扩展走 `os.homedir()` 解析的 `~/.pi/agent/extensions-data/**`（pi-config /
pi-state）与 pi-logger 的 `~/.pi/logs/**` **不在 guard 覆盖内**——用到它们的用例仍须
自行隔离 HOME。且中断/被 kill 不再有 "恢复没跑" 的窗口。
旧机制（每模块 `rm -f $HOME/.pi/agent/extensions-data/*/config.json` + 结尾从
`test/results/<ts>/config-backup` 恢复）在**在用运行器** `test/e2e/scripts/run-e2e.sh` 中已删除：
实测 1119 轮里 81 轮中断 → 配置整批丢失。`test/scripts/run-e2e.sh` 是 ADR-0004 迁移遗留的副本
（已加 DEPRECATED 头注），仍含该逻辑，不要运行。

## 4. 并行化与依赖关系

### 4.1 现状

- **模块级并行**：runner 池化（`--pool N`，默认 `min(CPU×2, 6)`）按
  `(type, module, test_file)` 任务并行，同一 shard 内互不相关。
    > 并发上限默认 **6**：最重的用例是「真实 tmux 成员 + 真实 pi 进程」的多进程编排与重渲染 TUI，
    > 对争用敏感——实测 20 worker 会把就绪等待拖到超时（假失败），而墙钟瓶颈（org ~512s）
    > 不会因并发变小。CI 可用 `E2E_POOL_SIZE` 提高（分片跑时可放宽）。
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
  固定路径的临时文件、固定端口等都会被并发执行污染。（真实配置已有兜底：PATH 前置的 `pi`
  shim 会把未隔离 HOME 的调用重定向到**每测试文件一个**的隔离配置根，见 §3.4 环境哨兵段。）
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
