#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# skills 扩展端到端测试
# 验证 pi-logger 集成是否正常工作，日志是否按预期输出
# ──────────────────────────────────────────────────────────────────────────────

test_describe "skills extension (logging)"

# ── 用例 1：加载无报错 ──
test_it "loads without errors" <<'TEST'
  run_pi_and_check \
    --extensions "pi-logger,skills" \
    --prompt "hi" \
    --expect-no-error
TEST

# ── 用例 2：skills 日志器在启动时输出 "Skills extension loaded" ──
test_it "logs 'Skills extension loaded' on startup" <<'TEST'
  run_pi_and_check \
    --extensions "pi-logger,skills" \
    --prompt "hi" \
    --save-output
  # 检查 skills 日志文件是否包含启动消息
  if ls "$PI_LOG_DIR"/skills_*.log &>/dev/null; then
    if grep -q "Skills extension loaded" "$PI_LOG_DIR"/skills_*.log; then
      exit 0
    else
      echo "Expected 'Skills extension loaded' in skills log"
      cat "$PI_LOG_DIR"/skills_*.log
      exit 1
    fi
  else
    echo "No skills log file found in $PI_LOG_DIR"
    ls -la "$PI_LOG_DIR"/ 2>/dev/null || echo "  (no log dir)"
    exit 1
  fi
TEST

# ── 用例 3：skills 日志器在初始化时输出 enabled 数量 ──
test_it "logs skills enabled count on initialization" <<'TEST'
  run_pi_and_check \
    --extensions "pi-logger,skills" \
    --prompt "hi" \
    --save-output
  if ls "$PI_LOG_DIR"/skills_*.log &>/dev/null; then
    if grep -q "Skills: initialized" "$PI_LOG_DIR"/skills_*.log; then
      exit 0
    else
      echo "Expected 'Skills: initialized' in skills log"
      cat "$PI_LOG_DIR"/skills_*.log
      exit 1
    fi
  else
    exit 1
  fi
TEST

# ── 用例 4：/skills 交互界面可触发（需 AI 衡量） ──
test_it "/skills command responds [REVIEW]" <<'TEST'
  run_pi_and_check \
    --extensions "pi-logger,skills" \
    --prompt "try using /skills" \
    --save-output || true
  mark_for_review "验证 pi 对 /skills 命令的响应是否正常"
TEST

# ── 用例 5：日志不包含 ERROR（需 AI 衡量） ──
test_it "no ERROR in skills log [REVIEW]" <<'TEST'
  run_pi_and_check \
    --extensions "pi-logger,skills" \
    --prompt "hi" \
    --save-output || true
  # 检查是否存在 ERROR
  if ls "$PI_LOG_DIR"/skills_*.log &>/dev/null; then
    if grep -q "ERROR" "$PI_LOG_DIR"/skills_*.log; then
      echo "Found ERROR in skills log:"
      grep "ERROR" "$PI_LOG_DIR"/skills_*.log
      exit 1
    fi
  fi
  mark_for_review "验证 skills 运行全过程中 pi-logger 无 ERROR 级别日志"
TEST
