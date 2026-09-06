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

## tools 字段三态

| 值                  | 语义                               |
| ------------------- | ---------------------------------- |
| 非空数组            | 白名单：只启用列出的工具，其余禁用 |
| `[]`（空数组）      | 不限制：恢复全部工具               |
| 未配置（undefined） | 不改变当前工具状态                 |

## skills 字段三态

> 注意：与 tools 的语义**不同**——`[]` 在 tools 里是「不限制」，在 skills 里是「全部禁止」。

| 值                  | 语义                             |
| ------------------- | -------------------------------- |
| 非空数组            | 白名单：只启用列出的技能         |
| `[]`（空数组）      | 全部禁止（如 raw-pi 模拟无扩展） |
| 未配置（undefined） | 不限制（不改变技能状态）         |

skills 覆盖仅写会话 entry（跨 `/reload` 保持），不写 `/skills` 的 config.json，
避免 preset 切换污染 `/skills` 的跨会话持久化配置。

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
