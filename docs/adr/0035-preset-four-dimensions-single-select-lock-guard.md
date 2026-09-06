# ADR-0035: preset 四维度统一、单选交互与锁定守卫

- 状态：已接受（2026-09）
- 相关组件：`extensions/meta/preset`（`index.ts`、`tools.ts`、`skills.ts`、`prompt-editor.ts`）
- 延伸：ADR-0034（`/mode` 恢复 + instructions 组件化）

## 背景

preset 的四个「可变维度」——model、tools、skills、prompt——此前地位不一：model/tools/skills
有独立命令、会话级状态、`detectDrift` 偏离检测；prompt（prompt-editor 的 overrides）却是
模块级内存、无持久化、无偏离检测，是四者中的特例。同时 preset 面板的 Enter 键语义（直接激活）
与「查看详情」混在一起，且缺少「锁定当前配置不被临时改动」的能力。

## 决策

1. **四维度统一**：model/tools/skills/prompt 平级，各维度职责一致——独立功能入口 +
   会话级状态持久化 + 变化监听 + 与 activePreset 比对后偏离提示。prompt 维度补齐：
   prompt-editor 的 overrides 从模块级内存改为会话级持久化（与 tools/skills 同走
   session 层），`detectDrift` 新增 `instructions` 维度（偏离判定见 ADR-0034 决策 3）。

2. **preset 单选交互改造**：preset 为单选、可取消。一级列表按键改为——
   `Enter` 与 `→` 同义（进详情看配置），`Space` 切换激活/取消（激活当前项；已激活项再按
   Space 即取消选中）。`onDone` 语义从「Enter 即激活」改为「Space 才激活」。

3. **详情面板锁定守卫**：详情面板新增 `l` 键切换「锁定」（toggle 激活/取消），`Preset`
   增加 `locked?: boolean` 字段并随 preset 三级持久化（默认不锁定）。锁定的 preset 处于
   激活态时，四维度任一修改若将导致偏离，则**拒绝修改**而非 widget 提醒——`setStatus`
   显示 error：`因为 preset 已锁定，<维度> 修改不被允许`。

## 锁定守卫的实现约束

- tools/skills/prompt 的修改入口在 preset 目录内（`/tools`、`/skills`、`/prompt`），
  可在变更前通过 globalThis 守卫检查锁定并拒绝。
- `/model` 是 pi 内置命令，preset 无法前置拦截其入口；若锁定且用户切 model 导致偏离，
  退化为「事后回滚 + error 提示」（`model_select` 事件里检测锁定偏离并回滚），而非静默放行。
- 守卫仅在「锁定且会导致偏离」时拒绝；锁定但修改不偏离（如改回 preset 设定值）应放行。
- **第三方覆盖缺口与 turn 边界兜底**：前置守卫只覆盖 preset 目录内的修改入口
  （`/tools`、`/skills`、`/prompt`），第三方插件绕过入口直接改 tools/skills/instructions
  无法前置拦截。因此 `turn_start` 做「兜底回滚」：`detectDrift` 检测五维度，对锁定 preset
  的偏离维度改回设定值（tools→`__toolsApi.replaceTools`、skills→`__skillsApi.replaceSkills`、
  instructions→`__promptEditorApi.clearOverride`）并 `notify`（warning，每次回滚都提示）。
  model/thinking 已有 `model_select`/`thinking_level_select` 事件即时回滚，turn 兜底同时
  覆盖其「事件回滚失败」的残留偏离。

## 权衡

| 方案                                 | 结论                                             |
| ------------------------------------ | ------------------------------------------------ |
| A. 四维度各自为政（prompt 维持特例） | 拒绝：行为不一致，用户对「偏离」的预期落空       |
| B. 四维度统一 + 锁定守卫（本决策）   | 采纳：单一心智模型，锁定提供「防止误改」的硬约束 |
| C. 锁定仅提醒不拒绝                  | 拒绝：用户明确要求「拒绝修改」，提醒无法阻止误改 |

## 后果

- **正向**：prompt 与 model/tools/skills 行为一致；Enter 语义回归「查看」，激活/取消交由
  显式 Space；锁定给「临时配置」加了一道防误改护栏。
- **负向**：锁定守卫需在四个维度入口各自接入，实现面广；`/model` 无法前置拦截，只能事后
  回滚，存在「先切过去再弹回」的短暂闪变；tools/skills/instructions 的第三方改动只能
  turn 边界兜底，存在「本轮内偏离生效、下一轮 `turn_start` 才改回」的延迟窗口；`locked`
  字段进入 `Preset` 数据模型，需同步写回路径。
