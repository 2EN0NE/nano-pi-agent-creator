# Sync Tool 参考文档

`sync-to-local-pi` 是一个配置驱动的资源同步工具，将本项目的扩展、技能、主题、提示同步到 Pi 代理目录。

## 安装

```bash
# 在工程根目录安装依赖
npm install
```

## 用法

### Profile 模式（配置文件驱动）

通过 YAML 配置文件定义 Profile，按场景同步不同组合：

```bash
# 使用默认 Profile（配置文件中第一个）
npx tsx scripts/sync-to-local-pi.ts

# 指定 Profile
npx tsx scripts/sync-to-local-pi.ts --profile user-install

# 同步所有 Profile
npx tsx scripts/sync-to-local-pi.ts --all

# 使用自定义配置文件
npx tsx scripts/sync-to-local-pi.ts --profile dev-test --config ./my-config.yaml

# Dry-run 预览
npx tsx scripts/sync-to-local-pi.ts --dry-run --profile user-install
```

### 内联模式（命令行直接指定）

适用于开发中快速测试，无需编辑配置文件：

```bash
# 同步单个扩展
npx tsx scripts/sync-to-local-pi.ts --ext sandbox --target ./.pi/test

# 同步多个扩展 + 主题
npx tsx scripts/sync-to-local-pi.ts --ext sandbox --ext pi-logger --theme nightowl --target ./.pi/test

# 同步技能
npx tsx scripts/sync-to-local-pi.ts --skill my-skill --target ./.pi/test

# 同步到用户目录
npx tsx scripts/sync-to-local-pi.ts --ext sandbox --target ~/.pi/agent
```

## 配置文件结构

默认配置文件: `scripts/sync-profiles.yaml`

```yaml
profiles:
    my-profile:
        description: '用途描述'
        target: '~/.pi/agent' # 目标目录（支持 ~ 展开、相对路径、绝对路径）
        extensions: '*' # "*" = 全部，或 ["sandbox", "logger"]
        skills: '*' # "*" = 全部，或 ["my-skill"]
        themes: ['nightowl'] # 只同步指定的主题
        prompts: ['*'] # "*" = 全部
        exclude: # 排除列表（可选）
            extensions: ['sandbox'] # 排除需要特殊设置的扩展
```

### 资源类型与目录映射

| 资源类型   | 源目录                                                                                              | 目标子目录             | 说明                                                   |
| ---------- | --------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------ |
| extensions | `extensions/` (含 `tui/` `context/` `security/` `auto/` `accuracy/` `verification/` `meta/` 子目录) | `<target>/extensions/` | 按功能分类存放，同步脚本递归搜索所有子目录，按名字匹配 |
| skills     | `skills/`                                                                                           | `<target>/skills/`     |                                                        |
| themes     | `themes/`                                                                                           | `<target>/themes/`     |                                                        |
| prompts    | `prompts/`                                                                                          | `<target>/prompts/`    |                                                        |

> `intercepted-commands/` 目录不同步，保留原名用于独立用途。

