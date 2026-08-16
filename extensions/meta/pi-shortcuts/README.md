# @zenone/pi-shortcuts — 快捷键中心

leader-key 前缀模式：扩展快捷键不再各自占用 `ctrl+shift+[字母]`（与 pi 原生键域冲突），而是统一挂在前缀键 `alt+.` 之下，按「子键」触发。子键在扩展专属子键域内分配，与 pi 原生键域彻底隔离。

设计见 [`docs/adr/0015-shortcut-hub-architecture.md`](../../../../docs/adr/0015-shortcut-hub-architecture.md)。

## 触发方式

- `alt+.` + 子键（默认前缀键，可配置；备用键 `ctrl+shift+space` 始终注册）
- 前缀键按下后弹出**快捷面板**（列出所有快捷键 + 说明，超出屏幕时 Tab/Shift+Tab 翻页），或**静默等待子键**（由配置 `paletteOnPrefix` 决定）
- `/shortcuts` 命令列出所有已注册快捷键

## 终端兼容性（mac 终端 Option 键）

`alt+.` 依赖终端的 Option/Alt 键能产生 `ESC` 前缀序列（传统 Meta 协议）。
若终端把 Option 设为「Normal」，`alt+.` 会直接输出特殊字符（如 `≥`），
pi 无法识别为组合键，面板弹不出来。各终端需如下设置：

| 终端             | 设置项                                                           |
| ---------------- | ---------------------------------------------------------------- |
| iTerm2           | Preferences → Profiles → Keys → Left/Right ⌥ Option Key → `Esc+` |
| Ghostty          | 配置 `macos-option-as-alt = false`（Option 作为 Esc/Meta）       |
| Windows Terminal | 默认即可（Alt 键按 VT 序列发送 ESC 前缀）                        |

> 备用键 `ctrl+shift+space` 在部分 mac 终端会被截获，故默认改用 `alt+.`。

## 消费方接入（弱依赖 + 降级回退）

```ts
const hub = (globalThis as any).__shortcutsApi;
if (hub?.register) {
	// 中心可用：注册子键（单功能 ['f']，多功能 ['f','o']）
	hub.register({ name: 'files', keys: ['f', 'o'], description: '打开文件浏览器', handler });
} else {
	// 中心缺失：回退到自身降级键
	pi.registerShortcut('ctrl+shift+o', { description: '打开文件浏览器', handler });
}
```

> 注册须在 `session_start` 事件中做（消除加载顺序竞险，确保 `__shortcutsApi` 就绪），与 pi-lab 的弱依赖约定一致。

## 子键分配规则

- 子键默认取**插件名首字母**；单功能插件一级直达（`f`），多功能插件两级（`f` + 功能键 `o`/`r`）。
- 冲突（完全同子键、或互为前缀）由中心裁决：**先注册者胜，后者告警**。

## 配置

双层路径（项目级覆盖用户级覆盖默认值）：`pi-config` 管理。

```jsonc
{
	"prefixKey": "alt+.", // 前缀键；空字符串禁用快捷键（备用键 ctrl+shift+space 始终注册）
	"paletteOnPrefix": true, // true = 弹面板；false = 静默等待子键
}
```

## 命令

| 命令         | 说明                     |
| ------------ | ------------------------ |
| `/shortcuts` | 列出所有已注册扩展快捷键 |

## 模块结构

```
api.ts            # 公共 API（类型 + 工厂）
config.ts         # 配置加载（pi-config 双层）
index.ts          # 扩展入口：桥接 + 前缀键 + 分发接线
core/registry.ts  # 子键注册表 + 冲突裁决 + match
core/dispatcher.ts# 子键分发状态机（静默模式）
ui/palette.ts     # 快捷面板（TUI）
```
