# ADR-0031: preset 吸收 mode-switcher 的预设切换职责

- 状态：已接受（2026-09）
- 相关组件：`extensions/meta/preset.ts`、已删除的 `extensions/meta/mode-switcher.ts`

## 背景

mode-switcher 与 preset 是功能重叠的两个「模型预设切换」插件。mode-switcher 提供 `/mode`
命令、`alt+. m/n` 快捷键（选择面板 + 循环切换）、`/mode store` 保存、color/overlay 概念；
preset 提供 `/preset`、`--preset` CLI flag、tools/instructions 配置。两者数据模型高度重叠
（provider/model/thinkingLevel，值域一字不差），preset 是超集（多 tools/instructions），
但 mode-switcher 有 preset 缺的「可视化选择面板」交互。两者并存造成定位重复。

## 决策

1. **删除 mode-switcher，preset 成为唯一的预设切换入口。**
2. **preset 选择面板升级为 master-detail 两级导航**，吸收 mode-switcher 的「可视化选择面板」
   体验：一级列表 `Enter` 选用、`→` 进详情看全部 5 字段（provider/model/thinkingLevel/tools/
   instructions，未配置显式「未设置」）、`←` 返回。
3. **取消循环切换**（盲切下一项）：`alt+. p` 从「循环」改为「打开选择面板」，降级键
   `Ctrl+Shift+P`（原 `Ctrl+Shift+U` 循环一并删除）。

## 权衡

| 方案                                   | 结论                                                   |
| -------------------------------------- | ------------------------------------------------------ |
| A. 保留 mode-switcher 与 preset 并存   | 拒绝：定位重复，两个插件都挂全局                       |
| B. preset 吸收 mode-switcher（本决策） | 采纳：单一入口，preset 是数据模型超集                  |
| C. 保留循环 + 新增面板双键             | 拒绝：循环盲切在 preset 少时价值低，且用户明确不要循环 |

## 后果

- **正向**：单一预设入口消除重复；master-detail 面板比盲切更可发现、可审查（能看到每个
  preset 的完整配置再决定）。
- **负向**：mode-switcher 独有但几乎未使用（无配置、日志无使用记录）的功能不再保留：
  `/mode store` 保存、color 边框色、overlay 临时模式、内置默认 mode（fast）。
