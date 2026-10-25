# ADR-0066: 技能轴的运行时裁剪走 `systemPromptOptions`，不再做提示词字符串手术

- 状态：**已接受**（2026-10-25）
- 相关组件：`extensions/meta/preset/skills.ts`（`/skills` 与 preset 的 skills overlay）、`extensions/meta/preset/prompt-editor.ts`（相邻的 force 路径）
- 术语：见 `CONTEXT.md`「preset 预设」节

## 背景

preset 的 skills 轴需要"只让模型看到白名单里的技能"。旧实现（pi 早期版本没有运行时接口时的妥协）是：

1. 用 `formatSkillsForPrompt(all)` / `(visible)` 各拼一份 `<available_skills>` XML；
2. `event.systemPrompt.replace(fullXml, filteredXml)`，失败再退化成正则替换整块；
3. `return { systemPrompt: newPrompt }`。

两个问题：

- **脆**：依赖 pi 渲染出的 XML 措辞与技能顺序（注释里自己写了 "exact string match can fail when the arrays are sorted differently"）；pi 改一次格式就静默失效。
- **贵**：`return { systemPrompt }` 在 pi 内部等价于 `forceSystemPrompt`——整段系统提示词被钉死成"强制头"，**失去 section diff 语义**（每轮整块替换，不产生"skills 段更新"的增量声明，也不利于 prompt cache）。

## 决策

pi 提供了更正的做法，**直接裁剪可变选项，让 pi 自己渲染**：

```ts
pi.on('before_agent_start', (event) => {
	event.systemPromptOptions.skills = event.systemPromptOptions.skills.filter((s) =>
		isEnabled(s.name),
	);
});
```

依据（`dist/core/extensions/runner.js` `emitBeforeAgentStart`）：

- `event.systemPrompt` 是 **getter**：`get systemPrompt() { return renderCurrentSystemPrompt(); }`，每次读取都从同一个 `currentOptions` 重新 `buildSystemPrompt`；
- `event.systemPromptOptions` 是**可变**对象，类型注释明写 "Mutable prompt sections. Later handlers observe mutations made by earlier handlers."；
- `normalizeBuildSystemPromptOptions` 返回普通对象，`skills` 是浅拷贝数组——就地写安全（不会污染 `_baseSystemPromptOptions`，清除 preset 后自然回到全量）；
- 渲染出的 section 变化会走 `diffSystemPromptSections`，以"Updated system prompt section skills"补丁下发。

> 版本口径：该契约在仓库锁定的基座 **1.3.0** 上即已具备（`emitBeforeAgentStart` 与 1.4.0 逐字相同，2026-10 已 diff 核对）。此前文档写的 "pi ≥1.4" 是错的，不要据此升版本。

因此：

- **删掉** `formatSkillsForPrompt` 的 XML 拼接与正则替换（主路径）；
- **不再** `return { systemPrompt }`（该返回值只保留给真正需要整段重写的场景，如 prompt-editor 的组件化编辑）；
- 非 prompt 侧的控制保持原样：`tool_call` 拦截被禁技能的 `SKILL.md` 读取、`input` 拦截 `/skill:<name>` 手动调用（pi 的技能命令展开不做 enabled 检查）。

### 跨扩展契约：`systemPromptOptions.skills` 在裁剪后 = 可见集

就地裁剪改变了这个**共享可变对象**字段的语义：对本 handler 之后的 handler，`options.skills` 是「可见技能」而非「已加载全量」。当前消费者与处理方式：

