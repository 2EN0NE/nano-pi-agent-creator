# Agent Notes

## 项目基本原则

### 1. 如涉及基础设施改造，完成后需询问是否同步AGENTS.md和README.md说明

正例：如设置logger为所有模块提供日志支撑，logger体系创建或用法修改后，要问用户是否检查AGENTS.md是否涉及这一块的说明，是否要把extensions创建要求更新；
反例：创建一个展示辅助模块（不影响其他模块），在未询问我的建议的情况下，就擅自把这个功能的说明加入了AGENTS.md或README.md

### 2. 完成任务后，要把端到端集成测试完成，同步到该去的地方让用户测试

详见技能 [`e2e-test`](skills/e2e-test/SKILL.md)，测试基础设施在 [`test/`](test/)。

测试框架有两个途径：

#### 路径 A：bash e2e 测试（run-e2e.sh）

传统 bash 测试，涵盖所有扩展和技能。

```bash
# 运行测试
bash test/scripts/run-e2e.sh --ext pi-logger
bash test/scripts/run-e2e.sh --skill e2e-test
bash test/scripts/run-e2e.sh              # 全部模块

# CI 模式（自动注入 mock-llm，无需 API Key）
CI=true bash test/scripts/run-e2e.sh --ext pi-logger

# 查看最新结果
LATEST=$(ls -1t test/results/ | head -1)
cat test/results/$LATEST/summary.md
cat test/results/$LATEST/cases/*.log

# 快速手动验证
pi -a --no-session -e ./extensions/foo.ts -p "test prompt"
```

#### 路径 B：Vitest 结构化测试（推荐用于新扩展）

基于 TypeScript 的结构化测试，速度更快，可并行。

```bash
# 运行全部 Vitest 测试
npm test

# 监听模式（开发使用）
npm run test:watch

# CI 模式下输出 JUnit XML
npm run test:ci
```

Vitest 测试文件在 `test/vitest/extensions/<name>.test.ts` 中。编写示例见 [`test/vitest/extensions/pi-logger.test.ts`](test/vitest/extensions/pi-logger.test.ts)。

#### 验证流程

1. 确定变更影响范围（扩展/技能/基础设施）
2. 运行对应测试（`run-e2e.sh` 或 `npm test`）
3. 查看结果汇总，对 `[REVIEW]` 用例逐条 AI 衡量（≤20 条全量，>20 条建议手动）
4. 确认所有用例通过后，同步到用户目录，再告知完成

正例：运行 run-e2e.sh → 查看 summary → 衡量 REVIEW 用例 → 确认通过后告知完成。
反例：修改完代码直接告知完成，无真实测试验证。

详情和完整流程见 [`skills/e2e-test/SKILL.md`](skills/e2e-test/SKILL.md)。

#### Husky Hook 体系

项目使用 husky v9 管理 git hooks，按分层策略组织：**CI 是绝对标准（全部阻塞），本地 hook 轻重分层对齐 CI，但跳过耗时步骤。**

| 层             | 触发时机     | 耗时 | format:check | typecheck            | lint/eslint           | test (vitest) | e2e       | semgrep       |
| -------------- | ------------ | ---- | ------------ | -------------------- | --------------------- | ------------- | --------- | ------------- |
| **CI**         | `git push`   | 全量 | ✅ 阻塞      | ✅ 阻塞              | ✅ 阻塞               | ✅ 阻塞       | ✅ 阻塞   | ✅ ERROR 阻塞 |
| **pre-push**   | `git push`   | 中   | —            | ✅ 有 .ts 变更时阻塞 | —                     | ✅ 阻塞       | ✅ 仅变更 | —             |
| **pre-commit** | `git commit` | ~5s  | ✅ 阻塞      | —                    | ✅ auto-fix 仅 staged | ✅ 阻塞       | —         | —             |

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
2. **`npm test`** — Vitest 单元测试（阻塞，对齐 CI `unit-tests` job）
3. **e2e 测试** — 自动检测本次推送变更的扩展/技能，只运行受影响模块

```bash
# 修改 extensions/auto/loop.ts → 推送前自动运行:
bash test/scripts/run-e2e.sh --ext loop
```

> pre-commit 是 `git commit` 时触发，pre-push 是 `git push` 时触发。若需要跳过 hook 使用 `--no-verify` 参数。
>
> **⚠️ 对 coding agent 的约束**：本项目的 commit/sync 工具和 ci-watch 修复流程中，prompt 已约束 agent 不得使用 `--no-verify` 跳过 hook。如需手动维护，请在 commit 前确保 `npm run format:check && npm run typecheck` 通过。

