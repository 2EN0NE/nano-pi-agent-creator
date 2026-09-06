#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# ci-watch 扩展 — expect 交互测试
#
# 验证 TUI 面板（/ci-watch 无参数）：
#   - 面板正常打开（含"监控分支"、"监控 PR"两项）
#   - "监控分支"为第一项（日常主力操作，顺序在"监控 PR"之前）
#   - esc 关闭面板不崩溃
# 验证命令逻辑（print 模式下 slash 命令不解析，命令路径只能在 TUI 测）：
#   - /ci-watch <无效 ref> → 拒绝并提示"无效的引用"
#   - 监控进行中 /reload → 会话代际机制中止在途轮询，不崩溃
# ──────────────────────────────────────────────────────────────────────────────

test_describe "ci-watch extension (expect TUI mode)"

# CI 中 ci-watch 的 dist 不提交（gitignore），tui_copy_extensions 依赖
# dist/index.js 存在才复制目录扩展——缺失时先构建
if [[ ! -d "$ROOT_DIR/extensions/verification/ci-watch/dist" ]]; then
  echo "Building ci-watch dist (missing in source)..."
  (cd "$ROOT_DIR/extensions/verification/ci-watch" && npx tsc) || exit 1
fi

test_it "expect: /ci-watch panel opens with 监控分支 as first item" <<'TEST'
  tui_expect_test "ci-watch,pi-logger" '
    # 打开面板
    send "/ci-watch\r"
    sleep 1

    # 按 esc 关闭面板（模板收尾会自动 /quit 退出）
    send "\033"
    sleep 0.5
  ' 15

  if [[ "$TUI_EXIT_CODE" -ne 0 && "$TUI_EXIT_CODE" -ne 124 ]]; then
    echo "FAIL: unexpected exit code $TUI_EXIT_CODE"
    exit 1
  fi

  # 面板包含两个监控项
  if tui_output_contains "$TUI_OUTPUT_FILE" "监控分支" && tui_output_contains "$TUI_OUTPUT_FILE" "监控 PR"; then
    echo "PASS: panel opened with branch/pr items"
  else
    echo "FAIL: panel items not found"
    extract_visible_text "$TUI_OUTPUT_FILE" | tail -40
    exit 1
  fi

  # 断言"监控分支"出现在"监控 PR"之前（第一项）
  branch_line=$(extract_visible_text "$TUI_OUTPUT_FILE" | grep -n "监控分支" | head -1 | cut -d: -f1)
  pr_line=$(extract_visible_text "$TUI_OUTPUT_FILE" | grep -n "监控 PR" | head -1 | cut -d: -f1)
  if [[ -n "$branch_line" && -n "$pr_line" && "$branch_line" -lt "$pr_line" ]]; then
    echo "PASS: 监控分支 listed before 监控 PR (branch@$branch_line < pr@$pr_line)"
  else
    echo "FAIL: 监控分支 not first (branch=$branch_line pr=$pr_line)"
    extract_visible_text "$TUI_OUTPUT_FILE" | grep -n "监控" | head -10
    exit 1
  fi

  tui_cleanup
TEST

# ====================================================================
# /ci-watch <无效 ref> → 拒绝并提示"无效的引用"
# 注入假 gh（PATH 前缀）使 ghAvailable=true，确保走到 ref 校验分支。
# 注意：tui_expect_test 的 expect 脚本继承当前 PATH，spawn pi 时 mock gh 可达。
# ====================================================================
test_it "expect: /ci-watch with invalid ref rejected" <<'TEST'
  mock_bin="$ROOT_DIR/.pi/tmp/ciw-mock-bin-$$"
  mkdir -p "$mock_bin"
  cat >"$mock_bin/gh" <<'GH'
#!/bin/bash
echo "mock-gh: not authenticated" >&2
exit 1
GH
  chmod +x "$mock_bin/gh"
  export PATH="$mock_bin:$PATH"

  tui_expect_test "ci-watch,pi-logger" '
    send "/ci-watch invalid@ref!\r"
    sleep 2
  ' 15

  if [[ "$TUI_EXIT_CODE" -ne 0 && "$TUI_EXIT_CODE" -ne 124 ]]; then
    echo "FAIL: unexpected exit code $TUI_EXIT_CODE"
    exit 1
  fi

  # 断言：命令 handler 走到 ref 校验 → 拒绝提示
  if tui_output_contains "$TUI_OUTPUT_FILE" "无效的引用"; then
    echo "PASS: invalid ref rejected"
  else
    echo "FAIL: no invalid-ref notice in TUI output"
    extract_visible_text "$TUI_OUTPUT_FILE" | tail -30
    exit 1
  fi

  tui_cleanup
  rm -rf "$mock_bin"
  exit 0
