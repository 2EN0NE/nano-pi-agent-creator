# ADR-0025: review 扩展合并为 profile 驱动

`review` 与 `test-analysis` 两个扩展主流程（target 选择、PR 检出、fresh-session 分支、循环修复、end 返回/总结）完全一致，仅提示词与"判定结束条件"不同。决定：合并为单一 folder 插件 `extensions/verification/review/`，注册 `/review` + `/end-review` 两个命令；差异抽成 **审查方案（profile）**，每个 profile 绑定「提示词（`prompt.md`）+ 判定结束条件（`verdict.json`）」两个资源文件，`config.json` 只做轻量 profile 注册表。

## 考虑过的选项

- **A 保留两命令各自独立**：`/review` + `/test-analysis` 各保留。零改造，但 1606 行重复代码继续漂移（已观察到 PR notify 文案 review 中文 / test-analysis 英文的不一致）。
- **B 提示词全塞 config.json**：一个 JSON 装提示词 + 判定规则。被拒——大段 markdown 进 JSON 转义/diff/高亮都是灾难。
- **C 分离资源文件 + 注册表（采用）**：提示词放 `prompt.md`（`## <section>` 分节，模板变量 `{sha}`/`{title}`/`{paths}` 运行时替换），判定规则放独立 `verdict.json`（三层 schema），`config.json` 仅列 profile 引用。

## 后果

- profile 语义确立：**审查方案（Profile）** = 提示词 + 判定结束条件的组合。`/review` 下先选 profile、再选 target（staged/uncommitted/branch/commit/PR/folder）。
- 判定结束条件收敛为三层声明式 schema（`verdict` / `findings` / `findingLine`），review 的二态结论（correct / needs attention）与 test-analysis 的三态结论（protected / gaps found / unprotected）用同一组 `safeValues` / `blockingValues` 表达，枚举拒绝在 `safeValues+blockingValues` 总数 > 1 时自动启用。
- profile id 采用 `code-review` / `test-analysis`，避开命令名 `/review`。
- `CONTEXT.md` 新增「review 审查方案（profile）」词汇区；`Profile` 中文映射扩为三义（配置/预设/审查方案）。
- 迁移注意：删除的 `extensions/verification/review.ts` 与 `test-analysis.ts` 不会被 sync 工具自动清理（sync 默认不删除目标文件）。存量安装需用 `--purge` 或手动删除 `~/.pi/agent/extensions/` 下的旧 `review.ts`/`test-analysis.ts`，否则会与新的 `review/` 目录插件重复注册 `/review`、`/test-analysis` 命令。
