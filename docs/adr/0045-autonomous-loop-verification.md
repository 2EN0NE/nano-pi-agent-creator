# ADR-0045: 多 agent 自主闭环的验证设计

- 状态：**已接受**（2026-09-11；D1/D2/D3/D4/D5/D6 **均已落地**，断言矩阵 A1–A5/A8 自动化）
- 相关组件：`test/e2e`（`scripts/run-e2e.sh`、`helpers/mock-llm.ts`、`helpers/llm-surface-dump.ts`）、`test/e2e/extensions/org`、`test/vitest/extensions/org*`
- 延伸：为 ADR-0038（目录绑定 agent 框架）的"构思是否有效"提供可证伪判据；保护 ADR-0041（在岗门控）、ADR-0042（在岗简报）、ADR-0043（在岗入口）
- 术语：见 `CONTEXT.md`（多 agent 框架节：可感知状态 / 主动唤醒 / 在岗）

## 背景

### 现有 e2e 盘点（实测）

| 层       | 位置                                   | 覆盖                                                                                                     | 未覆盖               |
| -------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------- |
| 逻辑     | `test/vitest/extensions/org*.test.ts`  | 状态机 / orgstore / board 渲染与按键 / presence 判定 / lifecycle（真 unix socket、真 pid、真 tmux 原语） | 真实 pi 进程行为     |
| 集成     | `org/smoke.test.sh`（8 例）            | 加载、CRUD、chief 编排闭环、握手 accept/reject、多人采纳、tmux 生命周期、在岗门控                        | **agent 自主行为**   |
| 集成 TUI | `org/tui-expect.smoke.test.sh`（3 例） | 看板渲染、人类强制验收、四态圆点+诊断行                                                                  | 面板与账本间的数据流 |

**致命缺口**：

1. **"编排闭环"里派发不是 agent 做的**——用例 3/4/5/6 用 `tsx dispatch.mts` 直接 `import { dispatchTask }`、成员动作用 `run_org_cmd` 跑 `/org …` 命令，**LLM 全程不参与决策**。e2e 证明了"机制跑得通"，**没证明"构思有效"**。
2. **没有一条「两个在岗 agent 进程互相自动跑通」的链路**——生命周期用例只验到 `deliver == "online"`（socket 投递成功），没验成员 agent 收到后做了什么。
3. **没验「人的冷启动旅程」**——在岗门控用例只验"在岗时可见面里有 `dispatch_task`"，没验"未在岗 / 非成员时，人/agent 是否被告知原因与出路"。

### 人工 UAT 暴露

在未在岗（无 `--session-control`）的普通 pi 里，agent 完全看不到 org 能力且无提示；同时真实 `~/.pi/org/dev-team` 混入了历史 vitest 测试数据（`/var/folders/.../T/org-board-*` 成员），使手工验证跑在**不可信环境**上。

### 「构思有效」的可证伪断言

| #   | 断言                                                        | 现状           |
| --- | ----------------------------------------------------------- | -------------- |
| A1  | 在岗 A 的 LLM 可见面含 `dispatch_task`/`org_fleet`          | ✅ 已验        |
| A2  | 给定"把 X 派给 B"，**A 自主调用 `dispatch_task`**           | ❌ 未验        |
| A3  | B 在岗时经 socket 收到 `[org:task]…`，且 B 的 prompt 里可见 | ⚠️ 只验 online |
| A4  | **B 自主 `org_claim` → `org_report`**                       | ❌ 未验        |
| A5  | A 收到交付通知，**自主 `org_review`** 关闭                  | ❌ 未验        |
| A6  | B 睡眠 → inbox 兜底 → 唤醒后 B 看到并处理                   | ❌ 未验        |
| A7  | 人类在看板看到全程（数据面）                                | ❌ 未验        |
| A8  | 冷启动 / 离岗时，人被告知状态与进入在岗的方法               | ❌ 未验        |

## 决策

### D1 分层验证

把验证分为四层，各自可独立跑：**L1 机制**（现有 vitest + e2e）/ **L2 可见面**（`llm-surface-dump` 抓系统提示、工具、技能）/ **L3 自主闭环**（新增，核心）/ **L4 冷启动旅程**（新增，低成本）。

### D2 L3 采用「全自主」

两个**真实 pi 进程**（tmux；`--session-control`；各自 cwd 为成员；`HOME`/`ORG_ROOT` 隔离），**mock-LLM 按脚本注入任意工具调用**；人类只通过 tmux `send-keys` 对 A 发一条指令。验证 A2–A5 全链，断言全部落**账本 + surface-dump**。

### D3 mock-LLM 扩展：`MOCK_LLM_TOOL_SCRIPT`