### 除非用户在最后一次对话中明确指明要你git操作，不要做任何改变git状态的操作

用户提到的commit、提交等词语说的是git操作，需要以中文作为主要语言进行。但仅对最后一次说话有效，后续再修改的操作，不要越俎代庖帮用户自动git commit了，每一次git改变状态的操作1）只限定在用户最后一次对话的一轮行动中；2）如果你想主动做，都要和用户确认。

- 正例：用户在最后一次对话中指明“请帮我提交此次变更”，你从对话中识别到针对什么插件进行了哪些文件的改动，从git status中把相应改变的文件进行add，剔除了不相关的文件（其他之前staged的不相干的文件剔除，本次对话产生的一些临时性文件加入了.gitignore），然后按过去的commit规范以中文提交了（可使用项目中的commit技能）
- 反例：用户在前一轮对话说过“帮我提交”，这一轮是要我修改错误，没有在话语中提到“帮我提交”，就默认为修改完的要提交，自动commit -a合并了。

## 扩展开发

Pi 扩展放在 [extensions](extensions) 目录中；修改时请在这里更新。若需要参考内部实现，可查看 `pi-mono`，但不要改动其源码。

### 扩展分类体系

`extensions/` 按功能分为 7 个子目录，新扩展必须归入对应分类，不得放回顶层：

| 目录            | 分类                         | 说明                                                                                                                                                                                                                                                                   |
| --------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tui/`          | 交互界面                     | 提供终端交互式 UI 的插件（命令面板、选择器、编辑器等）                                                                                                                                                                                                                 |
| `context/`      | 上下文组装                   | 修改/增强/组装 system prompt 或会话上下文的插件                                                                                                                                                                                                                        |
| `security/`     | 审计与安全                   | 提供安全保护、审计、权限控制的插件                                                                                                                                                                                                                                     |
| `auto/`         | 自动化                       | 自动执行任务的插件，无需或少量用户交互                                                                                                                                                                                                                                 |
| `accuracy/`     | 更精准强大信息获取与操作工具 | 增强或替换内置工具，提供更强大/精准的操作能力                                                                                                                                                                                                                          |
| `verification/` | 验证与评估                   | 代码审查、质量评估、验证检查的插件                                                                                                                                                                                                                                     |
| `meta/`         | 元插件                       | 管理其他插件/工具的插件、管理预设配置的插件，以及提供基础服务的插件。注意这里面的插件设计定位是最基础层的，其他插件可以依赖这里面的插件，这里面的插件应避免依赖其他类别的插件。npm install应把这里面的插件变为本地包，其他插件对其的依赖通过包引用，而不是相对路径引用 |

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

> ⚠️ **注意**：`pi-logger/` 和 `pi-rate-limiter/` 虽然本质是基础设施，但它们是作为 Pi 扩展机制实现的，因此归入 `meta/`（元插件）。

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

日志输出由 pi-logger 的配置文件统一管控（`pi-logger.json`），扩展本身无需关心输出目的地和级别过滤。详细说明见 [skills/pi-logger/SKILL.md](skills/pi-logger/SKILL.md)

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

> ⚠️ **pi-logger 例外**：pi-logger 是其他扩展依赖的基础设施，为避免循环依赖，保留自身配置加载机制，但搜索路径已对齐到标准 `extensions-data/pi-logger/config.json`。

详细 API 说明见 [`extensions/meta/pi-config/README.md`](extensions/meta/pi-config/README.md)。

### 扩展的快捷键设计

建议以alt（option)+插件英文首字母或关联字母为插件相关快捷键，一个插件不应占用太多快捷键，建议一个插件有众多功能都需要分配快捷键时，采用二级组合按键的形式进行设计。

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
import { registerFauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai';
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

详见 [e2e-test 技能的 Mock LLM 测试章节](.pi/skills/e2e-test/SKILL.md#mock-llm-测试)。

#### TUI 模式测试

工程支持 **TUI 交互模式测试**。对使用 `ctx.ui.custom()`、覆盖层、选择器等 TUI 功能的扩展，应编写 TUI 测试。

**和普通测试的区别：**

| 维度     | 普通测试 (smoke.test.sh)     | TUI 测试 (tui.smoke.test.sh)    |
| -------- | ---------------------------- | ------------------------------- |
| Pi 模式  | `pi -a --no-session` (print) | `pi -a` (TUI 交互)              |
| 测试手段 | 发送 prompt，检查 stdout     | 通过 PTY 发送按键，捕获屏幕输出 |
| 验证方式 | exit code + 日志 grep        | ANSI 输出剥离后文本匹配         |
| 适用场景 | 加载、工具调用、日志         | 覆盖层渲染、键盘交互、快捷键    |

**快速参考：**

```bash
# 运行 TUI 测试
bash test/scripts/run-e2e.sh --ext quit --tui

