# ADR-0017: custom-compaction 分层写入与压缩实验接入

**状态**: 已接受
**日期**: 2026-08
**背景**: grilling-with-docs session 输出（UI 重构 + pi-lab 压缩实验 + 跨扩展打标提醒）

## 问题

1. **配置层污染（P0）**：custom-compaction 的写操作（`upsertProfile`/`setActiveProfile`/`deleteProfile`）用 `store.get()` 的**合并全量快照**覆盖写入 `user` 层文件，导致项目级/会话级配置被固化为用户级快照、跨项目泄漏（「项目级阈值被改」根因）。

2. **压缩效果无法客观量化**：压缩摘要是 LLM 生成的、无 ground truth。edit 插件的 `match_success` 式确定性信号不存在，需要设计**用户行为信号**（回退/重压/打标）作为满意度代理。

3. **并行实验归因**：用户要并行对比机制/prompt/阈值三个维度，一次压缩同时属于三个实验，反馈信号需正确归因到各实验的臂。

4. **自动打标不可见**：pi-session-tree 的 tag-engine 支持正则自动打标，但命中时无任何 UI 反馈，用户不知道标签被自动打了。

## 决策

### 1. 配置分层最小写入

`config.ts` 引入层作用域写操作：`readLayerRaw(scope)` 读目标层原始文件（不合并），`writeLayer(scope, raw)` 写回并刷新缓存。`upsertProfile(profile, scope)` / `setActiveProfile(id, scope)` 只更新目标层的差异字段；`deleteProfile(id)` 从**所有层**删除。默认 scope 为 `getActiveScope()`（session > project > user，default 映射 user）。

- **理由**：绝不把合并快照写回单层文件——「写操作基于目标层原始文件做最小更新」。
- `saveConfig` 保留为底层能力（全量写），业务路径不再使用。

### 2. 压缩实验（3 并行维度，select/record 直报）

`lab.ts` 弱依赖接入（方案 A：`globalThis.__labApi` 桥接，pi-lab 缺失时降级）。三个独立实验（臂集不同，不可混入同一实验）：

| 实验               | 臂                        | 生效点                               | 注册前提                                                             |
| ------------------ | ------------------------- | ------------------------------------ | -------------------------------------------------------------------- |
| mechanism-strategy | summarize / smart-compact | compactor 执行时 `applyLabOverrides` | smart_compact adapter 声明 `handlesCompaction: true`（真实拦截压缩） |
| prompt-strategy    | structured / narrative    | 同上                                 | 无                                                                   |
| threshold-strategy | 60 / 70 / 80              | agent_end 触发判断                   | 无                                                                   |

**机制实验注册前提**：smart_compact adapter 当前是 collaboration 模式（`beforeCompact` 恒返回 false = pass-through），机制臂会落到与 summarize 相同的摘要路径，无对比度。因此 `initExperiments` 检查 `getAdapter('smart_compact')?.handlesCompaction === true` 才注册 mechanism-strategy 实验；未满足时跳过该实验（prompt/threshold 不受影响），避免收集噪声数据。

**归因机制**：每次压缩对各实验独立 `select()` 选臂，存「最近压缩记录」（`RecentCompactRecord`：leafBefore/leafAfter/source/arms）；反馈信号对记录中各臂分别 `record()`。并行归因的固有代价（用户不满源于哪个维度不可分）已向用户明示并接受。

**实验覆盖不写回持久化配置**——`applyLabOverrides` 克隆 profile 应用臂（stable-hash 保证同模型稳定同臂，体验一致）。**未激活实验的维度不覆盖**：`LabArmSelection.mechanism/prompt` 在对应实验未注册时为 `null`，`applyLabOverrides` 保留 profile 原配置（防止自定义 prompt / pass_through 机制被静默覆盖）。

### 3. 用户行为信号（满意度代理）

| 信号       | 定义                                       | 触发点                                                                         |
| ---------- | ------------------------------------------ | ------------------------------------------------------------------------------ |
| 回退（主） | 当前 leaf 位置回到压缩前 leaf 之前         | agent_end 每轮 `detectRollback`，一次压缩只报一次（`_rollbackReported` latch） |
| 重压（辅） | 自动压缩后 30min 内手动 `/custom-compact`  | triggerHandler `reportRecompact`                                               |
| 打标（辅） | 用户打 GOOD/BAD 标签                       | 复用 pi-session-tree 打标（本次不做，入口已存在）                              |
| 过程指标   | latency_ms / saved_tokens / summary_length | compactor 生成摘要后 `setCompactResult` → onComplete `reportProcessMetrics`    |

### 4. 自动打标 UI 提醒

pi-session-tree `turn_end` 增量打标循环：新命中标签时 `ctx.ui.setStatus('pi-session-tree-tag', '|打标:<label>')` + `log.info`。全量重扫（规则变更/启动）不提醒（避免刷屏）。tag-engine 本身已支持 `on:user_message` + `contentPattern` 正则规则，本次只补可见性。

### 5. settings panel answer 范式重构

主面板改为自定义边框组件（`settings-ui.ts`，answer 同款 boxLine/padToWidth/truncateToWidth），字段编辑保留原生对话框（`ctx.ui.input/select/editor/confirm`）。全量中文化（`types.ts` 标签、面板文案、状态栏）。实验状态（当前臂/样本量）显示于主面板。组件遵守 TUI 铁律：第 0 行固定文案、总高固定不滚动、每行 truncateToWidth。

## 后果

- 分层写入后，settings panel 编辑「当前活跃层」与面板显示一致；项目级配置不再泄漏到用户级。
- 实验覆盖与 profile 配置解耦：实验激活时 profile 的 mechanism/prompt/threshold 被临时覆盖，关闭实验（pi-lab 移除）即回到配置原样。
- 回退检测依赖 `sessionManager.getLeafId()`/`getEntries()`（已确认可用）；pass_through 机制下无摘要 → 无过程指标，但回退/重压信号仍生效。
- 并行实验的维度混淆代价已接受（用户知情）。
