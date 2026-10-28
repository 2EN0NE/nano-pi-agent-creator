# ADR-0065: 工具权威与"默认工具选择"复位

- 状态：**已接受**（2026-10-25 grilling 收敛；落地票见 `.scratch/preset-tool-authority/issues/`）
- 相关组件：`extensions/meta/preset`（`tools.ts` / `index.ts` / `skills.ts`）、`@zenone/pi-config`、`@zenone/pi-state`
- 延伸：**修正** ADR-0049（"约束是 overlay，基础层原样保留"在 pi 1.4 下不成立）、**修订** ADR-0050（"限制权只有两个来源"漏了 pi 自己的装载清单）
- 术语：见 `CONTEXT.md`「preset 预设」节（默认工具选择 / 装载清单 / 基础层 / 约束叠加层 / 陈旧引用）

## 背景

ADR-0049/0050 假设工具状态只有两层：preset 的 overlay 与 `/tools` 维护的"基础层"。pi 1.4 引入了**第三个来源**：

1. **装载清单（tool loadout）**：某些工具变更以 system message 形式写进会话 transcript（`toolsAdded` / `toolsRemoved`），并在
   `AgentSession` **构造期**（`_restoreToolsFromTranscript`）与 `/tree` 导航时被**重新装载**——早于任何扩展的 `session_start`。
2. 因此 `tools.ts` 原来的"无持久状态就以 `pi.getActiveTools()` 反推禁用集"会把**pi 刚恢复出来的 preset 限制**固化成基础层。
3. 一旦固化，`clearOverlay()` 只撤 overlay，活动集永远回不到默认——用户报告的"切回 default 后仍是 Plan 模式、部分工具不可用"即此。

实测（真实 pi 1.4 进程，probe 打印 `before_agent_start` 的活动集）：会话记录里留着 plan 的 `["read"]`，
清除 preset 后 `clearOverlay()` 仍返回 `["read"]`；启动后继续受限。

另有一个叠加事实：pi 只在**下一次请求**时才把工具变更写进 transcript（`_prepareRun` → `_preparePromptAndToolLoadout`），
所以"清除后没发消息就退出"的会话，记录里留的是旧限制。

## 决策

### D1 三个来源与优先级

| 来源             | 是什么                                                                                                                       | 权威性                             |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| **默认工具选择** | pi 的 `defaultTools` 设置（`+name`/`-name` 修饰按 pi 语义）∪ 非内置工具（内建工具跟随 `defaultTools`，扩展工具按注册即启用） | **无 preset 状态的唯一回退目标**   |
| **装载清单**     | pi 记录在 transcript 并可恢复的工具声明                                                                                      | 运行时投影；**不是** preset 的判据 |
| **preset 约束**  | preset 激活期间施加的封闭集白名单                                                                                            | 激活期间生效；清除即撤回           |

`/tools` 的用户手改直接写 pi 的活动集（由 pi 记录），本扩展**不再持有**任何"基础层"快照。

### D2 删除私有基础层

- `disabledTools` / `tools-config` 会话 entry 一并移除；旧 entry 不再影响行为（历史会话表现为回到默认工具选择）。
- 有效活动集 = overlay ∩ 已注册工具；无 overlay 时 = pi 自身的活动集（不反推、不落任何长期状态）。

### D3 清除 / 切换 preset = 复位到默认工具选择

`clearOverlay()` 的目标就是 D1 的默认工具选择。**会话内的 `/tools` 手改不跨 preset 切换保留**
（可预测性优先于"记住临时偏好"；要长期生效请写 `defaultTools`）。

### D4 会话恢复的唯一判据是 preset 状态

`preset-state` entry 在**激活与清除时**都会落一条（`{name}` / `{name: null}`）；会话恢复与 `/tree` 导航时：