| 消费者                                                              | 用法                          | 处理                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extensions/meta/preset/prompt-editor.ts`                           | 从 `options` 发现 prompt 组件 | 依赖顺序（见下），已满足                                                                                                                                                                                                                     |
| `extensions/context/resources-tree/index.ts`（`fsSkillCount` 分母） | 当作「Pi 已加载全量」         | 改用 `pi.getCommands()`（`source === "skill"`，直读 resourceLoader 完整清单，不经 handler 变更），否则分母会变成可见集（如 `0/0`）。**注意 `ctx.getSystemPromptOptions()` 只在命令 ctx 上，事件 ctx 上为 `undefined`**（实测定论），故不可用 |
| `test/e2e/helpers/llm-surface-dump.ts`                              | 当作「LLM 可见面」            | 语义与"可见"一致；但取值时机取决于 handler 顺序，仅在无 preset 的技能轴断言中使用                                                                                                                                                            |

### 与 force 路径共存（顺序无关）

有 4 个扩展会 `return { systemPrompt: event.systemPrompt + … }`（`context/goal.ts`、`context/claude-rules.ts`、`security/secret-firewall`、`auto/org`），
runner 收到后写入 `currentOptions.forceSystemPrompt`，而 pi 在发请求前会用 `_installAgentForcedPromptProjection`
**整段覆盖 sections**。于是：

- force 发生在 skills **之后** → force 文本由 getter 渲染，已含裁剪结果，正确；
- force 发生在 skills **之前** → force 里是未过滤快照，`options.skills` 的裁剪**进不了本次请求**（旧实现靠字符串替换仍能生效，属纯回归）。
- 扩展加载顺序由 `readdirSync` 决定且 **pi 不排序**，故不能假设先后。

因此 skills.ts 保留了一条**收敛的兜底**（不是主路径）：裁剪 options 后读一次 `event.systemPrompt`，若其中仍广告着被禁技能，
就地对文本做 `<skills>` section 的条目级裁剪（只删除条目，不重建格式）：

- `forceSystemPrompt !== undefined` → 改写它；
- 否则（基座 `systemPrompt` 是静态快照，不回渲染 options）→ `return { systemPrompt: pruned }`（旧契约）；
- 都做不到（文本里没有 `<skills>` section）→ `log.warn`，不再静默。

日志带 `path: 'options' | 'force' | 'snapshot'`，可直接判断本次走的是哪条路。

### 与 prompt-editor 的 force 路径

`prompt-editor.ts` 仍会 `return { systemPrompt: rebuildPrompt(components) }`（instructions 组件化编辑需要整段重写）。它从 `event.systemPromptOptions` 构建组件，
所以在 `index.ts` 里 **skills 应注册在 promptEditor 之前**（现状：`tools → skills → commands → promptEditor → model`）——
顺序反了会丢掉 section diff 与缓存收益（正确性由上面的 force 兜底保住）。

## 被否掉的替代方案

| 方案                                                     | 否决理由                                                                      |
| -------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 继续用 `formatSkillsForPrompt` + 字符串替换              | 依赖渲染格式与顺序，pi 改格式即静默失效；且无法区分"技能块未变化"与"替换失败" |
| 用 `return { systemPrompt }` 做裁剪                      | 等价 forceSystemPrompt，失去 section diff，prompt cache 失效                  |
| 靠 frontmatter `disable-model-invocation: true` 静态隐藏 | 只能静态、逐技能，无法表达 preset 白名单与 `/skills` 运行时开关               |
| `-ns` / `--no-skills`                                    | 进程级全关，粒度不够                                                          |

## 后果

- 技能可见性由 pi 自己渲染，<available_skills> 的措辞/排序变化不再影响正确性（主路径）。
- 每次 `before_agent_start` 都会重算可见集（含 `/skills` 开关与 preset overlay），无需显式失效缓存。
- 日志：裁剪发生时记 `Skills: prompt skills filtered (path=...)`，`path` 说明走的是 options / force / snapshot 哪条路。
  **`path` 必须写在 message 里**——pi-logger 的文件 appender 只落 message、不落 details 字段，塞进字段等于日志里看不见。

## 验证

- `test/vitest/extensions/preset-overlay.test.ts`（skills 段）：
    - `skills: []` → `systemPromptOptions.skills` 为空，且**没有**任何 handler 返回 `systemPrompt`（守住不走 force）；
    - `skills: [a]` → `options.skills` 只剩白名单；
    - **force 兜底**：`forceSystemPrompt` 里是未过滤快照时，就地裁剪后只剩白名单条目，且不再额外返回 `systemPrompt`；
    - **快照兜底**：基座 `systemPrompt` 为静态字符串时，返回裁剪后的提示词；
    - 以上均同时断言 `/skill:<name>` 的拦截/放行。
- `test/vitest/extensions/skills.test.ts`：`/skill:` 拦截切面 + 初始化时机。
- **渲染层 e2e**（唯一能证明 "options → pi 渲染" 的层）：`test/e2e/extensions/preset/smoke.test.sh`
  「skills：白名单裁剪真正落到 system prompt（渲染层）」——沙箱放 `alpha` / `beta` 两个技能，preset 只留 `alpha`，
  用 `MOCK_LLM_RECORD_SKILLS=1` 让 mock provider 导出 `[mock-llm-skills]`（请求里的 `<available_skills>` 名字），
  断言 `alpha` 在、`beta` 不在。
- 全量：`CI=true bash test/e2e/scripts/run-e2e.sh --ext preset`。
