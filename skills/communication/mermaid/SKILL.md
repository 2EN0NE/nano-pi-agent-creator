---
name: mermaid
description: '创建/编辑 mermaid 图表的必读指南，附带验证工具'
---

# Mermaid 技能

使用此技能通过官方 Mermaid CLI 解析和渲染来快速验证 Mermaid 图表。

## 前置条件

- Node.js + npm（用于 `npx`）。
- 首次运行会通过 Puppeteer 下载无头 Chromium。如果缺少 Chromium，请设置 `PUPPETEER_EXECUTABLE_PATH`。

## 工具

### 验证图表

```bash
./tools/validate.sh diagram.mmd [output.svg]
```

- 解析并渲染 Mermaid 源码。
- 非零退出码 = Mermaid 语法无效。
- 使用 `beautiful-mermaid` 打印 ASCII 预览（尽力而为；并非所有图表类型都支持）。
- 如果省略 `output.svg`，SVG 渲染到临时文件后丢弃。

## 工作流（简版）

1. **如果图表将嵌入 Markdown**：先在独立的 `diagram.mmd` 中起草（该工具仅验证纯 Mermaid 文件）。
2. 编写/更新 `diagram.mmd`。
3. 运行 `./tools/validate.sh diagram.mmd`。
4. 修复 CLI 显示的错误。
5. 验证通过后，将 Mermaid 块复制到你的 Markdown 文件中。
