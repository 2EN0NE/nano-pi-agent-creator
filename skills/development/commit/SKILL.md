---
name: commit
description: '在创建 git 提交前阅读此技能'
---

使用简洁的 Conventional Commits 风格主题为当前更改创建 git 提交。

## 格式

`<type>(<scope>): <summary>`

- `type` **必填**。新功能用 `feat`，错误修复用 `fix`。其他常见类型：`docs`、`refactor`、`chore`、`test`、`perf`。
- `scope` **可选**。括号内的影响范围简写名词（如 `api`、`parser`、`ui`）。
- `summary` **必填**。简短祈使句，≤ 72 字符，末尾不加句号。

## 注意事项

- 正文**可选**。如需添加，在主题后空一行，写入简短段落。
- 不要包含破坏性变更标记或页脚。
- 不要添加签名（不要 `Signed-off-by`）。
- 仅提交，不推送。
- 如果不确定某个文件是否应包含在内，请询问用户。
- 将调用方提供的任何参数视为附加的提交指导。常见模式：
    - 自由格式的说明应影响 scope、summary 和 body。
    - 文件路径或 glob 应限制哪些文件参与提交。如果指定了文件，仅 stage/commit 这些文件，除非用户明确要求其他。
    - 如果参数同时包含文件路径和说明，两者均需遵守。

## 步骤

1. 从 prompt 中推断用户是否提供了特定的文件路径/glob 和/或附加说明。
2. 查看 `git status` 和 `git diff` 以了解当前变更（如果指定了文件参数，则限制到那些文件）。
3. （可选）运行 `git log -n 50 --pretty=format:%s` 查看常用的 scope。
4. 如果有歧义的额外文件，在提交前请用户澄清。
5. 仅暂存目标文件（如果未指定文件则暂存所有变更）。
6. 运行 `git commit -m "<subject>"`（如有需要再加上 `-m "<body>"`）。
