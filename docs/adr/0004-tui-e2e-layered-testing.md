# ADR: TUI E2E 测试分层架构

**状态**：草案，待审核

## 问题

本轮 pi-session-tree v2 开发暴露出测试体系的系统性缺陷：

| Bug                    | 原因                                                                                             | 为什么 758 个 Vitest 全部没测出来                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `m` 标记不工作         | `annotate()` 调了 `pi.appendEntry()`，Pi 的 `appendEntry` 丢弃 `entryId`，永远挂到 `this.leafId` | headless 的 mock `annotate` 正确用了 `entryId` (`sm.addCustomChild(entryId, ...)`) |
| `c/u/a/t` 过滤不生效   | 过滤条件 `raw?.message?.role === 'toolResult'` 可能和 Pi 真实 `SessionEntry` 结构不匹配          | headless 的 `node.raw` 来自手造的 `toSessionEntry()`，不是 Pi 的真实结构           |
| Kitty 协议下按键无响应 | `data === 'm'` 在 Kitty 模式收到 `\x1b[109;1u`                                                   | headless 测试直接传 `'m'` 给 `handleInput()`                                       |

**根因：headless 测试 mock 了 Pi 核心 API（sessionManager, annotate, keybinding），三个 mock 各自偏离真实 Pi 行为。**

## 决策

将 TUI 相关测试分为两层：

```
Layer 1: Component tests (headless, 已有, 改标签)
    Mock: sessionManager, annotate, keybindings, theme
    Run:  Vitest, <30s, 每次 commit
    Test: 渲染布局, 缩进, ANSI 颜色, handleInput 调用, mark/listMarks 生命周期

Layer 2: TUI integration e2e (新增)
    Mock: 仅 LLM API
    Run:  真实 Pi 进程 + PTY, ~2min per module, CI + 提交前手动
    Test:  真实 pi.appendEntry / pi.setLabel, 真实 key dispatch, 真实 SessionEntry 结构
```

## Layer 2 设计

### Mock 边界

**只 mock 一处：LLM 服务的 HTTP 请求**。其他所有 Pi API 均走真实路径：

```
┌──────────────────────────────────────────────────┐
│  Layer 2: TUI integration e2e                     │
│                                                   │
│  mock-llm ← 唯一 mock：返回预设的 assistant 消息  │
│       ↓                                           │
│  真实 pi 进程                                      │
│       ↓                                           │
│  真实 extension 加载 (createSessionTreeWithPi)    │
│       ↓                                           │
│  真实 sessionManager (pi.appendEntry/pi.setLabel) │
│       ↓                                           │
│  真实 key dispatch (Pi TUI → focusedComponent)    │
│       ↓                                           │
│  PTY 捕获 ANSI 输出 → 断言                          │
└──────────────────────────────────────────────────┘
```

### Pi 启动参数约定

e2e 测试或调试时启动 pi，**如非必要一律加 `--no-session`**（不落历史会话记录，避免污染会话树、残留测试数据）。

**例外**：当需要对话记录来定位/验证问题时（如验证会话持久化、分析 session 树），可以不加 `--no-session`。

### 会话构造

测试会话不能依赖 LLM 自由回复——需要确定性的树结构。两种方式：

**方式 A：mock-llm 脚本（推荐）**

mock-llm 的 `setResponses()` 支持多轮脚本：

```typescript
faux.setResponses([
	// Turn 1: agent 调用 bash
	fauxAssistantMessage('Let me check.', [fauxToolCall('bash', 'ls src/', 'App.tsx\nindex.tsx')]),
	// Turn 2: agent 调用 read
	fauxAssistantMessage('Reading package.json.', [
		fauxToolCall('read', 'cat package.json', '{"react":"^18"}'),
	]),
	// Turn 3: 触发 compaction
	fauxAssistantMessage('Project structure is clear.'),
	// ...
]);
```

Pi 收到这些 mock 回复后，session tree 自然产生 user/assistant/toolResult/compaction 等节点。

**方式 B：sendUserMessage 注入（备选）**

在 `session_start` 中直接用 `pi.sendUserMessage()` 注入用户消息流，让 mock-llm 回复。适合不需要复杂 tool call 的场景。

### 按键交互

当前 PTY 测试用 `script` + heredoc，一次性发送所有输入，不支持"打开面板后再按 m"。需要升级：

**方案：`expect` (unix 工具)**

```bash
#!/usr/bin/env expect
spawn pi -a -e .pi/extensions/pi-session-tree/index.ts
expect "session"       # 等待会话启动
send "/custom-session-tree\r"
sleep 1                # 等待面板渲染
send "m"               # 按 m 标记
sleep 0.3
send "\x1b"            # Esc 退出面板
expect eof
```

