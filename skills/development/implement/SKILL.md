---
name: implement
description: 基于 spec 或一组 ticket 实现工作。用户给出 spec 或 ticket 后使用。
disable-model-invocation: true
---

实现用户在 spec 或 ticket 中描述的工作。

在可能时使用 `/tdd`，在预先约定的 seam 处。

定期运行类型检查，定期运行单个测试文件，最后运行完整测试套件一次。

完成后，使用 `/code-review` 审查工作。

将工作提交到当前分支。
