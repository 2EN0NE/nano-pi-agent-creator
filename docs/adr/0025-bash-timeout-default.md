# bash 工具默认超时兜底

macOS 自带 bash 没有 GNU `timeout`，且 Pi 内置 bash 工具的 `timeout` 参数无默认值——agent 不显式指定就会无限挂起。新增 `bash-timeout` 扩展：在 `tool_call` 钩子里，仅当 agent 未指定 `timeout` 时为 bash 工具注入默认 300 秒（经 `@zenone/pi-config` 双层可配置），作为**兜底默认值**而非硬上限。

## 考虑过的选项

- **`tool_call` 钩子注入（采用）** vs `createBashTool()` 替换 operations：后者更重，且与 sandbox（已整体接管 bash operations）冲突；前者与 `uv.ts` 同构，最小侵入，天然只覆盖 agent 路径、不碰 `user_bash`。
- **兜底默认（采用）** vs 硬上限：补的是"未指定时的默认值"，agent 对长任务（`npm install`、`git clone` 等）可显式传更大的 `timeout` 放宽。
- **可配置（采用）** vs 硬编码 300：e2e 验证"超时杀进程"路径必须能把默认值调短到秒级，且遵守项目"配置必须走 `@zenone/pi-config`"的强制规范。

## 后果

- 仅作用于 `tool_call`（agent 调用的 bash 工具），用户手动输入的 shell（`user_bash` 事件）不受影响。
- `&` 后台孤儿进程可能漏杀、`a & b` 中 shell 提前退出时超时不触发——这是 Pi 内建 `killProcessTree`/`waitForChildProcess` 的既有边界，本扩展只注入数值、不改变 kill 语义。
- 配置项 `defaultTimeoutSeconds` 设为 `0` 或负数即禁用注入。
