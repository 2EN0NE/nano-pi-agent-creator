#!/usr/bin/env python3
"""从一个 cell 的 session jsonl 提取指标并写 result.json。

原为 run-cell.sh 的内联 heredoc，抽成独立 module 以便单元测试（见 ADR-0057 后果）。

用法：
  TRIGGER_TOOLS=<逗号分隔> python3 bench/metrics.py <cell-dir> <wall-seconds>

环境变量：
  TRIGGER_TOOLS   该 config 臂声明的触发工具名；空/未设 → plugin_triggered 记 null（无法判定）
  BENCH_MODEL     模型标识（原样写入 result.json）
  BENCH_THINKING  思考级别（原样写入，默认 low）

输出：<cell-dir>/result.json
"""

from __future__ import annotations

import glob
import json
import os
import sys

TOKEN_KEYS = ("input", "output", "cacheRead", "cacheWrite", "totalTokens")
PATCH_REL = os.path.join("artifacts", "model.patch")


def _as_int(value):
    """usage 字段容错读取：非数字（None / 字符串 / 非法值）一律当 0。"""
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _as_float(value):
    """同 _as_int，用于成本等浮点字段。"""
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _read_lines(path):
    """读取 session 文件的全部行；仅吞「glob 之后文件被清理」这一竞态。

    FileNotFoundError 是声明过的正常竞态（cell 清理与提取并发）。其余 OSError
    （权限、EIO、目录等）必须向上传播——静默返回空列表会让 cell 写出
    turns=0 / tokens=0 的假指标（ADR-0027 要消灭的假信号）。
    """
    try:
        with open(path, errors="replace") as fh:
            return fh.readlines()
    except FileNotFoundError:
        return []


def scan_sessions(cell_dir, trigger_tools):
    """扫描 <cell>/session/*.jsonl，汇总轮次 / 工具调用 / token / 成本 / 是否触发。

    损坏的 JSONL 行跳过——session 写入被中断（看门狗 TERM 等）是正常情况，
    不该让整个 cell 的指标提取失败。
    """
    turns = 0
    tool_calls = 0
    triggered = None if not trigger_tools else False
    totals = dict.fromkeys(TOKEN_KEYS, 0)
    cost = 0.0
    for path in glob.glob(os.path.join(cell_dir, "session", "*.jsonl")):
        for line in _read_lines(path):
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            msg = rec.get("message") or {}
            if msg.get("role") != "assistant":
                continue
            turns += 1
            usage = msg.get("usage") or {}
            for key in TOKEN_KEYS:
                totals[key] += _as_int(usage.get(key))
            cost_obj = usage.get("cost")
            if isinstance(cost_obj, dict):
                cost += _as_float(cost_obj.get("total"))
            for item in msg.get("content") or []:
                if not isinstance(item, dict) or item.get("type") != "toolCall":
                    continue
                tool_calls += 1
                if trigger_tools and str(item.get("name") or "") in trigger_tools:
                    triggered = True
    return turns, tool_calls, totals, cost, triggered


def build_result(cell_dir, wall_s, model, thinking, trigger_tools):
    """组装 result.json 的字典。成本口径 = provider 报告的 usage.cost.total 累加，不 hardcode 费率。"""
    turns, tool_calls, totals, cost, triggered = scan_sessions(cell_dir, trigger_tools)
    patch_path = os.path.join(cell_dir, PATCH_REL)
    return {
        "model": model,
        "thinking_level": thinking,
        "combined_total_tokens": totals["totalTokens"],
        "tokens_fresh_input": totals["input"] + totals["cacheWrite"],
        "tokens_cached_input": totals["cacheRead"],
        "tokens_output": totals["output"],
        "combined_cost_usd": round(cost, 6),
        "agent_wall_s": wall_s,
        "turns": turns,
        "tool_calls": tool_calls,
        "patch_bytes": os.path.getsize(patch_path) if os.path.exists(patch_path) else 0,
        "plugin_triggered": triggered,
    }


def main(argv):
    if len(argv) != 3:
        sys.stderr.write(
            "用法：TRIGGER_TOOLS=<a,b> metrics.py <cell-dir> <wall-seconds>\n"
        )
        return 2
    cell_dir = argv[1]
    try:
        wall_s = float(argv[2])
    except ValueError:
        sys.stderr.write(f"wall-seconds 必须是数字，got: {argv[2]!r}\n")
        return 2
    trigger_tools = [t for t in (os.environ.get("TRIGGER_TOOLS") or "").split(",") if t]
    result = build_result(
        cell_dir,
        wall_s,
        os.environ.get("BENCH_MODEL", ""),
        os.environ.get("BENCH_THINKING", "low"),
        trigger_tools,
    )
    out_path = os.path.join(cell_dir, "result.json")
    try:
        with open(out_path, "w") as fh:
            json.dump(result, fh, indent=2)
    except OSError as exc:
        sys.stderr.write(f"failed to write {out_path}: {exc}\n")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