新增 `MOCK_LLM_TOOL_SCRIPT`（JSON 数组，顺序回放）：元素为 `{"tool":"<name>","args":{...}}` 或 `{"text":"..."}`；支持 `{{taskId}}` 之类**运行时占位**（从请求消息里抽取，因任务号 `M-xxxx` 运行时才生成）。**仅加法**，不影响现有用例。

### D4 断言口径

一律以**账本 / 日志 / surface-dump** 为准，不 grep TUI 屏幕文本；多进程一律"**轮询到条件**"，不用固定 `sleep`。

### D5 L4 冷启动 / 可发现性

在「非成员目录」「成员目录但未在岗」两种进程里，断言**人**能在状态栏看到明确的状态告知与进入在岗的指引（而不是静默无能力）。此条保护 ADR-0043。

> **修订（2026-09-12，ADR-0046/ADR-0047）**：原决策要求「未在岗时发一条 `org-off-duty` 消息（`display: true`，人与模型都能看到）」，**已删除**。理由：在岗与否属于**给人看的状态**，走状态栏即可（`offDutyStatusText`）；面向模型的可发现性由**在岗简报**承载（ADR-0042 动态块——在岗 agent 的 context 里本就有「我是谁 / 谁在岗 / 未结计数」）。发消息会把只给人看的状态永久写进 LLM 上下文（ADR-0047 背景）。

### D6 环境哨兵

e2e 跑前 / 跑后对真实环境取指纹，不一致即判本模块 FAIL；`ORG_ROOT`/`HOME` 隔离收敛为强制 helper；历史残留（`~/.pi/org/*` 里的测试成员）以 **dry-run 清单**交付人工清理，不自动删。

指纹口径（2026-09-12 修订，均为消除宿主 / 基建自身的误报）：

- `~/.pi/org`：**文件内容**全量哈希，排除 `runtime/<成员>.json`（真实在岗成员每轮重写，属运行痕迹）；
- `~/.pi/agent/extensions-data`：只比**路径集合**（不含内容）——宿主 pi 会话与 run-e2e 的 config 备份/恢复都在持续写它，比内容必然误报；测试泄漏的形态是**新增插件目录/配置**，路径集足以捕获。**（2026-09-16「隔离机制」修订已取代此口径——改为内容哈希；原「run-e2e 自身在写它」的理由随删除/恢复机制退场而消失。）**

> **修订（2026-09-16，实现层）**：指纹口径不变，但**判定粒度与严重级别**调整：
> ① 归因收敛到**运行级单次检查**（整轮前后各取一次指纹）——模块级归因在「池化并发 + 同机并行交互 pi 会话」下不可靠（实测一次全量被 44 个测试文件同声报 FAIL，噪声盖过真信号）；
> ② 变动时输出**具体变动路径清单**（`test/results/<ts>/env-sentinel.log`），不再只给哈希；
> ③ 默认 `warn`（不阻塞；本机开着交互会话时不至于整轮永久红），CI 用 `E2E_ENV_SENTINEL=strict` 恢复硬阻塞；模块级保留一次比对，仅报 WARN。
> 详见 `docs/e2e-performance.md` §3.4。

