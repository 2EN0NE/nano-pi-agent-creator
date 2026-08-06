#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# mode-switcher — expect 交互 TUI 测试
# 迁移自 tui.smoke.test.sh (script+heredoc → expect)
# ──────────────────────────────────────────────────────────────────────────────

test_describe "mode-switcher extension (expect TUI mode)"

test_it "expect: /mode command triggers without crash" <<'TEST'
  tui_expect_test "pi-logger,mode-switcher" '
    send "/mode\r"
    sleep 3
  ' 15

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: /mode TUI exited cleanly (code=$TUI_EXIT_CODE)"
  else
    echo "FAIL: /mode TUI exited with code $TUI_EXIT_CODE (expected 0 or 124)"
    exit 1
  fi

  tui_assert_contains "mode" "Mode-switcher extension should appear in output"
  tui_cleanup
TEST

test_it "expect: shows mode-switcher in TUI extension list" <<'TEST'
  tui_expect_test "pi-logger,mode-switcher" '
    send "/mode\r"
    sleep 3
  ' 15

  tui_assert_contains "pi-logger" "pi-logger should be in extension list"
  tui_assert_contains "mode-switcher" "mode-switcher should be in extension list"

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

test_it "expect: /mode shows selector panel [REVIEW]" <<'TEST'
  tui_expect_test "pi-logger,mode-switcher" '
    send "/mode\r"
    sleep 3
  ' 15

  tui_assert_contains "pi" "TUI should produce output"
  tui_cleanup
  mark_for_review "验证 /mode 在 TUI 模式下触发了模式选择面板："$'\n'"1. 输出中包含'mode'或'Mode'相关文字"$'\n'"2. 面板正常渲染、无排版/颜色错乱"$'\n'"3. 可正常退出面板"
TEST
