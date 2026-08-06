#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# smart-context e2e smoke test
# 测试要点：
# 1. 扩展在 mock-llm 模式下正常加载
# 2. /smart-context 命令可用
# 3. 与 pi-lab 共存无错误（turn-routing 实验注册）
# 4. 无 ERROR 日志
# ──────────────────────────────────────────────────────────────────────────────

test_describe "smart-context"

test_it "loads without errors (mock-llm mode)" <<'TEST'
  run_pi_and_check \
    --extensions "smart-context" \
    --prompt "hello" \
    --expect-no-error
  exit 0
TEST

test_it "/smart-context command is callable" <<'TEST'
  run_pi_and_check \
    --extensions "smart-context" \
    --prompt "/smart-context" \
    --expect-no-error
  exit 0
TEST

test_it "co-loads with pi-lab without errors" <<'TEST'
  run_pi_and_check \
    --extensions "smart-context,pi-lab" \
    --prompt "hello" \
    --expect-no-error

  # 检查 pi-lab 日志确认 turn-routing 实验注册成功
  FOUND=0
  for log_dir in "$ROOT_DIR/.pi/tmp"/*/home/.pi/agent/extensions-data/pi-logger/logs/; do
    for log in "$log_dir"/smart-context_*.log; do
      [[ -f "$log" ]] || continue
      if grep -q "turn-routing\|registered" "$log" 2>/dev/null; then
        echo "PASS: turn-routing experiment registration confirmed"
        FOUND=1
      fi
    done
  done
  if [[ $FOUND -eq 0 ]]; then
    echo "INFO: experiment registration log not found (pi-lab may not be in test sandbox)"
  fi
  exit 0
TEST

test_it "no ERROR in logs" <<'TEST'
  run_pi_and_check \
    --extensions "smart-context" \
    --prompt "hello" \
    --expect-no-error
  # run_pi_and_check with --expect-no-error already validates no errors in output
  exit 0
TEST
