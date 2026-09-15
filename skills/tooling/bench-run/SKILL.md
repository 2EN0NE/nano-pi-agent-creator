---
name: bench-run
description: >
    在后台运行插件有效性 bench 评测（bench/ 下的 DeepSWE 风格离线配对基准），
    并以「后台跑 + 用户问进度 + agent 查询反馈」的模式交付。
    适用于用户要求验证「某个插件是否有用」「跑个 bench 看看」「deepswe 验证插件」等场景。
---

# Bench Run — 后台运行插件有效性评测

## 何时执行

用户要求量化「某个插件是否有用」时，用 `bench/` 的离线配对基准（对比「无插件 vs 有插件」两个配置臂的边际价值）。见 `bench/README.md` 与 `docs/adr/0026`、`0027`、`0028`、`0031`，术语见 `CONTEXT.md`「bench 评测体系」。

**关键约束**：bench 跑一次可能几小时、且**烧真实模型的钱**。因此必须**后台运行**，用户通过「问进度」触发 agent 查询并反馈，而不是同步阻塞等结果。

## 流程总览

```text
1. 前置检查（环境/模型/臂由 preflight.sh 自动校；agent 判断插件适配度）
2. 冒烟测试（mock-llm，不烧钱）：全部臂 × 全部任务
3. 确定评测矩阵（tasks / configs / model / reps），新臂需先在 arms.json 登记
4. 先导门：--pilot 花 ~25min 确认每个臂能跑通（其 cell 可被全量复用）
5. 后台启动全量 run-matrix.sh，记录 run-id 告知用户
6. 用户问进度 → 查 progress.json + run.log → 反馈
7. 跑完 → 读 analysis-summary.json → 下结论
```

---

## 1. 前置检查

**环境类检查已自动化，不必手写**：`run-matrix.sh` 启动时会先跑 `bench/preflight.sh`，一次校完本机前置条件——`pi` / `git` / `python3` 可执行、`@zenone/*` 本地包就位、`bench/.cache` 可写、指定模型存在于 models-store、**本次 run 的每个臂都能解析到插件**。有缺失即 `exit 2` 并一屏聚合列全（含每项修复提示），**不会跑任何 cell**（见 `docs/adr/0056`、`0057`）。直接启动即可，preflight 会告诉你缺什么。

agent 仍需自己判断的：

- **任务资产存在**：`ls bench/tasks/` 看有哪些任务 slug。
- **模型选择**：`pi --list-models` 列出可用模型，选一个（如 `deepseek/deepseek-v4-flash`）。`run-matrix.sh` **强制 `--model`**，不传报错。
- **插件适配度三问**（`bench/README.md`「选型三问」）：
    1. 它注册工具吗（agent 能主动调用）？不注册 → `plugin_triggered` 恒 null，测不出。
    2. 它的价值能在真实编码任务上体现吗？不能 → delta≈0，纯烧钱。
    3. 能单插件隔离吗？依赖走 node_modules 本地包，或同臂 `+` 组合。
    - 不适配就明确告诉用户「这个插件不适合 bench 评测」+ 原因，不要硬跑。

## 2. 冒烟测试（先跑，不烧钱）

```bash
bash bench/smoke-test.sh            # 全部任务
bash bench/smoke-test.sh --task <slug>   # 单任务（快）
```

冒烟用 mock-llm（自动注入隔离 HOME，不烧钱、不联网），验证骨架全链路 + verify.sh 能正确判 FAIL。它遍历 `bench/arms.json` 里的**全部臂 × 全部任务**（含 `none` 臂——早先只跑 `plugin-mock-llm` 时 `none` 臂专属的 `CFG_FLAGS` 空数组 bug 漏网，全量跑 3h 才发现对照组全废）。**冒烟不过，不要上真实评测。**

## 3. 确定评测矩阵

- **tasks**：默认全部（`bench/tasks/` 下每个目录）；聚焦单个插件可用 `--tasks <slug>`。
- **configs**：配对对比必须是 `none,plugin-<name>`（`none` 是基线，`plugin-<name>` 是被测插件）。插件名 = 目录名（如 `truncated-tool`）或 npm 包名（scoped 包 `/` 会被自动转义为 `__`，config 写全名即可）。
    - **新臂必须先登记到 `bench/arms.json`**——臂是封闭清单，未登记的臂会被 preflight 直接拦下（不会跑到那个 cell 才发现）。登记内容 = 臂名 → 该插件注册的工具名（用于 `plugin_triggered` 判定）：

        ```json
        "plugin-truncated-tool": { "triggerTools": ["rg"] }
        ```

        工具名怎么找：读插件源码里的 `pi.registerTool({ name: '...' })`（如 `rg` / `todo` / `ffgrep`）。不注册工具的插件不适合 bench（见选型三问①）。
- **model**：`pi --list-models` 选一个，**同一轮矩阵内固定一个模型**。
- **reps**：先 `--reps 1` 探路；要统计显著性再加大（成本线性增长）。

## 4. 先导门（`--pilot`，强烈建议）

全量可能烧几小时。先用先导门花 ~25min 确认**每个臂都能跑通**，再上全量：

