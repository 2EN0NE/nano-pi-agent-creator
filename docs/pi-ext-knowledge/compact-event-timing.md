# `compact()` 内部事件时序（扩展视角）

> 从 `AGENTS.md`「开发Pi插件一些补充信息」第 1 条归档（该节有 200 行上限）。
> 结论来自逆向阅读 pi 的 `agent-session.js`，官方 `docs/compaction.md` 未提及。

`ctx.compact()` 或内置 compaction 的内部执行顺序：

```text
compact() 内部:
  1. abort()
  2. _compactionAbortController = new AbortController()  ← 从此进入“压缩进行中”
  3. _emit(compaction_start)
  4. prepareCompaction()
  5. emit(session_before_compact)  ← 扩展在这里拦截或提供自定义摘要
  6. 生成摘要（内置默认生成器，或扩展提供的 compaction）
  7. appendCompaction() + _refreshFinalizedContext()
  8. emit(session_compact)     ← ⚠ 压缩控制器仍处于“进行中”
  9. _clearManualCompactionState()  ← 控制器在这里才被清除
 10. _emit(compaction_end)
 11. return → onComplete()     ← ✓ 压缩已彻底结束，安全状态
```

**关键结论：**

- `compact()` **从不断开 agent**（`_disconnectFromAgent()` 只在 `dispose()` 里调用）。旧版本文档“session_compact 时 agent 已断开”的**理由已作废**。
- 但**结论不变**：在 `session_compact` 里调用 `pi.sendUserMessage()` 会**确定性失败**——`prompt()` 在压缩进行中直接
  `throw new Error("Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.")`，
  而压缩控制器要到第 9 步才清除。所有需要与 agent 交互的操作（如 `sendUserMessage`）仍然**只能**放在 `onComplete`。
- 失败是**静默的**：扩展侧 `pi.sendUserMessage()` 是 fire-and-forget（返回 `void`），`prompt()` 的异常只经
  `runner.emitError({ event: "send_user_message" })` 上报，调用方拿不到返回值。
- 上游 `compact()` 里 `compaction_end` 那行注释写着 “listeners may submit queued prompts”，但 `compaction_end`
  **不是扩展事件**（只在会话内部 emitter 上发），扩展拿不到——不要指望它。
- 如果需要捕获触发压缩时的配置状态，使用闭包：
  `const triggerProfile = profile; ctx.compact({ onComplete: () => { /* 用 triggerProfile */ } })`
