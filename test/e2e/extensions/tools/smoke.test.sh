#!/usr/bin/env bash
#
# smoke.test.sh — tools.ts e2e tests
#
# Covers ctx-simulator (mocks context-mode MCP tools) integration:
#   - Auto-enable new tools on first discovery
#   - Explicit disable → permanent block
#   - Late-registration → auto-enable
#   - Re-registration of disabled tool → stays blocked
#   - tool_call handler blocks disabled tools at execution time
#
# Run: bash test/e2e/scripts/run-e2e.sh --ext tools
#
# NOTE: EPERM / Connection error warnings are INFRASTRUCTURE issues
# (no model provider in test sandbox). Not code defects.

set -euo pipefail

ROOT_DIR="${ROOT_DIR:?must be set by test runner}"

# ====================================================================
# Helper: copy ctx-simulator to a test home (it's in test/helpers/, not extensions/)
# ====================================================================
setup_test_home() {
  local test_home="$1"
  shift
  mkdir -p "$test_home/.pi/extensions" "$test_home/.pi/logs"

  # Always copy pi-logger (needed for log output)
  cp -r "$ROOT_DIR/extensions/meta/pi-logger" "$test_home/.pi/extensions/pi-logger"
  cp "$ROOT_DIR/pi-logger.json" "$test_home/pi-logger.json" 2>/dev/null || true

  # 拷贝共享 TUI 辅助模块（src/tui/），供 import '.../src/tui/helpers.js' 的扩展在沙箱内解析
  if [[ -d "$ROOT_DIR/src/tui" ]]; then
    mkdir -p "$test_home/src"
    cp -r "$ROOT_DIR/src/tui" "$test_home/src/tui"
  fi

  for name in "$@"; do
    case "$name" in
    tools)
      cp -r "$ROOT_DIR/extensions/meta/preset" "$test_home/.pi/extensions/preset"
      ;;
    ctx-simulator)
      cp "$ROOT_DIR/test/e2e/extensions/tools/helpers/z-ctx-simulator.ts" \
        "$test_home/.pi/extensions/z-ctx-simulator.ts"
      ;;
    call-observer)
      cat >"$test_home/.pi/extensions/call-observer.ts" <<'OBSERVER'
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLogger } from "@zenone/pi-logger";
const log = createLogger("call-observer");
export default function (pi: ExtensionAPI) {
  pi.on("tool_call", (event: any) => {
    log.info("tool_call attempt", {
      tool: event.toolName,
      id: event.toolCallId?.slice(0, 8),
    });
  });
}
OBSERVER
      ;;
    esac
  done
}

# ====================================================================
# Helper: run pi in test home and capture output
# ====================================================================
run_pi() {
  local test_home="$1"
  local slug="$2"
  local prompt="${3:-hi}"

  cd "$test_home"
  set +e
  pi -a --no-session -p "$prompt" \
    >"$ROOT_DIR/.pi/tmp/${slug}-stdout.log" 2>&1
  local ec=$?
  set -e
  cd "$ROOT_DIR"
  echo "pi exit: $ec"
}

# ====================================================================
# Helper: dump test results
# ====================================================================
dump_logs() {
  local test_home="$1"
  echo "=== EXTENSIONS DIR ==="
  ls -la "$test_home/.pi/extensions/" 2>/dev/null || echo "(no dir)"
  echo "=== LOG FILES ==="
  ls -la "$test_home/.pi/logs/" 2>/dev/null || echo "(no logs)"
  for f in "$test_home/.pi/logs/"*.log; do
    [[ -f "$f" ]] || continue
    local bn=$(basename "$f")
    echo "--- $bn ---"
    cat "$f"
  done
}

