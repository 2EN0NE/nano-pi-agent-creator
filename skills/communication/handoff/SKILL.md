---
name: handoff
description: 将当前对话压缩为交接文档，供另一个 agent 继续工作。
argument-hint: '下一个会话将用于什么？'
disable-model-invocation: true
---

编写一个交接文档，总结当前对话，以便一个新的 agent 可以继续工作。保存到用户操作系统的临时目录——不是当前工作区。

在文档中包含一个"suggested skills"（建议技能）部分，建议应调用的技能。

不要复制已在其他产物（spec、计划、ADR、issue、commit、diff）中捕获的内容。通过路径或 URL 引用它们。

删除任何敏感信息，如 API 密钥、密码或个人身份信息。

如果用户传递了参数，将其视为下一个会话将关注的内容的描述，并相应地调整文档。
