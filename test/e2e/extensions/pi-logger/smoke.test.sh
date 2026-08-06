#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# pi-logger 扩展端到端测试
# ──────────────────────────────────────────────────────────────────────────────

test_describe "pi-logger extension"

# ── 用例 1：加载无报错 ──
test_it "loads without errors" <<'TEST'
  run_pi_and_check \
    --extensions "pi-logger" \
    --prompt "hi" \
    --expect-no-error
TEST

# ── 用例 2：createLogger 产生日志文件 ──
test_it "createLogger produces log file" <<'TEST'
  run_pi_and_check \
    --extensions "pi-logger" \
    --prompt "load the logger and log a test message" \
    --save-output
  # 检查日志目录是否存在且有文件
  if [[ -d "$PI_LOG_DIR" ]] && ls "$PI_LOG_DIR"/*.log &>/dev/null; then
    exit 0
  else
    echo "No log files found in $PI_LOG_DIR"
    exit 1
  fi
TEST

# ── 用例 3：生命周期捕获工具调用（需 AI 衡量） ──
test_it "lifecycle capture fires on tool calls [REVIEW]" <<'TEST'
  run_pi_and_check \
    --extensions "pi-logger" \
    --prompt "run a simple bash command like 'echo hello'" \
    --save-output
  mark_for_review "验证 __lifecycle__ 日志中是否包含 [tool] 进入/退出的记录"
TEST
