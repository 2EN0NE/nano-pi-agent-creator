# pi-rewind 架构分层与跨插件边界

**决策**：单包 `extensions/auto/pi-rewind/`，引擎内联 `engine/`（纯 git 库，零 Pi 依赖，可单测）；状态持久化由「git 引擎 + session entries（`pi-checkpoint` custom entry）+ storage manifest」三层承担，**不接 `@zenone/pi-state`**；跨插件控制走 **`globalThis.__piRewind` 弱依赖桥**（`suppressTreeRestore` / `clearSuppressTreeRestore`），不共享引擎、不做 label 探测。

**为什么**：

- **不拆 meta 包**：当前仓库无第二个引擎消费者。review 开审查分支用的是 `ctx.navigateTree(..., { summarize:false, label })` 而非 fork，它需要的是「控制信号」（这次导航别切代码），不是「共享引擎」；拆 `@zenone/pi-checkpoint` 是投机。
- **不接 pi-state**：rewind 的重数据（beforeCommit/afterCommit）在 bare repo、元数据在 session entries、簿记在 manifest——pi-state 的 JSON 状态文件（`extensions-data/<plugin>/`）放不进这套，且 `cleanupExpired` 管不到 bare repo 目录。
- **globalThis 桥**：review 开审查分支的 `navigateTree` 会触发 `session_before_tree`，`restoreOnTree:"ask"` 下会弹多余的「Sync files?」。弱依赖桥（仿 pi-lab `__labApi`、permission-gate `__permissionGateApi` 同款）让 review 在导航前 suppress、导航后 finally clear，rewind 未装时 `?.` 静默降级。

## 考虑过的选项

- **拆 `@zenone/pi-checkpoint` meta 包（供多插件复用引擎）**——否决：无第二消费者，YAGNI；真出现再抽，成本低。
- **接 pi-state 存状态**——否决：状态归宿已被 git 引擎/entries/manifest 三层覆盖，硬套 pi-state 是张冠李戴。
- **label 探测（rewind 识别 review 的 `label` 自动跳过）**——否决：rewind 需耦合 review 的 label 语义，脆弱；显式桥解耦。
- **消费一次自动清除的 suppress**——未采用；采用 suppress + finally clear（防泄漏，且与 oh-my-pi 内部 `/rewind` 导航防重入同构）。

## 后果

- review 的所有 `navigateTree` 调用点（打开审查分支、总结返回的 loader 与直接两分支、returnOnly 返回）均包 suppress/clear（弱依赖，rewind 未装时 no-op）。
- `checkpointTrigger` 配置决定创建时机（`message`/`event`/`off`，`batch` 挂起）；checkpoint 的跨度单位固定为「一条用户消息」（before=消息前、after=loop 结束后），不做 turn 级粒度。
