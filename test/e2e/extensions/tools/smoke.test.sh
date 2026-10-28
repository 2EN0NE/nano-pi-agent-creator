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
# SCENARIO 4: 旧 tools-config entry 不再影响行为（ADR-0065 D2）
# ====================================================================
# 私有基础层（disabledTools / tools-config）已删除：历史会话里残留的 tools-config
# entry 不再禁用工具 —— 动态注册的工具照常可用，且不被 tool_call 硬拦截。
test_it "旧 tools-config entry 被忽略：动态工具不被拦截（ADR-0065）" <<'TEST'
  local slug="e2e-tools-s4-$$"
  local test_home="$ROOT_DIR/.pi/tmp/$slug"
  setup_test_home "$test_home" tools ctx-simulator call-observer

  # 预置历史遗留的 tools-config entry（旧版本的私有基础层）
  mkdir -p "$test_home/.pi/sessions"
  python3 -c "
import json, os, uuid
sid = str(uuid.uuid4())
d = f'$test_home/.pi/sessions/{sid}'
os.makedirs(d, exist_ok=True)
entry = {
    'type': 'custom',
    'customType': 'tools-config',
    'data': {'disabledTools': ['ctx_search']},
}
with open(f'{d}/branch.json', 'w') as f: json.dump([entry], f)
with open(f'$test_home/.pi/sessions/current.json', 'w') as f: json.dump({'sessionId': sid}, f)
" 2>/dev/null

  run_pi "$test_home" "$slug" "Use ctx_search to search for 'test' in the knowledge base"

  local tools_log="$test_home/.pi/logs/tools_"*.log
  if grep -q "tool blocked" $tools_log 2>/dev/null; then
    echo "FAIL: 旧 tools-config entry 仍在拦截工具（基础层应已删除，ADR-0065 D2）"
    grep "tool blocked" $tools_log
    dump_logs "$test_home"
    exit 1
  fi
  echo "PASS: 旧 tools-config entry 不再拦截工具（ADR-0065 D2）"

  rm -rf "$test_home" "$ROOT_DIR/.pi/tmp/${slug}"*
  exit 0
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
# SCENARIO 8: tool-range 显式报名 → 臂结果生效（core 收紧 / full 不限制，不落长期状态）
# ====================================================================
test_it "tool-range 显式报名 → 分配臂并生效（core: effective=7 injected>0 / full: injected=0）" <<'TEST'
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

  local arm effective injected
  arm=$(sed -n 's/.*arm=\([a-z]*\).*/\1/p' <<<"$assigned_line")
  effective=$(sed -n 's/.*effective=\([0-9]*\).*/\1/p' <<<"$assigned_line")
  injected=$(sed -n 's/.*injected=\([0-9]*\).*/\1/p' <<<"$assigned_line")

  if [[ "$arm" == "core" ]]; then
    # core 臂 = 施加限制：生效集被收窄 + 其余被实验注入禁用。
    # **不钉死绝对数量**：effective 取决于本进程实际注册/启用的工具（CI 上扩展装载集与
    # 本机不同，实测 CI 得到 effective=4 而本机 7），钉死 7 会在异地环境假失败。
    # 断言改为语义：arm 已分配 + 确有注入（injected>0）+ 生效集非空。
    if [[ "$effective" -gt 0 && "$injected" -gt 0 ]]; then
      echo "PASS: core arm applied (effective=$effective injected=$injected)"
    else
      echo "FAIL: core arm not applied correctly (effective=$effective injected=$injected)"
      exit 1
    fi
  elif [[ "$arm" == "full" ]]; then
    # full 臂 = 不施加限制（ADR-0065）：不注入禁用项，活动集保持 pi 现状
    if [[ "$injected" -eq 0 ]]; then
      echo "PASS: full arm imposes no restriction (injected=0 effective=$effective)"
    else
      echo "FAIL: full arm should not restrict tools (injected=$injected)"
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
