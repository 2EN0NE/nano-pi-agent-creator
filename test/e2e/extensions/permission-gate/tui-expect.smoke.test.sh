#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# permission-gate — expect TUI 测试
# 迁移自 tui.smoke.test.sh (script+heredoc → expect)
# ──────────────────────────────────────────────────────────────────────────────

test_describe "permission-gate (expect TUI mode)"

test_it "expect: loads extension in TUI mode without crash" <<'TEST'
  tui_expect_test "pi-logger,permission-gate" '
    send "/permission-gate\r"
    sleep 3
  ' 15

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: TUI mode exited cleanly (code=$TUI_EXIT_CODE)"
  else
    echo "FAIL: TUI mode exited with code $TUI_EXIT_CODE (expected 0 or 124)"
    exit 1
  fi

  tui_assert_contains "permission-gate" "Extension name in TUI output"
  tui_cleanup
TEST

test_it "expect: TUI mode produces pi-logger output [REVIEW]" <<'TEST'
  tui_expect_test "pi-logger,permission-gate" '
    send "/permission-gate\r"
    sleep 3
  ' 15

  local padded
  padded=$(printf '%03d' "$CASE_INDEX")
  local log_dir="$CASE_DIR/${padded}-logs"
  if [[ -d "$log_dir" ]]; then
    local log_files
    log_files=$(find "$log_dir" -name "*.log" -type f 2>/dev/null)
    if [[ -n "$log_files" ]]; then
      echo "PASS: Log files found:"
      echo "$log_files" | sed 's/^/  /'

      if echo "$log_files" | xargs grep -l "permission-gate\|Config loaded\|Permission Gate" 2>/dev/null | head -1 >/dev/null; then
        echo "PASS: permission-gate log content found"
      else
        echo "WARN: No permission-gate specific content in logs (may be in combined log)"
        echo "$log_files" | head -3 | xargs head -5 2>/dev/null || true
      fi
    else
      echo "WARN: No log files in $log_dir"
    fi
  else
    echo "WARN: No logs directory captured"
  fi

  tui_cleanup
  mark_for_review "检查日志文件内容，确认 permission-gate 生命周期事件和 widget 更新被正确记录"
TEST

test_it "expect: TUI mode captures status bar content [REVIEW]" <<'TEST'
  tui_expect_test "pi-logger,permission-gate" '
    send "/permission-gate\r"
    sleep 3
  ' 15

  echo "TUI exit code: $TUI_EXIT_CODE"
  echo "TUI output size: $(wc -c <"$TUI_OUTPUT_FILE") bytes"

  local padded
  padded=$(printf '%03d' "$CASE_INDEX")
  local log_dir="$CASE_DIR/${padded}-logs"
  if [[ -d "$log_dir" ]]; then
    if grep -r "gate:on\|gate:off\|permission-gate\|setStatus\|widget" "$log_dir" 2>/dev/null | head -5; then
      echo "PASS: widget/gate references found in logs"
    else
      echo "WARN: No widget/gate references in logs"
    fi
  fi

  tui_cleanup
  mark_for_review "审查 PTY 输出和日志文件，确认 permission-gate 状态栏 widget 正确显示"
TEST

test_it "expect: /permission-gate directly opens panel with 6 tabs (ADR-0030)" <<'TEST'
  tui_expect_test "pi-logger,permission-gate" '
    send "/permission-gate\r"
    sleep 2
  ' 20

  tui_assert_contains "[会话]" "一级 tab 会话 渲染"
  tui_assert_contains "[项目]" "一级 tab 项目 渲染"
  tui_assert_contains "[用户]" "一级 tab 用户 渲染"
  tui_assert_contains "[历史]" "一级 tab 历史 渲染"
  tui_assert_contains "[分析]" "一级 tab 分析 渲染"
  tui_assert_contains "[设置]" "一级 tab 设置 渲染"
  tui_assert_contains "命令(" "二级 tab 命令 渲染"
  tui_assert_contains "工具(" "二级 tab 工具 渲染"
  tui_assert_contains "目录(" "二级 tab 目录 渲染"
  tui_assert_contains "会话级" "session 层失效提示 渲染"
  tui_cleanup
TEST

