#!/usr/bin/env python3
"""Paired analysis for the nano plugin benchmark.

Reads results/<run_id>/<config>/<task>/rep<N>/result.json and reports
per-config aggregates and paired marginal-value deltas (none vs plugin-*).
Plugin cells carry a `plugin_triggered` flag; untriggered cells are excluded
from the marginal-value delta and reported separately as a trigger rate.
"""

from __future__ import annotations

import glob
import json
import math
import os
import statistics
import sys

BASELINE_CONFIG = "none"


def load_json(path):
    """Read a cell's result.json. Fast-fail: never silently return {}.

    截断/损坏的文件若被当作「未解决」数据点，会把一次验证超时/写盘崩溃静默统计成
    「插件无效」，正是统计口径的反面（ADR-0027）。因此解析失败带上下文重新抛出，
    由调用方（main，CLI 边界）把坏 cell 单列 error_cells 计数。
    """
    try:
        with open(path) as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"unreadable or corrupt result.json: {path}: {exc}") from exc


def exact_mcnemar(a, b):
    n = a + b
    if n == 0:
        return 1.0
    k = min(a, b)
    tail = sum(math.comb(n, i) for i in range(k + 1)) / (2**n)
    return min(1.0, 2 * tail)


def median(rows, key):
    vals = [r.get(key) for r in rows if r.get(key) is not None]
    return statistics.median(vals) if vals else None


def mean(rows, key):
    vals = [r.get(key) for r in rows if r.get(key) is not None]
    return round(statistics.mean(vals), 4) if vals else None


def summarize(rows):
    solved = sum(1 for r in rows if r.get("reward_binary") == 1)
    partials = [
        r["reward_partial"] for r in rows if r.get("reward_partial") is not None
    ]
    triggered = [r for r in rows if r.get("plugin_triggered") == True]  # noqa: E712 — json 解析产物为真 bool，== 语义与 is 等价
    untriggered = [r for r in rows if r.get("plugin_triggered") == False]  # noqa: E712
    return {
        "n": len(rows),
        "solves": solved,
        "mean_partial": round(statistics.mean(partials), 4) if partials else None,
        "median_tokens": median(rows, "combined_total_tokens"),
        "median_cost": median(rows, "combined_cost_usd"),
        "median_wall_s": median(rows, "agent_wall_s"),
        "median_turns": median(rows, "turns"),
        "median_tool_calls": median(rows, "tool_calls"),
        "triggered": len(triggered),
        "untriggered": len(untriggered),
    }


def collect(run_dir):
    cells = []
    for result in glob.glob(os.path.join(run_dir, "*", "*", "rep*", "result.json")):
        cell = os.path.dirname(result)
        rel = os.path.relpath(cell, run_dir)
        config, task, rep = rel.split(os.sep)
        cells.append(
            {
                "config": config,
                "task": task,
                "rep": rep,
                "path": cell,
            }
        )
    return cells


def main():
    run_dir = sys.argv[1]
    rows = []
    error_cells = []
    for cell in collect(run_dir):
        result_path = os.path.join(cell["path"], "result.json")
        try:
            res = load_json(result_path)
        except ValueError as exc:
            error_cells.append({**cell, "reason": str(exc)})
            continue
        if "reward_binary" not in res:
            # verify.sh 未跑完/崩溃（被看门狗 TERM 等）的 cell：valid JSON 但无 reward。
            # 计入 error_cells，不当作「未解决」混入配对翻转统计。
            error_cells.append(
                {
                    **cell,
                    "reason": "missing reward_binary (verify.sh 未完成或崩溃)",
                }
            )
            continue
        rows.append({**cell, **res})
    configs = sorted({r["config"] for r in rows})
    summary = {"run_dir": run_dir, "per_config": {}, "per_task": {}}

    for cfg in configs:
        summary["per_config"][cfg] = summarize([r for r in rows if r["config"] == cfg])
    for task in sorted({r["task"] for r in rows}):
        summary["per_task"][task] = {
            cfg: summarize(
                [r for r in rows if r["task"] == task and r["config"] == cfg]
            )
            for cfg in configs
            if any(r["task"] == task and r["config"] == cfg for r in rows)
        }
    if error_cells:
        summary["error_cells"] = error_cells
        sys.stderr.write(
            f"WARNING: {len(error_cells)} corrupt/incomplete cell(s) excluded from "
            f"stats (listed in summary['error_cells']):\n"
        )
        for e in error_cells:
            sys.stderr.write(
                f"  - {e['config']}/{e['task']}/{e['rep']}: {e['reason']}\n"
            )

    # 配对边际价值：none vs 每个 plugin-* config
    pairs = {}
    for r in rows:
        pairs.setdefault((r["task"], r["rep"]), {})[r["config"]] = r

    if BASELINE_CONFIG in configs:
        others = [c for c in configs if c != BASELINE_CONFIG]
        for other in others:
            # 触发口径：plugin 臂里 plugin_triggered 为 True（或未声明=null，无法判断触发，照常纳入）
            paired = [
                (pv[BASELINE_CONFIG], pv[other])
                for pv in pairs.values()
                if BASELINE_CONFIG in pv and other in pv
            ]
            triggered_pairs = [
                (a, b) for a, b in paired if b.get("plugin_triggered") in (True, None)
            ]
            left_only = sum(
                1
                for a, b in triggered_pairs
                if a.get("reward_binary") == 1 and b.get("reward_binary") != 1
            )
            right_only = sum(
                1
                for a, b in triggered_pairs
                if a.get("reward_binary") != 1 and b.get("reward_binary") == 1
            )
            tok_delta = [
                b["combined_total_tokens"] - a["combined_total_tokens"]
                for a, b in triggered_pairs
                if a.get("combined_total_tokens") is not None
                and b.get("combined_total_tokens") is not None
            ]
            cost_delta = [
                b["combined_cost_usd"] - a["combined_cost_usd"]
                for a, b in triggered_pairs
                if a.get("combined_cost_usd") is not None
                and b.get("combined_cost_usd") is not None
            ]
            summary[f"paired_none_vs_{other}"] = {
                "n_pairs": len(triggered_pairs),
                "n_untriggered_excluded": len(paired) - len(triggered_pairs),
                "solve_flips_left_only": left_only,
                "solve_flips_right_only": right_only,
                "mcnemar_p": round(exact_mcnemar(left_only, right_only), 4),
                "median_token_delta": statistics.median(tok_delta)
                if tok_delta
                else None,
                "mean_token_delta": mean(
                    [{"combined_total_tokens": d} for d in tok_delta],
                    "combined_total_tokens",
                )
                if tok_delta
                else None,
                "median_cost_delta": statistics.median(cost_delta)
                if cost_delta
                else None,
            }

    out_path = os.path.join(run_dir, "analysis-summary.json")
    try:
        with open(out_path, "w") as fh:
            json.dump(summary, fh, indent=2)
    except OSError as exc:
        sys.stderr.write(f"failed to write {out_path}: {exc}\n")
        sys.exit(1)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
