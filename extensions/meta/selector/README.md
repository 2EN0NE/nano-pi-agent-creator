# pi-selector 共享选择器

为 pi 扩展提供统一的选择 / 确认对话框（`showSelect` / `showConfirm` / `showConfirmDestructive`），
支持键盘导航、`Tab` 补充信息、外部取消信号，并向 `pi-tmux-status` 通告对话框开关状态。

本包同时是 **远端豁免模式**（ADR-0068）的承载方：`--unattended-confirm` flag、`globalThis.__confirmGateApi`、
状态栏三态与「跳过」日志都落在这里。

## 基本用法

```typescript
import { showSelect, showConfirm } from '@zenone/pi-selector';

const r = await showSelect(ctx, '选择颜色', [
	{ value: 'r', label: '红色' },
	{ value: 'g', label: '绿色' },
]);
// r = { value:'r', label:'红色' } 或 null（Esc / 取消）

const ok = await showConfirm(ctx, '确认删除?', '此操作不可撤销');
```

`showSelect` 返回 `null` 表示**取消**（用户按 Esc、外部 `signal` abort、或无 UI）。

## 远端豁免模式下的行为

模式生效（armed）时**不弹任何对话框**，返回值由调用方声明的默认值决定：

| 调用方是否声明 `unattendedDefault` | 行为                                                                        | 日志                                          |
| ---------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------- |
| 声明了                             | 立即返回由该值组装的结果（等同用户选它）                                    | `skip-with-default title=<标题> default=<值>` |
| 未声明                             | 等同**取消**（`showSelect` → `null`，`showConfirm` → `false`）。fail-closed | `skip-no-default title=<标题>`                |

```typescript
// 示例：无人应答时视为「继续」
await showSelect(ctx, '仓库有未提交文件，仍要继续吗？', options, {
	unattendedDefault: 'proceed',
});

// 示例：无人应答时视为「确认」
await showConfirm(ctx, 'Clear session?', message, 'danger', {
	unattendedDefault: true,
});
```

### 调用方检查清单

1. 这个确认**允不允许**在无人在场时自动放行？允许 → 声明 `unattendedDefault`；不允许 → 不要声明。
2. 默认值必须是**该对话框里真实存在的选项值**（`showSelect`）或布尔（`showConfirm`）。
3. `allowOther` 的补充输入在 armed 下不会被触发（没有弹框就没有补充文本）。

## 模式的三态与接口

| 状态            | 含义                                                               |
| --------------- | ------------------------------------------------------------------ |
| `off`           | 启动未带 `--unattended-confirm`，与普通 pi 完全一致                |
| `licensed-idle` | 有许可，但没有通道占用 → **行为与普通 pi 一致**（许可只是授权）    |
| `armed`         | 通道 `arm()` 占用 → 上面的跳过规则生效；状态栏显示 `\| unattended` |

`globalThis.__confirmGateApi`（弱桥接，供其它仓库的通道插件调用）：

```typescript
interface ConfirmGateApi {
	hasLicense(): boolean;
	isArmed(): boolean;
	owners(): string[];
	arm(owner: string): (() => void) | undefined; // 无许可 → undefined（fail-soft）
	status(): {
		license: boolean;
		armed: boolean;
		owners: string[];
		mode: 'off' | 'licensed-idle' | 'armed';
	};
}
```

通道侧用法（如微信桥）：连接就绪 `arm('wechat')`、断开 `disarm()`；**执行 `/new` 这类动作前先查
`isArmed()`**，未生效就回执说明，不要让用户等挂起。

> 桥接在**扩展工厂期**就安装（不依赖 `session_start` 的 handler 顺序）：通道插件的 `session_start` 可能
> 早于 selector 的（handler 按加载顺序执行、pi 不排序），若等 `session_start` 才装，通道会读到 `undefined`
> 并按「接口不存在 → 不 arm」静默放弃。

**`arm()` 是引用计数，按 owner 分别计**：同一通道重复 `arm('wechat')`（重连而旧连接未及 `disarm()`）
各自持有凭据，`arm()` 返回的解除函数只释放自己那一次（可重复调用，幂等）；因此不会因为先断开的连接
一次 `disarm()` 就把仍在连接中的通道打回「弹框等应答」。`disarm(owner)` 释放一次；`/unattended disarm`
直接清空**所有** owner（含通道），是通道崩溃后人工恢复确认的唯一入口。

## 对话框状态通告（既有接口）

- `globalThis.__piOnDialogChange(isOpen: boolean)`——对话框开 / 关时回调，供 `pi-tmux-status` 变红。
  注意：armed 跳过时**不会**触发（没有对话框）。
- `isSelecting()`——当前是否有选择框在显示（只读）。
- `globalThis.__piTmuxDialogState`——与上者同步的状态对象。

## 相关文档

- [ADR-0068 远端模式的确认豁免](../../../docs/adr/0068-remote-mode-confirm-exemption-cwd-scoped.md)
- [`permission-gate/README.md`](../../security/permission-gate/README.md)「远端豁免模式」节

## 远端模式下的 B 类命令（不建议加入远端白名单）

D5 的闸门只能拦 `showSelect` / `showConfirm`。而这些命令的对话框**多数直调** `ctx.ui.custom` /
`ctx.ui.input` / `ctx.ui.editor` / `ctx.ui.confirm`——armed 下闸门覆盖不到，于是**照旧弹框并永久挂起**
（无人应答），不是「静默不执行」：

`/worktree`、`/review`、`/ci-watch`、`/rewind`、`/rate-limit`、`/loop`、`/commands`、
`/custom-compaction`（设置面板）、`/preset`（`/tools`·`/skills`·`/commands` 面板与 `prompt-editor`）

> 个别命令里**走 selector 的子流程**（如 `/preset` 的预设切换确认、`/custom-compaction` 的 profile 选择）
> 确实会被闸门按「未声明默认 → 取消」处理并记 `skip-no-default`；但同一条命令的其它入口仍会挂起，
> **不要**据此把命令加进白名单。
>
> 结论：远端通道的命令白名单只应放**非交互型**命令（`/new`、`/stop`、`/status` 这类）。
