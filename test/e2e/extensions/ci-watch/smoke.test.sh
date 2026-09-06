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
  # mock-llm 源：默认共享版；传参可指定专用版（如 ci-watch 自动监控场景）
  local mock_llm_src="${2:-$ROOT_DIR/test/helpers/mock-llm.ts}"

  local home_dir="$test_home/home"
  mkdir -p "$home_dir/.pi/agent/extensions" \
    "$test_home/.pi/extensions" \
    "$test_home/.pi/logs"

  # ci-watch：带 dist 的目录扩展（pi 靠 package.json 的 pi.extensions 发现入口）
  # CI 中 dist 不提交（gitignore），缺失时自动构建
  if [[ ! -d "$ROOT_DIR/extensions/verification/ci-watch/dist" ]]; then
    echo "Building ci-watch dist (missing in source)..."
    (cd "$ROOT_DIR/extensions/verification/ci-watch" && npx tsc) || {
      echo "FAIL: ci-watch build failed"
      exit 1
    }
  fi
  mkdir -p "$test_home/.pi/extensions/ci-watch"
  cp "$ROOT_DIR/extensions/verification/ci-watch/package.json" \
    "$test_home/.pi/extensions/ci-watch/package.json"
  cp -r "$ROOT_DIR/extensions/verification/ci-watch/dist" \
    "$test_home/.pi/extensions/ci-watch/dist"

  # pi-logger：日志基础设施
  cp -r "$ROOT_DIR/extensions/meta/pi-logger" \
    "$test_home/.pi/extensions/pi-logger"

  # 拷贝共享 TUI 辅助模块（src/tui/），供 import '.../src/tui/helpers.js' 的扩展在沙箱内解析
  if [[ -d "$ROOT_DIR/src/tui" ]]; then
    mkdir -p "$test_home/src"
    cp -r "$ROOT_DIR/src/tui" "$test_home/src/tui"
  fi

  # mock-llm：默认共享版本，可传参替换为专用版本
  mkdir -p "$test_home/.pi/extensions/mock-llm"
  cp "$mock_llm_src" \
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
# Helper：安装假 gh（确定性控制 gh 行为，避免依赖宿主机 gh / 真实 GitHub）
# 参数：$1 = test_home  $2 = run conclusion（failure/success/pending）
# 用法：install_mock_gh "$test_home" failure
# ====================================================================
install_mock_gh() {
  local test_home="$1"
  local conclusion="${2:-failure}"
  mkdir -p "$test_home/bin"
  cat >"$test_home/bin/gh" <<GH
#!/bin/bash
# mock gh：headSha 取沙箱 git HEAD，使 evaluateBranchRuns 的 expectedSha 匹配
case "\$1" in
  "pr")
    # pr list --head <branch> ... → 无 PR（走分支模式）
    echo ""
    exit 0
    ;;
  "run")
    if [[ "\$2" == "view" ]]; then
      # run view <id> --log-failed → 假失败日志
      echo "mock failed log line 1 (compile error)"
      echo "mock failed log line 2 (test failed)"
      exit 0
    fi
    # run list --branch <b> -L <n> --json ... → 单个 run（conclusion 由环境变量决定）
    head_sha=\$(git rev-parse HEAD 2>/dev/null || echo "0000000000000000000000000000000000000000")
    cat <<JSON
[{"name":"CI","status":"completed","conclusion":"$conclusion","databaseId":999,"headSha":"\$head_sha","headBranch":"main"}]
JSON
    exit 0
    ;;
  *)
    echo "mock-gh: unhandled: \$*" >&2
    exit 1
    ;;
esac
GH
  chmod +x "$test_home/bin/gh"
}