# ====================================================================
# SCENARIO 1: ctx-simulator alone — tools register correctly
# ====================================================================
test_it "ctx-simulator alone registers both tools [REVIEW]" <<'TEST'
  local slug="e2e-tools-s1-$$"
  local test_home="$ROOT_DIR/.pi/tmp/$slug"
  setup_test_home "$test_home" ctx-simulator
  run_pi "$test_home" "$slug" "hi"

  echo "=== ctx-simulator log ==="
  cat "$test_home/.pi/logs/ctx-simulator_"*.log 2>/dev/null || echo "(none)"
  echo "=== lifecycle (first 20 lines) ==="
  head -20 "$test_home/.pi/logs/__lifecycle__"*.log 2>/dev/null || echo "(none)"

  rm -rf "$test_home" "$ROOT_DIR/.pi/tmp/${slug}"*

  mark_for_review "Verify ctx-simulator works standalone:"$'\n'"1. ctx-simulator log: 'ctx_search registered (simulating early connect)'"$'\n'"2. ctx-simulator log: 'ctx_execute registered (simulating late connect)'"$'\n'"3. No crash, no error"
TEST

# ====================================================================
# SCENARIO 2: tools + ctx-simulator — ctx_search auto-enabled
# ====================================================================
test_it "tools + ctx-simulator: auto-enables ctx_search on session_start [REVIEW]" <<'TEST'
  local slug="e2e-tools-s2-$$"
  local test_home="$ROOT_DIR/.pi/tmp/$slug"
  setup_test_home "$test_home" tools ctx-simulator
  run_pi "$test_home" "$slug" "hi"

  echo "=== tools log ==="
  cat "$test_home/.pi/logs/tools_"*.log 2>/dev/null || echo "(none)"
  echo "=== ctx-simulator log ==="
  cat "$test_home/.pi/logs/ctx-simulator_"*.log 2>/dev/null || echo "(none)"

  rm -rf "$test_home" "$ROOT_DIR/.pi/tmp/${slug}"*

  mark_for_review "Verify ctx_search is available at session_start (base layer opt-out, ADR-0049):"$'\n'"1. tools log: 'tools applied' (基础层恢复/应用)"$'\n'"2. 运行时新注册工具默认并入基础层（pi.registerTool 的启用行为）"$'\n'"3. tools log 不出现 'tool blocked' for ctx_search"
TEST

# ====================================================================
# SCENARIO 3: tools + ctx-simulator — ctx_execute auto-enabled on late register
# ====================================================================
test_it "tools + ctx-simulator: auto-enables ctx_execute on late registration [REVIEW]" <<'TEST'
  local slug="e2e-tools-s3-$$"
  local test_home="$ROOT_DIR/.pi/tmp/$slug"
  setup_test_home "$test_home" tools ctx-simulator
  run_pi "$test_home" "$slug" "hi"

  echo "=== tools log ==="
  cat "$test_home/.pi/logs/tools_"*.log 2>/dev/null || echo "(none)"

  rm -rf "$test_home" "$ROOT_DIR/.pi/tmp/${slug}"*

  mark_for_review "Verify late-registered ctx_execute is available:"$'\n'"1. 运行时新注册工具默认并入基础层（无 auto-enable 通知，opt-out 语义）"$'\n'"2. tools log 不出现 'tool blocked' for ctx_execute"$'\n'"3. No crash from the setTimeout handler"
TEST

# ====================================================================
# SCENARIO 4: tools + ctx-simulator — disabled ctx_search stays blocked
# ====================================================================
test_it "tools + ctx-simulator: disabled ctx_search stays blocked [REVIEW]" <<'TEST'
  local slug="e2e-tools-s4-$$"
  local test_home="$ROOT_DIR/.pi/tmp/$slug"
  setup_test_home "$test_home" tools ctx-simulator

  # Pre-configure: ctx_search is DISABLED
  mkdir -p "$test_home/.pi/sessions"
  python3 -c "
import json, os, uuid
sid = str(uuid.uuid4())
d = f'$test_home/.pi/sessions/{sid}'
os.makedirs(d, exist_ok=True)
entry = {
    'type': 'custom',
    'customType': 'tools-config',
    'data': {
        'enabledTools': ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls', 'ctx_execute'],
        'disabledTools': ['ctx_search'],
    }
}
with open(f'{d}/branch.json', 'w') as f: json.dump([entry], f)
with open(f'$test_home/.pi/sessions/current.json', 'w') as f: json.dump({'sessionId': sid}, f)
" 2>/dev/null

  run_pi "$test_home" "$slug" "hi"

  dump_logs "$test_home"

  rm -rf "$test_home" "$ROOT_DIR/.pi/tmp/${slug}"*

  mark_for_review "Verify disabledTools keeps ctx_search blocked:"$'\n'"1. tools log 不出现 'tool blocked' 直到 LLM 调用；基础层 disabledTools 决定有效集"$'\n'"2. tool_call 触发时 tools log 出现 'tool blocked' with ctx_search"$'\n'"3. ctx-simulator log: 'ctx_search registered' still appears (它只负责注册)"
