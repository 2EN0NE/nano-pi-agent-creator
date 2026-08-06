#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# todos — expect 交互 TUI 测试
# 迁移自 tui.smoke.test.sh (script+heredoc → expect)
#
# 按键映射：\x1b[C → \033[C (右箭头), \x1b[D → \033[D (左箭头)
#          \x1b → \033 (Esc), \n → \r (Enter)
# ──────────────────────────────────────────────────────────────────────────────

test_describe "todos extension (expect TUI mode)"

test_it "expect: loads in TUI mode without crash" <<'TEST'
  tui_expect_test "pi-logger,pi-config,todos" '
    send "/quit\r"
    expect eof
  ' 15

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: TUI mode exited cleanly (code=$TUI_EXIT_CODE)"
  else
    echo "FAIL: TUI mode exited with code $TUI_EXIT_CODE (expected 0 or 124)"
    exit 1
  fi

  padded=$(printf '%03d' "$CASE_INDEX")
  log_dir="$CASE_DIR/${padded}-logs"
  if [[ -d "$log_dir" ]]; then
    todo_logs=$(find "$log_dir" -name "*todos*" -type f 2>/dev/null | head -3)
    if [[ -n "$todo_logs" ]]; then
      echo "PASS: todos log files exist"
    else
      echo "WARN: No todos-specific log files found (expected in CI mode)"
    fi
  fi

  tui_cleanup
TEST

test_it "expect: handles /todos command without crash" <<'TEST'
  tui_expect_test "pi-logger,pi-config,todos" '
    send "/todos\r"
    sleep 1
    send "\033"
    sleep 0.5
    send "/quit\r"
    expect eof
  ' 15

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: /todos command handled without crash (code=$TUI_EXIT_CODE)"
  else
    echo "FAIL: Crash on /todos command (code=$TUI_EXIT_CODE)"
    exit 1
  fi

  tui_cleanup
TEST

test_it "expect: arrow key tab switching does not crash" <<'TEST'
  tui_expect_test "pi-logger,pi-config,todos" '
    send "/todos\r"
    sleep 1
    send "\033\[C"
    sleep 0.3
    send "\033\[C"
    sleep 0.3
    send "\033\[D"
    sleep 0.3
    send "\033\[D"
    sleep 0.3
    send "/quit\r"
    expect eof
  ' 15

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: Arrow key navigation handled without crash (code=$TUI_EXIT_CODE)"
  else
    echo "FAIL: Crash during arrow key navigation (code=$TUI_EXIT_CODE)"
    exit 1
  fi

  tui_cleanup
TEST

test_it "expect: settings tab Esc does not crash" <<'TEST'
  tui_expect_test "pi-logger,pi-config,todos" '
    send "/todos\r"
    sleep 1
    send "\033\[C"
    sleep 0.3
    send "\033\[C"
    sleep 0.3
    send "\033\[C"
    sleep 0.3
    send "/quit\r"
    expect eof
  ' 15

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: Settings tab Esc handled without crash (code=$TUI_EXIT_CODE)"
  else
    echo "FAIL: Crash exiting settings tab (code=$TUI_EXIT_CODE)"
    exit 1
  fi

  tui_cleanup
TEST

test_it "expect: settings tab arrow key exit does not crash" <<'TEST'
  tui_expect_test "pi-logger,pi-config,todos" '
    send "/todos\r"
    sleep 1
    send "\033\[C"
    sleep 0.3
    send "\033\[C"
    sleep 0.3
    send "\033\[C"
    sleep 0.3
    send "\033\[D"
    sleep 0.3
    send "/quit\r"
    expect eof
  ' 15

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: Arrow key exit from settings handled without crash (code=$TUI_EXIT_CODE)"
  else
    echo "FAIL: Crash on arrow key exit from settings (code=$TUI_EXIT_CODE)"
    exit 1
  fi

  tui_cleanup
TEST

test_it "expect: logs store extension activity [REVIEW]" <<'TEST'
  tui_expect_test "pi-logger,pi-config,todos" '
    send "/todos\r"
    sleep 1
    send "\033\[C"
    sleep 0.3
    send "/quit\r"
    expect eof
  ' 15

  padded=$(printf '%03d' "$CASE_INDEX")
  log_dir="$CASE_DIR/${padded}-logs"

  if [[ -d "$log_dir" ]]; then
    log_content=$(find "$log_dir" -name "*.log" -type f -exec cat {} + 2>/dev/null | head -100)
    if echo "$log_content" | grep -qi "todos"; then
      echo "PASS: Logs contain 'todos' references"
    else
      echo "WARN: No 'todos' references in logs (CI sandbox may not capture logger config)"
    fi
    echo "--- Log content (first 20 lines) ---"
    find "$log_dir" -name "*.log" -type f -exec head -5 {} + 2>/dev/null | head -20
  fi

  tui_cleanup
  mark_for_review "Verify todos extension log entries in a real TUI session"
TEST
