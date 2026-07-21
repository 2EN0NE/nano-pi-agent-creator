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
- 如果仓库使用了不同的默认分支名，就把它视为“当前版本”，而不是 `main`
- 如果不确定某项改动是否重要，宁可把它写进去，也不要漏掉
