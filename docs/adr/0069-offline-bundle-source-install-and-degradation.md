# ADR-0069: 离线包——以仓库源码为安装源、失败隔离、配置备份式升级

- 状态：**已接受**（2026-10-27 grilling 收敛）
- 相关组件：`scripts/offline.sh`（pack）、`scripts/offline/install.sh`（随包分发的独立安装器）、`scripts/offline/probe.mjs`（加载探针）
- 术语：见 `CONTEXT.md`「离线部署（offline bundle）」节

## 背景

把 pi 运行时 + 本仓库插件体系（扩展/技能/主题/提示）+ 第三方 npm/git 插件带到**完全离线、无 sudo、2019 年前后的 Linux** 上使用。

现有 `scripts/offline.sh` 的三处事实性缺陷（实测）：

1. **运行时定位失效**：`pack` 从 `pi` 可执行文件向上找 `package.json` 来定位运行时。pi 1.4 的 managed install 布局是
   `~/.pi/agent/bin/pi`（sh 启动器）→ `~/.pi/agent/install/releases/<ver>/`，而 `~/.pi/agent/package.json` 恰好存在，
   于是被解析成 `~/.pi/agent` 整个 3.2G 目录，而非 148M 的运行时。安装后的 wrapper 指向不存在的 `dist/bundle/cli.js`。
2. **工具二进制缺口**：`pack` 排除了 `agent/bin`（macOS 的 rg/fd），而 pi 的 `ensureTool()` 在 `PI_OFFLINE=1` 时**直接跳过下载**，
   离线机 `grep`/`find` 工具不可用。原始需求提到的 `--ignore-scripts` + `npm install` 方案也不覆盖这一点。
3. **安装器不自举**：`restore` 逻辑住在仓库里，离线机若没带仓库源码就无法执行 restore——而"带仓库"又是可选项。

另有两个由使用场景带来的硬约束：目标机**无超管权限**（只能用户态安装）；需要**持续更新**（每次用 U 盘送新包），
而更新绝不能冲掉离线机上的会话历史、凭据与模型配置。

## 决策

### D1 安装源 = 仓库源码，而不是 agent 目录快照

`pack` 收集 `extensions/`、`skills/`、`themes/`、`prompts/` 的**仓库源码**；安装器把它们落地到 `~/.pi/agent`。
不把 `~/.pi/agent/extensions` 整目录当交付物（那是同步产物，含大量可重建内容）。

依据：pi 的扩展加载器在 `pi.extensions` 声明的 `dist/*.js` 缺失时会**回退到同目录 `index.ts`**（`loader.js` 实测），
所以包形态扩展（`secret-firewall`/`cloud-sessions`/`recap`/`_widget-wrangler`…）无需在离线机构建 `dist`。

### D2 pi 运行时钉仓库 devDependency 版本

`pack` 读仓库 `package.json` 的 `@earendil-works/pi-coding-agent` 版本作为期望值，校验源机
`~/.pi/agent/install/current-version` 与 `install/releases/<ver>/dist/bundle/cli.js` 存在；不一致**fail-fast**。

### D3 交付物 = tar.gz + 独立 install.sh（不用自解压单文件）

三个文件：`pi-offline-<版本>-<arch>.tar.gz`、`.sha256`、`install.sh`。安装命令
`bash install.sh pi-offline-<版本>-<arch>.tar.gz`。选择普通 tar.gz 而非 `cat` 拼接的自解压壳：逻辑可读、可单独调试、
出错时用户能直接 `tar -tzf` 检查。

### D4 全用户态安装

安装位置：运行时 `~/.local/share/pi-offline/runtime/`，agent `~/.pi/agent/`，可执行入口 `~/.local/bin/pi`。
安装器在 `~/.bashrc` 维护**带标记的 PATH 块**（幂等替换，不重复追加）——2019 年发行版默认 PATH 通常不含 `~/.local/bin`。

### D5 第三方插件全带，原生包"换血"

`~/.pi/agent/npm`、`~/.pi/agent/git`、`~/.pi/agent/node_modules` 随包；其中 darwin-only 原生包在 pack 时下载
对应 linux 变体（ast-grep、ffi-rs、fff-bin、sharp+libvips、video-gen ffmpeg、typescript native），安装时替换。
`node-pty` 若包内无 linux 预编译则**不重建**，由探针判定相关插件降级。

### D6 失败隔离：逐项探针 + 自动禁用

