#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# selector 扩展（@zenone/pi-selector）端到端测试 — 普通模式
# 测试要点：
# 1. 选择器作为 Pi 扩展正确加载无报错
# 2. 选择器的 npm 包引用可被其他扩展正常使用
# ──────────────────────────────────────────────────────────────────────────────

test_describe "selector extension (@zenone/pi-selector)"

# ── 用例 1：单独加载无报错 ──
test_it "loads without errors" <<'TEST'
  run_pi_and_check \
    --extensions "selector" \
    --prompt "hi" \
    --save-output
  exit 0
TEST

# ── 用例 2：与其它扩展一起加载无冲突 ──
test_it "coexists with other extensions" <<'TEST'
  run_pi_and_check \
    --extensions "selector,commands" \
    --prompt "hi" \
    --save-output
  exit 0
TEST
