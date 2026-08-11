#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# selector 扩展 (@zenone/pi-selector) — expect TUI 测试
# 迁移自 tui.smoke.test.sh (script+heredoc → expect)
# ──────────────────────────────────────────────────────────────────────────────

test_describe "selector extension (expect TUI mode)"

test_it "expect: loads in TUI mode without crash" <<'TEST'
  tui_expect_test "selector" '
  ' 15

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: TUI mode exited cleanly (code=$TUI_EXIT_CODE)"
  else
    echo "FAIL: TUI mode exited with code $TUI_EXIT_CODE (expected 0 or 124)"
    exit 1
  fi

  tui_assert_contains "selector" "Selector extension name appears in TUI output"
  tui_cleanup
TEST

test_it "expect: renders TUI welcome screen" <<'TEST'
  tui_expect_test "selector" '
  ' 15

  tui_assert_matches "pi v[0-9]+\.[0-9]+\.[0-9]+" "TUI welcome banner should show pi version"
  tui_assert_contains "Extensions" "Extensions section should appear"
  tui_cleanup
TEST

test_it "expect: works with pi-logger in TUI mode" <<'TEST'
  tui_expect_test "pi-logger,selector" '
  ' 15

  tui_assert_contains "pi-logger" "pi-logger should be in extension list"
  tui_assert_contains "selector" "selector should be in extension list"

  local padded
  padded=$(printf '%03d' "$CASE_INDEX")
  local log_dir="$CASE_DIR/${padded}-logs"
  if [[ -d "$log_dir" ]]; then
    local log_files
    log_files=$(find "$log_dir" -name "*.log" -type f 2>/dev/null | head -5)
    if [[ -n "$log_files" ]]; then
      echo "PASS: Log files exist:"
      echo "$log_files"
    else
      echo "WARN: No log files found in $log_dir"
    fi
  else
    echo "WARN: No logs directory captured"
  fi

  tui_cleanup
TEST

test_it "expect: importable via @zenone/pi-selector in TUI mode" <<'TEST'
  tui_expect_test "pi-logger,selector,skills" '
    send "/skills\r"
    sleep 3
  ' 15

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: TUI mode with selector+skills exited cleanly (code=$TUI_EXIT_CODE)"
  else
    echo "FAIL: Unexpected exit code $TUI_EXIT_CODE"
    exit 1
  fi

  tui_assert_contains "pi" "TUI should produce some output"
  tui_cleanup
TEST
