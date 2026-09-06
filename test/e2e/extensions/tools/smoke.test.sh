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
# Run: bash test/scripts/run-e2e.sh --ext tools
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

  mark_for_review "Verify ctx_search is auto-enabled at session_start:"$'\n'"1. tools log: 'auto-enabled new tool' with ctx_search (new tool discovered)"$'\n'"2. tools log: 'event: session_start'"$'\n'"3. No 'blocked tool call' for ctx_search (it's enabled, not blocked)"
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

  mark_for_review "Verify late-registered ctx_execute is auto-enabled:"$'\n'"1. If the pi process survives >2s: tools log shows 'auto-enabled new tool' with ctx_execute"$'\n'"2. If pi exits before 2s: ctx_execute may NOT appear — this is normal timing behavior"$'\n'"3. No crash from the setTimeout handler"
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

  mark_for_review "Verify disabledTools blocks re-registration:"$'\n'"1. tools log should NOT show 'auto-enabled' for ctx_search (it's in disabledTools)"$'\n'"2. tools log should show 'blocked re-enabled tools' with ctx_search"$'\n'"3. ctx-simulator log: 'ctx_search registered' still appears (it always registers)"
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

  mark_for_review "Full cycle:"$'\n'"PHASE 1: tools log shows 'auto-enabled new tool' with ctx_search (new tool)"$'\n'"PHASE 2: tools log shows 'blocked re-enabled tools' with ctx_search (was disabled)"$'\n'"This proves: enable → disable → re-register → stays disabled permanently"
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

  mark_for_review "Verify execution-level blocking:"$'\n'"1. call-observer log: 'tool_call attempt' with ctx_search (LLM tried to use it)"$'\n'"2. tools log: 'blocked tool call' with ctx_search (tool_call handler blocked)"$'\n'"3. ctx-simulator log: NO 'ctx_search executed' (execution was prevented)"$'\n'"4. ctx_execute should NOT be blocked (it's still in enabledTools)"
TEST

# ====================================================================
# SCENARIO 7: tool-range 实验（select 型）— pi-lab 注册 + 分流
# ====================================================================
# 手动沙箱：tools 依赖 pi-lab（experiment 注册）+ mock-llm（无真实 API）
# 验证：tool-range 实验注册 + session_start 分流（无用户显式配置时）
setup_tool_range_sandbox() {
  local test_home="$1"
  setup_lab_sandbox "$test_home"
  cp -r "$ROOT_DIR/extensions/meta/preset" "$test_home/.pi/extensions/preset"
}

test_it "tool-range experiment registers and assigns arm (pi-lab + mock-llm)" <<'TEST'
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
  if grep -q "Experiment registered: tools/tool-range" $tools_log 2>/dev/null; then
    echo "PASS: tool-range experiment registered"
  else
    echo "FAIL: tool-range experiment not registered"
    cat $tools_log 2>/dev/null || echo "(no tools log)"
    exit 1
  fi

  # 分流结果与臂一致：core 臂 → 启用核心 7 工具且禁用其余；full 臂 → 全启用零禁用。
  # 防止「core 臂形同虚设」（非 core 工具既不 enabled 也不 disabled 会被 auto-enable）
  # 与「分流没应用到工具集」两类回归。
  local assigned_line
  assigned_line=$(grep -h "tool-range assigned" $tools_log 2>/dev/null | tail -1)
  if [[ -z "$assigned_line" ]]; then
    echo "FAIL: tool-range arm not assigned"
    cat $tools_log 2>/dev/null || echo "(no tools log)"
    exit 1
  fi
  echo "PASS: tool-range arm assigned (no user config)"

  local arm enabled disabled
  arm=$(sed -n 's/.*arm=\([a-z]*\).*/\1/p' <<<"$assigned_line")
  enabled=$(sed -n 's/.*enabled=\([0-9]*\).*/\1/p' <<<"$assigned_line")
  disabled=$(sed -n 's/.*disabled=\([0-9]*\).*/\1/p' <<<"$assigned_line")
  echo "INFO: assigned line: $assigned_line"

  if [[ "$arm" == "core" ]]; then
    # core 臂：7 个核心工具全部启用（基础 4 + 搜索 3，增强缺失时回退内置 grep/find/ls），其余被 block
    if [[ "$enabled" -eq 7 ]] && [[ "$disabled" -gt 0 ]]; then
      echo "PASS: core arm applied (enabled=7, disabled=$disabled)"
    else
      echo "FAIL: core arm not applied correctly (enabled=$enabled, disabled=$disabled)"
      exit 1
    fi
  elif [[ "$arm" == "full" ]]; then
    # full 臂：全部工具启用，零禁用
    if [[ "$enabled" -gt 7 ]] && [[ "$disabled" -eq 0 ]]; then
      echo "PASS: full arm applied (enabled=$enabled, disabled=0)"
    else
      echo "FAIL: full arm not applied correctly (enabled=$enabled, disabled=$disabled)"
      exit 1
    fi
  else
    echo "FAIL: unexpected arm '$arm' in: $assigned_line"
    exit 1
  fi

  rm -rf "$test_home" "$ROOT_DIR/.pi/tmp/${slug}"*
  exit 0
TEST
