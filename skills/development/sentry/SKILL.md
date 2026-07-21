---
name: sentry
description: '获取并分析 Sentry 的 issue、事件、事务和日志。帮助代理调试错误、查找根因、了解特定时间发生的情况。'
---

# Sentry 技能

通过 API 访问 Sentry 数据进行调试和调查。使用 `~/.sentryclirc` 中的认证令牌。

## 快速参考

| 任务               | 命令                                                                 |
| ------------------ | -------------------------------------------------------------------- |
| 查找某日期的错误   | `search-events.js --org X --start 2025-12-23T15:00:00 --level error` |
| 列出未解决的 issue | `list-issues.js --org X --status unresolved`                         |
| 获取 issue 详情    | `fetch-issue.js <issue-id-or-url> --latest`                          |
| 获取事件详情       | `fetch-event.js <event-id> --org X --project Y`                      |
| 搜索日志           | `search-logs.js --org X --project Y "level:error"`                   |

## 常见调试工作流

### "这个时间出了什么问题？"

查找特定时间戳附近的事件：

```bash
# Find all events in a 2-hour window
./scripts/search-events.js --org myorg --project backend \
  --start 2025-12-23T15:00:00 --end 2025-12-23T17:00:00

# Filter to just errors
./scripts/search-events.js --org myorg --start 2025-12-23T15:00:00 \
  --level error

# Find a specific transaction type
./scripts/search-events.js --org myorg --start 2025-12-23T15:00:00 \
  --transaction process-incoming-email
```

### "最近出现了什么错误？"

```bash
# List unresolved errors from last 24 hours
./scripts/list-issues.js --org myorg --status unresolved --level error --period 24h

# Find high-frequency issues
./scripts/list-issues.js --org myorg --query "times_seen:>50" --sort freq

# Issues affecting users
./scripts/list-issues.js --org myorg --query "is:unresolved has:user" --sort user
```

### "获取特定 issue/事件的详情"

```bash
# Get issue with latest stack trace
./scripts/fetch-issue.js 5765604106 --latest
./scripts/fetch-issue.js https://sentry.io/organizations/myorg/issues/123/ --latest
./scripts/fetch-issue.js MYPROJ-123 --org myorg --latest

# Get specific event with all breadcrumbs
./scripts/fetch-event.js abc123def456 --org myorg --project backend --breadcrumbs
```

### "查找带有特定标签的事件"

```bash
# Find by custom tag (e.g., thread_id, user_id)
./scripts/search-events.js --org myorg --tag thread_id:th_abc123

# Find by user email
./scripts/search-events.js --org myorg --query "user.email:*@example.com"
```

---

## 获取 Issue

```bash
./scripts/fetch-issue.js <issue-id-or-url> [options]
```

获取特定 issue（分组错误）的详情。

**接受：**

- Issue ID：`5765604106`
- Issue URL：`https://sentry.io/organizations/sentry/issues/5765604106/`
- 新 URL 格式：`https://myorg.sentry.io/issues/5765604106/`
- 简短 ID：`JAVASCRIPT-ABC`（需要 `--org` 标志）

**选项：**

- `--latest` - 包含最新事件的完整堆栈跟踪
- `--org <org>` - 组织 slug（用于简短 ID）
- `--json` - 输出原始 JSON

**输出包括：**

- 标题、原因、状态、级别
- 首次/最近看到的时间戳
- 事件数和用户影响
- 标签和环境信息
- 使用 `--latest`：堆栈跟踪、请求详情、面包屑、运行时上下文

---

## 获取事件

```bash
./scripts/fetch-event.js <event-id> --org <org> --project <project> [options]
```

通过事件 ID 获取特定事件的完整详情。

**选项：**

- `--org, -o <org>` - 组织 slug（必填）
- `--project, -p <project>` - 项目 slug（必填）
- `--breadcrumbs, -b` - 显示所有面包屑（默认：最近 30 条）
- `--spans` - 显示事务的 span 树
- `--json` - 输出原始 JSON

