### 12. pi-lab 实验框架：消费方接入规范

pi-lab（`extensions/meta/pi-lab/`）是实验框架，不自带实验。消费方插件通过它注册 A/B 实验、选臂、录反馈。

**接入方式（两种，按耦合强度分）：**

| 方式                 | API                                                                      | 耦合                     | 适用场景                                         |
| -------------------- | ------------------------------------------------------------------------ | ------------------------ | ------------------------------------------------ |
| **弱依赖（方案 A）** | `registerWeakExperiment()` 通过 `globalThis.__labApi` 桥接               | 不 import 包             | 插件只想"顺便做实验"，pi-lab 不存在时自然降级    |
| **强依赖（方案 B）** | `registerStrongExperiment()` 通过 `import { ... } from '@zenone/pi-lab'` | 在 package.json 声明依赖 | 插件的核心逻辑就是实验驱动的，明确和 pi-lab 绑定 |

**两条铁律：**

1. **注册必须在 `session_start` 事件中做**，绝不在模块工厂函数中做。这是为了消除加载顺序竞险，确保 `globalThis.__labApi` 已就绪、`ctx` 可用（冲突时可推 UI 通知）。
2. **消费方必须自己处理降级**——pi-lab 不阻塞插件的启动。如果 lab 不可用，消费方要自行提供兜底方案。

```typescript
// ✅ 正确：方案 A（弱依赖）— 在 session_start 中注册
pi.on('session_start', async (_event, ctx) => {
  const lab = (globalThis as any).__labApi?.getExperimentManager?.();
  if (!lab) { log.warn('pi-lab not available — no experiment'); return; }
  const exp = lab.registerWeakExperiment({ name: 'foo', arms: [...], strategy: 'thompson-sampling' });
  ctx.ui.notify('Experiment foo active', 'info');
});

// ✅ 正确：方案 B（强依赖）— 在 session_start 中注册
import { getExperimentManager } from '@zenone/pi-lab';

export default function (pi: ExtensionAPI) {
  pi.on('session_start', async (_event, ctx) => {
    const mgr = getExperimentManager();
    const exp = mgr.registerStrongExperiment({ name: 'foo', arms: [...], strategy: 'thompson-sampling' });
    ctx.ui.notify('Experiment foo active', 'info');
  });
}
```

**冲突裁决**：同名实验冲突时，强依赖者（B）始终优先于弱依赖者（A）。同一级别内后注册覆盖先注册（last-wins）。冲突时框架自动打 pi-logger 日志 + `ctx.ui.notify()` 推送通知。

> 详细设计见 `docs/adr/0003-pi-lab-extension-registration-mechanism.md`。

---
