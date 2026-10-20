# bench 编排层：臂注册表与先导门

bench 的「配置臂」一直只是字符串约定：`run-matrix.sh` 的 `--configs` 默认 `none`，`smoke-test.sh` 硬编码 `plugin-mock-llm`，`run-cell.sh` 用 `${CONFIG#plugin-}` + `IFS='+'` 从臂名推导插件名。约定能跑，但三个后果已经显现：**没有「全部臂」的单一来源**——冒烟只跑 `plugin-mock-llm`，`none` 臂从未覆盖，而 `none` 臂专属的 `CFG_FLAGS` 空数组展开 bug 让对照组 token=0 全废；**任务与插件耦合**——`trigger_tools` 挂在 `task.json` 上，语义却是「被测插件注册了什么工具」，一个任务测多插件臂只能上并集 hack，`bench/README.md` 自陈「换测插件时需同步改」；**mock-llm 伪装成臂**——它是测试替身，却作为 `plugin-mock-llm` 占着 config 空间，而 `none` 臂要跑冒烟就必须让它变基座。同时全量与预检没有分层：要「先跑一个小案例」只能手动拼 `run-cell.sh`，一轮 3.5h 跑完才发现要重跑。

决定引入 `bench/arms.json` 把配置臂升为实体，并给编排器加 `--pilot` 先导门。

## 臂注册表

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

- `baseline`：两臂公共基座（非被测变量），`bash-timeout` 从 `run-cell.sh` 的硬编码收进来。
- `arms` 的 key = 臂名；插件名沿用既有推导规则（`plugin-<name>`，`+` 分隔多插件臂），**不新增冗余字段**。
- `triggerTools` 从 `task.json` 下沉到臂：任务恢复与插件正交，并集 hack 消失。
- **臂封闭**：`--configs` 或冒烟里出现未注册臂即 fail-fast——与「强制显式 `--model`」同款思路：宁可报错，不要静默产出触发率不可判定的数据点。

## 先导门

`run-matrix.sh --pilot`：每个臂 × 第一个 task × rep0，跑完**停下**（不跑 `analyze.py`），打印 `--resume` 继续的命令。

关键约束来自 ADR-0031——`--resume` 是**严格配置相等**。所以 pilot 不能是「独立的 `reps=1` 预检 run」：那样 `reps=3` 的全量无法复用它，pilot 的 cell 白烧。pilot 因此是**同一个 run 的前置阶段**——`manifest.json` 照写全量配置，只有执行循环提前结束。

不跑 `analyze.py`：半量数据上出的 delta / 翻转结论会误导插件去留决策，正是 bench 要消灭的假信号。pilot 只回答「臂能不能跑通」。

- **状态**：accepted
- **考虑过的选项**：
    - **不引入注册表**（臂列表由调用方传，`trigger_tools` 留在 `task.json`）——否决。冒烟的「全部臂」与 `triggerTools` 的归属失去落点，并集 hack 继续。
    - **插件自声明 `triggerTools`**（`package.json` 的 `pi.triggerTools`）——否决。仓库内被测插件多数没有 `package.json`（只有 18 个 meta/security/tui 类有），为声明而新建 `package.json` 是本末倒置。
    - **未注册臂回退 + warn**——否决。静默产出 `plugin_triggered: null` 的数据点会混进触发率分母（假信号），且「忘了注册」不会被发现。
    - **`--configs` 缺省值改为全部臂**——否决。忘了传 `--configs` 就跑满全臂是意外烧钱；保持默认 `none`。
    - **pilot 作为独立 run**——否决，见上（严格配置相等使 cell 无法复用）。
    - **pilot 自动继续全量**——否决。pilot 的价值就是「花 25min 看结果，再决定要不要花 3.5h」；自动继续等于没有这个决策点。
    - **pilot 覆盖全部 task × rep0**——否决。pilot 要覆盖的是**每个臂**的加载 / flag 路径，不是任务维度。
    - **扩展 `plugin_triggered` 语义到 UI 效果**——否决。没有客观观测点，容易变成假指标；「纯 UI / 配置类插件不适用 bench」是已记录的边界（`bench/README.md`）。
- **后果**：
    - `preflight.sh` 的 interface 从「任务目录列表」扩为「任务目录列表 + 臂列表」，启动时一次校验全部臂（含 `baseline`）可解析到插件——消灭「跑到该 cell 才发现 `plugin not found`」。
    - `smoke-test.sh` 遍历 `arms.json` 全部臂，`plugin-mock-llm` 臂消失；mock-llm 改由 `BENCH_MOCK_LLM=<path>` 注入公共基座，使 `none` 臂也能不烧钱地跑。
    - `none` 臂的 `plugin_triggered` 由 `false` 变 `null`（语义修正：无目标插件可判定）。`analyze.py` 的配对口径只读 plugin 臂的值，统计零影响。
    - `run-cell.sh` 里 metrics 提取的 python heredoc 抽成 `bench/metrics.py`（可单测），`run-cell.sh` 保持编排者角色。
- **非目标**：
    - 不把「怎么跑」（模型、mock 注入）写进 `arms.json`——它只回答「臂是什么」。
    - 不做 `run-cell.sh` 的完整拆分（checkout / agent / verify 三段不动）。
    - 不引入 `task.json` 的 `requires` 声明（沿用 ADR-0056 的决定）。
