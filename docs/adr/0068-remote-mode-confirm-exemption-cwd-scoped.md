# ADR-0068: 远端模式的确认豁免（`--unattended-confirm`，cwd 限定）

- 状态：**已接受**（2026-10-26 grilling 收敛；按 D1–D7 实施）
- 相关组件：`extensions/meta/selector`（`showSelect`/`showConfirm`，兼承载 flag 与 `__confirmGateApi`）、
  `extensions/security/permission-gate`（判定 + 确认树 + `notes`）、`extensions/security/confirm-destructive`、
  `extensions/security/dirty-repo-guard`、`extensions/auto/cloud-sessions`、`extensions/context/goal`、
  `extensions/auto/loop`、`extensions/accuracy/todos`
- 消费方：微信桥接插件（另一仓库 `pi-plugins/wechatbot`），后续其它远端通道可复用同一接口
- 延伸：**修订** ADR-0051 `D6`（其原结论为「不引入确认超时/无人值守降级」「不把无人值守抽象成通用机制」，
  且其残余风险 3 断言「死锁面只收敛在 permission-gate 一处」——本 ADR 实测证伪）；承接 ADR-0028（通道无关
  外部确认）、ADR-0025（危险分级）、ADR-0030（阻断确认树）、ADR-0038（pi-rewind 覆盖边界）
- 术语：**远端豁免模式** / **可询问拦截** / **硬拦截** / **在场判定** / **声明式默认**（见 `CONTEXT.md`）

## 背景

### 痛点

微信发 `/new` → 桥调用 `ctx.newSession()` → pi 顺序 emit `session_before_switch`，多个扩展各自弹 TUI 对话框；
TUI 无人按键即**永久阻塞**。同一形态不只发生在 `/new`：只要对话框依赖「有人按键」，无人值守下就是挂起。

### 决定性事实（均已核实）

1. **`session_before_switch` 载荷无来源**：pi `agent-session-runtime.js:78-90` 只构造
   `{reason, targetSessionFile}`，handler 无法区分「谁发起」。
2. **`hasUI` ≠「有真人在看」**：`hasUI = uiContext !== noOpUIContext`（`runner.js:404-406`），注释明写
   "true in TUI and RPC modes"（`types.d.ts:218`）。因此**各插件已有的 `if (!ctx.hasUI)` 降级分支在 TUI 下永不触发**。
3. **`ctx.mode`（`tui`/`rpc`/`json`/`print`）是唯一能区分「终端在场」的字段，现有代码没人用它**。
4. **落点不止 `selector`**：selector 与 permission-gate 的确认树是两份平行实现
   （`selector/index.ts:121`、`confirm-tree.ts:573`），唯一公共层是 pi 的 `ctx.ui.custom`（扩展换不掉）。
5. **`rm -rf` 判 `critical`**（`permission-gate/config.ts:169`），且 `critical` 的放行规则持久化层级被固定为
   `session`（`approval-store.ts:28-32`）——既有设计是「critical 永不沉淀为长期免确认」。
6. **sandbox 不是破坏性意图的防线**：默认 `allowWrite: ['.', '/tmp']`（`sandbox/index.ts:75-77`），
   工作区内删除**全部放行**；它管「哪里能写」，不管「该不该删」。
7. **关掉门禁 ≠ 有日志**：`permission-gate/index.ts:484` 在 `enabled === false` 时直接 return，**不写审计**。
8. **自动阻断面共 11 处 / 9 个插件**（原问题陈述只列了 2 个）：见 D6 表。

## 决策

### D1 形态：门禁照跑，需确认的动作自动答 `allow` 并全量审计

不采用 `enabled:false`。保留判定、分级、策略与审计，只给「需要确认」这条路径补一个**无人应答时的出口**；
审计新增 decision 枚举 `allowed-unattended`，保留既有 `tier` / `reasons` / 命中叶子。
理由：唯一同时满足「能执行」与「有日志」的形态（事实 7）。

### D2 豁免范围：仅限 pi 启动工作目录（cwd）内的文件系统目标

「可豁免」必须**同时**满足：

