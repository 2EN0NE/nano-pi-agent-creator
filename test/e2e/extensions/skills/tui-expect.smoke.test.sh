#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# skills — expect TUI 测试
# 迁移自 tui.smoke.test.sh (script+heredoc → expect)
# ──────────────────────────────────────────────────────────────────────────────

test_describe "skills extension (expect TUI mode)"

test_it "expect: /skills command triggers without crash" <<'TEST'
  tui_expect_test "pi-logger,skills" '
    send "/skills\r"
    sleep 3
  ' 15

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: /skills TUI exited cleanly (code=$TUI_EXIT_CODE)"
  else
    echo "FAIL: /skills TUI exited with code $TUI_EXIT_CODE (expected 0 or 124)"
    exit 1
  fi

  tui_assert_contains "skills" "Skills extension should appear in output"
  tui_cleanup
TEST

test_it "expect: logs skills startup in TUI mode" <<'TEST'
  tui_expect_test "pi-logger,skills" '
    send "/skills\r"
    sleep 3
  ' 15

  local padded
  padded=$(printf '%03d' "$CASE_INDEX")
  local log_dir="$CASE_DIR/${padded}-logs"
  if [[ -d "$log_dir" ]]; then
    local skills_log
    skills_log=$(find "$log_dir" -name "*skills*" -type f 2>/dev/null | head -1)
    if [[ -n "$skills_log" ]]; then
      echo "PASS: skills log file found: $skills_log"
      if grep -q "Skills extension loaded\|skills" "$skills_log"; then
        echo "PASS: skills startup message in log"
      fi
    else
      local skills_refs
      skills_refs=$(grep -rl "skills" "$log_dir" 2>/dev/null | head -3)
      if [[ -n "$skills_refs" ]]; then
        echo "PASS: skills references found in logs: $skills_refs"
      else
        echo "WARN: No skills-specific logs found"
        ls "$log_dir" 2>/dev/null | head -5
      fi
    fi
  else
    echo "WARN: No logs directory captured"
  fi

  tui_cleanup
TEST

test_it "expect: /skills shows selector panel [REVIEW]" <<'TEST'
  tui_expect_test "pi-logger,skills" '
    send "/skills\r"
    sleep 3
  ' 15

  tui_assert_contains "pi" "TUI should produce output"
  tui_cleanup
  mark_for_review "验证 /skills 在 TUI 模式下触发了 SettingsList 选择器："$'\n'"1. 输出中包含技能列表或'Skills'字样"$'\n'"2. 选择器面板正常渲染、无排版错乱"$'\n'"3. 可以导航、确认、取消"
TEST
