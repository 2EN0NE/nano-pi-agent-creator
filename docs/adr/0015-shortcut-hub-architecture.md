# 快捷键体系 — leader-key 前缀 + pi-shortcuts 中心

pi 新版扩张了 `ctrl+shift` 键域（`tui.altScreen.search`/`searchPrevious` 等），扩展快捷键与 pi 原生键持续冲突且会继续冲突。决定：扩展快捷键整体迁移到 **leader-key 前缀模式**——统一前缀键 `ctrl+shift+space`（`alt+.` 备用），由 meta 插件 **pi-shortcuts** 集中持有前缀键注册、子键注册表、分发（静默/面板两模式）与冲突裁决；消费方插件弱依赖（`globalThis.__shortcutsApi` 鸭子类型检测）注册子键，中心缺失/报错时回退到自身降级键。子键按「插件名首字母 + 功能键」两级分配，冲突先注册者胜 + 告警。

## 考虑过的选项

- **`alt+字母` 键域**：符合 AGENTS.md 旧约定、键域较空，但 macOS 终端 Option 默认发特殊字符而非 Meta（Kitty 协议终端可解，老终端需配置），跨平台不可靠。
- **`ctrl+shift+字母` 键域**：跨平台最可靠，但与 pi 原生键域正面对撞，是零和博弈，未来仍会冲突。
- **全配置化**（每个扩展快捷键走 flag/config）：默认无快捷键、体验打折，单独用不可取，仅作 leader 模式的兜底能力。
- **单段式 `ctrl+alt+字母` 键域**：少按一次键，但 26 键上限，且三修饰组合偏重，不如 leader 两段式的子键空间可扩展。

## 关键机制

- 前缀键仅占一个保留键，扩展子键在其专属子键域内自由分配，与 pi 原生键域彻底隔离。
- 子键监听复用 `ctx.ui.onTerminalInput`（session-tree-label 已实践 `alt+.` leader + g/b 子键 + 超时 + Esc 取消）。
- 快捷键单一事实来源 = pi-shortcuts 子键注册表；README 快捷键列与抽取脚本均由此生成。

## 自定义快捷键（remap）机制

「全配置化兜底」落地为 **remap 重映射**：用户可自定义前缀键与每个功能的子键。

**数据模型**：`RemapRule { name: string; from: string[]; to: string[] }`

- `from` = 消费方硬编码的**默认子键**（稳定标识，永远不变）
- `to` = 用户当前想要的键；`to === from` 时删除规则、恢复默认
- 持久化在 `ShortcutsConfig.remap: RemapRule[]`，走标准双层 config（user/project 可切换）

**动态 remap（存原始 entries + 生效时应用）**：

- 注册表内部存**原始 entries**（默认 keys），`getEntries()`/`match()` 动态应用 remap 返回生效 entries
- `setRemap(remap)` 运行时更新：校验冲突（只检查被 remap 命中的 entry 与其他 entry），冲突则回滚并返回冲突对象
- 改子键**立即生效**（无需重启）；改前缀键因 `registerShortcut` 启动时绑定，保存后**重启生效**

**编辑面板**：`/shortcuts` 命令直接打开可编辑面板（`ui/editor.ts`）——列表展示（前缀键 + 各 entry 生效 keys）→ ↑↓ 选中、`e` 改子键、`p` 改前缀键、`l` 切换 scope（user/project）、Esc 退出；改键为文本输入新键（空格分隔），Enter 确认（冲突校验，冲突则拒绝并提示）、Esc 取消。
