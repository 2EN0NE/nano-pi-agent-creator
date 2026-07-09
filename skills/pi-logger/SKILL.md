---
name: pi-logger
description: "pi 扩展的统一日志系统。提供 createLogger() API、按插件分文件输出、通过配置文件按日志器控制级别、以及自动捕获所有扩展（包括 npm 安装的扩展）的生命周期日志。"
---

为 pi 扩展项目安装 pi-logger 统一日志系统。

pi-logger 提供三个能力：
- **Logger API** — 其他扩展调用 `createLogger('name').info('msg')` 即可使用结构化日志
- **配置驱动输出** — `pi-logger.json` 控制每个日志器的级别 + 输出目的地
- **生命周期捕获** — 自动记录所有扩展（包括 npm 第三方扩展）的工具调用/turn/消息/agent 事件

## 安装步骤

### 1. 复制扩展

```bash
# 方案 A：项目本地（推荐开发用）
cp -r path/to/pi-logger ./extensions/meta/pi-logger

# 方案 B：全局安装（跨项目使用）
cp -r path/to/pi-logger ~/.pi/agent/extensions/pi-logger
```

### 2. 在 package.json 中注册

将 pi-logger 添加到 `pi.extensions` 数组（pi-logger 应尽早加载以捕获启动事件）：

```json
{
  "pi": {
    "extensions": [
      "./extensions",
      "./extensions/meta/pi-logger"
    ]
  }
}
```

> **顺序重要**：pi-logger 应排在**其他使用 `createLogger()` 的扩展之前**，因为 `initEventBus()` 必须在日志事件发射前完成初始化。

### 3. 配置日志（可选）

在项目根目录或 `~/.pi/agents/` 下创建 `pi-logger.json`：

```jsonc
{
  "defaultLevel": "info",
  "loggers": {
    "my-extension": "debug",
    "__lifecycle__": "info"
  },
  "appenders": {
    "file": {
      "enabled": true,
      "path": "./.pi/logs",
      "level": "trace"
    },
    "console": {
      "enabled": false,
      "level": "info",
      "color": true
    }
  }
}
```

配置文件搜索顺序（后面的覆盖前面的）：
1. 插件自带：`extensions/meta/pi-logger/pi-logger.json`
2. 用户全局：`~/.pi/agents/pi-logger.json`
3. 项目本地：从 cwd 向上递归查找，找到的第一个 `pi-logger.json`

### 4. 在扩展中添加日志

```typescript
import { createLogger } from "./pi-logger/api.js";

const log = createLogger("my-extension");

export default function myExtension(pi: ExtensionAPI) {
  log.info("扩展已加载");

  pi.registerTool({
    name: "my-tool",
    execute(toolCallId, params, signal, onUpdate, ctx) {
      log.debug("my-tool 被调用，参数：%j", params);
      // ... 工具实现 ...
      log.info("my-tool 完成");
    },
  });
}
```

## 配置项参考

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `defaultLevel` | string | `"info"` | 默认日志级别（trace/debug/info/warn/error/off） |
| `loggers.<name>` | string | — | 按日志器名称覆盖级别（层次化匹配） |
| `loggers.__lifecycle__` | string | `"info"` | 生命周期自动捕获日志的级别 |
| `appenders.file.enabled` | bool | `true` | 启用文件输出 |
| `appenders.file.path` | string | `~/.pi/logs` | 日志目录 |
| `appenders.file.level` | string | `"trace"` | 文件输出的最低级别 |
| `appenders.file.pattern` | string | `"[%d{ISO}] [%p] [%c] %m%n"` | 日志格式模板 |
| `appenders.console.enabled` | bool | `false` | 启用控制台输出（stderr） |
| `appenders.console.level` | string | `"info"` | 控制台输出的最低级别 |
| `appenders.console.color` | bool | `true` | 是否使用 ANSI 颜色 |

## 日志文件

日志按 source 分文件输出，格式为 `{日志目录}/{source}_{YYYYMMDD}.log`：

```
.pi/logs/
├── review_20260614.log        ← review 插件的日志
├── __lifecycle___20260614.log ← 生命周期自动捕获
├── my-extension_20260614.log  ← 其他插件的日志
└── ...
```

## 运行时命令

| 命令 | 说明 |
|---|---|
| `/log config` | 查看当前日志器配置 |
| `/log config reload` | 重新加载配置文件 |
| `/log config level <名称>` | 查看某个日志器的级别 |
| `/log config level <名称> <级别>` | 设置某个日志器的级别（仅本次会话） |
| `/log tail [n]` | 查看最近 n 条日志（默认 20） |
| `/log path` | 查看日志目录路径 |
| `/log set-output file\|console\|both` | 切换输出目标（仅本次会话） |

## CLI 标志

```
pi --log-level debug    # 启动时覆盖默认日志级别
```

## 使用技巧

- **导入路径**：`extensions/foo.ts` 中的导入写法应为 `import { createLogger } from "./pi-logger/api.js"`
- **日志器命名**：使用点号分隔的层次化名称以便细粒度控制，如 `"review"`、`"review.file-scanner"`
- **结构化数据**：将对象作为最后一个参数传入：`log.info("处理完成", { 文件, 行数: 42 })`
- **生命周期控制**：设置 `"__lifecycle__": "trace"` 可看到每次工具调用；`"info"` 则只看到工具结果
- **TUI 下使用控制台**：交互式 TUI 使用时应关闭控制台输出（`"enabled": false`），避免渲染干扰
