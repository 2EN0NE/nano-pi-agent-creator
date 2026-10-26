# Agent Notes

## 项目基本原则

### 1. 如涉及基础设施改造，完成后需询问是否同步AGENTS.md和README.md说明

正例：如设置logger为所有模块提供日志支撑，logger体系创建或用法修改后，要问用户是否检查AGENTS.md是否涉及这一块的说明，是否要把extensions创建要求更新；
反例：创建一个展示辅助模块（不影响其他模块），在未询问我的建议的情况下，就擅自把这个功能的说明加入了AGENTS.md或README.md

### 2. 完成任务后，要把端到端集成测试完成，同步到该去的地方让用户测试

详见技能 [`e2e-test`](skills/e2e-test/SKILL.md)，测试基础设施在 [`test/`](test/)。

#### 测试分层原则

所有扩展测试分两层，按 mock 边界严格区分：

```
test/vitest/  — 单元 + 组件测试（headless）
    Mock:  MockTerminal, 内存 sessionManager, 手造 annotate, mock keybindings
    目标:  快速验证逻辑正确性（渲染布局、API 生命周期、handleInput 调用）
    时长:  <30s，每次 commit 运行
    约束:  不测 Pi runtime 行为（pi.appendEntry / pi.setLabel / 真实 key dispatch）

test/e2e/     — 集成端到端测试（真实 Pi）
    Mock:  仅 LLM API（mock-llm）
    目标:  验证扩展在真实 Pi 进程中的行为
    时长:  **硬预算 ≤5min/插件**（默认 300s，超预算判失败），CI + 提交前手动运行
    约束:  每个测试只 mock 大模型服务商，其他 Pi API 均走真实路径
```

> **铁律**：`test/e2e/` 下的所有测试，如果 mock 了 LLM 以外的任何 Pi API（sessionManager、annotate、keybinding），视为不合规。

> **铁律（耗时与可观测）**：单插件 e2e **总耗时硬预算 300s**（`E2E_EXT_BUDGET_SEC` / `--ext-budget` 可覆盖，`0` 仅排障），
> 超出即判失败——要么用例挂起/等待异常，要么冗余需精简。每条 TUI 用例必须留下可定位的**过程日志**
> （`[tui-stage]` 阶段计时；合并用例用 `STEP_BEGIN`/`STEP_OK`/`FAIL_MARKER`），
> 结果统计必须**文件驱动**（不得依赖跨子 shell 的内存变量）。
> 规范与排查清单：[`docs/e2e-performance.md`](docs/e2e-performance.md)。

详见 ADR：[`docs/adr/0004-tui-e2e-layered-testing.md`](docs/adr/0004-tui-e2e-layered-testing.md)。

#### 路径 A：Vitest 单元/组件测试（test/vitest/）

基于 TypeScript 的快速测试，mock 所有 Pi API。

```bash
# 运行全部 Vitest 测试
npm test

# 监听模式（开发使用）
npm run test:watch
```

编写示例见 `test/vitest/extensions/pi-logger.test.ts`。

> ⚠️ **worktree 系 vitest 用例**（`test/vitest/extensions/worktree*.test.ts`）会执行真实 git 操作
> （worktree/merge/rebase），与 `git commit` 环境冲突：pre-commit 的 `npm test` 会排除它们，
> 但 **pre-push / CI 必须全量跑**（CI `e2e-worktree` job 跑 `worktree*.test.ts` 全 glob）。

#### 路径 B：bash/expect 集成 e2e 测试（test/e2e/）

真实 Pi 进程，仅 mock LLM。传统 bash（print 模式）+ `expect` 脚本（TUI 按键交互）。

```bash
# 运行指定扩展
bash test/e2e/scripts/run-e2e.sh --ext pi-logger
bash test/e2e/scripts/run-e2e.sh --ext pi-session-tree

# CI 模式（自动注入 mock-llm，无需 API Key）
CI=true bash test/e2e/scripts/run-e2e.sh --ext pi-logger

# 查看结果
LATEST=$(ls -1t test/results/ | head -1)
cat test/results/$LATEST/summary.md
```

> **运行基座留痕与来源（ADR-0063）**：e2e 跑的是**基座版本**——`scripts/setup-ci.sh` 从
> `node_modules/@earendil-works/pi-coding-agent/package.json` 读版本再全局安装（读不到即
> fail-fast）；`PIPELINE=<版本>` 已降级为**显式覆盖开关**（不再是默认 `latest`）。
> 每次运行在启动横幅打印 `pi runtime base: <版本> (<路径>)`，并写入 `summary.json` 的
> `pi_version` / `pi_path`；vitest 的 TUI 用例（`resolvePiBin()`）默认锚到
> `<repo>/node_modules/.bin/pi` 并打印 `[pi-bin] <路径> → <版本>`。要用全局新版试一次，
> 显式 `PI_BIN="$(command -v pi)"`。**版本只留痕、不作阻塞断言**（上游发版不阻塞合并）。

> **CI 分片语义（改 `ci.yml` 的 e2e job 前必读）**：分片按模块名确定性 hash 分桶
> （`run-e2e.sh` 的 `_shard_match`），**不写硬编码模块清单**——新增模块一定落在某个 shard 上。
> 唯一允许不在矩阵里跑的是显式 `--exclude` 的模块（当前：`worktree` / `permission-gate`，
> 各自有专用 job）。CI 还设 `E2E_BUDGET_STRICT=1`：耗时超插件预算**一律判失败**，不降级为 WARN。

#### 验证流程

1. 确定变更影响范围（扩展/技能/基础设施）
2. 运行 Vitest（`npm test`）+ 受影响模块的 e2e（`run-e2e.sh`）
3. 查看结果汇总，对 `[REVIEW]` 用例逐条 AI 衡量（≤20 条全量，>20 条建议手动）
4. 确认所有用例通过后，同步到用户目录，再告知完成

#### Pi 启动参数约定（e2e 测试与调试）

启动 pi 做 e2e 测试或任何调试时，**如非必要一律加 `--no-session`**（不落历史会话记录，避免污染会话树、残留测试数据）。

**例外**：当确实需要对话记录来定位或验证问题时（如验证会话持久化、分析 session 树、复现依赖历史上下文的行为），可以不加 `--no-session`。

- 反例：随手 `pi -a -p "hi"` 做冒烟，却留下一条无意义的历史会话
- 正例：调试跨会话持久化行为，需要真实会话文件 → 不加 `--no-session`

#### Husky Hook 体系

项目使用 husky v9 管理 git hooks，按分层策略组织：**CI 是绝对标准（全部阻塞），本地 hook 轻重分层对齐 CI，但跳过耗时步骤。**

| 层             | 触发时机     | 耗时 | format:check | typecheck            | lint/eslint + config 锚点          | test (vitest) | e2e                 | semgrep       |
| -------------- | ------------ | ---- | ------------ | -------------------- | ---------------------------------- | ------------- | ------------------- | ------------- |
| **CI**         | `git push`   | 全量 | ✅ 阻塞      | ✅ 阻塞              | ✅ 阻塞（含 `lint:config:anchor`） | ✅ 阻塞       | ✅ 阻塞（分片矩阵） | ✅ ERROR 阻塞 |
| **pre-push**   | `git push`   | 中   | —            | ✅ 有 .ts 变更时阻塞 | ✅ 仅 config 锚点                  | ✅ 阻塞       | ✅ 仅变更 + 金丝雀  | —             |
| **pre-commit** | `git commit` | ~5s  | ✅ 阻塞      | —                    | ✅ auto-fix 仅 staged              | ✅ 阻塞       | —                   | —             |

