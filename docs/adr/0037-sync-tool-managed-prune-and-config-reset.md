# ADR-0037: sync 工具受管资产剪枝 + 配置重置交互

- 状态：已接受（2026-09）
- 相关组件：`scripts/sync-to-local-pi.ts`、`scripts/sync-profiles.yaml`、`scripts/lib/`（bridge-builder / package-manager）
- 延伸：无（sync 工具此前无专项 ADR）；与 `extensions/meta/pi-config`（ADR-0032 双层路径）相关
- 术语：见 `CONTEXT.md`「本地同步（sync 工具）」一节（受管资产 / 第三方资产 / 有效集合 / 严格剪枝 / 保护名单）

## 背景

`scripts/sync-to-local-pi.ts` 此前是**只增不删**：默认永不删除目标目录里已存在的资产，只有显式
`--purge` 才镜像清空。由此产生两个痛点：

1. 插件从 `project` profile 挪到 `user-install`（或反之）后，旧目标里的副本**残留**，pi 启动时
   出现 `command 1` / `command 2` 重名（同一扩展被两个 profile 各注册一份）。
2. 删除/更新插件时，其 `extensions-data/<plugin>/config.json`（pi-config 的 profile）无人清理，
   下架插件留下孤儿配置、更新插件带着旧配置字段继续跑。

## 决策

### 1. 默认行为升级为「严格剪枝」（受管资产删除）

删除谓词（默认，无需 `--purge`）：

```text
受管资产（名字 ∈ 本仓库源清单） ∧ 不在当前 profile 有效集合 ∧ 不在保护名单 → 删除
```

- **受管资产**：目标目录中、名字能在本仓库源清单（`extensions/`、`skills/`、`themes/`、
  `prompts/`）按名匹配到的资产。按名字匹配，无需任何状态文件（不引入「上次同步清单」）。
- **有效集合** = include（`*` 或显式清单）减去 exclude。`user-install` 是显式清单、`project` 是
  `'*' + exclude`，两者的有效集合互斥，故「从 project 挪到 user-install」会同时触发
  `./.pi` 旧副本被 project 的 exclude 剪掉、`~/.pi/agent` 新副本被 user-install 同步——根治重名。
- **第三方资产**：名字不在源清单里（herdr 安装的集成等）。默认**永不删除**，仅 `--purge` 清。
- **形态冲突残留（补充，UAT 发现）**：目标里名字 ∈ 源清单、但**形态与源不一致**的残留——源是
  目录扩展、目标残留了同名单文件 `.ts`（或反向）——也按受管资产删除，且**不受 purge/inline 决策**
  影响（属「形态一致性修正」而非 stale 剪枝）。典型场景：`review` 从单文件重构为目录后，旧
  `review.ts` 残留导致 pi 加载 `review.ts` + `review/` 两次 → `review:1` / `review:2` 重名。

### 2. `--purge` 语义升级为「全量镜像」超集

- 默认 = 只剪受管；`--purge` = 连第三方一起删（仍跳过保护名单）。两者是包含关系，不重叠混淆。
- 内联模式（`--ext/--skill/--theme/--prompt --target ...`）**不默认剪枝**，保持「增量拷贝」语义，
  仅 `--purge` 才删。既有护栏不变：内联 `--target` 指向 `~/.pi` 且 `--purge` 仍强制阻断。

### 3. 配置重置：删除/更新时交互式批量处理 pi-config profile

- **进列表条件**：目标下存在 `extensions-data/<plugin>/config.json`（**已保存过 profile** 的插件）。
  是否 import 过 `@zenone/pi-config` 与「有无可重置的东西」解耦，故不按源码 import 判定。
- **列表内容**：本次被**删除**的插件 ∪ 本次被**更新**（`shouldSync` 判定实际会写入）的插件。
- **重置语义**：只删 `config.json`（保留同目录 `<sessionId>.json` session 文件），插件下次启动回
  落到内嵌默认 profile。
- **交互**：单次聚合多选列表（`↑/↓` 移动、`空格` 勾选、`a` 全选/全不选、`回车` 确认、`Ctrl+C`
  中止=全保留）。勾选 = 重置（删 `config.json`），未勾选 = 保留。默认全保留。
- **降级**：`process.stdin.isTTY === false`（CI/husky/e2e/管道）→ 跳过提示、全部保留并 log WARN。
  `--dry-run` → 不弹提示，仅预览 `[would reset] <plugin>`。

### 4. 彻底下架插件 fail-safe 放过

插件若既不在 profile 有效集合、也不在源清单（源码已从仓库删除），按「第三方」处理被放过——宁可
不误删（无法区分「我们下架的旧插件」与「用户自己装的」），真需清理时用 `--purge`。不引入墓碑清单。

## 后果

**正面**：sync 从「只增」变为「受管资产可回收」，根治 profile 迁移后的重名与孤儿副本；配置重置给
用户一个显式、非破坏性的收尾动作（默认保留，删除是显式勾选）。

**负面/代价**：默认即会删除 `~/.pi/agent` 里「我们的但不在清单」的资产——对 `user-install` 这种
显式清单是激进剪枝，任何源清单有、却没列进清单的扩展都会被清。用户须确保清单准确反映意图。

**迁移风险**：`PROTECTED_EXTERNAL` 目前只有 `extensions: herdr-agent-state`；若未来有更多第三方
集成需要保留，需补入保护名单。交互式多选需在无第三方库的前提下用 raw mode 手写，非 TTY 降级必须
覆盖 CI/husky/e2e 场景，否则会挂起。