安装后运行 `probe.mjs`：用运行时自带的 jiti 逐个导入扩展入口（每个子进程 + 超时），直接 `require` 各原生包，
spawn `rg --version` / `fd --version`。失败项写入 `load-report.json`，对应扩展目录移入
`~/.pi/agent/extensions-disabled/`，并在结尾打印汇总表。**任何单项失败都不得让 pi 无法启动。**

例外（2026-10 修订）：探针在跑扩展前先做**运行时预检**（`piAliases` 的 jiti 别名映射 + jiti 本身能否解析）。
预检失败意味着**每个**扩展都会失败——那不是"某个扩展坏了"，隔离它们等于静默把整个安全栈下掉。
此时探针以**退出码 2** 上报 `runtimeError`，安装器 `die`：要么修探针映射，要么用匹配的 pi 版本重打包。
同一个预检在 pack 侧以 `probe.mjs --preflight` 复用，源机上就能拦住 pi 布局漂移。

### D7 模型配置只给占位

`models.json` / `auth.json` 在**首次安装且文件不存在**时写入占位模板；之后升级**完全不读不写**（含备份），
避免把密钥复制进备份目录，也避免升级冲掉离线机已配好的模型。

### D8 升级 = 代码替换 + 配置备份后替换

| 类别      | 路径                                                                                                         | 升级行为                                            |
| --------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| 代码      | runtime、`extensions/`、`npm/`、`git/`、`node_modules/`、`bin/`                                              | 整包替换                                            |
| 配置      | `extensions-data/`、`settings.json`、`skills/`、`themes/`、`prompts/`                                        | 先备份到 `~/.pi/agent/.config-backup-<ts>/`，再替换 |
| 凭据/模型 | `auth.json`、`models.json`                                                                                   | 完全保留                                            |
| 历史/缓存 | `sessions/`、`state/`、`rewind/`、`ayu/`、`chat/`、`compact-backups/`、`fff/`、`cache/`、`web-search-cache/` | 不读不写                                            |

`--overwrite-config` 跳过备份直接替换；`--restore-config <ts>` 从备份回填。

### D9 回退 = 清单 + 配置备份，不常驻代码副本

`~/.pi/agent/installed-bundle.json` 记录 bundle 版本、repo commit、pi 版本、arch、构建时间、sha256、安装时间。
回退方式：拿上一个 bundle 重跑 `install.sh`。不为"一键回退"常驻 1G+ 代码副本（老机器磁盘紧张）。

### D10 历史与依赖都不进包

`sessions/`（1.0G）、`state/`、`rewind/`（103M）、`ayu/`（35M）与各类缓存不打包。配置与依赖合计约 1.1–1.4G。

### D11 目标架构单架构，默认 x64

`--arch x64|arm64` 显式指定；原生包只下载对应架构。

### D12 老 glibc 的已知边界

glibc 下限**不靠猜测，靠实测**：pack 阶段扫描每个预编译产物里出现的最高 `GLIBC_x.y` 符号需求，
写进 manifest，安装器按目标机 glibc 打印兼容性对照表。2026-10 在 linux x64 上实测：

| 产物                                                            | 实测下限 |
| --------------------------------------------------------------- | -------- |
| `@yuuang/ffi-rs` / `@ast-grep/napi` / `@mariozechner/clipboard` | 2.14     |
| `@img/sharp`                                                    | 2.17     |
| `@img/sharp-libvips`                                            | 2.25     |
| `@ff-labs/fff-bin`（`libfff_c.so`）                             | 2.30     |
| `@ast-grep/cli`（独立可执行）                                   | 2.34     |
| `@amaster.ai/pi-video-gen-ffmpeg`（ffmpeg/ffprobe）             | 2.35     |
| `@typescript/typescript`（`tsc`）                               | 静态链接 |
| `rg` / `fd`（musl 目标）                                        | 静态     |

注意官方 Node 22 二进制要求 glibc ≥ 2.28——目标机"已有 node ≥ 22.19"本身就隐含了这个下限
（若用 unofficial glibc-217 构建则例外）。glibc 更老的机器上，相关插件按 D6 降级为不可用，
而不是整体失败；安装器只做**如实告知**，不猜测、不中断。

### D13 探针与安装过程必须留痕

安装日志落 `~/.pi/agent/logs/offline-install-<ts>.log`；探针报告落 `load-report.json`；
`load-report.json` 与 `installed-bundle.json` 是排障与验收的唯一事实来源（不靠屏幕输出回忆）。

## 考虑过的选项

