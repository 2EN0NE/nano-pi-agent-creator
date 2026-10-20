# bench — 插件有效性离线配对基准

移植自 pi-fabric 的 DeepSWE 风格 paired benchmark，量化「某个插件是否有用」——固定任务 + 固定模型下，对比「无插件 vs 有插件」两个配置臂的**边际价值**（解决率 / token / 成本 / 耗时 / 行为）。

与 pi-lab 互补：pi-lab 管会话内变体（同一插件不同参数，在线 A/B），bench 管环境级装/卸扩展（离线配对）。详见 `docs/adr/0026`、`0027`、`0028`，术语见 `CONTEXT.md`「bench 评测体系」。

## 目录结构

```text
bench/
├── arms.json        # 臂注册表：baseline（公共基座）+ 各臂的 triggerTools（单一来源，见 ADR-0057）
├── preflight.sh     # 前置检查：环境 / 工具链 / 本地包 / 模型 / 臂，缺失即 fail-fast（见 ADR-0056）
├── find-extension.sh # 插件名 → 扩展入口路径（run-cell 与 preflight 共用的解析规则）
├── run-cell.sh      # 单 cell：checkout → agent → 指标提取 → verify.sh（阶段写 progress.json）
├── metrics.py       # 指标提取：session jsonl → result.json（抽成 module 以便单测，见 ADR-0057）
├── run-matrix.sh    # task × config × rep 矩阵编排 → analyze.py（强制 --model、--resume 续跑、--pilot 先导门）
├── progress.py      # progress.json 读写/查询（run-matrix 与 bench-status 的结构化契约）
├── bench-status.sh  # 进度查询：bench-status.sh [<run-id>] [--log N]
├── analyze.py       # 配对边际价值统计（含 plugin_triggered 触发率）
├── smoke-test.sh    # 冒烟测试（mock-llm 不烧钱；遍历 arms.json 全部臂 × 全部任务，跳过本机解析不到的臂）
├── test_*.py        # analyze.py / progress.py / metrics.py 的单元测试（python3 bench/test_*.py）
└── tasks/<slug>/    # 任务三件套：task.json + prompt.txt + verify.sh (+probe.mjs)
```

> `preflight.sh` / `find-extension.sh` / `run-matrix.sh --pilot` 的契约行为（fail-fast 聚合报告、四级解析与优先级、先导门调用集合）由 `test/e2e/skills/bench-run/smoke.test.sh` 覆盖——纯 bash + stub 驱动，不启动 pi、不调用 LLM：
>
> ```bash
> bash test/e2e/scripts/run-e2e.sh --skill bench-run
> ```

## 快速开始

```bash
# 1. 冒烟测试（mock-llm，不烧钱、不需 --model）：验证骨架全链路 + verify.sh 能正确判 FAIL
bash bench/smoke-test.sh

# 2. 查你本机已配置的模型（选一个作为 --model）
pi --list-models

# 3. 真实评测：无插件 vs 单插件配对（必须显式 --model，bench 不再有隐式默认模型）
bash bench/run-matrix.sh \
  --tasks scc-bounded-memory-spilling \
  --configs none,plugin-truncated-tool \
  --reps 1 \
  --model deepseek/deepseek-v4-flash

# 4. 查看配对结果（<run-id> 在启动输出的 RUN_ID=... 或 manifest.json 里；用 bench-status.sh 可查）
cat bench/results/<run-id>/analysis-summary.json
```

> **`--model` 是必填项**：`run-matrix.sh` 不再有隐式默认模型（旧默认 `cli-proxy-api/deepseek-v4-flash` 已失效），启动时会 preflight 校验模型存在于 `~/.pi/agent/models-store.json`，不存在则在跑任何 cell 之前报错并列出可用模型。冒烟测试不用 `--model`——它由 `smoke-test.sh` 自动注入 `mock-llm/mock-model-1`。

## 配置臂（config）

臂清单与每个臂的**触发工具名**登记在 `bench/arms.json`（臂注册表，单一来源，见 ADR-0057）：

```json
{
	"baseline": ["bash-timeout"],
	"arms": {
		"none": { "triggerTools": [] },
		"plugin-todos": { "triggerTools": ["todo"] },
		"plugin-truncated-tool": { "triggerTools": ["rg"] },
		"plugin-@ff-labs/pi-fff": { "triggerTools": ["ffgrep", "fffind"] }
	}
}
```

- **`baseline`**：两臂公共基座（非被测变量）。`bash-timeout` 是评测环境安全网（防 agent 慢命令如 `find /` 卡死），`none` 与 `plugin-*` 都加载——配对唯一差异仍是被测插件本身。
- **`triggerTools`**：该臂被测插件注册的工具名，用于 `plugin_triggered` 判定。挂在**臂**上而非 `task.json` 上，使任务与插件正交（同一个任务可测多个插件臂，不再需要并集 hack）。`none` 臂为空数组 → 该臂的 `plugin_triggered` 记为 `null`（无目标插件可判定）。
- **臂封闭**：`--configs` 里出现未登记的臂即 fail-fast（`preflight.sh` 在启动时一次校完，不会跑到那个 cell 才发现 `plugin not found`）。

