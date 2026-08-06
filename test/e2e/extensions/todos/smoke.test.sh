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
		"$test_home/.pi/extensions" \
		"$test_home/.pi/logs" \
		"$test_home/.pi/todos"

	# Copy pi-logger
	cp -r "$ROOT_DIR/extensions/meta/pi-logger" \
		"$test_home/.pi/extensions/pi-logger"

	# Copy todos
	cp -r "$ROOT_DIR/extensions/accuracy/todos" \
		"$test_home/.pi/extensions/todos"

	# Copy mock-llm-completion
	mkdir -p "$test_home/.pi/extensions/mock-llm-completion"
	cp "$ROOT_DIR/test/extensions/todos/helpers/mock-llm-completion.ts" \
		"$test_home/.pi/extensions/mock-llm-completion/index.ts"

	# Copy pi-logger config
	if [[ -f "$ROOT_DIR/extensions/meta/pi-logger/pi-logger.json" ]]; then
		cp "$ROOT_DIR/extensions/meta/pi-logger/pi-logger.json" \
			"$test_home/.pi/pi-logger.json"
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

test_it "completion detection: sends reminder on agent_end" <<'TEST'
  local slug="e2e-todos-comp-$$"
  local test_home="$ROOT_DIR/.pi/tmp/$slug"
  trap "rm -rf \"$test_home\"" EXIT
  setup_completion_sandbox "$test_home"

  local stdout_file="$test_home/pi-stdout.log"

  cd "$test_home"
  set +e
  HOME="$test_home/home" pi -a --no-session -p "test completion detection" \
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

  # Check pi-logger output for completion hint
  # The log file is named todos_<pid>.log or similar under .pi/logs/
  local log_dir="$test_home/.pi/logs"
  local todos_logs
  todos_logs=$(find "$log_dir" -name "todos*" -type f 2>/dev/null || true)

  if [[ -z "$todos_logs" ]]; then
    echo "=== STDOUT ==="
    cat "$stdout_file" 2>/dev/null || echo "(no stdout)"
    echo "=== LOG DIR ==="
    ls -la "$log_dir/" 2>/dev/null || echo "(no log dir)"
    echo "ERROR: No todos log files found"
    exit 1
  fi

  echo "=== STDOUT ==="
  cat "$stdout_file" 2>/dev/null || echo "(no stdout)"
  echo "=== TODOS LOGS ==="
  for f in $todos_logs; do
    echo "--- $f ---"
    cat "$f"
  done

  # Verify "completion hint sent" appears in the log
  if grep -q "completion hint sent" $todos_logs 2>/dev/null; then
    echo "PASS: completion hint was sent"
    exit 0
  fi

  echo "ERROR: No 'completion hint sent' found in todos logs"
  exit 1
TEST
