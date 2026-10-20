#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# pi-rewind 扩展 e2e 测试（使用 mock LLM）
#
# 验证 checkpointTrigger 三态在真实 pi 进程中的触发语义：
#   1. message（默认）：每条用户消息 → checkpoint finalized
#   2. event：普通消息不打点（仅 fork/clone/tree/命令事件前打快照——
#      fork/tree 需 TUI 导航交互，print 模式无法触发，其 git 快照逻辑由
#      vitest EventCheckpointCapturer 覆盖）
#   3. off：完全不打点
#
# ⚠️ 已知盲区（测试分析 [P2]）：event 模式「事件前快照」的**正向** hook 接线
#   （session_before_fork/tree → createEventCheckpoint → appendEntry）在真实
#   Pi 进程中无 TUI 导航用例覆盖——需持久化会话 + TUI expect 驱动 /fork、/tree，
#   与 AGENTS.md「默认 --no-session」约定冲突且成本高，暂以 vitest
#   EventCheckpointCapturer（git 快照层）+ 本文件负向断言（普通消息不打点）
#   兜底；若未来补 TUI 正向用例，放置于 test/e2e/extensions/pi-rewind/ 下
#   tui-expect.smoke.test.sh（fork 依赖两条 session 文件，属 --no-session 例外）。
#
# 运行：bash test/e2e/scripts/run-e2e.sh --ext pi-rewind
# ──────────────────────────────────────────────────────────────────────────────

test_describe "pi-rewind extension"

# ====================================================================
# 带超时保护的 pi 调用（发现 [P2]：per-case 超时，避免扩展挂起时只能靠
# pool worker 900s 兜底拖住整个 shard）。
#   Linux（CI）有 GNU timeout；macOS 无 → background + wait + kill 兜底。
# 退出码 0/124 均视为 pi 正常跑完（mock 回复后 pi 不主动退出是预期行为）。
# ====================================================================
run_pi_with_timeout() {
  local test_home="$1"
  local stdout_file="$test_home/pi-stdout.log"
  local timeout_seconds="${RUN_PI_TIMEOUT:-120}"

  cd "$test_home"
  set +e
  if command -v timeout >/dev/null 2>&1; then
    HOME="$test_home/home" timeout "$timeout_seconds" pi -a --no-session -p "hi" >"$stdout_file" 2>&1
    local ec=$?
  else
    HOME="$test_home/home" pi -a --no-session -p "hi" >"$stdout_file" 2>&1 &
    local pid=$!
    local waited=0
    while kill -0 "$pid" 2>/dev/null && ((waited < timeout_seconds)); do
      sleep 1
      waited=$((waited + 1))
    done
    if kill -0 "$pid" 2>/dev/null; then
      echo "  [run_pi TIMEOUT] pi 超过 ${timeout_seconds}s，强制终止"
      kill -TERM -- -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
      sleep 2
      kill -KILL -- -"$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
      local ec=124
    else
      wait "$pid"
      local ec=$?
    fi
  fi
  set -e
  cd "$ROOT_DIR"
  return "$ec"
}

