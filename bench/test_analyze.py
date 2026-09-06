#!/usr/bin/env python3
"""bench/analyze.py 统计口径的单元测试。

覆盖 ADR-0027 的核心语义：
  - exact_mcnemar：配对解决翻转的显著性检验（含 n=0 边界）
  - summarize：per-config 聚合 + plugin_triggered 触发率分层
  - collect：results/<run>/<config>/<task>/repN/result.json 的路径解析
  - main：paired_none_vs_plugin-* 边际价值（未触发 cell 不混入 delta）

无第三方依赖（仅标准库 unittest），CI 秒级可跑：
  python3 bench/test_analyze.py
"""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import analyze  # noqa: E402


class TestExactMcNemar(unittest.TestCase):
    def test_no_discordant_pairs_returns_one(self):
        # 无翻转对 → 无法拒绝原假设，p=1.0
        self.assertEqual(analyze.exact_mcnemar(0, 0), 1.0)

    def test_single_discordant_pair(self):
        # k=0 → 2 * C(1,0)/2^1 = 1.0（截断到 1.0）
        self.assertEqual(analyze.exact_mcnemar(1, 0), 1.0)

    def test_two_sided_symmetry(self):
        self.assertEqual(analyze.exact_mcnemar(2, 0), 0.5)
        self.assertEqual(analyze.exact_mcnemar(0, 2), 0.5)

    def test_known_value(self):
        # a=3,b=1: k=1, sum C(4,i) i=0..1 = 5, tail=5/16, 2*tail=0.625
        self.assertAlmostEqual(analyze.exact_mcnemar(3, 1), 0.625)

    def test_p_value_capped_at_one(self):
        # a=1,b=1: k=1, sum C(2,0)+C(2,1)=3, tail=0.75, 2*tail=1.5 → min(1.0)
        self.assertEqual(analyze.exact_mcnemar(1, 1), 1.0)


class TestMedianMean(unittest.TestCase):
    def test_empty_returns_none(self):
        self.assertIsNone(analyze.median([], "x"))
        self.assertIsNone(analyze.mean([], "x"))

    def test_median(self):
        rows = [{"v": 3}, {"v": 1}, {"v": 2}]
        self.assertEqual(analyze.median(rows, "v"), 2)

    def test_median_skips_missing(self):
        rows = [{"v": 10}, {}, {"v": 20}]
        self.assertEqual(analyze.median(rows, "v"), 15)

    def test_mean_rounds_4(self):
        rows = [{"v": 1}, {"v": 2}, {"v": 4}]
        self.assertEqual(analyze.mean(rows, "v"), 2.3333)


class TestSummarize(unittest.TestCase):
    def test_empty(self):
        s = analyze.summarize([])
        self.assertEqual(s["n"], 0)
        self.assertEqual(s["solves"], 0)
        self.assertIsNone(s["mean_partial"])
        self.assertEqual(s["triggered"], 0)
        self.assertEqual(s["untriggered"], 0)

    def test_solves_and_trigger_rate(self):
        rows = [
            {"reward_binary": 1, "reward_partial": 1.0, "plugin_triggered": True},
            {"reward_binary": 0, "reward_partial": 0.5, "plugin_triggered": False},
            {"reward_binary": 1, "reward_partial": 0.8, "plugin_triggered": True},
        ]
        s = analyze.summarize(rows)
        self.assertEqual(s["n"], 3)
        self.assertEqual(s["solves"], 2)
        self.assertEqual(s["triggered"], 2)
        self.assertEqual(s["untriggered"], 1)
        # summarize 对 mean_partial 做 round(..., 4)
        self.assertAlmostEqual(s["mean_partial"], 0.7667, places=4)


class TestCollect(unittest.TestCase):
    def test_parses_nested_result_paths(self):
        with tempfile.TemporaryDirectory() as d:
            cell = os.path.join(d, "none", "task-a", "rep0")
            os.makedirs(cell)
            with open(os.path.join(cell, "result.json"), "w") as fh:
                json.dump({"reward_binary": 1}, fh)

            cells = analyze.collect(d)
            self.assertEqual(len(cells), 1)
            self.assertEqual(cells[0]["config"], "none")
            self.assertEqual(cells[0]["task"], "task-a")
            self.assertEqual(cells[0]["rep"], "rep0")
            self.assertTrue(cells[0]["path"].endswith(cell))


