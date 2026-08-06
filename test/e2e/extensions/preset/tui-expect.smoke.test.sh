#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# preset — expect TUI 测试
# 迁移自 tui.smoke.test.sh (script+heredoc → expect)
# ──────────────────────────────────────────────────────────────────────────────

test_describe "preset extension (expect TUI mode)"

test_it "expect: /preset command triggers without crash" <<'TEST'
  tui_expect_test "pi-logger,preset" '
    send "/preset\r"
    sleep 3
  ' 15

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: /preset TUI exited cleanly (code=$TUI_EXIT_CODE)"
  else
    echo "FAIL: /preset TUI exited with code $TUI_EXIT_CODE (expected 0 or 124)"
    exit 1
  fi

  padded=$(printf '%03d' "$CASE_INDEX")
  log_dir="$CASE_DIR/${padded}-logs"
  if [[ -d "$log_dir" ]]; then
    ext_refs=$(grep -rl "preset" "$log_dir" 2>/dev/null || true)
    if [[ -n "$ext_refs" ]]; then
      echo "PASS: preset references found in logs: $ext_refs"
    else
      echo "WARN: No preset references in logs (background extension may not log)"
      ls "$log_dir" 2>/dev/null || true
    fi
  else
    echo "WARN: No logs directory captured"
  fi

  tui_cleanup 2>/dev/null || true
TEST

test_it "expect: loads preset in TUI mode without errors" <<'TEST'
  tui_expect_test "pi-logger,preset" '
    send "/preset\r"
    sleep 3
  ' 15

  if tui_output_contains "$TUI_OUTPUT_FILE" "Error"; then
    echo "FAIL: Found 'Error' in TUI output"
    exit 1
  fi
  echo "PASS: TUI output shows no errors"

  padded=$(printf '%03d' "$CASE_INDEX")
  log_dir="$CASE_DIR/${padded}-logs"
  if [[ -d "$log_dir" ]]; then
    log_files=$(find "$log_dir" -name "*.log" -type f 2>/dev/null | head -5 || true)
    if [[ -n "$log_files" ]]; then
      echo "PASS: Log files exist:"
      echo "$log_files"
    else
      echo "WARN: No log files found in $log_dir"
    fi
  else
    echo "WARN: No logs directory captured"
  fi

  tui_cleanup 2>/dev/null || true
TEST

test_it "expect: /preset shows selection panel [REVIEW]" <<'TEST'
  tui_expect_test "pi-logger,preset" '
    send "/preset\r"
    sleep 3
  ' 15

  tui_assert_contains "pi" "TUI should produce output"
  tui_cleanup
  mark_for_review "验证 /preset 在 TUI 模式下触发了预设选择面板："$'\n'"1. 输出中包含'preset'或'Preset'相关文字"$'\n'"2. 面板正常渲染、无排版错乱"$'\n'"3. 可正常退出面板"
TEST
