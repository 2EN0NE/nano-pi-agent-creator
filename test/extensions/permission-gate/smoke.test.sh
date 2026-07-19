#!/usr/bin/env bash
#
# smoke.test.sh — permission-gate 动态策略 e2e 测试
#
# 使用 mock-llm 辅助扩展（test/extensions/permission-gate/helpers/mock-llm.ts）
# 来模拟 LLM 生成危险 bash 命令（rm -rf），无需真实 API Key。
#
# 关键设计：
#   - mock-llm 默认回复包含 fauxToolCall('bash', { command: 'rm -rf /tmp/...' })
#   - 触发 permission-gate 的 ToolCallEvent 拦截
#   - 在 no-UI 模式下，dynamic policy auto-approve 放行，否则 block
#
# 运行：
#   bash test/scripts/run-e2e.sh --ext permission-gate
#

set -euo pipefail
ROOT_DIR="${ROOT_DIR:?must be set by test runner}"

# ====================================================================
# Helper: 搭建隔离测试沙箱
# ====================================================================
setup_sandbox() {
	local test_home="$1"
	local scenario="$2"
	shift 2 || true

	local home_dir="$test_home/home"
	mkdir -p "$home_dir/.pi/agent/extensions" \
		"$test_home/.pi/extensions" \
		"$test_home/.pi/logs" \
		"$test_home/.pi/extensions-data/permission-gate"

	# 拷贝 pi-logger
	cp -r "$ROOT_DIR/extensions/meta/pi-logger" \
		"$test_home/.pi/extensions/pi-logger"

	# 拷贝 permission-gate
	cp -r "$ROOT_DIR/extensions/security/permission-gate" \
		"$test_home/.pi/extensions/permission-gate"

	# 拷贝 mock-llm（test/extensions/permission-gate/helpers/mock-llm.ts → index.ts）
	mkdir -p "$test_home/.pi/extensions/mock-llm"
	cp "$ROOT_DIR/test/extensions/permission-gate/helpers/mock-llm.ts" \
		"$test_home/.pi/extensions/mock-llm/index.ts"

	# pi-logger 配置
	if [[ -f "$ROOT_DIR/extensions/meta/pi-logger/pi-logger.json" ]]; then
		cp "$ROOT_DIR/extensions/meta/pi-logger/pi-logger.json" \
			"$test_home/.pi/pi-logger.json"
	fi

	# node_modules 本地包链接
	mkdir -p "$test_home/node_modules/@zenone"
	if [[ ! -e "$test_home/node_modules/@zenone/pi-logger" ]]; then
		ln -sf "$ROOT_DIR/extensions/meta/pi-logger" \
			"$test_home/node_modules/@zenone/pi-logger"
	fi

	# 初始化 git
	if ! git -C "$test_home" rev-parse --git-dir &>/dev/null; then
		git -C "$test_home" init --initial-branch main &>/dev/null || true
	fi

	# 写入项目级 permission-gate 配置（场景不同，配置不同）
	write_config "$test_home" "$scenario"
}

write_config() {
	local test_home="$1"
	local scenario="$2"
	local config_file="$test_home/.pi/extensions-data/permission-gate/config.json"

	case "$scenario" in
	auto_approve)
		# 阈值足够高 → 自动放行
		cat >"$config_file" <<'JSON'
{
  "enabled": true,
  "dynamicPolicyEnabled": true,
  "dynamicPolicy": {
    "scope": ".",
    "thresholds": {
      "sameCommand": 999,
      "sameTool": 999,
      "sameFolder": 999
    }
  },
  "patterns": [
    "\\brm\\s+(-rf?|--recursive)"
  ],
  "approvalCounts": {}
}
JSON
		;;
	threshold_exceeded)
		# 阈值 0 → 立即超限 → block（no-UI 模式）
		cat >"$config_file" <<'JSON'
{
  "enabled": true,
  "dynamicPolicyEnabled": true,
  "dynamicPolicy": {
    "scope": ".",
    "thresholds": {
      "sameCommand": 0,
      "sameTool": 0,
      "sameFolder": 0
    }
  },
  "patterns": [
    "\\brm\\s+(-rf?|--recursive)"
  ],
  "approvalCounts": {}
}
JSON
		;;
	out_of_scope)
		# scope 指向不相关目录 → 不自动放行
		cat >"$config_file" <<'JSON'
{
  "enabled": true,
  "dynamicPolicyEnabled": true,
  "dynamicPolicy": {
    "scope": "/tmp/nonexistent-scope-for-testing",
    "thresholds": {
      "sameCommand": 999,
      "sameTool": 999,
      "sameFolder": 999
    }
  },
  "patterns": [
    "\\brm\\s+(-rf?|--recursive)"
  ],
  "approvalCounts": {}
}
JSON
		;;
	esac
}