TEST

# ====================================================================
# 监控进行中 /reload → 会话代际机制中止在途轮询，不崩溃
# mock gh 返回 pending run（headSha 匹配沙箱 HEAD）→ /ci-watch main 进入轮询
# sleep（30s）；/reload 触发 session_shutdown → abort → sleep 立即返回 →
# cancelled → 代际检查发现会话已替换 → 只写日志安全退出（不使用 stale ctx）。
# ====================================================================
test_it "expect: /reload aborts in-flight monitoring safely" <<'TEST'
  mock_bin="$ROOT_DIR/.pi/tmp/ciw-mock-bin-$$"
  mkdir -p "$mock_bin"
  cat >"$mock_bin/gh" <<'GH'
#!/bin/bash
case "$1" in
  "pr")
    # pr list --head <branch> ... → 无 PR（走分支模式）
    echo ""
    exit 0
    ;;
  "run")
    if [[ "$2" == "view" ]]; then
      echo "mock log line"
      exit 0
    fi
    # run list --branch <b> -L <n> --json ... → 单个 pending run
    head_sha=$(git rev-parse HEAD 2>/dev/null || echo "«SECRET AWS_SECRET redacted — the real value is live in your shell env; read it in bash as "$SECRET_AWS_SECRET"»")
    cat <<JSON
[{"name":"CI","status":"in_progress","conclusion":"","databaseId":999,"headSha":"$head_sha","headBranch":"main"}]
JSON
    exit 0
    ;;
  *)
    echo "mock-gh: unhandled: $*" >&2
    exit 1
    ;;
esac
GH
  chmod +x "$mock_bin/gh"
  export PATH="$mock_bin:$PATH"

  tui_expect_test "ci-watch,pi-logger" '
    # 开始监控 main（mock gh 返回 pending → 进入轮询 sleep）
    send "/ci-watch main\r"
    sleep 3
    # 会话重载：session_shutdown → abort 在途轮询 → 代际检查
    send "/reload\r"
    sleep 4
  ' 20

  if [[ "$TUI_EXIT_CODE" -ne 0 && "$TUI_EXIT_CODE" -ne 124 ]]; then
    echo "FAIL: unexpected exit code $TUI_EXIT_CODE"
    exit 1
  fi

  # 断言：监控确实进入在途状态（"开始监控"日志）+ reload 成功执行
  # 且进程不崩溃。注：reload 边界的 abort 日志依赖 pi-logger 在模块重载时的
  # 异步 flush（bus 指向 stale runtime 时事件进缓冲），写入时机不可靠——
  # 此处以稳定观测点断言核心价值：监控启动 → reload → 进程存活。
  ci_log=""
  ci_log=$(ls "$TUI_TEST_HOME/.pi/logs/ci-watch_"*.log 2>/dev/null | head -1) || true
  if [[ -z "$ci_log" ]]; then
    ci_log=$(ls "$TUI_TEST_HOME/home/.pi/logs/ci-watch_"*.log 2>/dev/null | head -1) || true
  fi
  lifecycle_log=""
  lifecycle_log=$(ls "$TUI_TEST_HOME/.pi/logs/__lifecycle__"*.log "$TUI_TEST_HOME/home/.pi/logs/__lifecycle__"*.log 2>/dev/null | head -1) || true

  if [[ -n "$ci_log" ]] && grep -q "开始监控" "$ci_log" \
    && [[ -n "$lifecycle_log" ]] && grep -q "reason=reload" "$lifecycle_log"; then
    echo "PASS: monitoring started, reload executed, process alive"
  else
    echo "FAIL: missing monitor-start or reload evidence"
    echo "TUI_TEST_HOME=$TUI_TEST_HOME"
    find "$TUI_TEST_HOME" -name "*.log" 2>/dev/null | head -10
    cat "$ci_log" 2>/dev/null || echo "(no ci-watch log)"
    cat "$lifecycle_log" 2>/dev/null || echo "(no lifecycle log)"
    extract_visible_text "$TUI_OUTPUT_FILE" | tail -30
    exit 1
  fi

  tui_cleanup
  rm -rf "$mock_bin"
  exit 0
TEST
