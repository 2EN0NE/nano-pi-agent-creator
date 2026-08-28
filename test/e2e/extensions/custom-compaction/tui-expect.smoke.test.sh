#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# custom-compaction — expect TUI 测试
# 验证：扩展在 TUI 模式加载不崩、/custom-compaction-setting 打开面板、
# 纯横线边框（ADR-0023）由 [REVIEW] 人工确认。
# ──────────────────────────────────────────────────────────────────────────────

test_describe "custom-compaction (expect TUI mode)"

test_it "expect: loads extension in TUI mode without crash" <<'TEST'
  tui_expect_test "custom-compaction" '
    send "/custom-compaction-setting\r"
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

  tui_assert_contains "custom-compaction" "Extension name in TUI output"
  tui_cleanup
TEST

test_it "expect: settings panel renders pure-horizontal border [REVIEW]" <<'TEST'
  tui_expect_test "custom-compaction" '
    send "/custom-compaction-setting\r"
    sleep 3
  ' 15

  # PTY 无法可靠还原 overlay，纯横线边框（── custom-compaction）只能人工确认
  mark_for_review "检查设置面板：顶边框为纯横线 '── custom-compaction'，无圆角字符（╭╮）、无竖线（│）"
  tui_cleanup
TEST

test_it "expect: settings panel produces pi-logger output [REVIEW]" <<'TEST'
  tui_expect_test "custom-compaction" '
    send "/custom-compaction-setting\r"
    sleep 3
    send "\x1b"
    sleep 1
  ' 15

  local padded
  padded=$(printf '%03d' "$CASE_INDEX")
  local log_dir="$CASE_DIR/${padded}-logs"
  if [[ -d "$log_dir" ]]; then
    echo "PASS: Log files found:"
    find "$log_dir" -name "*.log" -type f 2>/dev/null | sed 's/^/  /'
  else
    echo "WARN: No logs directory captured"
  fi

  tui_cleanup
  mark_for_review "检查日志文件，确认 custom-compaction 面板打开/关闭被正确记录"
TEST