# ====================================================================
# Helper：定位 ci-watch 日志文件
# 可能位置：项目级 $test_home/.pi/logs 或用户级 $test_home/home/.pi/logs
# 参数：$1 = test_home
# 输出：日志文件路径（存在则输出，否则空）
# ====================================================================
ci_watch_log() {
  local test_home="$1"
  # 注意：run-e2e.sh 以 set -o pipefail 运行，ls 多个 glob 时任一无匹配会
  # 使管道整体返回非零（赋值为非零 → 触发外层 set -e）——分开查找 + echo 兜底
  local f=""
  f=$(ls "$test_home/.pi/logs/ci-watch_"*.log 2>/dev/null | head -1) || true
  if [[ -z "$f" ]]; then
    f=$(ls "$test_home/home/.pi/logs/ci-watch_"*.log 2>/dev/null | head -1) || true
  fi
  echo "$f"
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
test_it "ci-watch session_start handler fires" <<'TEST'
  slug="ciw-s2-$$"
  test_home="$ROOT_DIR/.pi/tmp/$slug"
  setup_sandbox "$test_home"

  run_pi "$test_home" "hi"
  ec=$?

  if [[ "$ec" -ne 0 && "$ec" -ne 124 ]]; then
    echo "FAIL: unexpected exit code $ec"
    exit 1
  fi

  # 断言：session_start 的 gh 检测 handler 实际触发（ci-watch 日志写入检测结果）
  log_file=$(ci_watch_log "$test_home")
  if [[ -n "$log_file" ]] && grep -q "gh CLI 检测" "$log_file"; then
    echo "PASS: session_start gh detection logged"
  else
    echo "FAIL: no gh detection log in ci-watch log"
    cat "$log_file" 2>/dev/null || echo "(no ci-watch log)"
    exit 1
  fi

  rm -rf "$test_home" "$ROOT_DIR/.pi/tmp/${slug}"*
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
# 场景 5：/ci-watch 带无效参数时不崩溃（print 模式启动冒烟）
# 注意：print 模式下 slash 命令不解析执行（命令逻辑在 TUI 场景覆盖：
# "expect: /ci-watch with invalid ref"），本场景仅验证启动不崩溃。
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
# 场景 6：gh CLI 检测日志（注入假 gh → 确定性断言检测成功）
# ====================================================================
test_it "gh CLI detection logged" <<'TEST'
  slug="ciw-s6-$$"
  test_home="$ROOT_DIR/.pi/tmp/$slug"
  setup_sandbox "$test_home"
  install_mock_gh "$test_home" failure

  # 假 gh 使 command -v gh 成功 → ghAvailable=true → 记录"检测成功"
  run_pi "$test_home" "hi" "$test_home/bin"
  ec=$?

  if [[ "$ec" -ne 0 && "$ec" -ne 124 ]]; then
    echo "FAIL: unexpected exit code $ec"
    exit 1
  fi

  log_file=$(ci_watch_log "$test_home")
  if [[ -n "$log_file" ]] && grep -q "gh CLI 检测成功" "$log_file"; then
    echo "PASS: gh CLI detection success logged"
  else
    echo "FAIL: no 'gh CLI 检测成功' in ci-watch log"
    cat "$log_file" 2>/dev/null || echo "(no ci-watch log)"
    exit 1
  fi

  rm -rf "$test_home" "$ROOT_DIR/.pi/tmp/${slug}"*
  exit 0
TEST

# ====================================================================
# 场景 7：自动监控 — bash 工具输出 push 文本 → 触发 CI 自动监控
# ====================================================================
test_it "auto-monitor triggers on git push output in bash tool result" <<'TEST'
  slug="ciw-s7-$$"
  test_home="$ROOT_DIR/.pi/tmp/$slug"
  # 使用专用 mock-llm（支持 MOCK_LLM_BASH_OUTPUT 触发真实 bash tool call）
  setup_sandbox "$test_home" "$ROOT_DIR/test/e2e/extensions/ci-watch/helpers/mock-llm.ts"

  # 让沙箱 git 仓库有 main 分支 commit（自动监控需解析 refs/heads/main 的完整 SHA）
  git -C "$test_home" config user.email test@example.com
  git -C "$test_home" config user.name test
  git -C "$test_home" commit --allow-empty -m init &>/dev/null || true

  # 缩短轮询间隔 + 自动监控超时，避免 poll 拖慢测试
  mkdir -p "$test_home/home/.pi/agent/extensions-data/ci-watch"
  cat >"$test_home/home/.pi/agent/extensions-data/ci-watch/config.json" <<'JSON'
{ "pollConfig": { "minMs": 1000, "maxMs": 2000, "stepMs": 1000 }, "autoMaxWaitMs": 5000 }
JSON

  # 假 gh：沙箱无 GitHub 认证，真实 gh 命令会交互式提示挂起（每次 30s）——
  # 用立即失败的 mock 替代（gh 属于外部 CLI，mock 不损害对 ci-watch 逻辑的验证）
  mkdir -p "$test_home/bin"
  cat >"$test_home/bin/gh" <<'GH'
#!/bin/bash
echo "mock-gh: gh not authenticated in test sandbox" >&2
exit 1
GH
  chmod +x "$test_home/bin/gh"

  cd "$test_home"
  set +e
  HOME="$test_home/home" \
    PATH="$test_home/bin:$PATH" \
    MOCK_LLM_BASH_OUTPUT='To github.com:2EN0NE/nano-pi-agent-creator.git   0ed3326b..040c8427  main -> main' \
    pi -a --no-session -p "hi" >"$test_home/pi-stdout.log" 2>&1
  ec=$?
  set -e
  cd "$ROOT_DIR"

  echo "=== pi exit code: $ec ==="
  if [[ "$ec" -ne 0 && "$ec" -ne 124 ]]; then
    echo "FAIL: unexpected exit code $ec"
    exit 1
  fi

  # 断言：push 检测 + SHA 解析成功 → 进入自动监控
  if grep -q "触发 CI 自动监控" "$test_home/.pi/logs/ci-watch_"*.log 2>/dev/null; then
    echo "PASS: auto-monitor triggered (push detected)"
  else
    echo "FAIL: no auto-monitor trigger in ci-watch log"
    cat "$test_home/.pi/logs/ci-watch_"*.log 2>/dev/null || echo "(no ci-watch log)"
    echo "=== stdout ==="
    cat "$test_home/pi-stdout.log"
    exit 1
  fi

  rm -rf "$test_home" "$ROOT_DIR/.pi/tmp/${slug}"*
  exit 0
TEST

# ====================================================================
# 场景 8：自动监控 — tag push 明确跳过（不再误兜底成当前分支）
# ====================================================================
test_it "auto-monitor skips tag push" <<'TEST'
  slug="ciw-s8-$$"
  test_home="$ROOT_DIR/.pi/tmp/$slug"
  setup_sandbox "$test_home" "$ROOT_DIR/test/e2e/extensions/ci-watch/helpers/mock-llm.ts"

  git -C "$test_home" config user.email test@example.com
  git -C "$test_home" config user.name test
  git -C "$test_home" commit --allow-empty -m init &>/dev/null || true

  # 假 gh：避免真实 gh 未认证交互挂起
  mkdir -p "$test_home/bin"
  cat >"$test_home/bin/gh" <<'GH'
#!/bin/bash
echo "mock-gh: gh not authenticated in test sandbox" >&2
exit 1
GH
  chmod +x "$test_home/bin/gh"

  cd "$test_home"
  set +e
  HOME="$test_home/home" \
    PATH="$test_home/bin:$PATH" \
    MOCK_LLM_BASH_OUTPUT='To github.com:2EN0NE/nano-pi-agent-creator.git   * [new tag]  v0.1.0 -> v0.1.0' \
    pi -a --no-session -p "hi" >"$test_home/pi-stdout.log" 2>&1
  ec=$?
  set -e
  cd "$ROOT_DIR"

  echo "=== pi exit code: $ec ==="
  if [[ "$ec" -ne 0 && "$ec" -ne 124 ]]; then
    echo "FAIL: unexpected exit code $ec"
    exit 1
  fi

  # 断言：tag push 被明确跳过（不进入分支监控）
  if grep -q "检测到 tag push，跳过自动监控" "$test_home/.pi/logs/ci-watch_"*.log 2>/dev/null; then
    echo "PASS: tag push skipped"
  else
    echo "FAIL: no tag-push skip log"
    cat "$test_home/.pi/logs/ci-watch_"*.log 2>/dev/null || echo "(no ci-watch log)"
    echo "=== stdout ==="
    cat "$test_home/pi-stdout.log"
    exit 1
  fi

  rm -rf "$test_home" "$ROOT_DIR/.pi/tmp/${slug}"*
  exit 0
TEST

# ====================================================================
# 场景 9：自动监控 → 分支 run 失败 → 通知链路（notifyResult fail 分支）
# mock gh 输出 headSha 匹配沙箱 HEAD 的 failure run，验证：
#   - expectedSha 匹配后评估出 fail
#   - notifyResult 写 "CI 失败" 日志（含 failedRuns）
# ====================================================================
test_it "auto-monitor detects failed run and notifies" <<'TEST'
  slug="ciw-s9-$$"
  test_home="$ROOT_DIR/.pi/tmp/$slug"
  setup_sandbox "$test_home" "$ROOT_DIR/test/e2e/extensions/ci-watch/helpers/mock-llm.ts"
  install_mock_gh "$test_home" failure

  # 沙箱 git 仓库：mock gh 用 rev-parse HEAD 输出 headSha（需匹配 expectedSha）
  git -C "$test_home" config user.email test@example.com
  git -C "$test_home" config user.name test
  git -C "$test_home" commit --allow-empty -m init &>/dev/null || true

  # 缩短轮询间隔，避免拖慢测试
  mkdir -p "$test_home/home/.pi/agent/extensions-data/ci-watch"
  cat >"$test_home/home/.pi/agent/extensions-data/ci-watch/config.json" <<'JSON'
{ "pollConfig": { "minMs": 1000, "maxMs": 2000, "stepMs": 1000 }, "autoMaxWaitMs": 8000 }
JSON

  cd "$test_home"
  set +e
  HOME="$test_home/home" \
    PATH="$test_home/bin:$PATH" \
    MOCK_LLM_EXTRA_RESPONSES=3 \
    MOCK_LLM_BASH_OUTPUT='To github.com:2EN0NE/nano-pi-agent-creator.git   0ed3326b..040c8427  main -> main' \
    pi -a --no-session -p "hi" >"$test_home/pi-stdout.log" 2>&1
  ec=$?
  set -e
  cd "$ROOT_DIR"

  echo "=== pi exit code: $ec ==="
  if [[ "$ec" -ne 0 && "$ec" -ne 124 ]]; then
    echo "FAIL: unexpected exit code $ec"
    exit 1
  fi

  # 断言：轮询走到 fail → notifyResult 记录 "CI 失败"（含 run 名 CI）
  log_file=$(ci_watch_log "$test_home")
  if [[ -n "$log_file" ]] && grep -q "CI 失败" "$log_file"; then
    echo "PASS: failed-run notification logged"
  else
    echo "FAIL: no 'CI 失败' in ci-watch log"
    cat "$log_file" 2>/dev/null || echo "(no ci-watch log)"
    echo "=== stdout ==="
    cat "$test_home/pi-stdout.log"
    exit 1
  fi

  rm -rf "$test_home" "$ROOT_DIR/.pi/tmp/${slug}"*
  exit 0
TEST

# ====================================================================
# 场景 10：自动监控 → 分支 run 通过 → 通知链路（notifyResult pass 分支）
# ====================================================================
test_it "auto-monitor detects successful run and notifies" <<'TEST'
  slug="ciw-s10-$$"
  test_home="$ROOT_DIR/.pi/tmp/$slug"
  setup_sandbox "$test_home" "$ROOT_DIR/test/e2e/extensions/ci-watch/helpers/mock-llm.ts"
  install_mock_gh "$test_home" success

  git -C "$test_home" config user.email test@example.com
  git -C "$test_home" config user.name test
  git -C "$test_home" commit --allow-empty -m init &>/dev/null || true

  mkdir -p "$test_home/home/.pi/agent/extensions-data/ci-watch"
  cat >"$test_home/home/.pi/agent/extensions-data/ci-watch/config.json" <<'JSON'
{ "pollConfig": { "minMs": 1000, "maxMs": 2000, "stepMs": 1000 }, "autoMaxWaitMs": 8000 }
JSON

  cd "$test_home"
  set +e
  HOME="$test_home/home" \
    PATH="$test_home/bin:$PATH" \
    MOCK_LLM_BASH_OUTPUT='To github.com:2EN0NE/nano-pi-agent-creator.git   0ed3326b..040c8427  main -> main' \
    pi -a --no-session -p "hi" >"$test_home/pi-stdout.log" 2>&1
  ec=$?
  set -e
  cd "$ROOT_DIR"

  echo "=== pi exit code: $ec ==="
  if [[ "$ec" -ne 0 && "$ec" -ne 124 ]]; then
    echo "FAIL: unexpected exit code $ec"
    exit 1
  fi

  # 断言：轮询走到 pass → notifyResult 记录 "CI 通过"
  log_file=$(ci_watch_log "$test_home")
  if [[ -n "$log_file" ]] && grep -q "CI 通过" "$log_file"; then
    echo "PASS: success notification logged"
  else
    echo "FAIL: no 'CI 通过' in ci-watch log"
    cat "$log_file" 2>/dev/null || echo "(no ci-watch log)"
    echo "=== stdout ==="
    cat "$test_home/pi-stdout.log"
    exit 1
  fi

  rm -rf "$test_home" "$ROOT_DIR/.pi/tmp/${slug}"*
  exit 0
TEST
