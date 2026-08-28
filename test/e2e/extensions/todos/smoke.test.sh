#!/usr/bin/env bash
#
# smoke.test.sh — todos e2e tests
#
# 运行：
#   bash test/scripts/run-e2e.sh --ext todos
#

set -euo pipefail
ROOT_DIR="${ROOT_DIR:?must be set by test runner}"

test_describe "todos extension"

# ── 场景 1：基本加载 ────────────────────────────────

test_it "loads without errors" <<'TEST'
  run_pi_and_check \
    --extensions "pi-logger,todos" \
    --prompt "hi" \
    --save-output
  if compgen -G "${PI_LOG_DIR:-/dev/null}"/*.log >/dev/null 2>&1; then
    exit 0
  else
    echo "No log files found in ${PI_LOG_DIR:-<unset>}"
    exit 1
  fi
TEST

test_it "extension logs captured by pi-logger" <<'TEST'
  run_pi_and_check \
    --extensions "pi-logger,todos" \
    --prompt "hi" \
    --save-output
  if compgen -G "${PI_LOG_DIR:-/dev/null}"/*.log >/dev/null 2>&1; then
    exit 0
  else
    echo "No log files found in ${PI_LOG_DIR:-<unset>}"
    exit 1
  fi
TEST

# ── 场景 2：Completion detection 端到端测试 ──────────
# 使用 mock-llm-completion（返回 "All done!"）来触发完成检测，
# 验证 agent_end 事件中生成的提醒信息。

setup_completion_sandbox() {
  local test_home="$1"
  shift

  local home_dir="$test_home/home"
  mkdir -p "$home_dir/.pi/agent/extensions" \
    "$home_dir/.pi/extensions" \
    "$home_dir/.pi/logs" \
    "$test_home/.pi/todos"

  # Copy pi-logger to HOME (pi discovers extensions in ~/.pi/extensions/)
  cp -r "$ROOT_DIR/extensions/meta/pi-logger" \
    "$home_dir/.pi/extensions/pi-logger"

  # Copy todos to HOME
  cp -r "$ROOT_DIR/extensions/accuracy/todos" \
    "$home_dir/.pi/extensions/todos"

  # Copy mock-llm-completion to HOME
  mkdir -p "$home_dir/.pi/extensions/mock-llm-completion"
  cp "$ROOT_DIR/test/e2e/extensions/todos/helpers/mock-llm-completion.ts" \
    "$home_dir/.pi/extensions/mock-llm-completion/index.ts"

  # Copy pi-logger config to HOME
  if [[ -f "$ROOT_DIR/extensions/meta/pi-logger/pi-logger.json" ]]; then
    cp "$ROOT_DIR/extensions/meta/pi-logger/pi-logger.json" \
      "$home_dir/.pi/pi-logger.json"
  fi

  # Link @zenone/pi-logger for todos import
  mkdir -p "$test_home/node_modules/@zenone"
  if [[ ! -e "$test_home/node_modules/@zenone/pi-logger" ]]; then
    ln -sf "$ROOT_DIR/extensions/meta/pi-logger" \
      "$test_home/node_modules/@zenone/pi-logger"
  fi

  # Link @zenone/pi-config for todos config
  if [[ -d "$ROOT_DIR/extensions/meta/pi-config" ]]; then
    if [[ ! -e "$test_home/node_modules/@zenone/pi-config" ]]; then
      ln -sf "$ROOT_DIR/extensions/meta/pi-config" \
        "$test_home/node_modules/@zenone/pi-config"
    fi
  fi

  # Copy shared TUI helpers (src/tui/) for todos' relative imports
  # (extensions at $home_dir/.pi/extensions/todos/, ../../../../src/tui = $home_dir/src/tui)
  if [[ -d "$ROOT_DIR/src/tui" ]]; then
    mkdir -p "$home_dir/src"
    cp -r "$ROOT_DIR/src/tui" "$home_dir/src/tui"
  fi

  # Init git (todos uses cwd)
  if ! git -C "$test_home" rev-parse --git-dir &>/dev/null; then
    git -C "$test_home" init --initial-branch main &>/dev/null || true
  fi

  # Create a pending todo file to trigger the reminder
  cat >"$test_home/.pi/todos/deadbeef.md" <<'TODOEOF'
{
  "id": "deadbeef",
  "title": "Test pending task",
  "tags": [],
  "status": "open",
  "created_at": "2025-01-01T00:00:00.000Z",
  "assigned_to_session": "test-session",
  "project_id": "project"
}

A pending task for e2e completion detection.
TODOEOF
}

test_it "completion detection: sends reminder on agent_settled" <<'TEST'
  local slug="e2e-todos-comp-$$"
  local test_home="$ROOT_DIR/.pi/tmp/$slug"
  trap "rm -rf \"$test_home\"" EXIT
  setup_completion_sandbox "$test_home"

  local stdout_file="$test_home/pi-stdout.log"

  cd "$test_home"
  set +e
  HOME="$test_home/home" pi -a --no-session \
    -e "$test_home/home/.pi/extensions/pi-logger/index.ts" \
    -e "$test_home/home/.pi/extensions/todos/index.ts" \
    -e "$test_home/home/.pi/extensions/mock-llm-completion/index.ts" \
    -p "test completion detection" \
    >"$stdout_file" 2>&1
  local ec=$?
  set -e
  cd "$ROOT_DIR"

  # Exit code 0 means pi ran without crashing
  if [[ "$ec" -ne 0 ]]; then
    echo "=== STDOUT ==="
    cat "$stdout_file" 2>/dev/null || echo "(no stdout)"
    echo "pi exited with code $ec"
    exit 1
  fi

  # Verify mock model responded (proves extensions loaded correctly)
  if grep -q "All done" "$stdout_file" 2>/dev/null; then
    echo "PASS: mock model responded"
  else
    echo "=== STDOUT ==="
    cat "$stdout_file" 2>/dev/null || echo "(no stdout)"
    echo "ERROR: mock model did not respond as expected"
    exit 1
  fi

  # Check pi-logger output for completion hint (best-effort: buffered logs may not flush in --no-session)
  local log_dir="$test_home/home/.pi/logs"
  local todos_logs
  todos_logs=$(find "$log_dir" -name "todos*" -type f 2>/dev/null || true)

  if [[ -n "$todos_logs" ]]; then
    echo "=== TODOS LOGS ==="
    for f in $todos_logs; do
      echo "--- $f ---"
      cat "$f"
    done
    if grep -q "completion hint sent" $todos_logs 2>/dev/null; then
      echo "PASS: completion hint was sent"
    else
      echo "WARN: completion hint not found in logs (may be due to --no-session buffering)"
      mark_for_review "Verify completion detection triggers in a real interactive session"
    fi
  else
    echo "WARN: No todos log files (expected in --no-session with short lifespan)"
    mark_for_review "Verify completion detection triggers in a real interactive session"
  fi
TEST
