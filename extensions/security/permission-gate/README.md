# permission-gate 权限门禁

拦截危险命令与敏感文件操作，按**危险分级**决定放行策略，支持全量审计、外部通道确认与拦截强度回检。

## 危险分级模型

命中黑名单的操作按**三个正交语义轴**判级为 `critical / warning / info`：

| 轴       | 判定                                         | 规则                                   |
| -------- | -------------------------------------------- | -------------------------------------- |
| 副作用   | 读 vs 写                                     | 有副作用至少 info 级以上；纯读为最低档 |
| 权限相关 | chmod/chown/sudo/su/setfacl/usermod/mount 等 | `sudo` 一律 critical，不解析后续命令   |
| 路径空间 | 系统目录层 / 敏感凭证层                      | 见下                                   |

**路径空间分两层**：

- **系统目录层**（/etc /usr /boot /lib /sbin /bin /sys /proc /dev）——写 = critical、读 = warning
    - **无害设备文件豁免**：/dev/null、/dev/zero、/dev/full、/dev/random、/dev/urandom、/dev/stdin、/dev/stdout、/dev/stderr、/dev/fd、/dev/tty 的读写不判 system-dir-write/read（避免 `2>/dev/null`、`cat /dev/zero` 等常规操作被误报为 critical）
- **敏感凭证层**（~/.ssh ~/.aws ~/.kube ~/.gnupg、项目内 `.env` `*.pem` `*.key` `id_rsa`）——读 = 写 = critical（读凭证即信息泄露）

**危险命令清单**（dd/mkfs/fdisk/parted/wipefs/shred/iptables/nftables/shutdown/reboot 等）命令字面匹配即一律 critical。

> 判定实现基于 tree-sitter-bash（WASM）精确语法解析，产出「命令 × 目标路径 × 读写方向」的结构化表示，供判级与未来算法语料使用。

## 自适应放行与三级持久化

自适应放行规则（graduated approval）可沉淀的最高层级由危险等级决定——**危险等级越高，信任越不持久**：

| 等级     | 放行规则可沉淀层级 | 生命周期                         |
| -------- | ------------------ | -------------------------------- |
| critical | 会话级             | /reload 后仍生效；超期 30 天清理 |
| warning  | 项目级             | 跨会话、限本项目                 |
| info     | 用户级             | 跨项目、全局                     |

`info` 级也进入确认流程，但大概率沉淀到用户级被自动放行，打扰成本极低、换来审计完整。

## 全量审计与分层存储

每次命令执行（全部工具调用，不只被拦截的）生成唯一 ID 并完整记录，分三层存储：

| 层       | 内容                                                  | 生命周期                             |
| -------- | ----------------------------------------------------- | ------------------------------------ |
| 审计日志 | 每次执行的 ID、时间、工具、命令、级别、决策、命中维度 | JSONL 按天分片，默认保留半年滚动清理 |
| 放行规则 | 自适应放行沉淀的信任规则                              | 永久（三级持久化）                   |
| 配置     | pattern 清单 + 级别标注 + 阈值                        | 永久（双层：用户/项目）              |

## 外部确认接口

permission-gate 暴露**通道无关**的程序化确认接口，任何插件（如 wechatbot）可订阅并确认，等效于人工 TUI 选择：

```typescript
// globalThis.__permissionGateApi
interface ConfirmRequest {
	requestId: string; // 唯一 ID
	shortCode: string; // 前 6 位短码，供外部通道短引用
	tool: string;
	command: string; // 命令摘要
	level: 'critical' | 'warning' | 'info';
	reasons: string[]; // 命中维度：permission-related / destructive / system-dir / credential ...
}

interface PermissionGateApi {
	onPendingRequest(cb: (req: ConfirmRequest) => void): () => void;
	confirm(requestId: string, decision: 'allow' | 'deny'): Promise<boolean>;
	listPending(): ConfirmRequest[];
}
```

约束：