# 不指定 --tui 时会自动补充运行 tui.smoke.test.sh
bash test/scripts/run-e2e.sh --ext quit    # 同时跑 smoke + tui
```

**TUI 测试文件命名：** `test/extensions/<name>/tui.smoke.test.sh`

**核心 API（定义在 `test/helpers/tui-functions.sh`）：**

| 函数                                       | 用途                                 |
| ------------------------------------------ | ------------------------------------ |
| `tui_run_pi_test <exts> <input> <timeout>` | 在 PTY 中启动 TUI 模式 pi 并发送输入 |
| `tui_assert_contains <text>`               | 断言 TUI 输出包含文本                |
| `tui_assert_matches <regex>`               | 断言 TUI 输出匹配正则                |
| `tui_cleanup`                              | 清理临时文件                         |

**注意事项：**

- TUI 测试在隔离沙箱中运行，会自动创建 `node_modules/@zenone/pi-logger` 链接
- **避免触发 LLM 调用**（不要发 `hi`/`hello`），直接发 `/command` 即可
- `session_shutdown` 中的输出可能因 PTY 关闭而丢失
- 退出码 124（timeout）在 LLM 未返回时是预期的

**已有样例：** `test/extensions/quit/tui.smoke.test.sh`

完整文档见 [`test/README.md`](test/README.md) 和 [`skills/e2e-test/SKILL.md`](skills/e2e-test/SKILL.md)。

### TUI 设计约定

#### 不要使用 Emoji/图标

TUI 组件的渲染**禁止使用 emoji 和 Unicode 图标字符**（如 📋📜✅❌⭐🔍▼▊→ 等）。原因：

1. **宽度不确定性**：emojii 在不同终端的显示宽度不同（单宽或双宽），`visibleWidth()` 和 `truncateToWidth()` 可能无法正确处理，导致 `Rendered line exceeds terminal width` 崩溃
2. **可读性**：部分终端/字体不支持 emoji，显示为方块
3. **搜索/过滤不便**：emoji 无法用文字匹配

**替代方案**：一律使用纯文本表示：

- `[Strategies]` 代替 `[📋 Strategies]`
- `OK/BLOCK` 代替 `✅/❌`
- `>` (大于号) 代替 `→` 表示选中
- `_` (下划线) 代替 `▊` 表示光标

#### `truncateToWidth` 安全网

每个 TUI `render()` 方法返回的每一行，都必须用 `truncateToWidth(line, width)` 包裹作为最后的安全保障，确保不会超过终端宽度。

```typescript
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

// ✅ 正确: 每行都经过 truncateToWidth
lines.push(truncateToWidth(th.fg('accent', title), width));
lines.push(truncateToWidth('│  ' + content, width));

// ❌ 错误: 不包裹可能导致崩溃
lines.push(th.fg('accent', title));
```

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

---

## 开发Pi插件一些补充信息

> **动态维护策略**：本节 ≤200 行。每次新增知识前先检查已有条目，进行合并与综合。若超限，将最早或最长的条目移入 `docs/pi-ext-knowledge/` 下独立文件并引用。
> 本节内容由 `.pi/skills/extract-pi-knowledge/SKILL.md` 技能从 `~/.pi/agent/sessions/` 会话历史中自动提取分析得到。

以下信息在 Pi 官方文档（`docs/extensions.md`, `docs/compaction.md`）中**没有提及**，需要阅读 agent-session.js 源码才能理解。记录在此以便后续扩展开发一次改对。

### 1. `compact()` 内部事件时序

`ctx.compact()` 或内置 compaction 的内部执行顺序（需逆向阅读 `agent-session.js`）：

```
compact() 内部:
  1. _disconnectFromAgent()    ← ⚠ 先断开 agent 连接
  2. abort()
  3. emit(session_before_compact)  ← 扩展在这里拦截或提供自定义摘要
  4. appendCompaction()
  5. emit(session_compact)     ← ⚠ 此时 agent 已断开
  6. finally: _reconnectToAgent()  ← 重连 agent
  7. return → onComplete()     ← ✓ agent 已重连，安全状态
