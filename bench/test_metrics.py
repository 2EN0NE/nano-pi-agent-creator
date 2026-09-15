#!/usr/bin/env python3
"""bench/metrics.py 的单元测试。

覆盖：轮次 / 工具调用 / token / 成本汇总、plugin_triggered 三态（null / false / true）、
损坏 JSONL 行的容错、非 assistant 记录过滤、patch 字节数、CLI 端到端写盘。

无第三方依赖，秒级可跑：
  python3 bench/test_metrics.py
"""

import json
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import metrics  # type: ignore  # noqa: E402 — 运行时经 sys.path 注入同目录模块


def _assistant(usage=None, tool_names=(), role="assistant"):
    return {
        "message": {
            "role": role,
            "usage": usage or {},
            "content": [{"type": "toolCall", "name": n} for n in tool_names],
        }
    }


def _usage(input=0, output=0, cache_read=0, cache_write=0, total=0, cost=None) -> dict:
    usage: dict = {
        "input": input,
        "output": output,
        "cacheRead": cache_read,
        "cacheWrite": cache_write,
        "totalTokens": total,
    }
    if cost is not None:
        usage["cost"] = {"total": cost}
    return usage


def _write_cell(cell_dir, records=(), raw_lines=(), patch=None):
    os.makedirs(os.path.join(cell_dir, "session"), exist_ok=True)
    with open(os.path.join(cell_dir, "session", "s.jsonl"), "w") as fh:
        for rec in records:
            fh.write(json.dumps(rec) + "\n")
        for line in raw_lines:
            fh.write(line + "\n")
    if patch is not None:
        os.makedirs(os.path.join(cell_dir, "artifacts"), exist_ok=True)
        with open(os.path.join(cell_dir, "artifacts", "model.patch"), "wb") as fh:
            fh.write(patch)


class MetricsTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.cell = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def test_totals_sum_across_assistant_turns(self):
        _write_cell(
            self.cell,
            [
                _assistant(_usage(input=10, output=2, cache_write=5, total=17)),
                _assistant(
                    _usage(input=3, cache_read=7, output=1, total=11, cost=0.25)
                ),
            ],
        )
        result = metrics.build_result(self.cell, 12.5, "m/x", "low", [])
        self.assertEqual(result["turns"], 2)
        self.assertEqual(result["combined_total_tokens"], 28)
        self.assertEqual(result["tokens_fresh_input"], 18)  # input + cacheWrite
        self.assertEqual(result["tokens_cached_input"], 7)
        self.assertEqual(result["tokens_output"], 3)
        self.assertEqual(result["combined_cost_usd"], 0.25)
        self.assertEqual(result["agent_wall_s"], 12.5)

    def test_non_assistant_records_ignored(self):
        _write_cell(
            self.cell,
            [
                _assistant(role="user"),
                {"message": {"role": "tool", "usage": _usage(total=99)}},
                _assistant(_usage(total=5)),
            ],
        )
        result = metrics.build_result(self.cell, 1.0, "m/x", "low", [])
        self.assertEqual(result["turns"], 1)
        self.assertEqual(result["combined_total_tokens"], 5)

    def test_corrupt_jsonl_line_skipped(self):
        _write_cell(
            self.cell,
            [_assistant(_usage(total=5))],
            raw_lines=['{"message": {"role": "assist', "not json at all"],
        )
        result = metrics.build_result(self.cell, 1.0, "m/x", "low", [])
        self.assertEqual(result["turns"], 1)
        self.assertEqual(result["combined_total_tokens"], 5)

    def test_non_numeric_usage_fields_zeroed(self):
        # usage 字段为字符串/None/非法值时归零而非抛异常（provider 字段类型不定）
        usage = {
            "input": "abc",
            "output": None,
            "cacheRead": "12x",
            "cacheWrite": [1, 2],
            "totalTokens": "  ",
            "cost": "not-a-dict",  # cost 非 dict → 不计成本，也不崩溃
        }
        _write_cell(self.cell, [_assistant(usage)])
        result = metrics.build_result(self.cell, 1.0, "m/x", "low", [])
        self.assertEqual(result["combined_total_tokens"], 0)
        self.assertEqual(result["tokens_fresh_input"], 0)
        self.assertEqual(result["tokens_cached_input"], 0)
        self.assertEqual(result["tokens_output"], 0)
        self.assertEqual(result["combined_cost_usd"], 0.0)

    def test_as_int_as_float_fallbacks(self):
        self.assertEqual(metrics._as_int(None), 0)
        self.assertEqual(metrics._as_int(""), 0)
        self.assertEqual(metrics._as_int("oops"), 0)
        self.assertEqual(metrics._as_int("42"), 42)
        self.assertEqual(metrics._as_float(None), 0.0)
        self.assertEqual(metrics._as_float("oops"), 0.0)
        self.assertAlmostEqual(metrics._as_float("1.5"), 1.5)

    def test_triggered_null_without_declared_tools(self):
        _write_cell(self.cell, [_assistant(_usage(total=1), tool_names=["rg"])])
        result = metrics.build_result(self.cell, 1.0, "m/x", "low", [])
        self.assertIsNone(result["plugin_triggered"])
        self.assertEqual(result["tool_calls"], 1)

    def test_triggered_false_when_declared_but_unused(self):
        _write_cell(self.cell, [_assistant(_usage(total=1), tool_names=["bash"])])
        result = metrics.build_result(self.cell, 1.0, "m/x", "low", ["rg"])
        self.assertIs(result["plugin_triggered"], False)

    def test_triggered_true_when_declared_tool_called(self):
        _write_cell(
            self.cell,
            [
                _assistant(_usage(total=1), tool_names=["bash"]),
                _assistant(_usage(total=1), tool_names=["ffgrep", "read"]),
            ],
        )
        result = metrics.build_result(self.cell, 1.0, "m/x", "low", ["rg", "ffgrep"])
        self.assertIs(result["plugin_triggered"], True)
        self.assertEqual(result["tool_calls"], 3)

    def test_patch_bytes_zero_when_absent(self):
        _write_cell(self.cell, [_assistant(_usage(total=1))])
        self.assertEqual(
            metrics.build_result(self.cell, 1.0, "m/x", "low", [])["patch_bytes"], 0
        )

    def test_patch_bytes_counted(self):
        patch = b"diff --git a/x b/x\n"
        _write_cell(self.cell, [], patch=patch)
        self.assertEqual(
            metrics.build_result(self.cell, 1.0, "m/x", "low", [])["patch_bytes"],
            len(patch),
        )

    @mock.patch("builtins.open", side_effect=PermissionError("denied"))
    def test_read_lines_propagates_non_race_oserror(self, _open):
        # 只吞「glob 后文件被清理」的 FileNotFoundError；权限/EIO 等必须大声失败，
        # 否则 cell 会静默写出 turns=0 的假指标（ADR-0027）。
        with self.assertRaises(PermissionError):
            metrics._read_lines("/nonexistent/session.jsonl")

    def test_cli_writes_result_json(self):
        _write_cell(self.cell, [_assistant(_usage(total=7), tool_names=["todo"])])
        os.environ["TRIGGER_TOOLS"] = "todo"
        os.environ["BENCH_MODEL"] = "deepseek/deepseek-v4-flash"
        try:
            self.assertEqual(metrics.main(["metrics.py", self.cell, "3.5"]), 0)
        finally:
            del os.environ["TRIGGER_TOOLS"]
            del os.environ["BENCH_MODEL"]
        with open(os.path.join(self.cell, "result.json")) as fh:
            written = json.load(fh)
        self.assertEqual(written["model"], "deepseek/deepseek-v4-flash")
        self.assertIs(written["plugin_triggered"], True)
        self.assertEqual(written["thinking_level"], "low")
        self.assertEqual(written["combined_total_tokens"], 7)

    def test_cli_rejects_wrong_arity(self):
        self.assertEqual(metrics.main(["metrics.py", self.cell]), 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
