### 10. 累加式指标追踪器的 checkpoint 设计模式

对于在会话中累积指标（计数、Set 去重、比率等）的扩展，`session_shutdown` 保存不够——`/reload` 后 tracker 从 0 开始，sigma 全偏差。

**关键设计**：

```typescript
// ① tracker 提供原始状态的导出/导入（非 ratio，是原始计数）
exportRawState(): TrackerRawState {
  return { thinkingSteps, userQuestions, agentTurns, toolTypes: [...set] };
}
importRawState(state): void { /* 恢复所有计数器 + Set */ }

// ② 三个 checkpoint 时机：指标变化时 + turn 边界 + 销毁时
function saveCheckpoint() { saveLiveState(sessionId, tracker.exportRawState()); }
// refreshMessage 检测到指标变化后 → saveCheckpoint()
// turn_end → saveCheckpoint()（turn 边界安全点）
// session_shutdown → appendSession() + deleteLiveState()（清理）

// ③ session_start 时恢复
const live = await loadLiveState(sessionId);
if (live) tracker.importRawState(live);
```

**触发条件**：扩展在会话中累积计数/集合/比率，且需要跨 `/reload` 保持一致性。
**反模式**：只在 `session_shutdown` 保存，或只保存比率不保存原始计数。

> 具体实现参考：`extensions/tui/whimsical/metrics.ts` / `index.ts` / `session-store.ts` 中的 save/load/delete checkpoint 完整实现。