1. 命中的全部 reason 落在白名单 `{destructive, pattern}` 内（白名单而非黑名单：未来新增分类默认落在「不豁免」一侧），
   且 `pattern` 命中必须是**内置规则**；`permission-related` / `credential` / `system-dir-*` / **用户自加 pattern** → 不豁免。
   用户自加 pattern 代表本机额外声明的确认意图，远端模式不代答（内置 `rm -rf` 命中记 `userPattern: false`，可豁免）。
2. 静态解析出的目标路径**全部落在 `ctx.cwd` 之内**（按 **realpath 真实路径**判定：cwd 与目标两侧都归一化，
   cwd 内软链指向外面 → 判越界；`~user` 由 shell 展开，不认作相对路径）；
   无目标、目标不可静态解析（变量 / 通配符 / `~user`）、命令链中含 `cd`（相对目标基准不可信）→ 不豁免。
   写重定向目标同等判定，仅 `/dev/null` 视为「丢弃输出」不计入写目标。

    **补充（实现契约，2026-10-27）**：判据是「能证明」而非「没看见就当作没有」。`bash-parser` 只把
    `word` / `string` 类节点收进 `arguments`、只把「父节点是 `redirected_statement` 且 body 是单条 `command`」
    的重定向归属给命令；因此解析层**必须**把这些信息缺口显式交出（`BashCommand.unresolved`、
    `BashParseResult.unattributedRedirects`），判定层见到即按不可解析处理（`unresolvable-target`）。
    否则 `rm -rf ./x $DANGER`、`rm -rf ./x $(cmd)`、`(rm -rf ./x) > /tmp/out` 这类命令会被读成
    「目标只有 `./x`、没有越界写目标」而在无人值守下放行——与第 2 条的正文明文冲突。

    **补充（实现契约，2026-10-27）**：豁免覆盖的文件操作命令必须是**裸命令名**（`rm` / `rmdir` / `unlink`）。
    `./rm`、`/tmp/x/unlink` 是任意可执行文件（`install -m 755 payload ./rm` 不触发任何内置 pattern，
    随后 `./rm -rf ./x` 只命中 `rm -rf` 这一条），按 basename 当 coreutils 会让「参数都在 cwd 内」的判定
    去放行一段不受约束的代码——与第 2 条「只作用于 cwd 内」直接冲突。命令名含 `/` → `deny('path-qualified-op')`。

3. 目标不得是 **cwd 本身**（`rm -rf .`），也不得落在 **`.git` / `.pi`** 内：这两个目录被 pi-rewind 快照显式剔除
   （`pi-rewind/engine/repo-manager.ts` 的 `shouldPruneAutoExcludeScanDir` 按**目录名**判定，任意层级都剔除），
   删除既无快照可恢复，还会带走仓库历史或项目配置/待办。判据同样**按路径段**——只比对 `<cwd>/.git`
   会把 `packages/sub/.git`（嵌套仓库 / 子模块）当成普通 cwd 内目标放行（实现契约，2026-10-27）。

    **补充（实现契约，2026-10-27）**：只判目标路径段还不够——`rm -rf packages` 会把 `packages/sub/.git`
    一起带走，后果与直接删它完全相同。因此目标本身是目录时还要扫**子树**是否含 `.git` / `.pi`
    （不跟随符号链接）：命中即 `protected-internal`；扫描不完（条目数上限）或子树不可读 = 证明不出来
    → `unresolvable-target`，仍不放行。普通工作区无感（本仓库 `node_modules` 约 2.2 万条目 / 约 130ms）。

不满足即回到原行为（拒绝或走确认）。**不引入 sandbox 或其它插件作为前提条件**——范围判据自包含在 cwd。

### D3 无法证明「只作用于 cwd 内」的动作不豁免，拒绝必须携带「为什么 + 怎样合理操作」

`git push --force`、`curl … | sh`、`sudo`、`eval`、`rm -rf $VAR`、`cd X && rm -rf Y` 一律不豁免。
理由：这些动作的后果在远端不可撤销，「工作区内」对它们没有约束意义；给豁免开口子等于让远端模式也能放行
提权与远程脚本执行。需要时走既有策略入口（手动策略 / graduated）提前放行。

**拒绝文案契约**（新增维度）：

- 既有 `note` 回答「为什么危险」；新增 `remedy` 回答「**怎样合理操作**」，随 `block.reason` 回给模型
  （pi `tool_call` → `beforeToolCall`，`types.d.ts:1089-1092`），模型据此**自愈重试**，无需人去 TUI。
