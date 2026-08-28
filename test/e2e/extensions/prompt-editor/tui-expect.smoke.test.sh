#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# prompt-editor — expect TUI 测试
# 迁移自 tui.smoke.test.sh (script+heredoc → expect)
# ──────────────────────────────────────────────────────────────────────────────

test_describe "prompt-editor extension (expect TUI mode)"

test_it "expect: /prompt command triggers without crash" <<'TEST'
  tui_expect_test "pi-logger,prompt-editor" '
    send "/prompt\r"
    sleep 3
  ' 15

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: /prompt TUI exited cleanly (code=$TUI_EXIT_CODE)"
  else
    echo "FAIL: /prompt TUI exited with code $TUI_EXIT_CODE (expected 0 or 124)"
    exit 1
  fi

  tui_assert_contains "prompt" "Prompt-editor extension should appear in output"
  tui_cleanup
TEST

test_it "expect: shows prompt-editor in TUI extension list" <<'TEST'
  tui_expect_test "pi-logger,prompt-editor" '
    send "/prompt\r"
    sleep 3
  ' 15

  tui_assert_contains "pi-logger" "pi-logger should be in extension list"
  tui_assert_contains "prompt-editor" "prompt-editor should be in extension list"

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

test_it "expect: /prompt shows assembly panel [REVIEW]" <<'TEST'
  tui_expect_test "pi-logger,prompt-editor" '
    send "/prompt\r"
    sleep 3
  ' 15

  tui_assert_contains "pi" "TUI should produce output"
  tui_cleanup
  mark_for_review "验证 /prompt 在 TUI 模式下触发了 prompt 组装面板："$'\n'"1. 输出中包含'Prompt Assembly'或'prompt'相关文字"$'\n'"2. 面板组件列表正常渲染"$'\n'"3. 可正常退出（Esc/Ctrl+C）"
TEST

# 注：方向键响应（含应用模式 \x1bOB/\x1bOA 序列）由 headless 测试覆盖：
#   test/vitest/extensions/prompt-editor.keys.test.ts
# 原因：expect 裸 PTY 环境下 pi-tui 对 theme 渲染组件的移动后重绘存在调度限制
#       （doRender 不触发），屏幕断言不可靠；headless 直接驱动 handleInput 更可靠。
