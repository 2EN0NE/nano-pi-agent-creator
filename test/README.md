# Test Infrastructure

本仓库采用双层测试架构：**Vitest 单元/组件测试** + **bash 集成 e2e 测试**。

## 目录结构

```
test/
├── vitest/                              # Layer 1: 单元 + 组件测试（headless / mock）
│   ├── extensions/                       # 每个扩展的 vitest 测试
│   │   ├── pi-logger.test.ts
│   │   ├── pi-session-tree-*.test.ts
│   │   └── ...
│   ├── helpers/
│   │   ├── sandbox.ts                    # 沙箱管理 + pi 执行
│   │   └── tui-runner.ts                 # node-pty TUI runner
│   └── experiments/                     # POC 测试（非正式）
│
├── e2e/                                 # Layer 2: 集成 e2e 测试（真实 Pi，仅 mock LLM）
│   ├── extensions/                       # 每个扩展的 bash 测试
│   │   ├── pi-logger/
│   │   │   ├── smoke.test.sh            # print 模式
│   │   │   ├── tui-expect.smoke.test.sh # TUI 模式（expect，推荐）
│   │   │   └── tui-integration.test.exp # TUI 模式（独立 expect 脚本）
│   │   └── ...
│   ├── skills/                           # 每个技能的 bash 测试
│   │   └── e2e-test/
│   │       └── smoke.test.sh
│   ├── helpers/
│   │   ├── mock-llm.ts                   # Mock LLM 扩展（唯一允许的 mock）
│   │   ├── tui-functions.sh             # TUI 测试辅助函数
│   │   └── tui-layout-helper.ts
│   └── scripts/
│       └── run-e2e.sh                    # 主 e2e 运行器
│
├── results/                              # 测试结果输出（gitignored）
│   └── <timestamp>/
│       ├── summary.md                    # 全局汇总
│       └── extensions/<name>/summary.md  # 模块级汇总
│
└── README.md                             # 本文件
```

## 分层设计

```
test/vitest/  — 单元 + 组件测试（headless）
    Mock:  MockTerminal, 内存 sessionManager, 手造 annotate, mock keybindings
    目标:  快速验证逻辑正确性（渲染布局、API 生命周期、handleInput 调用）
    时长:  <30s，每次 commit 运行
    约束:  不测 Pi runtime 行为（pi.appendEntry / pi.setLabel / 真实 key dispatch）

test/e2e/     — 集成端到端测试（真实 Pi 进程）
    Mock:  仅 LLM API（mock-llm）
    目标:  验证扩展在真实 Pi 进程中的行为
    时长:  ~2min/module，CI + 提交前手动运行
    约束:  每个测试只 mock 大模型服务商，其他 Pi API 均走真实路径
```

> **铁律**：`test/e2e/` 下的所有测试，如果 mock 了 LLM 以外的任何 Pi API（sessionManager、annotate、keybinding），视为不合规。

详见 ADR：[`docs/adr/0004-tui-e2e-layered-testing.md`](../docs/adr/0004-tui-e2e-layered-testing.md)。

## 使用方法

### Vitest 测试（Layer 1）

```bash
npm test                 # 运行一次
npm run test:watch       # 监听模式
npm run test:ci          # CI 模式（JUnit XML）
```

### bash e2e 测试（Layer 2）

```bash
# 运行指定模块
bash test/e2e/scripts/run-e2e.sh --ext pi-logger
bash test/e2e/scripts/run-e2e.sh --skill e2e-test

# TUI 模式测试
bash test/e2e/scripts/run-e2e.sh --ext quit --tui

# CI 模式（自动注入 mock-llm，无需 API Key）
CI=true bash test/e2e/scripts/run-e2e.sh --ext pi-logger
```

### 查看结果

```bash
LATEST=$(ls -1t test/results/ | head -1)
cat test/results/$LATEST/summary.md
cat test/results/$LATEST/extensions/pi-logger/summary.md
```

## Mock 边界

### Layer 1 (vitest) 允许的 mock

- `MockTerminal` / `InteractiveMockTerminal`（替代真实终端）
- 内存版 sessionManager / annotate
- mock keybindings / theme
- mock LLM（`registerFauxProvider()`）

### Layer 2 (e2e) 允许的 mock

- **仅 LLM**：`test/e2e/helpers/mock-llm.ts` 提供的 `mock-llm` 扩展

### CI 模式

`CI=true` 时自动注入 `mock-llm` 扩展，无需真实 API Key。所有测试可直接在 CI 中运行。

## 编写测试

### Vitest 测试

```typescript
import { describe, it, expect } from 'vitest';
import {
	MockTerminal,
	renderToSnapshot,
	dispatchInput,
	stripAnsi,
	assertWithinWidth,
} from '../../src/tui-testing/index.js';
import { TUI } from '@earendil-works/pi-tui';

describe('MyPanel TUI', () => {
	it('不超宽', () => {
		const tui = new TUI(new MockTerminal(80, 24));
		tui.addChild(new MyPanel());
		const snapshot = renderToSnapshot(tui, 80, 24);
		assertWithinWidth(snapshot, 80);
	});
});
```

### bash e2e 测试

```bash
test_describe "my-extension"

test_it "loads without errors" <<'TEST'
  run_pi_and_check \
    --extensions "pi-logger,my-ext" \
    --prompt "hi" \
    --expect-no-error
TEST
```

## TUI 模式测试

所有 TUI e2e 测试统一使用 **expect** 作为 PTY 后端。

### 两种测试模式

| 模式 | 函数              | 适用场景                          | 文件                       |
| ---- | ----------------- | --------------------------------- | -------------------------- |
| bash | `tui_expect_test` | expect 驱动 bash 测试（推荐）     | `tui-expect.smoke.test.sh` |
| 独立 | 独立 `.exp` 脚本  | 复杂交互（多轮 expect/send 闭环） | `tui-integration.test.exp` |

> **`tui_run_pi_test` 已废弃**：原 script+heredoc 函数保留但不再用于新测试。所有 TUI 测试已迁移至 expect。

### bash 测试（tui_expect_test）

```bash
test_it "loads in TUI mode without crash" <<'TEST'
  tui_expect_test "pi-logger,my-ext" '
    send "/command\r"
    sleep 3
  ' 15
  if [[ "$TUI_EXIT_CODE" -eq 0 ]]; then
    echo "PASS"
  fi
  tui_assert_contains "expected text"
  tui_cleanup
TEST
```

### 交互测试（tui_expect_test）

```bash
test_it "opens panel and responds to keys" <<'TEST'
  tui_expect_test "pi-logger,my-ext" '
    send "/command\r"
    sleep 1
    expect -re {Panel Title} { }
    send "m"
    sleep 0.3
    expect -re {Marked} { }
    send "\033"
  ' 15
  tui_cleanup
TEST
```

TUI 测试辅助函数定义在 `test/e2e/helpers/tui-functions.sh`。

## 结果解读

- **PASS** — 自动化断言通过
- **FAIL** — 自动化断言失败
- **[REVIEW]** — 需 AI 人工衡量（如渲染效果、超宽检测等）

`[REVIEW]` 数量 ≤20 时由 AI 逐条衡量，>20 时建议用户手动比对。
