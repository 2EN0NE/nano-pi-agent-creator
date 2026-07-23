# 领域词汇表

## Cloud Sessions

| 术语                 | 定义                                                                                                                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ConflictResolver** | 纯决策引擎，接收本地/远端文件的 `FileState` 对，返回 `Resolution`。不执行任何文件操作。                                                                                                                  |
| **Resolution**       | ConflictResolver 的输出。`action`: `push_local` / `pull_remote` / `skip` / `merge`，带可选的 `mergedContent` 和 `reason`。                                                                               |
| **MtimeResolver**    | ConflictResolver 的默认实现。基于 hash 和 mtime 差异做 4 路决策。构造时可配 `toleranceMs` 和 `tieBreaker`。                                                                                              |
| **Merger**           | 负责生成合并后内容。`merge(localPath, remotePath) → Promise<string>`。延迟读文件，仅在需要 merge 时调用。                                                                                                |
| **ProjectMatcher**   | 从同步镜像中查找同一项目的其他机器目录、复制匹配会话到当前 cwd 目录的策略接口。`match(config: ProjectMatchConfig, machineId: string, sessionsRoot: string, mirrorRoot: string) → Promise<MergeResult>`。 |
| **Sync**             | 同步编排器，内部 `syncFiles()` + `applyProjectMatch()` 分别走 ConflictResolver 和 ProjectMatcher，最终一次 `provider.push()` 提交。                                                                      |