- 指引按失败原因分类：目标在 cwd 外 → 指明 cwd 与合法替代；含变量 → 「改用字面路径」；含 `cd` →
  「不要改变目录，直接给相对/绝对字面路径」；无文件目标 → 「远端模式不自动放行，需在 TUI 确认或加手动策略」。
- 指引**不得暗示「换个写法即可通过」**——拒绝不是话术游戏，绕过拦截不属于自愈。

### D4 开关形态：静态许可 + 动态生效

```text
pi 启动         --unattended-confirm 在 → license = true
                                            │
通道连接就绪    api.arm('wechat')  ─────────→ armed = true    状态栏「远端豁免：生效」
通道断开/关闭   disarm()           ─────────→ armed = false   立即恢复确认
```

许可不存在时 `arm()` 返回 `undefined`（**不抛错**），通道 fail-soft 并在回执里说明原因。
理由：① 许可必须显式、可事后证明（`ps` / 启动日志），否则日志答不出「当时模式开着吗、谁开的」；
② 生效必须可回退（远端通道时连时断）；③ 任何插件不得自行创造许可。

接口（弱桥接，`globalThis.__confirmGateApi`，与 ADR-0028 同形，避免跨仓库 import 耦合）：

```ts
interface ConfirmGateApi {
	hasLicense(): boolean;
	isArmed(): boolean;
	owners(): string[];
	/** 引用计数占用；无许可时返回 undefined（fail-soft，不抛错） */
	arm(owner: string): (() => void) | undefined;
	status(): {
		license: boolean;
		armed: boolean;
		owners: string[];
		mode: 'off' | 'licensed-idle' | 'armed';
	};
}
```

#### 责任分工

#### ① pi 用户（人类）

1. 首次配置：把 `--unattended-confirm` 加进常驻启动命令（tmux 启动行 / org 成员 `launchArgs`）。
   **先同步扩展再改启动命令**——flag 未注册时 pi 以 `Unknown option` 直接退出（ADR-0051 `D8` 实测）。
2. 日常：无需动作；状态栏 `| unattended` = 生效中（`licensed-idle` 不显示）。
3. 临时恢复确认：让通道 `disarm()`，或停用桥。
4. 排障：`/permission-gate` 历史 tab 查 `allowed-unattended`；日志搜 `arm` / `disarm` /
   `allowed-unattended` / `skip-with-default`。

#### ② 通道消费方（如 wechatbot，另一仓库）

1. `session_start` 后读取 `globalThis.__confirmGateApi`；接口不存在 → `log.warn` + 回执写明
   「本机未提供豁免接口，远端操作仍会被 TUI 确认挡住」，不 `arm`。
2. `hasLicense() === false` → 不 `arm`；在 `/status` 与回执里提示「未授权：启动命令需加 `--unattended-confirm`」。
3. 连接就绪 → `const disarm = api.arm('wechat')`；断开 / `session_shutdown` / 停用 → `disarm()`（幂等，`try/finally`）。
4. **执行 `/new` 等会触发 `session_before_switch` 的动作前先自检 `isArmed()`**；未生效直接回执拒绝 + 指引，
   **不要让用户等到挂起**。
5. 每次 `arm` / `disarm` 与状态变化留日志（通道名 + 结果）。
6. 仍需处理 `newSession()` 返回的 `{cancelled}`（现被丢弃）。

### D5 「跳过」用**声明式默认值**表达，不引入第三返回值

- `SelectOptions.unattendedDefault?: T`（`showSelect`）；`showConfirm(..., opts.unattendedDefault?: boolean)`。
- armed 且声明了默认值 → **不弹** `ctx.ui.custom`，直接返回由该默认值组装的结果，日志记
  `skip-with-default title=<标题> default=<值>`。
- armed 但**未声明**默认值 → 按「取消」处理（fail-closed），日志记 `skip-no-default title=<标题>`。
- 不新增第三返回值：11 处 `showSelect`/`showConfirm` 调用点里只有 4 处需要「放行」语义
  （`dirty-repo-guard` 的 `proceed`；`confirm-destructive` 的 clear session / switch session / fork 三个「是」），
  其余 7 处保持现状（未声明 → 按取消）。

理由：默认真值是「这个确认允不允许自动放行」的**就近表达**——只有写这个对话框的人能判断。实测三处调用方
的「第一个选项」含义互不一致（`proceed` / `false` / `yes`），selector 不该猜。