class TestMainPairedAnalysis(unittest.TestCase):
    """端到端验证 paired_none_vs_plugin-* 边际价值口径（ADR-0027）。"""

    def _write_cell(self, run_dir, config, task, rep, **fields):
        cell = os.path.join(run_dir, config, task, f"rep{rep}")
        os.makedirs(cell)
        with open(os.path.join(cell, "result.json"), "w") as fh:
            json.dump(fields, fh)
        return cell

    def _run_main(self, run_dir):
        old = sys.argv
        sys.argv = ["analyze.py", run_dir]
        try:
            analyze.main()
        finally:
            sys.argv = old
        with open(os.path.join(run_dir, "analysis-summary.json")) as fh:
            return json.load(fh)

    def test_untriggered_plugin_cell_excluded_from_delta(self):
        with tempfile.TemporaryDirectory() as d:
            run_dir = os.path.join(d, "run")
            # none 臂解决，plugin 臂未触发（plugin_triggered=False）→ 应被排除
            self._write_cell(
                run_dir,
                "none",
                "t",
                0,
                reward_binary=1,
                reward_partial=1.0,
                combined_total_tokens=100,
                combined_cost_usd=0.1,
                plugin_triggered=None,
            )
            self._write_cell(
                run_dir,
                "plugin-x",
                "t",
                0,
                reward_binary=0,
                reward_partial=0.0,
                combined_total_tokens=200,
                combined_cost_usd=0.2,
                plugin_triggered=False,
            )

            summary = self._run_main(run_dir)
            paired = summary["paired_none_vs_plugin-x"]
            self.assertEqual(paired["n_pairs"], 0)
            self.assertEqual(paired["n_untriggered_excluded"], 1)
            self.assertIsNone(paired["median_token_delta"])

    def test_triggered_plugin_cell_included_and_solve_flip(self):
        with tempfile.TemporaryDirectory() as d:
            run_dir = os.path.join(d, "run")
            # none 解决、plugin 未解决 → right_only=0, left_only=1（none 单边解决）
            self._write_cell(
                run_dir,
                "none",
                "t",
                0,
                reward_binary=1,
                reward_partial=1.0,
                combined_total_tokens=100,
                combined_cost_usd=0.1,
                plugin_triggered=None,
            )
            self._write_cell(
                run_dir,
                "plugin-x",
                "t",
                0,
                reward_binary=0,
                reward_partial=0.0,
                combined_total_tokens=250,
                combined_cost_usd=0.3,
                plugin_triggered=True,
            )

            summary = self._run_main(run_dir)
            paired = summary["paired_none_vs_plugin-x"]
            self.assertEqual(paired["n_pairs"], 1)
            self.assertEqual(paired["n_untriggered_excluded"], 0)
            self.assertEqual(paired["solve_flips_left_only"], 1)
            self.assertEqual(paired["solve_flips_right_only"], 0)
            # token delta = 250 - 100 = 150
            self.assertEqual(paired["median_token_delta"], 150)
            self.assertAlmostEqual(paired["median_cost_delta"], 0.2, places=6)

    def test_no_baseline_config_skips_paired_analysis(self):
        with tempfile.TemporaryDirectory() as d:
            run_dir = os.path.join(d, "run")
            self._write_cell(
                run_dir,
                "plugin-x",
                "t",
                0,
                reward_binary=0,
                combined_total_tokens=100,
                combined_cost_usd=0.1,
                plugin_triggered=True,
            )

            summary = self._run_main(run_dir)
            # 无 none 基线 → 不产出任何 paired_none_vs_* 键
            paired_keys = [k for k in summary if k.startswith("paired_none_vs_")]
            self.assertEqual(paired_keys, [])
            self.assertIn("plugin-x", summary["per_config"])


class TestErrorCells(unittest.TestCase):
    """损坏/不完整 cell 单列 error_cells，不进任何统计（快速失败而非静默归并）。"""

    def test_load_json_corrupt_raises(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "result.json")
            with open(p, "w") as fh:
                fh.write('{"reward_binary": 0, "trunc')
            with self.assertRaises(ValueError):
                analyze.load_json(p)

    def _run_main(self, run_dir):
        old = sys.argv
        sys.argv = ["analyze.py", run_dir]
        try:
            analyze.main()
        finally:
            sys.argv = old
        with open(os.path.join(run_dir, "analysis-summary.json")) as fh:
            return json.load(fh)

    def test_corrupt_cell_excluded_and_listed(self):
        with tempfile.TemporaryDirectory() as d:
            run_dir = os.path.join(d, "run")
            cell = os.path.join(run_dir, "none", "t", "rep0")
            os.makedirs(cell)
            with open(os.path.join(cell, "result.json"), "w") as fh:
                fh.write('{"reward_binary": 1, "trunc')  # 截断（模拟被看门狗 TERM）
            # 另加一个健康 cell，确保主统计仍产出
            ok = os.path.join(run_dir, "plugin-x", "t", "rep0")
            os.makedirs(ok)
            with open(os.path.join(ok, "result.json"), "w") as fh:
                json.dump(
                    {
                        "reward_binary": 0,
                        "reward_partial": 0.0,
                        "combined_total_tokens": 200,
                        "combined_cost_usd": 0.2,
                        "plugin_triggered": True,
                    },
                    fh,
                )

            summary = self._run_main(run_dir)
            self.assertEqual(len(summary["error_cells"]), 1)
            self.assertEqual(summary["error_cells"][0]["config"], "none")
            self.assertIn("corrupt", summary["error_cells"][0]["reason"])
            # 坏 cell 不进 per_config 聚合
            self.assertNotIn("none", summary["per_config"])
            # 唯一 none cell 已损坏 → 无 none 基线 → 不产出配对分析（而非把坏 cell 当「未解决」计入）
            self.assertEqual(
                [k for k in summary if k.startswith("paired_none_vs_")], []
            )
            self.assertIn("plugin-x", summary["per_config"])

    def test_missing_reward_key_excluded_and_listed(self):
        with tempfile.TemporaryDirectory() as d:
            run_dir = os.path.join(d, "run")
            cell = os.path.join(run_dir, "none", "t", "rep0")
            os.makedirs(cell)
            # valid JSON 但无 reward_binary（verify.sh 未跑完）
            with open(os.path.join(cell, "result.json"), "w") as fh:
                json.dump({"combined_total_tokens": 100, "plugin_triggered": None}, fh)

            summary = self._run_main(run_dir)
            self.assertEqual(len(summary["error_cells"]), 1)
            self.assertIn("reward_binary", summary["error_cells"][0]["reason"])
            self.assertNotIn("none", summary["per_config"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