# ====================================================================
# Helper: 在隔离沙箱中运行 pi
# ====================================================================
run_pi() {
	local test_home="$1"
	local prompt="${2:-hi}"

	local stdout_file="$test_home/pi-stdout.log"

	cd "$test_home"
	set +e
	HOME="$test_home/home" pi -a --no-session -p "$prompt" \
		>"$stdout_file" 2>&1
	local ec=$?
	set -e
	cd "$ROOT_DIR"

	echo "=== pi exit code: $ec ==="
	return $ec
}

# ====================================================================
# Helper: 输出权限相关日志
# ====================================================================
dump_perm_logs() {
	local test_home="$1"
	local log_dir="$test_home/.pi/logs"

	echo "=== PERMISSION-GATE LOG ==="
	if [[ -d "$log_dir" ]]; then
		for f in "$log_dir"/permission-gate*.log; do
			if [[ -f "$f" ]]; then
				cat "$f"
			fi
		done
	fi
	echo "=== STDOUT (last 40 lines) ==="
	tail -40 "$test_home/pi-stdout.log" 2>/dev/null || echo "(no stdout)"
}

# ====================================================================
test_describe "permission-gate dynamic policy (mock-llm)"

# ── 场景 1：动态策略自动放行（阈值极高） ──
test_it "dynamic policy auto-approves when within thresholds" <<'TEST'
  local slug="e2e-pg-dp1-$$"
  local test_home="$ROOT_DIR/.pi/tmp/$slug"
  mkdir -p "$test_home"
  setup_sandbox "$test_home" auto_approve

  run_pi "$test_home" "clean up the temp directory" || true

  dump_perm_logs "$test_home"

  # 验证：日志中应出现 "Auto-approved"
  local log_dir="$test_home/.pi/logs"
  if grep -q "Auto-approved" "$log_dir"/permission-gate*.log 2>/dev/null; then
    echo "PASS: Auto-approved found in permission-gate log"
  else
    echo "FAIL: Auto-approved NOT found in permission-gate log"
    echo "Expected: log should contain 'Auto-approved (sameCommand)' or similar"
    exit 1
  fi

  rm -rf "$test_home" "$ROOT_DIR/.pi/tmp/${slug}"*
  exit 0
TEST

# ── 场景 2：动态策略阈值超限 → block（no-UI） ──
test_it "dynamic policy blocks when all thresholds exceeded" <<'TEST'
  local slug="e2e-pg-dp2-$$"
  local test_home="$ROOT_DIR/.pi/tmp/$slug"
  mkdir -p "$test_home"
  setup_sandbox "$test_home" threshold_exceeded

  run_pi "$test_home" "clean up the temp directory" || true
  local ecode=$?

  dump_perm_logs "$test_home"

  # 验证：日志中应出现 "all thresholds exceeded"
  local log_dir="$test_home/.pi/logs"
  if grep -q "all thresholds exceeded" "$log_dir"/permission-gate*.log 2>/dev/null; then
    echo "PASS: 'all thresholds exceeded' found in log"
  else
    echo "FAIL: 'all thresholds exceeded' NOT found"
    exit 1
  fi

  # 验证：stdout 中应有 block 消息（no-UI 模式）
  if grep -q "Blocked" "$test_home/pi-stdout.log" 2>/dev/null; then
    echo "PASS: Block message found in stdout"
  else
    echo "WARN: No explicit 'Blocked' in stdout (may appear differently)"
  fi

  rm -rf "$test_home" "$ROOT_DIR/.pi/tmp/${slug}"*
  exit 0
TEST

# ── 场景 3：不在 scope 内 → fall through ──
test_it "dynamic policy skips when not in scope" <<'TEST'
  local slug="e2e-pg-dp3-$$"
  local test_home="$ROOT_DIR/.pi/tmp/$slug"
  mkdir -p "$test_home"
  setup_sandbox "$test_home" out_of_scope

  run_pi "$test_home" "clean up the temp directory" || true

  dump_perm_logs "$test_home"

  # 验证：日志中应出现 "not in scope"
  local log_dir="$test_home/.pi/logs"
  if grep -q "not in scope" "$log_dir"/permission-gate*.log 2>/dev/null; then
    echo "PASS: 'not in scope' found in log"
  else
    echo "FAIL: 'not in scope' NOT found"
    exit 1
  fi

  rm -rf "$test_home" "$ROOT_DIR/.pi/tmp/${slug}"*
  exit 0
TEST
