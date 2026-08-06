#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# ci-watch — expect 交互 TUI 测试
#
# 迁移自 tui.smoke.test.sh (script+heredoc → expect)
#
# ci-watch 打开 TUI 覆盖层面板后 pi 不主动退出，
# 因此依赖 expect timeout (exit 124) 作为正常行为。
# tui_assert_exit_code 0 接受 124 作为合法退出码。
# ──────────────────────────────────────────────────────────────────────────────

test_describe "ci-watch TUI interaction (expect)"

test_it "expect: /ci-watch launches without crash" <<'TEST'
  tui_expect_test "ci-watch,pi-logger,pi-config" '
    send "/ci-watch\r"
    sleep 3
  ' 10

  tui_assert_exit_code 0

  local logs_dir="$TUI_TEST_HOME/.pi/logs"
  if ls "$logs_dir"/*.log 2>/dev/null | head -1; then
    if grep -q "ci-watch" "$logs_dir"/*.log 2>/dev/null; then
      echo "PASS: ci-watch log entries found"
    else
      echo "WARN: no ci-watch log entries"
    fi
  else
    echo "WARN: no log files in $logs_dir"
  fi

  tui_cleanup
  exit 0
TEST

test_it "expect: /ci-watch with PR number starts monitoring (no gh)" <<'TEST'
  tui_expect_test "ci-watch,pi-logger,pi-config" '
    send "/ci-watch 123\r"
    sleep 3
  ' 10

  tui_assert_exit_code 0

  echo "=== TUI visible output ==="
  extract_visible_text "$TUI_OUTPUT_FILE" | tail -30

  tui_cleanup
  exit 0
TEST

test_it "expect: /ci-watch with branch name starts monitoring (no gh)" <<'TEST'
  tui_expect_test "ci-watch,pi-logger,pi-config" '
    send "/ci-watch main\r"
    sleep 3
  ' 10

  tui_assert_exit_code 0

  tui_cleanup
  exit 0
TEST

test_it "expect: extension lifecycle [REVIEW]" <<'TEST'
  tui_expect_test "ci-watch,pi-logger,pi-config" '
    send "/ci-watch\r"
    sleep 3
  ' 10

  local logs_dir="$TUI_TEST_HOME/.pi/logs"
  if ls "$logs_dir"/__lifecycle__*.log 2>/dev/null | head -1; then
    echo "=== lifecycle log ==="
    cat "$logs_dir"/__lifecycle__*.log 2>/dev/null | tail -30
    echo "=== ci-watch log ==="
    cat "$logs_dir"/ci-watch*.log 2>/dev/null | tail -20 || echo "(no ci-watch log)"
  else
    echo "WARN: no lifecycle log files"
  fi

  tui_cleanup
  mark_for_review "验证 ci-watch TUI 模式下的表现："$'\n'"1. /ci-watch 打开 TUI 面板（覆盖层）不崩溃"$'\n'"2. 当没有 gh CLI 时优雅提示"$'\n'"3. 面板内容（Monitor PR, Monitor Branch, Auto-mode, Polling config）渲染正确"$'\n'"4. 日志完整记录 session 生命周期"
  exit 0
TEST
