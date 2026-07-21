#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# permission-gate TUI 测试
#
# TUI 模式下 permission-gate 扩展的行为验证。
# 注意：TUI overlay 内容（控制面板、策略面板等）通过 script 捕获的 PTY 输出
# 无法可靠提取（overlay 使用光标定位绘制），因此我们只验证可捕获的信号：
#   - 扩展加载（在启动输出中出现）
#   - 状态栏 widget（在视口快照中出现）
#   - 日志文件（pi-logger 捕获）
#   - 灰度 REVIEW 需要手动验证 overlay 渲染效果
# ──────────────────────────────────────────────────────────────────────────────

test_describe "permission-gate (TUI mode)"

test_it "loads extension in TUI mode without crash" <<'TEST'
  tui_run_pi_test "permission-gate" "/permission-gate" 15

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: TUI mode exited cleanly (code=$TUI_EXIT_CODE)"
  else
    echo "FAIL: TUI mode exited with code $TUI_EXIT_CODE (expected 0 or 124)"
    exit 1
  fi

  # 验证扩展名出现在启动资源列表中
  tui_assert_contains "permission-gate" "Extension name in startup list"
  tui_cleanup
TEST

test_it "shows widget in status bar after session_start" <<'TEST'
  tui_run_pi_test "permission-gate" "/permission-gate" 15

  # widget 在视口快照的第二帧中出现（after LLM response）
  # gate:on 表示扩展已加载且 widget 已设置（dynamic policy 默认关闭）
  tui_assert_contains "gate:on" "Status widget shows gate:on (dynamic off)"

  tui_cleanup
TEST

test_it "shows TUI welcome and extension list" <<'TEST'
  tui_run_pi_test "permission-gate" "/permission-gate" 15

  # TUI 基本结构
  tui_assert_contains "[Extensions]" "Extensions section should appear"
  tui_assert_contains "permission-gate" "permission-gate in extension list"
  tui_assert_contains "mock-llm" "mock-llm loaded in CI mode"

  tui_cleanup
TEST

test_it "extension logs captured correctly [REVIEW]" <<'TEST'
  tui_run_pi_test "permission-gate" "/permission-gate" 15

  local padded
  padded=$(printf '%03d' "$CASE_INDEX")
  local log_dir="$CASE_DIR/${padded}-logs"
  if [[ -d "$log_dir" ]]; then
    # 查找所有日志文件
    local log_files
    log_files=$(find "$log_dir" -name "*.log" -type f 2>/dev/null)
    if [[ -n "$log_files" ]]; then
      echo "PASS: Log files found:"
      echo "$log_files" | sed 's/^/  /'

      # 检查权限门控日志
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

test_it "TUI startup content is correctly captured" <<'TEST'
  tui_run_pi_test "permission-gate" "/permission-gate" 15

  # 基础结构验证
  tui_assert_matches "pi v[0-9]+\.[0-9]+\.[0-9]+" "TUI welcome banner should show pi version"
  tui_assert_contains "escape interrupt" "Help text should appear"

  # 验证上下文资源
  tui_assert_contains "Context" "Context section should appear"

  tui_cleanup
TEST
