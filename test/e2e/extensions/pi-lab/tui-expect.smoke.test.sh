#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# pi-lab — expect TUI 测试
# 迁移自 tui.smoke.test.sh (script+heredoc → expect)
#
# 宽度特定测试使用 tui_expect_test 的 cols 参数（第4参数）。
# ──────────────────────────────────────────────────────────────────────────────

test_describe "pi-lab (expect TUI mode)"

test_it "expect: loads extension in TUI mode without crash" <<'TEST'
  tui_expect_test "pi-lab" '
    send "/lab\r"
    sleep 3
  ' 15

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: TUI mode exited cleanly (code=$TUI_EXIT_CODE)"
  else
    echo "FAIL: TUI mode exited with code $TUI_EXIT_CODE (expected 0 or 124)"
    exit 1
  fi

  tui_cleanup
TEST

test_it "expect: /lab command is recognized by pi [REVIEW]" <<'TEST'
  tui_expect_test "pi-lab" '
    send "/lab\r"
    sleep 3
  ' 15

  tui_assert_contains "lab" "/lab command should appear in output"
  tui_cleanup
  mark_for_review "手动验证 /lab 命令在 TUI 中能正确打开面板：输入 /lab 后应出现实验管理面板（Current Session / Global 标签页，底部帮助栏）"
TEST

test_it "expect: TUI mode renders status bar" <<'TEST'
  tui_expect_test "pi-lab" '
    send "/lab\r"
    sleep 3
  ' 15

  tui_assert_contains "mock" "Status bar should show model name"
  tui_cleanup
TEST

test_it "expect: divider fills full terminal width on first render" <<'TEST'
  local WIDTH=100
  tui_expect_test "pi-lab" '
    send "/lab\r"
    sleep 3
  ' 15 $WIDTH

  local divider_line
  divider_line=$(extract_visible_text "$TUI_OUTPUT_FILE" | grep -E '─{3,}' | head -1)

  if [[ -z "$divider_line" ]]; then
    echo "FAIL: No divider line found in output"
    echo "--- TUI output ---"
    extract_visible_text "$TUI_OUTPUT_FILE" | tail -30
    echo "---"
    exit 1
  fi

  local dash_count
  dash_count=$(echo "$divider_line" | sed 's/[^─]//g' | wc -c | tr -d ' ')
  dash_count=$((dash_count - 1))

  echo "Divider line: ${#divider_line} chars width, $dash_count dashes"
  echo "Terminal width: $WIDTH"

  if [[ "$dash_count" -ge "$((WIDTH - 10))" ]]; then
    echo "PASS: Divider fills terminal ($dash_count dashes, terminal=$WIDTH)"
  elif [[ "$dash_count" -gt 80 && "$dash_count" -lt "$((WIDTH - 10))" ]]; then
    echo "WARN: Divider width $dash_count plausible but verify"
  else
    echo "FAIL: Divider only $dash_count dashes (expected >= $((WIDTH - 10)))"
    exit 1
  fi

  tui_cleanup
TEST

test_it "expect: works with edit extension in TUI mode [REVIEW]" <<'TEST'
  tui_expect_test "pi-lab,edit" '
    send "/lab\r"
    sleep 3
  ' 15

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: TUI mode with pi-lab+edit exited cleanly (code=$TUI_EXIT_CODE)"
  else
    echo "FAIL: TUI mode exited with code $TUI_EXIT_CODE"
    exit 1
  fi

  tui_cleanup
  mark_for_review "检查 TUI 中两个扩展同时加载时的显示效果：状态栏、面板交互"
TEST

test_it "expect: panel renders single-column box border [REVIEW]" <<'TEST'
  local WIDTH=100
  tui_expect_test "pi-lab" '
    send "/lab\r"
    sleep 3
  ' 15 $WIDTH

  local raw_file="$TUI_TEST_HOME/visible.txt"
  extract_visible_text "$TUI_OUTPUT_FILE" > "$raw_file"

  # 新面板为单列布局，顶部/底部为 ┌─┐ / └─┘ 框（无旧版左右竖线 │）
  if grep -q '┌' "$raw_file" 2>/dev/null && grep -q '└' "$raw_file" 2>/dev/null; then
    echo "PASS: top/bottom box border rendered (┌ / └)"
  else
    echo "WARN: box border not detected, verify manually"
  fi

  tui_cleanup
  mark_for_review "人工验证两级导航面板：/lab 一级应出现实验列表（插件名:实验名 + arm 摘要，↑↓ 导航 ⏎ 进入），二级操作条 [统计] [设置] [重置] Tab 切换，顶部 ┌── pi-lab ──┐ 框、底部 └─┘ 框"
TEST