> CI `config-compliance` job 里 **`npm run lint:config:anchor` 是阻塞项**（仓库级配置必须显式锚仓库根，见
> 「[项目级配置的解析锚点](#项目级配置的解析锚点仓库级-vs-目录级强制判断)」）；历史欠账较多的 `lint:config`（规则 1/2）仍为 WARN。

**① pre-commit：提交前轻量校验（`.husky/pre-commit`）**

只跑快速检查（~5s），重量级留给 pre-push 和 CI：

1. **`lint-staged`** — 对 staged 文件自动运行 `prettier --write` + `eslint --fix`
2. **`format:check`** — `prettier --check .` 全局格式校验（prettier ~2s，对齐 CI `format` job）
3. **`npm test`** — Vitest 单元测试（对齐 CI `unit-tests` job）

```bash
# 手动触发 pre-commit 测试
npx husky run pre-commit
```

**② pre-push：推送前较重校验（`.husky/pre-push`）**

1. **`typecheck`** — 仅当有 `.ts/.tsx` 变更时运行 `tsc --noEmit`（阻塞，对齐 CI）
2. **`lint:config:anchor`** — 仅当有 `.ts/.tsx` 变更时运行（阻塞，对齐 CI `config-compliance` job）
3. **`npm test`** — Vitest 单元测试（阻塞，对齐 CI `unit-tests` job）
4. **e2e 测试** — 自动检测本次推送变更的扩展/技能，只运行受影响模块
5. **e2e 金丝雀** — 当 `test/e2e/scripts/*` 或 `test/e2e/helpers/*`（运行器/助手）变更时，额外跑
   `--shard 0/8` 代表分片：运行器变更影响**所有**模块，但逐个跑全量太慢，用一片当金丝雀抓
   全局性回归（脚本语法、参数解析、分片选择、沙箱/expect 助手失效）。全量由 CI 分片矩阵覆盖。

```bash
# 修改 extensions/auto/loop.ts → 推送前自动运行:
bash test/e2e/scripts/run-e2e.sh --ext loop
```

> pre-commit 是 `git commit` 时触发，pre-push 是 `git push` 时触发。若需要跳过 hook 使用 `--no-verify` 参数。
>
> **⚠️ 对 coding agent 的约束**：本项目的 commit/sync 工具和 ci-watch 修复流程中，prompt 已约束 agent 不得使用 `--no-verify` 跳过 hook。如需手动维护，请在 commit 前确保 `npm run format:check && npm run typecheck` 通过。

### 除非用户在最后一次对话中明确指明要你git操作，不要做任何改变git状态的操作

用户提到的commit、提交等词语说的是git操作，需要以中文作为主要语言进行。但仅对最后一次说话有效，后续再修改的操作，不要越俎代庖帮用户自动git commit了，每一次git改变状态的操作1）只限定在用户最后一次对话的一轮行动中；2）如果你想主动做，都要和用户确认。

- 正例：用户在最后一次对话中指明“请帮我提交此次变更”，你从对话中识别到针对什么插件进行了哪些文件的改动，从git status中把相应改变的文件进行add，剔除了不相关的文件（其他之前staged的不相干的文件剔除，本次对话产生的一些临时性文件加入了.gitignore），然后按过去的commit规范以中文提交了（可使用项目中的commit技能）
- 反例：用户在前一轮对话说过“帮我提交”，这一轮是要我修改错误，没有在话语中提到“帮我提交”，就默认为修改完的要提交，自动commit -a合并了。

### 临时产物与 pi-rewind 可记录性（本项目）

本仓库启用 project-profile 的 pi-rewind 扩展（`.pi/extensions/pi-rewind`），自动 checkpoint 覆盖的**只有会话 cwd（本项目根）内、未被排除的文件**；cwd 之外的改动（`/tmp`、`~`、其它 worktree 等）**不会被 checkpoint 记录，也无法 `/rewind` 回滚**（详见 ADR-0038「范围边界」）。

因此，在本项目工作时遵循：

1. **希望有记录 / 可回滚的产物，一律放在项目（cwd）内**。不要在 cwd 外（尤其系统 `/tmp`）留下「想找回」的中间产物——pi-rewind 管不到。
2. 确需在项目内建临时目录时，用**已被 `.gitignore` 忽略的目录**（`tmp/`、`temp/`、`.scratch/` 等，见根 `.gitignore`）：真实 git 与 pi-rewind 的 untracked 快照都不会纳入，`git status` 保持干净、快照无噪声。
3. 若临时物只是「跑完即弃」，放 cwd 外亦可（不在安全网承诺内）；但涉及要回滚验证/留痕的，回到规则 1。

> 配套：根 `.gitignore` 含 `/tmp/` `/temp/`（项目内同名临时目录已被忽略）；如需新增同类目录，先在 `.gitignore` 登记再使用。

## 扩展开发

Pi 扩展放在 [extensions](extensions) 目录中；修改时请在这里更新。若需要参考内部实现，可查看 `pi-mono`，但不要改动其源码。

### 扩展分类体系

`extensions/` 按功能分为 8 个子目录，新扩展必须归入对应分类，不得放回顶层：

| 目录             | 分类                         | 说明                                                                                                                                                                                                                                                                   |
| ---------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tui/`           | 交互界面                     | 提供终端交互式 UI 的插件（命令面板、选择器、编辑器等）                                                                                                                                                                                                                 |
| `context/`       | 上下文组装                   | 修改/增强/组装 system prompt 或会话上下文的插件                                                                                                                                                                                                                        |
| `security/`      | 审计与安全                   | 提供安全保护、审计、权限控制的插件                                                                                                                                                                                                                                     |
| `auto/`          | 自动化                       | 自动执行任务的插件，无需或少量用户交互                                                                                                                                                                                                                                 |
| `accuracy/`      | 更精准强大信息获取与操作工具 | 增强或替换内置工具，提供更强大/精准的操作能力                                                                                                                                                                                                                          |
| `verification/`  | 验证与评估                   | 代码审查、质量评估、验证检查的插件                                                                                                                                                                                                                                     |
| `observability/` | 观察分析                     | 以观测/分析 pi 自身（插件、工具、skill、会话）的运行与效果为核心目的的插件（如会话用量分析面板、指标采集）                                                                                                                                                             |
| `meta/`          | 元插件                       | 管理其他插件/工具的插件、管理预设配置的插件，以及提供基础服务的插件。注意这里面的插件设计定位是最基础层的，其他插件可以依赖这里面的插件，这里面的插件应避免依赖其他类别的插件。npm install应把这里面的插件变为本地包，其他插件对其的依赖通过包引用，而不是相对路径引用 |

**分类原则：**

- 按插件**核心功能**归类，一个插件只放入一个目录
- 如果插件有多个功能维度，以其主要目的为准
- 新增扩展时，先判断属于哪个分类，创建对应的 `.ts` 文件或目录放入对应子目录
- 不允许直接在 `extensions/` 顶层添加文件（顶层仅保留分类子目录）

**开发示例：**

```bash
# 添加一个新 TUI 插件
touch extensions/tui/my-picker.ts

# 添加一个新的自动化插件（目录形式，带 index.ts）
mkdir -p extensions/auto/my-watcher
touch extensions/auto/my-watcher/index.ts
```

> ⚠️ **注意**：`pi-logger/` 虽然本质是基础设施，但它是作为 Pi 扩展机制实现的，因此归入 `meta/`（元插件）。`pi-rate-limiter/`（限流）和 `control/`（会话控制）属于自动化/特殊场景插件，归入 `auto/`。

### 日志接入要求

所有新建或修改的扩展**必须接入 pi-logger 统一日志体系**，禁止使用裸 `console.log/error`。

接入方式：

```typescript
import { createLogger } from '@zenone/pi-logger';

const log = createLogger('your-extension-name');

// 使用：
log.info('信息');
log.debug('详情');
log.warn('警告');
log.error('错误');
```

> ⚠️ **本地依赖说明**：`@zenone/pi-logger` 是一个本地 npm 包，不会发布到 npm registry。
> 在新电脑上 clone 本工程后，需要先执行以下命令使其可用：
>
> ```bash
> # 在工程根目录执行（已在 package.json 中声明为 devDependency）
> npm install
> ```
>
> 这会从 `extensions/pi-logger/` 通过 `file:` 协议安装到 `node_modules/` 下，
> 使得 jiti（pi 的扩展加载器）可以解析 `import { createLogger } from "@zenone/pi-logger"`。

日志输出由 pi-logger 的配置文件统一管控（`pi-logger.json`），扩展本身无需关心输出目的地和级别过滤。详细说明见 [pi-logger 内嵌技能](extensions/meta/pi-logger/skills/pi-logger/SKILL.md)

### 扩展的配置文件设计

所有扩展的配置文件采用**标准化双层路径**，由 `@zenone/pi-config` 提供统一访问 API：

```
用户级：~/.pi/agent/extensions-data/<plugin-name>/config.json
项目级：<cwd>/.pi/extensions-data/<plugin-name>/config.json
```

**合并规则**：项目级覆盖用户级，用户级覆盖内置默认值。

#### 标准配置 API

所有新扩展和迁移扩展，必须使用 `@zenone/pi-config` 管理配置（禁止手写文件路径拼接、自定义 deepMerge、raw JSON 读取）：

```typescript
import { createConfigStore } from '@zenone/pi-config';
import type { ConfigStore } from '@zenone/pi-config';

interface MyConfig {
	param1: string;
	param2: number;
}

const store: ConfigStore<MyConfig> = createConfigStore<MyConfig>({
	pluginName: 'my-plugin', // extensions-data/{plugin-name}/
	defaults: { param1: 'a', param2: 42 },
	// sessionScoped: true,     // 可选：启用会话级覆盖
});

// 读取（自动分2层合并 + 缓存）
const config = store.get();

// 保存
store.save({ param1: 'b', param2: 99 }, 'user');

// 刷新缓存
store.reload();
```

该模块自动处理：双层路径解析、原子写入（tmp+rename）、JSON 读写、深合并、cache。

可用函数：

| API                                     | 用途                                     |
| --------------------------------------- | ---------------------------------------- |
| `resolveConfigPaths(pluginName, opts?)` | 获取用户/项目级的文件/目录路径           |
| `deepMerge(base, overlay)`              | 纯对象深合并（数组替换、undefined 跳过） |
| `readJsonFile(path)`                    | 安全读 JSON，失败返回 null               |
| `writeJsonAtomic(path, data)`           | 原子写入（tmp+rename）                   |
| `loadLayeredConfig<T>(opts)`            | 一次性分层加载（不含缓存）               |
| `createConfigStore<T>(opts)`            | 返回带缓存的 ConfigStore<T>（推荐）      |

#### 项目级配置的解析锚点：仓库级 vs 目录级【强制判断】

`@zenone/pi-config` 的项目级层默认锚在**会话 cwd**（`<cwd>/.pi/extensions-data/<plugin>/config.json`）。

**判断规则**：配置描述的是**仓库**还是**当前目录**？

| 配置描述的对象                      | 锚点                     | 写法                                        |
| ----------------------------------- | ------------------------ | ------------------------------------------- |
| 仓库（worktree 花名册、仓库级策略） | **git 仓库根**（强制）   | `createConfigStore({ cwd: repoRoot, ... })` |
| 当前目录（目录作用域策略）          | 会话 cwd（默认，不要动） | `createConfigStore({ ... })`（见 ADR-0059） |

`repoRoot` 用 `git rev-parse --path-format=absolute --git-common-dir` 推导（其父目录即主仓库根，**在 worktree 内也有效**；pi-worktree 的 `getRepoRoot()` 即此实现）。**不要**用 `--show-toplevel`：它在 worktree 内返回的是 worktree 自身。

**为什么必须锚到仓库根**：`.pi/` 通常被 gitignore，git worktree **各自持有独立 `.pi/`**——主仓库的项目级配置在成员 worktree 里**不可见**。锚在 `ctx.cwd` 会导致：① 在 worktree / 子目录里读不到仓库级配置；② 同一份声明要在每个 worktree 各配一遍。

**副作用（需知情接受）**：该 `config.json` 变成主仓库与所有 worktree **共享**——偏好类字段（如「上次选择的策略」）从「每个 cwd 各存各的」变为「全仓库一致」。

**门禁（自动化，别只靠人记）**：`npm run lint:config:anchor`（`scripts/check-config-compliance.ts --anchor --error`）检查下列**仓库级配置消费者**白名单里的每个配置解析点：

| 要求                                     | 写法                                                        |
| ---------------------------------------- | ----------------------------------------------------------- |
| 显式锚仓库根                             | `{ cwd: repoRoot }`（值不得是 `process.cwd()` / `ctx.cwd`） |
| 或显式声明目录作用域（偏好类配置才允许） | 调用点上方写 `// config-scope: session-cwd`                 |

该门禁在 CI `config-compliance` job 与 pre-push 中**阻塞**。新增仓库级配置消费者时，把扩展路径加进 `scripts/check-config-compliance.ts` 的 `REPO_SCOPED_CONFIG_CONSUMERS` 白名单。

> 首个采用者：pi-worktree 的「Worktree 组」声明（2026-09，`CONTEXT.md` 术语 `Worktree 组`）。

> ⚠️ **pi-logger 例外**：pi-logger 是其他扩展依赖的基础设施，为避免循环依赖，保留自身配置加载机制，但搜索路径已对齐到标准 `extensions-data/pi-logger/config.json`。

详细 API 说明见 [`extensions/meta/pi-config/README.md`](extensions/meta/pi-config/README.md)。

### 扩展的内嵌 skill 约定

扩展可以自带 agent 技能（skill），使"技能跟着插件走"（ADR-0022）。约定：

- **位置**：技能放在扩展目录的 `skills/<skillName>/SKILL.md` 子目录下。
- **声明**：扩展根 `package.json` 必须有 `pi` manifest，声明 `pi.extensions`（扩展入口）与内嵌技能目录（为将来 npm 包化分发做准备）。技能有**两种分发方式**：
    - **默认（安装式）**：用 `pi.skills` 声明内嵌技能目录，由 sync 工具装进目标 `skills/`，所有 pi 会话可见（适合“基础能力/普遍适用”的技能，如 `pi-logger`）。
    - **运行期贡献式（例外）**：**不声明 `pi.skills`**，技能随扩展目录一起分发，由扩展在 `resources_discover` 事件里按条件贡献路径（`skillPaths`），仅特定进程可见。适用场景：技能**不应全局可见**、且需按上下文/角色门控（如 `org` 的在岗技能，见 ADR-0042 D4）。此方式下技能目录必须与扩展入口同目录下的 `skills/`，扩展用 `import.meta.url` 定位。

默认（安装式，大多数扩展适用）：

```json
{
	"name": "my-extension",
	"type": "module",
	"pi": {
		"extensions": ["./index.ts"],
		"skills": ["./skills"]
	}
}
```

运行期贡献式（例外；省略 `skills` 字段，技能仅在 `resources_discover` 被贡献时可见，如 `extensions/auto/org`）。

- **发现**：sync 工具同步扩展时，自动读取 `pi.skills`，把声明目录下每个含 `SKILL.md` 的子目录作为内嵌技能同步到目标 `skills/` 目录——**无需在 sync-profiles.yaml 的 skills 列表中再列一遍**（内嵌技能随扩展走：扩展属于哪个 profile，技能就同步到哪个 profile）。未声明 `pi.skills`（运行期贡献式）的扩展，其 `skills/` 不装进目标 `skills/`，但依旧随扩展目录整体拷贝，由扩展运行期 `resources_discover` 自行贡献。
- **命名**：内嵌技能名 = 目录名（与官方 package 语义一致）。若与 `skills/` 顶层的同名技能冲突，sync 工具 fail-fast 报错，不静默覆盖。
- **受众**：内嵌技能面向 agent（模型），教 agent 何时/如何使用该扩展，而非面向终端用户的安装/配置说明。

> 现状：`pi-logger` 已迁移为内嵌技能；`e2e-test` 是纯技能（无对应扩展），留在 `skills/tooling/` 不变。

### 扩展的快捷键设计

建议以alt（option)+插件英文首字母或关联字母为插件相关快捷键，一个插件不应占用太多快捷键，建议一个插件有众多功能都需要分配快捷键时，采用二级组合按键的形式进行设计。

