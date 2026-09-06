# permission-gate 危险分级与自适应放行模型

**决策**：permission-gate 不再按"破坏性程度的模糊直觉"分级，而是按**三个正交语义轴**对命中黑名单的操作判级为 `critical / warning / info` 三级，且每一级绑定一个"自适应放行规则可沉淀的最高持久化层级"：

| 等级     | 判定来源                                                   | 放行规则可沉淀层级     |
| -------- | ---------------------------------------------------------- | ---------------------- |
| critical | 权限相关命令 / 危险命令 / 敏感凭证（读写）/ 系统目录（写） | 会话级（会话结束失效） |
| warning  | 有副作用但不涉权限、不在敏感区域（系统目录读也归此）       | 项目级                 |
| info     | 纯读、非敏感、非权限相关                                   | 用户级                 |

**三维判定轴**：

1. **副作用**（读 vs 写）——有副作用至少 info 级以上；无副作用（纯读）为最低档。
2. **权限相关**（chmod/chown/sudo/su/setfacl/usermod/mount 等）——`sudo` 一律 critical，不解析其后续命令（提权即最高警戒）。
3. **路径空间**（分两层）：
    - 系统目录层（/etc /usr /boot /lib /sbin /bin /sys /proc /dev）——写 = critical、读 = warning；其中**无害设备文件豁免**：/dev/null、/dev/zero、/dev/full、/dev/random、/dev/urandom、/dev/stdin、/dev/stdout、/dev/stderr、/dev/fd、/dev/tty 的读写不判 system-dir-write/read（避免 `2>/dev/null`、`cat /dev/zero` 等常规操作被误报为 critical）；
    - 敏感凭证层（~/.ssh ~/.aws ~/.kube ~/.gnupg、项目内 `.env` `*.pem` `*.key` `id_rsa`）——读 = 写 = critical（读凭证即信息泄露）。

另有独立的**危险命令清单**（dd/mkfs/fdisk/parted/wipefs/shred/iptables/nftables/shutdown/reboot 等），命令字面匹配即一律 critical。

**关键取舍**：`info` 级也拦截（进入确认流程），但因大概率会沉淀到用户级被自动放行，实际打扰成本极低——换来的是"每次命令执行可回溯"的审计完整性。

**实现基础**：采用 tree-sitter-bash（WASM）做精确语法解析，产出「命令 × 目标路径 × 读写方向」的结构化表示，替代现有的"空格切 token + `includes('/')`"启发式（该启发式丢失读写方向、丢失命令×路径绑定、误判 flag 型参数）。

**为什么**：危险等级越高，信任越不持久——这是"fail-closed 于跨会话持久化"与"保留动态自适应放行"之间的分层裁决。此前讨论过 (a) 一律永不自动放行、(c) 全部动态放行、(d) 全部永不拦截，均被否决：(a) 打扰成本过高，(c) 违背安全目标，(d) 失去审计价值。

> **语义更新（ADR-0033）**：表中 critical 的「会话级（会话结束失效）」在 2026-09 调整为
> 「跨 `/reload` 保留，30 天过期清理」——会话文件跟随 sessionId 落盘，`session_shutdown` 不再删除，
> 由 `session_start` 的 `cleanupRulesStore`/`cleanupManualStrategiesStore` 按 mtime 清理。
> 信任窗口由「会话结束」放宽到「30 天」，详见 ADR-0033 决策 4。

## 补充（命中原因解释）

- **多命中收集**：`assessTier` 由「单条最高分类」改为返回 `{ tier, reasons, hits }`——`hits` 收集全部命中维度（`sudo rm -rf /etc` = 权限相关 + 系统目录写 + 拦截模式），`reasons` 保留去重后的扁平分类 key 供审计/统计/外部通道消费（向后兼容）。
- **来源区分（口径甲）**：命中按「规则层」标注——内置清单（danger/permission/pathSurfaces）标 `[内置·xx]`，拦截模式（patterns）标 `[拦截模式]`。
- **解释文案分层**：条目 `note`（用户/官方）优先，否则分类兜底文案。内置清单与默认拦截模式的官方解释集中于 `notes.ts`，加载时按 command/pattern 反查注入「note 为空」的条目，不覆盖用户备注；用户自增条目无 note 落兜底文案。
- **读写语义修正**：`sudo rm -rf /etc` 等提权前缀命令的读写判定落到其参数中的真实命令（rm），不再误判为「读取系统目录」。
