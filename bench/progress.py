#!/usr/bin/env python3
"""bench 进度管理：progress.json 的读写与状态查询。

这是 run-matrix.sh（编排层）与 bench-status.sh / agent（查询层）之间的
结构化契约，避免靠解析 stdout 判断进度。后台跑 bench 时，agent 通过
`progress.py status <run_dir>` 回答「跑到哪了 / 还剩多少 / 哪些失败」。

progress.json schema（位于 results/<run-id>/progress.json）：
{
  "run_id": "run-...",
  "status": "pending|running|done|failed",
  "started_at": "<iso-utc>", "finished_at": null,
  "resumed_at": null,
  "model": "...", "thinking": "...",
  "total_cells": N, "done_cells": N（含 skipped）, "failed_cells": N,
  "cells": [
    {
      "config": "none|plugin-<name>（目录安全名，/ 已转义为 __）",
      "task": "<slug>",
      "rep": 0,
      "status": "pending|running|done|failed|skipped",
      "phase": "clone|agent|metrics|verify|null",
      "started_at": null, "finished_at": null, "error": null
    }
  ]
}

用法：
  progress.py init <run_dir>                  # 读 manifest.json → 生成/续跑 progress.json
  progress.py mark <run_dir> <config> <task> <rep> <status> [phase|error]
  progress.py status <run_dir>                # 人类可读进度
  progress.py is_complete <cell_dir>          # exit 0 = 已完成（result.json 含 reward_binary）
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone

TERMINAL_CELL_STATUSES = {"done", "failed", "skipped"}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _safe(config: str) -> str:
    """config 名 → 目录安全名（scoped npm 包 @scope/pkg 的 / 转义为 __）。"""
    return config.replace("/", "__")


def build_cells(manifest: dict) -> list[dict]:
    """从 manifest.json 推导完整 cell 列表（task → config → rep 顺序）。"""
    tasks = [t for t in str(manifest.get("tasks", "")).split(",") if t]
    configs = [c for c in str(manifest.get("configs", "")).split(",") if c]
    try:
        reps = int(manifest.get("reps", 1))
    except (TypeError, ValueError):
        raise ValueError("manifest['reps'] 必须是整数") from None
    cells = []
    for task in tasks:
        for config in configs:
            for rep in range(reps):
                cells.append(
                    {
                        "config": _safe(config),
                        "task": task,
                        "rep": rep,
                        "status": "pending",
                        "phase": None,
                        "started_at": None,
                        "finished_at": None,
                        "error": None,
                    }
                )
    return cells


def load(run_dir: str) -> dict | None:
    """读取 progress.json；缺失或损坏返回 None（损坏由调用方决定是否报错）。"""
    path = os.path.join(run_dir, "progress.json")
    if not os.path.isfile(path):
        return None
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError):
        return None


def save(run_dir: str, progress: dict) -> None:
    path = os.path.join(run_dir, "progress.json")
    tmp = path + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(progress, fh, indent=2)
        os.replace(tmp, path)
    except OSError as exc:
        raise ValueError(f"failed to write {path}: {exc}") from exc


def recompute(progress: dict) -> None:
    # skipped 是续跑时跳过的已完成 cell，计入 done_cells，避免「0/N done 但 status=done」的矛盾
    done = sum(1 for c in progress["cells"] if c["status"] in ("done", "skipped"))
    failed = sum(1 for c in progress["cells"] if c["status"] == "failed")
    progress["done_cells"] = done
    progress["failed_cells"] = failed
    terminal = all(c["status"] in TERMINAL_CELL_STATUSES for c in progress["cells"])
    if terminal:
        progress["status"] = "failed" if failed > 0 else "done"
        if progress.get("finished_at") is None:
            progress["finished_at"] = now_iso()
    else:
        progress["status"] = "running"


def _read_manifest(run_dir: str) -> dict:
    manifest_path = os.path.join(run_dir, "manifest.json")
    if not os.path.isfile(manifest_path):
        raise ValueError(f"manifest.json not found in {run_dir}")
    try:
        with open(manifest_path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"unreadable manifest.json in {run_dir}: {exc}") from exc


def cmd_init(run_dir: str) -> int:
    try:
        manifest = _read_manifest(run_dir)
        cells = build_cells(manifest)
    except ValueError as exc:
        sys.stderr.write(f"init failed: {exc}\n")
        return 2
    previous = load(run_dir)
    progress = {
        "run_id": manifest.get("run_id", os.path.basename(run_dir)),
        "status": "running",
        # 续跑保留原始 started_at，另记 resumed_at；全新跑二者分离
        "started_at": (previous or {}).get("started_at") or now_iso(),
        "finished_at": None,
        "resumed_at": now_iso() if previous is not None else None,
        "model": manifest.get("model"),
        "thinking": manifest.get("thinking"),
        "total_cells": 0,
        "done_cells": 0,
        "failed_cells": 0,
        "cells": cells,
    }
    progress["total_cells"] = len(progress["cells"])
    recompute(progress)
    save(run_dir, progress)
    return 0


def _find_cell(progress: dict, config: str, task: str, rep: int) -> dict | None:
    for c in progress["cells"]:
        if c["config"] == config and c["task"] == task and c["rep"] == rep:
            return c
    return None


def cmd_mark(run_dir: str, argv: list[str]) -> int:
    if len(argv) < 4:
        sys.stderr.write(
            "usage: progress.py mark <run_dir> <config> <task> <rep> <status> [phase|error]\n"
        )
        return 2
    config, task = argv[0], argv[1]
    try:
        rep = int(argv[2])
    except ValueError:
        sys.stderr.write(f"invalid rep: {argv[2]}\n")
        return 2
    status = argv[3]
    extra = argv[4] if len(argv) > 4 else None

    progress = load(run_dir)
    if progress is None:
        sys.stderr.write(
            f"progress.json not found in {run_dir}（先 progress.py init）\n"
        )
        return 2
    cell = _find_cell(progress, _safe(config), task, rep)
    if cell is None:
        sys.stderr.write(f"cell not found: {config}/{task}/rep{rep}\n")
        return 2

    cell["status"] = status
    if status == "running":
        if cell.get("started_at") is None:
            cell["started_at"] = now_iso()
        cell["phase"] = extra
        cell["error"] = None
    elif status == "done":
        cell["finished_at"] = now_iso()
        cell["phase"] = None
        cell["error"] = None
    elif status == "failed":
        cell["finished_at"] = now_iso()
        cell["phase"] = None
        cell["error"] = extra or "run-cell failed"
    else:  # skipped
        cell["started_at"] = None
        cell["finished_at"] = None
        cell["phase"] = None
        cell["error"] = None

    recompute(progress)
    save(run_dir, progress)
    return 0


def _elapsed_s(progress: dict) -> int | None:
    started = progress.get("started_at")
    if not started:
        return None
    try:
        t = datetime.fromisoformat(started)
        if t.tzinfo is None:
            t = t.replace(tzinfo=timezone.utc)
        delta = datetime.now(timezone.utc) - t
    except (ValueError, TypeError):
        return None
    try:
        seconds = int(delta.total_seconds())
    except (OverflowError, ValueError):
        return None
    return max(0, seconds)


def _fmt_duration(seconds: int | None) -> str:
    if seconds is None:
        return "?"
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h}h{m:02d}m{s:02d}s"


def cmd_status(run_dir: str) -> int:
    progress = load(run_dir)
    if progress is None:
        print(f"no progress.json in {run_dir}")
        return 1

    print(
        f"run: {progress['run_id']}  status: {progress['status']}  "
        f"model: {progress.get('model')}"
    )
    print(
        f"progress: {progress['done_cells']}/{progress['total_cells']} cells done "
        f"({progress['failed_cells']} failed)"
    )
    resumed = (
        f"  resumed_at: {progress['resumed_at']}" if progress.get("resumed_at") else ""
    )
    print(f"elapsed: {_fmt_duration(_elapsed_s(progress))}{resumed}")

    mark = {
        "pending": "[pending]",
        "running": "[running]",
        "done": "[done]",
        "failed": "[failed]",
        "skipped": "[skip  ]",
    }
    for c in progress["cells"]:
        phase = f" ({c['phase']})" if c.get("phase") else ""
        line = f"  {mark.get(c['status'], c['status'])}  {c['config']} / {c['task']} / rep{c['rep']}{phase}"
        print(line)

    failed_cells = [c for c in progress["cells"] if c["status"] == "failed"]
    if failed_cells:
        print("failed cells:")
        for c in failed_cells:
            print(
                f"  - {c['config']}/{c['task']}/rep{c['rep']}: {c.get('error') or '?'}"
            )
    return 0


def cmd_is_complete(cell_dir: str) -> int:
    rp = os.path.join(cell_dir, "result.json")
    if not os.path.isfile(rp):
        return 1
    try:
        with open(rp, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError):
        return 1
    return 0 if "reward_binary" in data else 1


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        sys.stderr.write(__doc__ or "see usage\n")
        return 2
    cmd, run_dir = argv[0], argv[1]
    rest = argv[2:]
    try:
        if cmd == "init":
            return cmd_init(run_dir)
        if cmd == "mark":
            return cmd_mark(run_dir, rest)
        if cmd == "status":
            return cmd_status(run_dir)
        if cmd == "is_complete":
            return cmd_is_complete(run_dir)
    except ValueError as exc:
        sys.stderr.write(f"progress.py {cmd}: {exc}\n")
        return 2
    sys.stderr.write(f"unknown command: {cmd}\n")
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