### preset 策略源与子工具锁定（ADR-0049）【强制】

`preset` 是 tools / skills / instructions 三个维度的**唯一策略声明者**；`/tools`、`/skills`、`/prompt` 是它的**子工具**（执行臂），三者均由 preset 插件注册（`extensions/meta/preset/`）。硬约束：

- **preset 激活 = 硬约束 + 子工具锁死**。激活期间 `/tools`、`/skills`、`/prompt` 的写操作一律**拒绝并告警**（读视图仍可用）；要改配置只能通过 `/preset` 编辑/切换，或先清除预设。ADR-0035 的「默认不锁定、偏离仅提示」语义被取代（**激活即锁定**）。
- **无 preset（none）= 不施加任何限制**。三轴回到「无策略」默认：**工具回到默认工具选择**（pi 的 `defaultTools` 解析 ∪ 非内置工具，ADR-0065）、技能不限制、无 preset instructions。清除预设与任何恢复路径（`/reload`、`session_tree`、分支恢复）**不得复活**上一次的约束。
- **tools 白名单是封闭集**。preset 激活且声明了 `tools` 时，运行时新注册的工具（org / MCP 等）一律视为禁用，`/tools` 视图同样显示为**不可用**；要启用须写进该 preset 的 `tools`。
- **preset 不得污染长期工具状态**（ADR-0065）。preset 不持有任何"基础层"快照；`/tools` 手改直接写 pi 的活动集（由 pi 记录），清除/切换 preset 一律复位到**默认工具选择**。任何扩展**不得**从 `pi.getActiveTools()` 反推禁用集（pi 1.4 的装载清单会在扩展 `session_start` 之前恢复，反推必然把上一次 preset 的限制固化）。
- **会话恢复只认 preset 状态**。`preset-state` entry 的 `name: null` = 已清除 → 复位到默认工具选择；有 name = 仍激活 → 重放白名单；**无记录 = 不干预** pi（保护 `--no-builtin-tools` / `--tools -name` 等启动修饰）。
- **限制权只有两个来源：preset 与三个子工具**。其它扩展 / 实验**不得**用 `pi.setActiveTools()` 或写 `disabledTools` 去缩减活动工具集，只能观测/记录；`registerTool` 的动态注册不算限制（属 pi 的基础启用行为，在封闭集 preset 下由 overlay 遮罩）。`tool-range` 实验按 B2：默认只记录，用户显式报名后才按其臂收紧活动集（不落长期状态），preset 激活时退避（ADR-0050 / ADR-0065）。
- **必须有语义级 e2e 保护**（仅"无报错 / 退出码"不算）：① 激活带 `tools` 的 preset 后 `/tools` 视图 == preset 白名单；② 清除 preset 后工具/技能恢复无限制（`bash` 可调用）；③ `/reload` 后不复活已清除的 preset；④ 动态注册工具在激活的封闭集 preset 下不可用；⑤ **resume 复位**：已清除 → 工具回到默认工具选择；仍激活 → 保持白名单（探针 `test/e2e/helpers/tools-probe.ts`）。

> 术语见 `CONTEXT.md`「preset 预设」节；决策与实现契约见 `docs/adr/0049-preset-hard-policy-source-and-subtool-lock.md`、`docs/adr/0050-active-toolset-ownership-and-restriction-authority.md`；**工具权威与复位语义以 `docs/adr/0065-tool-authority-and-default-tool-selection.md` 为准**（它修正了 0049 的"两层"假设与 0050 的"两个来源"）。

### 测试辅助扩展（跨扩展交互测试）

当测试的扩展需要与其它扩展交互（如 tools.ts 拦截动态注册工具），可编写专用测试辅助扩展。

**约定：** 测试辅助扩展放在 `test/extensions/<target>/helpers/` 目录下。

#### Mock LLM 测试辅助扩展

