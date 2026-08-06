# src/tui/ — 公共 TUI 辅助模块

> 位置：`src/tui/helpers.ts`  
> 维护者：nano-pi-agent-creator  
> 最后更新：2025-07-30

pi-tui（`@earendil-works/pi-tui`）不提供原生的 Grid / Table / 两列布局组件，所有布局通过 `Container` 垂直堆叠 + 手动行渲染实现。本模块沉淀项目内已验证的布局与检测模式，供各 TUI 面板复用。

---

## 1. colLayout — 两列布局

### 用途

为两列面板（如 pi-lab 的「命名空间 | 实验」）提供精确的列宽计算和行渲染函数。

### 接口

```typescript
import { colLayout, type ColLayout } from '../../src/tui/helpers.js';

const layout: ColLayout = colLayout({
	width: currentWidth - 2, // 可用宽度（通常减去左边距）
	leftRatio: 0.36, // 左列占比，默认 0.36
	separator: dim(' │ '), // 列分隔符，默认 dim(' │ ')
});
```

### 方法

| 方法                            | 参数               | 返回值   | 说明                                           |
| ------------------------------- | ------------------ | -------- | ---------------------------------------------- |
| `row(left, right)`              | 左列内容, 右列内容 | `string` | 渲染一行，左列 padEnd 到 `lw`，中间插入 `sep`  |
| `header(leftTitle, rightTitle)` | 左标题, 右标题     | `string` | 同 row，但左列使用 `padEnd(lw)` 对齐，适合表头 |

### 属性

| 属性  | 类型     | 说明                                   |
| ----- | -------- | -------------------------------------- |
| `lw`  | `number` | 左列宽度（含填充）                     |
| `rw`  | `number` | 右列宽度（参考值，row 不强制截断右列） |
| `sep` | `string` | 分隔符（含 ANSI 样式）                 |

### 使用示例

```typescript
// 在 panel.ts 的 rebuild() 中
const lay = colLayout({ width: currentWidth - 2 });

container.addChild(new Text(lay.header('命名空间', '实验'), 0, 0));

for (let i = 0; i < maxRows; i++) {
	const left = formatNamespace(namespaces[i]);
	const right = formatExperiment(experiments[i]);
	container.addChild(new Text(lay.row(left, right), 0, 0));
}
```

### 注意

- 左列和右列内容中如果包含 ANSI 转义（如 `theme.fg()` 的输出），`padEnd` 的宽度对齐由 **调用方** 保证——如果 ANSI 序列的 `visibleWidth` 与 `String.length` 不一致，竖线可能对不齐。
- 推荐：左列使用纯文本或固定宽度片段，调用样色主题函数前先确保其不影响对齐。

---

## 2. divider — 分隔线

### 用途

生成全宽水平分隔线（用于面板顶部/底部与内容区之间）。

### 函数

```typescript
import { divider, dimDivider, type StyleFn } from '../../src/tui/helpers.js';

// accent 色分隔线
container.addChild(divider(currentWidth, (s) => theme.fg('accent', s)));

// dim 色分隔线
container.addChild(dimDivider(currentWidth, (s) => theme.fg('dim', s)));
```

> 等价于 `new Text(fn('─'.repeat(width)), 0, 0)`，封装为语义清晰的调用。

---

## 3. checkAlignment — 对齐检测

### 用途

离线检测多行文本中分隔符（如竖线 `│`）是否在同一列位置。  
主要用于 **e2e 测试脚本**，验证两列/多列面板渲染后竖线未因 ANSI / 宽度计算错误而偏移。

### 接口

```typescript
import { checkAlignment, type AlignmentResult } from '../../src/tui/helpers.js';

const result: AlignmentResult = checkAlignment(visibleLines, '│', 1);
// result.ok === true → 所有竖线在 tolerance 内对齐
// result.ok === false → maxDeviation > tolerance，需检查渲染
```

### 返回值

| 字段             | 类型       | 说明                                          |
| ---------------- | ---------- | --------------------------------------------- |
| `ok`             | `boolean`  | 所有行对齐通过（`maxDeviation <= tolerance`） |
| `positions`      | `number[]` | 每行竖线的列位置（0-based index）             |
| `expectedColumn` | `number`   | 基于众数的预期列位置                          |
| `maxDeviation`   | `number`   | 最大偏差列数                                  |

### 在 bash e2e 中使用

```bash
test_it "vertical bars align" <<'TEST'
  tui_run_pi_test_width "my-ext,helper" "/cmd" 15 100

  # 去掉 ANSI 转义
  strip_ansi < "$TUI_OUTPUT_FILE" > visible.txt

  # 提取含 │ 的行，检查竖线列号一致
  local bars=$(grep -n '│' visible.txt)
  local positions=()
  while IFS=: read -r lno line; do
    positions+=($(echo "$line" | awk '{print index($0, "│")}'))
  done <<<"$bars"

  # 检查所有位置偏差 <= 1
  local first=${positions[0]}
  for p in "${positions[@]}"; do
    [[ $(($p - $first)) -gt 1 || $(($first - $p)) -gt 1 ]] && echo "MISALIGNED" && exit 1
  done
  echo "PASS: all │ aligned within 1 column"
  tui_cleanup
TEST
```

> **PTY 限制**：`script` 命令可能无法完整捕获 overlay 面板内容；若 `positions` 为空，测试应标记 `[REVIEW]` 而非 FAIL。对齐精度需在真实终端中人工确认。

---

## 迁移指南

### 新 TUI 面板 Checklist

- [ ] 用 `colLayout()` 替代手动 `padEnd` + 拼接 `│`
- [ ] 在 `render()` 中每行用 `truncateToWidth(line, width)`
- [ ] 用 `divider()` 替代 `new Text(accent('─'.repeat(n)))`
- [ ] e2e 中加入竖线对齐检测（如适用）
- [ ] 对齐无法自动化 → 标记 `[REVIEW]`