test_it "expect: Tab switches layer, settings tab renders toggles (ADR-0030)" <<'TEST'
  tui_expect_test "pi-logger,permission-gate" '
    send "/permission-gate\r"
    sleep 2
    # Tab 切一级 tab 到「设置」（第 6 个）
    send "\t"
    sleep 0.4
    send "\t"
    sleep 0.4
    send "\t"
    sleep 0.4
    send "\t"
    sleep 0.4
    send "\t"
    sleep 0.4
    sleep 1
  ' 20

  tui_assert_contains "权限门" "设置 tab 权限门开关 渲染"
  tui_assert_contains "动态策略" "设置 tab 动态策略开关 渲染"
  tui_assert_contains "组件" "设置 tab 组件开关 渲染"
  tui_assert_contains "默认沉淀级别" "设置 tab 沉淀级别项 渲染"
  tui_assert_contains "拦截模式" "设置 tab 拦截模式项 渲染"
  tui_assert_contains "阈值" "设置 tab 阈值项 渲染"
  tui_cleanup
TEST

test_it "expect: blocking confirmation tree renders for dangerous command (ADR-0030)" <<'TEST'
  export MOCK_LLM_DANGEROUS_COMMAND="rm -rf ./permission-gate-test-target"
  tui_expect_test "pi-logger,permission-gate" '
    # 发送 prompt 触发 mock-llm 的 bash tool call（rm -rf，critical）
    send "clean up the temp directory\r"
    sleep 6
    # 树状阻断框出现后，enter 放行
    send "\r"
    sleep 2
  ' 30
  unset MOCK_LLM_DANGEROUS_COMMAND

  tui_assert_contains "Permission Gate" "阻断框标题 渲染"
  tui_assert_contains "DANGER" "阻断框 DANGER 标记 渲染"
  tui_assert_contains "rm -rf" "阻断框子命令 渲染"
  tui_assert_contains "●" "阻断框风险颜色点 渲染"
  tui_cleanup
TEST

test_it "expect: multi-line command root is flattened, no render corruption" <<'TEST'
  # 多行命令（for 循环 + rm -rf）：根节点原始含换行，曾导致 TUI 行错位/串行
  export MOCK_LLM_DANGEROUS_COMMAND=$'for d in a b; do\n  rm -rf "./$d"\ndone'
  tui_expect_test "pi-logger,permission-gate" '
    send "clean up temp dirs\r"
    sleep 6
    send "\r"
    sleep 2
  ' 30
  unset MOCK_LLM_DANGEROUS_COMMAND

  tui_assert_contains "Permission Gate" "多行命令阻断框标题 渲染"
  tui_assert_contains "DANGER" "多行命令 DANGER 标记 渲染"
  tui_assert_contains "rm -rf" "多行命令子命令 渲染"
  tui_assert_contains "enter 放行" "多行命令放行提示 渲染"
  tui_assert_contains "esc 拒绝" "多行命令拒绝提示 渲染"
  tui_cleanup
TEST

test_it "expect: leaf add-as-strategy then same command auto-passes (ADR-0030)" <<'TEST'
  export MOCK_LLM_DANGEROUS_COMMAND="rm -rf ./permission-gate-test-target"
  export MOCK_LLM_DANGEROUS_REPEAT=2
  tui_expect_test "pi-logger,permission-gate" '
    # prompt 1：触发树状阻断框
    send "clean up the temp directory\r"
    sleep 6
    # ↓ 选中叶子 → a 打开级别选择 → enter 确认(默认 session) → enter 放行
    send "\x1b\[B"
    sleep 0.4
    send "a"
    sleep 0.4
    send "\r"
    sleep 0.6
    send "\r"
    sleep 8
    # prompt 2：同命令 → manual strategy 命中 → 直接放行（无阻断框）
    send "clean up the temp directory again\r"
    sleep 15
  ' 60
  unset MOCK_LLM_DANGEROUS_COMMAND
  unset MOCK_LLM_DANGEROUS_REPEAT

  tui_assert_contains "Permission Gate" "首次树状阻断框标题 渲染"
  tui_assert_contains "DANGER" "阻断框 DANGER 标记 渲染"
  tui_assert_contains "rm -rf" "阻断框子命令 渲染"

  # 日志断言：第二次同命令应为 manual strategy 自动放行（无二次阻断框）
  local padded
  padded=$(printf '%03d' "$CASE_INDEX")
  local log_dir="$CASE_DIR/${padded}-logs"
  if [[ -d "$log_dir" ]] && grep -rh "Auto-approved (manual)" "$log_dir"/permission-gate*.log 2>/dev/null | grep -q .; then
    echo "PASS: manual strategy auto-approval found in permission-gate log"
  else
    echo "WARN: no manual strategy auto-approval log (check ${padded}-logs)"
    grep -rh "manual\|Auto-approved\|Manual strategy" "$log_dir"/permission-gate*.log 2>/dev/null | tail -5 || true
    mark_for_review "确认第二次同命令是通过 manual strategy 自动放行（日志应有 Auto-approved (manual)），且未再次弹出阻断框"
  fi

  tui_cleanup
