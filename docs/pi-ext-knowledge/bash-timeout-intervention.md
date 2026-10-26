# 内置 bash 工具：timeout 无默认值与两条干预路径

> 从 `AGENTS.md`「开发Pi插件一些补充信息」#14 移出（该节有 200 行上限）。

Pi 内置 bash 工具的 `timeout` 参数 schema 是 `optional, no default timeout`——agent 不显式传就无限等待（macOS 无 GNU `timeout`，尤为危险）。`bash-timeout` 扩展（`extensions/accuracy/bash-timeout.ts`）在 `tool_call` 钩子里补默认 300s 兜底（`@zenone/pi-config` 双层可配，配置项 `defaultTimeoutSeconds`，设 0 即禁用），仅当 agent 未指定时注入、不设上限。

干预内置 bash 工具有两条路径，单个扩展须二选一。两条路径可共存（tool_call 钩子注入不与 sandbox 的 operations 替换冲突）；真正互斥的是同用 operations 替换的多个扩展之间：

| 路径               | 机制                                       | 采用者           |
| ------------------ | ------------------------------------------ | ---------------- |
| tool_call 钩子注入 | `pi.on('tool_call', ...)` mutate `input`   | uv、bash-timeout |
| operations 替换    | `createBashTool(cwd, { operations })` 接管 | sandbox          |

超时语义（改 `input.timeout` 不改变 Pi 的 kill 逻辑）：`spawn(bash, ["-c", 整条命令])` 后自 spawn 起计墙钟时间，超时 `killProcessTree` 用 `kill(-pid, SIGKILL)` 杀进程组。`a | b` 共享一个超时、`a; b` 合计、`a & b` 中 shell 提前退出则超时不触发且后台孤儿可能漏杀——均为 Pi 既有边界，非扩展引入（详见 ADR-0025）。
