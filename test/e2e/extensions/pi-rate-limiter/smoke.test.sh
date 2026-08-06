#!/usr/bin/env bash
#
# smoke.test.sh — pi-rate-limiter e2e tests (using mock LLM)
#
# 使用 mock-llm 辅助扩展（test/extensions/pi-rate-limiter/helpers/mock-llm.ts）
# 来模拟 LLM 回复，无需真实 API Key 和网络请求。
#
# 关键点：
#   - HOME 隔离：设置 HOME 到隔离沙箱，避免全局扩展冲突（pi-logger flag 重复注册）
#   - 手动沙箱搭建：mock-llm 在 test/ 下，不在标准的 extensions/ 中
#
# 运行：
#   bash test/scripts/run-e2e.sh --ext pi-rate-limiter
#
# 验证内容：
#   1. mock-llm + pi-rate-limiter 同时加载无报错
#   2. Pi 使用 mock 模型回复（而非真实 API）
#   3. pi-rate-limiter 的 before_provider_request handler 正常工作
#   4. 432 错误能被正确检测和记录

set -euo pipefail
ROOT_DIR="${ROOT_DIR:?must be set by test runner}"

# ====================================================================
# Helper: 搭建隔离测试沙箱
# ====================================================================
setup_sandbox() {
	local test_home="$1"
	shift
	# 沙箱目录结构：
	#   test_home/
	#   ├── home/            ← 用作 $HOME（隔离全局扩展）
	#   │   └── .pi/agent/   ← pi 配置文件目录
	#   ├── .pi/
	#   │   ├── extensions/  ← 测试用的扩展
	#   │   └── logs/        ← pi-logger 输出
	#   └── node_modules/    ← 本地包链接

	local home_dir="$test_home/home"
	mkdir -p "$home_dir/.pi/agent/extensions" \
		"$test_home/.pi/extensions" \
		"$test_home/.pi/logs"

	# 始终拷贝 pi-logger（扩展的日志基础设施）
	cp -r "$ROOT_DIR/extensions/meta/pi-logger" \
		"$test_home/.pi/extensions/pi-logger"

	for name in "$@"; do
		case "$name" in
		pi-rate-limiter)
			cp -r "$ROOT_DIR/extensions/meta/pi-rate-limiter" \
				"$test_home/.pi/extensions/pi-rate-limiter"
			;;
		mock-llm)
			mkdir -p "$test_home/.pi/extensions/mock-llm"
			cp "$ROOT_DIR/test/extensions/pi-rate-limiter/helpers/mock-llm.ts" \
				"$test_home/.pi/extensions/mock-llm/index.ts"
			;;
		mock-llm-429)
			mkdir -p "$test_home/.pi/extensions/mock-llm-429"
			cp "$ROOT_DIR/test/extensions/pi-rate-limiter/helpers/mock-llm-429.ts" \
				"$test_home/.pi/extensions/mock-llm-429/index.ts"
			;;
		esac
	done

	# 拷贝 pi-logger 配置
	if [[ -f "$ROOT_DIR/extensions/meta/pi-logger/pi-logger.json" ]]; then
		cp "$ROOT_DIR/extensions/meta/pi-logger/pi-logger.json" \
			"$test_home/.pi/pi-logger.json"
	fi

	# 建立 node_modules 本地包链接（使 import '@zenone/pi-logger' 可解析）
	mkdir -p "$test_home/node_modules/@zenone"
	if [[ ! -e "$test_home/node_modules/@zenone/pi-logger" ]]; then
		ln -sf "$ROOT_DIR/extensions/meta/pi-logger" \
			"$test_home/node_modules/@zenone/pi-logger"
	fi

	# 初始化 git（某些扩展需要 git 工作目录）
	if ! git -C "$test_home" rev-parse --git-dir &>/dev/null; then
		git -C "$test_home" init --initial-branch main &>/dev/null || true
	fi
}

# ====================================================================
# Helper: 在隔离沙箱中运行 pi（无会话模式）
# ====================================================================
run_pi() {
	local test_home="$1"
	local prompt="${2:-hi}"

	local stdout_file="$test_home/pi-stdout.log"

	cd "$test_home"
	set +e
	# HOME 隔离：沙箱内的 $HOME 是 test_home/home/
	HOME="$test_home/home" pi -a --no-session -p "$prompt" \
		>"$stdout_file" 2>&1
	local ec=$?
	set -e
	cd "$ROOT_DIR"

	echo "=== pi exit code: $ec ==="
	return $ec
}

# ====================================================================
# Helper: 在隔离沙箱中运行 pi（会话模式 — 允许 fork）
# TODO: 用于后续 fork 场景测试（当前 deep cooldown 场景使用 --no-session）
# ====================================================================
run_pi_with_session() {
	local test_home="$1"
	local prompt="${2:-hi}"
	local session_name="${3:-test-session}"

	local stdout_file="$test_home/pi-stdout.log"

	cd "$test_home"
	set +e
	HOME="$test_home/home" pi -a --name "$session_name" -p "$prompt" \
		>"$stdout_file" 2>&1
	local ec=$?
	set -e
	cd "$ROOT_DIR"

	echo "=== pi exit code: $ec ==="
	return $ec
}

