---
name: summarize
description: '使用 `uvx markitdown` 获取 URL 或将本地文件（PDF/DOCX/HTML 等）转换为 Markdown，可选地生成摘要'
---

将"各种内容"（URL、PDF、Word 文档、PowerPoint、HTML 页面、文本文件等）转换为 **Markdown**，以便像普通文本一样检查/引用/处理。

`markitdown` 可以自行获取 URL；本技能主要封装它以方便保存 + 摘要。
对于 PDF 输入，使用 `markitdown[pdf]` 扩展（或下面的封装脚本，它现在会自动处理）。

## 何时使用

当需要以下场景时使用此技能：

- 将网页以类似文档的 Markdown 格式拉取下来
- 将二进制文档（PDF/DOCX/PPTX）转换为 Markdown 进行分析
- 在深度阅读前快速生成长文档的简短摘要

## 快速使用

### 将 URL 或文件转换为 Markdown

从**此技能文件夹**运行（代理应先 `cd` 到此目录）：

```bash
uvx --from 'markitdown[pdf]' markitdown <url-or-path>
```

要将 Markdown 写入临时文件（打印路径），使用封装脚本：

```bash
node to-markdown.mjs <url-or-path> --tmp
```

提示：摘要时，脚本会**始终**将完整的转换后 Markdown 写入临时 `.md` 文件，并**始终**打印最后一条带路径的 "Hint" 行（以便你可以打开/查看完整内容）。

将 Markdown 写入特定文件：

```bash
uvx --from 'markitdown[pdf]' markitdown <url-or-path> > /tmp/doc.md
```

### 使用 haiku-4-5 转换 + 摘要（传递上下文！）

摘要只有在提供了**你想提取的内容**和**受众/目的**时才有用。

```bash
node to-markdown.mjs <url-or-path> --summary --prompt "Summarize focusing on X, for audience Y. Extract Z."
```

或者：

```bash
node to-markdown.mjs <url-or-path> --summary --prompt "Focus on security implications and action items."
```

该过程将：

1. 通过 `uvx --from 'markitdown[pdf]' markitdown` 转换为 Markdown
2. 将完整 Markdown 写入临时 `.md` 文件并打印路径作为 "Hint" 行
3. 运行 `pi --model claude-haiku-4-5`（无工具、无会话）使用你的额外提示进行摘要
