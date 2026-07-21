#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""
分析 Pi 会话 JSONL 文件。

功能:
  1. 编辑工具分析 (edits): 统计 Edit 工具调用模式 (single/multi/patch) 及文件扩展名分布
  2. 技能工具分析 (skills): 统计所有工具调用情况，识别使用模式
  3. 多会话汇总: 对多个会话生成汇总对比表格

用法:
  uv run .pi/skills/analyze-sessions/analyze-sessions.py [选项] [会话文件...]

示例:
  # 默认: 分析最近 10 个会话的 Edit 使用情况
  uv run .pi/skills/analyze-sessions/analyze-sessions.py

  # 分析最近 20 个会话
  uv run .pi/skills/analyze-sessions/analyze-sessions.py --recent 20

  # 分析具体会话文件
  uv run .pi/skills/analyze-sessions/analyze-sessions.py session1.jsonl session2.jsonl

  # 分析技能使用
  uv run .pi/skills/analyze-sessions/analyze-sessions.py --focus skills

  # 全面分析
  uv run .pi/skills/analyze-sessions/analyze-sessions.py --focus all

  # 指定会话目录
  uv run .pi/skills/analyze-sessions/analyze-sessions.py --session-dir ~/.pi/agent/sessions/--my-project--

  # 分析全部会话
  uv run .pi/skills/analyze-sessions/analyze-sessions.py --all-sessions

  # 扫描全部项目
  uv run .pi/skills/analyze-sessions/analyze-sessions.py --all-projects --focus all