> **修订（2026-09-16，隔离机制）**：防污染手段由「删除 + 恢复」改为**隔离**，哨兵口径随之收紧。
>
> **背景（事故）**：旧机制是「每模块跑完 `rm -f $HOME/.pi/agent/extensions-data/*/config.json`，整轮结束再从 `test/results/<ts>/config-backup` 恢复」。恢复只在脚本走到最后一行才执行，而轮内清理是**每模块**都做——任一中断（Ctrl-C / 超时被 kill / `set -e` 异常 / CI 取消）都让配置**整批消失且无备份可取**。实测：1119 轮含备份的运行里 **81 轮中断**；受害样例是 custom-compaction 的 `smart-compact` profile 与 custom-rename / todos / pi-shortcuts 的用户配置。
>
> **新机制**：run-e2e.sh 把一个 `pi` shim（`test/e2e/helpers/pi-home-guard.sh`）符号链接为 `<guard_root>/bin/pi` 并前置到 PATH。shim 判定：`HOME` 仍等于真实 home（**或为空**，`env -u HOME` 不是绕过口）→ 注入 `PI_CODING_AGENT_DIR=<每测试文件一个的隔离 agent 目录>`；已自行隔离 HOME（或已显式设 `PI_CODING_AGENT_DIR`，视为调用方自有隔离）的调用原样 `exec` 真实 pi（语义不变，PTY 语义不变）。真实 pi 与真实 home 取两路：环境变量 `E2E_REAL_PI`/`E2E_REAL_HOME`，以及 guard 根下的 `real-pi`/`real-home` 文件——后者不可省，因为 pi 也会在**不继承 runner 环境**的进程里被拉起（org 经 tmux 唤醒成员时，session 取的是 tmux server 的环境快照，拿不到任何 `E2E_*`）。隔离根在 `$ROOT_DIR/.pi/tmp/e2e-guard-<pid>/`，`trap EXIT/INT/TERM` 保证清理（`E2E_KEEP_GUARD_ROOT=1` 保留取证）。
>
> **验证（2026-10-17 补记；此前只留在会话记录里，按 ADR-0063「验证要求」补写）**：机制落地时跑过真 e2e——
> `--ext tools,files` → 28 用例 / 19 PASS / 0 FAIL / 9 REVIEW（50s）；`--shard 0/8` 金丝雀 → 14 用例 / 13 PASS /
> 0 FAIL / 1 REVIEW（61s）。两次 `env_sentinel_failed: 0`、无 `env-sentinel.log`，真实
> `extensions-data/pi-config/config.json` 的 mtime 未变。
>
> **范围**：本机制只覆盖**在用运行器** `test/e2e/scripts/run-e2e.sh`。`test/scripts/run-e2e.sh` 是 ADR-0004 迁移遗留的旧副本，仍含「每模块删除 + 结尾恢复」逻辑（已加 DEPRECATED 头注），不要运行。
>
> 边界与取舍：① 隔离 agent 目录**为空**（不种模型/第三方包）——模型层由测试自行 mock（AGENTS.md「e2e 只 mock LLM」），泄漏调用拿不到真实模型反而是期望行为；② 只管**经由 pi 的写入**，测试脚本直接用 `mkdir/cp` 写真实路径的情况由运行级哨兵兜（CI `strict` 阻塞）；③ `PI_CODING_AGENT_DIR` 同时覆盖 `sessions/`、`models.json`、`auth.json`、`settings.json`、`npm/`，故同源问题（测试把会话写进真实 sessions）一并消失。

> **④ 覆盖边界（2026-10-17 补记，修正原提交消息的过度表述）**：guard 注入的是 `PI_CODING_AGENT_DIR`，因此只覆盖
> **pi 内核目录**（`sessions/`、`models.json`、`auth.json`、`settings.json`、`npm/`）。**扩展自己用 `os.homedir()`
> 解析的用户级路径不在覆盖内**——`pi-config` / `pi-state` 的 `~/.pi/agent/extensions-data/**`
> （`extensions/meta/pi-config/index.ts`、`extensions/meta/pi-state/api.ts`）与 pi-logger 的 `~/.pi/logs/**`。
> 故准确表述是「**pi 内核目录**从根上不可被写」；原提交消息里的「真实配置从根上不可被写」**过度**，以本段为准。
> 用到这些路径的用例必须自行隔离 `HOME`；本地哨兵默认 `warn`，这类写入不会被阻塞（CI 的 `strict` 也只覆盖
> `~/.pi/org` 与 `extensions-data` 的内容哈希，不含 `sessions/models/auth/settings`）。
>
> **哨兵口径**：`~/.pi/agent/extensions-data` 由「路径集合」改为**内容哈希**（目录仍按路径记录）——旧口径的理由（run-e2e 自身在写它）随删除/恢复机制退场而消失，而旧口径对「改写已存在 config.json 的内容」是瞎的；CI 三个 e2e job 均已设 `E2E_ENV_SENTINEL=strict`。

## 可行性（spike 实测，2026-09-11）

- **单进程**：mock 注入 `dispatch_task` → 账本出现 `invited` 成员（A 自主派发生效）。
- **双进程全链路**（tmux A/B，均 `--session-control`）：A 派发 → B `org_claim`/`org_report` → A `org_review` → 账本 `closed`，history = `[dispatched, claimed, delivered, accepted_closed]`。
- **结论**：D2/D3 可行，**无需改 pi 本体**。（spike 代码已回退，仅保留结论；实现随本 ADR 推进。）

## 落地记录（2026-09-11）

### 断言矩阵（A1–A8）逐条落点