相比 `node-pty`：

- 无需原生编译依赖
- 支持精准时序控制 (`send`, `sleep`, `expect`)
- macOS/Linux 预装
- 日志通过 `expect_out(buffer)` 获取

**备选：`node-pty`**

```typescript
import * as pty from 'node-pty';
const p = pty.spawn('pi', ['-a', '-e', '...'], { cols: 80, rows: 30 });
p.write('/custom-session-tree\r\n');
await sleep(1000);
p.write('m');
```

- 需要在 `package.json` 加 `node-pty` 依赖
- 跨平台但需编译
- 适合复杂交互（捕获取帧、逐行断言）

**建议**：先用 `expect` 覆盖基础场景（打开面板 → 按键 → 退出），`node-pty` 作为后续优化。

### 断言方式

PTY 捕获的是含 ANSI 转义序列的原始输出。断言分层：

1. **退出码断言**：`expect eof` 正常退出
2. **文本断言**：ANSI 剥离后匹配文本（如 `[m1]`、`已复制`）
3. **帧断言**（node-pty 专属）：按 `\x1b[2J` 等清屏序列分割为帧，对指定帧做 snapshot 对比

### 测试文件组织

```
test/
├── vitest/                    # Layer 1: 单元 + 组件测试
│   ├── extensions/
│   │   ├── pi-session-tree.test.ts
│   │   ├── pi-session-tree-resolve.test.ts
│   │   ├── pi-session-tree-analyze.test.ts
│   │   ├── pi-session-tree-panel.test.ts        # panel 数据
│   │   ├── pi-session-tree-panel.tui.test.ts    # headless TUI 渲染
│   │   ├── pi-session-tree-panel-keyboard.test.ts # headless 键盘
│   │   └── ...
│   └── helpers/
│       └── sandbox.ts
├── e2e/                       # Layer 2: 集成 e2e（真实 Pi，仅 mock LLM）
│   ├── extensions/
│   │   ├── pi-logger/
│   │   │   └── smoke.test.sh
│   │   ├── pi-session-tree/
│   │   │   ├── smoke.test.sh           # print 模式
│   │   │   ├── tui.smoke.test.sh       # TUI 启动 + /quit
│   │   │   └── tui-integration.test.exp # PTY 按键交互（新增）
│   │   └── ...
│   ├── helpers/
│   │   ├── mock-llm.ts
│   │   └── tui-functions.sh
│   └── scripts/
│       └── run-e2e.sh
├── results/
└── README.md
```

**迁移路径**：

1. 将现有 `test/extensions/` 下所有 bash smoke test 移至 `test/e2e/extensions/`
2. `test/helpers/` 移至 `test/e2e/helpers/`
3. `test/scripts/` 移至 `test/e2e/scripts/`
4. `test/e2e/` 下的现有测试重写：确保来自 mock-llm、不 mock Pi 内部 API
5. `test/vitest/` 维持现状，文档标注为 "component tests (headless)"

### 测试分层原则

```
test/vitest/  — 单元 + 组件测试
    Mock: sessionManager, annotate, keybindings, theme（以内存实现替代 Pi API）
    目标: 快速验证逻辑正确性（渲染、布局、API 生命周期）
    约束: 不测 Pi runtime 行为

test/e2e/     — 集成端到端测试
    Mock: 仅 LLM API
    目标: 验证扩展在真实 Pi 进程中的行为
    约束: 每个测试只 mock 大模型服务商，其他均走真实路径
```

### Layer 1 重标

现有 headless Vitest 测试**不删除、不削弱**，但需澄清定位：

- 文件命名：`*.test.ts` → 无需改
- 文档标注：从 "TUI e2e test" 改为 "TUI component test (headless)"
- 明确限制：不测 Pi API 集成、不测真实 key dispatch

## 影响

- `test/README.md`：新增 Layer 2 章节，Layer 1 章节加 headless 标注
- `AGENTS.md`：更新 e2e 一节，补充"TUI 集成测试要求：只 mock LLM"
- `test/helpers/tui-functions.sh`：新增 `tui_expect_test` 函数封装 expect 测试
- 新建 `test/extensions/pi-session-tree/tui-integration.test.exp`
- 可选：`package.json` 加 `node-pty` 为 devDependency

## 非目标

- 不删除现有 headless 测试
- 不改动现有 `run-e2e.sh` 流程（expect 测试作为新 case 加入）
- 不要求每个扩展都写 Layer 2 测试——仅 TUI 交互复杂的扩展（如 pi-session-tree）必写