一种特殊的测试辅助扩展是 **mock-llm**，用于在 e2e 测试中替代真实 LLM API 调用。实现原理：

1. 使用 `@earendil-works/pi-ai` 内置的 `registerFauxProvider()` 创建虚假 provider
2. 通过 `pi.registerProvider(name, config)` 将模型注册到 ModelRegistry
3. 在 `session_start` 中用 `pi.setModel()` 切换到 mock 模型

**关键实现要点：**

```typescript
// 注意：registerFauxProvider 只在 `@earendil-works/pi-ai/compat` 子路径导出，
// 主入口 `@earendil-works/pi-ai` 无此导出（会导致类型推断为 any）。
import {
	registerFauxProvider,
	fauxAssistantMessage,
	fauxToolCall,
} from '@earendil-works/pi-ai/compat';
import type { ExtensionAPI, ProviderConfig } from '@earendil-works/pi-coding-agent';

export default function (pi: ExtensionAPI) {
	const faux = registerFauxProvider({
		provider: 'mock-llm',
		models: [{ id: 'mock-model-1', name: 'Mock Model' }],
	});
	// registerFauxProvider 已内部注册 streamSimple，无需额外传入
	// 只需将模型注册到 ModelRegistry 使 ctx.modelRegistry.find() 可用
	pi.registerProvider('mock-llm', {
		name: 'Mock LLM Provider',
		api: faux.api as ProviderConfig['api'],
		baseUrl: 'http://localhost:0',
		apiKey: 'mock-key-noop',
		models: faux.models.map((m) => ({
			id: m.id,
			name: m.name ?? m.id,
			api: faux.api as ProviderConfig['api'],
			provider: 'mock-llm',
			apiKey: 'mock-key-noop',
			baseUrl: 'http://localhost:0',
			input: m.input ?? (['text', 'image'] as const),
			reasoning: m.reasoning ?? false,
		})),
	});
	faux.setResponses([fauxAssistantMessage('Mock LLM is ready.')]);
	pi.on('session_start', async (_event, ctx) => {
		const model = ctx.modelRegistry.find('mock-llm', 'mock-model-1');
		if (model) await pi.setModel(model);
	});
}
```

**在 smoke 测试中使用：** 因 mock-llm 在 `test/` 下，需手动搭建沙箱 + HOME 隔离：

```bash
mkdir -p "$test_home/.pi/extensions/mock-llm"
cp "$ROOT_DIR/test/extensions/<target>/helpers/mock-llm.ts" \
  "$test_home/.pi/extensions/mock-llm/index.ts"
HOME="$test_home/home" pi -a --no-session -p "hi"
```

**完整示例：** `test/extensions/pi-rate-limiter/smoke.test.sh`

**环境变量（可叠加）：**

| 变量                        | 作用                                                                       |
| --------------------------- | -------------------------------------------------------------------------- |
| `MOCK_LLM_REPEAT=N`         | 补足 N 个相同响应，构造多条消息的稳定长树（>20 节点触发滚动路径）          |
| `MOCK_LLM_TOOL_CALLS=N`     | 前 N 轮返回 bash 工具调用（echo），让 agent 执行产生多轮 entry             |
| `MOCK_LLM_RECORD_CONTEXT=1` | 记录每次请求的 provider 序列化 context 到 stdout，供断言「LLM 收到零文本」 |

**压缩/继续类集成链路必须用 TUI 模式验证。** 两个关键事实：

1. `ctx.compact()` 是 fire-and-forget——`-p`（打印模式）下 pi 处理完 prompt 立即退出，
   摘要→onComplete 异步链来不及完成，日志只见「触发信号」、无 onComplete/onError。
   只有 `pi -a`（TUI 交互模式，pi 不退出）才能确定性验证压缩完成 + auto-continue。
   `--no-session` **不影响**这条链路（内存会话同样有 branch，`prepareCompaction` 照常返回 preparation）：
   实测 `pi -a --no-session` 连发 12 条 prompt 一样压缩成功并 auto-continue，故按
   「Pi 启动参数约定」默认加 `--no-session` 即可。真正的不确定项是 `-p`（打印模式处理完即退出）。
2. Pi 的 `prepareCompaction` 用 `keepRecentTokens=20000` 从后往前累积找切分点。
   **单条超长 user 消息会把切分点顶到第一条消息**，`messagesToSummarize` 为空
   （报 "Nothing to compact"）。要触发成功压缩，需**多条 user 消息**（每条 <20000
   tokens，累积 >20000）让切分点落在中间——可通过连续发多个 prompt，或用
   `MOCK_LLM_TOOL_CALLS` 叠加 `MOCK_LLM_RECORD_CONTEXT` 让工具调用积累多轮 entry。

完整链路用例参考：`test/e2e/extensions/custom-compaction/tui-expect.smoke.test.sh`
的「invisible continue full chain」用例。

