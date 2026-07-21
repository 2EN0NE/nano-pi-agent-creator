---
name: extract-pi-knowledge
description: '分析 Pi 会话历史（~/.pi/agent/sessions/）中关于扩展开发的失败模式与 tree 分叉路径，提取可复用的关键知识，补充到 AGENTS.md 的 `## 开发Pi插件一些补充信息` 节下。帮助后续 agent 一次改对，无需阅读 Pi 源码。'
---

从 Pi 会话历史中提取扩展开发关键知识，补充到 AGENTS.md。

!!!特别注意：

1. 如果没有额外的信息，不用非要有知识抽取合并，保留精简有用才是第一要义。没有的话直接回复没有额外的关键信息即可。
2. 信息必须是pi的官方文档中不存在的。

## 原理

Pi 的 `~/.pi/agent/sessions/` 中保存了所有对话的 JSONL 文件，包含完整的会话树（tree branches）、compaction 摘要、用户反馈等。多次失败尝试的会话往往包含：

- **多次修正尝试**：同一问题的多个修复 → 验证 → 修复 → 验证的循环
- **tree 分叉**：一个 conversation 分岔成两个分支，代表探索不同方向的方案
- **用户事后总结**：任务结束时的总结、根因分析

## 提取步骤

### 1. 找到相关会话文件

扫描 `~/.pi/agent/sessions/` 下以 `--<当前项目路径>--` 命名的目录。按文件大小/行数排序，优先分析大文件（包含更多会话内容）。

```bash
SESSION_DIR="${HOME}/.pi/agent/sessions/--$(echo "$PWD" | tr '/' '-')--"
ls -S "$SESSION_DIR"/*.jsonl 2>/dev/null | head -5
```

### 2. 找出失败模式与 tree 分叉

用 Python 脚本扫描会话文件，提取三类关键信号：

```python
# 关键模式检测（用 Python 解析 JSONL）

# a. 用户消息中的错误/问题关键词
error_keywords = ["错误", "不工作", "失败", "没触发", "wrong", "error", "fail", "bug",
                  "为什么", "不对", "问题", "issue", "doesn", "isn't working"]

# b. tree 分叉检测：同一 parentId 有多个不同 type 的子节点
# 如一个节点同时有 message(user) 和 branch_summary 子节点
# 表示 agent 在处理过程中分岔出去探索了另一条路

# c. 连续的"修复→验证"循环：
# 3 次以上类似的修改后验证，表明第一次方向是错的
```

完整检测脚本见 [extract-pi-knowledge/analyze.py](analyze.py)。

### 3. 提取知识模板

每个知识点按以下结构记录：

```markdown
- **问题**：[一句话描述]
  **根因**：[为什么错]
  **修复**：[怎么改]
  **触发条件**：[什么情况下会遇到]
```

### 4. 更新 AGENTS.md

- 知识点放入 `## 开发Pi插件一些补充信息` 节
- 该节不超过 **200 行**（含空行）
- 若超限，将**最早或最长**的知识点移入 `./docs/pi-ext-knowledge/` 目录下独立文件，并在 AGENTS.md 中引用
- 每次新增前检查已有条目是否可合并
- 知识应让 agent **一看就懂直接用**，不需要再查源码

### 5. 将新知识同步到 AGENTS.md

按 [step 3](#3-提取知识模板) 的格式写入 `## 开发Pi插件一些补充信息` 节。若该节已接近 200 行，先归档部分到 `./docs/pi-ext-knowledge/`。

## 检测脚本

本技能提供 `analyze.py` 脚本，自动扫描会话文件并输出分析结果：

```bash
cd /home/zenone/popular_projects/forked_projects/nano-pi-stuff
uv run .pi/skills/extract-pi-knowledge/analyze.py --session-dir ~/.pi/agent/sessions/--home-zenone-popular_projects-forked_projects-nano-pi-stuff--
```

输出：

1. 每个会话的用户消息摘要
2. Tree 分叉点（分支路径）
3. 失败模式列表（错误关键词 + 上下文）
4. 提取的知识点建议
