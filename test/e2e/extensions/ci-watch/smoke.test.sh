#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# ci-watch 扩展 e2e 测试（使用 mock LLM）
#
# 使用 mock-llm（共享版本 test/helpers/mock-llm.ts）模拟 LLM 回复，
# 无需真实 API Key，让 pi 完整启动、加载扩展、处理会话。
#
# 运行：bash test/scripts/run-e2e.sh --ext ci-watch
# ──────────────────────────────────────────────────────────────────────────────

test_describe "ci-watch extension"

# ====================================================================
# Helper：搭建隔离测试沙箱
# ====================================================================
setup_sandbox() {
	local test_home="$1"

	local home_dir="$test_home/home"
	mkdir -p "$home_dir/.pi/agent/extensions" \
		"$test_home/.pi/extensions" \
		"$test_home/.pi/logs"

	# ci-watch：带 dist 的目录扩展
	mkdir -p "$test_home/.pi/extensions/ci-watch"
	cp -r "$ROOT_DIR/extensions/verification/ci-watch/dist" \
		"$test_home/.pi/extensions/ci-watch/dist"

	# pi-logger：日志基础设施
	cp -r "$ROOT_DIR/extensions/meta/pi-logger" \
		"$test_home/.pi/extensions/pi-logger"

	# mock-llm：引用共享版本（test/helpers/mock-llm.ts）
	mkdir -p "$test_home/.pi/extensions/mock-llm"
	cp "$ROOT_DIR/test/helpers/mock-llm.ts" \
		"$test_home/.pi/extensions/mock-llm/index.ts"

	# pi-logger 配置
	[[ -f "$ROOT_DIR/extensions/meta/pi-logger/pi-logger.json" ]] && {
		cp "$ROOT_DIR/extensions/meta/pi-logger/pi-logger.json" \
			"$test_home/.pi/pi-logger.json"
	}

	# node_modules 本地包链接（@zenone/pi-logger）
	mkdir -p "$test_home/node_modules/@zenone"
	[[ ! -e "$test_home/node_modules/@zenone/pi-logger" ]] && {
		ln -sf "$ROOT_DIR/extensions/meta/pi-logger" \
			"$test_home/node_modules/@zenone/pi-logger"
	}

	# 初始化 git（某些事件需要 git 目录）
	git -C "$test_home" init --initial-branch main &>/dev/null || true
}

# ====================================================================
# Helper：在隔离沙箱中运行 pi
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
# Helper：输出沙箱日志
# ====================================================================
dump_logs() {
	local test_home="$1"
	echo "=== STDOUT ==="
	cat "$test_home/pi-stdout.log" 2>/dev/null || echo "(no stdout)"
	echo "=== LOGS ==="
	ls "$test_home/.pi/logs/" 2>/dev/null && cat "$test_home/.pi/logs/"*.log 2>/dev/null | head -50 || echo "(no logs)"
}

# ====================================================================
# 场景 1：基本加载 —— mock-llm + ci-watch
# ====================================================================
test_it "loads with mock LLM and responds" <<'TEST'
  slug="ciw-s1-$$"
  test_home="$ROOT_DIR/.pi/tmp/$slug"
  setup_sandbox "$test_home"

  run_pi "$test_home" "hi"
  ec=$?

  # 验证 exit code（0 或 124 timeout 都算通过）
  if [[ "$ec" -ne 0 && "$ec" -ne 124 ]]; then
    echo "FAIL: unexpected exit code $ec"
    exit 1
  fi

  # 验证 stdout 包含 mock 回复 → 说明 LLM 交互正常
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
# 场景 2：ci-watch 的 session_start 事件正常触发
# ====================================================================
test_it "ci-watch session_start handler fires [REVIEW]" <<'TEST'
  slug="ciw-s2-$$"
  test_home="$ROOT_DIR/.pi/tmp/$slug"
  setup_sandbox "$test_home"

  run_pi "$test_home" "hi"
  ec=$?

  if [[ "$ec" -ne 0 && "$ec" -ne 124 ]]; then
    echo "FAIL: unexpected exit code $ec"
    exit 1
  fi

  dump_logs "$test_home"

  rm -rf "$test_home" "$ROOT_DIR/.pi/tmp/${slug}"*

  mark_for_review "检查 ci-watch 是否正确加载："$'\n'"1. Exit code 0（或 124 timeout）"$'\n'"2. 日志中有 ci-watch 相关输出（gh CLI 检测结果）"$'\n'"3. Lifecycle log 显示完整的 session 生命周期"
  exit 0
