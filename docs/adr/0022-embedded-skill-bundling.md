# ADR-0022: 技能随扩展内嵌分发（Embedded Skill Bundling）

pi-worktree 要把"使用方式"抽成 agent 技能，且技能应随插件（扩展）一起分发。决定：技能放在扩展目录 `skills/` 子目录下，由扩展根 `package.json` 的 `pi.skills` 字段声明，sync 工具在同步扩展时自动发现并同步内嵌技能——而非继续维护"扩展 + 技能"两份独立清单，也不转向 npm 包分发。

## 考虑过的选项

- **A 松散关联**：技能独立放 `skills/` 顶层，sync-profiles.yaml 里扩展与技能各列一项。零改造，但"跟着走"靠人肉保证，两份清单易漂移。
- **B 捆绑 + 改 sync（采用）**：技能内嵌到扩展目录，sync 工具识别 `pi.skills` 随扩展同步。保持 monorepo + sync 开发流，单一事实来源。
- **C npm 包化**：worktree 拆成独立 npm 包，`pi install` 分发。最"标准"，但需处理 `@zenone/*` 本地依赖、定发布渠道、切换开发流——对自家 daily-use 插件是过度工程。

## 后果

- 目录约定（`extensions/<name>/skills/<skillName>/SKILL.md` + `pi.skills` 声明）确立后难逆转，成为 monorepo 内"扩展自带技能"的一等公民约定，所有后续插件复用。
- 与官方 package 目录约定同构：`pi.skills` 指向的目录即 package 视角的 `skills/`，将来 npm 化零迁移（`pi` manifest 已就绪）。
- 内嵌技能命名沿用目录名（N1），与顶层 `skills/` 同名时 sync 工具 fail-fast，不静默覆盖。