# ====================================================================
# Helper: 输出沙箱日志
# ====================================================================
dump_logs() {
	local test_home="$1"
	echo "=== STDOUT ==="
	cat "$test_home/pi-stdout.log" 2>/dev/null || echo "(no stdout)"
	echo "=== LIFECYCLE LOG ==="
	cat "$test_home/.pi/logs/__lifecycle__"*.log 2>/dev/null || echo "(no lifecycle log)"
	echo "=== PI-RATE-LIMITER (custom file logger) ==="
	local rl_log="$test_home/home/.pi/agent/rate-limiter/extension.log"
	if [[ -f "$rl_log" ]]; then
		cat "$rl_log"
	else
		echo "(no rate-limiter log — writes to its own file)"
	fi
}

# ====================================================================
# 场景 1：基本加载 —— mock-llm + pi-rate-limiter
# ====================================================================
test_it "mock-llm + pi-rate-limiter: loads and responds without crash" <<'TEST'
  local slug="e2e-rl-s1-$$"
  local test_home="$ROOT_DIR/.pi/tmp/$slug"
  setup_sandbox "$test_home" pi-rate-limiter mock-llm

  run_pi "$test_home" "hi"
  local ec=$?

  # 验证 exit code
  if [[ "$ec" -ne 0 && "$ec" -ne 124 ]]; then
	echo "FAIL: unexpected exit code $ec"
	exit 1
  fi

  # 验证 stdout 包含 mock 回复
  if grep -q "Mock LLM is ready" "$test_home/pi-stdout.log" 2>/dev/null; then
	echo "PASS: mock response in stdout"
  else
	echo "FAIL: no mock response in stdout"
	cat "$test_home/pi-stdout.log"
	exit 1
  fi

  # 验证 lifecycle log 中有 assistant 消息
  if grep -q "assistant" "$test_home/.pi/logs/__lifecycle__"*.log 2>/dev/null; then
	echo "PASS: assistant message in lifecycle log"
  else
	echo "FAIL: no assistant message in lifecycle log"
	exit 1
  fi

  rm -rf "$test_home" "$ROOT_DIR/.pi/tmp/${slug}"*
  exit 0
TEST

# ====================================================================
# 场景 2：pi-rate-limiter 的事件监听器正常绑定
# ====================================================================
test_it "pi-rate-limiter: lifecycle event handlers bind and fire [REVIEW]" <<'TEST'
  local slug="e2e-rl-s2-$$"
  local test_home="$ROOT_DIR/.pi/tmp/$slug"
  setup_sandbox "$test_home" pi-rate-limiter mock-llm

  run_pi "$test_home" "hi"
  local ec=$?

  # 验证 exit code
  if [[ "$ec" -ne 0 && "$ec" -ne 124 ]]; then
	echo "FAIL: unexpected exit code $ec"
	exit 1
  fi

  dump_logs "$test_home"

  rm -rf "$test_home" "$ROOT_DIR/.pi/tmp/${slug}"*

  mark_for_review "Verify rate limiter event bindings:"$'\n'"1. Exit code is 0 (no crash in rate limiter startup)"$'\n'"2. Lifecycle log shows: session_start → agent → msg → turn → agent_end → session_shutdown"$'\n'"3. pi-rate-limiter's custom extension.log shows factory invoked + session_start + loadConfig + session_shutdown"$'\n'"4. loadConfig shows correct defaults (maxReq=10, maxTok=256000, adaptiveRateLimit='off')"$'\n'"   ('off' because no YAML config file was provided to test sandbox)"$'\n'"5. No error-level logs"
TEST

# ====================================================================
# 场景 3：连续 429 — 验证 deep cooldown 机制 [REVIEW]
# ====================================================================
test_it "pi-rate-limiter: consecutive 429s trigger deep cooldown [REVIEW]" <<'TEST'
  local slug="e2e-rl-s3-$$"
  local test_home="$ROOT_DIR/.pi/tmp/$slug"
  setup_sandbox "$test_home" pi-rate-limiter mock-llm-429

  # 启用 autoResumeOn432（默认关闭，需要显式开启）
  local config_dir="$test_home/home/.pi/agent/extensions-data/pi-rate-limiter"
  mkdir -p "$config_dir"
  cat > "$config_dir/pi-rate-limiter.yaml" <<'YAML'
autoResumeOn432: true
maxRequestsPerMinute: 100
maxTokensPerMinute: 1000000
YAML

  run_pi "$test_home" "hi"
  local ec=$?

  echo "=== pi exit code: $ec ==="

  dump_logs "$test_home"

  # 检查 pi-rate-limiter 日志中有 deep cooldown 证据
  local rl_log="$test_home/home/.pi/agent/rate-limiter/extension.log"
  if [[ -f "$rl_log" ]]; then
	echo "=== RATE-LIMITER LOG (relevant lines) ==="
	grep -i "consecutive429Count\|deep cooldown\|enterDeepCooldown\|cooldown\|fork" "$rl_log" || echo "(no matching lines)"
  else
	echo "(no rate-limiter log)"
  fi

  rm -rf "$test_home" "$ROOT_DIR/.pi/tmp/${slug}"*

  mark_for_review "Verify consecutive 429 deep cooldown behavior:"$'\n'"1. pi-rate-limiter log shows consecutive429Count incrementing (1, 2, 3)"$'\n'"2. Log shows 'enterDeepCooldown' after 3rd consecutive 429"$'\n'"3. Log shows 'in deep cooldown, skipping 432 handling' for any subsequent 429"$'\n'"4. The auto-resume timer is cancelled (no more 'sending auto-resume message' after cooldown)"$'\n'"5. Exit code 0 (no crash)"
TEST