TEST

# ====================================================================
# SCENARIO 5: full cycle — enable → disable → stays disabled
# ====================================================================
test_it "full cycle: enable → disable → re-register → stays disabled [REVIEW]" <<'TEST'
  local slug="e2e-tools-s5-$$"
  local test_home="$ROOT_DIR/.pi/tmp/$slug"
  setup_test_home "$test_home" tools ctx-simulator

  # ── Phase 1: fresh start, all tools auto-enabled ──
  echo "──────────────────── PHASE 1 ────────────────────"
  run_pi "$test_home" "$slug-p1" "hi"
  echo "--- tools log p1 ---"
  cat "$test_home/.pi/logs/tools_"*.log 2>/dev/null || echo "(none)"

  # ── Phase 2: user disabled ctx_search, re-run ──
  echo "──────────────────── PHASE 2 ────────────────────"
  rm -f "$test_home/.pi/logs/"*.log
  mkdir -p "$test_home/.pi/sessions"
  python3 -c "
import json, os, uuid
sid = str(uuid.uuid4())
d = f'$test_home/.pi/sessions/{sid}'
os.makedirs(d, exist_ok=True)
entry = {
    'type': 'custom',
    'customType': 'tools-config',
    'data': {
        'enabledTools': ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls', 'ctx_execute'],
        'disabledTools': ['ctx_search'],
    }
}
with open(f'{d}/branch.json', 'w') as f: json.dump([entry], f)
with open(f'$test_home/.pi/sessions/current.json', 'w') as f: json.dump({'sessionId': sid}, f)
" 2>/dev/null

  run_pi "$test_home" "$slug-p2" "hi"
  echo "--- tools log p2 ---"
  cat "$test_home/.pi/logs/tools_"*.log 2>/dev/null || echo "(none)"

  rm -rf "$test_home" "$ROOT_DIR/.pi/tmp/${slug}"*

  mark_for_review "Full cycle (ADR-0049/0050 基础层 opt-out):"$'\n'"PHASE 1: 新工具默认启用，无 'tool blocked'"$'\n'"PHASE 2: ctx_search 在 disabledTools → tool_call 时 'tool blocked'"$'\n'"This proves: enable → disable → 重新注册后仍被基础层禁用"
TEST

# ====================================================================
# SCENARIO 6: tool_call handler blocks disabled tool at execution
# ====================================================================
test_it "tool_call handler blocks disabled ctx_search, allows enabled ctx_execute [REVIEW]" <<'TEST'
  local slug="e2e-tools-s6-$$"
  local test_home="$ROOT_DIR/.pi/tmp/$slug"
  setup_test_home "$test_home" tools ctx-simulator call-observer

  # Pre-configure: ctx_search DISABLED, ctx_execute ENABLED
  mkdir -p "$test_home/.pi/sessions"
  python3 -c "
import json, os, uuid
sid = str(uuid.uuid4())
d = f'$test_home/.pi/sessions/{sid}'
os.makedirs(d, exist_ok=True)
entry = {
    'type': 'custom',
    'customType': 'tools-config',
    'data': {
        'enabledTools': ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls', 'ctx_execute'],
        'disabledTools': ['ctx_search'],
    }
}
with open(f'{d}/branch.json', 'w') as f: json.dump([entry], f)
with open(f'$test_home/.pi/sessions/current.json', 'w') as f: json.dump({'sessionId': sid}, f)
" 2>/dev/null

  run_pi "$test_home" "$slug" "Use ctx_search to search for 'test' in the knowledge base"

  dump_logs "$test_home"

  echo "=== stdout (first 40 lines) ==="
  head -40 "$ROOT_DIR/.pi/tmp/${slug}-stdout.log" 2>/dev/null || echo "(none)"

  rm -rf "$test_home" "$ROOT_DIR/.pi/tmp/${slug}"*

  mark_for_review "Verify execution-level blocking:"$'\n'"1. call-observer log: 'tool_call attempt' with ctx_search (LLM tried to use it)"$'\n'"2. tools log: 'tool blocked' with ctx_search (tool_call handler blocked)"$'\n'"3. ctx-simulator log: NO 'ctx_search executed' (execution was prevented)"$'\n'"4. ctx_execute should NOT be blocked (not in disabledTools)"
