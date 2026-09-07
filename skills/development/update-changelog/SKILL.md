---
name: update-changelog
description: '在更新 changelog 前阅读此技能'
---

更新仓库的 changelog，内容应当包括从上一次发布到当前版本（`main`）之间尚未纳入的变更。如果 `CHANGELOG.md` 不存在，就使用 `CHANGELOG`。

## 分步流程

### 1. 确定基线版本

如果没有提供基线版本，就使用最近的 git tag。可以通过 `git describe --tags --abbrev=0` 找到它。

### 2. 查找 git 中的提交

使用以下命令收集提交信息：

```bash
# 获取基线版本（如果没有提供）
git describe --tags --abbrev=0

# 获取自基线版本以来的所有提交
git log <baseline-version>..HEAD
```

### 3. 更新 changelog

阅读现有的 changelog 文件（`CHANGELOG.md`，如果不存在则用 `CHANGELOG`），检查是否有尚未纳入的变更，然后把它们添加进去。始终只把内容添加到 "Unreleased" 部分。如果还没有这一节，就在顶部按照现有 changelog 的风格补一个（例如 `## Unreleased` 与 `## [Unreleased]`）。

## 编写 changelog 时的基本规则

### 内容指南

- 关注对用户有影响的显著变化（功能、修复、破坏性变更）
- 如果有 PR 号，就写上（`#NUMBER`），但不要写原始提交哈希
- 忽略不重要的变更（拼写错误、内部重构、次要文档更新）
- 相关改动可以适当归类合并
- 按重要性排序：先写破坏性变更，再写新功能，最后写修复

### 风格指南

- 使用有效的 Markdown 语法
- 每条条目都以过去式动词或描述性短语开头
- 保持条目简洁，但足够清楚地说明变更内容
- 对每一项变更使用项目符号（`*` 或 `-`）
- 对代码引用使用反引号格式（例如 `` `foo.cleanup` ``）

### 示例格式

```markdown
## 2.13.0

- Added multi-key support to the `|sort` filter. #827
- Fix `not undefined` with strict undefined behavior. #838
- Added support for free threading Python. #841

## 2.12.0

- Item or attribute lookup will no longer swallow all errors in Python. #814
- Added `|zip` filter. #818
- Fix `break_on_hyphens` for the `|wordwrap` filter. #823
- Prefer error message from `unknown_method_callback`. #824
- Ignore `.jinja` and `.jinja2` as extensions in auto escape. #832
```

### 好的示例与不好的示例

**好的示例：**

- `Fixed an issue with the TypeScript SDK which caused an incorrect config for CJS.`
- `Added support for claim timeout extension on checkpoint writes.`
- `Improved error reporting when task claim expires.`

**不好的示例：**

- `Fixed bug`（太模糊）
- `Updated dependencies`（除非是安全修复，否则不重要）
- `Refactored internal code structure`（内部改动，不是面向用户的）
- `Fixed typo in comment`（不重要）

## 备注

- 如果当前 changelog 已经有 "Unreleased" 段落且其中有内容，就把新内容追加到它里面，而不是替换它
- 保留现有 changelog 的风格与格式（标题、列表样式、顺序、空行）
- 如果仓库使用了不同的默认分支名，就把它视为"当前版本"，而不是 `main`
- 如果不确定某项改动是否重要，宁可把它写进去，也不要漏掉

## TODO 审查（发版/更新 changelog 前必做）

本仓库的工程级 TODO 统一集中在 `.pi/todos/TODO.md`（单一事实来源，本地开发记录，不随代码分发）。每次更新 changelog 前，先做一次 TODO 审查，把「已完成」和「未完成」区分清楚，避免 changelog 遗漏已落地的修复。

> **文件不存在则跳过**：`.pi/todos/TODO.md` 是本地开发记录（gitignore 内），其他机器 clone 后可能没有此文件。若文件不存在，直接跳过本节审查，无需创建或报错。

### 审查流程

1. **读取集中清单**：`.pi/todos/TODO.md`，定位「已完成（归档）」和各级未完成分区。
2. **逐项验证未完成项**：对每条 `[ ]`（未完成）TODO，按它标注的「验证方式」检查代码/文件/测试是否已落地：
    - 检查对应文件/函数是否存在
    - 检查是否有测试覆盖
    - 用 `git log --oneline -- <相关文件>` 确认是否已有提交落地
3. **划掉已完成项**：把 `[ ]` 改为 `[x]`，移动到「已完成（归档）」分区，并在对应的 changelog 条目里体现这次落地。
4. **未完成项**：保留原状；如优先级发生变化（如某个 TODO 变成发布阻断），在清单里调整它的分区。
5. **新增 TODO**：一律登记到 `.pi/todos/TODO.md` 对应优先级分区（带状态、现状、验证方式），**禁止散落在代码注释之外的临时文件**（如 `TUI-TODO-*.md`、`*.scratch/*.md`）。

### 代码注释 TODO 的处理

- 代码内 `// TODO:` 注释**允许保留**（就近原则，方便阅读者当场看到），但必须同步登记到 `.pi/todos/TODO.md`，否则只有代码注释而无集中跟踪，审查时会被遗漏。
- 反之，`.pi/todos/TODO.md` 里某条 TODO 落地后，应同步删除/更新对应代码注释。

### 常用检查命令

```bash
# 列出所有未完成 TODO
grep -nE "^### \[ \]" .pi/todos/TODO.md

# 列出已归档 TODO
grep -nE "^### \[x\]" .pi/todos/TODO.md

# 确认某 TODO 相关的提交历史（示例）
git log --oneline -- extensions/meta/pi-lab/ui/panel.ts
```
