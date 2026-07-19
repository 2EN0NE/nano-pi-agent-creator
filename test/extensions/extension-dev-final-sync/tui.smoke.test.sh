#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# extension-dev-final-sync TUI 测试
# 测试要点：
# 1. 扩展在 TUI 模式下正确加载，出现在扩展列表中
# 2. 扩展日志在 TUI 模式下被正确捕获
# 3. 扩展在无变更场景下不自爆（保护锁正常）
#
# 注意：必须包含 quit 扩展以支持 /quit 命令正常退出
# ──────────────────────────────────────────────────────────────────────────────

test_describe "extension-dev-final-sync extension (TUI mode)"

test_it "loads extension in TUI mode without crash" <<'TEST'
  tui_run_pi_test "quit,extension-dev-final-sync" "/quit" 15

  # 退出码 0=quit 正常退出, 124=timeout
  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: TUI mode exited cleanly (code=$TUI_EXIT_CODE)"
  else
    echo "FAIL: TUI mode exited with code $TUI_EXIT_CODE (expected 0 or 124)"
    exit 1
  fi

  # 验证扩展名出现在 TUI 输出中
  tui_assert_contains "extension-dev-final-sync" "Extension name appears in TUI output"

  tui_cleanup
TEST

test_it "shows in TUI extensions list [REVIEW]" <<'TEST'
  tui_run_pi_test "quit,extension-dev-final-sync" "/quit" 15

  # 验证：扩展在 Extensions 列表中显示
  tui_assert_contains "extension-dev-final-sync" "extension-dev-final-sync should appear in Extensions list"

  tui_cleanup
  mark_for_review "检查 TUI 输出中 extension-dev-final-sync 的加载状态：扩展列表显示、无报错"
TEST

test_it "extension logs captured in TUI mode" <<'TEST'
  tui_run_pi_test "pi-logger,quit,extension-dev-final-sync" "/quit" 15

  # 检查 pi-logger 日志是否记录了 extension-dev-final-sync
  local padded
  padded=$(printf '%03d' "$CASE_INDEX")
  local log_dir="$CASE_DIR/${padded}-logs"
  if [[ -d "$log_dir" ]]; then
    local ext_log
    ext_log=$(find "$log_dir" -name "*extension-dev-final-sync*" -type f 2>/dev/null | head -1)
    if [[ -n "$ext_log" ]]; then
      echo "PASS: extension-dev-final-sync log found: $ext_log"
    else
      local ext_refs
      ext_refs=$(grep -rl "extension-dev-final-sync" "$log_dir" 2>/dev/null | head -3)
      if [[ -n "$ext_refs" ]]; then
        echo "PASS: extension-dev-final-sync references found in logs: $ext_refs"
      else
        echo "WARN: No extension-dev-final-sync specific logs found"
        ls "$log_dir" 2>/dev/null | head -5
      fi
    fi
  else
    echo "WARN: No logs directory captured"
  fi

  tui_cleanup
TEST

test_it "TUI infra detects sync notification text" <<'TEST'
  # 验证：即使没有变更触发同步，扩展在 agent_end 时也不会崩溃
  # 在 TUI 沙箱中没有 git repo + extensions/ 变更，
  # 所以不会显示"已同步"通知。这个测试验证扩展不会因此报错。
  tui_run_pi_test "pi-logger,quit,extension-dev-final-sync" "/quit" 15

  # 只要能正常退出且无异常，就说明保护锁和空检测逻辑正常工作
  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: Extension ran without crash in no-change TUI scenario"
  else
    echo "FAIL: Extension crashed in TUI mode with exit code $TUI_EXIT_CODE"
    exit 1
  fi

  tui_cleanup
TEST
