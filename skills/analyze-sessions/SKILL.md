---
name: analyze-sessions
description: >
    分析 Pi 会话 JSONL 文件，统计 Edit 工具使用模式、技能工具调用情况，
    支持多会话汇总比对，帮助了解编码行为和工具使用趋势。
---

# Analyze Sessions

分析 Pi 会话 JSONL 文件，提供两类分析焦点（`--focus`）：

| 焦点     | 分析内容                                                        |
| -------- | --------------------------------------------------------------- |
| `edits`  | **Edit 工具分析** — single/multi/patch 模式统计、文件扩展名分布 |
| `skills` | **技能工具分析** — 全部工具调用排名（区分内置/非内置）          |
| `all`    | **全面分析** — 同时输出 edits 和 skills 两种分析                |

## 何时使用

- 想了解自己在编码中更倾向用 **single edit、multi edit 还是 patch** 模式
- 想排查 Edit 工具的失败率，识别容易出错的文件类型
- 想了解 Pi 在会话中调用了哪些 **技能工具**（扩展提供的工具）及其使用频率
- 想对比**多个会话**的工具使用行为差异
- 想从**最近 N 个会话**中获取整体趋势

## 快速使用

### 默认：分析最近 10 个会话的 Edit 使用情况

```bash
cd /path/to/your/project
uv run skills/analyze-sessions/analyze-sessions.py
```

会自动从当前工作目录推断 Pi 会话目录（`~/.pi/agent/sessions/--<path>--`），取最近 10 个 JSONL 文件分析。

### 分析更多/更少会话

```bash
# 最近 20 个
uv run skills/analyze-sessions/analyze-sessions.py --recent 20

# 最近 5 个
uv run skills/analyze-sessions/analyze-sessions.py -n 5

# 全部会话
uv run skills/analyze-sessions/analyze-sessions.py --all-sessions
```

### 分析技能工具使用

```bash
uv run skills/analyze-sessions/analyze-sessions.py --focus skills
```

### 全面分析（Edit + 技能工具）

```bash
uv run skills/analyze-sessions/analyze-sessions.py --focus all
```

### 指定具体会话文件

```bash
uv run skills/analyze-sessions/analyze-sessions.py session1.jsonl session2.jsonl
```

### 指定会话目录（非当前项目）

```bash
uv run skills/analyze-sessions/analyze-sessions.py \
    --session-dir ~/.pi/agent/sessions/--Users-jojo-Projects-other-project--
```

### JSON 输出（程序消费）

```bash
uv run skills/analyze-sessions/analyze-sessions.py --json
```

## 输出说明

### Edit 分析输出结构

```
====================================================================
Edit 工具分析报告（10 个会话）
====================================================================
  Edit 调用总次数: 187
  总失败次数:     15 (8.0%)

── 按模式（工具调用次数）──
  single       120  (64.2%)   失败: 8 (6.7%)
  multi         45  (24.1%)   失败: 5 (11.1%)
  patch         22  (11.8%)   失败: 2 (9.1%)

── 按扩展名（工具调用次数）──
  .ts          102   失败: 12 (11.8%)
  .md           45   失败: 1 (2.2%)
  .json         25   失败: 2 (8.0%)
  .py           15   失败: 0 (0.0%)

── 扩展名 × 模式（工具调用数 / 失败数）──
  扩展名       single       multi         patch        合计
  ────────────────────────────────────────────────────────────
  .ts           70 (8✗)     22 (3✗)      10 (1✗)      102 (12✗)
  .md           30          12 (1✗)       3              45 (1✗)
  .json         15           8 (1✗)       2              25 (2✗)
  .py           10           3            2              15
  ────────────────────────────────────────────────────────────
  合计         125 (8✗)     45 (5✗)      17 (2✗)      187 (15✗)

====================================================================
各会话 Edit 调用汇总
====================================================================
  会话文件                     single      multi       合计    失败率
  ──────────────────────────────────────────────────────────────────
  2026-07-10_analysis.jsonl      12          3          15    6.7%
  2026-07-09_session1.jsonl       8          5          13    7.7%
  ...
  ──────────────────────────────────────────────────────────────────
  合计                           120         45         187    8.0%
```

