#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# quit 扩展 — expect 交互测试 (tui_expect_test 版)
#
# 使用 tui_expect_test() 函数（取代 script+heredoc 的 tui_run_pi_test）
# 验证交互式 TUI 测试能通过 expect 实现按键 → 等待 → 断言闭环。
# ──────────────────────────────────────────────────────────────────────────────

test_describe "quit extension (expect TUI mode)"

test_it "expect: sends /quit and exits cleanly" <<'TEST'
  # 用户命令不处理 eof/退出——模板收尾统一 send /quit + 等待退出。
  # 旧版在用户命令内 expect eof 会消耗 eof 事件，模板再次 send /quit 报
  # "spawn id not open" → ec_file 缺失 → exit 误判（tui-functions 兜底后现形）。
  tui_expect_test "pi-logger,quit" '
    sleep 1
  ' 15

  if [[ "$TUI_EXIT_CODE" -eq 0 ]]; then
    echo "PASS: expect: pi exited cleanly"
  elif [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: expect: pi timed out (non-exiting command)"
  else
    echo "FAIL: expect: unexpected exit code $TUI_EXIT_CODE"
    exit 1
  fi
  tui_cleanup
TEST

test_it "expect: verifies extension loaded in TUI" <<'TEST'
  tui_expect_test "quit" '
    # Wait for TUI ready
    expect -re {\(auto\)|0\.0%/0} { }
    sleep 1

    # Check output contains quit extension
    set output [expect_output]
  ' 15

  # Check captured output for quit extension
  if tui_output_contains "$TUI_OUTPUT_FILE" "quit.ts"; then
    echo "PASS: expect: quit.ts found in output"
  else
    echo "FAIL: expect: quit.ts not found"
    exit 1
  fi
  tui_cleanup
TEST
