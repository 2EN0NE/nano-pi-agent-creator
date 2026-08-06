#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# permission-gate — expect TUI 测试
# 迁移自 tui.smoke.test.sh (script+heredoc → expect)
# ──────────────────────────────────────────────────────────────────────────────

test_describe "permission-gate (expect TUI mode)"

test_it "expect: loads extension in TUI mode without crash" <<'TEST'
  tui_expect_test "permission-gate" '
    send "/permission-gate\r"
    sleep 3
  ' 15

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: TUI mode exited cleanly (code=$TUI_EXIT_CODE)"
  else
    echo "FAIL: TUI mode exited with code $TUI_EXIT_CODE (expected 0 or 124)"
    exit 1
  fi

  tui_assert_contains "permission-gate" "Extension name in TUI output"
  tui_cleanup
TEST

test_it "expect: TUI mode produces pi-logger output [REVIEW]" <<'TEST'
  tui_expect_test "permission-gate" '
    send "/permission-gate\r"
    sleep 3
  ' 15

  local padded
  padded=$(printf '%03d' "$CASE_INDEX")
  local log_dir="$CASE_DIR/${padded}-logs"
  if [[ -d "$log_dir" ]]; then
    local log_files
    log_files=$(find "$log_dir" -name "*.log" -type f 2>/dev/null)
    if [[ -n "$log_files" ]]; then
      echo "PASS: Log files found:"
      echo "$log_files" | sed 's/^/  /'

      if echo "$log_files" | xargs grep -l "permission-gate\|Config loaded\|Permission Gate" 2>/dev/null | head -1 >/dev/null; then
        echo "PASS: permission-gate log content found"
      else
        echo "WARN: No permission-gate specific content in logs (may be in combined log)"
        echo "$log_files" | head -3 | xargs head -5 2>/dev/null || true
      fi
    else
      echo "WARN: No log files in $log_dir"
    fi
  else
    echo "WARN: No logs directory captured"
  fi

  tui_cleanup
  mark_for_review "检查日志文件内容，确认 permission-gate 生命周期事件和 widget 更新被正确记录"
TEST

test_it "expect: TUI mode captures status bar content [REVIEW]" <<'TEST'
  tui_expect_test "permission-gate" '
    send "/permission-gate\r"
    sleep 3
  ' 15

  echo "TUI exit code: $TUI_EXIT_CODE"
  echo "TUI output size: $(wc -c <"$TUI_OUTPUT_FILE") bytes"

  local padded
  padded=$(printf '%03d' "$CASE_INDEX")
  local log_dir="$CASE_DIR/${padded}-logs"
  if [[ -d "$log_dir" ]]; then
    if grep -r "gate:on\|gate:off\|permission-gate\|setStatus\|widget" "$log_dir" 2>/dev/null | head -5; then
      echo "PASS: widget/gate references found in logs"
    else
      echo "WARN: No widget/gate references in logs"
    fi
  fi

  tui_cleanup
  mark_for_review "审查 PTY 输出和日志文件，确认 permission-gate 状态栏 widget 正确显示"
TEST