```

**关键结论：**

- `session_compact` 事件触发时 agent **已断开连接**。在此事件中调用 `pi.sendUserMessage()` → `this.prompt()` **不可靠**（agent 不在线，prompt 和消息发送无法正常处理）。
- `onComplete` 回调在 `compact()` **完全返回后**触发，此时 agent **已重连**。所有需要与 agent 交互的操作（如 `sendUserMessage`）必须放在 `onComplete` 中。
- 如果需要捕获触发压缩时的配置状态，使用闭包：`const triggerProfile = profile; ctx.compact({ onComplete: () => { /* 用 triggerProfile */ } })`

### 2. `isIdle()` 的时机限制

`ctx.isIdle()` 的实现本质是：

```typescript
isIdle = () => !this.isStreaming;
```

关于 `isIdle()` 有几个坑：

| 事件            | isIdle() 状态                    | 说明                                                   |
| --------------- | -------------------------------- | ------------------------------------------------------ |
| `turn_end`      | `false`                          | agent 仍在事件循环中                                   |
| `agent_end`     | **可能仍为 false**               | `isStreaming` 标志结束时间 **滞后于** `agent_end` 事件 |
| `agent_settled` | `true`（除非其他扩展启动新 run） | 这是唯一保证 idle 的事件                               |

**正确用法：**

- 不要用 `isIdle()` 来判断压缩时机——用 **独立 flag**（如 `compactingInProgress`）做重入保护
- 要监听 idle 状态用 `agent_settled`，不是 `agent_end`
- `agent_end` 后虽然 `isIdle()` 可能仍 false，但可以用 `compactingInProgress` flag 防止多实例冲突

### 3. `complete()` 调用全流程注意事项

`@earendil-works/pi-ai` 的 `complete()` 有两处文档未提及的细节：

**① Auth 解析不会走 Pi 的 ModelRegistry**

内部通过 `getEnvApiKey(model.provider)` 解析 API Key，**只检查环境变量**。但用户通常通过 `models.json` / auth storage 配置 Key。必须手动调用 `ctx.modelRegistry.getApiKeyAndHeaders()` 解析后传入 options：

```typescript
const auth = await ctx.modelRegistry.getApiKeyAndHeaders(modelInfo);
const options: Record<string, unknown> = { maxTokens: 8192, signal };
if (auth.ok) {
	if (auth.apiKey) options.apiKey = auth.apiKey;
	if (auth.headers) options.headers = auth.headers;
}
const response = await complete(modelInfo, { messages }, options as any);
```

**② `Response.errorMessage` 在 `stopReason: "error"` 时有值**

```typescript
if (response.stopReason === 'error') {
	log.error('Model call failed', { errorMessage: response.errorMessage });
}
```

### 5. `npx pi` vs 全局 `pi` 的 CLI 参数差异

| 二进制                   | `-a`       | `--no-session` | `-e`/`--extension` |
| ------------------------ | ---------- | -------------- | ------------------ |
| `$(which pi)` (全局安装) | ✓          | ✓              | ✓                  |
| `npx pi`                 | 可能不支持 | ✓              | 可能不支持         |

**e2e 测试必须用 `$(which pi)`**，不能用 `npx pi`。

### 6. `sendUserMessage()` 的可靠性限制

`pi.sendUserMessage()` 内部调用 `this.prompt()`。当 agent 处于断开状态时（如 `session_compact` 事件期间），`prompt()` 的调用路径不可靠，且错误被 `.catch()` 吞掉（`agent-session.js:1717`），没有失败的信号。

**正确用法**：只在以下时机调用 `sendUserMessage`：

- `onComplete` 回调中（已确认 agent 重连）
- 普通事件处理器中（确保 agent 在线）
- 使用 `deliverAs: "followUp"` 作为默认（排队等待当前处理后执行）

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

跨多个扩展项目验证的结论。`/reload` 会导致 jiti 重新加载模块，`import.meta.url` 路径不一致，扩展实例的 in-memory 状态全部重置。

| 策略             | 适用场景           | 实现方式                                               |
| ---------------- | ------------------ | ------------------------------------------------------ |
| **配置存入文件** | session 级持久化   | `~/.pi/agent/extensions-data/<name>/<sessionId>.json`  |
| **路径确定性**   | 所有文件操作       | 用 `os.homedir()` 拼接路径，**不用** `import.meta.url` |
| **entry 持久化** | 树状状态（非配置） | `pi.appendEntry()` 写入会话树，`session_start` 时重建  |

**示例（配置存入文件）**：

```typescript
// session_start 时设置 sessionId
pi.on('session_start', async (_event, ctx) => {
	const sid = ctx.sessionManager.getSessionId();
	if (sid) setSessionId(sid); // 加载 <sessionId>.json
});

