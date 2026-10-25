### 8. `/reload` 后状态丢失 — 三种纠正策略

跨多个扩展项目验证的结论。`/reload` 会导致 jiti 重新加载模块，`import.meta.url` 路径不一致，扩展实例的 in-memory 状态全部重置。

| 策略             | 适用场景           | 实现方式                                               |
| ---------------- | ------------------ | ------------------------------------------------------ |
| **配置存入文件** | session 级持久化   | `~/.pi/agent/extensions-data/<name>/<sessionId>.json`  |
| **路径确定性**   | 所有文件操作       | 用 `os.homedir()` 拼接路径，**不用** `import.meta.url` |
| **entry 持久化** | 树状状态（非配置） | `pi.appendEntry()` 写入会话树，`session_start` 时重建  |

**示例（配置存入文件）**：

```typescript
// session_start 时设置 sessionId
pi.on('session_start', async (_event, ctx) => {
	const sid = ctx.sessionManager.getSessionId();
	if (sid) setSessionId(sid); // 加载 <sessionId>.json
});

// /reload 时重新加载
pi.on('session_start', async (_event, ctx) => {
	const sid = ctx.sessionManager.getSessionId();
	if (sid) setSessionId(sid);
	else reloadConfig();
});
```

> ⚠️ **/reload 的关键行为**：`session_shutdown` 先触发（清理旧实例），然后 `session_start` 触发（新实例）。因此旧扩展实例中的闭包、变量、定时器全部失效。所有状态必须在 `session_start` 中重建。
