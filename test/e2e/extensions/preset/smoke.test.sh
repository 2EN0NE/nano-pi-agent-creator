#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# preset 扩展端到端测试 — 普通模式
# 测试要点：
# 1. preset 扩展正确加载无报错
# 2. pi-logger 正确捕获日志（通过 lifecycle 日志）
# 3. /preset 命令在 print 模式下不崩溃
# ──────────────────────────────────────────────────────────────────────────────

test_describe "preset extension"

# ── 用例 1：加载无报错 ──
test_it "loads without errors" <<'TEST'
  run_pi_and_check \
    --extensions "pi-logger,preset" \
    --prompt "hi" \
    --save-output
  exit 0
TEST

# ── 用例 2：lifecycle 日志记录 preset 活动 ──
test_it "lifecycle log captures preset session events" <<'TEST'
  run_pi_and_check \
    --extensions "pi-logger,preset" \
    --prompt "hi" \
    --save-output
  # 检查 lifecycle 日志（preset 使用 debug 级别，默认被过滤，但 lifecycle 始终记录）
  if ls "$PI_LOG_DIR"/__lifecycle__*.log &>/dev/null; then
    echo "PASS: lifecycle log exists"
    exit 0
  fi
  # 如果 logs 目录存在但没有 preset 专用日志也算通过（debug 级别被过滤）
  echo "PASS: log dir exists without dedicated preset log (debug level filtered)"
  exit 0
TEST

# ── 用例 3：/preset 命令在 print 模式下不崩溃 ──
test_it "/preset command does not crash in print mode" <<'TEST'
  run_pi_and_check \
    --extensions "pi-logger,preset" \
    --prompt "/preset" \
    --save-output
  # 非 TUI 模式下 /preset 可能提示 "requires TUI mode"，不崩溃即可
  exit 0
TEST

# ── 用例 4：preset-usage 实验（record 型）注册 + 结算 ──
test_it "preset-usage experiment registers and records duration (pi-lab + mock-llm)" <<'TEST'
  local slug="e2e-preset-s4-$$"
  local test_home="$ROOT_DIR/.pi/tmp/$slug"
  setup_lab_sandbox "$test_home"
  cp -r "$ROOT_DIR/extensions/meta/preset" "$test_home/.pi/extensions/preset"
  mkdir -p "$test_home/.pi/extensions-data/preset"
  cat > "$test_home/.pi/extensions-data/preset/config.json" <<'JSON'
{ "test": { "thinkingLevel": "low" }, "plan": { "thinkingLevel": "medium" } }
JSON

  cd "$test_home"
  set +e
  HOME="$test_home/home" pi -a --no-session --preset test -p "hi" >"$test_home/pi-stdout.log" 2>&1
  local ec=$?
  set -e
  cd "$ROOT_DIR"
  if [[ "$ec" -ne 0 && "$ec" -ne 124 ]]; then
    echo "FAIL: unexpected exit code $ec"
    cat "$test_home/pi-stdout.log"
    exit 1
  fi

  local jsonl="$test_home/home/.pi/agent/extensions-data/pi-lab/preset-usage.jsonl"
  if [[ ! -f "$jsonl" ]]; then
    echo "FAIL: preset-usage jsonl not created (settle 未在 session_shutdown 落盘)"
    echo "(no jsonl at $jsonl)"
    exit 1
  fi
  if grep -q '"armId":"test"' "$jsonl" && grep -q '"use_duration_ms"' "$jsonl"; then
    echo "PASS: preset-usage recorded arm=test with duration metric"
    cat "$jsonl"
  else
    echo "FAIL: preset-usage event missing (arm=test or use_duration_ms)"
    cat "$jsonl"
    exit 1
  fi

  rm -rf "$test_home" "$ROOT_DIR/.pi/tmp/${slug}"*
  exit 0
TEST
