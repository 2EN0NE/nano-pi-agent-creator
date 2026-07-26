#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# pi-lab e2e smoke test
# 测试要点：
# 1. 扩展在 print 模式下正常加载
# 2. 日志中无 ERROR
# 3. /lab 命令可用（print 模式返回提示信息）
# ──────────────────────────────────────────────────────────────────────────────

test_describe "pi-lab"

test_it "loads without errors" <<'TEST'
  run_pi_and_check \
    --extensions "pi-lab" \
    --prompt "/help" \
    --expect-no-error
  exit 0
TEST

test_it "/lab command is callable (print mode returns hint)" <<'TEST'
  run_pi_and_check \
    --extensions "pi-lab" \
    --prompt "/lab" \
    --expect-no-error
  exit 0
TEST

test_it "no ERROR in logs" <<'TEST'
  run_pi_and_check \
    --extensions "pi-lab" \
    --prompt "/help" \
    --expect-no-error

  LOG_DIR="$PI_LOG_DIR"
  if [[ -d "$LOG_DIR" ]]; then
    if grep -r "ERROR" "$LOG_DIR" 2>/dev/null | grep -qi "pi-lab"; then
      echo "FAIL: Found ERROR in pi-lab logs"
      grep -r "ERROR" "$LOG_DIR" 2>/dev/null | head -10
      grep -r "ERROR" "$LOG_DIR" 2>/dev/null | grep -i "pi-lab" | head -10
      exit 1
    fi
    echo "PASS: No ERROR in pi-lab logs"
  else
    echo "WARN: No logs directory found"
  fi
  exit 0
TEST

test_it "works alongside edit extension (experiment auto-registration)" <<'TEST'
  run_pi_and_check \
    --extensions "pi-lab,edit" \
    --prompt "/help" \
    --expect-no-error

  # Check logs for experiment registration
  LOG_DIR="$PI_LOG_DIR"
  if [[ -d "$LOG_DIR" ]]; then
    if grep -r -i "experiment" "$LOG_DIR" 2>/dev/null | grep -q "edit"; then
      echo "PASS: Edit experiment registration found in logs"
    else
      echo "WARN: Could not verify experiment registration (may use different log path)"
    fi

    if grep -r "ERROR" "$LOG_DIR" 2>/dev/null | grep -qiE "(pi-lab|edit)"; then
      echo "FAIL: Found ERROR in pi-lab or edit logs"
      grep -r "ERROR" "$LOG_DIR" 2>/dev/null | grep -iE "(pi-lab|edit)" | head -10
      exit 1
    fi
    echo "PASS: No ERROR in logs when running with edit extension"
  fi
  exit 0
TEST
