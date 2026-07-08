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

### 本地同步

这个仓库当前只面向本人本地使用，不做正式发布。

如需把资源同步到本地 Pi 代理目录，请执行：

```bash
./scripts/sync-to-local-pi.sh
```

默认会把资源同步到当前项目的 .pi/agents；如果要改成同步到用户目录 ~/.pi/agents，可使用：

```bash
./scripts/sync-to-local-pi.sh --target user
```

如果要同时同步到两个位置，则用：

```bash
./scripts/sync-to-local-pi.sh --target both
```

如果只想预览要同步的内容，可先运行：

```bash
./scripts/sync-to-local-pi.sh --dry-run
```