后果：`allowOther` 的补充输入在 armed 下不会触发；`questionnaire`（agent 可调用工具）不声明默认值 →
返回取消，agent 得到「无人回答」。

### D6 覆盖范围：只覆盖「无人值守下会**自动**出现的」对话框

判定标准：**在没有人追加操作的前提下**，日常 pi 使用（`/new`、`/fork`、`/resume`、`/compact`、`stop`，
以及 agent 自主执行命令 / 调用工具）是否可能弹出它。

纳入（A 类，11 处落点）：

| #   | 插件                  | 触发                                                                           | 对话框                | 落点                  |
| --- | --------------------- | ------------------------------------------------------------------------------ | --------------------- | --------------------- |
| 1-2 | `confirm-destructive` | `session_before_switch`(new/resume)、`session_before_fork`                     | selector              | `:25`、`:49`、`:72`   |
| 3   | `dirty-repo-guard`    | switch / fork                                                                  | selector              | `:42`                 |
| 4-5 | `cloud-sessions`      | `session_before_switch`(resume)、`session_start`(resume/startup) 的 cwd 不匹配 | `custom`              | `:251`、`:300+`       |
| 6   | `goal`                | `agent_end`（上一轮被 abort）                                                  | `ctx.ui.confirm`      | `:679`                |
| 7   | `loop`                | `agent_end`（上一轮被 abort）                                                  | `ctx.ui.confirm`      | `:432-433`            |
| 8   | `todos`               | 工具内抢过期锁                                                                 | `ctx.ui.confirm`      | `storage.ts:638`      |
| 9   | `permission-gate`     | `tool_call` 危险命令                                                           | `custom`（确认树）    | `confirm-tree.ts:573` |
| 10  | `questionnaire`       | 工具调用（单问题走 selector；多问题/多选走 `custom`）                          | `showSelect`/`custom` | `:270`、`:343`        |
| 11  | `pi-rewind`           | `session_before_fork`（`restoreOnFork` 默认 `ask` 且有检查点文件变更）         | `ctx.ui.select`       | `:245-249`            |

**不纳入**（B 类）：所有经由扩展命令 / 面板打开的对话框——33 处 `ctx.ui.*` 直调 + 4 处直接 `custom`

- 7 处 selector，分布 15 个插件。理由：

1. 桥侧命令穿透默认关闭（`wechatbot/src/settings.ts:39-41`：`user.commands[id] ?? "off"`），
   用户**显式加白名单即表示接受该命令的交互成本**；
2. 不采用 monkey-patch 共享 `ctx.ui` 的方案：篡改 pi 内部对象会让「模式生效」变成全进程隐式行为，
   与 D4「许可必须显式、可事后证明」冲突；
3. 上游若在 `wrapUIPromptContext`（`runner.js:359-368`，唯一 choke point）开前置拦截钩子，可一次覆盖
   B 类，届时无需本地补丁。

需要澄清一处实现层面的推论：B 类里**走 selector** 的调用点（如 `preset` 的 4 处）在 armed 下会被 D5 的闸门
**顺带跳过**——它们没有声明 `unattendedDefault`，因此按取消处理（命令不执行，日志 `skip-no-default`）。
这不算「纳入」：没有专门改造、也不会自动放行；但意味着这些命令在远端模式下会「静默不执行」。
真正仍会**挂起**的是 B 类里**不经 selector** 的 `ctx.ui.*` 调用（`input` / `editor` / 直接 `confirm`）。

### D7 落地范围：A 类 11 处全部纳入，统一用「在场判定」

`#1 #2 #3` 都经 `showSelect` → **由 D5 免费覆盖**。`#10` 只有单问题路径经 `showSelect`，
多问题/多选走 `ctx.ui.custom`（不经 selector）→ 必须在 `execute` 顶部自己判在场，否则仍会挂起。
其余 6 处（`#4`–`#8`、`#11`）改法统一：把 `ctx.hasUI` 换成**在场判定**

```ts
const isAttended = (ctx: ExtensionContext) => ctx.hasUI && !isArmed();
```

并**复用各插件已有的 `!ctx.hasUI` 降级分支**（`goal` 自动暂停 / `loop` 跳过 / `todos` 返回 error /
`cloud-sessions` 跳过修复），不新写分支。

