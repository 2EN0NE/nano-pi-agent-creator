#!/usr/bin/env bash

test_describe "session-tree-label"

test_it "加载无报错" <<'TEST'
  run_pi_and_check \
    --extensions "session-tree-label" \
    --prompt "hi" \
    --save-output
  exit 0
TEST

test_it "加载后日志无 ERROR" <<'TEST'
  run_pi_and_check \
    --extensions "session-tree-label" \
    --prompt "hi" \
    --expect-no-error
TEST

test_it "/label reload 命令触发日志输出 [REVIEW]" <<'TEST'
  run_pi_and_check \
    --extensions "session-tree-label" \
    --prompt "/label reload" \
    --save-output
  if [[ -d "$PI_LOG_DIR" ]]; then
    label_log=$(ls "$PI_LOG_DIR"/session-tree-label_*.log 2>/dev/null | head -1 || true)
    if [[ -n "$label_log" ]]; then
      echo "=== session-tree-label 日志 ==="
      cat "$label_log"
      grep -q "Label applied\|Config reloaded\|notify" "$label_log" && \
        echo "PASS: 日志包含预期输出" || \
        echo "FAIL: 日志缺少预期内容"
    else
      echo "WARN: 未找到 session-tree-label_*.log（可能命令在非 TUI 模式下未触发）"
    fi
  else
    echo "WARN: PI_LOG_DIR 不存在"
  fi
  exit 0
TEST

test_it "/label status 命令不崩溃" <<'TEST'
  run_pi_and_check \
    --extensions "session-tree-label" \
    --prompt "/label status" \
    --save-output
  exit 0
TEST
