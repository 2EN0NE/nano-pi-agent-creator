# 离线部署：把 pi + 本仓库插件体系带到无网 Linux

一条命令打包、一条命令安装。目标机：**无网络、无 sudo、2019 年前后的 Linux x64**。
决策与取舍见 [`ADR-0069`](adr/0069-offline-bundle-source-install-and-degradation.md)；
术语见 [`CONTEXT.md`](../CONTEXT.md)「离线部署（offline bundle）」。

---

## 1. 源机：打包（需要联网）

```bash
bash scripts/offline.sh pack --arch x64
```

产物在 `tmp/offline/`：

| 文件                                  | 作用                                                               | 必需     |
| ------------------------------------- | ------------------------------------------------------------------ | -------- |
| `pi-offline-<版本>-x64.tar.gz`        | 全部内容（运行时 / 仓库源码 / 第三方插件 / 原生包 / rg+fd / 配置） | 是       |
| `pi-offline-<版本>-x64.tar.gz.sha256` | 传输完整性校验                                                     | 强烈建议 |
| `install.sh`                          | 独立的离线安装器（不依赖仓库、不依赖 npm、不依赖网络）             | 是       |
| `README-安装说明.txt`                 | 一份最小说明                                                       | 可选     |

打包做了什么：

1. 复制 **pi 运行时**（版本钉仓库 `package.json` 的 devDependency；源机版本不一致会 fail-fast）
2. 复制 **仓库源码**（`extensions/` `skills/` `themes/` `prompts/` `src/tui/`），
   并为 npm 包形态扩展补 `index.ts` 桥接（离线机不需要 `tsc`）；
   同时按扩展源码的 `@zenone/*` import 闭包补齐**纯库包**（如 `@zenone/pi-state`：不注册为扩展、只被
   `pi-config` / `permission-gate` import），否则目标机上 `@zenone` 链接会解析失败并级联拖垮安全栈
3. 复制 **依赖快照**（`~/.pi/agent/{node_modules,npm,git}`）
4. 复制 **配置**（`settings.json`、`extensions-data/`、内嵌技能、主题）
5. 下载 **linux 原生包**替换 darwin-only 依赖，并**实测每个包的 glibc 下限**
6. 下载 **rg / fd**（linux musl 静态），校验 ELF 头；`rg` 用上游发布的 `.sha256` 校验来源
   （`fd` 上游没有 per-asset 校验和 → 只记录实测 sha256；`--skip-verify` 可跳过校验，仅调试用）
7. 产出 manifest（bundle 版本、repo commit、pi 版本、逐包 glibc 下限、工具 sha256）

常用选项：

```bash
--arch arm64        # 目标机是 aarch64 时
--with-node         # 目标机没有 node 时，把 node 运行时也打进包（用 SHASUMS256.txt 校验来源）
-o DIR              # 指定产物目录（默认 tmp/offline）
--skip-verify       # 跳过下载内容的 sha256 校验（仅调试用）
```

---

## 2. 传输

把上面表格里的三个文件拷到目标机**同一目录**（U 盘 / scp / 内网均可）。
也可以先 `scp` 到目标机再 `sha256sum` 核对。

> 目标机全程不需要网络，也不需要 sudo：所有写入都在 `$HOME` 下。

---

## 3. 目标机：安装

```bash
bash install.sh pi-offline-<版本>-x64.tar.gz
```

按提示新开终端（或 `source ~/.bashrc`），然后：

```bash
pi --version     # 应为 bundle 里钉住的版本
pi               # 正常启动
```

安装到这些位置（全部在 `$HOME` 下）：

| 路径                                 | 内容                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------- |
| `~/.local/share/pi-offline/runtime/` | pi 运行时（每次升级整体替换）                                                   |
| `~/.local/bin/pi`                    | 启动器（自动注入 `PI_OFFLINE=1` 与 `PI_CODING_AGENT_DIR`＝安装时的 agent 目录） |
| `~/.pi/agent/`                       | agent 目录（扩展、技能、主题、配置、依赖）                                      |
| `~/.pi/src/tui/`                     | 扩展共享模块（相对 import 的落点，与同步工具同一约定）                          |
| `~/.bashrc`                          | 带 `# >>> pi-offline >>>` 标记的 PATH 块                                        |

