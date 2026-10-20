# preset 扩展

定义具名预设（preset），统一切换模型、思考级别、工具集、技能集与 system prompt 指令。

## 三级来源

同名 shadow，优先级 `session > project > user`：

| 来源    | 位置                                             | 持久化                          |
| ------- | ------------------------------------------------ | ------------------------------- |
| session | 会话内存（TUI 面板新建）                         | 不持久化，session_shutdown 清空 |
| project | `<cwd>/.pi/extensions-data/preset/config.json`   | 文件                            |
| user    | `~/.pi/agent/extensions-data/preset/config.json` | 文件                            |

无内置默认 preset（ADR-0032）——没有 config.json 时 preset 列表为空。

## tools 字段三态（preset overlay，ADR-0049）

preset 的 tools 是**叠加层**（不写 `/tools` 的基础状态）；清除/切换预设只撤回叠加层。

| 值                  | 语义                                                                     |
| ------------------- | ------------------------------------------------------------------------ |
| 非空数组            | 白名单（**封闭集**）：只启用列出的工具；运行时新注册的工具一律视为不可用 |
| `[]`（空数组）      | 不限制：撤回叠加层，回到 `/tools` 基础层                                 |
| 未配置（undefined） | 不限制：撤回叠加层（preset 不约束该维度）                                |

## skills 字段三态（preset overlay）

> 注意：与 tools 的语义**不同**——`[]` 在 tools 里是「不限制」，在 skills 里是「全部禁止」。

| 值                  | 语义                             |
| ------------------- | -------------------------------- |
| 非空数组            | 白名单：只启用列出的技能         |
| `[]`（空数组）      | 全部禁止（如 raw-pi 模拟无扩展） |
| 未配置（undefined） | 不限制（撤回叠加层）             |

## preset 激活期间锁死子工具

preset 激活期间，`/tools`、`/skills`、`/prompt` 的**写操作一律被拒绝并告警**（读视图可用）；
要改配置只能经 `/preset` 编辑/切换，或先清除预设。无 preset（`(none)`）时三轴不锁死，
用户可自由维护基础层。

skills 覆盖仅写会话 entry（跨 `/reload` 保持），不写 `/skills` 的 config.json，
避免 preset 切换污染 `/skills` 的跨会话持久化配置。

## 已知限制（pi 机制，ADR-0049 例外）

- **skills 控制与 `/skill:xxx` 不保证一致**：preset 的 skills overlay 控制技能的可见/可调用状态，
  但 pi 的技能命令展开路径不完全受扩展 enabled 状态约束。**不要求** `/skills` 的控制内容与用户经
  `/skill:xxx` 实际可达的内容一致。
- **动态工具遮罩对当轮 system prompt 可能滞后一轮**：`tools.ts` 在 `before_agent_start` 内遮蔽运行时
  新注册的工具，但该事件在各扩展间共享事件开始时的快照；同轮由其它扩展重建 system prompt 时，被遮蔽
  工具的描述可能残留一次，下一轮收敛。工具**调用**层面不滞后（`tool_call` 始终拦截）。

## tool-range 实验报名

`tool-range`（tool-range 实验由 `tools.ts` 自持，见 ADR-0050）**默认只观测、不限制**工具集。
要参与实验分流，在**项目级**配置文件 `<cwd>/.pi/extensions-data/tools/config.json` 显式报名：

```json
{ "enableToolRange": true }
```

报名后 `tools.ts` 才会按 `core` / `full` 臂把结果写进**基础层**（preset 激活期间实验一律退避）。

## 字段

| 字段            | 说明                                  |
| --------------- | ------------------------------------- |
| `provider`      | 模型服务商名                          |
| `model`         | 模型 ID                               |
| `thinkingLevel` | off/minimal/low/medium/high/xhigh/max |
| `tools`         | 工具白名单（见上）                    |
| `skills`        | 技能白名单（见上）                    |
| `instructions`  | 追加到 system prompt 的指令           |

## 用法

- `pi --preset plan` — 以 plan 预设启动
- `/preset` — 打开选择面板
- `/preset implement` — 直接切换到 implement 预设
- `alt+. p` — 打开面板快捷键（降级键 Ctrl+Shift+P）

CLI flag 始终覆盖 preset 值。

## 目录结构

本扩展是「文件夹插件」，聚合 5 个基础子模块（均作为 preset 的基础能力统一注册）：

| 文件               | 职责                                                      |
| ------------------ | --------------------------------------------------------- |
| `index.ts`         | 主入口：preset 面板 + 三级配置 + 聚合加载子模块           |
| `tools.ts`         | `/tools` 工具管理（`__toolsApi` 供 preset 控制工具）      |
| `skills.ts`        | `/skills` 技能管理（`__skillsApi` 供 preset 控制技能）    |
| `model.ts`         | 模型选择（`__modelApi`，复用内置 ModelSelectorComponent） |
| `commands.ts`      | `/commands` 命令列表（SettingsList 带搜索）               |
| `prompt-editor.ts` | `/prompt` prompt 组装检查与控制                           |
