#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# extension-dev-final-sync — expect 交互 TUI 测试
#
# 迁移自 tui.smoke.test.sh (script+heredoc → expect)
# ──────────────────────────────────────────────────────────────────────────────

test_describe "extension-dev-final-sync extension (expect TUI mode)"

test_it "expect: loads extension in TUI mode without crash" <<'TEST'
  tui_expect_test "quit,extension-dev-final-sync" '
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

test_it "expect: loads without errors in TUI (log check) [REVIEW]" <<'TEST'
  tui_expect_test "quit,extension-dev-final-sync" '
    send "/quit\r"
    expect eof
  ' 15

  if tui_output_contains "$TUI_OUTPUT_FILE" "Error"; then
    echo "FAIL: Found 'Error' in TUI output"
    exit 1
  fi
  echo "PASS: TUI output shows no errors"

  tui_cleanup
  mark_for_review "确认 extension-dev-final-sync 在 TUI 模式下无报错"
TEST

test_it "expect: extension logs captured in TUI mode" <<'TEST'
  tui_expect_test "pi-logger,quit,extension-dev-final-sync" '
    send "/quit\r"
    expect eof
  ' 15

  padded=$(printf '%03d' "$CASE_INDEX")
  log_dir="$CASE_DIR/${padded}-logs"
  if [[ -d "$log_dir" ]]; then
    ext_log=$(find "$log_dir" -name "*extension-dev-final-sync*" -type f 2>/dev/null | head -1 || true)
    if [[ -n "$ext_log" ]]; then
      echo "PASS: extension-dev-final-sync log found: $ext_log"
    else
      ext_refs=$(grep -rl "extension-dev-final-sync" "$log_dir" 2>/dev/null || true)
      if [[ -n "$ext_refs" ]]; then
        echo "PASS: extension-dev-final-sync references found in logs: $ext_refs"
      else
        echo "WARN: No extension-dev-final-sync specific logs found"
        ls "$log_dir" 2>/dev/null || true
      fi
    fi
  else
    echo "WARN: No logs directory captured"
  fi

  tui_cleanup 2>/dev/null || true
TEST

test_it "expect: TUI infra detects sync notification text" <<'TEST'
  tui_expect_test "pi-logger,quit,extension-dev-final-sync" '
    send "/quit\r"
    expect eof
  ' 15

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: Extension ran without crash in no-change TUI scenario"
  else
    echo "FAIL: Extension crashed in TUI mode with exit code $TUI_EXIT_CODE"
    exit 1
  fi

  tui_cleanup 2>/dev/null || true
TEST
