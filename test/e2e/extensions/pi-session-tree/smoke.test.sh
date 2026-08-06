#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# pi-session-tree smoke test
# 验证：
# 1. 扩展在 print 模式下正确加载（无报错）
# 2. 库函数 createSessionTree 可用（通过单元测试覆盖 — 32 cases）
# ──────────────────────────────────────────────────────────────────────────────

test_describe "pi-session-tree extension"

test_it "loads extension without errors" <<'TEST'
  run_pi_and_check \
    --extensions "pi-session-tree" \
    --prompt "hi" \
    --expect-no-error

  echo "Extension loaded successfully"
TEST
