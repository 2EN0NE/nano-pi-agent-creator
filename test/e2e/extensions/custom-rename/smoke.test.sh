#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# custom-rename 扩展端到端测试
#
# Tests:
#   1. 扩展加载无报错（run_pi_and_check + CI mock-llm）
#   2. 首轮成功自动命名（手动沙箱 + 预置 enabled 配置 + 专用 mock-llm）
#
# 运行：
#   CI=true bash test/e2e/scripts/run-e2e.sh --ext custom-rename
#
# 关键点：
#   - 核心行为「首轮自动命名」需要 custom-rename 配置 enabled=true 且
#     model ref 指向 mock-llm/mock-model-1，因此手动预置
#     extensions-data/custom-rename/config.json
#   - 专用 mock-llm（helpers/mock-llm.ts）提供 2 条回复：首轮 agent 回复 +
#     rename LLM 标题回复（"修复登录超时"）
#   - 手动沙箱用 -e 直接加载项目内路径，@zenone 本地包从项目根 node_modules 解析
# ──────────────────────────────────────────────────────────────────────────────

set -euo pipefail
# shellcheck disable=SC2034 # ROOT_DIR 在 test_it heredoc 的 eval 中使用（静态分析不可见）
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
TEST_HOME=$(mktemp -d /tmp/custom-rename-e2e-XXXXXX)
cleanup_all() { rm -rf "$TEST_HOME"; }
trap cleanup_all EXIT

# ── 隔离 HOME（与 run_pi_and_check 一致）──────────────────────────
ISOLATED_HOME="$TEST_HOME/iso-home"

setup_isolated_home() {
  mkdir -p "$ISOLATED_HOME/.pi/agent/extensions-data/custom-rename" "$ISOLATED_HOME/.pi/logs"
  # 预置 mock-llm 模型配置，使命名用例无需真实 LLM API Key
  cat >"$ISOLATED_HOME/.pi/agent/models-store.json" <<'CIEOF'
{
  "mock-llm": {
    "models": [
      {
        "id": "mock-model-1",
        "name": "Mock Model (CI)",
        "api": "openai-completions",
        "provider": "mock-llm",
        "apiKey": "ci-noop-key",
        "baseUrl": "http://localhost:0"
      }
    ],
    "default": "mock-model-1"
  }
}
CIEOF
}

# 预置 custom-rename 配置：enabled=true + model ref 指向 mock 模型
preset_rename_config() {
  mkdir -p "$ISOLATED_HOME/.pi/agent/extensions-data/custom-rename"
  cat >"$ISOLATED_HOME/.pi/agent/extensions-data/custom-rename/config.json" <<'JSONEOF'
{"enabled": true, "model": {"type": "ref", "ref": "mock-llm/mock-model-1"}, "maxTitleLength": 50, "thinkingLevel": "off"}
JSONEOF
}

# 定位 custom-rename 日志（聚合 cwd 与隔离 HOME 两个落点）
find_rename_log() {
  local f
  for f in $(ls -t "$TEST_HOME"/.pi/logs/custom-rename_*.log "$ISOLATED_HOME"/.pi/logs/custom-rename_*.log 2>/dev/null); do
    if grep -q "renamed to\|model not available\|rename LLM call failed\|skip: title empty" "$f" 2>/dev/null; then
      echo "$f"
      return 0
    fi
  done
  return 1
}

# GNU timeout 兼容：macOS 无 timeout 命令
TIMEOUT_CMD=""
if command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_CMD="gtimeout"
elif command -v timeout >/dev/null 2>&1; then
  TIMEOUT_CMD="timeout"
fi
timed_run() {
  local secs="$1"
  shift
  if [[ -n "$TIMEOUT_CMD" ]]; then
    "$TIMEOUT_CMD" "$secs" "$@"
  else
    "$@"
  fi
}

# ── Test 1: 加载无报错 ─────────────────────────────────────────────
test_describe "custom-rename"

test_it "loads without errors" <<'TEST'
  run_pi_and_check \
    --extensions "custom-rename" \
    --prompt "hi" \
    --expect-no-error
  exit 0
TEST

# ── Test 2: 首轮成功自动命名（核心行为）────────────────────────────
test_it "first-turn auto-naming sets session name" <<'TEST'
  setup_isolated_home
  preset_rename_config

  cd "$TEST_HOME"
  set +e
  timed_run 90 env HOME="$ISOLATED_HOME" "$(which pi)" -a --no-session \
    -e "$ROOT_DIR/extensions/tui/custom-rename" \
    -e "$ROOT_DIR/extensions/meta/pi-logger" \
    -e "$ROOT_DIR/test/e2e/extensions/custom-rename/helpers/mock-llm.ts" \
    -p "hi" >"$TEST_HOME/pi-name.log" 2>&1
  local ec=$?
  set -e
  cd "$ROOT_DIR"

  echo "=== pi exit code: $ec ==="
  RENAME_LOG=$(find_rename_log)
  if [[ -n "$RENAME_LOG" ]]; then
    echo "=== custom-rename log: $RENAME_LOG ==="
    cat "$RENAME_LOG"
  else
    echo "(no custom-rename log found)"
    echo "=== pi stdout ==="
    cat "$TEST_HOME/pi-name.log"
  fi

  local F=0
  # 无 JS/module 错误
  if grep -qE "SyntaxError|TypeError|Cannot find module|Failed to load extension" "$TEST_HOME/pi-name.log"; then
    F=$((F + 1))
    echo "[FAIL] JS/module errors in pi stdout"
  else
    echo "[PASS] no JS/module errors"
  fi
  # 核心：重命名发生（mock-llm 第 2 条回复作为标题）
  if [[ -n "$RENAME_LOG" ]] && grep -q 'renamed to "修复登录超时"' "$RENAME_LOG"; then
    echo "[PASS] auto-named to 修复登录超时"
  else
    F=$((F + 1))
    echo "[FAIL] no 'renamed to' in custom-rename log"
  fi
  exit $F
TEST