### 安装器做了什么（按顺序）

1. 校验 sha256（不匹配直接拒绝，非零退出）
2. 环境检查：node ≥ 22.19、arch 是否匹配、磁盘 ≥ 3G、`$HOME` 可写、glibc 版本
3. 打印**原生包兼容性表**（哪个包在当前 glibc 下会降级）
4. 代码类（运行时 / 依赖 / 扩展 / `bin`）整体替换
5. 配置类（`extensions-data` / `settings.json` / `skills` / `themes` / `prompts`）**先备份再替换**
6. `auth.json` / `models.json` 与**历史缓存完全不读不写**
7. 加载探针：逐个 import 扩展、`require` 原生包、跑 `rg --version`/`fd --version`
8. 失败项隔离到 `~/.pi/agent/extensions-disabled/`（pi 仍能启动）

### 验收（安装器已自动做，也可人工复核）

```bash
pi --version                                   # 版本正确
cat ~/.pi/agent/load-report.json               # 看 extensionFailures / nativeFailures / disabled
cat ~/.pi/agent/installed-bundle.json          # 看装的是哪个 bundle、sha256、备份目录
ls ~/.pi/agent/extensions | wc -l              # 扩展数量
```

判定标准：

- `load-report.json` 的 `extensionFailures` 为空 → 全绿
- 非空时看 `disabled`：这些扩展**已被移出加载路径**，pi 不受影响；
  读 `reason` 判断是真坏了还是老 glibc 不兼容（**只有"入口导入失败"会自动隔离**）
- `nativeFailures` 里的项说明对应功能降级（例如 glibc 太老导致 `sharp` 不可用）——
  这类**只报告不隔离**，因为依赖方通常在运行期才 `require`，探针推不出"谁依赖它"，需人工核对
- 探针本身没跑完（安装日志里 `探针未完成`）→ 本次没有可加载性证据，`load-report.json` 不反映本次结果
- `load-report.json` 带 `runtimeError` → 探针判定**pi 运行时自身不可用**（bundle 与运行时布局不匹配，
  例如探针的 jiti 别名映射没跟上 pi 升版）。此时安装器**直接失败**（不会把扩展批量隔离——那等于静默
  下掉整个安全栈），按提示用匹配的 pi 版本重新打包。
- `installed-bundle.json` 的 `sha256` 是安装器**实测**的 bundle 哈希（与交付的 `.sha256` 一致），
  `migratedFrom: "legacy/manual"` 表示这次是把旧版 restore 布局/手工安装接管过来的

---

## 4. 升级（第二次送包）

拿新 bundle 重跑同一条命令即可：

```bash
bash install.sh pi-offline-<新版本>-x64.tar.gz
```

| 类别            | 路径                                                                                                         | 升级行为                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| 代码            | runtime、`extensions/`、`npm/`、`git/`、`node_modules/`、`bin/`                                              | 整包替换                                                                             |
| 配置            | `extensions-data/`、`settings.json`、`skills/`、`themes/`、`prompts/`                                        | 备份到 `~/.pi/agent/.config-backup-<时间戳>/` 后替换                                 |
| 凭据/模型       | `auth.json`、`models.json`                                                                                   | **完全保留**（仅首次安装且不存在时写占位）                                           |
| 历史/缓存       | `sessions/`、`state/`、`rewind/`、`ayu/`、`chat/`、`compact-backups/`、`fff/`、`cache/`、`web-search-cache/` | **不读不写**                                                                         |
| 已下架扩展      | 上次安装记录里有、新包里没有                                                                                 | 移到 `extensions-disabled/<name>.removed-<时间戳>`（不删除）                         |
| 已下架技能/主题 | 上次安装记录里有、新包里没有                                                                                 | 直接删除——但**前提是本次已成功备份**，所以一定能在 `.config-backup-<时间戳>/` 里捞回 |