TEST

# ====================================================================
# SCENARIO 7: tool-range 实验（select 型）— 未报名只观测、不限制
# ====================================================================
# 手动沙箱：tools 依赖 pi-lab（experiment 注册）+ mock-llm（无真实 API）。
# ADR-0050 决策 3 / B2：默认（未报名）不 select、不改变活动工具集。
setup_tool_range_sandbox() {
  local test_home="$1"
  setup_lab_sandbox "$test_home"
  cp -r "$ROOT_DIR/extensions/meta/preset" "$test_home/.pi/extensions/preset"
}

# 显式报名（写 user 级 tools config）后，臂结果才写入基础层。
setup_tool_range_enrolled_sandbox() {
  local test_home="$1"
  setup_tool_range_sandbox "$test_home"
  mkdir -p "$test_home/home/.pi/agent/extensions-data/tools"
  printf '{"enableToolRange": true}' >"$test_home/home/.pi/agent/extensions-data/tools/config.json"
}

test_it "tool-range 未报名 → 只观测不限制（无 arm 分配）" <<'TEST'
  local slug="e2e-tools-s7-$$"
  local test_home="$ROOT_DIR/.pi/tmp/$slug"
  setup_tool_range_sandbox "$test_home"

  cd "$test_home"
  set +e
  HOME="$test_home/home" pi -a --no-session -p "hi" >"$test_home/pi-stdout.log" 2>&1
  local ec=$?
  set -e
  cd "$ROOT_DIR"

  if [[ "$ec" -ne 0 && "$ec" -ne 124 ]]; then
    echo "FAIL: unexpected exit code $ec"
    cat "$test_home/pi-stdout.log"
    exit 1
  fi

  local tools_log="$test_home/.pi/logs/tools_"*.log
  if grep -q "tool-range: not enrolled" $tools_log 2>/dev/null; then
    echo "PASS: tool-range not enrolled (observe only)"
  else
    echo "FAIL: expected 'not enrolled' log"
    cat $tools_log 2>/dev/null || echo "(no tools log)"
    exit 1
  fi

  # 硬约束：未报名时不得分配臂（否则实验会静默改变用户环境）
  if grep -q "tool-range assigned" $tools_log 2>/dev/null; then
    echo "FAIL: arm assigned despite not being enrolled"
    grep "tool-range assigned" $tools_log
    exit 1
  fi
  echo "PASS: no experiment restriction applied (ADR-0050 决策 3)"

  rm -rf "$test_home" "$ROOT_DIR/.pi/tmp/${slug}"*
  exit 0
TEST