"""

import argparse
import json
import os
import re
import sys
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


# ─────────────────────────────────────────────
#  数据模型
# ─────────────────────────────────────────────


@dataclass
class EditCall:
    """一次 Edit 工具调用的信息。"""

    mode: str  # single, multi(N), single+multi(N), patch
    files: list[str]  # 操作的文件路径
    failed: bool = False
    error: str = ""  # 失败时的错误文本


@dataclass
class ToolCall:
    """一次任意工具调用的信息。"""

    name: str
    args: dict
    failed: bool = False
    error: str = ""  # 失败时的错误文本


@dataclass
class SessionAnalysis:
    """单个会话的分析结果。"""

    filename: str
    filepath: str
    entry_count: int = 0
    user_msg_count: int = 0
    assistant_msg_count: int = 0
    edits: list[EditCall] = field(default_factory=list)
    tools: list[ToolCall] = field(default_factory=list)


# ─────────────────────────────────────────────
#  会话文件发现
# ─────────────────────────────────────────────


def detect_session_dir() -> Optional[str]:
    """根据当前工作目录自动推断 Pi 会话目录。"""
    cwd = os.getcwd()
    # 去掉开头的 /
    path = cwd.lstrip("/")
    # 用 - 替换 /
    key = path.replace("/", "-")
    session_dir = os.path.expanduser(f"~/.pi/agent/sessions/--{key}--")
    if os.path.isdir(session_dir):
        return session_dir
    return None


def find_recent_sessions(session_dir: str, count: int) -> list[str]:
    """从会话目录中找到最近的 N 个 .jsonl 文件。"""
    files = sorted(
        (
            os.path.join(session_dir, f)
            for f in os.listdir(session_dir)
            if f.endswith(".jsonl")
        ),
        key=os.path.getmtime,
        reverse=True,
    )
    return files[:count]


def find_all_sessions(session_dir: str) -> list[str]:
    """从会话目录中找到所有 .jsonl 文件。"""
    return sorted(
        (
            os.path.join(session_dir, f)
            for f in os.listdir(session_dir)
            if f.endswith(".jsonl")
        ),
        key=os.path.getmtime,
        reverse=True,
    )


def find_all_project_sessions(
    sessions_root: str, max_per_project: int = 5
) -> list[str]:
    """扫描所有项目会话目录，每个取最近 N 个会话。"""
    project_dirs = sorted(
        os.path.join(sessions_root, d)
        for d in os.listdir(sessions_root)
        if d.startswith("--")
        and d.endswith("--")
        and os.path.isdir(os.path.join(sessions_root, d))
    )
    all_files: list[tuple[float, str]] = []
    for pdir in project_dirs:
        files = sorted(
            (os.path.join(pdir, f) for f in os.listdir(pdir) if f.endswith(".jsonl")),
            key=os.path.getmtime,
            reverse=True,
        )
        for f in files[:max_per_project]:
            all_files.append((os.path.getmtime(f), f))
    all_files.sort(key=lambda x: -x[0])
    return [f for _, f in all_files]


# ─────────────────────────────────────────────
#  分类逻辑
# ─────────────────────────────────────────────


def base_mode(mode: str) -> str:
    """提取基本模式（去掉 multi 括号内的数字）。"""
    if mode.startswith("multi(") or mode.startswith("single+multi("):
        return "multi"
    return mode


def classify_edit(args: dict) -> tuple[str, list[str]]:
    """识别一次 Edit 调用的模式，返回 (模式标识, 文件路径列表)。"""
    has_patch = "patch" in args
    has_multi = "multi" in args and isinstance(args.get("multi"), list)
    has_single = "path" in args and "oldText" in args

    paths: list[str] = []

    if has_patch:
        patch_text = args["patch"]
        for line in patch_text.split("\n"):
            line = line.strip()
            for prefix in ("*** Add File: ", "*** Delete File: ", "*** Update File: "):
                if line.startswith(prefix):
                    paths.append(line[len(prefix) :])
        return "patch", paths

    multi_items = args.get("multi", []) if has_multi else []

    if has_single and has_multi:
        paths.append(args["path"])
        paths.extend(item.get("path", "") for item in multi_items)
        return f"single+multi({1 + len(multi_items)})", paths

    if has_multi:
        paths.extend(item.get("path", "") for item in multi_items)
        return f"multi({len(multi_items)})", paths

    if has_single:
        paths.append(args["path"])
        return "single", paths

    return "unknown", paths


def get_ext(filepath: str) -> str:
    """获取文件扩展名。"""
    ext = Path(filepath).suffix
    return ext if ext else "(无扩展名)"


# ─────────────────────────────────────────────
#  会话分析
# ─────────────────────────────────────────────


def _extract_error_text(msg: dict) -> str:
    """从 toolResult 消息中提取错误文本。"""
    content = msg.get("content", "")
    if isinstance(content, list):
        texts = []
        for c in content:
            if isinstance(c, dict):
                text = c.get("text", "")
                if text:
                    texts.append(text)
        return "\n".join(texts).strip()
    return str(content).strip()


def analyze_session(filepath: str) -> SessionAnalysis:
    """分析单个会话文件。"""
    result = SessionAnalysis(
        filename=os.path.basename(filepath),
        filepath=filepath,
    )

    entries = []
    try:
        with open(filepath) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                entries.append(json.loads(line))
    except (json.JSONDecodeError, FileNotFoundError) as e:
        print(f"  ⚠ 跳过无效文件 {filepath}: {e}", file=sys.stderr)
        return result

    result.entry_count = len(entries)

    # 第一遍：收集所有 toolCall（建立 id → index 映射）
    tool_call_map: dict[str, int] = {}  # tc_id -> index in result.tools
    edit_call_map: dict[str, int] = {}  # tc_id -> index in result.edits (仅 Edit 工具)

    for d in entries:
        if d.get("type") != "message":
            continue
        msg = d.get("message", {})
        role = msg.get("role")

        if role == "user":
            result.user_msg_count += 1
        elif role == "assistant":
            result.assistant_msg_count += 1
            for c in msg.get("content", []):
                if c.get("type") == "toolCall":
                    tc_id = c.get("id", "")
                    name = c.get("name", "")
                    arguments = c.get("arguments", {})

                    # 记录通用工具调用
                    tool_idx = len(result.tools)
                    result.tools.append(ToolCall(name=name, args=arguments))
                    tool_call_map[tc_id] = tool_idx

                    # 如果是 Edit 工具，额外做精细分析
                    if name in ("edit", "Edit"):
                        mode, paths = classify_edit(arguments)
                        edit_idx = len(result.edits)
                        result.edits.append(EditCall(mode=mode, files=paths))
                        edit_call_map[tc_id] = edit_idx

    # 第二遍：匹配 toolResult，回填失败状态和错误文本
    for d in entries:
        if d.get("type") != "message":
            continue
        msg = d.get("message", {})
        if msg.get("role") != "toolResult":
            continue
        tc_id = msg.get("toolCallId", "")
        is_error = msg.get("isError", False)
        if not is_error:
            continue

        error_text = _extract_error_text(msg)

        # 回填到 ToolCall
        if tc_id in tool_call_map:
            tc = result.tools[tool_call_map[tc_id]]
            tc.failed = True
            tc.error = error_text

        # 回填到 EditCall
        if tc_id in edit_call_map:
            ec = result.edits[edit_call_map[tc_id]]
            ec.failed = True
            ec.error = error_text

    return result


# ─────────────────────────────────────────────
#  失败原因分析
# ─────────────────────────────────────────────


def error_signature(text: str) -> str:
    """将错误文本归一化为可归因的签名。

    处理:
      - 移除文件路径（替换为 <path>）
      - 移除时间戳
      - 取第一段有意义的内容（≤100 字符）
      - 空输出归类为 "(silent failure - no output)"
    """
    if not text or not text.strip():
        return "(silent failure - no output)"

    text = text.strip()

    # 移除路径
    text = re.sub(
        r'(?<=["\s(/])/(?:home|Users|private|tmp|workspace)[^\s,;:)]{3,120}',
        "<path>",
        text,
    )

    # 移除 ISO 时间戳
    text = re.sub(
        r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?",
        "<ts>",
        text,
    )

    # 取第一段非空行（最多 100 字符）
    first_line = text.split("\n")[0].strip()[:100]

    # 某些通用后缀去掉
    for suffix in [
        "Command exited with code",
    ]:
        if suffix in first_line:
            first_line = first_line[: first_line.index(suffix)].strip().rstrip(",")

    if not first_line:
        return "(empty error text)"

    return first_line


def collect_failures(
    results: list[SessionAnalysis],
    tool_filter: set[str] | None = None,
) -> list[tuple[str, str, str]]:
    """收集所有失败的调用，返回 [(tool_name, signature, full_error_text)]。"""
    failures: list[tuple[str, str, str]] = []
    for r in results:
        for tc in r.tools:
            if not tc.failed:
                continue
            if tool_filter and tc.name not in tool_filter:
                continue
            sig = error_signature(tc.error)
            # full text for display (truncated)
            full = tc.error[:300] if tc.error else ""
            failures.append((tc.name, sig, full))
    return failures


def print_failure_analysis(
    failures: list[tuple[str, str, str]],
    title: str = "失败原因 Top 5",
    max_reasons: int = 5,
):
    """输出工具失败原因分析 3 级表格。

    表格: 工具名 | 失败原因 | 次数
    """
    if not failures:
        print("\n  (无失败记录)")
        return

    # 分组统计
    group_counts: Counter[tuple[str, str]] = Counter()
    group_examples: dict[tuple[str, str], str] = {}

    for tool, sig, full in failures:
        key = (tool, sig)
        group_counts[key] += 1
        if key not in group_examples:
            group_examples[key] = full

    print(f"\n── {title} ──")
    name_w = max(8, max(len(t) for t, _ in group_counts))
    reason_w = 85
    cell_w = 6
    header = f"  {'工具':<{name_w}s} {'失败原因':<{reason_w}s} {'次数':>{cell_w}s}"
    print(header)
    print(f"  {'-' * (len(header) - 2)}")

    for (tool, sig), count in group_counts.most_common(max_reasons):
        row = f"  {tool:<{name_w}s} {sig:<{reason_w}s} {count:>{cell_w}d}"
        print(row)


# ─────────────────────────────────────────────
#  输出 - 编辑分析
# ─────────────────────────────────────────────


def print_edit_analysis(results: list[SessionAnalysis]):
    """输出 Edit 工具的详细分析。"""
    if not results:
        print("未找到任何会话数据。")
        return

    all_edits = [e for r in results for e in r.edits]
    if not all_edits:
        print("未找到任何 Edit 工具调用。")
        return

    total = len(all_edits)
    total_failed = sum(1 for e in all_edits if e.failed)

    print(f"\n{'=' * 60}")
    print(f"Edit 工具分析报告（{len(results)} 个会话）")
    print(f"{'=' * 60}")
    print(f"  Edit 调用总次数: {total}")
    print(f"  总失败次数:     {total_failed} ({total_failed / total * 100:.1f}%)")

    # ── 按基础模式统计 ──
    mode_calls: Counter[str] = Counter()
    mode_fails: Counter[str] = Counter()
    mode_ext_calls: Counter[tuple[str, str]] = Counter()
    ext_calls: Counter[str] = Counter()
    ext_fails: Counter[str] = Counter()

    for e in all_edits:
        bm = base_mode(e.mode)
        mode_calls[bm] += 1
        if e.failed:
            mode_fails[bm] += 1

        exts = {get_ext(f) for f in e.files} if e.files else {"(无扩展名)"}
        for ext in exts:
            mode_ext_calls[(bm, ext)] += 1
            ext_calls[ext] += 1
            if e.failed:
                ext_fails[ext] += 1

    print("\n── 按模式（工具调用次数）──")
    for mode, count in sorted(mode_calls.items(), key=lambda x: -x[1]):
        pct = count / total * 100
        fails = mode_fails[mode]
        fail_pct = fails / count * 100 if count else 0
        print(
            f"  {mode:<12s} {count:>4d}  ({pct:5.1f}%)   失败: {fails:>3d} ({fail_pct:5.1f}%)"
        )

    print("\n── 按扩展名（工具调用次数）──")
    for ext, count in sorted(ext_calls.items(), key=lambda x: -x[1]):
        fails = ext_fails[ext]
        fail_pct = fails / count * 100 if count else 0
        print(f"  {ext:<12s} {count:>4d}   失败: {fails:>3d} ({fail_pct:5.1f}%)")

    # ── 交叉表 ──
    all_modes_sorted = sorted(mode_calls.keys(), key=lambda m: -mode_calls[m])
    all_exts_sorted = sorted(ext_calls.keys(), key=lambda e: -ext_calls[e])

    col_w = 12
    ext_w = max(12, *(len(e) for e in all_exts_sorted))

    print("\n── 扩展名 × 模式（工具调用数 / 失败数）──")
    header = (
        f"  {'扩展名':<{ext_w}s}"
        + "".join(f" {m:>{col_w}s}" for m in all_modes_sorted)
        + f" {'合计':>{col_w}s}"
    )
    print(header)
    print(f"  {'-' * (len(header) - 2)}")
    for ext in all_exts_sorted:
        row = f"  {ext:<{ext_w}s}"
        row_total = 0
        row_total_f = 0
        for m in all_modes_sorted:
            v = mode_ext_calls.get((m, ext), 0)
            # 计算此 (m, ext) 的失败数
            vf = sum(
                1
                for e in all_edits
                if base_mode(e.mode) == m
                and ext in {get_ext(f) for f in e.files}
                and e.failed
            )
            row_total += v
            row_total_f += vf
            cell = f"{v}" if vf == 0 else f"{v} ({vf}✗)"
            row += f" {cell:>{col_w}s}"
        cell_t = f"{row_total}" if row_total_f == 0 else f"{row_total} ({row_total_f}✗)"
        row += f" {cell_t:>{col_w}s}"
        print(row)

    # 合计行
    print(f"  {'-' * (len(header) - 2)}")
    row = f"  {'合计':<{ext_w}s}"
    grand = 0
    grand_f = 0
    for m in all_modes_sorted:
        v = sum(1 for e in all_edits if base_mode(e.mode) == m)
        vf = sum(1 for e in all_edits if base_mode(e.mode) == m and e.failed)
        grand += v
        grand_f += vf
        cell = f"{v}" if vf == 0 else f"{v} ({vf}✗)"
        row += f" {cell:>{col_w}s}"
    cell = f"{grand}" if grand_f == 0 else f"{grand} ({grand_f}✗)"
    row += f" {cell:>{col_w}s}"
    print(row)

    # ── 每会话汇总 ──
    print(f"\n{'=' * 60}")
    print("各会话 Edit 调用汇总")
    print(f"{'=' * 60}")
    print_edit_session_table(results)

    # ── 失败原因分析 ──
    if total_failed > 0:
        edit_failures = collect_failures(results, tool_filter={"edit", "Edit"})
        print_failure_analysis(edit_failures, "Edit 工具失败原因 Top 5")


def print_edit_session_table(results: list[SessionAnalysis]):
    """输出各会话的 Edit 调用汇总表格。"""
    # 收集所有模式
    all_modes_set: set[str] = set()
    for r in results:
        for e in r.edits:
            all_modes_set.add(base_mode(e.mode))
    all_modes_sorted = sorted(all_modes_set)

    # 表头
    name_w = max(40, max(len(r.filename[:37]) for r in results))
    col_w = 10
    header = (
        f"  {'会话文件':<{name_w}s}"
        + "".join(f" {m:>{col_w}s}" for m in all_modes_sorted)
        + f" {'合计':>{col_w}s} {'失败率':>{col_w}s}"
    )
    print(header)
    print(f"  {'-' * (len(header) - 2)}")

    grand = Counter[str]()
    grand_fail = Counter[str]()
    total_all = 0
    total_fail_all = 0

    for r in results:
        mode_counts = Counter[str]()
        mode_fails = Counter[str]()
        for e in r.edits:
            bm = base_mode(e.mode)
            mode_counts[bm] += 1
            if e.failed:
                mode_fails[bm] += 1

        session_total = sum(mode_counts.values())
        session_fails = sum(mode_fails.values())
        total_all += session_total
        total_fail_all += session_fails

        short_name = r.filename[:name_w]
        row = f"  {short_name:<{name_w}s}"
        for m in all_modes_sorted:
            v = mode_counts.get(m, 0)
            vf = mode_fails.get(m, 0)
            grand[m] += v
            grand_fail[m] += vf
            cell = f"{v}" if vf == 0 else f"{v} ({vf}✗)"
            row += f" {cell:>{col_w}s}"

        fail_rate = (
            f"{session_fails / session_total * 100:.1f}%" if session_total > 0 else "-"
        )
        row += f" {session_total:>{col_w}d} {fail_rate:>{col_w}s}"
        print(row)

    # 合计行
    print(f"  {'-' * (len(header) - 2)}")
    row = f"  {'合计':<{name_w}s}"
    for m in all_modes_sorted:
        v = grand[m]
        vf = grand_fail[m]
        cell = f"{v}" if vf == 0 else f"{v} ({vf}✗)"
        row += f" {cell:>{col_w}s}"
    fail_rate = f"{total_fail_all / total_all * 100:.1f}%" if total_all > 0 else "-"
    row += f" {total_all:>{col_w}d} {fail_rate:>{col_w}s}"
    print(row)


# ─────────────────────────────────────────────
#  输出 - 技能工具分析
# ─────────────────────────────────────────────


# 已知的内置工具（不会被归类为"技能工具"）
BUILTIN_TOOLS = {
    "bash",
    "ls",
    "cd",
    "cat",
    "read",
    "write",
    "edit",
    "Edit",
    "rg",
    "find",
    "grep",
    "head",
    "tail",
    "echo",
    "lsp_diagnostics",
    "lsp_navigation",
    "ast_grep_search",
    "ast_grep_replace",
    "questionnaire",
    "structured_output",
    "get_goal",
    "create_goal",
    "update_goal",
    "todo",
    "signal_loop_success",
}


def print_skill_analysis(results: list[SessionAnalysis]):
    """输出技能工具使用分析。"""
    if not results:
        print("未找到任何会话数据。")
        return

    all_tools = [t for r in results for t in r.tools]
    if not all_tools:
        print("未找到任何工具调用。")
        return

    print(f"\n{'=' * 60}")
    print(f"技能工具分析报告（{len(results)} 个会话）")
    print(f"{'=' * 60}")

    # 总体工具使用排名
    tool_counts: Counter[str] = Counter()
    tool_fails: Counter[str] = Counter()
    for t in all_tools:
        tool_counts[t.name] += 1
        if t.failed:
            tool_fails[t.name] += 1

    total = len(all_tools)
    print(f"\n  总工具调用次数: {total}")
    print(f"  总失败次数:     {sum(tool_fails.values())}")

    # 区分内置工具和技能工具
    skill_tools = {name for name in tool_counts if name not in BUILTIN_TOOLS}

    # ── 技能工具（非内置）──
    if skill_tools:
        print(f"\n── 技能工具使用排名（{len(skill_tools)} 种）──")
        for name in sorted(skill_tools, key=lambda n: -tool_counts[n]):
            count = tool_counts[name]
            fails = tool_fails[name]
            pct = count / total * 100
            fail_str = f" 失败: {fails}" if fails else ""
            print(f"  {name:<25s} {count:>4d} ({pct:4.1f}%) {fail_str}")

    # ── 全部工具排名 ──
    print("\n── 全部工具调用排名（按频率）──")
    for name, count in tool_counts.most_common(15):
        fails = tool_fails[name]
        kind = "📦" if name not in BUILTIN_TOOLS else "🔧"
        fail_str = f" ✗{fails}" if fails else ""
        print(f"  {kind} {name:<25s} {count:>4d}{fail_str}")

    # ── 各会话工具使用汇总 ──
    print(f"\n{'=' * 60}")
    print("各会话工具调用汇总")
    print(f"{'=' * 60}")
    print_tool_session_table(results, skill_tools)

    # ── 失败原因分析 ──
    total_failed_all = sum(tool_fails.values())
    if total_failed_all > 0:
        all_failures = collect_failures(results)
        print_failure_analysis(all_failures, "全部工具失败原因 Top 5")


def print_tool_session_table(results: list[SessionAnalysis], skill_tools: set[str]):
    """输出各会话工具调用汇总表格。"""
    # 选取前 10 个工具作为列
    all_tool_counts: Counter[str] = Counter()
    for r in results:
        for t in r.tools:
            all_tool_counts[t.name] += 1
    top_tools = [n for n, _ in all_tool_counts.most_common(12)]
    # 尝试将 skill_tools 放在前面
    skill_top = sorted(
        [t for t in top_tools if t in skill_tools], key=lambda n: -all_tool_counts[n]
    )
    builtin_top = sorted(
        [t for t in top_tools if t not in skill_tools],
        key=lambda n: -all_tool_counts[n],
    )
    columns = skill_top + builtin_top

    name_w = max(40, max(len(r.filename[:37]) for r in results))
    col_w = 8
    header = (
        f"  {'会话文件':<{name_w}s}"
        + "".join(f" {c:>{col_w}s}" for c in columns)
        + f" {'合计':>{col_w}s}"
    )
    print(header)
    print(f"  {'-' * (len(header) - 2)}")

    for r in results:
        tc = Counter(t.name for t in r.tools)
        session_total = sum(tc.values())
        short_name = r.filename[:name_w]
        row = f"  {short_name:<{name_w}s}"
        for c in columns:
            v = tc.get(c, 0)
            row += f" {v:>{col_w}d}"
        row += f" {session_total:>{col_w}d}"
        print(row)

    # 合计行
    row = f"  {'合计':<{name_w}s}"
    for c in columns:
        v = all_tool_counts.get(c, 0)
        row += f" {v:>{col_w}d}"
    row += f" {sum(all_tool_counts.values()):>{col_w}d}"
    print(row)


# ─────────────────────────────────────────────
#  主入口
# ─────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(
        description="分析 Pi 会话 JSONL 文件",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "session_files",
        nargs="*",
        help="会话 JSONL 文件路径（可选；不指定则用 --recent 或 --all-sessions）",
    )
    parser.add_argument(
        "--recent",
        "-n",
        type=int,
        metavar="N",
        help="分析最近 N 个会话（默认 10，当未指定文件且未用 --all-sessions 时生效）",
    )
    parser.add_argument(
        "--all-sessions", "-a", action="store_true", help="分析会话目录下所有会话"
    )
    parser.add_argument(
        "--session-dir",
        "-d",
        metavar="DIR",
        help="会话 JSONL 目录（默认自动从当前工作目录推断）",
    )
    parser.add_argument(
        "--focus",
        "-f",
        choices=["edits", "skills", "all"],
        default="edits",
        help="分析焦点: edits=Edit 工具, skills=全部技能工具, all=全部（默认: edits）",
    )
    parser.add_argument(
        "--json", "-j", action="store_true", help="以 JSON 格式输出（用于程序消费）"
    )
    parser.add_argument(
        "--all-projects",
        "-A",
        action="store_true",
        help="扫描 ~/.pi/agent/sessions/ 下所有项目会话目录（每个取最近 5 个会话）",
    )

    args = parser.parse_args()
    focus = args.focus

    # ── 确定会话文件列表 ──
    session_files: list[str] = []

    if args.all_projects:
        sessions_root = os.path.expanduser("~/.pi/agent/sessions")
        if not os.path.isdir(sessions_root):
            print(f"错误: 会话根目录不存在: {sessions_root}", file=sys.stderr)
            sys.exit(1)
        count_per = 5 if args.recent is None else args.recent
        session_files = find_all_project_sessions(sessions_root, count_per)
        if not args.json:
            print(
                f"扫描全部项目，每个取最近 {count_per} 个会话，共 {len(session_files)} 个会话文件"
            )
    elif args.session_files:
        # 直接指定了文件
        session_files = args.session_files
    else:
        # 自动发现
        session_dir = args.session_dir or detect_session_dir()
        if not session_dir:
            print(
                "错误: 无法自动推断会话目录，请用 --session-dir 指定", file=sys.stderr
            )
            sys.exit(1)
        if not os.path.isdir(session_dir):
            print(f"错误: 会话目录不存在: {session_dir}", file=sys.stderr)
            sys.exit(1)

        if args.all_sessions:
            session_files = find_all_sessions(session_dir)
        else:
            count = args.recent if args.recent is not None else 10
            session_files = find_recent_sessions(session_dir, count)

        if not session_files:
            print(f"错误: 在 {session_dir} 中未找到会话文件", file=sys.stderr)
            sys.exit(1)

        if not args.json:
            print(f"会话目录: {session_dir}")
            print(f"找到 {len(session_files)} 个会话文件")

    # ── 分析会话 ──
    results: list[SessionAnalysis] = []
    for sf in session_files:
        if not os.path.isfile(sf):
            print(f"  ⚠ 跳过: 文件不存在 {sf}", file=sys.stderr)
            continue
        result = analyze_session(sf)
        results.append(result)
        if result.entry_count == 0:
            print(f"  ⚠ {result.filename}: 空文件或无效数据", file=sys.stderr)

    if not results:
        print("未找到有效的会话文件。")
        sys.exit(1)

    # ── JSON 输出 ──
    if args.json:
        output = {
            "total_sessions": len(results),
            "focus": focus,
            "sessions": [],
        }
        for r in results:
            s = {
                "filename": r.filename,
                "entries": r.entry_count,
                "user_messages": r.user_msg_count,
                "assistant_messages": r.assistant_msg_count,
                "edits": [
                    {"mode": e.mode, "files": e.files, "failed": e.failed}
                    for e in r.edits
                ],
                "tools": [{"name": t.name, "failed": t.failed} for t in r.tools],
            }
            output["sessions"].append(s)
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return

    # ── 文本输出 ──
    show_edits = focus in ("edits", "all")
    show_skills = focus in ("skills", "all")

    if show_edits:
        print_edit_analysis(results)
    if show_skills:
        print_skill_analysis(results)

    # ── 结尾 ──
    print(f"\n{'=' * 60}")
    print(f"分析完成。共分析 {len(results)} 个会话。")
    print(f"{'=' * 60}")


if __name__ == "__main__":
    main()
