#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# ci-watch TUI 交互测试
# 验证 /ci-watch 命令在 TUI 模式下的面板渲染
#
# 运行：bash test/scripts/run-e2e.sh --ext ci-watch --tui
# ──────────────────────────────────────────────────────────────────────────────

test_describe "ci-watch TUI interaction"

# ====================================================================
# 依赖检测：tui-functions.sh 在 setup 阶段被 run-e2e.sh 自动 source
# 但以防外部单独调用，这里显式 source
# ====================================================================
if ! type tui_run_pi_test &>/dev/null 2>&1; then
	if [[ -f "$ROOT_DIR/test/helpers/tui-functions.sh" ]]; then
		source "$ROOT_DIR/test/helpers/tui-functions.sh"
	else
		echo "FATAL: Cannot find tui-functions.sh. Run via run-e2e.sh."
		exit 1
	fi
fi

# ====================================================================
# 场景 1：/ci-watch 在 TUI 模式下不崩溃
# ====================================================================
test_it "TUI: /ci-watch launches without crash" <<'TEST'
  # ci-watch 扩展 + 必需依赖（不含 mock-llm——TUI 测试应避免触发 LLM）
  # 注意：TUI 模式下 ci-watch 会加载 pi-logger 和 pi-config 作为依赖
  tui_run_pi_test "ci-watch,pi-logger,pi-config" "/ci-watch" 10

  tui_assert_exit_code 0

  # 验证日志中出现 ci-watch 加载记录
  local logs_dir="$TUI_TEST_HOME/.pi/logs"
  if ls "$logs_dir"/*.log 2>/dev/null | head -1; then
    if grep -q "ci-watch" "$logs_dir"/*.log 2>/dev/null; then
      echo "PASS: ci-watch log entries found"
    else
      echo "INFO: ci-watch not in logs (expected if no gh CLI)"
    fi
  else
    echo "INFO: no log files found"
  fi

  tui_cleanup
  exit 0
TEST

# ====================================================================
# 场景 2：/ci-watch <prNumber> 在 TUI 模式下不崩溃
# ====================================================================
test_it "TUI: /ci-watch with PR number starts monitoring (no gh)" <<'TEST'
  # 在没有 gh CLI 的隔离环境中运行 /ci-watch <number>
  # 预期：检测到无 gh，报错提示而不是崩溃
  tui_run_pi_test "ci-watch,pi-logger,pi-config" "/ci-watch 123" 10

  tui_assert_exit_code 0

  echo "=== TUI visible output ==="
  extract_visible_text "$TUI_OUTPUT_FILE" | tail -30

  tui_cleanup
  exit 0
TEST

# ====================================================================
# 场景 3：/ci-watch <branchName> 在 TUI 模式下不崩溃
# ====================================================================
test_it "TUI: /ci-watch with branch name starts monitoring (no gh)" <<'TEST'
  tui_run_pi_test "ci-watch,pi-logger,pi-config" "/ci-watch main" 10

  tui_assert_exit_code 0

  tui_cleanup
  exit 0
TEST

# ====================================================================
# 场景 4：扩展加载生命周期 [REVIEW]
# ====================================================================
test_it "TUI: extension lifecycle [REVIEW]" <<'TEST'
  tui_run_pi_test "ci-watch,pi-logger,pi-config" "/ci-watch" 10

  # 检查 lifecycle log
  local logs_dir="$TUI_TEST_HOME/.pi/logs"
  if ls "$logs_dir"/__lifecycle__*.log 2>/dev/null | head -1; then
    echo "=== lifecycle log ==="
    cat "$logs_dir"/__lifecycle__*.log 2>/dev/null | tail -30
    echo "=== ci-watch log ==="
    cat "$logs_dir"/ci-watch*.log 2>/dev/null | tail -20 || echo "(no ci-watch log)"
  else
    echo "WARN: no lifecycle log files"
  fi

  tui_cleanup
  mark_for_review "验证 ci-watch TUI 模式下的表现："$'\n'"1. /ci-watch 打开 TUI 面板（覆盖层）不崩溃"$'\n'"2. 当没有 gh CLI 时优雅提示"$'\n'"3. 面板内容（Monitor PR, Monitor Branch, Auto-mode, Polling config）渲染正确"$'\n'"4. 日志完整记录 session 生命周期"
  exit 0
TEST