详见 [e2e-test 技能的 Mock LLM 测试章节](.pi/skills/e2e-test/SKILL.md#mock-llm-测试)。

#### TUI 模式测试

工程支持 **TUI 交互模式测试**。对使用 `ctx.ui.custom()`、覆盖层、选择器等 TUI 功能的扩展，应编写 TUI 测试。

**和普通测试的区别：**

| 维度     | 普通测试 (smoke.test.sh)     | TUI 测试 (tui-expect.smoke.test.sh) |
| -------- | ---------------------------- | ----------------------------------- |
| Pi 模式  | `pi -a --no-session` (print) | `pi -a` (TUI 交互)                  |
| 测试手段 | 发送 prompt，检查 stdout     | 通过 PTY 发送按键，捕获屏幕输出     |
| 验证方式 | exit code + 日志 grep        | ANSI 输出剥离后文本匹配             |
| 适用场景 | 加载、工具调用、日志         | 覆盖层渲染、键盘交互、快捷键        |

**快速参考：**

```bash
# 运行 TUI 测试
bash test/e2e/scripts/run-e2e.sh --ext quit --tui

# 不指定 --tui 时会自动补充运行 tui-expect.smoke.test.sh
bash test/e2e/scripts/run-e2e.sh --ext quit    # 同时跑 smoke + tui
```

**TUI 测试文件命名：** `test/e2e/extensions/<name>/tui-expect.smoke.test.sh`

**核心 API（定义在 `test/e2e/helpers/tui-functions.sh`）：**

| 函数                                          | 用途                   |
| --------------------------------------------- | ---------------------- |
| `tui_expect_test <exts> <commands> <timeout>` | expect 驱动的 TUI 测试 |
| `tui_assert_contains <text>`                  | 断言 TUI 输出包含文本  |
| `tui_assert_matches <regex>`                  | 断言 TUI 输出匹配正则  |
| `tui_cleanup`                                 | 清理临时文件           |

**注意事项：**

- TUI 测试在隔离沙箱中运行，会自动创建 `node_modules/@zenone/pi-logger` 链接
- **避免触发 LLM 调用**（不要发 `hi`/`hello`），直接发 `/command` 即可
- `session_shutdown` 中的输出可能因 PTY 关闭而丢失
- 退出码 124（timeout）在 LLM 未返回时是预期的

**已有样例：** `test/e2e/extensions/quit/tui-expect.smoke.test.sh` 和 `test/e2e/extensions/quit/tui-integration.test.exp`

完整文档见 [`test/README.md`](test/README.md) 和 [`skills/e2e-test/SKILL.md`](skills/e2e-test/SKILL.md)。

### TUI 设计约定

#### 字符白名单：禁双宽 emoji，放行单宽箭头

TUI 组件的渲染**禁止使用双宽 emoji 和 Unicode 图标字符**（如 📋📜✅❌⭐🔍▼▊⚙✎☑☐✓✗ 等）。原因：

1. **宽度不确定性**：emoji 在不同终端的显示宽度不同（单宽或双宽），`visibleWidth()` 和 `truncateToWidth()` 可能无法正确处理，导致 `Rendered line exceeds terminal width` 崩溃
2. **可读性**：部分终端/字体不支持 emoji，显示为方块
3. **搜索/过滤不便**：emoji 无法用文字匹配

**例外**：单宽箭头 `↑↓←→`（宽度恒为 1，仅用于键盘导航提示）**允许**。

**替代方案**：一律使用纯文本表示：

- `[Strategies]` 代替 `[📋 Strategies]`
- `OK/BLOCK` 代替 `✅/❌`、`✓/✗`
- `>` (大于号) 表示选中
- `[x]`/`[ ]` 代替 `☑/☐`
- `_` (下划线) 代替 `▊` 表示光标

> 详见 ADR-0023（字符白名单 + 纯横线边框范式）。门禁脚本 `scripts/check-tui-compliance.ts` 强制检测双宽 emoji（含 `✓/✗`）、硬编码颜色、`.length` 对齐误用与方角边框（`┌┐└┘`，树形 connector 豁免）。

#### `truncateToWidth` 安全网

每个 TUI `render()` 方法返回的每一行，都必须用 `truncateToWidth(line, width)` 包裹作为最后的安全保障，确保不会超过终端宽度。

```typescript
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

// ✅ 正确: 每行都经过 truncateToWidth
lines.push(truncateToWidth(th.fg('accent', title), width));
lines.push(truncateToWidth('  ' + content, width));

// ❌ 错误: 不包裹可能导致崩溃
lines.push(th.fg('accent', title));
```

#### 纯横线边框与内容行写法

纯横线范式（ADR-0023）：**顶边框 `── 插件名` + 横线填满、内容行缩进 + `truncateToWidth` 兜底、内部分隔线左右各缩进 1 格、底边框纯横线**。标杆实现见 `extensions/tui/answer.ts`、`quit.ts`、`btw.ts`、`todos/ui/actions.ts` 等（均已迁移）。

- **内容行**：统一 `row = (content) => indent + truncateToWidth(content, W)`，无竖线无 rightPad 对齐计算。
- **特殊场景**：左右分栏两端对齐、多列表格、滚动视口、固定宽居中卡片需各自处理列宽/视口。
- **需加固**：内容含 tab / emoji / 嵌套第三方组件输出时，必须额外 `truncateToWidth` 兜底。
- **口径统一**：对齐/截断只用 `visibleWidth`，禁止混用 `.length`。

完整清单见 [`docs/tui-design-principles.md` 第 7 节](docs/tui-design-principles.md#7-边框与布局) 与 [ADR-0023](docs/adr/0023-tui-visual-spec-completion.md)。

#### 状态栏文本 `|` 前缀约定

`ctx.ui.setStatus(key, text)` 的文本必须以半角 `|` 开头（`| prefix:text`，见 `docs/tui-design-principles.md` §2.1）。widget-wrangler 会在中间人层自动补齐缺失的 `|` 前缀并 `log.warn` 留痕——插件侧仍应主动遵守，不要依赖兜底。

#### 普通测试辅助扩展示例

**`test/extensions/tools/helpers/dynamic-registrar.ts`**

- 通过 `pi.registerTool()` 模拟 MCP 工具的注册行为
- 测试用例中通过手动拷贝 + `pi -a --no-session` 运行，不使用 `run_pi_and_check`（因其只搜索 `extensions/` 目录）
- 参考模板：

```typescript
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createLogger } from '@zenone/pi-logger';

const log = createLogger('my-helper');

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: 'mock_tool',
		label: 'Mock Tool',
		description: '...',
		parameters: { type: 'object', properties: {}, required: [] },
		execute: async () => ({
			content: [{ type: 'text', text: 'mock result' }],
			details: undefined,
		}),
	});
	log.info('mock_tool registered');
}
```

测试用例中使用手动隔离环境（见 `test/extensions/tools/smoke.test.sh` 的场景 4/5）。

#### 完整 TUI 设计规范

完整的设计规范、颜色使用、键盘交互、边框布局和 TUI 测试方法见 [`docs/tui-design-principles.md`](docs/tui-design-principles.md)。开发扩展 TUI 前请先阅读。

#### 交互模式规范 【强制】

TUI 设计按三轴正交分类，详见 [`docs/tui-interaction-patterns.md`](docs/tui-interaction-patterns.md)：

1. **先选入口**：`setStatus`（状态栏）/ `setWidget`（常驻面板）/ `custom`（临时覆盖层）/ `setHeader`/`setFooter`（慎用）。
2. **再定交互模式**：只读展示 / 导航选择 / 表单编辑 / 确认菜单，四选一。
3. **导航选择强制 master-detail 两级导航**：一级列表（选中 → 二级详情/操作），**一级列表必带滚动上限**。禁止把操作菜单与导航列表拍平在同一级。
4. **实现策略**：规则选择 → 组件化（`Container`/`SelectList`）；不规则复杂布局 → 手绘 `render()`。`Focusable` 是横切能力（硬件光标定位），非分类维度。
5. **编辑类输入必显当前值**：进入编辑/输入 UI 时必须展示当前使用的值，支持"基于现有值修改"。pi 的 `ctx.ui.input(title, placeholder)` **placeholder 不渲染**（pi-mono 的 `ExtensionInputComponent` 忽略该参数），当前值只能放进标题提示（如 `请输入分支名（当前：main，直接回车使用）`）；且空输入回车 = 确认/保留当前值，escape = 取消。详见 [`docs/tui-interaction-patterns.md` 3.3 节](docs/tui-interaction-patterns.md#33-表单编辑)。

> 反例警示：pi-lab 面板曾把「选实验」和「选操作」拍平为每实验内嵌一个 SelectList，导致高度膨胀 + 焦点失效。开发前先读该文档第 6 节反模式清单。

### TUI 测试强制要求 【强制】

**所有涉及 TUI 渲染的开发（新增组件、修改 render()、新增 overlay、修改交互逻辑），必须使用 headless snapshot 测试框架验证，禁止仅依赖人工肉眼检查。**

#### 最低要求

| 场景          | 必须验证                             | 使用工具                                        |
| ------------- | ------------------------------------ | ----------------------------------------------- |
| 新增 TUI 组件 | 渲染输出在 2+ 种宽度下不超宽、不崩溃 | `renderToSnapshot()` + `assertWithinWidth()`    |
| 修改 render() | 变更前后 snapshot diff 符合预期      | `renderToSnapshot()` + `diffSnapshots()`        |
| 新增 overlay  | overlay 可见/hidden 状态均正确合成   | `renderToSnapshot()` + overlay 相关断言         |
| 键盘交互      | 按键后 UI 状态切换正确               | `dispatchInput()` → `renderToSnapshot()` → diff |
| 颜色/主题     | ANSI 颜色代码存在于预期行            | 含 ANSI 的 snapshot 断言                        |

#### 快速模板

```typescript
import {
	MockTerminal,
	renderToSnapshot,
	dispatchInput,
	stripAnsi,
	assertWithinWidth,
	diffSnapshots,
} from '../../src/tui-testing/index.js';
import { TUI } from '@earendil-works/pi-tui';

// 基础 snapshot 测试
describe('MyPanel TUI', () => {
	it('不超宽', () => {
		const tui = new TUI(new MockTerminal(80, 24));
		tui.addChild(new MyPanel(/* ... */));
		const snapshot = renderToSnapshot(tui, 80, 24);
		assertWithinWidth(snapshot, 80);
	});

	it('按键切换状态', () => {
		const tui = new TUI(new MockTerminal(80, 24));
		const panel = new MyPanel(/* ... */);
		tui.addChild(panel);
		tui.setFocus(panel);
		// dispatchInput 通过 any 桥接直达运行时输入入口
		// （pi-tui ≥0.85 为 handleTerminalInput，旧版回退 handleInput）
		// 无需 tui.start()、无需特殊 Terminal 类

		const before = renderToSnapshot(tui).map(stripAnsi);
		dispatchInput(tui, '\t');
		const after = renderToSnapshot(tui).map(stripAnsi);
		expect(after).not.toEqual(before);
	});
});
```

#### 例外

以下场景可豁免 headless snapshot 测试，但需在 PR 中说明理由：

- 组件渲染依赖 `pi` 扩展生命周期（如 `ctx.ui.custom()` 内部状态），无法在纯 TUI 环境中复现 → 使用 TuiRunner (node-pty) 替代
- 组件渲染依赖 `@earendil-works/pi-coding-agent` 专有类型，无法在 vitest 中导入 → 使用 TuiRunner 替代

详细用法和 API 参考见 [`docs/tui-headless-testing.md`](docs/tui-headless-testing.md)。框架源码位于 [`src/tui-testing/`](src/tui-testing/)。

---

## 开发Pi插件一些补充信息

> **动态维护策略**：本节 ≤200 行。每次新增知识前先检查已有条目，进行合并与综合。若超限，将最早或最长的条目移入 `docs/pi-ext-knowledge/` 下独立文件并引用。
> 本节内容由 `.pi/skills/extract-pi-knowledge/SKILL.md` 技能从 `~/.pi/agent/sessions/` 会话历史中自动提取分析得到。

以下信息在 Pi 官方文档（`docs/extensions.md`, `docs/compaction.md`）中**没有提及**，需要阅读 agent-session.js 源码才能理解。记录在此以便后续扩展开发一次改对。

### 1. `compact()` 内部事件时序

`ctx.compact()` 或内置 compaction 的内部执行顺序（需逆向阅读 `agent-session.js`）：

```
compact() 内部:
  1. abort()
  2. _compactionAbortController = new AbortController()  ← 从此进入“压缩进行中”
  3. _emit(compaction_start)
  4. prepareCompaction()
  5. emit(session_before_compact)  ← 扩展在这里拦截或提供自定义摘要
  6. 生成摘要（内置默认生成器，或扩展提供的 compaction）
  7. appendCompaction() + _refreshFinalizedContext()
  8. emit(session_compact)     ← ⚠ 压缩控制器仍处于“进行中”
  9. _clearManualCompactionState()  ← 控制器在这里才被清除
 10. _emit(compaction_end)
 11. return → onComplete()     ← ✓ 压缩已彻底结束，安全状态
```

**关键结论：**

- `compact()` **从不断开 agent**（`_disconnectFromAgent()` 只在 `dispose()` 里调用）。旧版本文档“session_compact 时 agent 已断开”的**理由已作废**。
- 但**结论不变**：在 `session_compact` 里调用 `pi.sendUserMessage()` 会**确定性失败**——`prompt()` 在压缩进行中直接 `throw new Error("Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.")`，而压缩控制器要到第 9 步才清除。所有需要与 agent 交互的操作（如 `sendUserMessage`）仍然**只能**放在 `onComplete`。
- 失败是**静默的**：扩展侧 `pi.sendUserMessage()` 是 fire-and-forget（返回 `void`），`prompt()` 的异常只经 `runner.emitError({ event: "send_user_message" })` 上报，调用方拿不到返回值。
- 上游 `compact()` 里 `compaction_end` 那行注释写着“listeners may submit queued prompts”，但 `compaction_end` **不是扩展事件**（只在会话内部 emitter 上发），扩展拿不到——不要指望它。
- 如果需要捕获触发压缩时的配置状态，使用闭包：`const triggerProfile = profile; ctx.compact({ onComplete: () => { /* 用 triggerProfile */ } })`

### 2. `isIdle()` 的时机限制

`ctx.isIdle()` 的口径是“没有活动 run、且不在压缩中”：

```typescript
get isIdle() {
    return !this._isAgentRunActive && !this.isCompacting;
}
```

（旧版本文档记的 `!this.isStreaming` 已作废——它既没涵盖 run 的启动/收尾窗口，也没涵盖压缩。）

关于 `isIdle()` 有几个坑：

| 事件            | isIdle() 状态                    | 说明                                   |
| --------------- | -------------------------------- | -------------------------------------- |
| `turn_end`      | `false`                          | agent 仍在事件循环中                   |
| `agent_end`     | **可能仍为 false**               | run 的收尾 **滞后于** `agent_end` 事件 |
| `agent_settled` | `true`（除非其他扩展启动新 run） | 这是唯一保证 idle 的事件               |

**正确用法：**

- 不要用 `isIdle()` 来判断压缩时机——用 **独立 flag**（如 `compactingInProgress`）做重入保护
- 要监听 idle 状态用 `agent_settled`，不是 `agent_end`
- **在 `agent_settled` 处理器里发 prompt 是安全的**：`prompt()` 检测到正在派发 settled 时会把调用塞进 deferred 队列，settled 结束后自动执行（不是丢弃）。

### 3. `complete()` 调用全流程注意事项

两处 `@earendil-works/pi-ai` 文档未提的细节：① Auth **只查环境变量**（`getEnvApiKey`），不读 `models.json`/auth storage——必须先用 `ctx.modelRegistry.getApiKeyAndHeaders()` 解析并把 `apiKey`/`headers` 传进 options；② `stopReason: "error"` 时 `Response.errorMessage` 有值，必须读它才拿得到失败原因。

> 代码示例见 [`docs/pi-ext-knowledge/complete-call-flow.md`](docs/pi-ext-knowledge/complete-call-flow.md)。

### 5. `npx pi` vs 全局 `pi` 的 CLI 参数差异

| 二进制                   | `-a`       | `--no-session` | `-e`/`--extension` |
| ------------------------ | ---------- | -------------- | ------------------ |
| `$(which pi)` (全局安装) | ✓          | ✓              | ✓                  |
| `npx pi`                 | 可能不支持 | ✓              | 可能不支持         |

**e2e 测试必须用 `$(which pi)`**，不能用 `npx pi`。

### 6. `sendUserMessage()` 的时机限制

`pi.sendUserMessage()` 是 **fire-and-forget**（返回 `void`），内部调用 `this.prompt()`。`prompt()` 有两个**直接 throw** 的前置守卫：

| 守卫           | 触发条件                                             | 报错文本                                                                                               |
| -------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 压缩进行中     | 压缩控制器仍存在（含整个 `session_compact` 派发）    | `Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.`     |
| 正在 streaming | `isStreaming` 且未给 `streamingBehavior`/`deliverAs` | `Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.` |

失败**不是静默消失**：异常经 `runner.emitError({ event: "send_user_message" })` 派发到宿主 `onError` → `showExtensionError()`，用户会看到错误框，日志里也有记录。（旧版本文档“错误被 `.catch()` 吞掉、没有失败信号”已作废——被吞的只是异常的向外传播，信号仍到 UI/日志。）

**两种合法姿势（二选一，别混用）：**

- **(A) 先确认不在 streaming**：如 `if (!ctx.isIdle()) return;`，或在一个 `fork` 出来的新会话里发。适合“只在空闲时才该发生”的动作（典型：`continue` 类插件）。
- **(B) 带 `deliverAs` 排队**：`{ deliverAs: "followUp" }`（当前轮结束后执行）或 `"steer"`（插话）。适合“必须送达、可以等”的动作。

无论哪种，`session_compact` 事件内都不合法（见第 1 条）。

### 7. `Failed to load extension` 调试路径

从会话历史分析，这是最高频的启动失败模式。通常原因有 3 类：

| 原因               | 典型报错                                                   | 检查方法                                                        |
| ------------------ | ---------------------------------------------------------- | --------------------------------------------------------------- |
| **文件未同步**     | `Failed to load extension ".../extensions/foo.ts"`         | `ls -la .pi/extensions/foo/` 文件是否存在                       |
| **npm 依赖未安装** | `Cannot find module "xxx"` 或 `TS2307: cannot find module` | `ls .pi/extensions/foo/node_modules/` 或 `npm ls`（从扩展目录） |
| **jiti 缓存陈旧**  | 修改后加载旧版本                                           | `rm -rf node_modules/.cache/jiti` + 重启 pi                     |

**调试流程**：

1. 检查目标文件是否存在（尤其是刚用 sync 工具的）
2. 检查依赖安装（有 `package.json` 的扩展需要 `npm install`）
3. 清除 jiti 缓存后重试
4. `pi -e ./extensions/foo/index.ts` 直接加载看错误详情（绕过 auto-discovery）

### 8. `/reload` 后状态丢失 — 三种纠正策略

`/reload` 让 jiti 重新加载模块、实例 in-memory 状态全丢。三种纠正：配置存 `extensions-data/<name>/<sessionId>.json`；文件路径用 `os.homedir()` 而非 `import.meta.url`；树状状态用 `pi.appendEntry()` 在 `session_start` 重建。

> 策略对照表、示例代码与事件时序（`session_shutdown` 先、`session_start` 后，旧闭包/定时器全失效）见
> [`docs/pi-ext-knowledge/reload-state-loss.md`](docs/pi-ext-knowledge/reload-state-loss.md)。

### 9. E2E 测试扩展的常见陷阱

从多个扩展的 e2e 测试中总结：

| 陷阱                                                                | 原因                                                                                                                                                                                                                                                                | 修复                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **日志检查用 stdout**                                               | pi-logger 写文件，非 stdout                                                                                                                                                                                                                                         | 检查 `.pi/logs/<name>_*.log`                                                                                                                                                                                                                                                                                                      |
| **`npx pi` vs `$(which pi)`**                                       | `npx pi` 的参数集可能不同                                                                                                                                                                                                                                           | 测试脚本用 `$(which pi)`                                                                                                                                                                                                                                                                                                          |
| **print 模式下扩展不加载**                                          | `pi -p` 不触发全部 life cycle                                                                                                                                                                                                                                       | 用 `pi -a --no-session`                                                                                                                                                                                                                                                                                                           |
| **测试数据残留**                                                    | 会话文件持久化                                                                                                                                                                                                                                                      | 启动 pi 一律加 `--no-session`（见下行）；未自行隔离 HOME 的调用由 guard 注入隔离配置根，不再写真实 `~/.pi/agent/sessions`；⚠ guard 只重定向 **pi 内核目录**（sessions/models/auth/settings），扩展经 `os.homedir()` 解析的 `extensions-data/**` 与 `~/.pi/logs/**` **不在覆盖内**，涉及它们的用例须自行隔离 HOME                  |
| **无意义会话残留**                                                  | 忘记加 `--no-session`                                                                                                                                                                                                                                               | 启动 pi 默认加 `--no-session`（见"Pi 启动参数约定"）                                                                                                                                                                                                                                                                              |
| **assert stdout 文本**                                              | TUI/ANSI escape 序列干扰                                                                                                                                                                                                                                            | grep 模式匹配而非全文比对                                                                                                                                                                                                                                                                                                         |
| **TUI/集成 e2e 假失败**                                             | 漏 `CI=true` → 不注入 mock-llm → `No API key found`，却表现为业务断言失败（本仓实测：6 个用例假红，加 `CI=true` 后 8 PASS/0 FAIL）                                                                                                                                  | 跑 e2e 一律 `CI=true bash test/e2e/scripts/run-e2e.sh ...`；**失败先排除环境再查代码**                                                                                                                                                                                                                                            |
| **TUI 按键错位**（阻断框/选择器/卡片）                              | 沙箱里「prompt → 阻断框出现」实测 ~~10-40s 波动（早先记的“30s~~7min”是把收尾白等误算进来了，见下一行），固定 `sleep` 会错位                                                                                                                                         | 用**重复 Enter 容错**（落在主输入框=空提交无副作用；落在阻断框=放行 / 选择器=选中 / 卡片=采纳），或 `expect -re` 等图案（别靠加长 budget 兜底）                                                                                                                                                                                   |
| **单用例调试太慢**                                                  | 整模块跑一次 ~10 分钟                                                                                                                                                                                                                                               | `--case <子串>` 只跑名字匹配的用例（需配 `--ext`/`--skill`）；TUI 加 `--tui`                                                                                                                                                                                                                                                      |
| **TUI 用例莫名多等**（实测：timeout 参数 15→用例 35s、45→用例 95s） | **两处白等**：① 就绪检测用状态栏正则 `(auto)\|\(0\.0%/0`，在 `expect <脚本文件>` 路径下不匹配 → 每用例白等到 `timeout_seconds`（`PI_TIMING=1` 证明 pi init+扩展仅 ~0.4s）；② 覆盖层没关 → 收尾 `/quit` 被吞 → 再白等收尾超时。两者都**不报错**（`exit=124` 被接受） | 已修：就绪改「读到输出静默」（历史用裸 `sleep` 不读走启动输出 → 后续按键与输出交错、首条命令 `Enter` 丢失，实测 `/preset plan`+`/tools` 合并成 `plan/tools`）；收尾两段式（先 `/quit`，未退再 `ESC`×3（间隔 0.6s）后重试，**ESC 紧贴 `/` 会被吞掉**）。用例仍应自觉关覆盖层。定位看 `[tui-stage]`（见 `docs/e2e-performance.md`） |

> **TUI 沙箱免改基建即可构造任意场景**（`tui_expect_test` 已支持）：
>
> - 第 6 参数 `preset_home_dir`：镜像 `$HOME` 结构的预置目录，pi 启动前拷入 → 可确定性预置 `$HOME/.pi/agent/extensions-data/<plugin>/config.json`（隔离 HOME 内落盘、不污染宿主）。
> - `MOCK_LLM_DANGEROUS_COMMAND="rm -rf ..."` + `MOCK_LLM_DANGEROUS_REPEAT=N`：让 mock-llm 前 N 轮各发一条指定危险命令 → 触发任意次数的人工批准。
> - 需要「一串不同命令」（如先 `mkdir` 后 `rm`）时，写专用 mock 扩展（参考 `test/e2e/extensions/permission-gate/helpers/mock-llm-promotion.ts`，按 `PG_E2E_COMMANDS` 用 `;;` 分隔生成命令序列）并 `cp` 到沙箱 `.pi/extensions/mock-llm/index.ts`。
> - 断言优先落在**持久化产物**（config.json / state.json / audit jsonl / 日志），其次才是屏幕文本。

### 10. 累加式指标追踪器的 checkpoint 设计模式

累积指标（计数 / Set / 比率）的扩展只靠 `session_shutdown` 保存不够——`/reload` 后 tracker 从 0 开始。要点：导出/导入**原始计数**（非比率）、三个 checkpoint 时机（指标变化 / `turn_end` / 销毁）、`session_start` 恢复。

> 代码骨架、触发条件与反模式见
> [`docs/pi-ext-knowledge/accumulating-metrics-checkpoint.md`](docs/pi-ext-knowledge/accumulating-metrics-checkpoint.md)。

### 11. Pi 挂起调试：扩展 vs 无扩展对比诊断

当 Pi 在运行中卡住（5min+ 无响应）而 `pi -ne`（无扩展模式）正常，根因通常是某个扩展的 `complete()` 调用未正确处理 API 错误，或事件处理器进入无限循环。

**诊断步骤**：

1. **确认同步状态**：检查 `.pi/extensions/` 下对应扩展是否与源码版本一致——`ls -la .pi/extensions/<name>/` 对比文件时间戳，不一致则重新 sync
2. **检查 `complete()` 错误处理**：确认每次调用有 `stopReason === "error"` 的日志和超时 signal 传递
3. **清 jiti 缓存**：`rm -rf node_modules/.cache/jiti` 后重启
4. **逐个排除**：在 `models.json` 的 `extensions` 列表中逐个去除扩展定位问题扩展

**反模式**：只在 `-ne` 模式确认正常即断定是"Pi 本身的问题"，必须先排除上述三项。

### 12. pi-lab 实验框架：消费方接入规范

pi-lab（`extensions/meta/pi-lab/`）是实验框架，不自带实验。消费方插件通过它注册 A/B 实验、选臂、录反馈。

**接入方式（按耦合强度）：** 弱依赖 A = `registerWeakExperiment()`（`globalThis.__labApi` 桥接，不 import 包，pi-lab 缺失时自然降级）；强依赖 B = `registerStrongExperiment()`（import `@zenone/pi-lab`，声明依赖）。

**两条铁律：** ① 注册必须在 `session_start` 事件中做，绝不在模块工厂函数中做（消除加载顺序竞险）；② 消费方必须自己处理降级——pi-lab 不阻塞插件启动。

**冲突裁决：** 同名实验冲突时强依赖者（B）优先于弱依赖者（A）；同级后注册覆盖先注册（last-wins）。

> 完整规范（含代码示例）见 `docs/pi-ext-knowledge/pi-lab-consumer-integration.md`；设计见 `docs/adr/0003-pi-lab-extension-registration-mechanism.md`。

### 13. pi-tui 渲染机制与自定义组件高度铁律

`tuiMode` 默认 **fullscreen**（1.0.0 起，见 pi CHANGELOG `## [1.0.0]`），走 `TuiAltScreen`（layout root + 固定输入 dock + 自管滚动）；
`firstChanged < prevViewportTop → fullRender` 那套内联渲染语义**只在 `tuiMode: "regular"` 下成立**。
两条铁律（总高 ≤ 视口、header 不得放动态内容）、观测工具（`PI_TUI_DEBUG` / `PI_DEBUG_REDRAW`）
与滚动类 e2e 盲区见 [`docs/pi-ext-knowledge/fullrender-and-fullscreen.md`](docs/pi-ext-knowledge/fullrender-and-fullscreen.md)。

### 14. 内置 bash 工具 timeout 无默认值 + 两条干预路径

`timeout` 参数 **无默认值**；`bash-timeout` 在 `tool_call` 钩子里补默认 300s 兜底。干预内置 bash 只有两条路径、
单个扩展须二选一：**tool_call 钩子注入**（uv、bash-timeout）或 **operations 替换**（sandbox 接管）。
超时语义（进程组 kill、`a | b` 共享超时等）见 [`docs/pi-ext-knowledge/bash-timeout-intervention.md`](docs/pi-ext-knowledge/bash-timeout-intervention.md)。

### 15. 判定模型（classifier）：存在性与准入

Pi 除 chat 外还有两类非对话模型：`classifier`（`bool` / `choice` / `score`，返回概率）与 `image`（生图）；两者**不出现在 `/model`**，只能经 `codemode` 或扩展 API 调用。
**有条目 ≠ 能用**（内置 catalog 多数 classifier 无凭证）：准入先查 `getAvailableOfType('classifier', provider)`，没配就 `return` 走原逻辑（fail-open）；`classify()` 永不 reject，失败只落 `stopReason: "error"`。

> 校验代码、`registerProvider` 接自建判定服务、`models.json` 覆盖 `baseUrl`、坑清单与实测记录见
> [`docs/pi-ext-knowledge/classifier-models-jev.md`](docs/pi-ext-knowledge/classifier-models-jev.md)。

### 16. `before_agent_start`：`systemPromptOptions` 可变、`systemPrompt` 是懒渲染

`event.systemPrompt` 是 **getter**（每次读取都拿同一个 `systemPromptOptions` 重建），`systemPromptOptions` 是**可变**对象（后注册的 handler 能看到前面的修改）。所以运行时裁剪技能/工具说明只需就地写 `event.systemPromptOptions.skills`，pi 自己渲染并以 **section diff** 增量下发；`return { systemPrompt }` 等价 `forceSystemPrompt`（整段钉死、失去 diff、不利缓存），只留给整段重写场景。两个已知坑：① **就地裁剪 = 改变共享字段语义**——之后读 `options.skills` 的扩展（如 resources-tree 的分母）看到的是「可见集」而非「全量」，要用 `pi.getCommands()`（`source === "skill"`）拿全量；② **force 会整段覆盖 sections**，早于裁剪方的 force 会把未过滤快照钉死，而扩展加载顺序由 `readdirSync` 决定、pi 不排序 → 裁剪方必须自带兜底（见 `skills.ts` 的 `path: options|force|snapshot`）。细节见 [`ADR-0066`](docs/adr/0066-skills-runtime-filtering-via-system-prompt-options.md)。

---

## 分支管理规范

本仓库采用三层分支模型，worktree 按 extensions 子类划分：

```
worktree(特性分支)  --squash-->  dev(集成主干)  --merge-->  main(发布分支)
```

### 合并规则（强制）

| 边界           | 方式                 | 约束                                                                   |
| -------------- | -------------------- | ---------------------------------------------------------------------- |
| worktree → dev | `git merge --squash` | 1 特性 = 1 提交，dev 历史保持干净                                      |
| dev → main     | `git merge --no-ff`  | dev 永不 reset、连续开发；**禁止 squash dev → main**（丢历史导致分叉） |

> 批量执行等价于逐条手工：`/worktree group merge all` 按花名册顺序逐个 squash 合并（fail-fast、可续跑）；
> 单次仍可用上表手工命令。

**worktree 复用铁律**：worktree 通过 squash 合入 dev 后，自身与 dev 分叉。**复用前必须先 `git reset --hard dev` 对齐**，否则会带上已合并的旧历史。

> 整组对齐可用 `/worktree group sync all`（未合入成员走 rebase 保留提交，不丢改动；手工 `reset --hard` 仍是兜底）。

**特殊情况**：仅在 dev 历史严重混乱（如大量 merge 提交）且用户明确要求时，才允许 squash dev → main 一次性压平；压平后立即 `git reset --hard main` 让 dev 重新对齐，并在压平前打 `archive/dev-<日期>` tag 保留历史。

### worktree 重建

6 个 worktree 对应 extensions 子类（bugfix 为跨类修复）：

| worktree      | 分支               | 对应                       |
| ------------- | ------------------ | -------------------------- |
| bugfix        | `wt/bugfix`        | 跨类 bug 修复              |
| context       | `wt/context`       | `extensions/context`       |
| observability | `wt/observability` | `extensions/observability` |
| security      | `wt/security`      | `extensions/security`      |
| tool          | `wt/tool`          | `extensions/accuracy`      |
| verification  | `wt/verification`  | `extensions/verification`  |

```bash
# 清空并重建全部 worktree（从当前 dev 拉）
bash scripts/recreate-worktrees.sh

# 仅重建某一个
bash scripts/recreate-worktrees.sh context
```

> ⚠️ 脚本会删除对应 worktree 目录及其分支，**未提交改动会丢失**。运行前先 `git -C <worktree> status --short` 检查无未提交工作。

#### 组声明与日常三件套（本机，不入库）

仓库级组声明：`<repo>/.pi/extensions-data/pi-worktree/config.json`（`.pi` 被 gitignore → **不随仓库分发**，
新机器 / 新 clone 需重建一次）。当前声明一个组：

| 组    | baseRef | 成员                                                              | 策略   |
| ----- | ------- | ----------------------------------------------------------------- | ------ |
| `all` | `dev`   | bugfix / context / observability / security / tool / verification | squash |

```bash
/worktree group create all   # 只补建缺失成员（补建 ≠ 重建）
/worktree group merge  all   # 按花名册顺序 squash 合并，fail-fast 可续跑
/worktree group sync   all   # 非破坏性对齐（未合入成员走 rebase）
```

`scripts/recreate-worktrees.sh` **保留**：它是「销毁重建」（删目录与分支），组 `create` 只补建缺失成员，
二者不等价——灾难恢复 / 彻底重来仍用脚本。

### 发版流程

```bash
# ① 特性开发在 worktree 完成 → 合入 dev（squash，1 特性 1 提交）
git checkout dev && git merge --squash wt/xxx && git commit -m "feat(xxx): 完整特性"

# ② 发版：dev → main（merge --no-ff，dev 不 reset）
git checkout main && git merge --no-ff dev -m "release: vX.Y.Z" && git tag vX.Y.Z
```

发版提交规范：`release: vX.Y.Z`，CHANGELOG 同步 `## Unreleased` → `## vX.Y.Z (日期)`。

## 本地同步

本仓库的 extension、skill、theme、prompt 开发使用 `scripts/sync-to-local-pi.ts` 管理同步。

### Profile 架构：全局 vs 项目隔离

本仓库使用两个互斥 Profile 避免 flag/tool 注册冲突：

| Profile        | 目标           | 范围                    | 说明                                               |
| -------------- | -------------- | ----------------------- | -------------------------------------------------- |
| `user-install` | `~/.pi/agent/` | 高成熟度日常插件        | 所有项目共用（selector、pi-logger、安全插件等）    |
| `project`      | `.pi/`         | 项目特定 / 低成熟度插件 | 本项目独有（custom-compaction、resources-tree 等） |

**核心原则**：user-install级别的插件安装应该与其他项目级的 Profile 插件互斥，避免项目里pi启动时重复注册报错。

### 工作要求

- **所有扩展/技能/主题的开发和测试**必须通过该工具管理，禁止手动复制文件到目标目录
- **开发流程**：在源目录编码 → 内联模式同步到测试目录 → 在 Pi 中测试 → 通过后同步到用户目录
- **最终交付**：开发完成后，必须同步到 `~/.pi/agent/`，完成 UAT 测试确认无误
- **Profile 配置**：修改 `scripts/sync-profiles.yaml` 时需保证两个 Profile 的 `extensions` 互斥。新增扩展时：
    - 判断它是否达到全局通用成熟度 → 加入 `user-install` 的 extensions 列表
    - 如果否（项目特定/低成熟度）→ 确保 `user-install` 的 exclude 或列表不包括它
    - 同时在 `project` 的 exclude 中同步更新

### 快速参考

```bash
# 全量同步（默认：执行所有 profile）
npx tsx scripts/sync-to-local-pi.ts

# 仅同步单个 profile
npx tsx scripts/sync-to-local-pi.ts --profile user-install
npx tsx scripts/sync-to-local-pi.ts --profile project

# 开发中快速测试（内联模式，只同步不删除）
npx tsx scripts/sync-to-local-pi.ts --ext foo --target ./.pi/test

# 预览所有 profile 的变更
npx tsx scripts/sync-to-local-pi.ts --dry-run
```

> **同步到用户目录（`~/.pi/agent`）的三种方式**（ADR-0037 语义）：
>
> ```bash
> npx tsx scripts/sync-to-local-pi.ts --profile user-install                        # 整个 profile
> npx tsx scripts/sync-to-local-pi.ts --profile user-install --ext permission-gate  # 只同步一个插件（推荐）
> npx tsx scripts/sync-to-local-pi.ts --ext permission-gate --target ~/.pi/agent     # inline 单插件
> ```
>
> - **删除语义（ADR-0037）**：profile 模式默认「严格剪枝」——删除目标中「受管但不在当前 profile 有效集合」的资产（含 `retired` 墓碑清单登记的已下架/内嵌扩展）；第三方资产默认保留，仅 `--purge` 才清。inline 模式（给了 `--target`）**默认不删**目标中任何文件。
> - **单插件白名单**（`--profile X --ext Y`）是**排他过滤**：只同步点名的资产，其他资源类型本次不参与，且**禁用 stale 剪枝**（绝不删除未点名的资产）；点名项不在该 profile 清单内时快速失败。
> - ⚠️ 唯一仍硬阻断的是 **`--purge` 指向 `~/.pi` / `~/.pi/agent`**：`--purge` 递归删除目标中不属于本次同步的一切，指向真实用户目录等于全毁（代码级护栏保留）。
> - 每次运行都会在控制台与日志输出 `WARN`，说明本次是否发生删除。
> - **坑**：其他 worktree 跑一次 sync 会把用户级覆盖成本 worktree 的版本；本 worktree 未提交的改动只有在**本 worktree 跑 sync** 后才生效（曾出现“新特性在用户级看不到”）。

详细用法参考 [docs/sync-tool.md](docs/sync-tool.md)。

### 离线部署（`scripts/offline.sh`）

把整个插件体系（pi 运行时 + `~/.pi/agent` 用户目录 + 本地包 + 第三方插件）打包成单个 bundle，在无网络 Linux 目标机解压恢复。

```bash
# 源机（macOS，有网）打包
bash scripts/offline.sh pack -o pi-offline-bundle.tar.gz [--arch x64|arm64] [--with-node]

# 目标机（Linux，离线）恢复
bash scripts/offline.sh restore pi-offline-bundle.tar.gz [--force]
```

**要点（改脚本前先读）：**

1. **离线模式**：restore 生成的 `pi` 是 wrapper，默认 `export PI_OFFLINE=1`（pi 内置离线模式，`PI_OFFLINE` 环境变量）。启动时不联网同步第三方插件；已装的 npm/git 插件靠本地版本匹配（`satisfies()` 纯本地比较）正常加载。这是**保留 settings.json `packages` 字段**而非清空的原因——清空会让第三方插件全部失效。
2. **符号链接重建**：`~/.pi/agent/node_modules/@zenone/*` 可能指向仓库外绝对路径（worktree），打包时记录映射（`AGENT_LINKS` / `VENDOR_LINKS` 段），restore 时重建为相对链接。源机环境不改动。
3. **本地包三分类**：agent 内置 → 重建链接；外部源码可用（非 `dist/` 入口或 dist 已构建）→ 解析进 `vendor/`（不在扩展发现路径）；dist 缺失 → 跳过并告警。
4. **裁剪清单**：默认排除 `sessions/tmp/state/bin/fff/chat/compact-backups/cache/.cache`、`*.log`、`auth.json`（`--keep-sessions`/`--keep-auth` 保留）；`agent/bin`（fd/rg 的 macOS 二进制）必须排除，否则 Linux 不可用。
5. **bash 3.2 兼容坑**：macOS 自带 bash 3.2 + `set -u` 下，① `local VAR` 分离声明后命令替换赋值可能丢值，一律用单行 `local VAR="$(...)"`；② `$VAR` 后紧跟中文全角标点（`（`/`）` 等，UTF-8 首字节 0xEF）会被吞进变量名报 unbound，须用 `${VAR}` 花括号界定。改脚本时新增中文消息必须遵守。
6. **平台包补位**：pack 时（有网）用 `npm pack` 下载目标平台的 ast-grep/ffi-rs linux 包进 `offline-tgz/`，restore 时补装；darwin-only 包在 restore 时仅告警（功能降级）。
7. **模型**：离线机需在 `models.json` 配本地 provider（如 ollama `http://localhost:11434/v1`），`model_check` 只做提示不自动改。
