# ADR-0003: pi-lab 扩展注册机制设计

**状态**: 已接受  
**日期**: 2025-07  
**背景**: grilling session（追问 1-6）+ domain-modeling 输出

## 问题

pi-lab 实验框架需要支持其他 Pi 扩展以不同耦合方式接入实验系统，同时解决加载顺序竞险（load-order hazard）导致的注册失败问题。

## 决策

### 1. 双轨注册 API

pi-lab 提供两套注册入口，按耦合强度区分优先级：

| API                             | 调用方                                | 耦合强度    | 优先级 |
| ------------------------------- | ------------------------------------- | ----------- | ------ |
| `registerStrongExperiment(def)` | 直接 import `@zenone/pi-lab` 的插件   | 强依赖（B） | 高     |
| `registerWeakExperiment(def)`   | 通过 `globalThis.__labApi` 桥接的插件 | 弱依赖（A） | 低     |

两套 API 最终都写入同一个 `ExperimentManager` 的内部注册表，但带有 `source` 标记以便冲突裁决。

### 2. 冲突裁决规则

按优先级裁决，**高于优先级的总是赢**：

| 场景       | 已有注册 | 新来注册 | 结果                                          |
| ---------- | -------- | -------- | --------------------------------------------- |
| B 先，A 后 | 强（B）  | 弱（A）  | **阻断 A** — 静默丢弃 + 日志 + UI 通知        |
| A 先，B 后 | 弱（A）  | 强（B）  | **覆盖 A** — 强实验接管 + 日志 + UI 通知      |
| 同级冲突   | 强（B）  | 强（B）  | 后注册覆盖先注册（last-wins）+ 日志 + UI 通知 |
| 同级冲突   | 弱（A）  | 弱（A）  | 后注册覆盖先注册（last-wins）+ 日志 + UI 通知 |

冲突通知：

- **pi-logger**: 始终记录 `warn` 级别日志，包含冲突双方信息（插件名、实验名、注册方式、优先级）
- **UI 通知**: 仅在 `session_start` 等有 `ctx` 的上下文中通过 `ctx.ui.notify()` 推送；如果在工厂函数中注册（无 ctx），缓存警告到 `session_start` 时批量冲刷

### 3. 注册时机：统一在 `session_start`

无论使用哪种注册 API，消费方**必须在 `session_start` 事件处理器中调用注册**，而不是在模块工厂函数中。

原因：

- 确保所有扩展已加载完毕，`globalThis.__labApi` 已就绪（方案 A 的场景）
- 确保 `ctx` 可用，能推送 UI 通知（冲突场景）
- 消除加载顺序竞险

```typescript
// ✅ 正确：在 session_start 中注册
pi.on('session_start', async (_event, ctx) => {
  const mgr = (globalThis as any).__labApi?.getExperimentManager?.();
  if (mgr) {
    mgr.registerWeakExperiment({
      name: 'edit-strategy',
      arms: [...],
      strategy: 'thompson-sampling',
    });
  } else {
    log.warn('pi-lab not available — running without experiment');
  }
});

// ❌ 错误：在模块工厂中同步检查
const mgr = (globalThis as any).__labApi?.getExperimentManager?.(); // 可能为 undefined
```

### 4. pi-lab 不可用的降级策略

pi-lab **不阻塞**消费方的启动。消费方自己负责降级行为：

| 反馈级别 | 行为                                          | 适用场景             |
| -------- | --------------------------------------------- | -------------------- |
| `silent` | 静默降级，无任何提示                          | 有完善兜底方案的插件 |
| `warn`   | pi-logger 日志 + 如有 UI 则 `ctx.ui.notify()` | 有降级但希望用户知情 |
| `block`  | 不允许使用                                    | 未来预留，当前不实现 |

pi-lab 本身不应决定消费方的降级策略——它只负责提供实验能力。消费方根据自身特性（是否有兜底方案、功能是否核心）自行选择反馈级别。

### 5. 方案 C（配置加载顺序）已排除

Pi 的扩展加载器（`loader.js`）不支持显式加载顺序配置。无 `priority`、`dependsOn`、`loadBefore`/`loadAfter` 机制。`fs.readdirSync` 返回顺序在 macOS APFS 上不可靠。因此方案 C 不可行。

## 理由

- **双轨 API** 比 options 参数更语义化，消费方一眼知道自己属于哪条路径
- **优先级裁决** 给强依赖插件确定性保证（不会被弱依赖插件意外覆盖）
- **统一 session_start 时机** 消除了加载顺序竞险，是三种候选时机中最平衡的选择
- **不阻塞消费方** 符合 Unix 哲学——每个插件独立负责自己的降级策略

## 其他方案考虑

- 方案 C（配置加载顺序）：不可行，Pi 框架不支持
- 单一 API + options 参数：被否决，语义不如双 API 清晰
- 纯模块工厂注册（现状）：被否决，加载顺序竞险无法消除

## 影响

- pi-lab 需要新增 `registerStrongExperiment()` 和 `registerWeakExperiment()` 两个公共 API
- `ExperimentManager.registerExperiment()` 内部增加优先级比较逻辑
- 所有现有和未来的消费方需将注册逻辑迁移到 `session_start` 中
- 需要向消费方插件开发者明确文档说明（AGENTS.md + pi-lab README.md）