- 想保留老配置 → 从备份目录捞；或直接回填：
    ```bash
    bash install.sh --restore-config <时间戳>
    ```
- 想跳过备份强制替换 → `--overwrite-config`
- 回退到上一版 → 拿上一版 bundle 重跑安装（`installed-bundle.json` 记着版本与 sha256）

---

## 4b. 从旧版迁移（0.7x / 旧 `restore` 布局）

2026-10 之前的 `offline.sh restore` 把运行时放在 `~/.local/share/pi-runtime`，用 `~/.local/bin/pi` 软链启动，
并在 `~/.pi/agent` 落一份快照。这样的机器**没有** `installed-bundle.json`，但**有**真实在用的配置。
新安装器把它识别为**迁移安装**（不是"全新安装"），因此：

| 项目                                                                          | 行为                                                                                                                                                    |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 配置（`settings.json` / `extensions-data` / `skills` / `themes` / `prompts`） | **先备份**到 `~/.pi/agent/.config-backup-<时间戳>/` 再替换；`installed-bundle.json` 记 `migratedFrom: legacy/manual`                                    |
| `~/.local/bin/pi`                                                             | 先移除旧软链再写新启动器（旧布局是软链，直接写会写穿到旧运行时里）                                                                                      |
| `~/.pi/agent/extensions/` 里的旧扩展                                          | **默认保留**，安装日志逐个列出"不属本包提供"的名字；确认不要了再加 `--prune-unknown-extensions` 移入 `extensions-disabled/`（不删除）                   |
| 旧运行时 `~/.local/share/pi-runtime/`                                         | 默认保留并提示体积；`--remove-legacy-runtime` 删除它，并**一并摘掉** `~/.local/bin` 下指向它的 `node`/`npm` 软链（否则会留下"能找到但执行失败"的 node） |
| 旧的第三方插件（`npm/` `git/` `node_modules/`）                               | 按 D8 整包替换；旧插件不在备份范围，需要保留请先在旧机器上自行备份                                                                                      |

推荐流程（先看清楚再动手）：

```bash
bash install.sh pi-offline-<版本>-x64.tar.gz --dry-run     # 只看计划：会备份什么、有多少旧扩展、旧运行时多大
bash install.sh pi-offline-<版本>-x64.tar.gz               # 正式迁移（配置已自动备份）
# 确认旧扩展/旧运行时都不要了：
bash install.sh pi-offline-<版本>-x64.tar.gz --prune-unknown-extensions --remove-legacy-runtime
```

> 迁移后 `pi --version` 必须等于 bundle 里钉的版本；若目标机 `~/.local/bin/node` 曾指向旧运行时，
> 加 `--remove-legacy-runtime` 会一并清理，避免残留悬空软链。

---

## 5. 模型接入（离线机自己配）

首次安装会写 `~/.pi/agent/models.json` 占位（Ollama 模板），升级**不会覆盖它**。

```jsonc
{
	"$schema": "https://pi.dev/schemas/models.schema.json",
	"providers": {
		"ollama": {
			"baseUrl": "http://localhost:11434/v1",
			"api": "openai-completions",
			"apiKey": "ollama",
			"models": [{ "id": "qwen2.5-coder:7b" }],
		},
	},
}
```

- 同机部署了 Ollama / vLLM / 内网 OpenAI 兼容端点 → 改 `baseUrl` 即可
- 需要凭据的端点 → 用 `pi` 里的 `/login`，或设置对应环境变量；`auth.json` 从不进 bundle
- **bundle 不带模型权重**：模型文件体积与推理硬件是另一件事

---

## 6. 老 glibc：会降级什么