> **扩展分类说明**：`extensions/` 下现有 7 个分类子目录，同步脚本的 `--ext <name>` 模式会自动递归搜索，用户无需关心扩展在哪个子目录下。详情见 [AGENTS.md](../AGENTS.md#扩展分类体系)。

### 配置合并规则

全局配置 `~/.pi/agent/sync-profiles.yaml` 和项目本地配置合并，项目本地优先。同名 Profile 以项目本地为准。

## 开发工作流

```
代码开发 → 内联模式同步到测试目录 → 在 Pi 中测试
    → 通过测试 → Profile 模式同步到用户目录
```

```bash
# 1. 开发时快速测试
npx tsx scripts/sync-to-local-pi.ts --ext my-extension --target ./.pi/test

# 2. 测试通过后部署到用户目录
npx tsx scripts/sync-to-local-pi.ts --profile user-install
```

## 增量同步

脚本通过比较源和目标的 mtime（修改时间）和文件大小来判断是否需要更新：

- **mtime**：只在源文件比目标文件**更新**时才复制（秒级精度）
- **文件大小**：大小不同时也会复制
- **忽略目录**：`node_modules/`、`.git/` 等生成目录不参与比较
- **SKIP**：源和目标完全一致时跳过，不执行任何写操作

## npm install 处理

当同步的扩展目录包含 `package.json` 且有 `dependencies`、`devDependencies` 或 `peerDependencies` 时，脚本自动执行 `npm install`：

1. 资源复制到目标后，检查目标路径是否存在 `package.json`
2. 如果有依赖声明，执行 `npm install`（2 分钟超时）
3. 安装结果记录到日志（成功/失败）
4. Dry-run 模式下会提示但不会实际执行

## npm 包风格扩展支持

`extensions/` 下的某些扩展具有完整的 npm 包结构（`package.json` + `src/` + `tsconfig.json`），称为 **npm 包风格扩展**。

脚本自动检测此类扩展（目录中包含 `package.json` 且含有 `pi.extensions` 字段），并在同步后：

1. 自动执行 `npm install`（安装 `devDependencies` 如 `@earendil-works/pi-tui` 等）
2. 创建 `index.ts` 桥接文件，内容为 `export { default } from "./src/index.ts";`

这个桥接文件让 Pi 的自动发现机制能正确加载扩展（Pi 要求目录形式扩展必须有 `index.ts` 入口）。

### 示例

```yaml
profiles:
    project:
        extensions: '*'
        # npmBuild 是可选的显式声明，仅用于文档目的。
        # 脚本会自动检测所有 npm 包风格扩展，无需手动列出。
        npmBuild: ['widget-wrangler', 'catch-the-fox']
```

> **注意**：桥接文件指向 `src/index.ts` 而非编译后的 `dist/index.js`，
> 因为 Pi 使用 jiti 加载 TypeScript，不需要预编译。这避免了在目标目录
> 运行 `tsc` 所需的环境依赖。

## 本地依赖处理

### 什么是本地依赖？

本地依赖是指不发布到 npm registry、仅在本地文件系统中通过 `file:` 协议引用的包。

示例：`@zenone/pi-logger`

```json
{
	"devDependencies": {
		"@zenone/pi-logger": "file:extensions/meta/pi-logger"
	}
}
```

当 `npm install` 执行时，npm 会创建一个从 `node_modules/@zenone/pi-logger` 指向 `extensions/pi-logger/` 的符号链接。

### 为什么需要特殊处理？

当扩展被同步到目标目录（如 `~/.pi/agent/extensions/sandbox/`）后，它的 `package.json` 中可能声明了需要 `@zenone/pi-logger` 等本地包。但目标目录中没有这个本地包，所以 `npm install` 会失败。

同步脚本需要做以下事情：

1. **检测**：扫描扩展的 `package.json`，识别所有 `file:` 协议的依赖
2. **映射**：将源路径（相对于项目根）转换为目标路径可解析的形式
3. **链接**：在目标目录的 `node_modules` 中创建正确的符号链接

### 策略

对于 `file:` 协议的本地依赖，当前脚本在目标目录执行 `npm install`。由于 `file:` 路径是相对于源 `package.json` 的，复制到目标后路径不匹配。可选的解决方案：

**创建符号链接（推荐）**：在目标目录的 `node_modules` 中，为每个 `file:` 协议依赖创建指向项目源目录的符号链接：

```bash
mkdir -p ~/.pi/agent/extensions/sandbox/node_modules
ln -s /path/to/project/extensions/pi-logger ~/.pi/agent/extensions/sandbox/node_modules/@zenone/pi-logger
```

**全局 npm link**：如果依赖在多个扩展间共享，也可以通过 `npm link` 注册到全局：

```bash
cd extensions/meta/pi-logger && npm link
cd ~/.pi/agent/extensions/sandbox && npm link @zenone/pi-logger
```

### 新增本地依赖时的操作指南

1. 在工程根目录 `package.json` 中声明 `file:` 依赖
2. 执行 `npm install`，验证 `node_modules/@zenone/my-new-pkg` 已正确链接
3. 在扩展中使用 `import` 引用
4. 在本文档中添加说明
5. 确保 `sync-profiles.yaml` 中不会错误排除新包
6. 验证同步：`npx tsx scripts/sync-to-local-pi.ts --dry-run --profile user-install`

### 已知的本地依赖

| 包名                  | 源路径                       | 说明                                                     |
| --------------------- | ---------------------------- | -------------------------------------------------------- |
| `@zenone/pi-logger`   | `extensions/meta/pi-logger/` | 统一日志系统，所有扩展必须接入                           |
| `@zenone/pi-selector` | `extensions/meta/selector/`  | 共享选择器，confir m-destructive、permission-gate 等使用 |

## 自动删除排除项（stale cleanup）

当 Profile 的 `exclude` 列表排除了某些资源，或 Profile 的 include 列表不再包含之前同步过的资源时，同步脚本会**自动删除**目标目录中对应的旧文件/目录，而非仅提示。

删除逻辑：

1. 扫描目标目录下每个资源类型的所有现有项目
2. 与当前 Profile 要同步的资源列表对比
3. 不在要同步列表中的项目视为 **stale**，直接删除
4. Dry-run 模式下仅显示 `[would delete]`，不实际删除

此行为适用于所有资源类型：extensions、skills、themes、prompts。

## 日志

每次同步操作追加到 `scripts/sync-to-local-pi.log`：

```
[2026-07-09T14:30:00+08:00] [INFO] Profile "user-install" started
[2026-07-09T14:30:00+08:00] [NEW] extensions:sandbox → /home/user/.pi/agent/extensions/sandbox
[2026-07-09T14:30:01+08:00] [DELETE] extensions:sandbox → /home/user/.pi/agent/extensions/sandbox
[2026-07-09T14:30:01+08:00] [WARN] Running npm install in /home/user/.pi/agent/extensions/sandbox
[2026-07-09T14:30:05+08:00] [INFO] Profile "user-install" completed (1 resources, 1 new)
```

操作类型：

- `[NEW]` — 新增文件（目标不存在）
- `[UPDATE]` — 更新已存在的文件
- `[DELETE]` — 因 exclude 或 include 列表变更而删除的老文件
- `[SKIP]` — 文件未变化，跳过

## 目标目录

| 路径             | 说明                      |
| ---------------- | ------------------------- |
| `~/.pi/agent/`   | Pi 实际读取的全局代理目录 |
| `<project>/.pi/` | 项目本地目录              |
