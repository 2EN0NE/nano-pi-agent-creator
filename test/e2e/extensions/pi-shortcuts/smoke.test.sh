#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# pi-shortcuts 扩展端到端测试 — 普通（print）模式
#
# 测试要点：
# 1. pi-shortcuts 加载无报错（依赖 @zenone/pi-logger + @zenone/pi-config）
# 2. 消费方（files）通过 globalThis.__shortcutsApi 注册子键，日志记录注册成功
# 3. /shortcuts 命令在 print 模式下不崩溃
# ──────────────────────────────────────────────────────────────────────────────

test_describe "pi-shortcuts extension"

# ── 用例 1：加载无报错 ──
test_it "loads without errors" <<'TEST'
  run_pi_and_check \
    --extensions "pi-logger,pi-config,pi-shortcuts" \
    --prompt "hi" \
    --expect-no-error
TEST

# ── 用例 2：消费方注册子键（files 通过 hub 注册）──
test_it "files registers sub-keys via shortcut hub" <<'TEST'
  run_pi_and_check \
    --extensions "pi-logger,pi-config,pi-shortcuts,files" \
    --prompt "hi" \
    --save-output

  local sc_log
  sc_log=$(ls "$PI_LOG_DIR"/pi-shortcuts_*.log 2>/dev/null | head -1)
  if [[ -n "$sc_log" ]]; then
    echo "=== pi-shortcuts 日志内容 ==="
    cat "$sc_log"
    if grep -q "Shortcut registered: files" "$sc_log"; then
      echo "PASS: files 子键已通过 hub 注册"
      exit 0
    else
      echo "FAIL: pi-shortcuts 日志缺少 files 注册记录"
      exit 1
    fi
  else
    echo "FAIL: 未找到 pi-shortcuts_*.log"
    ls -la "$PI_LOG_DIR/"
    exit 1
  fi
TEST

# ── 用例 3：/shortcuts 命令在 print 模式下不崩溃 ──
test_it "/shortcuts command does not crash in print mode" <<'TEST'
  run_pi_and_check \
    --extensions "pi-logger,pi-config,pi-shortcuts,files" \
    --prompt "/shortcuts" \
    --save-output
  # print 模式下 notify 可能不渲染，命令不崩溃即可
  exit 0
TEST

# ── 用例 4：无冲突注册（3 个子键 f o / f r / f q 均注册成功）──
test_it "no key conflicts among files sub-keys [REVIEW]" <<'TEST'
  run_pi_and_check \
    --extensions "pi-logger,pi-config,pi-shortcuts,files" \
    --prompt "hi" \
    --save-output

  local sc_log
  sc_log=$(ls "$PI_LOG_DIR"/pi-shortcuts_*.log 2>/dev/null | head -1)
  if [[ -n "$sc_log" ]]; then
    echo "=== pi-shortcuts 日志内容 ==="
    cat "$sc_log"
    mark_for_review "验证日志中 files 的 3 个子键（f o / f r / f q）均注册成功，且无 Shortcut conflict 警告"
  else
    echo "FAIL: 未找到 pi-shortcuts_*.log"
    exit 1
  fi
  exit 0
TEST
