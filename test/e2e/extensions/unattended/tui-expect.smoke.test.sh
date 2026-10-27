#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# unattended-confirm — TUI 端到端（ADR-0068）
#
# 验证「远端豁免模式生效后，程序化发起的会话切换不再弹 TUI 确认框」以及反向保护。
# 仅 mock LLM（CI 注入 mock-llm），其余 Pi API 全走真实路径；`/new` 不需要模型调用。
# ──────────────────────────────────────────────────────────────────────────────

test_describe "unattended-confirm (expect TUI mode)"

# shellcheck disable=SC2034 # 两个变量在引号 heredoc（'TEST'）内被引用，shellcheck 不解析其内容
EXT_LIST="selector,confirm-destructive,dirty-repo-guard,pi-logger"
# shellcheck disable=SC2034
FLAG="--unattended-confirm"

test_it "armed: /new 不弹确认框，并留下 skip-with-default 日志" <<'TEST'
  tui_expect_test "$EXT_LIST" '
    send "/unattended arm\r"
    sleep 2
    send "/new\r"
    sleep 4
  ' 60 80 "" "" "$FLAG"

  local logs_dir
  logs_dir="$(dirname "$TUI_OUTPUT_FILE")/.pi/logs"

  tui_assert_not_contains "Clear session" "armed 下不应出现 Clear session 对话框"
  tui_assert_contains "unattended" "状态栏应显示 | unattended"

  if grep -q "skip-with-default kind=showConfirm title=Clear session?" "$logs_dir"/unattended_*.log 2>/dev/null; then
    echo "PASS: 日志记录了 skip-with-default（采用声明式默认放行）"
  else
    echo "FAIL: 未在 $logs_dir 找到 skip-with-default 记录"
    tail -20 "$logs_dir"/unattended_*.log 2>/dev/null
    tui_cleanup
    exit 1
  fi

  if grep -q "arm(owner=manual) mode=licensed-idle→armed" "$logs_dir"/unattended_*.log 2>/dev/null; then
    echo "PASS: 日志记录了 licensed-idle→armed"
  else
    echo "FAIL: 未找到 arm 记录"
    tui_cleanup
    exit 1
  fi

  tui_cleanup
TEST

test_it "未 armed: /new 仍弹确认框（反向保护）" <<'TEST'
  tui_expect_test "$EXT_LIST" '
    send "/new\r"
    sleep 4
  ' 60 80 "" "" "$FLAG"

  tui_assert_contains "Clear session" "未 armed 时应仍弹出 Clear session 确认框"
  echo "PASS: 未 armed 时确认框仍在（保护未失效）"

  tui_cleanup
TEST