### 技能分析输出结构

```
====================================================================
技能工具分析报告（10 个会话）
====================================================================
  总工具调用次数: 905
  总失败次数:     28

── 技能工具使用排名（3 种）──
  structured_output     15 (1.7%)
  questionnaire         10 (1.1%)
  confirm_destructive    3 (0.3%)

── 全部工具调用排名（按频率）──
  🔧 bash                420
  🔧 read                210
  🔧 ls                  120
  🔧 edit                 80
  📦 structured_output    15
  ...

====================================================================
各会话工具调用汇总
====================================================================
  会话文件                     structured_output  bash  read  ...  合计
  ──────────────────────────────────────────────────────────────────────
  2026-07-10_analysis.jsonl                   2    45    20  ...   95
  ...
  ──────────────────────────────────────────────────────────────────────
  合计                                        15   420   210  ...  905
```

## 失败原因分析

报告结尾会展示 **失败原因 Top 5** 3 级表格：

```
── Edit 工具失败原因 Top 5 ──
  工具       失败原因                                                                                      次数
  ─────────────────────────────────────────────────────────────────────────────────────────────────────
  edit     Validation failed for tool "edit"                                                            3
  edit     Could not find the exact text in <path>                                                      4
  edit     🔄 RETRYABLE — Edit target not found                                                        2
  edit     Preflight failed before mutating files.                                                     1
  edit     🔄 RETRYABLE — Edit without read                                                            1
```

`--focus skills` / `all` 时同样输出全部工具的失败原因：

```
── 全部工具失败原因 Top 5 ──
  工具       失败原因                                                                                   次数
  ────────────────────────────────────────────────────────────────────────────────────────────────────
  bash     (no output)                                                                              22
  bash     🔧 Pi Sync Tool — Profile-Driven Resource Sync                                            7
  bash     Command timed out after 30 seconds                                                        4
  edit     Could not find the exact text in <path>                                                   4
  bash     Traceback (most recent call last):                                                        3
```

错误文本中的**文件路径**和**时间戳**会被自动归一化（替换为 `<path>` / `<ts>`），便于同类错误归因。

## 参数说明

| 参数                         | 说明                                                               |
| ---------------------------- | ------------------------------------------------------------------ |
| `session_files`              | 具体会话 JSONL 文件（可选）                                        |
| `--recent N`, `-n N`         | 分析最近 N 个会话（默认 10）                                       |
| `--all-sessions`, `-a`       | 分析会话目录下**所有**会话                                         |
| `--all-projects`, `-A`       | 扫描 `~/.pi/agent/sessions/` 下**所有项目**，每个取最近 5 个会话   |
| `--session-dir DIR`, `-d`    | 会话 JSONL 目录（默认自动从 cwd 推断）                             |
| `--focus {edits,skills,all}` | 分析焦点: edits=Edit 工具, skills=全部工具, all=全部（默认 edits） |
| `--json`, `-j`               | JSON 格式输出，适合程序消费                                        |

### 示例

```bash
# 扫描全部项目
uv run skills/analyze-sessions/analyze-sessions.py --all-projects --focus all

# 扫描全部项目，每个取最近 10 个会话
uv run skills/analyze-sessions/analyze-sessions.py -A -n 10 -f all
```

## 分析脚本

本技能提供 `analyze-sessions.py` 脚本，核心功能：

- **Edit 工具分析**：继承自原根目录的 `analyze-edits.py`，识别 single/multi/patch 模式 + 文件扩展名分布
- **技能工具分析**：分析所有工具调用，区分内置工具（🔧）和技能工具（📦）
- **失败原因分析**：提取失败工具的 error 文本，按工具+原因归一化分组，展示 Top 5
- **多会话汇总**：跨会话生成对比表格，便于查看趋势
- **自动会话发现**：根据 cwd 自动推断 Pi 会话目录
- **近期会话选择**：`--recent N` 快速查看最新 N 个会话

```bash
cd /home/zenone/popular_projects/forked_projects/nano-pi-stuff
uv run skills/analyze-sessions/analyze-sessions.py --focus all --recent 5
```
