#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# pi-shortcuts — expect TUI 测试
# 验证：扩展在 TUI 模式加载不崩、/shortcuts 打开快捷键编辑器、
# 纯横线边框（ADR-0023）由 [REVIEW] 人工确认。
# ──────────────────────────────────────────────────────────────────────────────

test_describe "pi-shortcuts (expect TUI mode)"

test_it "expect: loads extension in TUI mode without crash" <<'TEST'
  tui_expect_test "pi-logger,pi-config,pi-shortcuts" '
    send "/shortcuts\r"
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

test_it "expect: /shortcuts opens editor [REVIEW]" <<'TEST'
  tui_expect_test "pi-logger,pi-config,pi-shortcuts" '
    send "/shortcuts\r"
    sleep 3
  ' 15

  tui_assert_contains "shortcuts" "/shortcuts command should appear in TUI output"
  tui_cleanup
  mark_for_review "检查快捷键编辑器：顶边框为纯横线 '── 快捷键设置'，无方角（┌┐└┘）、无竖线（│）"
TEST