// /reload 时重新加载
pi.on('session_start', async (_event, ctx) => {
	const sid = ctx.sessionManager.getSessionId();
	if (sid) setSessionId(sid);
	else reloadConfig();
});
```

> ⚠️ **/reload 的关键行为**：`session_shutdown` 先触发（清理旧实例），然后 `session_start` 触发（新实例）。因此旧扩展实例中的闭包、变量、定时器全部失效。所有状态必须在 `session_start` 中重建。

### 9. E2E 测试扩展的常见陷阱

从多个扩展的 e2e 测试中总结：

| 陷阱                          | 原因                          | 修复                                               |
| ----------------------------- | ----------------------------- | -------------------------------------------------- |
| **日志检查用 stdout**         | pi-logger 写文件，非 stdout   | 检查 `.pi/logs/<name>_*.log`                       |
| **`npx pi` vs `$(which pi)`** | `npx pi` 的参数集可能不同     | 测试脚本用 `$(which pi)`                           |
| **print 模式下扩展不加载**    | `pi -p` 不触发全部 life cycle | 用 `pi -a --no-session`                            |
| **测试数据残留**              | 会话文件持久化                | 每次测试前 `rm -rf ~/.pi/agent/sessions/--tmp-*--` |
| **assert stdout 文本**        | TUI/ANSI escape 序列干扰      | grep 模式匹配而非全文比对                          |

### 10. 累加式指标追踪器的 checkpoint 设计模式

对于在会话中累积指标（计数、Set 去重、比率等）的扩展，`session_shutdown` 保存不够——`/reload` 后 tracker 从 0 开始，sigma 全偏差。

**关键设计**：

```typescript
// ① tracker 提供原始状态的导出/导入（非 ratio，是原始计数）
exportRawState(): TrackerRawState {
  return { thinkingSteps, userQuestions, agentTurns, toolTypes: [...set] };
}
importRawState(state): void { /* 恢复所有计数器 + Set */ }

// ② 三个 checkpoint 时机：指标变化时 + turn 边界 + 销毁时
function saveCheckpoint() { saveLiveState(sessionId, tracker.exportRawState()); }
// refreshMessage 检测到指标变化后 → saveCheckpoint()
// turn_end → saveCheckpoint()（turn 边界安全点）
// session_shutdown → appendSession() + deleteLiveState()（清理）

// ③ session_start 时恢复
const live = await loadLiveState(sessionId);
if (live) tracker.importRawState(live);
```

**触发条件**：扩展在会话中累积计数/集合/比率，且需要跨 `/reload` 保持一致性。
**反模式**：只在 `session_shutdown` 保存，或只保存比率不保存原始计数。

> 具体实现参考：`extensions/tui/whimsical/metrics.ts` / `index.ts` / `session-store.ts` 中的 save/load/delete checkpoint 完整实现。

### 11. Pi 挂起调试：扩展 vs 无扩展对比诊断

当 Pi 在运行中卡住（5min+ 无响应）而 `pi -ne`（无扩展模式）正常，根因通常是某个扩展的 `complete()` 调用未正确处理 API 错误，或事件处理器进入无限循环。

**诊断步骤**：

1. **确认同步状态**：检查 `.pi/extensions/` 下对应扩展是否与源码版本一致——`ls -la .pi/extensions/<name>/` 对比文件时间戳，不一致则重新 sync
2. **检查 `complete()` 错误处理**：确认每次调用有 `stopReason === "error"` 的日志和超时 signal 传递
3. **清 jiti 缓存**：`rm -rf node_modules/.cache/jiti` 后重启
4. **逐个排除**：在 `models.json` 的 `extensions` 列表中逐个去除扩展定位问题扩展

**反模式**：只在 `-ne` 模式确认正常即断定是"Pi 本身的问题"，必须先排除上述三项。

---

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

# 开发中快速测试（内联模式）
npx tsx scripts/sync-to-local-pi.ts --ext foo --target ./.pi/test

# 预览所有 profile 的变更
npx tsx scripts/sync-to-local-pi.ts --dry-run
```

详细用法参考 [docs/sync-tool.md](docs/sync-tool.md)。