- **npm install + `--ignore-scripts` 打成可移植 node_modules**（原始需求里的建议）：需要目标机有 npm 与 registry，且
  npm 的 optionalDependencies 会按**源机平台**解析；跨 macOS→Linux 不可用。已由 D5 的显式换血替代。
- **自解压 `.run` 单文件**：少一个文件，但 sha 校验与解包逻辑耦合在同一个脚本里，出错难排查。按 D3 放弃。
- **常驻上一版代码副本做 `--rollback`**：体验最好，但老机器磁盘与"无 sudo"场景下代价过高。按 D9 放弃。
- **只增不覆盖的配置合并**：最"安全"，但插件默认配置的修正永远进不来；用户明确选择"备份 + 替换"。按 D8。

## 后果

- 离线机上的配置修改在升级后**不再生效**（仍在备份目录里），升级后需要检查 `.config-backup-<ts>/`；
  这是 D8 的自觉代价。
- 离线机必须能运行 Node ≥ 22.19；不满足时安装器只报告，不尝试自带 node（`--with-node` 作为显式选项保留）。
- 第三方插件的原生依赖是主要不确定性来源；每次 pack 都必须重新下载 linux 变体，因此 **pack 需要联网**，
  且 bundle 的可用性与源机当时安装的第三方插件版本强绑定（记录在 manifest 中）。

## 修订（2026-10-27，code review 后）

首次实现落地后审查暴露了 5 处"语义是好的、实现没做到"，逐条修正（结论不变，只把契约钉死）：

- **D8 备份判据改为"目标侧有没有配置"，不再看 `installed-bundle.json`**。旧版 `restore` 布局的机器
  （以及手工装过 pi 的机器）本来就没有这个文件，按旧判据会走"全新安装"分支：`settings.json` /
  `extensions-data` 被直接覆盖且**不留备份**——对"0.7x 老机器升级"这条主路径来说是不可逆的配置丢失。
  现在只要 `settings.json` / `extensions-data` / `skills` / `themes` / `prompts` 任一存在就备份，
  并在 `installed-bundle.json` 记 `migratedFrom: "legacy/manual"`。
- **新增迁移语义（`--prune-unknown-extensions` / `--remove-legacy-runtime`）**：旧版 restore 把运行时放在
  `~/.local/share/pi-runtime`，并在 `~/.local/bin` 里留 `pi`/`node` 软链。安装器现在
  ①写启动器前先 `rm -f` 目标（否则 `cat >` 会**写穿软链**，把 wrapper 内容写进旧运行时、软链却仍指向旧运行时）；
  ②报告"不属本包提供"的旧扩展名，显式加参数才移入 `extensions-disabled/`（不删除）；
  ③`--remove-legacy-runtime` 删旧运行时，并一并摘掉 `$BIN_DIR` 下指向它的软链（否则删完留下悬空的 `node`，
  PATH 里"能找到但执行失败"）。
- **D9 的 sha256 只能由安装器实测写入**。tarball 的 sha256 不可能写进**包内** `manifest.json`（tar 已封口），
  原实现"打包后再写 manifest"永远进不了交付物，`installed-bundle.json.sha256` 恒为 `null`。
  现在 pack 只产出 `<tarball>.sha256` sidecar，安装器实测后把值记进 `installed-bundle.json`；
  没有 sidecar 时改为**大声警告**（记录实测值供追溯），不再假装"硬门禁"。
- **技能/主题也剪枝**（原来只有扩展剪枝）。与扩展的区别：技能/主题属于配置类，剪枝以"本次已成功备份"为前提，
  被删项一定能从 `.config-backup-<ts>/` 捞回。
- **D6 的措辞收窄到实现真实行为**：自动隔离只覆盖**扩展入口导入失败**；原生包失败（`nativeFailures`）只**报告**，
  不推断"依赖它的插件"，因为它们通常在运行期才 `require`。安装总结会显式提示这一点。
- **下载内容加来源校验**：`rg` 用上游 `<asset>.sha256`、`node` 用 `SHASUMS256.txt`（`--skip-verify` 仅调试用）。
  镜像站（ghproxy/ghfast）只保证"下载得到"，不保证"与上游发布的一致"；`fd` 上游没有 per-asset 校验和，
  改为把实测 sha256 记进 manifest 供追溯。
- **探针报告不再跨安装复用**：探针前 `rm -f load-report.json`，且只有本次探针成功才读它做隔离，
  避免"探针崩了 → 拿上次的失败清单再禁用一遍扩展"。
- **缺 node 时前置快速失败**：manifest 解析依赖 node，原来 node 缺失会表现为"bundle 架构与本机不一致"的误导性报错。
