#!/usr/bin/env python3
"""bench/progress.py 的单元测试。

覆盖 progress.json 生命周期：init（含续跑）→ mark（running/done/failed/skipped）
→ 整体状态重算 → status 渲染 → is_complete 判定。

无第三方依赖，秒级可跑：
  python3 bench/test_progress.py
"""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import progress  # type: ignore  # noqa: E402 — 运行时经 sys.path 注入同目录模块


def _load(run_dir: str) -> dict:
    """读取 progress.json；init 之后必须存在，返回非 None。"""
    p = progress.load(run_dir)
    assert p is not None, f"progress.json should exist in {run_dir}"
    return p


def _write_manifest(
    run_dir,
    tasks="t1,t2",
    configs="none,plugin-x",
    reps=1,
    model="deepseek/deepseek-v4-flash",
    thinking="low",
    run_id="run-1",
):
    os.makedirs(run_dir, exist_ok=True)
    with open(os.path.join(run_dir, "manifest.json"), "w") as fh:
        json.dump(
            {
                "run_id": run_id,
                "tasks": tasks,
                "configs": configs,
                "reps": reps,
                "model": model,
                "thinking": thinking,
            },
            fh,
        )


class TestInit(unittest.TestCase):
    def test_builds_cells_in_task_config_rep_order(self):
        with tempfile.TemporaryDirectory() as d:
            _write_manifest(d, tasks="t1,t2", configs="none,plugin-x", reps=2)
            self.assertEqual(progress.cmd_init(d), 0)
            p = _load(d)
            self.assertEqual(p["total_cells"], 8)  # 2 tasks × 2 configs × 2 reps
            first = p["cells"][0]
            self.assertEqual(
                (first["task"], first["config"], first["rep"]), ("t1", "none", 0)
            )
            last = p["cells"][-1]
            self.assertEqual(
                (last["task"], last["config"], last["rep"]), ("t2", "plugin-x", 1)
            )
            self.assertEqual(p["status"], "running")
            self.assertIsNone(p["finished_at"])

    def test_init_requires_manifest(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(progress.cmd_init(d), 2)

    def test_scoped_config_slash_escaped(self):
        with tempfile.TemporaryDirectory() as d:
            _write_manifest(d, tasks="t1", configs="none,plugin-@scope/pkg", reps=1)
            progress.cmd_init(d)
            p = _load(d)
            configs = [c["config"] for c in p["cells"]]
            self.assertIn("plugin-@scope__pkg", configs)
            self.assertNotIn("plugin-@scope/pkg", configs)

    def test_resume_preserves_started_at_and_sets_resumed_at(self):
        with tempfile.TemporaryDirectory() as d:
            _write_manifest(d)
            progress.cmd_init(d)
            p1 = _load(d)
            started = p1["started_at"]
            self.assertIsNone(p1["resumed_at"])
            # 二次 init 模拟 --resume
            progress.cmd_init(d)
            p2 = _load(d)
            self.assertEqual(p2["started_at"], started)
            self.assertIsNotNone(p2["resumed_at"])


class TestMarkAndRecompute(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.run_dir = self._tmp.name
        _write_manifest(self.run_dir, tasks="t1", configs="none,plugin-x", reps=2)
        progress.cmd_init(self.run_dir)

    def tearDown(self):
        self._tmp.cleanup()

    def test_running_then_done_advances_counter(self):
        progress.cmd_mark(self.run_dir, ["none", "t1", "0", "running", "agent"])
        p = _load(self.run_dir)
        cell = p["cells"][0]
        self.assertEqual(cell["status"], "running")
        self.assertEqual(cell["phase"], "agent")
        self.assertIsNotNone(cell["started_at"])

        progress.cmd_mark(self.run_dir, ["none", "t1", "0", "done"])
        p = _load(self.run_dir)
        self.assertEqual(p["done_cells"], 1)
        self.assertEqual(p["status"], "running")  # 尚有 pending cell

    def test_all_done_yields_overall_done(self):
        for rep in range(2):
            for cfg in ("none", "plugin-x"):
                progress.cmd_mark(self.run_dir, [cfg, "t1", str(rep), "done"])
        p = _load(self.run_dir)
        self.assertEqual(p["status"], "done")
        self.assertEqual(p["done_cells"], 4)
        self.assertIsNotNone(p["finished_at"])

    def test_any_failed_yields_overall_failed(self):
        for rep in range(2):
            for cfg in ("none", "plugin-x"):
                progress.cmd_mark(self.run_dir, [cfg, "t1", str(rep), "done"])
        progress.cmd_mark(self.run_dir, ["none", "t1", "0", "failed", "boom"])
        p = _load(self.run_dir)
        self.assertEqual(p["status"], "failed")
        self.assertEqual(p["failed_cells"], 1)
        self.assertEqual(p["done_cells"], 3)

    def test_skipped_status(self):
        progress.cmd_mark(self.run_dir, ["none", "t1", "0", "skipped"])
        p = _load(self.run_dir)
        self.assertEqual(p["cells"][0]["status"], "skipped")
        self.assertIsNone(p["cells"][0]["started_at"])

    def test_skipped_counts_toward_done(self):
        # 续跑：已完成 cell 标 skipped，应计入 done_cells，避免「0/N done 但 status=done」的矛盾
        progress.cmd_mark(self.run_dir, ["none", "t1", "0", "skipped"])
        progress.cmd_mark(self.run_dir, ["plugin-x", "t1", "0", "done"])
        p = _load(self.run_dir)
        self.assertEqual(p["done_cells"], 2)  # 1 skipped + 1 done

    def test_mark_unknown_cell_errors(self):
        self.assertEqual(
            progress.cmd_mark(self.run_dir, ["nope", "t1", "0", "done"]), 2
        )


class TestIsComplete(unittest.TestCase):
    def test_missing_or_corrupt_or_no_reward_are_incomplete(self):
        with tempfile.TemporaryDirectory() as cell:
            self.assertEqual(progress.cmd_is_complete(cell), 1)
            with open(os.path.join(cell, "result.json"), "w") as fh:
                fh.write("{not json")
            self.assertEqual(progress.cmd_is_complete(cell), 1)
            with open(os.path.join(cell, "result.json"), "w") as fh:
                json.dump({"combined_total_tokens": 10}, fh)
            self.assertEqual(progress.cmd_is_complete(cell), 1)

    def test_result_with_reward_is_complete(self):
        with tempfile.TemporaryDirectory() as cell:
            with open(os.path.join(cell, "result.json"), "w") as fh:
                json.dump({"reward_binary": 0}, fh)
            self.assertEqual(progress.cmd_is_complete(cell), 0)


class TestStatusRender(unittest.TestCase):
    def test_status_smoke(self):
        with tempfile.TemporaryDirectory() as d:
            _write_manifest(d, tasks="t1", configs="none", reps=1)
            progress.cmd_init(d)
            progress.cmd_mark(d, ["none", "t1", "0", "running", "agent"])
            self.assertEqual(progress.cmd_status(d), 0)

    def test_status_missing_progress(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(progress.cmd_status(d), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
