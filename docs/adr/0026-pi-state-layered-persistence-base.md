# pi-state 分层持久化底座

**决策**：新建 meta 层模块 `pi-state` 作为**分层持久化底座**——提供分层路径解析（default/user/project/session）、原子读写、会话级生命周期钩子，以及"增量状态"（运行时累积的信任规则）语义。`pi-config` 依赖 `pi-state`（不再让状态模块反向依赖配置模块）。

**不升格改名 pi-config**：讨论过"直接把 pi-config 改名为 pi-state"的方案，被否决——pi-config 已被 24 处 import 依赖，"配置"与"状态"是两个不同关注点（深模块原则：一个模块一个深度职责），升格改名只会机械改动 24 处 import 却无收益。正确做法是把 pi-config 里通用的"存储底座"函数（`resolveConfigPaths`/`readJsonFile`/`writeJsonAtomic`）下沉到 pi-state，pi-config 对外 API 不变（`createConfigStore` 等照旧），已有消费方零感知。

**为什么"配置是状态的子集"**：配置 = 无生命周期、用户显式设定、整体覆盖写入的数据；状态 = 运行时增量累积、可能带会话级生命周期的数据。让 pi-state 承担更通用的"分层持久化"，pi-config 作为其上的一层配置语义，依赖方向正确（避免"状态依赖配置"的语义倒置）。

**分发——维持 file: 协议，不发布 npm**：pi-state 继续沿用现有的本地包分发（file: 协议 + `~/.pi/agent/node_modules/@zenone/` 符号链接），**不发布 npm**。被否决的替代方案：

1. **Lombok 式代码内联**（构建期把底座源码烘焙进每个插件）——否决：底座会持续演进，内联放大迭代痛苦（版本漂移、升级要重烘焙 N 个插件），仅适用于"极小且不再变动"的代码。
2. **发 npm（0.x / org-scope / 私有 registry）**——暂缓：并非"未到 1.0 不该发"，npm 的 0.x 与 scope 本就为未稳定代码设计；真正发 npm 的触发器是"**独立 git 仓库的插件在运行时接入底座**"（出现 monorepo 之外的消费者）。届时再发，而非现在。

**会话级文件的过期清理**：会话级状态跟随 sessionId 落盘（`<sessionId>.json`），`/reload` 后仍生效——因此**不得在 session_shutdown 删除会话文件**（`/reload` 会先触发 shutdown，在 shutdown 删除会误删当前会话文件）。清理改用 `cleanupExpiredSessions(pluginName, { maxAgeDays })` / `StateStore.cleanupExpired(maxAgeDays)`：按文件 mtime 删除超过 `maxAgeDays`（默认 30，不传即用默认值）的会话文件，建议在 `session_start` 调用。会话文件保留在插件目录 `~/.pi/agent/extensions-data/<plugin>/` 下，`config.json` / `state.json` 不参与过期清理。

**后果**：涉及基础设施改造，落地后需确认是否同步 AGENTS.md / README.md 的"扩展开发"章节说明。
