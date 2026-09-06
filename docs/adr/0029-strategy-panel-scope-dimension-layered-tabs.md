# permission-gate 策略面板 scope × 维度两级分层 Tab

**决策**：将 permission-gate 的 TwoTabPanel 从「策略/历史/分析 三 tab + 维度混排」重构为「scope 一级 tab × 维度二级 tab」的两级分层结构。

**结构**：

```
一级 tab（Tab 切换）：[会话] [项目] [用户] [历史] [分析]
  scope 三个 tab 内，二级 tab（← / → 切换）：[命令] [工具] [目录]
    每个 = 一个维度列表，选中条目 → Enter 展开详情（master-detail）
  [分析] 二级 tab（← / → 切换）：[会话] [项目] [用户]（按 scope 分别分析）
  [历史] 无二级 tab，Enter 打开条目完整详情
```

**关键约束**：

1. **分层暴露多层计数**——展示层按层分别读取三层 counts（session/project/user 各自完整计数），同名 key（如 `tool:rm`）可同时出现在多个 scope tab；判定层（`checkThreshold` / `hasGraduatedStrategy`）维持单层遮蔽合并的保守语义，**不动**。实现新增按层读取接口（如 `getRuleCountsByLayer()`），替代 `getRuleCountsWithScope()` 的单层遮蔽语义供 UI 使用。

2. **维度用二级 tab 隔离，不用组头分组**——组头分组不解决「cmd 哈希膨胀淹没 tool/dir」：组头只是视觉标记，滚动视口仍被 cmd 段占满，tool/dir 组头落在视口外。二级 tab 才真正隔离维度。

3. **删除仅删当前层 + 确认弹窗**——在某 scope tab 删除只影响该层计数（session/project/user 各自独立删除），并补上确认弹窗（当前删放行策略无确认，与删拦截模式有确认不一致）。确认弹窗给「仅本层」/「所有层」双选项，默认「仅本层」。

4. **交互约定**：
    - Tab 切一级 tab；← / → 切二级 tab（scope 层切维度，分析层切 scope），历史层无二级。
    - Enter 打开选中条目详情（master-detail），历史详情含决策中文说明（被规则自动放行 / 用户确认 / 拒绝 / 直接放行）、命中规则、等级、工具、时间、完整命令。
    - 空维度 tab 仍显示 tab 头 + 内容区「暂无 X 策略」，不因空而隐藏/跳动。
    - 全局单过滤词，作用于当前聚焦列表，切换任何 tab 时清空（避免 9 个 scope×维度组合各自独立 filter 的状态爆炸）。
    - 维度 tab 头显示计数，如 `[命令(30)] [工具(3)] [目录(2)]`。
    - session tab 提示「会话级：本次对话结束后失效」，显式传达临时信任语义。
    - 分析 tab 按 scope（session→critical / project→warning / user→info）分别聚合审计指标，可独立审视各层级的确认/自动/拦截与误拦比例。

**为什么分层**：原混排方案下 cmd 哈希随使用线性膨胀，tool/dir 被永久压到视口外，且随时间恶化、非排序可解。scope（信任持久度：session 临时 < project 项目 < user 全局）是安全工具最核心的语义，放一级 tab 让「临时信任 vs 全局信任」一目了然，user 层（全局持久信任）最需被独立审视而不被 cmd 淹没。该结构与 /todos 的 scope 分层心智一致，零学习成本。