`pack` 会实测每个原生包的 glibc 下限并写进 manifest，安装时打印对照表。
本仓库当前实测（2026-10，linux x64）：

| 包                        | 要求          | 用途               | glibc 2.17（CentOS 7）     | glibc 2.27（Ubuntu 18.04） |
| ------------------------- | ------------- | ------------------ | -------------------------- | -------------------------- |
| `@yuuang/ffi-rs`          | ≥ 2.14        | pi-lens 等         | OK                         | OK                         |
| `@ast-grep/napi`          | ≥ 2.14        | pi-lens 结构化搜索 | OK                         | OK                         |
| `@mariozechner/clipboard` | ≥ 2.14        | 剪贴板             | OK                         | OK                         |
| `@img/sharp`              | ≥ 2.17        | 图像处理           | OK                         | OK                         |
| `@img/sharp-libvips`      | ≥ 2.25        | 图像处理           | 降级                       | OK                         |
| `@ff-labs/fff-bin`        | ≥ 2.30        | pi-fff 搜索        | 降级                       | 降级                       |
| `@ast-grep/cli`           | ≥ 2.34        | pi-lens CLI 模式   | 降级                       | 降级                       |
| `@amaster.ai/...ffmpeg`   | ≥ 2.35        | 视频生成           | 降级                       | 降级                       |
| `@typescript/typescript`  | 静态链接      | TS 原生工具        | OK                         | OK                         |
| `rg` / `fd`               | musl 静态     | grep/find 工具     | OK                         | OK                         |
| `node-pty`                | 需 Linux 编译 | plannotator 终端   | 取决于打包时是否编出预编译 | 同左                       |

「降级」= 该原生包 `require` 失败（`load-report.json` 的 `nativeFailures`），安装器**如实报告但不自动隔离**：
依赖它的插件可能在运行期才 `require`，探针无法可靠推断"谁依赖谁"。**其余插件正常工作**不受影响，
这也是 ADR-0069 D6 的硬要求：单项失败绝不拖垮 pi（自动隔离只针对"扩展入口导入失败"）。

> `node-pty` 上游没有提供 linux 预编译。pack 只在本机**已有** `node:22-bookworm-slim`
> 镜像时才在容器里编译出 N-API 二进制；否则标记为预期降级。

---

## 7. 排障

| 现象                                    | 原因                                             | 处理                                                               |
| --------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------ |
| `sha256 不匹配`                         | 传输损坏 / 不是同一批产物                        | 重新拷贝 tar.gz 与 `.sha256`                                       |
| `node 版本过低`                         | 目标机 node < 22.19                              | 升级 node；或打包时 `--with-node` + 安装加 `--use-bundled-node`    |
| `bundle 架构 x64 与本机 arm64 不一致`   | 打错架构                                         | 用 `--arch <本机>` 重打                                            |
| `command not found: pi`                 | PATH 没生效                                      | 新开终端，或 `source ~/.bashrc`；标记块在 `~/.bashrc`              |
| `Failed to load extension` 在 pi 日志里 | 该扩展已被隔离但仍被引用                         | 看 `load-report.json` 的 `disabled` 与 `reason`                    |
| 某个插件功能缺失                        | 原生包 glibc 不兼容                              | 看安装时的兼容性表 / `nativeFailures`                              |
| 安装过程中断                            | 磁盘不足（解包峰值 ~2.5G）                       | 清理后重跑；`--prefix` 指向更大分区                                |
| 安装日志提示"旧运行时目录仍在"          | 机器此前用旧版 restore 装过                      | 确认不再需要后加 `--remove-legacy-runtime`（顺带摘掉指向它的软链） |
| 安装日志列出"不属本包提供的扩展"        | 旧版本遗留的扩展名                               | 看 `load-report.json`；确认不要了加 `--prune-unknown-extensions`   |
| `node` 能找到但执行报错                 | `~/.local/bin/node` 是指向已删旧运行时的悬空软链 | `rm ~/.local/bin/node`，或重跑安装加 `--remove-legacy-runtime`     |