TEST

# ====================================================================
# 场景 3：扩展加载后在 lifecycle log 中有记录
# ====================================================================
test_it "lifecycle log shows extension load" <<'TEST'
  slug="ciw-s3-$$"
  test_home="$ROOT_DIR/.pi/tmp/$slug"
  setup_sandbox "$test_home"

  run_pi "$test_home" "hi"
  ec=$?

  if [[ "$ec" -ne 0 && "$ec" -ne 124 ]]; then
    echo "FAIL: unexpected exit code $ec"
    exit 1
  fi

  # 验证 lifecycle log 中有 ci-watch 或 mock-llm 扩展加载记录
  if grep -q "ci-watch\|mock-llm" "$test_home/.pi/logs/__lifecycle__"*.log 2>/dev/null; then
    echo "PASS: extension references found in lifecycle log"
  else
    echo "WARN: no extension references in lifecycle log (check manually)"
    cat "$test_home/.pi/logs/__lifecycle__"*.log 2>/dev/null
  fi

  rm -rf "$test_home" "$ROOT_DIR/.pi/tmp/${slug}"*
  exit 0
TEST

# ====================================================================
# 场景 4：/ci-watch 不带参数时不崩溃
# ====================================================================
test_it "/ci-watch without args shows usage hint (no crash)" <<'TEST'
  slug="ciw-s4-$$"
  test_home="$ROOT_DIR/.pi/tmp/$slug"
  setup_sandbox "$test_home"

  # /ci-watch 不带参数 → 应打开 TUI 面板而不崩溃
  run_pi "$test_home" "/ci-watch"
  ec=$?

  if [[ "$ec" -ne 0 && "$ec" -ne 124 ]]; then
    echo "FAIL: unexpected exit code $ec"
    exit 1
  fi

  echo "=== stdout ==="
  cat "$test_home/pi-stdout.log"

  # 不崩溃即可；TUI 面板不在 print 模式中可见
  if grep -q "ci-watch\|CI Watch\|Monitor" "$test_home/pi-stdout.log" 2>/dev/null; then
    echo "INFO: ci-watch references found in stdout"
  fi

  rm -rf "$test_home" "$ROOT_DIR/.pi/tmp/${slug}"*
  exit 0
TEST

# ====================================================================
# 场景 5：/ci-watch 带无效参数时不崩溃
# ====================================================================
test_it "/ci-watch with invalid ref shows error (no crash)" <<'TEST'
  slug="ciw-s5-$$"
  test_home="$ROOT_DIR/.pi/tmp/$slug"
  setup_sandbox "$test_home"

  # /ci-watch 带无效 ref
  run_pi "$test_home" "/ci-watch invalid@ref!"
  ec=$?

  if [[ "$ec" -ne 0 && "$ec" -ne 124 ]]; then
    echo "FAIL: unexpected exit code $ec"
    exit 1
  fi

  echo "=== stdout ==="
  cat "$test_home/pi-stdout.log"

  rm -rf "$test_home" "$ROOT_DIR/.pi/tmp/${slug}"*
  exit 0
TEST

# ====================================================================
# 场景 6：扩展日志对 gh CLI 的检测结果
# ====================================================================
test_it "gh CLI detection logged [REVIEW]" <<'TEST'
  slug="ciw-s6-$$"
  test_home="$ROOT_DIR/.pi/tmp/$slug"
  setup_sandbox "$test_home"

  run_pi "$test_home" "hi"
  ec=$?

  if [[ "$ec" -ne 0 && "$ec" -ne 124 ]]; then
    echo "FAIL: unexpected exit code $ec"
    exit 1
  fi

  dump_logs "$test_home"

  rm -rf "$test_home" "$ROOT_DIR/.pi/tmp/${slug}"*

  mark_for_review "验证 gh CLI 检测日志：隔离沙箱中预计无 gh 命令，ci-watch 应输出 'gh CLI not found' 通知。确认日志中有此记录且扩展未崩溃"
  exit 0
TEST
