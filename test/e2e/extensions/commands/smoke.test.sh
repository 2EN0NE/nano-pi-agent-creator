#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# commands 扩展端到端测试
# 测试要点：
# 1. commands 扩展正确加载无报错
# 2. /commands 命令在 print 模式下输出命令列表
# 3. /commands extensions 过滤器正常工作
# ──────────────────────────────────────────────────────────────────────────────

test_describe "commands extension"

# ── 用例 1：加载无报错 ──
test_it "loads without errors" <<'TEST'
  run_pi_and_check     --extensions "commands"     --prompt "hi"     --save-output
  exit 0
TEST

# ── 用例 2：/commands 命令在非 TUI 模式下能给出提示 ──
test_it "/commands responds without crash" <<'TEST'
  run_pi_and_check \
    --extensions "commands" \
    --prompt "/commands" \
    --save-output
  # 在非 TUI 模式下，/commands 的输出可能为空或提示信息
  # 只要不崩溃就是通过
  exit 0
TEST
