#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# answer 扩展 smoke 测试
# 验证：
# 1. 扩展加载无崩溃
# ──────────────────────────────────────────────────────────────────────────────

test_describe "answer extension"

test_it "loads without errors" <<'TEST'
  run_pi_and_check \
    --extensions "answer" \
    --prompt "hi" \
    --save-output
  exit 0
TEST