TEST

test_it "expect: session manual strategy survives /reload (ADR-0033) [REVIEW]" <<'TEST'
  # ADR-0033：会话级手动策略跨 /reload 持久化（session_shutdown 只解绑不删文件，
  # session_start 重新绑定 + 清理超期文件）。本用例：add-as-strategy → /reload →
  # 同命令仍自动放行（manual strategy 命中，无二次阻断框）。
  export MOCK_LLM_DANGEROUS_COMMAND="rm -rf ./permission-gate-reload-target"
  export MOCK_LLM_DANGEROUS_REPEAT=2
  tui_expect_test "pi-logger,permission-gate" '
    # prompt 1：触发树状阻断框
    send "clean up the reload target\r"
    sleep 6
    # ↓ 选中叶子 → a 打开级别选择 → enter 确认(默认 session) → enter 放行
    send "\x1b\[B"
    sleep 0.4
    send "a"
    sleep 0.4
    send "\r"
    sleep 0.6
    send "\r"
    sleep 8
    # /reload：session_shutdown 解绑 + session_start 重新绑定，session 文件不删
    send "/reload\r"
    sleep 10
    # prompt 2：同命令 → session 层 manual strategy 跨 /reload 命中 → 自动放行
    send "clean up the reload target again\r"
    sleep 15
  ' 60
  unset MOCK_LLM_DANGEROUS_COMMAND
  unset MOCK_LLM_DANGEROUS_REPEAT

  tui_assert_contains "Permission Gate" "首次树状阻断框标题 渲染"

  # 日志断言：/reload 后同命令仍 manual strategy 自动放行（跨 /reload 持久化生效）
  local padded
  padded=$(printf '%03d' "$CASE_INDEX")
  local log_dir="$CASE_DIR/${padded}-logs"
  if [[ -d "$log_dir" ]] && grep -rh "Auto-approved (manual)" "$log_dir"/permission-gate*.log 2>/dev/null | grep -q .; then
    echo "PASS: manual strategy auto-approval survived /reload (log)"
  else
    echo "WARN: no manual strategy auto-approval log after /reload"
    grep -rh "manual\|Auto-approved\|reload" "$log_dir"/permission-gate*.log 2>/dev/null | tail -5 || true
    mark_for_review "确认 /reload 后同命令仍通过 session 层 manual strategy 自动放行（日志应有 Auto-approved (manual)）"
  fi

  tui_cleanup
TEST

test_it "expect: 多命中原因被审计记录 (sudo rm -rf /etc)" <<'TEST'
  export MOCK_LLM_DANGEROUS_COMMAND="sudo rm -rf /etc"
  tui_expect_test "pi-logger,permission-gate" '
    send "clean up system config\r"
    sleep 6
    # enter 放行（详情页箭头键在 expect/PTY 下不可靠，命中明细由 audit 日志断言）
    send "\r"
    sleep 2
  ' 30
  unset MOCK_LLM_DANGEROUS_COMMAND

  tui_assert_contains "Permission Gate" "阻断框标题 渲染"
  tui_assert_contains "DANGER" "阻断框 DANGER 标记 渲染"
  tui_assert_contains "sudo rm -rf /etc" "阻断框子命令 渲染"

  # 审计日志断言：多命中原因（权限相关 + 系统目录写 + 拦截模式）被记录
  local audit_file
  audit_file=$(find "$TUI_TEST_HOME" -path "*permission-gate/audit/*.jsonl" 2>/dev/null | head -1)
  if [[ -n "$audit_file" ]]; then
    echo "audit file: $audit_file"
    if grep -q "permission-related" "$audit_file" \
      && grep -q "system-dir-write" "$audit_file" \
      && grep -q "pattern" "$audit_file"; then
      echo "PASS: 多命中原因（权限相关+系统目录写+拦截模式）已记录"
    else
      echo "FAIL: 审计日志缺少多命中原因"
      cat "$audit_file"
      exit 1
    fi
  else
    echo "WARN: 未找到审计日志文件"
    find "$TUI_TEST_HOME" -name "*.jsonl" 2>/dev/null | head -5
    mark_for_review "确认审计日志是否记录了 sudo rm -rf /etc 的多命中原因（permission-related + system-dir-write + pattern）"
  fi

  tui_cleanup
TEST