理由：`#6`/`#7`/`#8` 由 **agent 自主调用工具或 `agent_end` 事件**触发，用户无法提前预判；`#4`/`#5`
由 `/resume` 触发。漏任一处，微信日常对话中都会「永久挂起」；而这些处已有经测试的降级路径，点亮它近乎零成本。

## 后果

- 新增术语：**可询问拦截**（危险分级、切换/分叉确认、工具内提问 → 受远端模式影响）与
  **硬拦截**（`protected-paths` / `secret-firewall` / sandbox → 不受影响，不问不等；`protected-paths.ts:30`
  直接 block）。
- 闸门状态挂 `globalThis`（`__piUnattendedState`），不放模块闭包：同一进程内即使 selector 被解析成两个模块实例
  （复制而非软链的部署形态），`arm()` 与 `isArmed()` 也共享同一份状态，不会静默失效。
- 弱桥接 `__confirmGateApi` 在**扩展工厂期**安装（不是 `session_start`）：通道插件的 `session_start`
  可能早于 selector 的（handler 按加载顺序执行、pi 不排序），否则通道会读到 `undefined` 并按 D4「不 arm」
  静默放弃——与 `arm()` 回读 flag 那条修复同源。
- 远端模式下 `critical` 级动作可被自动放行，**与「critical 只存 session」的既有设计倾向相反**：
  本 ADR 以「显式许可 + 生效可回退 + cwd 限定 + 全量审计」四条同时成立为交换条件。
- 被 `.gitignore` 排除的工作区目录（`tmp/`、`.scratch/`）**不在 pi-rewind 快照内**
  （`pi-rewind/README.md:52`、ADR-0038「范围边界」）→ cwd 内的删除并非处处可回滚，此为明示代价。
- 其中 `.git` / `.pi` 与 cwd 根本身被 D2 第 3 条**排除在豁免之外**：它们是唯一「连快照都没有」的目标
  （`repo-manager.ts` 的 `AUTO_EXCLUDE_SCAN_ALWAYS_PRUNE_DIRS` 恒剔除），一旦删掉无法回滚。
- 文案维度从一层变两层：`note` =「为什么危险」、`remedy` =「怎样合理操作」，同源落在
  `permission-gate/notes.ts`，确认树（给人看）与 block reason（给模型看）共用，避免措辞漂移。
- **明示残余风险**：B 类命令一旦被加入桥侧白名单，远端触发时仍会挂起（有日志可查，可随时从白名单移除）。
- 桥侧仍需处理 `newSession()` 返回的 `{cancelled}`。

## 验证

#### 单元（vitest）

- selector 闸门三态：非 armed → 弹；armed + `unattendedDefault` → 不弹、返回该值、日志 `skip-with-default`；
  armed + 无默认 → 返回 null、日志 `skip-no-default`。`showConfirm` 的 `true`/`false` 两条路径。
- permission-gate 豁免判定（表驱动）：cwd 内 `rm -rf .scratch/tmp` ✅；cwd 外 ❌；`$VAR` ❌；`cd X && rm` ❌；
  `git push --force` ❌；`sudo …` ❌。命中时断言审计 `allowed-unattended` 且保留 tier/reasons；
  不豁免时断言 `block.reason` 同时含 `note` 与 `remedy`。
  解析信息不完整（`$VAR` / `$(cmd)` / `` `cmd` `` / `a$b` / `FOO=1` / `>(cat)` 混入字面目标、
  `( … ) > path` / `{ …; } > path` 的写重定向）→ `deny('unresolvable-target')`，由
  `unattended-exempt.test.ts` + `bash-parser.test.ts` 双向覆盖（解析层交出缺口、判定层拒绝）。
- 在场判定：`isAttended({hasUI:true})` 在 armed 下为 false；`confirm-destructive` / `dirty-repo-guard`
  两个 guard 走真实事件处理器断言「armed 不弹框且放行、未 armed 仍弹框」。
  `goal`/`loop`/`todos`/`cloud-sessions`/`pi-rewind` 五处是同一行 `ctx.hasUI` → `isAttended` 替换，
  由 `isAttended` 单测 + 上述两个走真实 handler 的用例覆盖；各自的事件处理器依赖较重（git/压缩/会话树），
  未单独立用例。