所有安装动作都留痕：

```bash
ls -t ~/.pi/agent/logs/offline-install-*.log | head -1   # 安装日志
node -p "require('$HOME/.pi/agent/load-report.json')"    # 加载报告
node -p "require('$HOME/.pi/agent/installed-bundle.json')" # 装的是哪个包
```

---

## 8. 目标机仿真（在源机上预演）

```bash
bash scripts/offline/e2e.sh                                  # 打包(local)+ 本机完整流程
bash scripts/offline/e2e.sh --bundle tmp/offline/xxx.tar.gz   # 针对已有包
```

覆盖内容（当前 58 条断言；本机全流程约 4~5 分钟——大头是复制 1.4G 依赖快照）：

- **全新安装**：探针 0 失败、`@zenone/*` 链接指向安装目录、`.bashrc` 标记块幂等
- **升级安装**：`models.json`/`auth.json` 字节不变、`sessions` 未被触碰、配置进备份、
  下架扩展进 `extensions-disabled/`、下架技能剪枝且**备份里能捞回**
- **陈旧报告**：预置一份"上次失败"的 `load-report.json`，断言本次不被它驱动（不误隔离扩展）
- **`--dry-run`**：退出码 0 且不写 `settings.json` / 启动器
- **sha256 不匹配**：安装必须失败，且失败原因明确
- **迁移（旧 restore 布局 / 0.7x）**：预置 `~/.local/share/pi-runtime` + 软链启动器 + 旧配置 + 旧扩展 →
  断言配置进备份、`settings.json` 被替换、`migratedFrom` 落库、启动器由软链变普通文件、
  默认保留旧扩展；再跑 `--prune-unknown-extensions --remove-legacy-runtime` 断言剪枝与清理
- **`--restore-config`**：回填后用户改动恢复
- **linux 包**：结构验证（在 macOS 上装 linux 包，`--no-probe`）——断言
  `*-darwin-*` 目录清零、linux 原生包落位、`rg`/`fd` 是 ELF、日志含 glibc 预检

> e2e 需要在本机复制/打包约 1.4G 的依赖快照。**CI 已纳入**（`offline-e2e` job，`--arch local`，无需网络，
> 最小 agent 目录约 90s；本机默认 4~5 分钟）：改动 `scripts/offline*` 后必须跑通它再交付
> （本机 `bash scripts/offline/e2e.sh` 等价）。
> 空间紧张时用 `PI_OFFLINE_E2E_WORK=<绝对路径>` 把沙箱搬到大盘（脚本会 `rm -rf` 该目录，故拒绝 `/`、
> `$HOME`、仓库根，以及它们的**祖先目录**；目录非空时会先打印将要清空的路径）；失败时沙箱保留并打印清理命令。

真实容器验证（需要能拉镜像）：

```bash
docker run --rm -it -v "$PWD/tmp/offline:/bundle:ro" -v "$PWD/tmp/home:/home/u" \
  -e HOME=/home/u node:22-bullseye bash -lc '
    cd /bundle && bash install.sh pi-offline-*-x64.tar.gz && /home/u/.local/bin/pi --version'
```

> 本机实测环境（macOS arm64）无法拉取镜像，因此 e2e 默认只跑到结构验证；
> 真实 ELF 执行结果以目标机 `load-report.json` 为准。

---

## 9. 已知边界

- **不含模型权重、不含 Ollama**：那是另一件事（体积与硬件）。
- **不含会话历史/回滚点**：目标是"在新机器上从配置开始用"，历史不带。
- **配置以 bundle 为准**：离线机上改的 `settings.json` / `extensions-data` 升级后会被替换
  （备份可回填）——这是用户在 grilling 中明确选择的语义（ADR-0069 D8）。
- **bundle 与源机第三方插件版本强绑定**：升级插件版本必须重新 pack。
- **`--arch local`** 是给源机自测用的，不是交付物。
