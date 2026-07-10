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
isIdle = () => !this.isStreaming
```

关于 `isIdle()` 有几个坑：

| 事件 | isIdle() 状态 | 说明 |
|------|--------------|------|
| `turn_end` | `false` | agent 仍在事件循环中 |
| `agent_end` | **可能仍为 false** | `isStreaming` 标志结束时间 **滞后于** `agent_end` 事件 |
| `agent_settled` | `true`（除非其他扩展启动新 run） | 这是唯一保证 idle 的事件 |

**正确用法：**
- 不要用 `isIdle()` 来判断压缩时机——用 **独立 flag**（如 `compactingInProgress`）做重入保护
- 要监听 idle 状态用 `agent_settled`，不是 `agent_end`
- `agent_end` 后虽然 `isIdle()` 可能仍 false，但可以用 `compactingInProgress` flag 防止多实例冲突

### 3. `complete()` 的 Auth 解析不会走 Pi 的 ModelRegistry

`@earendil-works/pi-ai` 的 `complete()` 函数内部通过 `getEnvApiKey(model.provider)` 解析 API Key，**只检查环境变量**：

```typescript
// pi-ai 内部（provider/openai-completions.js）:
const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
```

但用户通常通过 Pi 的 `models.json`、`settings.json` 或 auth storage 配置 API Key，**不一定会设置环境变量**。

Pi 正常流程通过 `ModelRegistry.getApiKeyAndHeaders(model)` 解析 auth，它会依次检查：
1. auth storage（OAuth/登录状态）
2. provider config 中的 `apiKey` 字段（来自 models.json）
3. 环境变量（最后回退）

**正确做法**：调用 `complete()` 前，必须先用 `ctx.modelRegistry.getApiKeyAndHeaders(modelInfo)` 显式解析 auth，并将 `apiKey` 和 `headers` 传入 options：

```typescript
const auth = await ctx.modelRegistry.getApiKeyAndHeaders(modelInfo);
const options: Record<string, unknown> = { maxTokens: 8192, signal };
if (auth.ok) {
  if (auth.apiKey) options.apiKey = auth.apiKey;
  if (auth.headers) options.headers = auth.headers;
}
const response = await complete(modelInfo, { messages }, options as any);
```

### 4. `Response.errorMessage` 在 `stopReason: "error"` 时有值

当 `complete()` 返回的 `response.stopReason === "error"` 时，`response.errorMessage` 包含错误详情（如 "401 Unauthorized"）。这个字段在文档中没有明确说明。

**使用方式**：
```typescript
if (response.stopReason === "error") {
  log.error("Model call failed", { errorMessage: response.errorMessage });
  // response.errorMessage 包含 API 返回的具体错误
}
```

### 5. `npx pi` vs 全局 `pi` 的 CLI 参数差异

| 二进制 | `-a` | `--no-session` | `-e`/`--extension` |
|--------|------|---------------|-------------------|
| `$(which pi)` (全局安装) | ✓ | ✓ | ✓ |
| `npx pi` | 可能不支持 | ✓ | 可能不支持 |

**e2e 测试必须用 `$(which pi)`**，不能用 `npx pi`。

### 6. `sendUserMessage()` 的可靠性限制

`pi.sendUserMessage()` 内部调用 `this.prompt()`。当 agent 处于断开状态时（如 `session_compact` 事件期间），`prompt()` 的调用路径不可靠，且错误被 `.catch()` 吞掉（`agent-session.js:1717`），没有失败的信号。

**正确用法**：只在以下时机调用 `sendUserMessage`：
- `onComplete` 回调中（已确认 agent 重连）
- 普通事件处理器中（确保 agent 在线）
- 使用 `deliverAs: "followUp"` 作为默认（排队等待当前处理后执行）

### 7. `Failed to load extension` 调试路径

从会话历史分析，这是最高频的启动失败模式。通常原因有 3 类：

| 原因 | 典型报错 | 检查方法 |
|------|---------|---------|
| **文件未同步** | `Failed to load extension ".../extensions/foo.ts"` | `ls -la .pi/extensions/foo/` 文件是否存在 |
| **npm 依赖未安装** | `Cannot find module "xxx"` 或 `TS2307: cannot find module` | `ls .pi/extensions/foo/node_modules/` 或 `npm ls`（从扩展目录） |
| **jiti 缓存陈旧** | 修改后加载旧版本 | `rm -rf node_modules/.cache/jiti` + 重启 pi |

**调试流程**：
1. 检查目标文件是否存在（尤其是刚用 sync 工具的）
2. 检查依赖安装（有 `package.json` 的扩展需要 `npm install`）
3. 清除 jiti 缓存后重试
4. `pi -e ./extensions/foo/index.ts` 直接加载看错误详情（绕过 auto-discovery）

### 8. `/reload` 后状态丢失 — 三种纠正策略

跨多个扩展项目验证的结论。`/reload` 会导致 jiti 重新加载模块，`import.meta.url` 路径不一致，扩展实例的 in-memory 状态全部重置。

| 策略 | 适用场景 | 实现方式 |
|------|---------|---------|
| **配置存入文件** | session 级持久化 | `~/.pi/agent/extensions-data/<name>/<sessionId>.json` |
| **路径确定性** | 所有文件操作 | 用 `os.homedir()` 拼接路径，**不用** `import.meta.url` |
| **entry 持久化** | 树状状态（非配置） | `pi.appendEntry()` 写入会话树，`session_start` 时重建 |

**示例（配置存入文件）**：
```typescript
// session_start 时设置 sessionId
pi.on("session_start", async (_event, ctx) => {
  const sid = ctx.sessionManager.getSessionId();
  if (sid) setSessionId(sid);  // 加载 <sessionId>.json
});

// /reload 时重新加载
pi.on("session_start", async (_event, ctx) => {
  const sid = ctx.sessionManager.getSessionId();
  if (sid) setSessionId(sid);
  else reloadConfig();
});
```

> ⚠️ **/reload 的关键行为**：`session_shutdown` 先触发（清理旧实例），然后 `session_start` 触发（新实例）。因此旧扩展实例中的闭包、变量、定时器全部失效。所有状态必须在 `session_start` 中重建。

### 9. E2E 测试扩展的常见陷阱

从多个扩展的 e2e 测试中总结：

| 陷阱 | 原因 | 修复 |
|------|------|------|
| **日志检查用 stdout** | pi-logger 写文件，非 stdout | 检查 `.pi/logs/<name>_*.log` |
| **`npx pi` vs `$(which pi)`** | `npx pi` 的参数集可能不同 | 测试脚本用 `$(which pi)` |
| **print 模式下扩展不加载** | `pi -p` 不触发全部 life cycle | 用 `pi -a --no-session` |
| **测试数据残留** | 会话文件持久化 | 每次测试前 `rm -rf ~/.pi/agent/sessions/--tmp-*--` |
| **assert stdout 文本** | TUI/ANSI escape 序列干扰 | grep 模式匹配而非全文比对 |

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