- 最后一条为 `name: null` → 曾激活后已清除 → **复位到默认工具选择**；
- 最后一条为具体名 → preset 仍激活 → 由 preset 重放白名单；
- **没有任何记录** → 本会话未涉及 preset → **不干预** pi。

"不干预"是刻意的：它保护 `--no-builtin-tools`、`--tools -bash` 这类启动修饰不被我们的复位反向撤销，
也保留 pi 原生"工具变更跨 resume 保留"的行为——只对**用过 preset 的会话**接管。

### D5 陈旧引用只查本地，交互式修复

preset 引用的工具 / 技能 / 模型 / provider 在**本地**不存在时（本地判定，不联网、不探测上游）：

- TUI 下弹面板，动作顺序固定为 **「修改并保存」→「移除」→「取消」**；「修改」逐项从本地候选挑正确值并写回所属层级
  （project / user 落 `config.json`，session 落会话文件）。
- 无陈旧项时零打扰。
- 非 TUI（print 模式）保留原有 toast 警告，不阻塞。
- **技能维度只在技能清单已知时判定**：pi 不向扩展暴露"本会话可用技能名"，技能清单只能在首次
  `before_agent_start` 的 `systemPromptOptions.skills` 里拿到。此前 `getSkillNames()` 为空，
  若据此判定就会把 preset 声明的技能全判成「本地不存在」，用户点「移除」即误删配置。
  故 `session_start`（含 `--preset` 启动）只判工具/模型维度，技能维度留到清单已知后再判。
- **`--preset` 启动时取消修复 = 不激活任何 preset**：工具轴按「无 preset」复位并落 `{name: null}`，
  避免 pi 从 transcript 恢复的旧限制留在无 preset 状态里。

## 明确不做

- 不做 `/preset doctor`、不做后台定时校验。
- **不**联网探测 provider 的模型列表，也**不**把"上游 4xx/unknown model"回写成 stale 标记：
  上游不可用属于 pi 的模型配置问题，preset 只保证与本地 `models.json`/registry 一致。
- 不做"记住每个会话的临时 /tools 偏好"。

## 已知限制

- **org 的自门控是「限制权只有两个来源」的已知例外**（2026-10-28，ADR-0070 `D11`）：
  `extensions/auto/org` 的 `/org off` 会用 `setActiveTools()` 把**自己注册的** org 工具移出活动集。
  它与本 ADR 禁止的「限制他人工具」不同型——只增删自己注册的工具，且 pi 没有 `unregisterTool`，
  **撤回工具的唯一手段就是 `setActiveTools()`**；`defaultActive: false` 帮不上（它只影响注册那一刻
  是否自动激活，而 org 本来只在在岗时才注册）。因此本轮**不改代码，登记为例外**。
  ⚠️「org × 封闭集 preset 叠加时是否真冲突」**尚未实测**——降级这条例外之前必须先做该实测
  （e2e 已有 `跨扩展防护（preset × org）` 一条，但只覆盖 preset 应用后 org 工具不丢，未覆盖
  off-duty 撤回与 preset 复位的先后顺序）。

- **`--tools` 的 `+name` / `-name` 修饰不参与复位**：pi 把这类修饰保存在 `AgentSession` 构造参数
  （`defaultToolModifiers`）里，扩展侧无读取入口；`tools.ts` 只能按 `getSettings().defaultTools`
  复算。`--exclude-tools` 与 `--tools` 白名单在注册期即被 pi 过滤（不在 `getAllTools()` 中），
  因此不会出现"复位把被排除工具放回来"的问题。要长期生效请写 `defaultTools`。
- **复位目标是"按声明重算"而非"pi 的注册期启用结果"**：`ToolInfo` 不含 `defaultActive`，
  故 `defaultActive: false` 的扩展工具（pi-lens 的 situational 工具、plannotator 等按需启用的工具）
  在复位时会被并入活动集。如果要精确复刻 pi 的注册期行为，需要引入会话级基线快照
  （本 ADR 明确拒绝的方案）；当前按 D1 的声明语义实现，属可接受的已知偏差。

