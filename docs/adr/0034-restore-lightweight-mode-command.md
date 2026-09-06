# ADR-0034: 恢复轻量 `/mode`（会话级 model+thinking 切换）并让 instructions 纳入 prompt 组件偏离检测

- 状态：已接受（2026-09）
- 相关组件：`extensions/meta/preset`（`index.ts`、`prompt-editor.ts`）
- 修订：部分修正 ADR-0031

## 背景

ADR-0031 删除 mode-switcher、由 preset 承担唯一预设切换入口后，暴露出一个缺口：
「model + thinkingLevel 绑定的一键快速切换」没有轻量入口——单独切 model 有内置 `/model` 与
`Ctrl+P`，单独切 thinking 无内置入口，而「绑定切换」只能走 preset（配置型、落盘、三级来源）。
用户在会话中临时换一套 model+thinking 的成本过高。

调查发现 pi 底层已支持绑定：`ScopedModel = { model, thinkingLevel }`，`model-resolver` 的
pattern 语法就带 thinking 后缀（`provider/model:high`），`cycleModel` 切 model 时会连带
`setThinkingLevel`。但 `/scoped-models` 命令的 UI（`ScopedModelsSelectorComponent`）只暴露
「启用/禁用循环模型」，不暴露 thinkingLevel，故用户感知不到该能力。

同时，preset 的 `instructions` 通过 `before_agent_start` 直接追加到 `systemPrompt`
（`systemPrompt + '\n\n' + instructions`），不在 `systemPromptOptions` 内，prompt-editor 的
`discoverComponents` 扫不到它，`/prompt` 面板看不到、也覆盖不到 preset 的 instructions；
且 `detectDrift` 只检测 model/thinking/tools/skills 四类确定性状态，无 instructions 偏离。

## 决策

1. **恢复轻量 `/mode` 命令**：打开组合选择器（model 复用 pi 的 ModelSelectorComponent +
   thinking 选择），应用 = `pi.setModel()` + `pi.setThinkingLevel()`，随 pi 的会话状态走
   `/reload` 后仍在。切完即触发 `detectDrift` 的 model/thinking 维度 → widget 显示
   「已偏离 model/thinking」。
2. **明确不复刻 ADR-0031 已删除的 mode-switcher 独有功能**：`/mode store` 保存、color 边框色、
   不落盘的 overlay 临时模式、内置默认 mode（fast）、`alt+. n` 循环盲切。这些仍由 preset
   （具名预设）与 `/scoped-models`（循环池）承担。
3. **instructions 组件化 + 偏离检测**：preset 通过 `globalThis.__presetApi` 暴露
   `{ instructions }`；prompt-editor 的 `discoverComponents` 读它并生成
   `type: 'preset_instructions'` 组件；用户用 `/prompt` 覆盖该组件时回调 `__presetDriftRefresh`，
   preset 在 `detectDrift` 新增 `instructions` 维度 → widget 显示「已偏离 instructions」。
   不碰 pi-mono（`BeforeAgentStartEventResult` 无改 `systemPromptOptions` 的能力），
   preset 与 prompt-editor 本就同属 preset 目录，走 globalThis 桥接。

## 与 `/scoped-models` 的边界（避免未来混淆）

| 维度     | `/scoped-models`（内置）              | `/mode`（本决策）                      |
| -------- | ------------------------------------- | -------------------------------------- |
| 管什么   | Ctrl+P **循环池**（哪些模型参与轮换） | **当前会话**用哪个 model+thinking 组合 |
| thinking | UI 不暴露（底层支持）                 | 显式选择                               |
| 持久化   | session-only，`Ctrl+S` 写 settings    | 随 pi 的 model/thinking 会话状态       |
| 触发偏离 | 否                                    | 是（`已偏离 model/thinking`）          |

## 权衡

| 方案                                                      | 结论                                                                 |
| --------------------------------------------------------- | -------------------------------------------------------------------- |
| A. 完整复活 mode-switcher（含 store/color/overlay/cycle） | 拒绝：与 preset 定位重复，正是 ADR-0031 删除的原因                   |
| B. 只恢复轻量 `/mode`（model+thinking 会话级，本决策）    | 采纳：补上缺口，复用 pi 已有 setModel/setThinkingLevel，零新增持久化 |
| C. 靠 `/model` + 手动切 thinking 拼凑                     | 拒绝：thinking 无独立入口，无法一次绑定切换                          |

## 后果

- **正向**：model+thinking 一键切换恢复，且会话级（/reload 后仍在）并触发偏离提示；instructions
  成为 prompt 组件后，用户能可视化查看/覆盖它，偏离可感知。
- **负向**：`/mode` 与 preset 的 model/thinking 字段在「偏离提示」上语义重叠——用户切 `/mode`
  后 widget 会持续显示「已偏离 model/thinking」，需明确这只是「临时会话覆盖」，非错误状态；
  instructions 偏离判定依赖 prompt-editor 与 preset 的 globalThis 桥接，桥接缺失时静默降级。
