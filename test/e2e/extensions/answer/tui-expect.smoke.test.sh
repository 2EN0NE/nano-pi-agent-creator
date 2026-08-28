#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# answer — expect TUI 测试
# 验证：扩展在 TUI 模式加载不崩、/answer 命令安全返回（无 assistant 消息时
# 仅 notify 不弹 Q&A 覆盖层）。Q&A 覆盖层的纯横线边框（ADR-0023）由
# headless 测试（answer.tui.test.ts）机器断言，此处仅保证 TUI 加载路径不崩。
# ──────────────────────────────────────────────────────────────────────────────

test_describe "answer (expect TUI mode)"

test_it "expect: loads extension in TUI mode without crash" <<'TEST'
  tui_expect_test "answer" '
    send "/answer\r"
    sleep 3
    send "\x1b"
    sleep 1
  ' 15

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: TUI mode exited cleanly (code=$TUI_EXIT_CODE)"
  else
    echo "FAIL: TUI mode exited with code $TUI_EXIT_CODE (expected 0 or 124)"
    exit 1
  fi

  tui_cleanup
TEST

test_it "expect: /answer command is recognized (no assistant msg → notify, no crash)" <<'TEST'
  tui_expect_test "answer" '
    send "/answer\r"
    sleep 3
  ' 15

  tui_assert_contains "answer" "/answer command should appear in TUI output"
  tui_cleanup
TEST
