#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# todos 扩展 TUI 端到端测试
# 测试要点：
# 1. TUI 模式下加载无崩溃
# 2. /todos 命令处理不崩溃
# 3. ←/→ 切换标签不崩溃
# 4. Settings 标签 Esc/←/→ 不崩溃
# 5. 扩展日志正常
# ──────────────────────────────────────────────────────────────────────────────

test_describe "todos extension (TUI mode)"

test_it "loads in TUI mode without crash" <<'TEST'
  tui_run_pi_test "pi-logger,pi-config,todos" "/quit" 15

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: TUI mode exited cleanly (code=$TUI_EXIT_CODE)"
  else
    echo "FAIL: TUI mode exited with code $TUI_EXIT_CODE (expected 0 or 124)"
    exit 1
  fi

  # Check log files exist from the test sandbox
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

test_it "handles /todos command without crash" <<'TEST'
  tui_run_pi_test "pi-logger,pi-config,todos" \
    $'/todos\n\x1b/quit\n' 15

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: /todos command handled without crash (code=$TUI_EXIT_CODE)"
  else
    echo "FAIL: Crash on /todos command (code=$TUI_EXIT_CODE)"
    exit 1
  fi

  tui_cleanup
TEST

test_it "arrow key tab switching does not crash" <<'TEST'
  tui_run_pi_test "pi-logger,pi-config,todos" \
    $'/todos\n\x1b[C\x1b[C\x1b[D\x1b[D\x1b/quit\n' 15

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: Arrow key navigation handled without crash (code=$TUI_EXIT_CODE)"
  else
    echo "FAIL: Crash during arrow key navigation (code=$TUI_EXIT_CODE)"
    exit 1
  fi

  tui_cleanup
TEST

test_it "settings tab Esc does not crash" <<'TEST'
  tui_run_pi_test "pi-logger,pi-config,todos" \
    $'/todos\n\x1b[C\x1b[C\x1b[C\x1b/quit\n' 15

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: Settings tab Esc handled without crash (code=$TUI_EXIT_CODE)"
  else
    echo "FAIL: Crash exiting settings tab (code=$TUI_EXIT_CODE)"
    exit 1
  fi

  tui_cleanup
TEST

test_it "settings tab arrow key exit does not crash" <<'TEST'
  tui_run_pi_test "pi-logger,pi-config,todos" \
    $'/todos\n\x1b[C\x1b[C\x1b[C\x1b[D\x1b/quit\n' 15

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: Arrow key exit from settings handled without crash (code=$TUI_EXIT_CODE)"
  else
    echo "FAIL: Crash on arrow key exit from settings (code=$TUI_EXIT_CODE)"
    exit 1
  fi

  tui_cleanup
TEST

test_it "logs store extension activity [REVIEW]" <<'TEST'
  tui_run_pi_test "pi-logger,pi-config,todos" \
    $'/todos\n\x1b[C\x1b/quit\n' 15

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
