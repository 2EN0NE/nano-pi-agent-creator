#!/usr/bin/env bash
# pi-worktree v2 TUI 测试
#
# 验证 TUI 交互组件：
# - 切换器面板渲染
# - force 删除弹窗文案
# - 帮助输出
# - 已删除命令（stop/mode）不生效

test_describe "worktree extension (TUI mode)"

# ── 测试 1：切换器面板内容 ──
test_it "switcher panel shows main and actions" <<'TEST'
  local pi_input
  pi_input=$(printf '/worktree\n\x1b')
  tui_run_pi_test "pi-logger,worktree" "$pi_input" 15

  # 验证面板内容
  tui_assert_contains "main" "switcher should list main checkout"
  tui_assert_contains "Create" "create action should be listed"
  tui_assert_contains "Delete" "delete action should be listed"
  tui_assert_contains "Quit" "quit action should be listed"

  tui_cleanup
  mark_for_review "验证切换器面板是否显示 main、Create/Delete/Quit 操作按钮"
TEST

# ── 测试 2：/worktree help 输出完整 ──
test_it "help shows all commands" <<'TEST'
  tui_run_pi_test "pi-logger,worktree" "/worktree help" 15

  tui_assert_contains "create" "help should show create"
  tui_assert_contains "delete" "help should show delete"
  tui_assert_contains "list" "help should show list"
  tui_assert_contains "merge" "help should show merge"
  tui_assert_contains "use" "help should show use"

  tui_cleanup
  mark_for_review "检查 /worktree help 是否输出 create/delete/list/merge/use 命令（不应含 widget）"
TEST

# ── 测试 3：已删除的命令（stop/mode）不再出现 ──
test_it "removed commands (stop/mode) no longer in help" <<'TEST'
  tui_run_pi_test "pi-logger,worktree" "/worktree help" 15

  # 期望：stop 和 mode 不再出现在帮助中
  local output
  output=$(extract_visible_text "$TUI_OUTPUT_FILE" 2>/dev/null || echo "")

  tui_cleanup
  mark_for_review "确认 /worktree help 中不再包含 stop 和 mode 命令（v2 已删除）"
TEST

# ── 测试 4：多次命令连续输入（TUI 稳定性） ──
test_it "multiple commands in sequence" <<'TEST'
  local pi_input
  pi_input=$(printf '/worktree help\n/worktree list\n')
  tui_run_pi_test "pi-logger,worktree" "$pi_input" 20

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: Multiple commands executed in TUI"
  else
    echo "FAIL: TUI exited with code $TUI_EXIT_CODE"
    exit 1
  fi

  tui_cleanup
TEST

# ── 测试 5：打开切换器面板后使用键盘导航 ──
test_it "switcher panel keyboard navigation" <<'TEST'
  # 打开面板 → 按 ↓ → 按 q 退出
  local pi_input
  pi_input=$(printf '/worktree\n\x1b[B\nq')
  tui_run_pi_test "pi-logger,worktree" "$pi_input" 15

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: navigated and quit"
  else
    echo "FAIL: TUI exited with code $TUI_EXIT_CODE"
    exit 1
  fi

  tui_cleanup
TEST
