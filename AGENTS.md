# Agent Notes

## 项目基本原则

### 1. 如涉及基础设施改造，完成后需询问是否同步AGENTS.md和README.md说明

正例：如设置logger为所有模块提供日志支撑，logger体系创建或用法修改后，要问用户是否检查AGENTS.md是否涉及这一块的说明，是否要把extensions创建要求更新；
反例：创建一个展示辅助模块（不影响其他模块），在未询问我的建议的情况下，就擅自把这个功能的说明加入了AGENTS.md或README.md

### 2. 完成任务后，要把端到端集成测试完成，再回复最后结果

详见技能 [`e2e-test`](skills/e2e-test/SKILL.md)，测试基础设施在 [`test/`](test/)。

简要流程：

1. 用 `bash test/scripts/run-e2e.sh --ext <name>` 或 `--skill <name>` 执行对应模块测试
2. 查看 `test/results/<latest>/summary.md` 了解测试结果
3. 对标记为 `[REVIEW]` 的用例，逐条读取日志进行 AI 衡量（≤20 条全部判断，>20 条需用户手动比对）
4. 确认所有用例通过或已了解非标结果后，再告知用户"已完成"

常用命令：

```bash
# 运行测试
bash test/scripts/run-e2e.sh --ext pi-logger
bash test/scripts/run-e2e.sh --skill e2e-test
bash test/scripts/run-e2e.sh              # 全部模块

# 查看最新结果
LATEST=$(ls -1t test/results/ | head -1)
cat test/results/$LATEST/summary.md

# 查看单条用例详情
cat test/results/$LATEST/cases/*.log

# 快速手动验证
pi -a --no-session -e ./extensions/foo.ts -p "test prompt"
```

正例：运行 run-e2e.sh → 查看 summary → 衡量 REVIEW 用例 → 确认通过后告知完成。
反例：修改完代码直接告知完成，无真实测试验证。

详情和完整流程见 [`skills/e2e-test/SKILL.md`](skills/e2e-test/SKILL.md)。

## 扩展开发

Pi 扩展放在 [extensions](extensions) 目录中；修改时请在这里更新。若需要参考内部实现，可查看 `pi-mono`，但不要改动其源码。

### 扩展分类体系

`extensions/` 按功能分为 7 个子目录，新扩展必须归入对应分类，不得放回顶层：

| 目录 | 分类 | 说明 |
|------|------|------|
| `tui/` | 交互界面 | 提供终端交互式 UI 的插件（命令面板、选择器、编辑器等） |
| `context/` | 上下文组装 | 修改/增强/组装 system prompt 或会话上下文的插件 |
| `security/` | 审计与安全 | 提供安全保护、审计、权限控制的插件 |
| `auto/` | 自动化 | 自动执行任务的插件，无需或少量用户交互 |
| `accuracy/` | 更精准强大信息获取与操作工具 | 增强或替换内置工具，提供更强大/精准的操作能力 |
| `verification/` | 验证与评估 | 代码审查、质量评估、验证检查的插件 |
| `meta/` | 元插件 | 管理其他插件/工具的插件、管理预设配置的插件，以及提供基础服务的插件 |

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
import { createLogger } from "@zenone/pi-logger";

const log = createLogger("your-extension-name");

// 使用：
log.info("信息");
log.debug("详情");
log.warn("警告");
log.error("错误");
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

### 测试辅助扩展（跨扩展交互测试）

当测试的扩展需要与其它扩展交互（如 tools.ts 拦截动态注册工具），可编写专用测试辅助扩展。

**约定：** 测试辅助扩展放在 `test/extensions/<target>/helpers/` 目录下。

**示例：** `test/extensions/tools/helpers/dynamic-registrar.ts`

- 通过 `pi.registerTool()` 模拟 MCP 工具的注册行为
- 测试用例中通过手动拷贝 + `pi -a --no-session` 运行，不使用 `run_pi_and_check`（因其只搜索 `extensions/` 目录）
- 参考模板：

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLogger } from "@zenone/pi-logger";

const log = createLogger("my-helper");

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "mock_tool",
    label: "Mock Tool",
    description: "...",
    parameters: { type: "object", properties: {}, required: [] },
    execute: async () => ({
      content: [{ type: "text", text: "mock result" }],
      details: undefined,
    }),
  });
  log.info("mock_tool registered");
}
```

测试用例中使用手动隔离环境（见 `test/extensions/tools/smoke.test.sh` 的场景 4/5）。

---

## 本地同步

本仓库的 extension、skill、theme、prompt 开发使用 `scripts/sync-to-local-pi.ts` 管理同步。

### 工作要求

- **所有扩展/技能/主题的开发和测试**必须通过该工具管理，禁止手动复制文件到目标目录
- **开发流程**：在源目录编码 → 内联模式同步到测试目录 → 在 Pi 中测试 → 通过后同步到用户目录
- **最终交付**：开发完成后，必须同步到 `~/.pi/agent/`，完成 UAT 测试确认无误
- **Profile 配置**：修改 `scripts/sync-profiles.yaml` 时需保证 `exclude` 列表准确，不同 Profile 用途清晰

### 快速参考

```bash
# 开发中快速测试（内联模式，指定具体资源和目标）
npx tsx scripts/sync-to-local-pi.ts --ext foo --target ./.pi/test

# 完成开发后部署到用户目录
npx tsx scripts/sync-to-local-pi.ts --profile user-install
```

详细用法参考 [docs/sync-tool.md](docs/sync-tool.md)。