# ====================================================================
# 组装 + 运行 + 断言单个 trigger 场景（手动沙箱，支持预写用户级配置）
#   $1 = trigger: message | event | off
#   $2 = expect_finalized: true（断言含 checkpoint finalized）| false（断言不含）
# ====================================================================
run_trigger_case() {
  local trigger="$1"
  local expect_finalized="$2"
  local slug="pirw-${trigger}-$$-$RANDOM"
  local test_home="$ROOT_DIR/.pi/tmp/$slug"
  local home_dir="$test_home/home"

  mkdir -p "$home_dir/.pi/agent/extensions" "$test_home/.pi/extensions" "$test_home/.pi/logs"

  # ── 扩展：pi-rewind + pi-logger + mock-llm ──
  cp -r "$ROOT_DIR/extensions/auto/pi-rewind" "$test_home/.pi/extensions/pi-rewind"
  cp -r "$ROOT_DIR/extensions/meta/pi-logger" "$test_home/.pi/extensions/pi-logger"
  mkdir -p "$test_home/.pi/extensions/mock-llm"
  cp "$ROOT_DIR/test/e2e/helpers/mock-llm.ts" "$test_home/.pi/extensions/mock-llm/index.ts"

  # ── src/tui 共享模块（pi-logger import ../../../src/tui/helpers.js，3 层上溯到 $test_home/src/tui）──
  if [[ -d "$ROOT_DIR/src/tui" ]]; then
    mkdir -p "$test_home/src"
    cp -r "$ROOT_DIR/src/tui" "$test_home/src/tui"
  fi

  # ── @zenone 链接（pi-rewind/pi-logger import @zenone/pi-*，双保险不依赖外层 node_modules）──
  mkdir -p "$test_home/node_modules/@zenone"
  ln -sfn "$ROOT_DIR/extensions/meta/pi-logger" "$test_home/node_modules/@zenone/pi-logger"
  ln -sfn "$ROOT_DIR/extensions/meta/pi-config" "$test_home/node_modules/@zenone/pi-config"

  # ── pi-logger 配置（cwd 项目级 + 隔离 HOME 用户级）──
  cp "$ROOT_DIR/extensions/meta/pi-logger/pi-logger.json" "$test_home/.pi/pi-logger.json"
  mkdir -p "$home_dir/.pi/agent"
  cp "$ROOT_DIR/extensions/meta/pi-logger/pi-logger.json" "$home_dir/.pi/agent/pi-logger.json"

  # ── 模型配置：mock provider（初始模型同 provider，避免启动时未注册 provider 警告）──
  cat >"$home_dir/.pi/agent/models-store.json" <<'JSON'
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
JSON

  # ── pi-rewind 配置（message 为默认值，不写文件；event/off 写入用户级）──
  if [[ "$trigger" != "message" ]]; then
    mkdir -p "$home_dir/.pi/agent/extensions-data/pi-rewind"
    printf '{"checkpointTrigger":"%s"}\n' "$trigger" >"$home_dir/.pi/agent/extensions-data/pi-rewind/config.json"
  fi

  # ── 运行 pi（print 模式，单轮 mock 回复，per-case 超时保护）──
  run_pi_with_timeout "$test_home"
  local ec=$?

  echo "  (trigger=$trigger, pi exit=$ec)"
  # 0（自然退出）或 124（mock 回复后超时）都视为 pi 正常跑完
  if [[ "$ec" -ne 0 && "$ec" -ne 124 ]]; then
    echo "FAIL: unexpected pi exit code $ec"
    cat "$test_home/pi-stdout.log" 2>/dev/null
    rm -rf "$test_home"
    return 1
  fi

  # ── 日志断言：找到 pi-rewind 日志 ──
  local log
  log=$(find "$test_home" -name 'pi-rewind_*.log' 2>/dev/null | head -1)
  if [[ -z "$log" ]]; then
    echo "FAIL: no pi-rewind log file"
    find "$test_home" -name '*.log' 2>/dev/null || true
    rm -rf "$test_home"
    return 1
  fi
  echo "  (log: $(basename "$log"))"

  # session_start 必须记录本次 trigger
  if ! grep -q "session_start.*trigger=$trigger" "$log"; then
    echo "FAIL: missing session_start trigger=$trigger"
    cat "$log"
    rm -rf "$test_home"
    return 1
  fi

  # checkpoint finalized 按期望出现/不出现
  if [[ "$expect_finalized" == "true" ]]; then
    if ! grep -q "checkpoint finalized" "$log"; then
      echo "FAIL: expected 'checkpoint finalized' (message mode)"
      cat "$log"
      rm -rf "$test_home"
      return 1
    fi
  else
    if grep -q "checkpoint finalized" "$log"; then
      echo "FAIL: unexpected 'checkpoint finalized' in $trigger mode"
      cat "$log"
      rm -rf "$test_home"
      return 1
    fi
  fi

  rm -rf "$test_home"
  return 0
}

# ====================================================================
# 用例 1：message（默认）— 每条消息产生 checkpoint
# ====================================================================
test_it "message mode auto-checkpoints per message" <<'TEST'
  run_trigger_case "message" "true"
TEST

# ====================================================================
# 用例 2：event — 普通消息不打点（仅事件前快照）
# ====================================================================
test_it "event mode does not checkpoint on plain messages" <<'TEST'
  run_trigger_case "event" "false"
TEST

# ====================================================================
# 用例 3：off — 完全不打点
# ====================================================================
test_it "off mode never checkpoints" <<'TEST'
  run_trigger_case "off" "false"
TEST
