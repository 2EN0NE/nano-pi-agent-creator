#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# btw — expect TUI 测试
# 验证：扩展在 TUI 模式加载不崩、/btw 打开侧边对话覆盖层、
# 纯横线边框（ADR-0023）由 [REVIEW] 人工确认。
# ──────────────────────────────────────────────────────────────────────────────

test_describe "btw (expect TUI mode)"

test_it "expect: loads extension in TUI mode without crash" <<'TEST'
  tui_expect_test "btw" '
    send "/btw\r"
    sleep 3
    send "\x1b"
    sleep 1
  ' 15

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: TUI mode exited cleanly (code=$TUI_EXIT_CODE)"
  else
    echo "FAIL: TUI mode exited with code $TUI_EXIT_CODE (expected 0 or 124)"
    exit 1
  fi

  tui_cleanup
TEST

test_it "expect: /btw opens side-chat overlay [REVIEW]" <<'TEST'
  tui_expect_test "btw" '
    send "/btw\r"
    sleep 3
  ' 15

  tui_assert_contains "btw" "/btw command should appear in TUI output"
  tui_cleanup
  mark_for_review "检查侧边对话覆盖层：顶边框为纯横线 '── btw'，无竖线（│）、无方角（┌┐└┘）"
TEST