# ====================================================================
# SCENARIO 8: tool-range 显式报名 → 臂结果写入基础层
# ====================================================================
test_it "tool-range 显式报名 → 分配臂并应用（core: enabled=7 disabled>0 / full: disabled=0）" <<'TEST'
  local slug="e2e-tools-s8-$$"
  local test_home="$ROOT_DIR/.pi/tmp/$slug"
  setup_tool_range_enrolled_sandbox "$test_home"

  cd "$test_home"
  set +e
  HOME="$test_home/home" pi -a --no-session -p "hi" >"$test_home/pi-stdout.log" 2>&1
  local ec=$?
  set -e
  cd "$ROOT_DIR"

  if [[ "$ec" -ne 0 && "$ec" -ne 124 ]]; then
    echo "FAIL: unexpected exit code $ec"
    cat "$test_home/pi-stdout.log"
    exit 1
  fi

  local tools_log="$test_home/.pi/logs/tools_"*.log
  local assigned_line
  assigned_line=$(grep -h "tool-range assigned" $tools_log 2>/dev/null | tail -1)
  if [[ -z "$assigned_line" ]]; then
    echo "FAIL: tool-range arm not assigned after enrollment"
    cat $tools_log 2>/dev/null || echo "(no tools log)"
    exit 1
  fi
  echo "INFO: assigned line: $assigned_line"

  local arm effective
  arm=$(sed -n 's/.*arm=\([a-z]*\).*/\1/p' <<<"$assigned_line")
  effective=$(sed -n 's/.*effective=\([0-9]*\).*/\1/p' <<<"$assigned_line")

  if [[ "$arm" == "core" ]]; then
    # core 臂：7 个核心工具生效（基础 4 + 搜索 3，增强缺失时回退内置 grep/find/ls）
    if [[ "$effective" -eq 7 ]]; then
      echo "PASS: core arm applied (effective=7)"
    else
      echo "FAIL: core arm not applied correctly (effective=$effective)"
      exit 1
    fi
  elif [[ "$arm" == "full" ]]; then
    if [[ "$effective" -gt 7 ]]; then
      echo "PASS: full arm applied (effective=$effective)"
    else
      echo "FAIL: full arm not applied correctly (effective=$effective)"
      exit 1
    fi
  else
    echo "FAIL: unexpected arm '$arm' in: $assigned_line"
    exit 1
  fi

  rm -rf "$test_home" "$ROOT_DIR/.pi/tmp/${slug}"*
  exit 0
TEST

# ====================================================================
# SCENARIO 9/10: ADR-0050 契约1/2 — 动态注册工具与 preset overlay
# ====================================================================
# 手动沙箱：mock-llm 脚本强制 LLM 调用 ctx_search；preset 扩展提供 overlay。
setup_preset_dynamic_sandbox() {
  local test_home="$1"
  local preset_json="$2"
  setup_lab_sandbox "$test_home"
  cp -r "$ROOT_DIR/extensions/meta/preset" "$test_home/.pi/extensions/preset"
  cp "$ROOT_DIR/test/e2e/extensions/tools/helpers/dynamic-registrar.ts" \
    "$test_home/.pi/extensions/dynamic-registrar.ts"
  mkdir -p "$test_home/home/.pi/agent/extensions-data/preset"
  printf '%s' "$preset_json" >"$test_home/home/.pi/agent/extensions-data/preset/config.json"
}

run_dynamic_tool_pi() {
  local test_home="$1"
  local extra_args="$2"
  cd "$test_home"
  set +e
  MOCK_LLM_TOOL_SCRIPT='[{"tool":"mock_search","args":{"pattern":"x"}},{"text":"done"}]' \
    HOME="$test_home/home" pi -a --no-session -p "search" $extra_args \
    >"$test_home/pi-stdout.log" 2>&1
  local ec=$?
  set -e
  cd "$ROOT_DIR"
  echo "$ec"
}

test_it "无 preset：第三方动态注册工具不被限制（ADR-0050 契约1）" <<'TEST'
  local slug="e2e-tools-s9-$$"
  local test_home="$ROOT_DIR/.pi/tmp/$slug"
  setup_preset_dynamic_sandbox "$test_home" '{}'

  local ec
  ec=$(run_dynamic_tool_pi "$test_home" "")
  if [[ "$ec" -ne 0 && "$ec" -ne 124 ]]; then
    echo "FAIL: unexpected exit code $ec"; cat "$test_home/pi-stdout.log"; exit 1
  fi

  local tools_log="$test_home/.pi/logs/tools_"*.log
  local ctx_log="$test_home/.pi/logs/dynamic-registrar_"*.log

  if grep -q "mock_search executed" $ctx_log 2>/dev/null; then
    echo "PASS: dynamically registered mock_search executed"
  else
    echo "FAIL: mock_search was not executed"; dump_logs "$test_home"; exit 1
  fi
  if grep -q "tool blocked" $tools_log 2>/dev/null; then
    echo "FAIL: tool blocked despite no preset overlay"; grep "tool blocked" $tools_log; exit 1
  fi
  echo "PASS: no restriction imposed on dynamic tool (ADR-0050 契约1)"

  rm -rf "$test_home" "$ROOT_DIR/.pi/tmp/${slug}"*
  exit 0
TEST
