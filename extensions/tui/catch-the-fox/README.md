# 🦊 catch-the-fox

PI 扩展，在编辑器上方显示一只**像素动画狐狸**（半块真彩色）。狐狸会根据代理正在执行的操作变换姿态——嗅探、挖掘、奔跑、跳跃、庆祝，或在你等待时睡觉。在执行过程中，它会横穿终端，在边缘滑行，转身再跑回来。

32 帧画面共用同一个人物模型、固定的 24×20 像素网格以及紧凑的调色板：深紫轮廓、橙色皮毛、白色口鼻和胸部、蓝灰色阴影，每个状态有少量特效色。

> 需要支持 **真彩色** 的终端（Warp ✓、iTerm2 ✓、kitty ✓、ghostty ✓）。

## 状态

| 状态 | 触发时机 | 画面 |
|------|---------|------|
| `sleep` | 空闲（对话结束） | 狐狸睡觉，灰色 `zzz` |
| `sniff` | `read`、`grep`、`find`、`search`、`list` | 狐狸嗅探，灰色轨迹 |
| `dig` | `edit`、`write`、`patch`、`replace` | 狐狸背身挖掘，泥土飞溅 |
| `run` | `bash`、`shell`、`fetch`、`web`、`curl` | 狐狸在两端之间奔跑，滑行后反向跑回 |
| `jump` | 对话结束（成功） | 狐狸跳跃，黄色闪光 |
| `caught` | 跳跃之后 | 狐狸正面庆祝，闪光，1.6 秒后 → `sleep` |
| `error` | 工具返回错误 | 红色闪烁，1.2 秒 |
| `sad` | 连续 3+ 错误 | 耳朵耷拉，蓝色眼泪 |

动画通过 `setInterval` 按每个状态自己的帧间隔逐帧播放（从 `run` 的 130ms 到 `sleep` 的 700ms）。widget 工厂函数通过 `ctx.ui.setWidget` 注册一次，每个 tick 调用 `tui.requestRender()` 请求重新渲染。在 `run` 状态下，`render(width)` 利用终端的实际宽度计算运动轨迹。狐狸在最后几步减速、扬起尘土、在边缘处停下、镜像精灵并继续奔跑。终端尺寸变化以及窄于 24 像素的宽度都会得到限制，不会导致换行问题。

## 工作原理

通过生命周期钩子驱动持久化 widget（`ctx.ui.setWidget`，ANSI 行数组）：

- `session_start` → `sleep`
- `agent_start` → `sniff`（重置错误计数）
- `tool_execution_start` → 根据 `event.toolName` 推导状态
- `tool_result` → 根据 `event.isError` 递增 `errorStreak`（`error`，3 次以上变为 `sad`）
- `agent_end` → `jump` → `caught` → `sleep`（若错误过多则为 `sad`）
- `session_shutdown` → 清理定时器

每个精灵是一个像素网格（`grids`），用 `PALETTE` 中的字母代表颜色。渲染器 `gridToAnsi` 将 2 行像素合并为 1 行文本，使用半块字符（`▀` 前景色 = 上方像素，背景色 = 下方像素），使垂直分辨率翻倍。美术资源在 `src/fox-art.ts` 中，由扩展和预览共享，确保画面一致。

## 命令

- `/fox` — 列出所有状态
- `/fox <状态>` — 强制切换状态（`sleep`、`sniff`、`dig`、`run`、`jump`、`caught`、`error`、`sad`）
- `/fox hide` — 隐藏狐狸
- `/fox show` — 重新显示狐狸
- `pi --fox-reduced-motion` — 保持状态变化，但使用静态帧，不播放连续动画

## 预览

在终端中遍历所有状态：

```bash
pnpm preview
```

让单个状态持续动画到按下 `Ctrl+C`：

```bash
pnpm preview -- --state run
```

`run` 的预览使用终端当前宽度，展示完整的含滑行和返回的运动轨迹。

生成包含所有帧并排显示的 `fox-preview.png`：

```bash
pnpm preview:sheet
```

两个命令都会在渲染前先编译扩展，因此结果始终与 PI 实际运行的精灵一致。

## 开发

```bash
pnpm install
pnpm build   # tsc → dist/
pnpm dev     # tsc --watch
pnpm test    # 轨迹、尺寸调整、方向和 ANSI 集成测试
```
