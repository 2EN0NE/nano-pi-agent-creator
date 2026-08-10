# TUI Headless 测试框架

不依赖真实终端（PTY / process.stdout）的 TUI 渲染测试方案。

## 动机

当前 Pi 扩展的 TUI 开发流程中，Agent 完成编码后无法感知终端渲染的实际效果——边框是否对齐、颜色是否正确、内容是否溢出——只能依赖人工测试。PTY 捕获方案存在根本性局限：

- **Overlay 内容不可验证**（使用光标定位绘制，PTY 流无法可靠还原）
- **颜色/主题不可验证**（strip_ansi 后全部丢失）
- **交互流程不可验证**（按键后状态切换的正确性）
- **truncateToWidth 是否生效不可验证**

本框架通过 **MockTerminal + any 桥接** 实现 headless snapshot 测试：在 Node.js 进程内直接调用 TUI 渲染管线，获取带完整 ANSI 转义序列的纯文本行数组，无需任何外部进程或终端模拟器。

## 架构

```
Component.render(width) → string[]        ← 纯函数
        +
compositeOverlays(lines, w, h)            ← any 桥接私有方法
        +
applyLineResets(lines)                    ← any 桥接私有方法
        ↓
renderToSnapshot(tui, width, height) → string[]  ← 完整渲染结果（含 ANSI）
```

## 快速开始

### 安装

框架位于 `src/tui-testing/`，零外部依赖（仅需 `@earendil-works/pi-tui` 的类型）。

### 基础用法：快照渲染

```typescript
import {
	MockTerminal,
	renderToSnapshot,
	stripAnsi,
	TuiMainScreen,
} from '../../src/tui-testing/index.js';

// 1. 创建 headless TUI
const term = new MockTerminal(80, 24);
const tui = new TuiMainScreen(term);

// 2. 挂载组件
tui.addChild(myComponent);

// 3. 获取 snapshot
const snapshot = renderToSnapshot(tui, 80, 24);
// → string[]，每行含完整 ANSI 颜色、SGR reset

// 4. 断言
expect(stripAnsi(snapshot[0])).toContain('Settings');
expect(snapshot.some((l) => l.includes('\x1b[36m'))).toBe(true); // 颜色验证
```

### 交互测试：模拟按键（首选：dispatchInput）

```typescript
import {
	MockTerminal,
	renderToSnapshot,
	dispatchInput,
	stripAnsi,
	TuiMainScreen,
} from '../../src/tui-testing/index.js';

// 1. 创建 headless TUI
const tui = new TuiMainScreen(new MockTerminal(80, 24));
const panel = new MyComponent();
tui.addChild(panel);
tui.setFocus(panel);

// 2. 初始 snapshot
const before = renderToSnapshot(tui).map(stripAnsi);

// 3. 直接注入按键（和 compositeOverlays 一样的 any 桥接模式）
dispatchInput(tui, '\t'); // Tab
dispatchInput(tui, '\x1b'); // Escape
dispatchInput(tui, '+'); // 普通字符

// 4. 验证状态变更
const after = renderToSnapshot(tui).map(stripAnsi);
expect(after).not.toEqual(before);
```

**原理**：`dispatchInput` 通过 `any` 桥接直接调用 `TUI.handleInput()`（私有方法），与 `renderToSnapshot` 调用 `compositeOverlays()` 是同一种模式。**无需 `tui.start()`，无需特殊 Terminal 类。**

### 交互测试（高级）：模拟完整终端事件链路

当需要测试从终端协议到 TUI 输入解析的完整链路时（如 Kitty keyboard protocol、input listeners、OSC 响应消费），使用 `InteractiveMockTerminal`：

```typescript
import {
	InteractiveMockTerminal,
	renderToSnapshot,
	stripAnsi,
	TuiMainScreen,
} from '../../src/tui-testing/index.js';

const term = new InteractiveMockTerminal(80, 24);
const tui = new TuiMainScreen(term);
tui.addChild(myComponent);
tui.setFocus(myComponent);
tui.start(); // 必须：建立 terminal → handleInput 链路

term.sendInput('\t');
// sendInput → onInput 回调 → handleInput 完整路径（含 OSC 消费、input listeners、kitty 协议处理）
```

**大多数场景用 `dispatchInput` 即可**，`InteractiveMockTerminal` 仅用于测试 TUI 事件路由层本身的正确性。

### 验证宽度约束

