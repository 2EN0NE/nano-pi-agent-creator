# ADR-0033: 会话级状态跨 /reload 持久化（30 天过期清理）+ 内置默认 preset

- 状态：已接受（2026-09）
- 相关组件：`extensions/meta/preset`、`extensions/security/permission-gate`、`extensions/meta/pi-state`

## 背景

此前三个决策共享同一前提「**会话级 = 会话结束即失效**」：

- ADR-0032 决策 2：preset 会话级仅存内存（`Map`），`session_shutdown` 清空，不做文件持久化。
- ADR-0032 决策 5：撤销硬编码默认，无 config.json 时 presets 为空。
- ADR-0025：permission-gate 的 critical 放行规则沉淀层级为「会话级（会话结束失效）」。

实践中该前提与 `/reload` 语义冲突：`/reload` 会先触发 `session_shutdown`，但 sessionId 不变，用户期望「会话内临时设定在 /reload 后仍生效」。据此做出统一设计转向。

## 决策

1. **会话级状态跨 /reload 持久化**：会话级状态跟随 sessionId 落盘到
   `~/.pi/agent/extensions-data/<plugin>/<sessionId>.json`，`/reload` 后由 `session_start` 恢复。
   `session_shutdown` 仅解绑 sessionId，**不删除会话文件**。
2. **过期清理替代立即删除**：会话文件按 mtime 保留 `maxAgeDays` 天（默认 30，不传即用默认值），
   由 `pi-state` 的 `cleanupExpiredSessions` / `StateStore.cleanupExpired` 在 `session_start` 清理。
   `config.json` / `state.json` 不参与过期清理（见 ADR-0026）。
3. **preset 内置默认**：用户级 `config.json` 不存在时，`ensureDefaultPresets()` 写入
   `plan`/`implement`/`raw` 三套默认预设（开箱即用）；已存在则跳过，不覆盖、不合并。
4. **permission-gate 会话级放行同样跨 /reload**：critical 放行规则与手动策略的会话层从
   「会话结束失效」改为「跨 /reload 保留，30 天过期清理」。

## 取代

- ADR-0032 决策 2（会话级仅存内存）→ 取代为本决策 1/2。
- ADR-0032 决策 5（撤销硬编码默认）→ 取代为本决策 3。
- ADR-0025 中 critical 的「会话级（会话结束失效）」→ 取代为本决策 4。

## 后果

- **正向**：会话级临时设定在 /reload 后不丢失；开箱即用有默认 preset；清理逻辑统一由 pi-state 提供。
- **负向**：会话级文件会残留（最长 30 天）；critical 放行规则的信任窗口从「会话结束」放宽到
  「30 天」，这是安全语义的实质放宽，须确保用户知晓。
