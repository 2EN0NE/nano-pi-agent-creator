#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# unified-edit 扩展 smoke 测试
# 验证：
# 1. 扩展加载无崩溃
# ──────────────────────────────────────────────────────────────────────────────

test_describe "unified-edit extension (experimental, upstream)"

test_it "loads without errors" <<'TEST'
  run_pi_and_check \
    --extensions "unified-edit" \
    --prompt "hi" \
    --save-output
  exit 0
TEST