双臂统一在 `COMMON_FLAGS` 关闭扩展/技能自动发现（`--no-extensions --no-skills` 等），plugin 臂只经显式 `-e` 加载目标插件。这样 `none` 与 `plugin-*` 的唯一差异就是被测插件本身——若只隔离 none 臂，plugin 臂会读入 `~/.pi/agent/extensions` 全量用户扩展（配对不对称），且目标插件若同时存在于 sync 同步的全局副本，会与 `-e` 副本重复注册（同工具名冲突）导致该臂失效。

| config           | 含义                                                  | 加载方式                                 |
| ---------------- | ----------------------------------------------------- | ---------------------------------------- |
| `none`           | 纯净 Pi 对照（无被测插件）                            | `baseline` + 隔离 flags，无被测插件 `-e` |
| `plugin-<name>`  | 单插件 + 其依赖链                                     | `baseline` + 隔离 flags + `-e <路径>`    |
| `plugin-<a>+<b>` | 多插件（`+` 分隔；多插件臂同样需在 `arms.json` 登记） | `baseline` + 隔离 flags + 逐个 `-e`      |

插件名由 `bench/find-extension.sh` 按序搜索（`run-cell.sh` 与 `preflight.sh` 的臂校验共用同一份，避免两份实现漂移）：

1. `extensions/<分类>/<name>/index.ts`（目录形式）或 `extensions/<分类>/<name>.ts`（单文件）——本仓库自家插件
2. `test/helpers/<name>.ts`、`test/e2e/helpers/<name>.ts`——测试辅助（mock-llm）
3. `~/.pi/agent/npm/node_modules/<包名>/`——**外部 npm 安装的插件**，读其 `package.json` 的 `pi.extensions` 入口

### 外部 npm 安装的插件能跑吗 —— 能

- config 臂直接写包名：`plugin-<包名>`。scoped 包名含 `/`（如 `@ff-labs/pi-fff`），`run-matrix.sh` 会把目录段的 `/` 自动转义为 `__`（避免 cell 目录错位），config 写全名即可：

    ```bash
    bash bench/run-matrix.sh --tasks scc-bounded-memory-spilling \
      --configs none,plugin-@ff-labs/pi-fff --reps 3 \
      --model deepseek/deepseek-v4-flash
    ```

- 插件的自身 import 依赖从其所在目录向上查找 `node_modules`（`~/.pi/agent/npm/node_modules`），无需额外安装。
- **前置条件**：被测插件必须**注册工具**（agent 能主动调用），否则 `plugin_triggered` 恒 `null`、边际价值测不出。纯 UI / 纯配置类 npm 插件（不注册工具）不适用 bench。

## 任务三件套（task.json）

```json
{
	"slug": "scc-bounded-memory-spilling",
	"repo": "https://github.com/boyter/scc.git",
	"base_ref": "bc2796e",
	"language": "go",
	"agent_timeout_s": 1500,
	"verify_timeout_s": 300
}
```

- 任务**不含**插件信息（`trigger_tools` 已下沉到 `bench/arms.json` 的臂，见 ADR-0057）。
- `language`：`preflight.sh` 据此映射工具链依赖（`go → go`、`typescript → node, npm`）。
- `verify.sh` 从任务验收标准推导，输出 `reward_binary` / `reward_partial` / `checks`。

## 模型配置

bench 只**引用** pi 的用户级模型，不新增/不修改模型配置。

- **引用格式**：`--model <provider>/<model-id>`（或环境变量 `BENCH_MODEL`，二者等效），如 `--model deepseek/deepseek-v4-flash`。模型 id 支持 `provider/id` 形态（同 pi 的 `--model`）。
- **必填**：`--model` 无默认值，不传则报错；启动时 preflight 校验模型存在于 models-store，缺失即 fail-fast（不会跑任何 cell 才暴露）。
- **模型来源**：`~/.pi/agent/models-store.json`（pi 维护，格式 `{ provider: { models: [{ id, ... }] } }`）；可用 `pi --list-models` 查看当前已配置的模型，用 pi 的模型管理添加新 provider/model。
- **冒烟模型**：`mock-llm/mock-model-1`——由 `smoke-test.sh` 自动注入到隔离 HOME 的 models-store，**不烧钱、不依赖真实网络/API key**，只验证骨架全链路 + verify.sh 能正确判 FAIL。
- **成本口径**：真实跑直接累加 session jsonl 的 `usage.cost.total`（provider 报告值），**不 hardcode 模型费率**（区别于 pi-fabric 的 GPT-5.6 Sol 硬编码费率）。
- **选型建议**：
    - 先冒烟跑通再上真实，避免烧钱踩骨架/任务资产 bug。
    - 同一轮矩阵内固定一个模型——配对对比的差分才干净；「对比不同模型」不是 bench 的目标。
    - `--thinking` 默认 `low`（省 token + 可复现）；`high` 会显著增加成本。
    - 网络注意：跑前需能 clone 任务 repo（github）。国内网络需代理：`export https_proxy=http://127.0.0.1:7890 http_proxy=http://127.0.0.1:7890`（端口按本机代理）。go 不在 PATH 时：`export PATH="$PATH:/usr/local/go/bin"`。

