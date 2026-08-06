#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# tools — expect TUI 测试
# 迁移自 tui.smoke.test.sh (script+heredoc → expect)
# ──────────────────────────────────────────────────────────────────────────────

test_describe "tools extension (expect TUI mode)"

test_it "expect: /tools command triggers without crash" <<'TEST'
  tui_expect_test "pi-logger,tools" '
    send "/tools\r"
    sleep 3
  ' 15

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: /tools TUI exited cleanly (code=$TUI_EXIT_CODE)"
  else
    echo "FAIL: /tools TUI exited with code $TUI_EXIT_CODE (expected 0 or 124)"
    exit 1
  fi

  tui_assert_contains "tools" "Tools extension should appear in output"
  tui_cleanup
TEST

test_it "expect: shows tools in TUI extension list" <<'TEST'
  tui_expect_test "pi-logger,tools" '
    send "/tools\r"
    sleep 3
  ' 15

  tui_assert_contains "pi-logger" "pi-logger should be in extension list"
  tui_assert_contains "tools" "tools should be in extension list"

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

test_it "expect: /tools shows selector panel [REVIEW]" <<'TEST'
  tui_expect_test "pi-logger,tools" '
    send "/tools\r"
    sleep 3
  ' 15

  tui_assert_contains "pi" "TUI should produce output"
  tui_cleanup
  mark_for_review "验证 /tools 在 TUI 模式下触发了 SettingsList 选择器："$'\n'"1. 输出中包含工具列表或'Tools'字样"$'\n'"2. 选择器面板正常渲染、无排版错乱"$'\n'"3. Ctrl+C 退出正常"
TEST