- **阻塞行为不变**：确认流程不因外部通道而改变；外部通道只是多一个确认入口。
- **超时/作废归通道**：permission-gate 不管理外部通道的超时与作废（微信端短码过期等由通道自己控制）。
- **decision 与 TUI 选项对齐**：`confirm` 的取值即 TUI 确认选项，保证外部确认与人工操作语义一致。

## 远端豁免模式（`--unattended-confirm`）

远端通道（微信等）发起 `session_before_switch` 等动作时，TUI 确认框无人应答会**永久阻塞**。
本模式让**可询问拦截**在无人在场时按声明处置；**硬拦截**（`protected-paths` / `secret-firewall` / sandbox）
完全不受影响。完整决策见 [ADR-0068](../../../docs/adr/0068-remote-mode-confirm-exemption-cwd-scoped.md)。

### 状态机（许可 ≠ 生效）

| 状态            | 触发                            | 行为                                             |
| --------------- | ------------------------------- | ------------------------------------------------ |
| `off`           | 启动未带 `--unattended-confirm` | 与今天一致：弹框、等待                           |
| `licensed-idle` | 带 flag，但无通道占用           | 与今天一致（许可只是授权，不自动生效）           |
| `armed`         | 通道 `arm()` 占用               | 不弹框；需确认的动作按下列规则处置，**全部审计** |

### 豁免规则

- 命中 reason 必须落在白名单 `{destructive, pattern}` 内，且 `pattern` 必须是**内置规则**——
  **你自己新增的拦截模式不算**（远端模式不代答本机额外声明的确认意图）；
- 静态目标**全部**在 `ctx.cwd` 内 → 放行，审计 `decision: 'allowed-unattended'`（保留 `tier` / `reasons` / 命中叶子）；
  「在 cwd 内」按 **realpath 真实路径**判定：cwd 与目标两侧都归一化，cwd 内软链指到外面 → 判越界；
  写重定向目标同等判定，仅 `/dev/null` 视为丢弃输出。
- 目标**不得是 cwd 本身**（`rm -rf .`），也不得在 **`.git` / `.pi`** 内——这两个目录被 pi-rewind 快照恒剔除，
  **任意层级**都算（按目录名剔除：`packages/sub/.git` 这类嵌套仓库 / 子模块同样没有快照），
  删掉不可回滚（仓库历史 / 项目配置与待办）。目标本身是目录时还会扫**子树**：`rm -rf packages` 会连带
  删掉 `packages/sub/.git`，同样不豁免；子树扫不完或不可读 = 证明不出来 → 不放行。
- 文件操作命令必须是**裸命令名**（`rm` / `rmdir` / `unlink`）：`./rm`、`/tmp/x/unlink` 是任意可执行文件，
  不能按 basename 当 coreutils 处理，否则「参数都在 cwd 内」的判定会去放行一段不受约束的代码 → `path-qualified-op`。
- 无目标 / 目标不可静态解析（变量 / 通配符 / `~user` / 写重定向目标为解析不出的空串）/ 命令链含 `cd` / `permission-related` / `credential` / `system-dir-*`
  / 用户自加 pattern / `.git`·`.pi`·cwd 根
  → **不豁免**（审计 `decision: 'deny'` + `denyCause: 'unattended'`），`block.reason` 回给模型，
  文案 = `note`（为什么危险）+ `remedy`（怎样合理操作），模型可据此自愈重试。
- 判定按「**证明得出**」而非「没看见就当作没有」：参数位含展开 / 替换 / 赋值（`$VAR`、`${VAR}`、`$(cmd)`、
  `` `cmd` ``、`FOO=1`、`a$b`）或复合体（`( … )` / `{ …; }`）上的写重定向，解析层无法把它们归属到可信目标，
  一律**不豁免**——`rm -rf ./x $DANGER` 不会被读成「目标只有 `./x`」。

### 给人类