## 后台运行 + 进度查询 + 断点续跑

真实评测一次要跑 task×config×rep 个 cell，单 cell 最长 `agent_timeout_s`（默认 1500s），整体可达几小时。**建议后台跑 + 查进度**：

```bash
# 后台启动（输出自动 tee 到 results/<run-id>/run.log，无需手动重定向）
nohup bash bench/run-matrix.sh \
  --tasks scc-bounded-memory-spilling \
  --configs none,plugin-truncated-tool \
  --reps 1 \
  --model deepseek/deepseek-v4-flash >/dev/null 2>&1 &

# 启动输出会打印 run-id（RUN_ID=run-YYYYMMDD-HHMMSS），记住它。
# 查进度（不传 run-id 则查最近一次）：
bash bench/bench-status.sh <run-id>            # 结构化进度 + 每个 cell 状态/阶段
bash bench/bench-status.sh <run-id> --log 20   # 追加 run.log 尾部 20 行
```

- **进度落盘**：`results/<run-id>/progress.json`（结构化，含总量/已完成/失败/每个 cell 的 `pending|running|done|failed|skipped` 与阶段 `clone|agent|metrics|verify`）；`bench-status.sh` 读它渲染人类可读进度。
- **run.log**：`run-matrix.sh` 自身 stdout+stderr 全量 tee 到 `results/<run-id>/run.log`，后台跑/日志滚走都能翻。
- **断点续跑**：中断后不想重跑已完成的 cell，用 `--resume <run-id>`。跳过「`result.json` 存在且含 `reward_binary`」的 cell（= 已完成），其余（含中断/残缺的）重跑；**续跑配置（tasks/configs/reps/model/thinking）必须与原 run 完全一致**，否则拒绝（对齐上游 Harbor `job resume` 的严格配置相等语义）。

```bash
bash bench/run-matrix.sh --resume run-20260906-143821 \
  --tasks scc-bounded-memory-spilling --configs none,plugin-truncated-tool \
  --reps 1 --model deepseek/deepseek-v4-flash
```

### 先导门（`--pilot`）

一轮全量可能烧几小时；先用 `--pilot` 花 ~25min 确认**每个臂都能跑通**，再决定要不要上全量：

```bash
bash bench/run-matrix.sh --tasks a,b --configs none,plugin-x --reps 3 \
  --model deepseek/deepseek-v4-flash --pilot
```

- 跑 **每个臂 × `--tasks` 的第一个任务 × rep0**，然后**停下**（不跑 `analyze.py`——半量数据上的 delta/翻转结论会误导插件去留决策），打印可复制的 `--resume` 命令。
- pilot 与全量**同属一个 run**（`manifest.json` 记录的是全量配置），所以先导已跑的 cell 会被后续 `--resume` 跳过，不重复烧钱。这是 ADR-0031「`--resume` 严格配置相等」逼出的设计：若 pilot 是独立的 `reps=1` run，`reps=3` 的全量无法复用它。
- 有 cell 失败即 `exit 1`（先导门的意义就是拦住明显的环境/资产问题）。

## 会话记录与命名

每个 cell 都是一次独立的 pi 进程，**会话完整保留（不传 `--no-session`）**，用于事后审计/复跑分析：

- 会话显示名 = `--name "bench-test:<task> <config> rep<N>"`（如 `bench-test:scc-bounded-memory-spilling plugin-truncated-tool rep0`），在 pi 会话列表/导出中可直接辨识。
- 会话 jsonl 存于 `cell/session-store/`（pi 写入）并复制到 `cell/session/`（供指标提取）；与 `result.json`、`artifacts/model.patch`、`logs/` 同处 cell 目录——**结果自包含可追溯**，不污染主会话历史（`~/.pi/agent/sessions/`）。
- 如需把某次 bench 会话并入主历史，可将该 cell 的 `session/*.jsonl` 拷入 `~/.pi/agent/sessions/<slug>/`（文件名需符合 pi 命名规则）。

## 度量指标