```bash
bash bench/run-matrix.sh \
  --tasks <slug-a>,<slug-b> --configs none,plugin-<name> --reps 3 \
  --model <provider>/<model-id> --pilot
```

- 跑 **每个臂 × `--tasks` 的第一个任务 × rep0**，然后**停下**，并打印可直接复制的 `--resume` 命令。
- pilot **不跑 analyze**（半量数据上的 delta / 翻转结论会误导插件去留决策），只回答「每个臂能不能跑通」。
- 有 cell 失败即 `exit 1`。
- pilot 与全量**同属一个 run**（`manifest.json` 记录全量配置），所以先导已跑的 cell 会被第 5 步的全量 `--resume` 跳过，**不重复烧钱**。
- 若用户只想先低成本看一眼、暂不上全量，把 pilot 结果（每个臂的 turns/token/reward）报给用户，等他决定。

## 5. 后台启动 + 告知 run-id

```bash
nohup bash bench/run-matrix.sh \
  --tasks <slug> --configs none,plugin-<name> --reps 1 \
  --model <provider>/<model-id> >/dev/null 2>&1 &
```

- `run-matrix.sh` 会把自身输出 **tee 到 `bench/results/<run-id>/run.log`**，并写结构化 **`progress.json`**，无需手动重定向 stdout 也能留档（`>/dev/null` 只是避免 nohup 默认日志干扰）。
- **启动后立刻抓 run-id**：启动输出会打印 `RUN_ID=run-YYYYMMDD-HHMMSS`（在 run.log 开头也能找到）。若丢失，`ls -1t bench/results | head -1` 取最近一次。
- **必须把 run-id 和查进度命令告知用户**，例如：

> 已在后台启动 bench，run-id = `run-20260906-143821`。想查进度就说「查 bench 进度」，跑完我会读报告告诉你插件有没有用。

## 6. 用户问进度 → 查询并反馈

用户说「查进度 / 进度如何 / 还在跑吗」时，执行：

```bash
bash bench/bench-status.sh <run-id>           # 结构化进度（总量/完成/失败 + 每个 cell 状态与阶段）
bash bench/bench-status.sh <run-id> --log 20  # 追加 run.log 尾部
```

**反馈要点**（用自然语言转述，别把原始 JSON 糊给用户）：

- 已完成 N/M 个 cell，当前在跑哪个 cell、处于哪个阶段（clone/agent/metrics/verify）。
- 是否有 cell 失败（`failed cells` 列表），失败原因去对应 `bench/results/<run-id>/<cfg>/<slug>/repN/logs/` 翻。
- 是否已结束（`status: done|failed`）：结束则直接进入第 6 步给结论。

**若 progress.json 还没生成**（刚启动 <1s）或 run 不存在，如实告知，不要编造。

## 7. 跑完 → 下结论

```bash
cat bench/results/<run-id>/analysis-summary.json
```

读 `paired_none_vs_plugin-*` 给出**边际价值结论**（见 `bench/README.md`「度量指标」示例）：

- `median_token_delta` / `median_cost_delta` 为负 = 插件省 token/省钱（正边际价值）。
- `solve_flips_*` + `mcnemar_p` = 解决率翻转是否显著（小样本多为不显著，如实说明）。
- `triggered` / `n_untriggered_excluded` = 插件是否真的被 agent 调用；未触发的 cell 不混入 delta。

**结论必须诚实**：样本量（reps）小时，说「N=1 无法下统计结论，只能看方向」；`plugin_triggered` 全 false 时，说「插件装了但 agent 没用上，可能不适用该任务，而非无效」。

## 8. 中断续跑

运行中断（机器重启 / 进程被杀）后，已完成的 cell 不必重跑：

```bash
bash bench/run-matrix.sh --resume <run-id> \
  --tasks <slug> --configs none,plugin-<name> --reps 1 --model <provider>/<model-id>
```

- 跳过「`result.json` 存在且含 `reward_binary`」的 cell，中断/残缺的默认重跑。
- **续跑配置必须与原 run 完全一致**（tasks/configs/reps/model/thinking），否则拒绝续跑。
- 先导门（第 4 步）跑完后的继续也走这条：`--resume <pilot 的 run-id>` + 全量参数（先导跑过的 rep0 会被跳过）。

---

## 常见坑

| 现象                               | 处置                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------- |
| `--model` 不传报错                 | 用 `pi --list-models` 查，显式传入                                          |
| preflight 报「未注册的 config 臂」 | 该臂没登记在 `bench/arms.json`：加上臂名 + `triggerTools` 再跑（见第 3 步） |
| preflight 报「插件未找到：xxx」    | 臂已登记但插件名解析不到：检查插件名拼写 / npm 包是否已安装                 |
| 插件臂 `plugin_triggered` 恒 null  | 该插件没注册工具，或不适用该任务 → 换插件或换任务                           |
| 冒烟测试失败                       | 骨架或 verify.sh 有问题，先修再上真实（别烧钱）                             |
| 后台跑没输出到终端                 | 正常——输出在 `results/<run-id>/run.log`                                     |
| 查进度报 run 不存在                | run-id 拼写错误，或 `bench/results/` 被清                                   |