**输出包括：**

- 时间戳、项目、标题、消息
- 所有标签
- 上下文（运行时、浏览器、操作系统、跟踪信息）
- 请求详情
- 异常及堆栈跟踪
- 面包屑
- Span（使用 `--spans`）

---

## 搜索事件

```bash
./scripts/search-events.js [options]
```

使用 Sentry Discover 搜索事件（事务、错误）。

**时间范围选项：**

- `--period, -t <period>` - 相对时间（24h、7d、14d）
- `--start <datetime>` - 开始时间（ISO 8601：2025-12-23T15:00:00）
- `--end <datetime>` - 结束时间（ISO 8601）

**过滤选项：**

- `--org, -o <org>` - 组织 slug（必填）
- `--project, -p <project>` - 项目 slug 或 ID
- `--query, -q <query>` - Discover 搜索查询
- `--transaction <name>` - 事务名称过滤
- `--tag <key:value>` - 标签过滤（可重复）
- `--level <level>` - 级别过滤（error、warning、info）
- `--limit, -n <n>` - 最大结果数（默认：25，最大：100）
- `--fields <fields>` - 逗号分隔的包含字段

**查询语法：**

```
transaction:process-*     通配符事务匹配
level:error               按级别过滤
user.email:foo@bar.com    按用户过滤
environment:production    按环境过滤
has:stack.filename        有堆栈跟踪
```

---

## 列出 Issue

```bash
./scripts/list-issues.js [options]
```

列出并搜索项目中的 issue（分组错误）。

**选项：**

- `--org, -o <org>` - 组织 slug（必填）
- `--project, -p <project>` - 项目 slug（可重复）
- `--query, -q <query>` - Issue 搜索查询
- `--status <status>` - unresolved、resolved、ignored
- `--level <level>` - error、warning、info、fatal
- `--period, -t <period>` - 时间周期（默认：14d）
- `--limit, -n <n>` - 最大结果数（默认：25）
- `--sort <sort>` - date、new、priority、freq、user
- `--json` - 输出原始 JSON

**查询语法：**

```
is:unresolved             状态过滤
is:assigned               有负责人
assigned:me               分配给我
level:error               级别过滤
firstSeen:+7d             首次出现 > 7 天前
lastSeen:-24h             最近 24 小时内出现
times_seen:>100           事件计数过滤
has:user                  有用户上下文
error.handled:0           仅未处理的错误
```

---

## 搜索日志

```bash
./scripts/search-logs.js [query|url] [options]
```

在 Sentry 的 Logs Explorer 中搜索日志。

**选项：**

- `--org, -o <org>` - 组织 slug（除非提供了 URL，否则必填）
- `--project, -p <project>` - 按项目 slug 或 ID 过滤
- `--period, -t <period>` - 时间周期（默认：24h）
- `--limit, -n <n>` - 最大结果数（默认：100，最大：1000）
- `--json` - 输出原始 JSON

**查询语法：**

```
level:error              按级别过滤（trace、debug、info、warn、error、fatal）
message:*timeout*        用通配符搜索消息文本
trace:abc123             按跟踪 ID 过滤
project:my-project       按项目 slug 过滤
```

**接受 Sentry URL：**

```bash
./scripts/search-logs.js "https://myorg.sentry.io/explore/logs/?project=123&statsPeriod=7d"
```

---

## 调试技巧

1. **先宽后窄**：先用 `search-events.js` 按时间范围搜索，再深入特定事件

2. **使用面包屑**：`fetch-event.js` 的 `--breadcrumbs` 标志显示错误发生前的完整历史

3. **寻找模式**：使用 `list-issues.js --sort freq` 查找频繁出现的问题

4. **检查相关事件**：如果找到一个事件，查找具有相同事务名称或跟踪 ID 的其他事件

5. **标签是你的朋友**：自定义标签如 `thread_id`、`user_id`、`request_id` 有助于关联事件