- **`DEFAULT_TOOL_NAMES` 只能硬编码，无法 import**：pi 的该常量只在核心模块导出，
  包 `exports` 仅暴露 `.` 与 `./rpc-entry`。因此 `tools.ts` 的手写字面量与 pi 的默认集**只能靠护栏
  保持一致** —— 见 `test/vitest/extensions/preset-default-tools.test.ts`（从已安装 pi 的构建产物里
  读常量比对）。升级基座后若该测试变红，说明 pi 改了内置默认工具集，需同步 `tools.ts` 与本 ADR。

## 被否掉的替代方案

| 方案                                       | 否决理由                                                           |
| ------------------------------------------ | ------------------------------------------------------------------ |
| 保留基础层，但只修"反推"那一段             | 反推的歧义无法消除：pi 的装载清单与用户偏好不可区分，仍会固化      |
| 完全交给 pi（不介入）                      | 清除 preset 后无法复位；用户报告的 bug 正是这个方向                |
| 用 in-memory 快照记住"preset 激活前"的集合 | 引入第二份真相（与 D2 冲突）；resume 后快照丢失，行为不一致        |
| 会话恢复时无条件复位（不看 preset 记录）   | 会覆盖 `--no-builtin-tools` / `-name` 等启动修饰与 pi 原生恢复行为 |

## 后果

- **已知覆盖**：凡是"用过 preset"的会话，`/tools` 手改与 pi 原生的工具持久化都会被复位到默认工具选择吞掉。
  这是 D3/D4 的显式代价，用 `defaultTools` 可获得持久偏好。
- 工具变更仍在**下一次请求**时落入 transcript，因此"清除后立刻退出"的窗口由 D4 的启动复位兜住（不依赖记录）。
- 观测：每次应用都记 `tools applied {source, overlay, experimentInjected, effectiveCount, total, effective}`；
  不干预时记 `tools untouched {source, reason}`。

## 验证

- 语义级 e2e（`test/e2e/extensions/preset/`）：
    - 激活带 `tools` 的 preset → `/tools` 视图 == 白名单且显示锁定；
    - 清除 preset → 工具恢复无限制（`bash` 可用）；
    - **resume**：已清除 → 工具回到默认选择（含 `bash`）；仍激活 → 保持白名单。探针 `test/e2e/helpers/tools-probe.ts` 打印每次请求前的活动集。
- 单元/组件（`test/vitest/extensions/preset-overlay.test.ts`）：默认工具选择解析（含 `+/-` 修饰）、清除复位、
  会话恢复三分支（已清除 / 仍激活 / 未涉及）、陈旧引用三种动作与写回、**修改途中取消不留脏改**、
  **面板契约**（动作顺序 修改→移除→取消、候选标题显示当前值）、
  **技能维度只按已知技能清单判定**（`isLoaded()` 为 false 时不误报、不误删）。
- 工具轴 e2e（`test/e2e/extensions/tools/`）：旧的 `tools-config` / `disabledTools` 场景已随 D2 删除，
  改为断言"历史 `tools-config` entry 不再拦截工具"（确定性 PASS/FAIL，非 REVIEW）。
- **TUI 测试豁免（AGENTS「TUI 测试强制要求」例外）**：陈旧引用面板**没有新增 `render()` 代码**，
  渲染完全复用 `@zenone/pi-selector` 的 `showSelect`（该组件已有 TUI e2e 覆盖：
  `test/e2e/extensions/selector/`）。本插件侧新增的只是**调用契约**，由上面的 vitest 契约用例守住；
  因此不另加 headless snapshot。若将来自绘该面板，必须补 `renderToSnapshot` 用例。
- 门禁：禁止再次出现"从 `pi.getActiveTools()` 反推禁用集"的写法（见 ADR-0049 的 preset 强制条目）。
