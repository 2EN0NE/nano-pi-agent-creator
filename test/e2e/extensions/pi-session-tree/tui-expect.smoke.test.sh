#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# pi-session-tree v2 — expect TUI 测试
#
# 迁移自 tui.smoke.test.sh (script+heredoc → expect)
# print 模式测试（/tree-stats）不受影响，仅迁移 TUI 部分。
# ──────────────────────────────────────────────────────────────────────────────

test_describe "pi-session-tree v2 (expect TUI mode)"

test_it "expect: extension loads in TUI mode without crash" <<'TEST'
  tui_expect_test "pi-session-tree" '
    send "/quit\r"
    expect eof
  ' 15

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: TUI mode exited cleanly (code=$TUI_EXIT_CODE)"
  else
    echo "FAIL: TUI mode exited with code $TUI_EXIT_CODE (expected 0 or 124)"
    exit 1
  fi

  tui_cleanup
TEST