1. 启动命令加 `--unattended-confirm`。**先同步扩展再改命令**——flag 未注册时 pi 会以 `Unknown option` 退出（ADR-0051 `D8`）。
2. 状态栏 `| unattended` = 生效中；`licensed-idle` 不显示该标记。
3. 临时恢复确认：`/unattended disarm`（清空**所有** owner，含通道；通道崩溃未及 `disarm()` 时也有效），
   或让通道 `disarm()`、停用桥。`/unattended status` 可查当前 owner 列表。

### 给通道消费方

```typescript
interface ConfirmGateApi {
	hasLicense(): boolean;
	isArmed(): boolean;
	owners(): string[];
	arm(owner: string): (() => void) | undefined; // 无许可 → undefined（fail-soft，不抛错）
	status(): {
		license: boolean;
		armed: boolean;
		owners: string[];
		mode: 'off' | 'licensed-idle' | 'armed';
	};
}
```

1. `session_start` 后读接口；不存在 → `log.warn` + 回执说明「本机未提供豁免接口」，不 `arm`。
2. `hasLicense() === false` → 不 `arm`，在 `/status` 与回执里提示「未授权：启动命令需加 `--unattended-confirm`」。
3. 连接就绪 → `arm('wechat')`；断开 / `session_shutdown` / 停用 → `disarm()`（幂等）。
4. **执行 `/new` 等动作前先自检 `isArmed()`**，未生效即回执拒绝 + 指引，不要让用户等挂起。
5. 每次 `arm` / `disarm` 与状态变化留日志（通道名 + 结果）。

## 系统通知

复用 `extensions/auto/notify.ts`（升级 osascript，不引入 alerter 重依赖），通过 `globalThis.__notifyApi` 弱桥接调用；仅在 `ask`（拦截需人工确认）时触发。

## 面板 tabs：分层 + 历史/分析按来源范围

`/permission-gate` 打开 6 个一级 tab：`[会话][项目][用户][历史][分析][设置]`。

- **会话 / 项目 / 用户 tab**：对应三层作用域的策略管理（见「自适应放行」），用户级 tab 顶层为全局视图，`enter` 下钻。
- **历史 tab**：全量命令审计，二级 tab `[会话][项目][用户]` 按**来源范围**筛选（←→ 切换）：
    - 会话 = 当前会话产生的记录；
    - 项目 = 当前项目（含历史会话与旧版无 `projectPath` 记录，按 `projectKey` 兼容）；
    - 用户 = 全部项目，列表加**项目路径列**（缩写：`~/P/D/A/name`，每段首字母大写、叶子全名；旧记录标「未知」）。
    - 列表带**表头**（状态/决策/命令/时间），数据懒加载窗口（倒序分片，滚动到底自动扩展）。
    - `enter` 详情：完整决策树 + **项目全路径**（超宽自动换行）+ **会话**（会话改名后显示最新名，找不到回退审计快照名）+ 会话 ID。
- **分析 tab**：聚合统计 + 确定性异常高亮，二级 tab 同历史按**来源范围**聚合：
    - **指标**（按级别分组）：确认/自动放行/拦截计数、graduated 放行的高危命令清单、高频被确认命令 Top N、误拦（用户拒绝）比例。
    - **异常高亮**：`critical 被 graduated 放行` 标红（本该最严格却自动放行）；`高频误拦`（同一命令被拒绝 ≥ N 次）标黄（规则该调）。
    - **时间粒度**：7 / 30 / 90 / 180 天；范围 = 本次会话 / 当前项目 / 全部项目。

复杂异常检测（统计离群等）留待未来智能自适应算法，第一版不做。

## 相关 ADR

- [ADR-0025 危险分级与自适应放行模型](../../../docs/adr/0025-danger-tiering-and-graduated-approval.md)
- [ADR-0026 pi-state 分层持久化底座](../../../docs/adr/0026-pi-state-layered-persistence-base.md)
- [ADR-0027 全量命令审计与分层存储](../../../docs/adr/0027-full-command-audit-and-layered-storage.md)
- [ADR-0028 多通道外部确认接口](../../../docs/adr/0028-multi-channel-external-confirmation.md)