- 用户自加 `pattern` → `deny('user-pattern')`；`rm -rf .` / `.git` / `.pi`（含**嵌套** `packages/sub/.git`、
  `sub/.pi`）→ `deny('cwd-root')` / `deny('protected-internal')`；`.github`、`docs/.gitignore-notes` 不受误伤；
  白名单外分类（未来新增）→ `deny('privileged-hit')`。fd 复制（`2>&1` / `>&-`）不算写重定向，不进 `targets`。
- `questionnaire` 多问题/多选在 armed 下不进入 `ctx.ui.custom`，直接返回 `cancelled`。
- `arm`/`disarm` 引用计数：两个 owner 时 disarm 一个仍 armed；**同一 owner 重复 `arm()` 各自计数**
  （`arm()` 返回的解除函数只释放自己那一次、可重复调用）；`/unattended disarm` 直接清空全部占用；
  无许可时 `arm()` 返回 `undefined`。

#### e2e（真实 pi + mock-llm，≤300s/插件，仅 mock LLM）

- 测试辅助扩展模拟通道：`session_start` 调 `arm(...)`（`unattended/` 用 `/unattended arm`，
  permission-gate 用 `helpers/arm-channel.ts` 的 `arm('e2e-channel')`）。
- 正向：`/new` → 会话已替换、TUI 输出**无** `Clear session` 确认框、日志有 `skip-with-default`
  与状态栏 `| unattended`。
- 反向：未带 flag / 未 arm 时 `/new` → 仍出现 `Clear session` 确认框（TUI 用例）。
- permission-gate：`rm -rf .scratch/tmp` → 命令真的执行 + 审计 `decision=allowed-unattended`
  （保留 tier/reasons）；`rm -rf /tmp/<cwd 外>` → 目标仍在（拒绝真的生效）+ 审计
  `decision=deny` & `denyCause=unattended` + 日志 `Unattended deny (outside-cwd)`。
  另有四条回归：引号包裹的越界目标（`unresolvable-target`）、字面目标混入 `$VAR`（`unresolvable-target`）、
  路径限定 `./rm`（`path-qualified-op`）、嵌套 `.git`（`protected-internal`）。

**当前状态**（2026-10-27）：

- `unattended` 模块 e2e：`/new` 正向 + 反向两条绿（2 PASS / 27s）。
- `permission-gate` 模块 e2e：`smoke.test.sh` 的「unattended:」六条绿（6 PASS，真实 `arm()` + 真实审计落盘）。
- vitest：判定表（`unattended-exempt.test.ts`）+ 走真实 `tool_call` handler 的集成用例
  （`permission-gate-unattended.test.ts`：审计 `allowed-unattended` / `deny`+`unattended`、
  `block.reason` 同时含 note 与 remedy、未 armed 时行为不变）。

**已发现并修复的实现约束（来自 e2e 首跑失败）**：闸门状态必须挂在 `globalThis`，不能放模块闭包。
部署形态（或 e2e 沙箱）可能让「扩展入口」与 `node_modules/@zenone/pi-selector` 解析到不同 realpath，
模块级状态会分裂成两份 → `arm()` 之后 `isArmed()` 仍为 false，模式**静默失效**。修复前 e2e 首跑即复现。

**另一条同类约束（permission-gate e2e 发现）**：`pi.getFlag()` 在扩展**加载期**还拿不到 argv 真值
（argv 解析晚于扩展加载，但早于 `session_start`）。因此「工厂期读一次许可」不足以覆盖
「channel 的 `session_start` 早于 selector 的 `session_start`」（handler 按加载顺序执行，pi 不排序）——
此时 `arm()` 会被误判为未授权。修复：`arm()` 拿持有 `pi` 实例的闸门状态**回读** flag 再判定。

#### 人工 UAT

- 微信 `/new`、`stop`（有活动 goal 时）、跨机 `resume` 三条路径各一次：无弹框、日志可查。

## 相关文档

- `extensions/security/permission-gate/README.md`「远端豁免模式」节（消费者视角）
- `extensions/meta/selector/README.md`（D5 语义与 API）
- `CONTEXT.md`「permission-gate 权限门禁」表（新增 5 个术语）
- wechatbot 仓库 `pi-agent/docs/adr/`：桥侧实现与命令面（**本轮不动**，属另一仓库）