| #   | 断言                                         | 落点                                                                            | 状态    |
| --- | -------------------------------------------- | ------------------------------------------------------------------------------- | ------- |
| A1  | 在岗 A 可见面含 `dispatch_task`/`org_fleet`  | `org/smoke.test.sh` 用例 008（llm-surface-dump）                                | ✅      |
| A2  | A **自主**调用 `dispatch_task`               | 用例 010（A 的 mock 脚本；人类只 `send-keys` 一条指令）                         | ✅      |
| A3  | B 经 socket 收到 `[org:task]` 且 prompt 可见 | 用例 010（B 的 `contextText` 含 `[org:task]` 与发送者头）                       | ✅      |
| A4  | B **自主** `org_claim` → `org_report`        | 用例 010（账本 `claimed`/`delivered`；均由 B 的 LLM 决策产生）                  | ✅      |
| A5  | A 收到交付通知后**自主** `org_review` 关闭   | 用例 010（账本 `accepted_closed` + `status=closed`）                            | ✅      |
| A6  | B 睡眠 → inbox 兜底 → 唤醒后 B 看到并处理    | 用例 007 覆盖**机制**（inbox 兜底 + 唤醒续接），未覆盖"唤醒后 agent 自主处理"   | ⚠️ 部分 |
| A7  | 人类在看板看到全程（数据面）                 | `tui-expect.smoke.test.sh` 三例覆盖看板渲染与账本一致                           | ⚠️ 部分 |
| A8  | 冷启动/离岗时人被告知状态与进入方法          | 用例 009（未在岗 / 非成员目录，断言状态栏有状态与出路；LLM 上下文**不含**告知） | ✅      |

### 各决策落点

- **D2（全自主）**：用例 010——两个真实 pi 进程（tmux + `--session-control` + 各自 cwd），
  mock-LLM 按脚本行动，人类只对 A 发一条指令；断言全落**账本 + 模型可见面**。
  实测账本：`status=closed`，`history=dispatched,claimed,delivered,accepted_closed` ✓（与 spike 预测一致）。
- **D3（`MOCK_LLM_TOOL_SCRIPT`）**：`test/e2e/helpers/mock-llm.ts`（**仅加法**，未设置该变量时
  行为完全不变，由 org 用例 1–9 回归证明）。纯逻辑有单测：`test/vitest/e2e-helpers/tool-script.test.ts`。
  占位符目前只 `{{taskId}}`（见"仍待补"）。
- **D4（断言口径）**：所有多进程用例一律"轮询到条件"（`wait_runtime`/账本轮询），不 grep 屏幕；
  失败时用 `tmux capture-pane` 取证。
- **D5（L4 可发现性）**：用例 009。**未在岗的告知走状态栏**（`|org: 待上岗 / 未连接 / 未加入`，见
  `org/onduty.ts`），不再发 `org-off-duty` 消息——人与模型都能看到的状态信息不该污染 LLM 上下文
  （ADR-0046 D5 / ADR-0047）；在岗 agent 所需的在岗信息由在岗简报（ADR-0042）随 context 注入。
- **D6（环境哨兵）**：`run-e2e.sh` 的 `real_env_hash()`——模块用例循环前后对
  `~/.pi/org` 与 `~/.pi/agent/extensions-data` 取内容指纹，不一致即判本模块 FAIL。
  实测：能检测到新增文件、恢复后回到原指纹。

### 顺带修掉的 harness 缺陷（重要）

写用例 010 时踩到并**复现**了一个会让 e2e **假通过**的洞：

> 用例体用 `trap cleanup EXIT` 时，若因 `set -u` 未绑定变量中止，bash 会以 **trap 的退出码**
> （通常 0）收尾 → 用例中途挂掉却判 PASS。诱因常见于 `$VAR` 紧跟全角括号被吞进变量名
> （AGENTS.md 记录过的高频坑）。

处置：① 修正 `org/smoke.test.sh` 中 3 处既有 + 2 处新增的该模式（统一 `${VAR}）`）；
② `run-e2e.sh` 增加守卫——用例日志出现 `unbound variable` 且退出码为 0 时判 FAIL。

### 仍待补（不阻塞本 ADR 的落地结论）

1. **A6 的自主版本**：睡眠 → inbox → 唤醒后由 agent 自主处理的端到端用例。
2. **失败路径**：socket `timeout → uncertain`（不落 inbox）的 e2e。
3. **CI 时长预算**：实测 org 模块 print 用例 18s、TUI 用例 260s（可接受；双进程用例单例 ~2s）。
4. **占位符覆盖面**：目前只 `{{taskId}}`；子任务号 / 成员名是否也要，视后续用例需要再加。

## 后果

- **正向**：把"构思有效"变成可回归的自动化判据；新功能（ADR-0043/0044）有保护网。
- **负向**：e2e 复杂度与时长上升（多进程 tmux + 脚本注入）；mock-LLM 从"哑回显"变为可编程，需防脚本与真实行为漂移。
- **注意**：全自主用例仍由 mock-LLM 驱动，**只证明"机制支持 agent 自主"，不证明"真实 LLM 一定这样决策"**；后者只能靠人工 UAT（L4 之外的旅程检查清单）补充。