```typescript
import { assertWithinWidth } from '../../src/tui-testing/index.js';

const snapshot = renderToSnapshot(tui, 80, 24);
assertWithinWidth(snapshot, 80); // 任一行超过 80 即抛异常
```

### Snapshot 比对

```typescript
import { diffSnapshots, stripAnsi } from '../../src/tui-testing/index.js';

const snapA = renderToSnapshot(tui).map(stripAnsi);
// ... 修改组件状态 ...
const snapB = renderToSnapshot(tui).map(stripAnsi);

const diff = diffSnapshots(snapA, snapB, 'CounterPanel');
if (diff.changed) {
	console.log(diff.diffs.join('\n'));
}
```

## API 参考

### `MockTerminal`

```typescript
class MockTerminal implements Terminal {
	constructor(columns = 80, rows = 24);
	setSize(columns: number, rows: number): void; // 动态修改终端尺寸
	// Terminal 接口其余方法均为空实现
}
```

### `dispatchInput(tui, data)` 【推荐】

直接向 TUI 注入按键事件。通过 `any` 桥接调用 `TUI.handleInput()`。

- **无需 `tui.start()`**：不需要建立 terminal → handleInput 链路
- **无需特殊 Terminal 类**：用普通 `MockTerminal` 即可
- 与 `compositeOverlays()` 相同的桥接模式
- 链路：`dispatchInput` → `TUI.handleInput` → `focusedComponent.handleInput` → 状态变化

```typescript
const tui = new TuiMainScreen(new MockTerminal(80, 24));
tui.addChild(myComponent);
tui.setFocus(myComponent);
dispatchInput(tui, '\t');
```

### `InteractiveMockTerminal extends MockTerminal`（高级）

```typescript
class InteractiveMockTerminal extends MockTerminal {
	start(onInput, onResize): void; // 保存 onInput 回调
	sendInput(data: string): void; // 模拟终端发送原始终端序列
}
```

**按键速查表：**

| 操作           | 序列                                            |
| -------------- | ----------------------------------------------- |
| Tab            | `'\t'`                                          |
| Escape         | `'\x1b'`                                        |
| Enter          | `'\r'`                                          |
| Ctrl+C         | `'\x03'`                                        |
| 普通字符       | `'+'`, `'a'`, `'0'` 等                          |
| Kitty 协议按键 | 使用 `@earendil-works/pi-tui` 的 `Key` 辅助生成 |

### `renderToSnapshot(tui, width?, height?)`

获取 TUI 完整渲染结果（含 overlay + ANSI 颜色 + SGR reset）。

- 幂等：相同状态产生相同输出
- 同步：不依赖 `doRender()` 的异步差分渲染管道
- 可被多次调用，获取不同时刻的渲染快照

### `stripAnsi(str)`

剥离 CSI / OSC / APC 三类 ANSI 转义序列，得到纯文本。

### `assertWithinWidth(lines, maxWidth)`

断言所有行的 `visibleWidth` ≤ `maxWidth`，超宽即抛异常。

### `diffSnapshots(a, b, label?)`

逐行比较两个 snapshot，返回差异列表（最多 10 处）。

## 测试文件位置

```
test/vitest/extensions/<name>.tui.test.ts   ← TUI 组件测试（使用本框架）
test/vitest/experiments/                     ← POC 参考测试
src/tui-testing/                             ← 框架源码
```

## 与 TuiRunner（PTY 方案）的选择

| 场景                                        | 推荐方案                                        |
| ------------------------------------------- | ----------------------------------------------- |
| 组件渲染正确性（边框、颜色、内容）          | `renderToSnapshot()` + strip 断言               |
| 按键后 UI 变化                              | `dispatchInput()` → `renderToSnapshot()` → diff |
| 宽度约束（truncateToWidth 生效）            | `assertWithinWidth()`                           |
| 终端事件链路（kitty 协议、input listeners） | `InteractiveMockTerminal`                       |
| 扩展完整生命周期（加载/卸载/崩溃）          | TuiRunner（node-pty）+ PTY                      |
| 与真实模型交互的端到端流程                  | TuiRunner（node-pty）                           |

**原则：能用 headless 测的都用 headless。交互场景首选 `dispatchInput()`。**

## 参考资料

- `test/vitest/experiments/headless-snapshot-poc.test.ts` — 快照渲染 POC（15 用例全通过）
- `test/vitest/experiments/headless-interactive-poc.test.ts` — 交互流程 POC（8 用例全通过）
- Pi TUI 设计文档：`docs/tui-design-principles.md`
- Pi TUI 辅助函数：`docs/tui-helpers.md`