每个 cell 产出 `result.json`：`reward_binary` / `reward_partial` / `checks`、`combined_total_tokens`（+ fresh/cached/output 分解）、`combined_cost_usd`、`agent_wall_s`、`turns`、`tool_calls`、`patch_bytes`、`plugin_triggered`。

`analyze.py` 输出：每 config 聚合 + 配对边际价值（`paired_none_vs_plugin-*`：解决翻转 McNemar、token/cost delta），并单列 `triggered`/`untriggered` 计数——**未触发的 plugin cell 不混入 delta**（见 ADR-0027）。

报告就是 `results/<run-id>/analysis-summary.json`（同时打印到 stdout 尾部）。示例（1 task × none/plugin × 1 rep）：

```json
{
	"run_dir": "bench/results/run-20260906-143821",
	"per_config": {
		"none": {
			"n": 1,
			"solves": 0,
			"median_tokens": 5200,
			"median_cost": 0.014,
			"triggered": 0,
			"untriggered": 0
		},
		"plugin-truncated-tool": {
			"n": 1,
			"solves": 0,
			"median_tokens": 4100,
			"median_cost": 0.011,
			"triggered": 1,
			"untriggered": 0
		}
	},
	"per_task": {
		"scc-bounded-memory-spilling": {
			"none": { "n": 1, "solves": 0, "median_tokens": 5200 },
			"plugin-truncated-tool": { "n": 1, "solves": 0, "median_tokens": 4100 }
		}
	},
	"paired_none_vs_plugin-truncated-tool": {
		"n_pairs": 1,
		"n_untriggered_excluded": 0,
		"solve_flips_left_only": 0,
		"solve_flips_right_only": 0,
		"mcnemar_p": 1.0,
		"median_token_delta": -1100,
		"median_cost_delta": -0.003
	}
}
```

> 解读：`median_token_delta` / `median_cost_delta` 为负 = 插件省 token/省钱（边际价值为正）；`solve_flips_*` + `mcnemar_p` 看解决率翻转是否显著（小样本多为不显著）；`triggered` 计数判断插件是否真的被 agent 调用（未触发的 plugin cell 不混入 delta，单列 `n_untriggered_excluded`）。

## 跑哪些插件：选型三问 + 适配度

bench 只能量化「装/卸扩展」在**真实 repo 编码任务**上的边际价值（solve / token / cost delta）。新插件是否值得入库评测，先过三问：

| 问                                                                  | 不满足的后果                                                              |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| ① 它注册工具吗（agent 能主动调用）？                                | `plugin_triggered` 恒 `null`，无法区分「插件没用」vs「装了但 agent 不用」 |
| ② 它的价值能在真实编码任务上体现吗？                                | delta ≈ 0，纯烧钱无结论                                                   |
| ③ 能单插件隔离吗（依赖走 node_modules 本地包，或同臂用 `+` 组合）？ | 隔离不干净会污染归因                                                      |

适配度参考（nano 自家插件）：

| 分类                                                                        | 适配度       | 说明                                                                                                                     |
| --------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `accuracy/` 工具增强（truncated-tool `rg`、edit、todos、structured-output） | ★★★ 第一波   | 直接参与编码，solve/token 边际价值最可量化                                                                               |
| `auto/`（loop、git-checkpoint、continue 等）                                | ★★ 视任务    | 长任务编排/自动化在特定形态任务上有可观测 delta                                                                          |
| `context/` `meta/`（smart-context、custom-compaction、preset）              | ★ 谨慎       | 纯上下文/配置类：仅当任务压到该能力（如大上下文压缩）才体现；preset 是用户主动选择、agent 不会「触发」其工具，**不适用** |
| `security/` `tui/`                                                          | ☆ 一般不适用 | 保护类不改变 solve；交互类在 `--print` 非交互模式下无价值                                                                |

第一波建议（accuracy 工具增强，已确认注册工具、可单插件隔离）：

| 插件           | config 臂               | 工具   | 预期信号                         |
| -------------- | ----------------------- | ------ | -------------------------------- |
| truncated-tool | `plugin-truncated-tool` | `rg`   | 有界搜索 → token 节省            |
| edit           | `plugin-edit`           | `edit` | 精准编辑 → 编辑成功率 / 少走弯路 |
| todos          | `plugin-todos`          | `todo` | 长任务规划 → solve 稳定性        |

> 换测插件时：在 `bench/arms.json` 加一个臂（`plugin-<name>` → 该插件注册的工具名）。工具名挂在**臂**上而非任务上，所以同一个任务可以同时测多个插件臂、互不影响（见 ADR-0057）。

## 案例库自动补充（后续阶段）

Pi 会话按 template 生成 `tasks/<slug>/` 三件套 → 冒烟（无/有两臂任一维度出现可观测 delta 才入库）→ 入库。冒烟门槛见 CONTEXT.md「冒烟门槛」。
