# bench 前置检查：纯自检、聚合报告、两处入口

bench 的环境依赖假设散落在四处，且失败时静默：`run-cell.sh` 用一行 `[ -d /usr/local/go/bin ] && export PATH=...` **静默修补** macOS 非登录 shell 的 Go PATH（不满足条件时什么都不说）；`smoke-test.sh` 查 `command -v git python3 pi`；`run-matrix.sh` 查模型是否存在于 models-store；而 `@zenone/*` 本地包、`node`/`npm`、`bench/.cache` 可写性**无人检查**。`task.json` 的 `language` 字段存在但**无人消费**——任务依赖是隐式的。

这类静默失败已在仓库里留过痕：`run-cell.sh` 的 `CFG_FLAGS` 安全展开注释记录了「对照组 token=0 全废」——`none` 臂的 `pi` 根本没执行，却静默产出空数据。环境侧目前没有同类事故的留档，但**没有任何机制**能在依赖缺失时拦住 `verify.sh` 静默判 0。

决定新增 `bench/preflight.sh` 作为唯一的前置检查 module，把环境就绪检查前移到跑任何 cell 之前：

```text
bash bench/preflight.sh [--arms <a,b,c>] <task-dir>...
    exit 0   — 全部就绪
    exit 2   — 有缺失；stderr 聚合列出全部缺失项 + 每项一句修复提示
```

> `--arms` 由 ADR-0057 追加：臂注册表（`bench/arms.json`）落地后，「本次 run 的每个臂能否解析到插件」也纳入启动时一次校完——否则要跑到那个 cell 才发现 `plugin not found`。

- **状态**：accepted
- **六项决策**：
    1. **纯自检（check-only）**：只回答「依赖在不在」，缺失即 fail-fast；**不预热、不安装**。本轮痛点是「缺失静默失败」（check 直接消灭），不是「未预热导致慢」（prepare 才管）。
    2. **检查项两层**：框架级内置（不随任务变）+ 任务级按 `task.json` 已有的 `language` 字段映射（`go → go`、`typescript → node, npm`），读本次 run 的任务集合取并集。**不新增 `requires` schema**。
    3. **框架级 6 项，不查远端**：`pi` / `python3` / `git` 可执行；指定 model 存在于 models-store；`bench/.cache` 可读写；`@zenone/*` 本地包就位。远端可达性**不查**——它的失败是显式的（`git clone` 报错，第一个 cell 就暴露），且探测远端要发真实请求，会捅破 check-only 边界。
    4. **两处入口**：`run-matrix.sh` 启动时传全部任务（一次全量，5 秒 fail-fast）；`run-cell.sh` 传自己那一个任务（保护冒烟 / 调试 / 复现这条独立入口——`smoke-test.sh` 直接调 `run-cell.sh`，绕开 `run-matrix.sh`）。preflight 的 interface 是「接受任务目录列表」，传 1 个或 N 个走同一份逻辑。
    5. **聚合报告**：跑完全部检查项，一屏列出全部缺失项，再统一 `exit 2`。「fail-fast」指在跑 cell **之前**失败，不是第一个错误就退。
    6. **独立可执行 bash 脚本**：`bench/preflight.sh`，与 `run-cell.sh`/`run-matrix.sh` 平级。必须用 **bash** 而非 python——它要检查 `python3` 是否存在，自身若是 python 写的会自锁。
- **考虑过的选项**：
    - **预热（check + prepare）**——否决。预热本质是性能优化（省几分钟），check 是正确性保障（省 3.5 小时）；且预热会引入「预热到一半失败」的残留状态。日后若发现预热显著省时，作为独立增量加。
    - **固定全量检查表**——否决。只跑 superjson 却因缺 `go` 而 fail，是假阳性阻塞。
    - **新增 `task.json` 的 `requires` 声明**——否决（YAGNI）。`language` 字段已存在且覆盖当前两个任务的依赖；`requires` 只在任务需要 `language` 之外的工具时才更强。
    - **总是查远端可达**——否决。`.cache` 命中、完全不需要网络的 run 会被拦（假阳性）。**条件查远端**（仅 cache miss 时）——否决，把条件逻辑塞进 preflight。网络挂起（TCP 超时）归 git 层超时解决。
    - **只在 `run-matrix.sh` 检查**——否决。冒烟 / 调试路径（直接调 `run-cell.sh`）裸奔，而冒烟恰是 bug 漏网处。**只在 `run-cell.sh` 检查**——否决，任务 2 的依赖缺失要等到 cell 2 才开始才发现。
    - **首个即退**——否决。本轮场景本就可能同时缺多项（`go` + `@zenone/*` + `.cache`），首个即退要「修一个 → 跑一次」往返多轮。
    - **`source` 函数库**——否决。bash 无 export 语义，public/private 模糊；独立调试还要另写包装。
- **非目标**（显式不做的）：
    - 不预热、不安装依赖
    - 不查远端可达性
    - 不新增 `task.json` schema
    - 不充当「冒烟门槛（Smoke Gate）」——后者是案例**入库**的门，preflight 是**每次运行**的门
- **后果**：
    - `run-matrix.sh` 的模型校验（见 ADR-0031）与 `smoke-test.sh` 的 `git/python3/pi` 检查**收进 `preflight.sh`**，消除两处散落。
    - `@zenone/*` 检查是**无条件**的：公共基座 `bash-timeout` 自身 import `@zenone/pi-config` 与 `@zenone/pi-logger`，两个臂（含 `none`）都加载它——`@zenone` 缺失时连 `none` 臂都会炸。
    - 「任务三件套声明工具链依赖」（`task.json` 加 `requires`）暂缓；重启条件：出现 `language` 无法表达的工具依赖（protoc / make / 特定 CLI）。
    - 新增语言任务时，`preflight.sh` 加一行映射即可，不改任何调用方。
    - 无单测（bash 不如 python 好测），靠 e2e 覆盖：造一个缺 `go` 的环境，验证 fail-fast + 列出该项。
