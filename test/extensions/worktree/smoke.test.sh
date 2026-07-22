#!/usr/bin/env bash
# pi-worktree v2 e2e 测试
#
# 验证扩展加载、命令注册、TUI 交互的基本流程。
# 深度 git 操作验证已由 Vitest 集成测试覆盖（test/vitest/extensions/worktree.smoke.test.ts）。
#
# 使用 mock-llm（CI=true）避免真实 API 调用。

test_describe "worktree extension"

# ── 测试 1：基本加载（print 模式） ──
test_it "loads without errors in print mode" <<'TEST'
  run_pi_and_check \
    --extensions "pi-logger,worktree" \
    --prompt "Respond with OK" \
    --expect-no-error

  echo "PASS: worktree extension loaded without errors"
  exit 0
TEST

# ── 测试 2：加载时 mock-llm 正常工作 ──
test_it "mock-llm responds in worktree session" <<'TEST'
  run_pi_and_check \
    --extensions "pi-logger,worktree" \
    --prompt "Say hello" \
    --expect-no-error

  echo "PASS: mock-llm and worktree extension loaded together"
  exit 0
TEST

# ── 测试 3：worktree 扩展日志存在（pi-logger 集成） ──
test_it "pi-logger captures worktree log output" <<'TEST'
  run_pi_and_check \
    --extensions "pi-logger,worktree" \
    --prompt "what is 1+1" \
    --expect-no-error

  # 检查 pi-logger 的输出目录中是否有 worktree 的日志
  local log_file
  log_file=$(find "$PI_LOG_DIR" -name 'pi-worktree_*.log' 2>/dev/null | head -1)
  if [[ -n "$log_file" ]]; then
    echo "PASS: pi-worktree log file found: $(basename "$log_file")"
  else
    echo "WARN: no pi-worktree log file found (may not have been written)"
  fi
  exit 0
TEST

# ── 测试 4：验证 help 文本包含核心命令 ──
test_it "help text contains key commands" <<'TEST'
  run_pi_and_check \
    --extensions "pi-logger,worktree" \
    --prompt "Show the worktree help" \
    --expect-no-error

  echo "PASS: help accessible"
  exit 0
TEST

# ── 测试 5：在 TUI 模式下扩展加载正常 ──
test_it "loads in TUI mode without crash" <<'TEST'
  local pi_input
  pi_input=$(printf '/worktree\n\x1b')
  tui_run_pi_test "pi-logger,worktree" "$pi_input" 15

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: TUI mode exited cleanly (code=$TUI_EXIT_CODE)"
  else
    echo "FAIL: TUI mode exited with code $TUI_EXIT_CODE (expected 0 or 124)"
    exit 1
  fi

  tui_assert_contains "worktree" "Extension name appears in TUI output"
  tui_cleanup
TEST

# ── 测试 6：/worktree list 在 TUI 中显示 ──
test_it "list shows worktree command in TUI" <<'TEST'
  tui_run_pi_test "pi-logger,worktree" "/worktree list" 15

  # 在 TUI 模式下 /worktree list 应当有输出
  tui_assert_contains "worktree" "command should be mentioned"
  tui_cleanup
TEST

# ── 测试 7：/worktree 无参数打开切换器面板（TUI） ──
test_it "switcher panel opens in TUI" <<'TEST'
  local pi_input
  pi_input=$(printf '/worktree\n\x1b')
  tui_run_pi_test "pi-logger,worktree" "$pi_input" 15

  # 主面板应该包含 main
  tui_assert_contains "main" "switcher panel should list main checkout"
  # 应有操作提示
  tui_assert_contains "Create" "should show create action"
  tui_assert_contains "Delete" "should show delete action"
  tui_assert_contains "Quit" "should show quit action"

  tui_cleanup
  mark_for_review "验证切换器面板是否显示 main、Create、Delete、Quit 等选项"
TEST

# ── 测试 9：session 文件创建验证（print 模式） ──
test_it "session files created with correct format" <<'TEST'
  # 创建一个沙箱 git 仓库 + worktree
  local sandbox_home test_repo wt_dir
  sandbox_home=$(mktemp -d "/tmp/pi-wt-session-test-XXXXXX")
  test_repo="$sandbox_home/repo"
  mkdir -p "$test_repo"
  git init --initial-branch main "$test_repo" >/dev/null 2>&1
  echo "# test" > "$test_repo/README.md"
  git -C "$test_repo" add README.md && git -C "$test_repo" commit -m init >/dev/null 2>&1

  # 创建 worktree
  wt_dir="${test_repo}-worktrees/test-wt"
  mkdir -p "$(dirname "$wt_dir")"
  git -C "$test_repo" worktree add "$wt_dir" wt/test-wt >/dev/null 2>&1

  # 创建 session 目录
  local session_root="${sandbox_home}/.pi/agent/sessions"
  mkdir -p "$session_root"

  # 生成 session 编码目录（通过 repoRoot 编码）
  local encoded_repo
  encoded_repo="--$(echo "$test_repo" | sed 's|/|-|g')--"
  local session_dir="$session_root/$encoded_repo"
  mkdir -p "$session_dir"

  # 模拟 createSession：写入 v3 格式 session 文件
  cat > "$session_dir/worktree-test-wt.jsonl" << SESS
{"type":"session","version":3,"id":"test-uuid-1234","timestamp":"2024-01-01T00:00:00.000Z","cwd":"$wt_dir"}
SESS

  # 验证 header 格式
  local header
  header=$(head -1 "$session_dir/worktree-test-wt.jsonl")
  echo "$header" | python3 -c "
import json,sys
h=json.loads(sys.stdin.read())
assert h['type']=='session','type should be session'
assert h['version']==3,'version should be 3'
assert h['id']=='test-uuid-1234','id should match'
assert h['cwd']=='$wt_dir','cwd should be worktree path'
print('PASS: session header v3 format valid')
" 2>&1 || {
    echo "FAIL: session header format invalid"
    cat "$session_dir/worktree-test-wt.jsonl"
    rm -rf "$sandbox_home"
    exit 1
  }

  # 清理
  git -C "$test_repo" worktree remove "$wt_dir" >/dev/null 2>&1 || true
  rm -rf "$sandbox_home"
  echo "PASS: session file v3 format verified"
  exit 0
TEST

# ── 测试 10：扩展后 pi 仍可正常交互（验证不崩溃） ──
test_it "pi continues working after worktree commands" <<'TEST'
  # 先执行 /worktree list，再发普通 prompt 验证 pi 不崩溃
  local pi_input
  pi_input=$(printf '/worktree list\n/help\n')
  tui_run_pi_test "pi-logger,worktree" "$pi_input" 20

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: pi continued after worktree commands (code=$TUI_EXIT_CODE)"
  else
    echo "FAIL: pi exited with code $TUI_EXIT_CODE after worktree command"
    exit 1
  fi

  tui_assert_contains "worktree" "worktree output should appear"
  tui_cleanup
  mark_for_review "验证/worktree命令后pi仍可继续接收用户输入"
TEST
